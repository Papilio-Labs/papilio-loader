import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ set: vi.fn() }));
vi.mock("serialport", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    SerialPort: class extends EventEmitter {
      open(callback: (error?: Error) => void) { callback(); }
      close(callback: () => void) { callback(); }
      set(flags: { dtr: boolean; rts: boolean }, callback: (error?: Error) => void) {
        mocks.set(flags);
        callback();
      }
    },
  };
});

import { NodeSerialAdapter } from "../src/main/node-serial-adapter.js";

describe("Node serial WebSerial signals", () => {
  it("preserves the other signal when esptool changes DTR or RTS", async () => {
    const adapter = new NodeSerialAdapter({ path: "COM10", vendorId: "303A", productId: "1001" });
    await adapter.open({ baudRate: 115200 });
    await adapter.setSignals({ dataTerminalReady: true });
    await adapter.setSignals({ requestToSend: true });
    await adapter.setSignals({ dataTerminalReady: false });
    expect(mocks.set.mock.calls).toEqual([
      [{ dtr: true, rts: false }],
      [{ dtr: true, rts: true }],
      [{ dtr: false, rts: true }],
    ]);
    await adapter.close();
  });
});
