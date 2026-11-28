import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  provision: vi.fn(),
  requestPort: vi.fn(),
}));

vi.mock("@papilio-loader/flasher-core", () => ({
  SerialLineReader: class {
    isRunning = false;
    onLine(callback) { this.lineCallback = callback; }
    onDisconnect() {}
    async start() {
      this.isRunning = true;
      if (mocks.provision.mock.calls.length) this.lineCallback("connected");
    }
    async stop() { this.isRunning = false; }
  },
  createBrowserXhrPoster: () => ({}),
  provisionBoardOverUsb: mocks.provision,
  watchProvisioningLine: (line, { onIp }) => {
    if (line === "connected") onIp("192.0.2.1");
  },
}));

import { initFlashPage } from "../../../packages/loader-ui/src/flash-page.js";

function setupPage(serial = true) {
  const elements = new Map();
  const doc = {
    getElementById(id) {
      if (id === "esp32-bundled-version") return null;
      if (!elements.has(id)) {
        elements.set(id, {
          tagName: id === "flash-log" ? "PRE" : "DIV",
          value: "",
          files: [],
          disabled: false,
          textContent: "",
          classList: { add() {}, remove() {} },
          addEventListener(event, callback) { this[event] = callback; },
        });
      }
      return elements.get(id);
    },
  };
  vi.stubGlobal("navigator", serial ? {
    serial: { requestPort: mocks.requestPort, addEventListener() {}, getPorts: async () => [] },
  } : {});
  initFlashPage(doc);
  return (id) => doc.getElementById(id);
}

describe("recovery page WiFi provisioning", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.provision.mockReset().mockResolvedValue({});
    mocks.requestPort.mockReset().mockResolvedValue({ connected: true });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("allows Send to Board to select USB and provision without an existing connection", async () => {
    const html = readFileSync(new URL("../../web/board-recovery/index.html", import.meta.url), "utf8");
    expect(html.match(/<button id="btn-send-wifi"[^>]*>/)[0]).not.toMatch(/\bdisabled\b/);
    const el = setupPage();
    el("wifi-ssid").value = "test-network";
    el("wifi-pass").value = "test-password";
    const action = el("btn-send-wifi").click();
    await vi.advanceTimersByTimeAsync(1000);
    await action;
    expect(mocks.requestPort).toHaveBeenCalledOnce();
    expect(mocks.provision).toHaveBeenCalledWith(
      await mocks.requestPort.mock.results[0].value,
      expect.objectContaining({ ssid: "test-network", password: "test-password" })
    );
    expect(el("device-ip").textContent).toBe("192.0.2.1");
    expect(el("btn-send-wifi").disabled).toBe(false);
  });

  it("reuses a port selected in Step 1", async () => {
    const el = setupPage();
    await el("btn-connect").click();
    el("wifi-ssid").value = "test-network";
    const action = el("btn-send-wifi").click();
    await vi.advanceTimersByTimeAsync(1000);
    await action;
    expect(mocks.requestPort).toHaveBeenCalledOnce();
    expect(mocks.provision).toHaveBeenCalledOnce();
  });

  it("reports a cancelled port selection and allows another attempt", async () => {
    mocks.requestPort.mockRejectedValueOnce(new Error("No port selected"));
    const el = setupPage();
    el("wifi-ssid").value = "test-network";
    await el("btn-send-wifi").click();
    expect(el("status-wifi").textContent).toContain("No port selected");
    expect(el("btn-send-wifi").disabled).toBe(false);
    expect(mocks.provision).not.toHaveBeenCalled();
  });

  it("validates the network name before opening the USB picker", async () => {
    const el = setupPage();
    await el("btn-send-wifi").click();
    expect(el("status-wifi").textContent).toContain("Enter a WiFi network name");
    expect(mocks.requestPort).not.toHaveBeenCalled();
  });

  it("disables provisioning when Web Serial is unavailable", () => {
    const el = setupPage(false);
    expect(el("btn-send-wifi").disabled).toBe(true);
  });
});
