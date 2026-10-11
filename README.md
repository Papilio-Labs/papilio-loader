# Papilio Loader

Papilio Loader programs Papilio boards with FPGA bitstreams and ESP32 firmware. Use the Electron desktop application or the no-install browser-based Web Edition for USB and network-based workflows. MCP is an optional interface: the Electron app includes an MCP server, and a separate Python package remains available for Python-based workflows.

## Desktop Application

The Electron desktop loader restores the **Saved Files Library** (save/load,
rename, descriptions, delete, ZIP backup/import including Python exports) and
the **WiFi Log pop-out terminal** (Stop/Reconnect/Clear, auto-scroll, ANSI colors).
These are desktop-only extras in the shared UI; the hosted website still uses
local file selection and USB logs. See
[Saved Files](documentation/SAVED_FILES_FEATURE.md#electron-desktop-app) and
[Desktop Features](documentation/DESKTOP_APP.md#electron-loader).

The Windows desktop application includes system-tray integration and a simple interface for programming boards.

**[👉 Download Desktop App Installer](https://github.com/Papilio-Labs/papilio-loader/releases)**

See [DESKTOP_APP.md](documentation/DESKTOP_APP.md) for installation and usage instructions.

## Features

- **Electron Desktop Application**: Windows app with system-tray integration
- **Web Edition**: Browser-based loader for programming devices without installing a desktop app
- **USB and OTA programming**: Flash over USB or, for compatible devices, WiFi/network
  - Discover OTA-capable devices on local network
  - Flash ESP32 firmware and FPGA bitstreams wirelessly
  - Supports devices with HTTP OTA endpoints (port 3232)
- **MCP integration**: Available in the Electron app and through the separate Python package
- **Python REST API**: FastAPI-based interface provided by the Python package
- **Saved Files Library**: Save frequently-used firmware files with descriptions for easy reuse
- **Dual Programming Tools**: 
  - Official esptool for ESP32 programming (safe and stable)
  - pesptool (GadgetFactory fork) for FPGA programming only
- **Gowin FPGA Support**: Flash Papilio boards (Gowin FPGA) with .bin files via pesptool
- **ESP32 Support**: Flash ESP32 devices with bin/elf files using official esptool, supports multi-partition flashing

## Quick Start

### Option 1: Desktop Application (Easiest)

1. Download and install `PapilioLoader-Setup-x.x.x.exe` from [Releases](https://github.com/Papilio-Labs/papilio-loader/releases)
2. Launch Papilio Loader from Start Menu
3. System tray icon appears - right-click and select "Open Web Interface"

See [DESKTOP_APP.md](documentation/DESKTOP_APP.md) for details.

### Option 2: Web Edition

Use the [Papilio Loader Web Edition](https://papilioworks.com/loader/) in a supported browser; nothing needs to be installed.

### Option 3: Python MCP/API package

The separate Python package remains available for MCP, REST API, and its Python-hosted web interface:

```powershell
uv pip install -e .
python start_combined_server.py
```

See [Python installation](documentation/INSTALLATION.md) and the [MCP quick start](documentation/QUICKSTART.md) for details.

## Python Package Architecture

The following architecture describes the optional Python server package:
```
┌─────────────────┐         Network          ┌──────────────────┐
│   Web Browser   │ ◄────────────────────► │  Windows Host    │
│  WSL / Linux    │      HTTP/MCP           │ Combined Server  │
│  Build Machine  │                         │                  │
│ - Manual Upload │                         │ - Web UI         │
│ - Build FPGA    │                         │ - MCP Server     │
│ - Build ESP32   │                         │ - REST API       │
│ - Send files    │                         │ - pyserial       │
│                 │                         │ - esptool (ESP32)│
│                 │                         │ - pesptool (FPGA)│
└─────────────────┘                         └────────┬─────────┘
                                                     │ USB/Serial
                                                     ▼
                                            ┌─────────────────┐
                                            │ FPGA / ESP32    │
                                            │ Hardware        │
                                            └─────────────────┘
```

## Python Package Installation

The Electron app is distributed through the [GitHub Releases](https://github.com/Papilio-Labs/papilio-loader/releases) page. The following setup is for the separate Python package.

### Prerequisites

1. **Python 3.12+**: Required for running the server
2. **esptool**: Official Espressif tool for ESP32 programming (installed automatically via pip)
3. **pesptool**: GadgetFactory's fork for FPGA programming (included as git submodule)
   - Used ONLY for programming FPGA bitstreams to external flash
   - ESP32 uses official esptool for safety and stability

### Setup

```bash
# Clone the repository
git clone https://github.com/papilio-labs/papilio-loader.git
cd papilio-loader

# Initialize submodules
git submodule update --init --recursive

# Create virtual environment using uv
uv venv

# Install dependencies
uv pip install -e .
```

## Configuration

Set environment variables to configure the server:

```bash
# Network settings
PAPILIO_BIND_ADDRESS=0.0.0.0  # Use 0.0.0.0 for remote access, 127.0.0.1 for local only
PAPILIO_PORT=8000

# Security
PAPILIO_API_KEY=your-secret-key-here  # Optional API authentication
PAPILIO_CORS_ORIGINS=["http://localhost:3000"]  # Comma-separated list

# Limits
PAPILIO_MAX_UPLOAD_SIZE=52428800  # 50 MB in bytes
PAPILIO_RATE_LIMIT=60  # Requests per minute

# Serial settings
PAPILIO_DEFAULT_BAUD_RATE=115200
PAPILIO_SERIAL_TIMEOUT=10
```

## Usage

### As Standalone HTTP/SSE Server (Recommended for Remote Access)

The HTTP/SSE server runs as a standalone Windows process and allows VS Code (or other MCP clients) to connect over HTTP with Server-Sent Events (SSE) transport.

**Benefits:**
- No need for VS Code to spawn the server process
- Server runs continuously, independent of VS Code
- Can be set up as a Windows service
- Multiple clients can connect to the same server instance
- Better for remote/network access scenarios

**Start the server:**

```bash
# Using the startup script
python start_mcp_server.py

# Or run the module directly
python -m papilio_loader_mcp.http_server --port 8765

# Or with custom host/port
python -m papilio_loader_mcp.http_server --host 0.0.0.0 --port 8765
```

The server will start on `http://127.0.0.1:8000` with the SSE endpoint at `/sse`.

**Configure VS Code:**

Update `.vscode/mcp.json` in your project:

```json
{
  "servers": {
    "papilio-loader": {
      "type": "sse",
      "url": "http://127.0.0.1:8000/sse"
    }
  }
}
```

**Note:** VS Code uses `"servers"` at the top level (not `"mcpServers"` which is for Claude Desktop).

For network access from other machines, use `"url": "http://YOUR_WINDOWS_IP:8000/sse"`.

**Set up as Windows Service (Optional):**

To run the server automatically on Windows startup, you can use NSSM (Non-Sucking Service Manager) or Task Scheduler:

```powershell
# Download NSSM from https://nssm.cc/download
nssm install PapilioMCP "C:\Python314\python.exe" "C:\development\papilio-loader-mcp\start_mcp_server.py"
nssm start PapilioMCP
```

### As MCP Server (GitHub Copilot in VS Code - stdio mode)

This project is pre-configured for GitHub Copilot MCP integration. After installation:

1. Reload VS Code window (`Ctrl+Shift+P` → "Developer: Reload Window")
2. Open GitHub Copilot Chat
3. The MCP tools will be available automatically

See [VSCODE_SETUP.md](VSCODE_SETUP.md) for detailed setup instructions.

### As MCP Server (Claude Desktop)

1. Add to your Claude Desktop configuration (`%APPDATA%\Claude\claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "papilio-loader": {
      "type": "sse",
      "url": "http://localhost:8000/sse"
    }
  }
}
```

**Note:** Claude Desktop uses `"mcpServers"` at the top level (not `"servers"` which is for VS Code).

2. Restart Claude Desktop

3. Use natural language to interact:
   - "List available serial ports"
   - "Flash this bit file to COM3"
   - "Get ESP32 chip information on /dev/ttyUSB0"

### As REST API Server

```bash
# Start the API server
python -m papilio_loader_mcp.api

# Or use uvicorn directly
uvicorn papilio_loader_mcp.api:api --host 0.0.0.0 --port 8000
```

### API Endpoints

#### Health Check
```bash
curl http://localhost:8000/health
```

#### List Serial Ports
```bash
curl -H "X-API-Key: your-key" http://localhost:8000/ports
```

#### Get Device Info
```bash
curl -X POST http://localhost:8000/device/info \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your-key" \
  -d '{"port": "COM3", "device_type": "esp32"}'
```

#### Flash Device
```bash
curl -X POST http://localhost:8000/flash/upload \
  -H "X-API-Key: your-key" \
  -F "file=@firmware.bin" \
  -F "port=COM3" \
  -F "device_type=esp32" \
  -F "address=0x1000" \
  -F "verify=true"
```

## MCP Tools

The server provides these MCP tools:

### USB/Serial Programming
- `list_serial_ports`: List all available COM ports
- `get_device_info`: Query device information (FPGA/ESP32)
- `get_flash_status`: Get flash memory status and info
- `flash_device`: Flash firmware to device with verification via USB/serial

### OTA (Over-The-Air) Programming
- `discover_ota_devices`: Scan local network for OTA-capable devices (HTTP endpoint on port 3232)
- `check_device_ip`: Check if a specific IP address has an OTA endpoint available
- `flash_device_ota`: Flash ESP32 firmware or FPGA bitstream via WiFi/network

### OTA Usage Examples

**Discover devices on network:**
```python
# Returns list of devices with their IP addresses and endpoints
discover_ota_devices(timeout=2, port=3232)
```

**Check specific device:**
```python
# Verify device at known IP has OTA capability
check_device_ip(ip="10.0.4.35", port=3232)
```

**Flash via OTA:**
```python
# Flash ESP32 firmware
flash_device_ota(
    ip="10.0.4.35",
    device_type="esp32",
    file_path="build/fpga_companion.bin",
    port=3232
)

# Flash FPGA bitstream
flash_device_ota(
    ip="10.0.4.35",
    device_type="fpga",
    file_path="impl/pnr/a2600nano_retrocade.bin",
    port=3232
)
```

**Note:** OTA flashing requires:
- Device must be running firmware with HTTP OTA server on port 3232
- Device must be connected to same network
- ESP32 OTA endpoint: `POST http://IP:3232/update`
- FPGA OTA endpoint: `POST http://IP:3232/fpga-update`

## Development

### Project Structure

```
papilio-loader/
├── src/
│   └── papilio_loader_mcp/
│       ├── __init__.py
│       ├── server.py          # MCP server implementation
│       ├── api.py             # FastAPI REST API
│       ├── config.py          # Configuration management
│       └── tools/             # Tool implementations
│           ├── serial_ports.py
│           ├── device_info.py
│           ├── flash_status.py
│           ├── fpga_flash.py
│           └── esp_flash.py
├── tools/
│   └── pesptool/             # Git submodule (GadgetFactory/esptool)
├── temp/                     # Temporary file uploads
├── logs/                     # Application logs
├── pyproject.toml
└── README.md
```

### Running Tests

```bash
# TODO: Add tests
uv run pytest
```

## Client Examples

### Python Client

```python
import requests

API_URL = "http://windows-host:8000"
API_KEY = "your-key"

headers = {"X-API-Key": API_KEY}

# List ports
response = requests.get(f"{API_URL}/ports", headers=headers)
print(response.json())

# Flash ESP32
with open("firmware.bin", "rb") as f:
    files = {"file": f}
    data = {
        "port": "COM3",
        "device_type": "esp32",
        "address": "0x1000",
        "verify": "true"
    }
    response = requests.post(
        f"{API_URL}/flash/upload",
        headers=headers,
        files=files,
        data=data
    )
    print(response.json())
```

### WSL/Linux Client

```bash
#!/bin/bash
# flash_from_wsl.sh

WINDOWS_HOST="192.168.1.100:8000"
API_KEY="your-key"

# Build your project
make build

# Flash to device via Windows host
curl -X POST "http://${WINDOWS_HOST}/flash/upload" \
  -H "X-API-Key: ${API_KEY}" \
  -F "file=@build/firmware.bin" \
  -F "port=COM3" \
  -F "device_type=esp32" \
  -F "address=0x1000"
```

### curl Examples

```bash
# List ports
curl http://localhost:8000/ports

# Get device info
curl -X POST http://localhost:8000/device/info \
  -H "Content-Type: application/json" \
  -d '{"port": "COM3", "device_type": "fpga"}'

# Flash FPGA
curl -X POST http://localhost:8000/flash/upload \
  -F "file=@design.bit" \
  -F "port=COM3" \
  -F "device_type=fpga"
```

## Troubleshooting

### Port Access Issues
- Ensure no other programs are using the serial port
- On Windows, check Device Manager for COM port assignments
- Verify USB drivers are installed for your device

### Permission Errors
- Run as Administrator on Windows if accessing USB ports fails
- Check firewall settings for network access

### pesptool Not Found
- Ensure git submodules are initialized: `git submodule update --init`
- Check that `tools/pesptool/esptool.py` exists
- pesptool is the unified tool for both FPGA and ESP32 programming

## License

[Add your license here]

## Contributing

Contributions welcome! Please open issues or pull requests.

## References

- [MCP (Model Context Protocol)](https://github.com/anthropics/mcp)
- [Papilio FPGA](http://papilio.cc)
- [GadgetFactory pesptool](https://github.com/GadgetFactory/esptool)
- [ESP32 Documentation](https://docs.espressif.com/projects/esp-idf/)
