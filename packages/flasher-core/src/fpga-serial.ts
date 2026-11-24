// fpga-serial.ts — the FPGA_FLASH_BEGIN serial protocol (see
// FPGA-Companion/src/esp32/serial_flash.h): stream a bitstream to SPI flash
// or JTAG SRAM over the same USB serial port used for ESP32 flashing and
// WiFi provisioning. Ported from flash.js/loader.js's flashFpgaOverSerial().
import type { SerialLike } from "./transport.js";
import type { SerialLineReader } from "./serial-log.js";

export type FpgaSerialTarget = "flash" | "sram";

// The loader (papilio-esp-bootloader) implements both targets over this
// protocol as of Phase 6.5: target=sram (volatile, JTAG SRAM) and
// target=flash (persistent, the FPGA's own SPI flash chip).
export const SERIAL_FPGA_TARGET: Record<string, FpgaSerialTarget> = {
  "/fpga-jtag-sram": "sram",
  "/fpga-update": "flash",
};

export type ProgressCallback = (loaded: number, total: number) => void;

export interface SerialFpgaUploadResult {
  bytesAcknowledged: number;
  completionAcknowledged: true;
}

export async function flashFpgaOverSerial(
  port: SerialLike,
  reader: SerialLineReader,
  target: FpgaSerialTarget,
  data: Uint8Array,
  onProgress: ProgressCallback
): Promise<SerialFpgaUploadResult> {
  if (!port) throw new Error("No USB serial port connected.");
  // "Connect USB" only selects a port — it doesn't open it. Opening happens
  // lazily here (matching loader.js's flashFpgaOverSerial()) so a port
  // chosen via the top "Connect USB" button (without also using Find IP or
  // Send WiFi, which already start the listener) still works.
  if (!reader.isRunning) await reader.start();
  if (!port.writable) throw new Error("No USB serial port connected.");

  const size = data.byteLength;
  if (size === 0 || size > 0x200000) {
    throw new Error("FPGA image must contain 1 to 2097152 bytes.");
  }
  const encoder = new TextEncoder();
  const writer = port.writable.getWriter();
  const controller = new AbortController();

  try {
    // READY is emitted before the FPGA bridge is prepared and flash erased.
    const readyPromise = reader.waitForLine(/^READY$|^FPGA_FLASH_ERROR /, 10000, undefined, controller.signal);
    void readyPromise.catch(() => {});
    await writer.write(encoder.encode(`FPGA_FLASH_BEGIN ${target} ${size}\n`));
    const readyLine = await readyPromise;
    if (readyLine.startsWith("FPGA_FLASH_ERROR")) {
      throw new Error(`Board rejected request: ${readyLine}`);
    }

    if (target === "flash") {
      const CHUNK = 4096;
      for (let offset = 0; offset < size; offset += CHUNK) {
        const end = Math.min(offset + CHUNK, size);
        const ackPromise = reader.waitForLine(
          /^PROGRESS \d+$|^FPGA_FLASH_ERROR /,
          offset === 0 ? 120000 : 20000,
          undefined,
          controller.signal
        );
        void ackPromise.catch(() => {});
        const donePromise =
          end === size
            ? reader.waitForLine(/^FPGA_FLASH_OK$|^FPGA_FLASH_ERROR /, 180000, undefined, controller.signal)
            : null;
        if (donePromise) void donePromise.catch(() => {});

        await writer.write(data.slice(offset, end));
        const ackLine = await ackPromise;
        if (ackLine.startsWith("FPGA_FLASH_ERROR ")) throw new Error(`Board reported: ${ackLine}`);
        if (ackLine !== `PROGRESS ${end}`) {
          throw new Error(`Unexpected progress acknowledgement: expected ${end} bytes, received "${ackLine}".`);
        }
        onProgress(end, size);

        if (donePromise) {
          const resultLine = await donePromise;
          if (resultLine.startsWith("FPGA_FLASH_ERROR")) throw new Error(`Board reported: ${resultLine}`);
        }
      }
    } else {
      const CHUNK = 16384;
      const donePromise = reader.waitForLine(
        /^FPGA_FLASH_OK$|^FPGA_FLASH_ERROR /,
        180000,
        (line) => {
          const m = line.match(/^PROGRESS (\d+)/);
          if (m) onProgress(parseInt(m[1], 10), size);
        },
        controller.signal
      );
      void donePromise.catch(() => {});
      const errorPromise = reader.waitForLine(/^FPGA_FLASH_ERROR /, 180000, undefined, controller.signal);
      void errorPromise.catch(() => {});

      for (let offset = 0; offset < size; offset += CHUNK) {
        const writePromise = writer.write(data.slice(offset, Math.min(offset + CHUNK, size)));
        await Promise.race([
          writePromise.then(() => null),
          errorPromise.then((line) => {
            throw new Error(`Board reported: ${line}`);
          }),
        ]);
      }

      const resultLine = await donePromise;
      if (resultLine.startsWith("FPGA_FLASH_ERROR")) throw new Error(`Board reported: ${resultLine}`);
    }
    onProgress(size, size);
    return { bytesAcknowledged: size, completionAcknowledged: true };
  } finally {
    controller.abort(new Error("Serial FPGA upload ended."));
    writer.releaseLock();
  }
}
