// esp32.ts — thin wrapper around esptool-js: flash firmware over WebSerial
// and reboot the board afterward. Ported from flash.js/loader.js. Uses the
// npm `esptool-js` package (pinned, bundled) instead of the unpkg CDN import
// the original static pages used — removes that CDN single-point-of-failure.
import { ESPLoader, Transport } from "esptool-js";
import type { SerialLike } from "./transport.js";
import { buildBoardProvisioningRegions, buildOtadataSelectingSlot, parsePartitionTable, type BoardProvisioningOptions } from "./nvs-image.js";

const PARTITION_TABLE_OFFSET = 0x8000;
const PARTITION_TABLE_SIZE = 0xc00;

export interface Esp32FlashOptions {
  onLog?(message: string): void;
  onProgress?(written: number, total: number): void;
  expectedChipName?: string;
}

// esptool-js's own reset strategies (classic RTS toggle, and the
// UsbJtagSerialReset used to *enter* the bootloader) don't reliably reboot a
// native-USB-Serial/JTAG ESP32-S3 (Papilio Retrocade) back into the app —
// the board is left requiring a physical RESET press. Python esptool has a
// separate `--after watchdog-reset` mode for exactly this case (arms the RTC
// watchdog and lets it fire, no DTR/RTS involved); esptool-js has no JS
// equivalent, so this is a direct port of ESP32S3ROM.watchdog_reset() from
// esptool's targets/esp32s3.py, using the same three register writes over
// the already-connected ESPLoader. Confirmed reliable on the Papilio
// Retrocade (see esp32s3-usb-auto-reset-findings repo memory).
export async function watchdogResetEsp32S3(loader: ESPLoader): Promise<void> {
  const RTC_CNTL_WDTCONFIG0_REG = 0x60008098;
  const RTC_CNTL_WDTCONFIG1_REG = 0x6000809c;
  const RTC_CNTL_WDTWPROTECT_REG = 0x600080b0;
  const RTC_CNTL_WDT_WKEY = 0x50d83aa1;

  await loader.writeReg(RTC_CNTL_WDTWPROTECT_REG, RTC_CNTL_WDT_WKEY); // unlock
  await loader.writeReg(RTC_CNTL_WDTCONFIG1_REG, 2000); // WDT timeout
  await loader.writeReg(RTC_CNTL_WDTCONFIG0_REG, 0xd0000102); // enable WDT
  await loader.writeReg(RTC_CNTL_WDTWPROTECT_REG, 0); // lock
  await new Promise((resolve) => setTimeout(resolve, 500));
}

// This board has no external reset circuit (see the entry-mode comment
// above), so "Find My IP" previously had to ask the user to physically
// press RESET after connecting. This reuses the exact same
// enter-bootloader/exit-bootloader dance as flashEsp32() — minus the actual
// flash write — to force a fresh boot in software, so the board reprints
// its "WiFi connected - IP: ..." boot log on its own.
export async function resetEsp32ForIp(port: SerialLike, onLog?: (message: string) => void): Promise<void> {
  const transport = new Transport(port as unknown as ConstructorParameters<typeof Transport>[0], true);
  const loader = new ESPLoader({
    transport,
    baudrate: 115200,
    terminal: {
      clean: () => {},
      writeLine: (msg: string) => onLog?.(msg),
      write: (msg: string) => onLog?.(msg),
    },
  });

  try {
    const chipName = await loader.main();
    onLog?.(`Connected to ${chipName} — resetting to read its boot log...`);

    if (loader.chip && loader.chip.CHIP_NAME === "ESP32-S3") {
      await watchdogResetEsp32S3(loader);
    } else {
      await loader.after("hard_reset");
    }
  } finally {
    try {
      await transport.disconnect();
    } catch {
      // already closed/never opened — ignore
    }
  }
}

export interface Esp32FlashResult {
  chipName: string;
}

export interface Esp32ProvisionOptions extends Esp32FlashOptions, BoardProvisioningOptions {}

// Writes WiFi credentials + boot selection straight into flash (see
// nvs-image.ts for why), then watchdog-resets so the board boots
// FPGA-Companion and joins WiFi. Offsets come from the board's own partition
// table, so a custom layout is handled as long as the labels match.
export async function provisionBoardOverUsb(port: SerialLike, options: Esp32ProvisionOptions): Promise<Esp32FlashResult> {
  const transport = new Transport(port as unknown as ConstructorParameters<typeof Transport>[0], true);
  const loader = new ESPLoader({
    transport,
    baudrate: 115200,
    terminal: {
      clean: () => {},
      writeLine: (msg: string) => options.onLog?.(msg),
      write: (msg: string) => options.onLog?.(msg),
    },
  });

  try {
    const chipName = await loader.main();
    options.onLog?.(`Connected to ${chipName}. Reading partition table...`);

    const partitions = parsePartitionTable(await loader.readFlash(PARTITION_TABLE_OFFSET, PARTITION_TABLE_SIZE));
    const ota0 = partitions.find((p) => p.type === 0x00 && p.subtype === 0x10);
    if (!ota0) throw new Error("No ota_0 partition found — flash the Step 1 firmware first.");
    const appMagic = await loader.readFlash(ota0.offset, 1);
    if (appMagic[0] !== 0xe9) throw new Error("FPGA-Companion is not installed in ota_0 — flash the Step 1 firmware first.");

    const regions = buildBoardProvisioningRegions(partitions, options);
    options.onLog?.(`Writing WiFi settings and boot selection (${regions.map((r) => `0x${r.address.toString(16)}`).join(", ")})...`);
    await loader.writeFlash({
      fileArray: regions,
      flashMode: "keep",
      flashFreq: "keep",
      flashSize: "keep",
      eraseAll: false,
      compress: true,
      reportProgress: (_fileIndex: number, written: number, total: number) => {
        options.onProgress?.(written, total);
      },
    });

    if (loader.chip && loader.chip.CHIP_NAME === "ESP32-S3") {
      options.onLog?.("Restarting into FPGA-Companion via RTC watchdog...");
      await watchdogResetEsp32S3(loader);
    } else {
      await loader.after("hard_reset");
    }
    return { chipName };
  } finally {
    try {
      await transport.disconnect();
    } catch {
      // already closed/never opened — ignore
    }
  }
}

// Boots FPGA-Companion (ota_0) from any state — including the Papilio ESP
// Bootloader — by selecting ota_0 in otadata over USB and restarting with the
// RTC watchdog. Unlike the bootloader's /resume (esp_restart = CPU-only reset),
// the watchdog fully resets the chip's peripherals: FPGA-Companion v2.0.0
// crashes in its SPI/IRQ init when booted via esp_restart right after the
// bootloader has driven the FPGA, and bootloader rollback then parks the board
// back in the loader.
export async function bootCompanionOverUsb(port: SerialLike, options: { onLog?: (msg: string) => void } = {}): Promise<Esp32FlashResult> {
  const transport = new Transport(port as unknown as ConstructorParameters<typeof Transport>[0], true);
  const loader = new ESPLoader({
    transport,
    baudrate: 115200,
    terminal: {
      clean: () => {},
      writeLine: (msg: string) => options.onLog?.(msg),
      write: (msg: string) => options.onLog?.(msg),
    },
  });

  try {
    const chipName = await loader.main();
    const partitions = parsePartitionTable(await loader.readFlash(PARTITION_TABLE_OFFSET, PARTITION_TABLE_SIZE));
    const ota0 = partitions.find((p) => p.type === 0x00 && p.subtype === 0x10);
    const otadata = partitions.find((p) => p.type === 0x01 && p.subtype === 0x00);
    if (!ota0 || !otadata) throw new Error("No ota_0/otadata partition found — flash the Step 1 firmware first.");
    const appMagic = await loader.readFlash(ota0.offset, 1);
    if (appMagic[0] !== 0xe9) throw new Error("FPGA-Companion is not installed in ota_0 — flash the Step 1 firmware first.");

    options.onLog?.("Selecting FPGA-Companion (ota_0) as the boot app...");
    await loader.writeFlash({
      fileArray: [{ address: otadata.offset, data: buildOtadataSelectingSlot(0, otadata.size) }],
      flashMode: "keep",
      flashFreq: "keep",
      flashSize: "keep",
      eraseAll: false,
      compress: true,
    });

    if (loader.chip && loader.chip.CHIP_NAME === "ESP32-S3") {
      options.onLog?.("Restarting into FPGA-Companion via RTC watchdog...");
      await watchdogResetEsp32S3(loader);
    } else {
      await loader.after("hard_reset");
    }
    return { chipName };
  } finally {
    try {
      await transport.disconnect();
    } catch {
      // already closed/never opened — ignore
    }
  }
}

// Flashes a merged single-file image (bootloader + partition table + app,
// built via `esptool merge-bin`) at offset 0x0. flashMode/Freq/Size use
// "keep" — read from the merged image's own bootloader header rather than
// guessed, matching the original SPA's behavior.
export async function flashEsp32(port: SerialLike, data: Uint8Array, options: Esp32FlashOptions = {}): Promise<Esp32FlashResult> {
  const transport = new Transport(port as unknown as ConstructorParameters<typeof Transport>[0]);
  transport.trace = (message) => options.onLog?.(message);
  const loader = new ESPLoader({
    transport,
    baudrate: 115200,
    terminal: {
      clean: () => {},
      writeLine: (msg: string) => options.onLog?.(msg),
      write: (msg: string) => options.onLog?.(msg),
    },
  });

  try {
    const chipName = await loader.main();
    if (options.expectedChipName && loader.chip?.CHIP_NAME !== options.expectedChipName) {
      throw new Error(`Unsupported provisioning chip "${chipName}"; expected ${options.expectedChipName}.`);
    }
    options.onLog?.(`Connected to ${chipName}.`);

    await loader.writeFlash({
      fileArray: [{ data, address: 0x0 }],
      flashMode: "keep",
      flashFreq: "keep",
      flashSize: "keep",
      eraseAll: false,
      compress: true,
      reportProgress: (_fileIndex: number, written: number, total: number) => {
        options.onProgress?.(written, total);
      },
    });
    options.onLog?.("ESP32 firmware flashed.");

    if (loader.chip && loader.chip.CHIP_NAME === "ESP32-S3") {
      options.onLog?.("Resetting board via RTC watchdog...");
      await watchdogResetEsp32S3(loader);
    } else {
      await loader.after("hard_reset");
    }

    return { chipName };
  } finally {
    // The transport may have opened the port before failing (e.g. chip sync
    // timeout) — always close it so a retry doesn't hit "port already open".
    try {
      await transport.disconnect();
    } catch {
      // already closed/never opened — ignore
    }
  }
}
