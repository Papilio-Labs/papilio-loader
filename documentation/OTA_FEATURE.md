# Legacy Python OTA (Over-The-Air) Update Feature

> **Scope:** This document describes the separate Python MCP/API package's OTA
> behavior and does not describe the TypeScript/Electron MCP contract introduced
> in version 0.5.0. Electron MCP uploads require a positively identified
> resident loader and default to raw application images. See
> [MCP Resident-Loader Uploads](MCP_RESIDENT_LOADER.md).

## Overview

The Papilio Loader MCP server now supports **OTA (Over-The-Air) updates** for devices over WiFi/network, in addition to the existing USB/serial programming capabilities.

## How It Works

### Device Requirements

Devices must be running firmware that includes an HTTP OTA server on port 3232 with the following endpoints:

- **ESP32 Firmware Update**: `POST http://DEVICE_IP:3232/update`
- **FPGA Bitstream Update**: `POST http://DEVICE_IP:3232/fpga-update`

### Discovery Methods

1. **Network Scan** (`discover_ota_devices`):
   - Automatically scans local subnet for devices with OTA endpoints
   - Returns list of discovered devices with IP addresses
   - Configurable timeout and port

2. **Direct IP Check** (`check_device_ip`):
   - Verify a specific IP address has OTA capability
   - Useful when device IP is already known

3. **Manual IP Entry**:
   - Users can directly specify device IP if known
   - No discovery needed

## New MCP Tools

### `discover_ota_devices`

Scan the local network for OTA-capable devices.

**Parameters:**
- `timeout` (int, optional): Timeout in seconds for each device check (default: 2)
- `port` (int, optional): OTA server port to scan (default: 3232)

**Returns:**
```json
{
  "success": true,
  "devices_found": 2,
  "devices": [
    {
      "ip": "10.0.4.35",
      "port": 3232,
      "url": "http://10.0.4.35:3232",
      "endpoints": {
        "esp32_update": "http://10.0.4.35:3232/update",
        "fpga_update": "http://10.0.4.35:3232/fpga-update"
      }
    }
  ]
}
```

### `check_device_ip`

Check if a specific IP address has an OTA endpoint.

**Parameters:**
- `ip` (string, required): IP address to check (e.g., "10.0.4.35")
- `port` (int, optional): OTA server port (default: 3232)

**Returns:**
```json
{
  "success": true,
  "available": true,
  "ip": "10.0.4.35",
  "port": 3232,
  "endpoints": {
    "esp32_update": "http://10.0.4.35:3232/update",
    "fpga_update": "http://10.0.4.35:3232/fpga-update"
  }
}
```

### `flash_device_ota`

Flash a device via OTA using WiFi/network.

**Parameters:**
- `ip` (string, required): Device IP address (e.g., "10.0.4.35")
- `device_type` (string, required): Type of device ("esp32" or "fpga")
- `file_path` (string, required): Path to firmware file (bin/elf for ESP32, bin for FPGA)
- `port` (int, optional): OTA server port (default: 3232)

**Returns:**
```json
{
  "success": true,
  "device_type": "ESP32",
  "ip": "10.0.4.35",
  "port": 3232,
  "file": "build/fpga_companion.bin",
  "file_size": 1494576,
  "response": "OTA update successful. Rebooting in 3 seconds...",
  "message": "✅ ESP32 OTA update successful! Device will reboot."
}
```

## Usage Examples

### Example 1: Discover and Flash

```python
# 1. Discover devices on network
devices = await discover_ota_devices()

# 2. Flash first discovered device
if devices["devices_found"] > 0:
    device_ip = devices["devices"][0]["ip"]
    result = await flash_device_ota(
        ip=device_ip,
        device_type="esp32",
        file_path="build/firmware.bin"
    )
```

### Example 2: Direct Flash to Known IP

```python
# Flash directly to known device IP
result = await flash_device_ota(
    ip="10.0.4.35",
    device_type="fpga",
    file_path="impl/pnr/bitstream.bin",
    port=3232
)
```

### Example 3: Using with Claude/MCP

```
User: "Discover OTA devices on my network"
→ Claude calls: discover_ota_devices()

User: "Flash the ESP32 firmware at build/firmware.bin to 10.0.4.35"
→ Claude calls: flash_device_ota(ip="10.0.4.35", device_type="esp32", file_path="build/firmware.bin")
```

## Implementation Details

### Network Discovery Process

1. Determine local IP address and subnet
2. Generate list of IPs to scan (e.g., 10.0.4.1-254)
3. Concurrently check each IP for HTTP response on port 3232
4. Return list of responding devices

### OTA Flash Process

1. Validate firmware file exists and has correct extension
2. Read firmware binary data
3. POST binary data to device OTA endpoint
4. Wait for response (up to 2 minute timeout)
5. Return success/failure status

### Security Considerations

- OTA endpoints should only be accessible on trusted networks
- Consider adding authentication to OTA endpoints in production
- File validation ensures correct firmware type before flash
- Network timeouts prevent hanging on unreachable devices

## Performance

### Discovery Speed

- Subnet scan (254 IPs): ~5-10 seconds with 1s timeout per IP
- Single IP check: <1 second
- Concurrent scanning minimizes total time

### Flash Speed

Based on testing with FPGA Companion firmware:
- **ESP32 firmware** (1.5 MB): ~2-3 seconds @ 40 MHz SPI flash
- **FPGA bitstream** (2 MB): ~3-4 seconds @ 40 MHz SPI flash
- Network transfer is typically faster than USB serial

## Troubleshooting

### Device Not Discovered

1. Verify device is powered on and connected to network
2. Check device is on same subnet as host machine
3. Confirm device firmware includes OTA server
4. Test direct IP check instead of full scan
5. Check firewall allows port 3232

### Flash Fails

1. Verify device IP is correct and reachable
2. Check firmware file path is correct
3. Ensure correct device_type (esp32 vs fpga)
4. Verify file is valid firmware/bitstream
5. Check device has space for update
6. Try USB/serial flash as fallback

### Slow Discovery

1. Reduce timeout parameter (default: 2s)
2. Use direct IP check if IP is known
3. Network congestion may slow scans

## Future Enhancements

Potential improvements for future versions:

1. **mDNS/Bonjour Discovery**: Auto-discovery without subnet scan
2. **Progress Callbacks**: Real-time upload progress
3. **Device Info**: Query device info over OTA (version, flash size, etc.)
4. **Batch Updates**: Flash multiple devices simultaneously
5. **Automatic Retry**: Retry failed updates
6. **Device Database**: Remember known devices and IPs

## Dependencies

The OTA feature requires:
- `aiohttp>=3.9.0`: HTTP client for async requests
- Python 3.12+ with asyncio support

Install with:
```bash
pip install aiohttp
```

Or use the full project installation:
```bash
uv pip install -e .
```

## Testing

Test the OTA functionality:

```bash
# Run OTA tests
python testing/test_ota.py
```

The test script:
- Discovers devices on network
- Checks specific IP addresses
- Demonstrates flash usage (without actually flashing)

## Comparison: USB vs OTA

| Feature | USB/Serial | OTA (WiFi) |
|---------|-----------|------------|
| Speed | ~460 kbps | ~1-3 Mbps |
| Connection | Physical cable required | Network only |
| Discovery | COM port enumeration | Network scan |
| Range | Cable length (~2m) | WiFi range (~30m+) |
| Multi-device | Sequential only | Can parallelize |
| Reliability | Very high | Depends on network |
| Use Case | Initial programming | Updates in field |

## Best Practices

1. **Use USB for initial programming**: More reliable for first-time flash
2. **Use OTA for updates**: Faster and more convenient for firmware updates
3. **Keep known IPs**: Store device IPs to skip discovery
4. **Validate files**: Always check firmware type before flash
5. **Test on one device**: Verify update works before batch flashing
6. **Have USB fallback**: Keep USB cable available for recovery
