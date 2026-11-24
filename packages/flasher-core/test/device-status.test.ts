import { describe, it, expect } from "vitest";
import { classifyBootLogLine, classifyStatusResponseText, identifyDeviceText, isLegacyPreMigrationApp } from "../src/device-status.js";

describe("classifyBootLogLine", () => {
  it("recognizes the loader's boot banner", () => {
    expect(classifyBootLogLine("Papilio ESP Bootloader -- Phase 4 (USB-serial fallback)")).toBe("loader");
  });

  it("recognizes the loader's periodic phase status line", () => {
    expect(classifyBootLogLine("I (136684) loader-phase1: alive -- running from 'factory' -- wifi=connected ip=10.0.4.100")).toBe("loader");
  });

  it("recognizes FPGA-Companion's ASCII boot banner", () => {
    expect(classifyBootLogLine("           FPGA Companion for ESP32-S2/S3")).toBe("app");
  });

  it("recognizes the HDMI app's existing MCP startup marker", () => {
    expect(classifyBootLogLine("[MCP] Debug interface ready. Type H for help.")).toBe("app");
  });

  it("recognizes the Papilio project template's application banner", () => {
    expect(classifyBootLogLine("Papilio RetroCade - Wishbone System")).toBe("app");
  });

  it("returns null for unrelated lines", () => {
    expect(classifyBootLogLine("I (317) boot: Loaded app from partition at offset 0x280000")).toBeNull();
  });
});

describe("classifyStatusResponseText", () => {
  it("recognizes the loader's GET / banner", () => {
    const body = "Papilio ESP Bootloader\nPOST /fpga-jtag-sram -- program FPGA SRAM via JTAG (.bin bitstream)\n";
    expect(classifyStatusResponseText(body)).toBe("loader");
  });

  // Verified against real hardware: net_recovery.c's status body wording
  // ("FPGA Companion - Network Recovery") differs from the boot-log ASCII
  // banner ("FPGA Companion for ESP32-S2/S3") -- only "FPGA Companion" is
  // common to both.
  it("recognizes FPGA-Companion's net_recovery status banner", () => {
    const body = "FPGA Companion - Network Recovery\n==================================\nRunning partition : ota_1\n";
    expect(classifyStatusResponseText(body)).toBe("app");
  });

  it("returns unknown for anything else", () => {
    expect(classifyStatusResponseText("<html>404</html>")).toBe("unknown");
  });
});

describe("isLegacyPreMigrationApp", () => {
  it("treats 404 as a pre-Phase-6 build", () => {
    expect(isLegacyPreMigrationApp(404)).toBe(true);
  });

  it("treats any other status as a migrated build", () => {
    expect(isLegacyPreMigrationApp(200)).toBe(false);
  });
});

describe("identifyDeviceText", () => {
  it("recognizes the standard Papilio app identity marker", () => {
    expect(identifyDeviceText("PAPILIO_APP name=fpga_companion version=v1.1.1")).toEqual({
      role: "app",
      name: "fpga_companion",
      version: "v1.1.1",
    });
  });

  it("recognizes existing ESP-IDF application information", () => {
    expect(identifyDeviceText("Project name: fpga_companion\nApp version: v1.1.1")).toEqual({
      role: "app",
      name: "fpga_companion",
      version: "v1.1.1",
    });
  });

  it("recognizes the existing FPGA Companion HTTP response", () => {
    expect(identifyDeviceText("FPGA Companion - Network Recovery\nFirmware version  : v1.1.1")).toEqual({
      role: "app",
      name: "fpga_companion",
      version: "v1.1.1",
    });
  });

  it("identifies the existing MCP app without inventing a version", () => {
    expect(identifyDeviceText("[MCP] Debug interface ready. Type H for help.")).toEqual({
      role: "app",
      name: "MCP app",
    });
  });
});
