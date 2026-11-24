# Electron MCP Resident-Loader Uploads

Version 0.5.0 changes the TypeScript/Electron MCP upload defaults. MCP tools
now use the resident Papilio ESP Bootloader instead of treating every ESP32
binary as a complete flash image.

This contract applies to the Electron and standalone TypeScript MCP server. The
separate Python MCP package and browser UI have not been migrated by this
change; see [OTA_FEATURE.md](OTA_FEATURE.md) for the legacy Python behavior.
Version 0.5.1 fixes HTTP MCP client reconnection and supports simultaneous
client sessions.

## Upload modes

### USB: `flash_device`

- `device_type="esp32"` defaults to `mode="resident"` and accepts a raw
  ESP32-S3 application `.bin`. The loader chooses the OTA slot; the tool does
  not accept arbitrary flash addresses.
- `device_type="fpga"` defaults to persistent FPGA flash. Use
  `fpga_target="sram"` for a volatile SRAM test.
- FPGA uploads resume the selected application after success unless
  `stay_in_loader=true`. ESP application uploads boot the newly selected app
  automatically; `stay_in_loader` is not valid for ESP uploads.
- A complete merged ESP image is accepted only with the explicit
  `mode="provision"` option. Provision mode writes the complete image from
  offset zero and is not an automatic fallback for resident upload errors.
- `address` is rejected. `verify=true` is rejected before writing because the
  protocol does not provide full-image readback. `force` cannot bypass board
  identity or recovery consent.

When the board is not already running the loader, USB recovery validates the
ESP32-S3, supported partition table and checksum, and factory loader
descriptor/version before changing metadata. Recovery requires
`allow_ota_metadata_reset=true`. It backs up and verifies the complete 0x2000
byte `otadata` region before clearing it, then reads the cleared region back.
This permission allows losing OTA selection/rollback history; it does not
authorize erasing application images. A failed backup or validation stops
before metadata is changed.

Backups are stored under the application's data directory in
`papilio-loader/loader-backups` (for example,
`%APPDATA%\papilio-loader\loader-backups` on Windows). The returned result
includes the backup path when recovery changed metadata.

### Network: `flash_device_ota`

HTTP uploads are network-only by default and require positive resident-loader
identity. A compatible application may be asked to hand off through
`POST /goto-loader`; unknown identity or an unsupported handoff fails without
uploading. ESP uploads check `/update-target` and report the loader-selected
slot. FPGA uploads target persistent flash by default; `fpga_target="sram"`
selects volatile SRAM.

USB-assisted entry is opt-in: pass `usb_port` to select the console interface.
The selected USB board must report the same IP address as the requested HTTP
host. `allow_ota_metadata_reset=true` is required only if that explicit USB
recovery needs to clear metadata. Supplying consent without `usb_port` is
rejected.

### Explicit lifecycle tools

- `enter_bootloader` identifies an existing loader or explicitly performs
  loader entry over USB or HTTP. USB metadata reset requires the same consent
  and verified backup as a USB upload.
- `resume_application` sends `RESUME_APP` over USB or `POST /resume` over HTTP
  only after positive loader identification. It does not flash.
- `get_device_info` reports USB metadata and `get_flash_status` reports port
  enumeration. Neither probes firmware role or changes board state.

## Result evidence and failure handling

Results distinguish protocol/HTTP completion acknowledgement, the reported
logical destination, metadata reset and backup path, and observed application
boot. These acknowledgements are not full-image verification. If upload
completion succeeds but resume or boot observation fails, the error result
still reports that the image was written and the lifecycle phase that failed.
Partial USB upload errors include acknowledged byte counts; the final image
state is marked unknown when completion was not acknowledged. Uploads are not
retried automatically.

USB operations select the RetroCade console interface and refuse ambiguous
ports. Recovery/reconnect waits are tied to the selected physical board;
unstable identity or a different re-enumerated device is not accepted.
Concurrent MCP mutations are serialized with per-board locks. If a Loader
monitor already owns the serial port, close it and retry rather than terminating
other processes.

## Migration

Existing TypeScript MCP callers that send a raw app image need no mode change.
Callers that previously supplied a merged ESP image must now explicitly pass
`mode="provision"`. Callers relying on `address`, `verify`, or `force` must
remove those options; they are rejected rather than ignored. Recovery callers
must request `allow_ota_metadata_reset=true` only after consenting to the
metadata change.

Windows hardware testing has exercised USB protected recovery, FPGA and ESP
uploads, explicit resume, and HTTP uploads from an already-running loader.
Full readback of protected regions, compatible-app HTTP handoff, packaged
releases, and Linux/macOS hardware testing remain outstanding.

On November 23, 2026, the standalone MCP server completed USB FPGA and ESP
uploads on a RetroCade, confirmed application boot, and the user confirmed
steady red after a power cycle. HTTP FPGA and ESP uploads from the resident
loader also completed; USB observation confirmed the app boot after the HTTP
ESP upload. HTTP resume was acknowledged; the template app has no HTTP status
endpoint, so MCP correctly reported boot observation as unavailable, while a
subsequent USB log check showed the app running. These checks used protocol
acknowledgements, not full readback.
