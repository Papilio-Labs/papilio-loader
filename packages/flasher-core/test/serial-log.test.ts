import { describe, it, expect, vi } from "vitest";
import { SerialLineReader } from "../src/serial-log.js";
import { MockSerialPort } from "./mock-transport.js";

describe("SerialLineReader", () => {
  it("splits lines and strips trailing CRs (ONLCR \\r\\r\\n on this board)", async () => {
    const port = new MockSerialPort();
    const reader = new SerialLineReader(port);
    const seen: string[] = [];
    reader.onLine((line) => seen.push(line));
    await reader.start();

    port.emit("READY\r"); // firmware's "\r\nREADY\r\n" arrives as "READY\r" post-\n-split
    await vi.waitFor(() => expect(seen).toContain("READY"));
    reader.stop();
  });

  it("waitForLine resolves once a matching line arrives", async () => {
    const port = new MockSerialPort();
    const reader = new SerialLineReader(port);
    await reader.start();

    const waiter = reader.waitForLine(/^FPGA_FLASH_OK$/, 1000);
    port.emit("some unrelated boot log line");
    port.emit("FPGA_FLASH_OK");

    await expect(waiter).resolves.toBe("FPGA_FLASH_OK");
    reader.stop();
  });

  it("waitForLine rejects on timeout", async () => {
    const port = new MockSerialPort();
    const reader = new SerialLineReader(port);
    await reader.start();

    await expect(reader.waitForLine(/^NEVER$/, 20)).rejects.toThrow(/Timed out/);
    reader.stop();
  });

  it("calls onEachLine for non-matching lines while waiting (PROGRESS-style acks)", async () => {
    const port = new MockSerialPort();
    const reader = new SerialLineReader(port);
    await reader.start();

    const progressLines: string[] = [];
    const waiter = reader.waitForLine(/^DONE$/, 1000, (line) => progressLines.push(line));
    port.emit("PROGRESS 10");
    port.emit("PROGRESS 20");
    port.emit("DONE");

    await waiter;
    expect(progressLines).toEqual(["PROGRESS 10", "PROGRESS 20"]);
    reader.stop();
  });

  it("notifies onDisconnect listeners when the read loop dies from a lost-device error", async () => {
    const port = new MockSerialPort();
    const reader = new SerialLineReader(port);
    const disconnected = vi.fn();
    reader.onDisconnect(disconnected);
    await reader.start();

    port.simulateDisconnect("The device has been lost.");
    await vi.waitFor(() => expect(disconnected).toHaveBeenCalledTimes(1));
  });

  it("notifies onDisconnect listeners when the readable stream ends normally", async () => {
    const port = new MockSerialPort();
    const reader = new SerialLineReader(port);
    const disconnected = vi.fn();
    reader.onDisconnect(disconnected);
    await reader.start();

    await port.close();
    await vi.waitFor(() => expect(disconnected).toHaveBeenCalledTimes(1));
  });

  it("rejects outstanding protocol waiters when the serial device disconnects", async () => {
    const port = new MockSerialPort();
    const reader = new SerialLineReader(port);
    await reader.start();

    const pending = reader.waitForLine(/^DONE$/, 10000);
    port.simulateDisconnect();

    await expect(pending).rejects.toThrow(/Serial read failed|disconnected/);
  });

  it("removes pending protocol waiters when the reader stops", async () => {
    const port = new MockSerialPort();
    const reader = new SerialLineReader(port);
    await reader.start();

    const pending = reader.waitForLine(/^DONE$/, 10000);
    await reader.stop();

    await expect(pending).rejects.toThrow(/stopped/);
  });
});
