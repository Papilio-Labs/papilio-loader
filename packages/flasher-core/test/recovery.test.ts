import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SerialLike } from "../src/transport.js";

const mocks = vi.hoisted(() => ({
  main: vi.fn(),
  readFlash: vi.fn(),
  writeFlash: vi.fn(),
  disconnect: vi.fn(),
  watchdog: vi.fn(),
  chip: { CHIP_NAME: "ESP32-S3" },
}));

vi.mock("esptool-js", () => ({
  Transport: class {
    disconnect = mocks.disconnect;
    trace() {}
  },
  ESPLoader: class {
    chip = mocks.chip;
    main = mocks.main;
    readFlash = mocks.readFlash;
    writeFlash = mocks.writeFlash;
  },
}));
vi.mock("../src/esp32.js", () => ({ watchdogResetEsp32S3: mocks.watchdog }));
vi.mock("../src/nvs-image.js", () => ({
  validateSupportedLoaderPartitionTable: () => [
    { label: "factory", offset: 0x20000, size: 0xe0000 },
    { label: "otadata", offset: 0xc000, size: 0x2000 },
  ],
  validatePapilioLoaderFactoryImage: () => "0.1.2",
}));

import { recoverIntoLoaderProtected } from "../src/recovery.js";

const port: SerialLike = {
  readable: null,
  writable: null,
  open: async () => {},
  close: async () => {},
};
const original = new Uint8Array(0x2000).fill(0x12);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.chip.CHIP_NAME = "ESP32-S3";
  mocks.main.mockResolvedValue("ESP32-S3 (QFN56) (revision v0.2)");
  mocks.readFlash
    .mockResolvedValueOnce(new Uint8Array(0xc00))
    .mockResolvedValueOnce(new Uint8Array(0x100))
    .mockResolvedValueOnce(original)
    .mockResolvedValueOnce(new Uint8Array(0x2000).fill(0xff));
  mocks.writeFlash.mockResolvedValue(undefined);
  mocks.disconnect.mockResolvedValue(undefined);
  mocks.watchdog.mockResolvedValue(undefined);
});

describe("protected recovery", () => {
  it("accepts an ESP32-S3 description and backs up metadata before clearing it", async () => {
    const backup = vi.fn(async (data: Uint8Array) => ({ location: "backup.bin", data }));
    const result = await recoverIntoLoaderProtected(port, {
      allowOtadataReset: true,
      md5: () => new Uint8Array(16),
      persistOtadataBackup: backup,
    });
    expect(result.metadataReset).toBe(true);
    expect(result.backupLocation).toBe("backup.bin");
    expect(backup).toHaveBeenCalledWith(original);
    expect(backup.mock.invocationCallOrder[0]).toBeLessThan(mocks.writeFlash.mock.invocationCallOrder[0]);
    expect(mocks.watchdog).toHaveBeenCalledOnce();
  });

  it("does not write when backup fails or the chip is unsupported", async () => {
    const options = {
      allowOtadataReset: true,
      md5: () => new Uint8Array(16),
      persistOtadataBackup: vi.fn(async () => { throw new Error("backup failed"); }),
    };
    await expect(recoverIntoLoaderProtected(port, options)).rejects.toThrow("backup failed");
    expect(mocks.writeFlash).not.toHaveBeenCalled();
    mocks.chip.CHIP_NAME = "ESP32";
    await expect(recoverIntoLoaderProtected(port, options)).rejects.toThrow("Unsupported recovery chip");
    expect(mocks.writeFlash).not.toHaveBeenCalled();
  });

  it("does not connect without metadata reset consent", async () => {
    await expect(recoverIntoLoaderProtected(port, {
      allowOtadataReset: false,
      md5: () => new Uint8Array(16),
      persistOtadataBackup: async (data) => ({ location: "backup.bin", data }),
    })).rejects.toThrow(/permission/);
    expect(mocks.main).not.toHaveBeenCalled();
  });
});
