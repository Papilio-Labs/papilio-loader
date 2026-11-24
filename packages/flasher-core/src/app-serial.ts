// app-serial.ts — the APP_FLASH_BEGIN serial protocol (see
// papilio-esp-bootloader/main/serial_flash.c try_handle_app_flash_begin()):
// stream an ESP32 app image into whichever ota_0/ota_1 slot is inactive,
// over the same USB serial port used for FPGA bitstream flashing. Added in
// Phase 7 (host tooling) -- Phase 4 only ported the firmware side, the host
// tooling kept using a full esptool merged-image flash instead.
//
import type { SerialLike } from "./transport.js";
import type { SerialLineReader } from "./serial-log.js";
import type { ProgressCallback } from "./fpga-serial.js";

const CHUNK = 4096;
const MAX_APP_SIZE = 0x180000;

export interface SerialUploadResult {
  bytesAcknowledged: number;
  completionAcknowledged: true;
}

function expectProgress(
  reader: SerialLineReader,
  expectedEnd: number,
  timeoutMs: number,
  protocol: "APP_FLASH" | "FPGA_FLASH",
  signal: AbortSignal
): Promise<string> {
  return reader.waitForLine(
    new RegExp(`^PROGRESS \\d+$|^${protocol}_ERROR .+`),
    timeoutMs,
    undefined,
    signal
  ).then((line) => {
    if (line.startsWith(`${protocol}_ERROR `)) throw new Error(`Board reported: ${line}`);
    if (line !== `PROGRESS ${expectedEnd}`) {
      throw new Error(`Unexpected progress acknowledgement: expected ${expectedEnd} bytes, received "${line}".`);
    }
    return line;
  });
}

export async function resumeAppOverSerial(port: SerialLike, reader: SerialLineReader): Promise<void> {
  if (!port) throw new Error("No USB serial port connected.");
  if (!reader.isRunning) await reader.start();
  if (!port.writable) throw new Error("No USB serial port connected.");

  const writer = port.writable.getWriter();
  const controller = new AbortController();
  try {
    const resultPromise = reader.waitForLine(/^RESUME_OK$|^RESUME_ERROR /, 10000, undefined, controller.signal);
    void resultPromise.catch(() => {});
    await writer.write(new TextEncoder().encode("RESUME_APP\n"));
    const resultLine = await resultPromise;
    if (resultLine.startsWith("RESUME_ERROR")) {
      throw new Error(`Board reported: ${resultLine}`);
    }
  } finally {
    controller.abort(new Error("Serial resume request ended."));
    writer.releaseLock();
  }
}

export async function flashEsp32OverSerial(
  port: SerialLike,
  reader: SerialLineReader,
  data: Uint8Array,
  onProgress: ProgressCallback
): Promise<SerialUploadResult> {
  if (!port) throw new Error("No USB serial port connected.");
  if (!reader.isRunning) await reader.start();
  if (!port.writable) throw new Error("No USB serial port connected.");

  const size = data.byteLength;
  if (size === 0 || size > MAX_APP_SIZE) {
    throw new Error(`ESP32 app image must contain 1 to ${MAX_APP_SIZE} bytes.`);
  }
  const encoder = new TextEncoder();
  const writer = port.writable.getWriter();
  const controller = new AbortController();

  try {
    const readyPromise = reader.waitForLine(/^READY$|^APP_FLASH_ERROR /, 10000, undefined, controller.signal);
    void readyPromise.catch(() => {});
    await writer.write(encoder.encode(`APP_FLASH_BEGIN ${size}\n`));
    const readyLine = await readyPromise;
    if (readyLine.startsWith("APP_FLASH_ERROR")) {
      throw new Error(`Board rejected request: ${readyLine}`);
    }

    for (let offset = 0; offset < size; offset += CHUNK) {
      const end = Math.min(offset + CHUNK, size);
      const ackPromise = expectProgress(reader, end, offset === 0 ? 120000 : 20000, "APP_FLASH", controller.signal);
      void ackPromise.catch(() => {});
      const donePromise =
        end === size
          ? reader.waitForLine(/^APP_FLASH_OK$|^APP_FLASH_ERROR /, 60000, undefined, controller.signal)
          : null;
      if (donePromise) void donePromise.catch(() => {});

      await writer.write(data.slice(offset, end));
      await ackPromise;
      onProgress(end, size);

      if (donePromise) {
        const resultLine = await donePromise;
        if (resultLine.startsWith("APP_FLASH_ERROR")) {
          throw new Error(`Board reported: ${resultLine}`);
        }
      }
    }

    return { bytesAcknowledged: size, completionAcknowledged: true };
  } finally {
    controller.abort(new Error("Serial app upload ended."));
    writer.releaseLock();
  }
}
