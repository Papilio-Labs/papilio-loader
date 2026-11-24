// recovery.ts — Tier 1 forced-entry into the Papilio ESP Bootloader: the
// USB-reset + otadata-blank dance from papilio-works/plans/
// 2026-09-21-papilio-esp-bootloader.md (Phase 5's recovery ladder, wired
// into host tooling in Phase 7). Used when a board can't be reached over
// LAN/OTA at all (crashed/uncooperative user app, or simply never
// provisioned) but is still connected over USB.
import { ESPLoader, Transport } from "esptool-js";
import type { SerialLike } from "./transport.js";
import { watchdogResetEsp32S3 } from "./esp32.js";
import {
  validatePapilioLoaderFactoryImage,
  validateSupportedLoaderPartitionTable,
  type DigestFunction,
} from "./nvs-image.js";

// papilio-esp-bootloader's partitions_loader.csv: `otadata` lives at
// 0xC000, size 0x2000 (2 x 4KB ping-pong records). Blanking it makes
// ESP-IDF's stock bootloader treat both records as invalid and fall back to
// `factory` (the loader) on the next boot -- see the Phase 1 rollback
// findings (papilio-esp-bootloader-phase1-rollback-findings repo memory)
// for the byte-level mechanics.
export const OTADATA_OFFSET = 0xc000;
export const OTADATA_SIZE = 0x2000;

export interface RecoveryOptions {
  onLog?(message: string): void;
}

export class MetadataResetConsentRequiredError extends Error {
  constructor() {
    super("Loader recovery needs permission to clear OTA selection/rollback metadata. Retry with allow_ota_metadata_reset=true after confirming this effect.");
    this.name = "MetadataResetConsentRequiredError";
  }
}

export interface OtadataBackup {
  location: string;
  data: Uint8Array;
}

export interface ProtectedRecoveryOptions extends RecoveryOptions {
  allowOtadataReset: boolean;
  md5: DigestFunction;
  persistOtadataBackup(data: Uint8Array): Promise<OtadataBackup>;
}

export interface ProtectedRecoveryResult {
  chipName: string;
  loaderVersion: string;
  metadataReset: true;
  backupLocation: string;
}

export function validateOtadataImage(data: Uint8Array): void {
  if (data.length !== OTADATA_SIZE) {
    throw new Error(`otadata backup must be exactly ${OTADATA_SIZE} bytes.`);
  }
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export async function recoverIntoLoaderProtected(
  port: SerialLike,
  options: ProtectedRecoveryOptions
): Promise<ProtectedRecoveryResult> {
  if (!options.allowOtadataReset) throw new MetadataResetConsentRequiredError();

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
    if (loader.chip?.CHIP_NAME !== "ESP32-S3") {
      throw new Error(`Unsupported recovery chip "${chipName}"; only ESP32-S3 is supported.`);
    }

    const partitionTable = await loader.readFlash(0x8000, 0xc00);
    const partitions = validateSupportedLoaderPartitionTable(partitionTable, options.md5);
    const factory = partitions.find((partition) => partition.label === "factory");
    const otadata = partitions.find((partition) => partition.label === "otadata");
    if (!factory || !otadata || otadata.offset !== OTADATA_OFFSET || otadata.size !== OTADATA_SIZE) {
      throw new Error("Supported factory or otadata partition is missing.");
    }

    const factoryImage = await loader.readFlash(factory.offset, 0x100);
    const loaderVersion = validatePapilioLoaderFactoryImage(factoryImage);
    options.onLog?.(`Validated Papilio ESP Bootloader ${loaderVersion} and its partition table.`);

    const originalOtadata = await loader.readFlash(otadata.offset, otadata.size);
    validateOtadataImage(originalOtadata);
    const backup = await options.persistOtadataBackup(originalOtadata);
    if (!backup.location || !bytesEqual(backup.data, originalOtadata)) {
      throw new Error("The otadata backup could not be verified; recovery stopped before changing metadata.");
    }

    const blank = new Uint8Array(otadata.size).fill(0xff);
    await loader.writeFlash({
      fileArray: [{ data: blank, address: otadata.offset }],
      flashMode: "keep",
      flashFreq: "keep",
      flashSize: "keep",
      eraseAll: false,
      compress: true,
    });
    const clearedOtadata = await loader.readFlash(otadata.offset, otadata.size);
    if (!clearedOtadata.every((byte) => byte === 0xff)) {
      throw new Error("otadata readback was not blank after recovery write.");
    }

    options.onLog?.(`otadata cleared after verified backup at ${backup.location}.`);
    await watchdogResetEsp32S3(loader);
    return {
      chipName,
      loaderVersion,
      metadataReset: true,
      backupLocation: backup.location,
    };
  } finally {
    try {
      await transport.disconnect();
    } catch {
      // The board may already have disconnected during its reset.
    }
  }
}

// esptool-js 0.6.0 has no dedicated erase-region command, so this writes an
// explicit all-0xFF buffer over the otadata partition instead -- from the
// bootloader's point of view that's indistinguishable from a real erase
// (both read back as blank/0xFF).
export async function recoverIntoLoader(port: SerialLike, options: RecoveryOptions = {}): Promise<void> {
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
    options.onLog?.(`Connected to ${chipName} — clearing otadata to force a boot into the loader...`);

    const blank = new Uint8Array(OTADATA_SIZE).fill(0xff);
    await loader.writeFlash({
      fileArray: [{ data: blank, address: OTADATA_OFFSET }],
      flashMode: "keep",
      flashFreq: "keep",
      flashSize: "keep",
      eraseAll: false,
      compress: true,
    });
    options.onLog?.("otadata cleared — next boot should fall back to the loader (factory partition).");

    if (loader.chip && loader.chip.CHIP_NAME === "ESP32-S3") {
      options.onLog?.("Resetting board via RTC watchdog...");
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
