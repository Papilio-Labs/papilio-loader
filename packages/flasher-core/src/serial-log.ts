// serial-log.ts — single shared read loop over a SerialLike port: line
// splitting, a promise-based waiter registry for protocol exchanges (READY /
// PROGRESS n / FPGA_FLASH_OK, etc.), and a subscriber list for plain log
// lines (UI display, IP capture). Ported verbatim from flash.js/loader.js's
// startSerialListener()/waitForSerialLine()/handleSerialLine() — the serial
// port's readable stream can only have one active reader, so every consumer
// of a given port's log output must go through one instance of this class.
import { SerialDisconnectError, type SerialLike } from "./transport.js";

export type LineListener = (line: string) => void;

interface Waiter {
  matchRegex: RegExp;
  onEachLine?: LineListener;
  resolve: (line: string) => void;
  reject: (err: Error) => void;
  timeoutHandle: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export class SerialLineReader {
  private port: SerialLike;
  private baudRate: number;
  private stopped = true;
  private waiters: Waiter[] = [];
  private lineListeners = new Set<LineListener>();
  private disconnectListeners = new Set<() => void>();
  private reader: ReadableStreamDefaultReader<string> | null = null;
  private loopDone: Promise<void> = Promise.resolve();
  private resolveLoopDone: (() => void) | null = null;
  private pipeDone: Promise<void> = Promise.resolve();

  constructor(port: SerialLike, baudRate = 115200) {
    this.port = port;
    this.baudRate = baudRate;
  }

  get isRunning(): boolean {
    return !this.stopped;
  }

  onLine(listener: LineListener): () => void {
    this.lineListeners.add(listener);
    return () => this.lineListeners.delete(listener);
  }

  // Fired when the read loop dies from a "lost"/"disconnect" style error —
  // e.g. USB re-enumeration after a chip-level reset — as opposed to a
  // deliberate stop().
  onDisconnect(listener: () => void): () => void {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  // Idempotent: calling start() while already running is a no-op, matching
  // the original startSerialListener()'s re-entry guard.
  async start(): Promise<void> {
    if (!this.stopped) return;

    if (!this.port.readable) {
      await this.port.open({ baudRate: this.baudRate });
    }
    if (!this.port.readable) {
      throw new Error("Serial port has no readable stream after open()");
    }

    this.stopped = false;
    this.loopDone = new Promise((resolve) => {
      this.resolveLoopDone = resolve;
    });
    const decoder = new TextDecoderStream();
    this.pipeDone = this.port.readable
      .pipeTo(decoder.writable as WritableStream<Uint8Array>)
      .catch(() => {});
    const reader = decoder.readable.getReader();
    this.reader = reader;

    let buf = "";
    (async () => {
      try {
        while (!this.stopped) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += value;
          let idx;
          while ((idx = buf.indexOf("\n")) >= 0) {
            // \r+ (not a single \r): this board's console converts \n to
            // \r\n on output, so its own explicit "\r\n" line endings arrive
            // on the wire as "\r\r\n".
            const line = buf.slice(0, idx).replace(/\r+$/, "");
            buf = buf.slice(idx + 1);
            if (line.length) this.handleLine(line);
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : "Serial read failed.";
        this.rejectWaiters(new SerialDisconnectError(`Serial read failed: ${message}`));
      } finally {
        const disconnected = !this.stopped;
        this.stopped = true;
        try {
          reader.releaseLock();
        } catch {
          // already released
        }
        if (disconnected) {
          this.rejectWaiters(new SerialDisconnectError("Serial device disconnected."));
          for (const listener of this.disconnectListeners) listener();
        }
        this.resolveLoopDone?.();
        this.resolveLoopDone = null;
      }
    })();
  }

  async stop(): Promise<void> {
    const wasRunning = !this.stopped;
    this.stopped = true;
    // A pending read keeps the stream locked even after the loop's stop flag
    // changes. Cancel it so esptool-js can open the same native USB port.
    this.reader?.cancel().catch(() => {});
    await this.loopDone;
    if (wasRunning) this.rejectWaiters(new SerialDisconnectError("Serial reader stopped."));
    // The pipe from port.readable keeps that stream locked until the cancel
    // propagates; port.close() fails (and the port stays open) until then.
    await Promise.race([this.pipeDone, new Promise((resolve) => setTimeout(resolve, 1000))]);
  }

  private handleLine(line: string): void {
    for (const listener of this.lineListeners) listener(line);

    for (const waiter of this.waiters.slice()) {
      if (waiter.matchRegex.test(line)) {
        this.removeWaiter(waiter);
        waiter.resolve(line);
      } else if (waiter.onEachLine) {
        waiter.onEachLine(line);
      }
    }
  }

  waitForLine(
    matchRegex: RegExp,
    timeoutMs: number,
    onEachLine?: LineListener,
    signal?: AbortSignal
  ): Promise<string> {
    if (this.stopped) {
      return Promise.reject(new SerialDisconnectError("Serial reader is not running."));
    }
    if (signal?.aborted) {
      return Promise.reject(signal.reason instanceof Error ? signal.reason : new SerialDisconnectError("Wait cancelled."));
    }

    return new Promise((resolve, reject) => {
      let waiter: Waiter;
      const timeoutHandle = setTimeout(() => {
        this.removeWaiter(waiter);
        reject(new Error(`Timed out waiting for board (expected ${matchRegex})`));
      }, timeoutMs);
      waiter = {
        matchRegex,
        onEachLine,
        resolve,
        reject,
        timeoutHandle,
        signal,
      };
      const onAbort = () => {
        this.removeWaiter(waiter);
        reject(signal?.reason instanceof Error ? signal.reason : new SerialDisconnectError("Wait cancelled."));
      };
      waiter.onAbort = onAbort;
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  private rejectWaiters(error: Error): void {
    for (const waiter of [...this.waiters]) {
      this.removeWaiter(waiter);
      waiter.reject(error);
    }
  }

  private removeWaiter(waiter: Waiter): void {
    clearTimeout(waiter.timeoutHandle);
    if (waiter.onAbort) waiter.signal?.removeEventListener("abort", waiter.onAbort);
    this.waiters = this.waiters.filter((candidate) => candidate !== waiter);
  }
}
