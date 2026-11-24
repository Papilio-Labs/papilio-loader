import { describe, it, expect } from "vitest";
import { SerialLineReader } from "../src/serial-log.js";
import { flashEsp32OverSerial, resumeAppOverSerial } from "../src/app-serial.js";
import { MockSerialPort } from "./mock-transport.js";

// Simulates the loader's APP_FLASH_BEGIN handler (serial_flash.c): first
// write() is the command line, everything after is raw app-image bytes,
// with periodic PROGRESS lines and a final APP_FLASH_OK once all bytes
// have arrived -- no per-chunk ACK/flow-control needed (see app-serial.ts's
// header comment).
function wireMockFirmware(port: MockSerialPort, totalSize: number) {
  let writeCount = 0;
  let bytesReceived = 0;
  port.onWrite = (chunk) => {
    writeCount++;
    if (writeCount === 1) {
      queueMicrotask(() => port.emit("READY"));
      return;
    }
    bytesReceived += chunk.byteLength;
    queueMicrotask(() => {
      port.emit(`PROGRESS ${bytesReceived}`);
      if (bytesReceived >= totalSize) port.emit("APP_FLASH_OK");
    });
  };
}

describe("flashEsp32OverSerial", () => {
  it("streams an app image and reports progress to completion", async () => {
    const port = new MockSerialPort();
    const reader = new SerialLineReader(port);
    await reader.start();

    const data = new Uint8Array(16384 * 2 + 100).fill(0xab);
    wireMockFirmware(port, data.byteLength);

    const progress: Array<[number, number]> = [];
    await flashEsp32OverSerial(port, reader, data, (loaded, total) => progress.push([loaded, total]));

    expect(progress[progress.length - 1]).toEqual([data.byteLength, data.byteLength]);
    // command line + nine 4KB-or-smaller data chunks
    expect(port.writes.length).toBe(10);
    reader.stop();
  });

  it("throws when the board rejects the APP_FLASH_BEGIN request", async () => {
    const port = new MockSerialPort();
    const reader = new SerialLineReader(port);
    await reader.start();

    port.onWrite = () => {
      queueMicrotask(() => port.emit("APP_FLASH_ERROR bad_magic"));
    };

    await expect(flashEsp32OverSerial(port, reader, new Uint8Array(10), () => {})).rejects.toThrow(/Board rejected request/);
    reader.stop();
  });

  it("throws when the board reports failure after streaming", async () => {
    const port = new MockSerialPort();
    const reader = new SerialLineReader(port);
    await reader.start();

    let writeCount = 0;
    port.onWrite = () => {
      writeCount++;
      if (writeCount === 1) {
        queueMicrotask(() => port.emit("READY"));
      } else {
        queueMicrotask(() => port.emit("APP_FLASH_ERROR esp_ota_write_failed"));
      }
    };

    await expect(flashEsp32OverSerial(port, reader, new Uint8Array(10), () => {})).rejects.toThrow(/Board reported/);
    reader.stop();
  });

  it("registers each progress waiter before writing and rejects a wrong cumulative ack", async () => {
    const port = new MockSerialPort();
    const reader = new SerialLineReader(port);
    await reader.start();

    let command = true;
    port.onWrite = () => {
      if (command) {
        command = false;
        port.emit("READY");
      } else {
        port.emit("PROGRESS 1");
      }
    };

    await expect(flashEsp32OverSerial(port, reader, new Uint8Array(64), () => {}))
      .rejects.toThrow(/Unexpected progress acknowledgement/);
    reader.stop();
  });
});

describe("resumeAppOverSerial", () => {
  it("sends RESUME_APP and waits for confirmation", async () => {
    const port = new MockSerialPort();
    const reader = new SerialLineReader(port);
    await reader.start();

    port.onWrite = () => queueMicrotask(() => port.emit("RESUME_OK"));

    await resumeAppOverSerial(port, reader);

    expect(new TextDecoder().decode(port.writes[0])).toBe("RESUME_APP\n");
    reader.stop();
  });

  it("throws when the board rejects the resume request", async () => {
    const port = new MockSerialPort();
    const reader = new SerialLineReader(port);
    await reader.start();

    port.onWrite = () => queueMicrotask(() => port.emit("RESUME_ERROR no_app"));

    await expect(resumeAppOverSerial(port, reader)).rejects.toThrow(/Board reported/);
    reader.stop();
  });
});
