// node-serial-adapter.ts — wraps the Node `serialport` package's
// EventEmitter/Node-stream API in the Web Streams `SerialLike` shape that
// @papilio-loader/flasher-core expects (the same duck-typed interface a
// browser/Electron-renderer `navigator.serial` SerialPort satisfies). This
// lets the MCP server (running in the Electron main/Node process, with no
// renderer and no user gesture available for `requestPort()`) reuse the
// exact same flashing logic as the UI instead of a second implementation.
import { SerialPort } from "serialport";
import type { SerialLike } from "@papilio-loader/flasher-core";

export interface NodeSerialPortInfo {
  path: string;
  vendorId?: string;
  productId?: string;
  manufacturer?: string;
  serialNumber?: string;
  locationId?: string;
  pnpId?: string;
  interfaceNumber?: number;
}

export function getSerialInterfaceNumber(pnpId?: string): number | undefined {
  const match = pnpId?.match(/(?:&|\\)MI_([0-9a-f]{2})(?:&|\\|$)/i);
  return match ? Number.parseInt(match[1], 16) : undefined;
}

export function serialPortIdentity(port: NodeSerialPortInfo): string {
  const interfaceKey = port.interfaceNumber === undefined ? "" : `:interface-${port.interfaceNumber}`;
  if (port.serialNumber) return `serial:${port.serialNumber}${interfaceKey}`;
  if (port.locationId) return `location:${port.locationId}${interfaceKey}`;
  if (port.pnpId) return `pnp:${port.pnpId.toLowerCase()}`;
  return `path:${port.path.toLowerCase()}`;
}

export function isSamePhysicalPort(previous: NodeSerialPortInfo, candidate: NodeSerialPortInfo): boolean {
  const sameInterface =
    previous.interfaceNumber === undefined ||
    candidate.interfaceNumber === undefined ||
    previous.interfaceNumber === candidate.interfaceNumber;
  if (previous.serialNumber && candidate.serialNumber) {
    return previous.serialNumber === candidate.serialNumber && sameInterface;
  }
  if (previous.locationId && candidate.locationId) {
    return previous.locationId === candidate.locationId && sameInterface;
  }
  if (previous.pnpId && candidate.pnpId) {
    return previous.pnpId.toLowerCase() === candidate.pnpId.toLowerCase() && sameInterface;
  }
  return false;
}

export class NodeSerialAdapter implements SerialLike {
  private port: SerialPort | null = null;
  private dtr = false;
  private rts = false;
  readable: ReadableStream<Uint8Array> | null = null;
  writable: WritableStream<Uint8Array> | null = null;

  constructor(private readonly info: NodeSerialPortInfo) {}

  getInfo(): { usbVendorId?: number; usbProductId?: number } {
    return {
      usbVendorId: this.info.vendorId ? Number.parseInt(this.info.vendorId, 16) : undefined,
      usbProductId: this.info.productId ? Number.parseInt(this.info.productId, 16) : undefined,
    };
  }

  async setSignals(signals: { dataTerminalReady?: boolean; requestToSend?: boolean }): Promise<void> {
    const port = this.port;
    if (!port) throw new Error("Serial port is not open.");
    const dtr = signals.dataTerminalReady ?? this.dtr;
    const rts = signals.requestToSend ?? this.rts;
    await new Promise<void>((resolve, reject) => {
      port.set({ dtr, rts }, (err) => (err ? reject(err) : resolve()));
    });
    this.dtr = dtr;
    this.rts = rts;
  }

  async open(options: { baudRate: number }): Promise<void> {
    const port = new SerialPort({ path: this.info.path, baudRate: options.baudRate, autoOpen: false });
    await new Promise<void>((resolve, reject) => {
      port.open((err) => (err ? reject(err) : resolve()));
    });
    this.port = port;

    let onData: ((chunk: Buffer) => void) | undefined;
    this.readable = new ReadableStream<Uint8Array>({
      start: (controller) => {
        onData = (chunk: Buffer) => {
          controller.enqueue(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
        };
        port.on("data", onData);
        port.on("error", (err) => controller.error(err));
        port.on("close", () => {
          try {
            controller.close();
          } catch {
            // Already closed/errored — ignore.
          }
        });
      },
      cancel: () => {
        if (onData) port.off("data", onData);
      },
    });

    this.writable = new WritableStream<Uint8Array>({
      write: (chunk) =>
        new Promise<void>((resolve, reject) => {
          port.write(Buffer.from(chunk), (err) => (err ? reject(err) : undefined));
          port.drain((err) => (err ? reject(err) : resolve()));
        }),
    });
  }

  async close(): Promise<void> {
    const port = this.port;
    if (!port) return;
    await new Promise<void>((resolve) => port.close(() => resolve()));
    this.port = null;
    this.readable = null;
    this.writable = null;
  }

  static async listPorts(): Promise<NodeSerialPortInfo[]> {
    const ports = await SerialPort.list();
    return ports.map((p) => ({
      path: p.path,
      vendorId: p.vendorId,
      productId: p.productId,
      manufacturer: p.manufacturer,
      serialNumber: p.serialNumber,
      locationId: p.locationId,
      pnpId: p.pnpId,
      interfaceNumber: getSerialInterfaceNumber(p.pnpId),
    }));
  }
}
