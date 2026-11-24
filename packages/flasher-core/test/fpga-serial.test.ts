import { describe, it, expect } from "vitest";
import { SerialLineReader } from "../src/serial-log.js";
import { flashFpgaOverSerial } from "../src/fpga-serial.js";
import { MockSerialPort } from "./mock-transport.js";

// Simulates the firmware side of the FPGA_FLASH_BEGIN protocol: the first
// write() is always the command line, everything after is data chunks. For
// target=flash it acks every chunk with PROGRESS <bytes-so-far> (the
// per-chunk flow control this protocol relies on); for target=sram it just
// waits for all bytes then reports success.
function wireMockFirmware(port: MockSerialPort, totalSize: number, target: "flash" | "sram") {
  let writeCount = 0;
  let bytesReceived = 0;
  port.onWrite = (chunk) => {
    writeCount++;
    if (writeCount === 1) {
      queueMicrotask(() => port.emit("READY"));
      return;
    }
    bytesReceived += chunk.byteLength;
    if (target === "flash") {
      queueMicrotask(() => {
        port.emit(`PROGRESS ${bytesReceived}`);
        if (bytesReceived >= totalSize) port.emit("FPGA_FLASH_OK");
      });
    } else if (bytesReceived >= totalSize) {
      queueMicrotask(() => port.emit("FPGA_FLASH_OK"));
    }
  };
}

describe("flashFpgaOverSerial", () => {
  it("streams a bitstream to target=flash with per-chunk PROGRESS flow control", async () => {
    const port = new MockSerialPort();
    const reader = new SerialLineReader(port);
    await reader.start();

    const data = new Uint8Array(4096 * 3 + 100).fill(0xab); // spans multiple 4KB chunks
    wireMockFirmware(port, data.byteLength, "flash");

    const progress: Array<[number, number]> = [];
    await flashFpgaOverSerial(port, reader, "flash", data, (loaded, total) => progress.push([loaded, total]));

    expect(progress[progress.length - 1]).toEqual([data.byteLength, data.byteLength]);
    // command line + 4 data chunks (3 full 4KB + 1 partial)
    expect(port.writes.length).toBe(5);
    reader.stop();
  });

  it("streams to target=sram without per-chunk waits", async () => {
    const port = new MockSerialPort();
    const reader = new SerialLineReader(port);
    await reader.start();

    const data = new Uint8Array(16384 * 2).fill(0xcd);
    wireMockFirmware(port, data.byteLength, "sram");

    const progress: Array<[number, number]> = [];
    await flashFpgaOverSerial(port, reader, "sram", data, (loaded, total) => progress.push([loaded, total]));

    expect(progress[progress.length - 1]).toEqual([data.byteLength, data.byteLength]);
    reader.stop();
  });

  it("throws when the board rejects the FPGA_FLASH_BEGIN request", async () => {
    const port = new MockSerialPort();
    const reader = new SerialLineReader(port);
    await reader.start();

    port.onWrite = () => {
      queueMicrotask(() => port.emit("FPGA_FLASH_ERROR ESP_ERR_TIMEOUT"));
    };

    await expect(
      flashFpgaOverSerial(port, reader, "flash", new Uint8Array(10), () => {})
    ).rejects.toThrow(/Board rejected request/);
    reader.stop();
  });

  it("registers the cumulative progress waiter before writing each flash chunk", async () => {
    const port = new MockSerialPort();
    const reader = new SerialLineReader(port);
    await reader.start();

    let command = true;
    port.onWrite = (chunk) => {
      if (command) {
        command = false;
        port.emit("READY");
      } else {
        port.emit(`PROGRESS ${chunk.byteLength}`);
      }
    };

    await expect(
      flashFpgaOverSerial(port, reader, "flash", new Uint8Array(4096 + 4), () => {})
    ).rejects.toThrow(/Unexpected progress acknowledgement/);
    reader.stop();
  });
});
