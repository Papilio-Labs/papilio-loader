// ota.ts — HTTP OTA client for the loader's /update, /update-target,
// /resume, and /fpga-jtag-sram routes, plus a couple of GET-only status
// helpers used to classify a board before deciding how to recover it (see
// device-status.ts). The actual POST is injected via an OtaPoster so this
// file stays DOM-free: the web build supplies an XHR-based poster (for real
// upload-progress events), the desktop build can use a Node fetch/http
// poster with no CORS constraints at all.
export type OtaProgressCallback = (loaded: number, total: number) => void;

export interface OtaPoster {
  post(url: string, body: BodyInit, onProgress: OtaProgressCallback): Promise<string>;
}

export const OTA_PORT = 3232;

// POST /update — semantics changed in Phase 7: this no longer means "the
// app is updating itself" (the old FPGA-Companion self-OTA), it means "the
// loader is writing a fresh app image into whichever ota_0/ota_1 slot is
// currently inactive". The wire format (raw body, same URL) is unchanged.
export async function flashEsp32Ota(
  poster: OtaPoster,
  ip: string,
  data: Uint8Array,
  onProgress: OtaProgressCallback,
  port: number = OTA_PORT
): Promise<string> {
  const url = `http://${ip}:${port}/update`;
  return poster.post(url, data as BodyInit, onProgress);
}

// POST /resume — the "return to user app" end state: tells the loader to
// set the boot partition back to whatever ota slot it wasn't just writing
// (loader_get_resume_partition()) and reboot into it, without flashing
// anything.
export async function resumeEsp32Ota(ip: string, port: number = OTA_PORT): Promise<string> {
  const res = await fetch(`http://${ip}:${port}/resume`, { method: "POST" });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text().catch(() => res.statusText)}`);
  return res.text();
}

// GET /update-target — reports which ota slot a subsequent POST /update
// would write to, so the UI can show it before the user commits.
export async function fetchUpdateTarget(ip: string, port: number = OTA_PORT): Promise<string> {
  const res = await fetch(`http://${ip}:${port}/update-target`);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text().catch(() => res.statusText)}`);
  return res.text();
}

// GET / — both the loader and FPGA-Companion (post-Phase-6) serve a plain
// text status/banner page here; feed the body into
// device-status.ts#classifyStatusResponseText() to tell them apart.
export async function fetchDeviceStatusText(ip: string, port: number = OTA_PORT, timeoutMs: number = 1500): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://${ip}:${port}/`, { signal: controller.signal });
    return res.text();
  } finally {
    clearTimeout(timeout);
  }
}

// POST /goto-loader — only registered on post-Phase-6 FPGA-Companion
// builds; returns the raw HTTP status so callers can feed it into
// device-status.ts#isLegacyPreMigrationApp() (404 => pre-Phase-6 build that
// never had this route).
export async function requestGotoLoader(ip: string, port: number = OTA_PORT, timeoutMs: number = 2000): Promise<number> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://${ip}:${port}/goto-loader`, {
      method: "POST",
      signal: controller.signal,
    });
    return res.status;
  } finally {
    clearTimeout(timeout);
  }
}

// FPGA OTA targets supported by the Phase 7 loader. SPI Flash is the default
// persistent target; JTAG SRAM remains available for quick volatile tests.
export type FpgaOtaEndpoint = "/fpga-update" | "/fpga-jtag-sram";

export async function flashFpgaOta(
  poster: OtaPoster,
  ip: string,
  endpoint: FpgaOtaEndpoint,
  body: BodyInit,
  onProgress: OtaProgressCallback,
  port: number = OTA_PORT
): Promise<string> {
  const url = `http://${ip}:${port}${endpoint}`;
  return poster.post(url, body, onProgress);
}

export interface RomUploadOptions {
  // "root" saves to the SD-card root (FPGA-Companion v2.1.0+). Omitted, the
  // Companion saves to /roms/.
  location?: "root";
}

// POST /rom-load?name=... — writes a ROM image to the Companion's SD card
// and asks the active core to insert it into drive 0.
export async function uploadRomOta(
  poster: OtaPoster,
  ip: string,
  fileName: string,
  body: BodyInit,
  onProgress: OtaProgressCallback,
  port: number = OTA_PORT,
  options: RomUploadOptions = {}
): Promise<string> {
  const location = options.location ? `&location=${encodeURIComponent(options.location)}` : "";
  const url = `http://${ip}:${port}/rom-load?name=${encodeURIComponent(fileName)}${location}`;
  return poster.post(url, body, onProgress);
}

// Browser-only poster (uses XMLHttpRequest for real upload.onprogress events
// — fetch()'s ReadableStream request bodies don't expose upload progress in
// any browser yet). Kept in this file behind a runtime guard rather than a
// separate browser-only module, since XHR is the only DOM API this file
// touches and only when actually invoked.
export function createBrowserXhrPoster(): OtaPoster {
  return {
    post(url, body, onProgress) {
      return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", url);
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) onProgress(e.loaded, e.total);
        };
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve(xhr.responseText);
          } else {
            reject(new Error(`HTTP ${xhr.status}: ${xhr.responseText || xhr.statusText}`));
          }
        };
        xhr.onerror = () => reject(new Error("Network error — check the device is on the same WiFi network"));
        xhr.send(body as XMLHttpRequestBodyInit);
      });
    },
  };
}
