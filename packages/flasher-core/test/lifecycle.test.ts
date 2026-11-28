import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureHttpLoader } from "../src/lifecycle.js";

const app = () => new Response("FPGA Companion - Network Recovery");
const loader = () => new Response("Papilio ESP Bootloader");

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("ensureHttpLoader", () => {
  it.each([
    new DOMException("request timed out", "AbortError"),
    new TypeError("fetch failed"),
  ])("confirms the loader after a lost handoff response without resending the request", async (failure) => {
    vi.useFakeTimers();
    const fetch = vi.fn()
      .mockResolvedValueOnce(app())
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(loader());
    vi.stubGlobal("fetch", fetch);

    const result = ensureHttpLoader("192.0.2.1");
    await vi.runAllTimersAsync();
    await expect(result).resolves.toEqual({
      identity: "loader",
      handedOff: true,
      handoffWarning: expect.stringContaining(failure.message),
    });
    expect(fetch.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(1);
  });

  it("fails explicitly when a lost handoff response is not followed by loader identity", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn()
      .mockResolvedValueOnce(app())
      .mockRejectedValueOnce(new DOMException("request timed out", "AbortError"))
      .mockImplementation(async () => app());
    vi.stubGlobal("fetch", fetch);

    const result = ensureHttpLoader("192.0.2.1", 3232, { timeoutMs: 1000, pollIntervalMs: 500 });
    const assertion = expect(result).rejects.toThrow(/Timed out waiting.*Handoff response was not received/);
    await vi.runAllTimersAsync();
    await assertion;
    expect(fetch.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(1);
  });

  it.each([404, 500])("does not ignore HTTP %i from the handoff", async (status) => {
    const fetch = vi.fn().mockResolvedValueOnce(app()).mockResolvedValueOnce(new Response("", { status }));
    vi.stubGlobal("fetch", fetch);

    await expect(ensureHttpLoader("192.0.2.1")).rejects.toThrow(
      status === 404 ? /does not support POST/ : /failed with HTTP 500/
    );
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
