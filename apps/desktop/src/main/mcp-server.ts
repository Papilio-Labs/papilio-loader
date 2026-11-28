// Flashing tools reuse @papilio-loader/flasher-core via NodeSerialAdapter.
// The same handlers serve both the Electron HTTP endpoint and standalone stdio.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createHash, randomUUID } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import type { Server as HttpServer } from "node:http";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import {
  classifyStatusResponseText,
  ensureHttpLoader,
  ensureUsbLoader,
  fetchDeviceStatusText,
  fetchUpdateTarget,
  flashEsp32,
  flashEsp32Ota,
  flashEsp32OverSerial,
  flashFpgaOta,
  flashFpgaOverSerial,
  identifyDeviceText,
  IP_REGEX,
  openUsbLoaderSession,
  parseUpdateTarget,
  resumeAppOverSerial,
  resumeEsp32Ota,
  SerialLineReader,
  validateFpgaBitstream,
  validateMergedLoaderImage,
  validateRawEsp32AppImage,
  waitForBootRole,
  waitForHttpLoader,
} from "@papilio-loader/flasher-core";
import {
  isSamePhysicalPort,
  NodeSerialAdapter,
  serialPortIdentity,
  type NodeSerialPortInfo,
} from "./node-serial-adapter.js";

const RETROCADE_VID = "303a";
const RETROCADE_PID = "1001";
const DEFAULT_HTTP_PORT = 3232;
const DEFAULT_APP_ID = "papilio-loader";

export interface McpServerOptions {
  appDataRoot?: string;
}

function getDefaultAppDataRoot(): string {
  if (process.env.APPDATA) return process.env.APPDATA;
  if (process.platform === "darwin") return path.join(homedir(), "Library", "Application Support");
  return process.env.XDG_CONFIG_HOME ?? path.join(homedir(), ".config");
}

function getAppDataDirectory(appDataRoot: string): string {
  return path.join(appDataRoot, DEFAULT_APP_ID);
}

function hasErrorCode(error: unknown, expected: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && Reflect.get(error, "code") === expected;
}

export function selectConsolePort(ports: NodeSerialPortInfo[], explicitPath?: string): NodeSerialPortInfo {
  if (explicitPath) {
    const explicit = ports.find((port) => port.path === explicitPath);
    if (!explicit) throw new Error(`Serial port "${explicitPath}" is not currently present.`);
    return explicit;
  }

  const papilioPorts = ports.filter(
    (port) => port.vendorId?.toLowerCase() === RETROCADE_VID && port.productId?.toLowerCase() === RETROCADE_PID
  );
  const consolePorts = papilioPorts.filter((port) => port.interfaceNumber === 0);
  if (consolePorts.length === 1) return consolePorts[0];
  if (consolePorts.length > 1 || papilioPorts.length > 1) {
    throw new Error(
      `Multiple Papilio serial interfaces are present. Pass an explicit console "port" (${papilioPorts.map((p) => p.path).join(", ")}).`
    );
  }
  if (papilioPorts.length === 1 && papilioPorts[0].interfaceNumber === undefined) return papilioPorts[0];
  if (papilioPorts.length === 1) {
    throw new Error(`Papilio interface ${papilioPorts[0].interfaceNumber} is not the native USB console interface 0.`);
  }
  throw new Error("No Papilio Retrocade USB console found. Connect the board or pass its explicit serial port.");
}

async function resolvePort(explicitPath?: string): Promise<NodeSerialPortInfo> {
  return selectConsolePort(await NodeSerialAdapter.listPorts(), explicitPath);
}

function hasStablePortIdentity(port: NodeSerialPortInfo): boolean {
  return Boolean(port.serialNumber || port.locationId || port.pnpId);
}

async function waitForSameBoard(previous: NodeSerialPortInfo, timeoutMs: number): Promise<NodeSerialPortInfo> {
  if (!hasStablePortIdentity(previous)) {
    throw new Error("The serial adapter exposes no stable board identity; refusing to recover or switch devices.");
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const matches = (await NodeSerialAdapter.listPorts()).filter((candidate) => isSamePhysicalPort(previous, candidate));
    if (matches.length > 1) throw new Error("More than one reconnected serial interface matches the selected board.");
    if (matches.length === 1) return matches[0];
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error("The selected physical board did not re-enumerate before the reconnect timeout.");
}

function md5(data: Uint8Array): Uint8Array {
  return createHash("md5").update(data).digest();
}

function sha256(data: Uint8Array): Uint8Array {
  return createHash("sha256").update(data).digest();
}

async function persistOtadataBackup(
  data: Uint8Array,
  identity: string,
  appDataDirectory: string
): Promise<{ location: string; data: Uint8Array }> {
  const backupDirectory = path.join(appDataDirectory, "loader-backups");
  await mkdir(backupDirectory, { recursive: true });
  const deviceHash = createHash("sha256").update(identity).digest("hex").slice(0, 16);
  const filename = `otadata-${deviceHash}-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}.bin`;
  const location = path.join(backupDirectory, filename);
  const file = await open(location, "wx");
  let written = false;
  try {
    await file.writeFile(data);
    await file.sync();
    written = true;
  } finally {
    await file.close();
    if (!written) await rm(location, { force: true });
  }
  const readBack = new Uint8Array(await readFile(location));
  return { location, data: readBack };
}

async function withMutationLock<T>(dataDirectory: string, key: string, operation: () => Promise<T>): Promise<T> {
  const lockDirectory = path.join(dataDirectory, "mcp-locks");
  await mkdir(lockDirectory, { recursive: true });
  const filename = `${createHash("sha256").update(key).digest("hex")}.lock`;
  const lockPath = path.join(lockDirectory, filename);
  const acquire = async () => {
    try {
      return await open(lockPath, "wx");
    } catch (error) {
      if (!hasErrorCode(error, "EEXIST")) throw error;
      let lockInfo: { pid?: number } | null = null;
      try {
        lockInfo = JSON.parse(await readFile(lockPath, "utf8")) as { pid?: number };
      } catch {
        return null;
      }
      if (!lockInfo?.pid || !Number.isInteger(lockInfo.pid) || lockInfo.pid <= 0) return null;
      try {
        process.kill(lockInfo.pid, 0);
        return null;
      } catch (processError) {
        if (!hasErrorCode(processError, "ESRCH")) return null;
        await rm(lockPath, { force: true });
        return open(lockPath, "wx");
      }
    }
  };
  let lock;
  try {
    lock = await acquire();
  } catch (error) {
    if (hasErrorCode(error, "EEXIST")) {
      throw new Error(`Another MCP mutation is already using this board. Close other Loader monitors and retry (lock: ${lockPath}).`);
    }
    throw error;
  }
  if (!lock) {
    throw new Error(`Another MCP mutation is already using this board. Close other Loader monitors and retry (lock: ${lockPath}).`);
  }

  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }));
    await lock.sync();
    return await operation();
  } finally {
    try {
      await lock.close();
    } finally {
      await rm(lockPath, { force: true });
    }
  }
}

async function createUsbLoaderSession(
  info: NodeSerialPortInfo,
  allowOtadataReset: boolean,
  appDataDirectory: string
) {
  if (!hasStablePortIdentity(info)) {
    throw new Error("This serial port has no stable board identity; refusing an operation that may reset the board.");
  }
  const identity = serialPortIdentity(info);
  try {
    return await ensureUsbLoader(new NodeSerialAdapter(info), {
      allowOtadataReset,
      md5,
      persistOtadataBackup: (data) => persistOtadataBackup(data, identity, appDataDirectory),
      rediscoverPort: async (timeoutMs) => {
        const reconnected = await waitForSameBoard(info, timeoutMs);
        return new NodeSerialAdapter(reconnected);
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (["EBUSY", "EACCES", "EPERM"].some((code) => hasErrorCode(error, code))) {
      throw new Error(`USB serial port is busy or access was denied. Close Loader monitors or other serial clients and retry. ${message}`);
    }
    throw new Error(
      `${message} If the USB console interface is unavailable, use the board's physical BOOT/RESET controls to restore it or select a positively identified HTTP loader. Do not switch to a different serial device.`
    );
  }
}

async function readReportedUsbIp(info: NodeSerialPortInfo): Promise<string> {
  const port = new NodeSerialAdapter(info);
  const reader = new SerialLineReader(port);
  let removeLineListener = () => {};
  let removeDisconnectListener = () => {};
  const ipPromise = new Promise<string | null>((resolve) => {
    let settled = false;
    const finish = (ip: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      removeLineListener();
      removeDisconnectListener();
      resolve(ip);
    };
    removeLineListener = reader.onLine((line) => {
      const match = line.match(IP_REGEX);
      if (match) finish(match[1]);
    });
    removeDisconnectListener = reader.onDisconnect(() => finish(null));
    const timeout = setTimeout(() => finish(null), 8000);
  });

  try {
    await reader.start();
    const ip = await ipPromise;
    if (!ip) throw new Error("Could not read the selected board's IP address over its USB console.");
    return ip;
  } finally {
    await reader.stop();
    await port.close();
  }
}

async function observeUsbApplication(
  info: NodeSerialPortInfo,
  activeRole?: "app" | "unknown"
): Promise<{ observed: boolean; error?: string }> {
  try {
    if (activeRole === "app") return { observed: true };
    const reconnected = await waitForSameBoard(info, 15000);
    const port = new NodeSerialAdapter(reconnected);
    const reader = new SerialLineReader(port);
    const rolePromise = waitForBootRole(reader, "app", 12000);
    try {
      await reader.start();
      const role = await rolePromise;
      return role === "app" ? { observed: true } : { observed: false, error: "No application identity was observed over USB." };
    } finally {
      await reader.stop();
      await port.close();
    }
  } catch (error) {
    return { observed: false, error: error instanceof Error ? error.message : "USB application observation failed." };
  }
}

async function waitForObservedBoot(observer: Promise<"app" | "unknown">): Promise<"app" | "unknown"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      observer,
      new Promise<"unknown">((resolve) => { timer = setTimeout(() => resolve("unknown"), 15000); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function observeHttpApplication(ip: string, port: number): Promise<{ observed: boolean; error?: string }> {
  const timeoutMs = 30000;
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const body = await fetchDeviceStatusText(ip, port, Math.min(1500, deadline - Date.now()));
      if (identifyDeviceText(body).role === "app") return { observed: true };
      lastError = "HTTP endpoint did not identify an application.";
    } catch (error) {
      lastError = error instanceof Error ? error.message : "HTTP application observation failed.";
    }
    const remaining = deadline - Date.now();
    if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(500, remaining)));
  }
  return {
    observed: false,
    error: `Timed out waiting for the application over HTTP after ${timeoutMs / 1000} seconds.${lastError ? ` Last status: ${lastError}` : ""}`,
  };
}

function textResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
  };
}

function errorResult(phase: string, error: unknown, details: Record<string, unknown> = {}) {
  const rawMessage = error instanceof Error ? error.message : String(error);
  const message = ["EBUSY", "EACCES", "EPERM"].some((code) => hasErrorCode(error, code))
    ? `USB serial port is busy or access was denied. Close Loader monitors or other serial clients and retry. ${rawMessage}`
    : rawMessage;
  return {
    isError: true,
    content: [{
      type: "text" as const,
      text: JSON.stringify({ success: false, phase, error: message, ...details }, null, 2),
    }],
  };
}

function assertUploadOptions(args: {
  address?: string;
  verify?: boolean;
  force?: boolean;
  stay_in_loader?: boolean;
  device_type: "esp32" | "fpga";
}): void {
  if (args.address !== undefined) throw new Error("Caller-supplied flash addresses are unsupported; use a logical upload target.");
  if (args.verify) throw new Error("Full-image readback verification is not supported by this protocol; no bytes have been written.");
  if (args.force) throw new Error("force cannot bypass device identity or recovery consent; use allow_ota_metadata_reset explicitly.");
  if (args.device_type === "esp32" && args.stay_in_loader) {
    throw new Error("stay_in_loader applies only to FPGA uploads; ESP app uploads boot the selected app automatically.");
  }
}

function assertBodyContains(response: string, expected: RegExp, operation: string): string {
  if (!expected.test(response)) throw new Error(`${operation} returned no documented success response: ${response.trim() || "(empty)"}`);
  return response;
}

async function requestHttpResume(ip: string, port: number): Promise<{
  resumeAcknowledged: boolean;
  response?: string;
  resumeWarning?: string;
}> {
  let response: string;
  try {
    response = await resumeEsp32Ota(ip, port);
  } catch (error) {
    if (!(error instanceof TypeError) && !(error instanceof DOMException && error.name === "AbortError")) throw error;
    return { resumeAcknowledged: false, resumeWarning: `Resume response was not received: ${error.message}.` };
  }
  assertBodyContains(response, /^Resuming 'ota_[01]'\./, "Loader resume");
  return { resumeAcknowledged: true, response };
}

function createNodePoster() {
  return {
    post: async (url: string, body: BodyInit) => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 300000);
      try {
        const response = await fetch(url, { method: "POST", body, signal: controller.signal });
        const responseText = await response.text();
        if (!response.ok) throw new Error(`HTTP ${response.status}: ${responseText || response.statusText}`);
        return responseText;
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

export function createServer(options: McpServerOptions = {}): McpServer {
  const appDataDirectory = getAppDataDirectory(options.appDataRoot ?? getDefaultAppDataRoot());
  const server = new McpServer({ name: "papilio-loader", version: "0.5.2" });

  server.tool("list_serial_ports", "List serial ports and USB identity metadata. Interface 0 is the RetroCade USB console.", {}, async () => {
    return textResult(await NodeSerialAdapter.listPorts());
  });

  server.tool(
    "get_device_info",
    "Get USB metadata for a connected board. This does not probe firmware role or change board state.",
    { port: z.string().optional(), device_type: z.enum(["esp32", "fpga"]) },
    async ({ port }) => {
      const info = await resolvePort(port);
      return textResult({ ...info, firmwareRole: "not-probed" });
    }
  );

  server.tool(
    "get_flash_status",
    "Check whether a serial port is enumerated. This read-only check does not reset or probe the board.",
    { port: z.string().optional(), device_type: z.enum(["esp32", "fpga"]) },
    async ({ port }) => {
      try {
        const info = await resolvePort(port);
        return textResult({ enumerated: true, firmwareRole: "not-probed", port: info.path });
      } catch (error) {
        return textResult({ enumerated: false, firmwareRole: "not-probed", error: error instanceof Error ? error.message : String(error) });
      }
    }
  );

  server.tool(
    "flash_device",
    "Upload over USB. ESP32 defaults to a raw app image written into the loader-selected OTA slot; merged full-flash images require mode=provision. FPGA defaults to persistent FPGA flash. Recovery from an app requires explicit allow_ota_metadata_reset consent and a verified otadata backup.",
    {
      port: z.string().optional(),
      device_type: z.enum(["esp32", "fpga"]),
      file_path: z.string(),
      mode: z.enum(["resident", "provision"]).default("resident"),
      fpga_target: z.enum(["flash", "sram"]).default("flash"),
      stay_in_loader: z.boolean().default(false),
      allow_ota_metadata_reset: z.boolean().default(false),
      address: z.string().optional(),
      verify: z.boolean().optional(),
      force: z.boolean().optional(),
    },
    async (args) => {
      let phase = "preflight";
      let bytesAcknowledged = 0;
      try {
        assertUploadOptions(args);
        if (args.mode === "provision" && args.device_type !== "esp32") {
          throw new Error("mode=provision is only available for merged ESP32 images.");
        }
        let data: Uint8Array = new Uint8Array(await readFile(args.file_path));
        if (args.device_type === "esp32") {
          if (args.mode === "resident") validateRawEsp32AppImage(data);
          else data = validateMergedLoaderImage(data, md5, sha256);
        } else {
          if (args.mode !== "resident") throw new Error("FPGA uploads use resident mode only.");
          validateFpgaBitstream(data);
        }

        phase = "identify";
        const info = await resolvePort(args.port);
        const lockKey = `usb:${serialPortIdentity(info)}`;
        return await withMutationLock(appDataDirectory, lockKey, async () => {
          if (args.mode === "provision") {
            phase = "provision";
            const result = await flashEsp32(new NodeSerialAdapter(info), data, { expectedChipName: "ESP32-S3" });
            return textResult({
              success: true,
              phase: "completed",
              transport: "usb-esptool",
              device: info,
              destination: "complete 4 MB ESP image at flash offset 0",
              chip: result.chipName,
              bytesWritten: data.byteLength,
              completionAcknowledged: true,
              verification: "not-performed",
              bootObserved: false,
            });
          }

          phase = "enter_loader";
          let session;
          let sessionClosed = false;
          let bootController: AbortController | undefined;
          try {
            session = await createUsbLoaderSession(info, args.allow_ota_metadata_reset, appDataDirectory);
            bootController = new AbortController();
            const bootObserver = args.stay_in_loader
              ? undefined
              : waitForBootRole(session.reader, "app", 300000, bootController.signal)
                  .then((role) => role === "app" ? "app" as const : "unknown" as const);

            phase = "upload";
            const uploaded = args.device_type === "esp32"
              ? await flashEsp32OverSerial(session.port, session.reader, data, (loaded) => { bytesAcknowledged = loaded; })
              : await flashFpgaOverSerial(session.port, session.reader, args.fpga_target, data, (loaded) => { bytesAcknowledged = loaded; });

            if (args.device_type === "fpga" && !args.stay_in_loader) {
              phase = "resume";
              try {
                await resumeAppOverSerial(session.port, session.reader);
              } catch (error) {
                return errorResult(phase, error, {
                  imageWritten: true,
                  bytesAcknowledged: uploaded.bytesAcknowledged,
                  completionAcknowledged: uploaded.completionAcknowledged,
                  destination: args.fpga_target === "flash" ? "fpga-flash" : "fpga-sram",
                });
              }
            }

            if (args.stay_in_loader) {
              return textResult({
                success: true,
                phase: "completed",
                transport: "usb-serial",
                device: info,
                loaderIdentity: "Papilio ESP Bootloader",
                metadataReset: session.recovery?.metadataReset ?? false,
                backupLocation: session.recovery?.backupLocation ?? null,
                destination: args.device_type === "esp32"
                  ? "loader-selected OTA slot"
                  : args.fpga_target === "flash" ? "fpga-flash" : "fpga-sram",
                destinationObserved: false,
                bytesAcknowledged: uploaded.bytesAcknowledged,
                completionAcknowledged: uploaded.completionAcknowledged,
                verification: "protocol-acknowledgement-only",
                bootObserved: false,
              });
            }

            phase = "boot_observation";
            const activeRole = bootObserver ? await waitForObservedBoot(bootObserver) : undefined;
            await session.reader.stop();
            await session.port.close();
            sessionClosed = true;
            const boot = await observeUsbApplication(info, activeRole);
            if (!boot.observed) {
              return errorResult(phase, new Error(boot.error ?? "Application boot was not observed."), {
                imageWritten: true,
                bytesAcknowledged: uploaded.bytesAcknowledged,
                completionAcknowledged: uploaded.completionAcknowledged,
                metadataReset: session.recovery?.metadataReset ?? false,
                backupLocation: session.recovery?.backupLocation ?? null,
                bootObserved: false,
              });
            }

            return textResult({
              success: true,
              phase: "completed",
              transport: "usb-serial",
              device: info,
              loaderIdentity: "Papilio ESP Bootloader",
              metadataReset: session.recovery?.metadataReset ?? false,
              backupLocation: session.recovery?.backupLocation ?? null,
              destination: args.device_type === "esp32"
                ? "loader-selected OTA slot"
                : args.fpga_target === "flash" ? "fpga-flash" : "fpga-sram",
              destinationObserved: false,
              bytesAcknowledged: uploaded.bytesAcknowledged,
              completionAcknowledged: uploaded.completionAcknowledged,
              verification: "protocol-acknowledgement-only",
              bootObserved: true,
            });
          } finally {
            bootController?.abort(new Error("USB application observation ended."));
            if (session && !sessionClosed) {
              await session.reader.stop();
              await session.port.close();
            }
          }
        });
      } catch (error) {
        return errorResult(
          phase,
          error,
          phase === "upload"
            ? { bytesAcknowledged, imageWritten: "unknown", completionAcknowledged: false }
            : {}
        );
      }
    }
  );

  server.tool(
    "flash_device_ota",
    "Upload over HTTP only after positively identifying the resident loader. A compatible app may be handed off via /goto-loader. USB-assisted recovery is opt-in and requires usb_port plus board-IP identity confirmation.",
    {
      ip: z.string(),
      device_type: z.enum(["esp32", "fpga"]),
      file_path: z.string(),
      port: z.number().int().positive().default(DEFAULT_HTTP_PORT),
      fpga_target: z.enum(["flash", "sram"]).default("flash"),
      stay_in_loader: z.boolean().default(false),
      usb_port: z.string().optional(),
      allow_ota_metadata_reset: z.boolean().default(false),
      verify: z.boolean().optional(),
    },
    async (args) => {
      let phase = "preflight";
      let handoffWarning: string | undefined;
      try {
        if (args.verify) throw new Error("Full-image readback verification is unsupported; no bytes have been written.");
        if (args.device_type === "esp32" && args.stay_in_loader) {
          throw new Error("stay_in_loader applies only to FPGA uploads; ESP app uploads boot the selected app automatically.");
        }
        if (!args.usb_port && args.allow_ota_metadata_reset) {
          throw new Error("allow_ota_metadata_reset applies only when an explicit usb_port is supplied.");
        }
        const data = new Uint8Array(await readFile(args.file_path));
        if (args.device_type === "esp32") validateRawEsp32AppImage(data);
        else validateFpgaBitstream(data);

        let usbInfo: NodeSerialPortInfo | undefined;
        if (args.usb_port) usbInfo = await resolvePort(args.usb_port);
        const lockKey = usbInfo
          ? `usb:${serialPortIdentity(usbInfo)}`
          : `http:${args.ip}:${args.port}`;

        return await withMutationLock(appDataDirectory, lockKey, async () => {
          let session;
          let sessionClosed = false;
          let bootController: AbortController | undefined;
          try {
            if (usbInfo) {
              phase = "confirm_usb_network_identity";
              const reportedIp = await readReportedUsbIp(usbInfo);
              if (reportedIp !== args.ip) {
                throw new Error(`Selected USB board reports ${reportedIp}, not requested network host ${args.ip}.`);
              }
              phase = "enter_loader";
              session = await createUsbLoaderSession(usbInfo, args.allow_ota_metadata_reset, appDataDirectory);
              await waitForHttpLoader(args.ip, args.port);
            } else {
              phase = "identify_http_loader";
              handoffWarning = (await ensureHttpLoader(args.ip, args.port)).handoffWarning;
            }

            bootController = session ? new AbortController() : undefined;
            const bootObserver = session && !args.stay_in_loader
              ? waitForBootRole(session.reader, "app", 300000, bootController?.signal)
                  .then((role) => role === "app" ? "app" as const : "unknown" as const)
              : undefined;
            const poster = createNodePoster();
            let uploadedBytes = data.byteLength;
            let destination: string;
            let response: string;
            let selectedSlot: string | undefined;
            let resumeResult: Awaited<ReturnType<typeof requestHttpResume>> | undefined;

            phase = "upload";
            if (args.device_type === "esp32") {
              selectedSlot = parseUpdateTarget(await fetchUpdateTarget(args.ip, args.port));
              destination = selectedSlot;
              response = assertBodyContains(
                await flashEsp32Ota(poster, args.ip, data, () => {}, args.port),
                /^App update successful\./,
                "ESP32 OTA"
              );
            } else {
              const endpoint = args.fpga_target === "flash" ? "/fpga-update" : "/fpga-jtag-sram";
              destination = args.fpga_target === "flash" ? "fpga-flash" : "fpga-sram";
              response = assertBodyContains(
                await flashFpgaOta(poster, args.ip, endpoint, data, () => {}, args.port),
                args.fpga_target === "flash" ? /FPGA flash update successful!/ : /FPGA programmed successfully via JTAG!/,
                "FPGA OTA"
              );
            }

            if (args.device_type === "fpga" && !args.stay_in_loader) {
              phase = "resume";
              try {
                resumeResult = await requestHttpResume(args.ip, args.port);
              } catch (error) {
                return errorResult(phase, error, {
                  imageWritten: true,
                  bytesAcknowledged: uploadedBytes,
                  destination,
                  response,
                  handoffWarning,
                });
              }
            }

            if (args.stay_in_loader) {
              return textResult({
                success: true,
                phase: "completed",
                transport: "http",
                device: { ip: args.ip, port: args.port },
                loaderIdentity: "Papilio ESP Bootloader",
                destination,
                selectedSlot,
                bytesAcknowledged: uploadedBytes,
                completionAcknowledged: true,
                response,
                verification: "http-success-response-only",
                bootObserved: false,
                handoffWarning,
              });
            }

            phase = "boot_observation";
            const activeRole = bootObserver ? await waitForObservedBoot(bootObserver) : undefined;
            if (session) {
              await session.reader.stop();
              await session.port.close();
              sessionClosed = true;
            }
            const boot = session
              ? await observeUsbApplication(usbInfo!, activeRole)
              : await observeHttpApplication(args.ip, args.port);
            if (!boot.observed) {
              return errorResult(phase, new Error(boot.error ?? "Application boot was not observed."), {
                imageWritten: true,
                bytesAcknowledged: uploadedBytes,
                destination,
                selectedSlot,
                completionAcknowledged: true,
                bootObserved: false,
                handoffWarning,
                resumeAcknowledged: resumeResult?.resumeAcknowledged,
                resumeWarning: resumeResult?.resumeWarning,
              });
            }

            return textResult({
              success: true,
              phase: "completed",
              transport: "http",
              device: { ip: args.ip, port: args.port },
              loaderIdentity: "Papilio ESP Bootloader",
              destination,
              selectedSlot,
              bytesAcknowledged: uploadedBytes,
              completionAcknowledged: true,
              response,
              verification: "http-success-response-only",
              bootObserved: true,
              handoffWarning,
              resumeAcknowledged: resumeResult?.resumeAcknowledged,
              resumeWarning: resumeResult?.resumeWarning,
            });
          } finally {
            bootController?.abort(new Error("HTTP application observation ended."));
            if (session && !sessionClosed) {
              await session.reader.stop();
              await session.port.close();
              sessionClosed = true;
            }
          }
        });
      } catch (error) {
        return errorResult(
          phase,
          error,
          phase === "upload"
            ? { bytesAcknowledged: null, imageWritten: "unknown", handoffWarning }
            : { handoffWarning }
        );
      }
    }
  );

  server.tool(
    "enter_bootloader",
    "Explicitly enter or positively confirm the resident loader over USB or HTTP. USB recovery may clear OTA selection/rollback metadata only with allow_ota_metadata_reset=true and after a verified backup.",
    {
      transport: z.enum(["usb", "http"]),
      port: z.string().optional(),
      ip: z.string().optional(),
      http_port: z.number().int().positive().default(DEFAULT_HTTP_PORT),
      allow_ota_metadata_reset: z.boolean().default(false),
    },
    async (args) => {
      let phase = "identify";
      try {
        if (args.transport === "usb") {
          const info = await resolvePort(args.port);
          return await withMutationLock(appDataDirectory, `usb:${serialPortIdentity(info)}`, async () => {
            let session;
            try {
              phase = "enter_loader";
              session = await createUsbLoaderSession(info, args.allow_ota_metadata_reset, appDataDirectory);
              return textResult({
                success: true,
                phase: "completed",
                transport: "usb-serial",
                device: info,
                loaderIdentity: "Papilio ESP Bootloader",
                metadataReset: session.recovery?.metadataReset ?? false,
                backupLocation: session.recovery?.backupLocation ?? null,
              });
            } finally {
              if (session) {
                await session.reader.stop();
                await session.port.close();
              }
            }
          });
        }

        if (!args.ip) throw new Error("ip is required for HTTP loader entry.");
        const ip = args.ip;
        phase = "enter_loader";
        return await withMutationLock(appDataDirectory, `http:${ip}:${args.http_port}`, async () => {
          const result = await ensureHttpLoader(ip, args.http_port);
          return textResult({
            success: true,
            phase: "completed",
            transport: "http",
            device: { ip, port: args.http_port },
            loaderIdentity: result.identity,
            handedOff: result.handedOff,
            handoffWarning: result.handoffWarning,
            metadataReset: false,
          });
        });
      } catch (error) {
        return errorResult(phase, error);
      }
    }
  );

  server.tool(
    "resume_application",
    "Explicitly send RESUME_APP or POST /resume to a positively identified resident loader. This tool does not flash or enter recovery.",
    {
      transport: z.enum(["usb", "http"]),
      port: z.string().optional(),
      ip: z.string().optional(),
      http_port: z.number().int().positive().default(DEFAULT_HTTP_PORT),
    },
    async (args) => {
      let phase = "identify_loader";
      try {
        if (args.transport === "usb") {
          const info = await resolvePort(args.port);
          return await withMutationLock(appDataDirectory, `usb:${serialPortIdentity(info)}`, async () => {
            const session = await openUsbLoaderSession(new NodeSerialAdapter(info));
            const bootController = new AbortController();
            const bootObserver = waitForBootRole(session.reader, "app", 15000, bootController.signal)
              .then((role) => role === "app" ? "app" as const : "unknown" as const);
            try {
              phase = "resume";
              await resumeAppOverSerial(session.port, session.reader);
              phase = "boot_observation";
              const activeRole = await bootObserver;
              await session.reader.stop();
              await session.port.close();
              const boot = await observeUsbApplication(info, activeRole);
              if (!boot.observed) {
                return errorResult(phase, new Error(boot.error ?? "Application boot was not observed."), {
                  resumeAcknowledged: true,
                  bootObserved: false,
                });
              }
              return textResult({
                success: true,
                phase: "completed",
                transport: "usb-serial",
                device: info,
                resumeAcknowledged: true,
                bootObserved: true,
              });
            } finally {
              bootController.abort(new Error("USB application observation ended."));
              await session.reader.stop();
              await session.port.close();
            }
          });
        }

        if (!args.ip) throw new Error("ip is required for HTTP resume.");
        const ip = args.ip;
        return await withMutationLock(appDataDirectory, `http:${ip}:${args.http_port}`, async () => {
          const status = await fetchDeviceStatusText(ip, args.http_port);
          if (classifyStatusResponseText(status) !== "loader") {
            throw new Error("HTTP endpoint did not positively identify the resident loader; resume was not sent.");
          }
          phase = "resume";
          const resumeResult = await requestHttpResume(ip, args.http_port);
          phase = "boot_observation";
          const boot = await observeHttpApplication(ip, args.http_port);
          if (!boot.observed) {
            return errorResult(phase, new Error(boot.error ?? "Application boot was not observed."), {
              ...resumeResult,
              bootObserved: false,
            });
          }
          return textResult({
            success: true,
            phase: "completed",
            transport: "http",
            device: { ip, port: args.http_port },
            ...resumeResult,
            bootObserved: true,
          });
        });
      } catch (error) {
        return errorResult(phase, error);
      }
    }
  );

  server.tool(
    "discover_ota_devices",
    "Scan the local /24 subnet for boards with the OTA HTTP server (port 3232) reachable.",
    { timeout: z.number().optional(), port: z.number().optional() },
    async ({ timeout, port }) => {
      const { discoverOtaDevices } = await import("./lan-discovery.js");
      const devices = await discoverOtaDevices(timeout, port);
      return textResult({ devicesFound: devices.length, devices });
    }
  );

  server.tool(
    "check_device_ip",
    "Check whether a specific IP address has an OTA HTTP server reachable.",
    { ip: z.string(), port: z.number().optional() },
    async ({ ip, port }) => {
      const { checkDeviceIp } = await import("./lan-discovery.js");
      return textResult({ ip, available: await checkDeviceIp(ip, port) });
    }
  );

  return server;
}

export async function startStdioMcpServer(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

export interface HttpMcpServerHandle {
  port: number;
  close(): Promise<void>;
}

export async function startHttpMcpServer(port: number, appDataRoot?: string): Promise<HttpMcpServerHandle> {
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const transports = new Set<StreamableHTTPServerTransport>();

  const httpServer: HttpServer = createHttpServer((req, res) => {
    if (req.url !== "/mcp") {
      res.writeHead(404).end("Not found");
      return;
    }

    void (async () => {
      const sessionId = req.headers["mcp-session-id"];
      if (typeof sessionId === "string") {
        const transport = sessions.get(sessionId);
        if (!transport) {
          res.writeHead(404).end("MCP session not found");
          return;
        }
        await transport.handleRequest(req, res);
        return;
      }

      if (req.method !== "POST" || sessionId !== undefined) {
        res.writeHead(400).end("MCP session ID required");
        return;
      }

      const server = createServer({ appDataRoot });
      const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => { sessions.set(id, transport); },
      });
      transports.add(transport);
      try {
        await server.connect(transport);
        const onClose = transport.onclose;
        transport.onclose = () => {
          if (transport.sessionId) sessions.delete(transport.sessionId);
          transports.delete(transport);
          onClose?.();
        };
        await transport.handleRequest(req, res);
      } finally {
        if (!transport.sessionId) {
          transports.delete(transport);
          await transport.close();
        }
      }
    })().catch((error: unknown) => {
      console.error("MCP HTTP request failed:", error);
      if (!res.headersSent) res.writeHead(500).end("MCP HTTP request failed");
      else res.destroy();
    });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, "127.0.0.1", resolve);
  });

  const address = httpServer.address();
  if (!address || typeof address === "string") throw new Error("MCP HTTP server did not bind to a TCP port.");
  return {
    port: address.port,
    close: async () => {
      await Promise.all([...transports].map((transport) => transport.close()));
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => error ? reject(error) : resolve());
      });
    },
  };
}
