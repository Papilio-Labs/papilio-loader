import { classifyBootLogLine, classifyStatusResponseText, type DeviceRole } from "./device-status.js";
import { fetchDeviceStatusText, requestGotoLoader, OTA_PORT } from "./ota.js";
import {
  MetadataResetConsentRequiredError,
  recoverIntoLoaderProtected,
  type ProtectedRecoveryOptions,
  type ProtectedRecoveryResult,
} from "./recovery.js";
import { SerialLineReader } from "./serial-log.js";
import type { SerialLike } from "./transport.js";

export interface UsbLoaderSession {
  port: SerialLike;
  reader: SerialLineReader;
  identity: "loader";
  recovery?: ProtectedRecoveryResult;
}

export interface EnsureUsbLoaderOptions extends Omit<ProtectedRecoveryOptions, "allowOtadataReset"> {
  allowOtadataReset: boolean;
  rediscoverPort(timeoutMs: number): Promise<SerialLike>;
  identityTimeoutMs?: number;
}

export async function waitForDeviceRole(reader: SerialLineReader, timeoutMs: number): Promise<DeviceRole> {
  return waitForMatchingRole(reader, undefined, timeoutMs);
}

export async function waitForBootRole(
  reader: SerialLineReader,
  expectedRole: Exclude<DeviceRole, "unknown">,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<DeviceRole> {
  return waitForMatchingRole(reader, expectedRole, timeoutMs, signal);
}

function waitForMatchingRole(
  reader: SerialLineReader,
  expectedRole: Exclude<DeviceRole, "unknown"> | undefined,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<DeviceRole> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (role: DeviceRole) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      removeLineListener();
      removeDisconnectListener();
      signal?.removeEventListener("abort", onAbort);
      resolve(role);
    };
    const removeLineListener = reader.onLine((line) => {
      const role = classifyBootLogLine(line);
      if (role && (!expectedRole || role === expectedRole)) finish(role);
    });
    const removeDisconnectListener = reader.onDisconnect(() => finish("unknown"));
    const onAbort = () => finish("unknown");
    const timeout = setTimeout(() => finish("unknown"), timeoutMs);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function closeUsbSession(port: SerialLike, reader: SerialLineReader): Promise<void> {
  await reader.stop();
  await port.close();
}

export async function openUsbLoaderSession(
  port: SerialLike,
  identityTimeoutMs = 5000
): Promise<UsbLoaderSession> {
  const reader = new SerialLineReader(port);
  const rolePromise = waitForDeviceRole(reader, identityTimeoutMs);
  await reader.start();
  const role = await rolePromise;
  if (role !== "loader") {
    await closeUsbSession(port, reader);
    throw new Error(
      role === "app"
        ? "The selected board is running an application, not the resident loader."
        : "Could not positively identify the selected board's firmware role over USB."
    );
  }
  return { port, reader, identity: "loader" };
}

export async function ensureUsbLoader(
  port: SerialLike,
  options: EnsureUsbLoaderOptions
): Promise<UsbLoaderSession> {
  const identityTimeoutMs = options.identityTimeoutMs ?? 5000;
  let activePort = port;
  let reader = new SerialLineReader(activePort);
  let keepOpen = false;

  try {
    const rolePromise = waitForDeviceRole(reader, identityTimeoutMs);
    await reader.start();
    const role = await rolePromise;
    if (role === "loader") {
      keepOpen = true;
      return { port: activePort, reader, identity: "loader" };
    }

    await closeUsbSession(activePort, reader);
    if (!options.allowOtadataReset) throw new MetadataResetConsentRequiredError();

    const recovery = await recoverIntoLoaderProtected(activePort, {
      ...options,
      allowOtadataReset: true,
    });
    activePort = await options.rediscoverPort(15000);
    reader = new SerialLineReader(activePort);
    const recoveredRolePromise = waitForDeviceRole(reader, 20000);
    await reader.start();
    const recoveredRole = await recoveredRolePromise;
    if (recoveredRole !== "loader") {
      throw new Error(
        "Recovery reset completed, but the same board did not positively identify as the resident loader. Check USB/BOOT/RESET and retry; no upload was started."
      );
    }
    keepOpen = true;
    return { port: activePort, reader, identity: "loader", recovery };
  } finally {
    if (!keepOpen) await closeUsbSession(activePort, reader);
  }
}

export interface HttpLoaderResult {
  identity: "loader";
  handedOff: boolean;
}

export async function ensureHttpLoader(
  ip: string,
  port = OTA_PORT,
  options: { timeoutMs?: number; pollIntervalMs?: number } = {}
): Promise<HttpLoaderResult> {
  const initialText = await fetchDeviceStatusText(ip, port);
  const initialRole = classifyStatusResponseText(initialText);
  if (initialRole === "loader") return { identity: "loader", handedOff: false };
  if (initialRole !== "app") {
    throw new Error("HTTP status endpoint did not positively identify a Papilio loader or compatible application.");
  }

  const handoffStatus = await requestGotoLoader(ip, port);
  if (handoffStatus === 404) {
    throw new Error("The identified application does not support POST /goto-loader; use explicit USB recovery if available.");
  }
  if (handoffStatus < 200 || handoffStatus >= 300) {
    throw new Error(`Application loader handoff failed with HTTP ${handoffStatus}.`);
  }

  const timeoutMs = options.timeoutMs ?? 20000;
  const pollIntervalMs = options.pollIntervalMs ?? 500;
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    try {
      const text = await fetchDeviceStatusText(ip, port);
      const role = classifyStatusResponseText(text);
      if (role === "loader") return { identity: "loader", handedOff: true };
      if (role === "unknown") lastError = "HTTP endpoint responded with an unknown firmware identity.";
    } catch (error) {
      lastError = error instanceof Error ? error.message : "HTTP status probe failed.";
    }
  }
  throw new Error(`Timed out waiting for the resident loader after HTTP handoff. ${lastError}`.trim());
}

export async function waitForHttpLoader(
  ip: string,
  port = OTA_PORT,
  timeoutMs = 20000,
  pollIntervalMs = 500
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const text = await fetchDeviceStatusText(ip, port);
      const role = classifyStatusResponseText(text);
      if (role === "loader") return;
      lastError = `HTTP endpoint identified ${role} firmware instead of the resident loader.`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : "HTTP status probe failed.";
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  throw new Error(`Timed out waiting for the resident loader over HTTP. ${lastError}`.trim());
}

export function parseUpdateTarget(responseText: string): "ota_0" | "ota_1" {
  const match = responseText.match(/\btarget:\s*(ota_[01])\b/i);
  if (!match) throw new Error(`Loader returned an invalid /update-target response: ${responseText.trim() || "(empty)"}`);
  return match[1].toLowerCase() === "ota_0" ? "ota_0" : "ota_1";
}
