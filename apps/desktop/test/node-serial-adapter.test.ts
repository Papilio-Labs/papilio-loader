import { describe, expect, it } from "vitest";
import {
  getSerialInterfaceNumber,
  isSamePhysicalPort,
  NodeSerialAdapter,
  type NodeSerialPortInfo,
} from "../src/main/node-serial-adapter.js";
import { selectConsolePort } from "../src/main/mcp-server.js";

const port = (path: string, interfaceNumber: number): NodeSerialPortInfo => ({
  path,
  vendorId: "303a",
  productId: "1001",
  serialNumber: "board-1",
  pnpId: `USB\\VID_303A&PID_1001&MI_${interfaceNumber.toString(16).padStart(2, "0")}\\board-1`,
  interfaceNumber,
});

describe("Node serial board selection", () => {
  it("exposes USB identifiers to esptool for native USB reset selection", () => {
    expect(new NodeSerialAdapter(port("COM5", 0)).getInfo()).toEqual({
      usbVendorId: 0x303a,
      usbProductId: 0x1001,
    });
  });
  it("recognizes the USB interface number from the PnP id", () => {
    expect(getSerialInterfaceNumber("USB\\VID_303A&PID_1001&MI_02\\A")).toBe(2);
    expect(getSerialInterfaceNumber("USB\\VID_303A&PID_1001\\A")).toBeUndefined();
  });

  it("selects the native USB console interface instead of the JTAG interface", () => {
    expect(selectConsolePort([port("COM5", 0), port("COM6", 2)]).path).toBe("COM5");
    expect(() => selectConsolePort([port("COM6", 2)])).toThrow(/not the native USB console/);
  });

  it("rejects ambiguous serial interfaces without an explicit port", () => {
    expect(() => selectConsolePort([port("COM5", 0), port("COM6", 0)])).toThrow(/Multiple Papilio/);
    expect(selectConsolePort([port("COM5", 0)], "COM5").path).toBe("COM5");
  });

  it("matches the same physical board across a COM path change", () => {
    expect(isSamePhysicalPort(port("COM5", 2), port("COM9", 2))).toBe(true);
    expect(isSamePhysicalPort(port("COM5", 2), { ...port("COM9", 2), serialNumber: "board-2" })).toBe(false);
  });
});
