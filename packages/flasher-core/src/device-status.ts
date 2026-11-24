// device-status.ts — classify what firmware a board is running, so host
// tooling can decide between the 3 recovery outcomes Phase 7 of
// papilio-works/plans/2026-09-21-papilio-esp-bootloader.md calls for:
//   - "boot log shows loader already" -> just needed the USB-reset nudge.
//   - "boot log shows old 2-slot firmware" -> needs the Phase 8 migration
//     merged-image (not implemented yet, this module only detects it).
//   - "no boot log at all" -> blank/unresponsive board, needs a full flash.
//
// Detection is based on fixed banner text both firmwares already print
// (papilio-esp-bootloader's main.c, FPGA-Companion's mcu_hw.c) plus one
// route (`POST /goto-loader`) that only exists on post-Phase-6
// FPGA-Companion builds -- pre-Phase-6 builds never had net_recovery.c, so
// the same request 404s there instead.
export type DeviceRole = "loader" | "app" | "unknown";

export interface DeviceIdentity {
  role: DeviceRole;
  name?: string;
  version?: string;
}

const LOADER_MARKER = "Papilio ESP Bootloader";
const LOADER_PHASE_MARKER = "loader-phase1";
// Just "FPGA Companion" -- verified against real hardware that the boot-log
// ASCII banner ("FPGA Companion for ESP32-S2/S3") and the net_recovery HTTP
// status body ("FPGA Companion - Network Recovery") don't share a longer
// common substring.
const APP_MARKER = "FPGA Companion";
const MCP_APP_MARKER = "[MCP] Debug interface ready";

// Feed this one line at a time from a live serial read loop, or one call
// per line of an already-captured boot log.
export function classifyBootLogLine(line: string): DeviceRole | null {
  if (line.includes(LOADER_MARKER) || line.includes(LOADER_PHASE_MARKER)) return "loader";
  if (
    line.includes(APP_MARKER) ||
    line.includes(MCP_APP_MARKER) ||
    line.includes("Papilio RetroCade - Wishbone System") ||
    /PAPILIO_APP\s+name=|Project name:/i.test(line)
  ) return "app";
  return null;
}

// Feed this the plain-text body of a GET / request to the device's OTA
// port (3232) -- both the loader's and FPGA-Companion's net_recovery status
// pages are reachable there and start with a distinguishing banner line.
export function classifyStatusResponseText(bodyText: string): DeviceRole {
  if (bodyText.includes(LOADER_MARKER)) return "loader";
  if (bodyText.includes(APP_MARKER)) return "app";
  return "unknown";
}

// Papilio applications should emit this line in both their boot log and
// status response. The ESP-IDF application-information lines are accepted as
// a compatibility fallback for existing firmware.
export function identifyDeviceText(text: string): DeviceIdentity {
  const standard = text.match(/PAPILIO_APP\s+name=([^\s]+)(?:\s+version=([^\s\r\n]+))?/i);
  if (standard) {
    return {
      role: "app",
      name: standard[1],
      version: standard[2],
    };
  }

  const project = text.match(/Project name:\s*([^\r\n]+)/i);
  const version = text.match(/(?:App version|Firmware version)\s*:\s*([^\r\n]+)/i);
  if (project) {
    return {
      role: "app",
      name: project[1].trim(),
      version: version?.[1].trim(),
    };
  }

  if (text.includes(APP_MARKER) && version) {
    return {
      role: "app",
      name: "fpga_companion",
      version: version[1].trim(),
    };
  }

  if (text.includes(MCP_APP_MARKER)) {
    return {
      role: "app",
      name: "MCP app",
    };
  }

  return {
    role: classifyStatusResponseText(text),
  };
}

// Only meaningful once classifyStatusResponseText()/classifyBootLogLine()
// has already said "app" -- distinguishes a genuinely-migrated
// (post-Phase-6) FPGA-Companion build, which always registers
// `POST /goto-loader`, from a pre-Phase-6 self-update build, which never
// had that route at all and so 404s (as opposed to e.g. a 500 if the route
// exists but fails for some other reason).
export function isLegacyPreMigrationApp(gotoLoaderHttpStatus: number): boolean {
  return gotoLoaderHttpStatus === 404;
}
