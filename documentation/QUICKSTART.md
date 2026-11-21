# Quick Start Guide

## Installation

```powershell
# Clone and setup
git clone https://github.com/papilio-labs/papilio-loader.git
cd papilio-loader
git submodule update --init --recursive

# Install dependencies
uv pip install -e .
```

Alternatively (Windows users): run the installer `PapilioLoader-Setup-x.x.x.exe` and start `PapilioLoader.exe` from the Start Menu.

## Starting the Server

```powershell
.\start.ps1
```

This starts all three interfaces on port 8000:
- **Web Interface**: http://localhost:8000/web/login
- **MCP Server**: http://localhost:8000/sse
- **REST API**: http://localhost:8000/docs

**Default login**: admin / admin (change in production!)

## Using the Web Interface

1. Open http://localhost:8000/web/login in your browser
2. Login with credentials
3. Select COM port and device type (FPGA or ESP32)
4. Upload firmware file (.bin or .elf)
5. Click "Flash" button
6. Monitor progress in Status Log

## Using the MCP Server

### With VS Code

Create `.vscode/mcp.json` in your workspace:

```json
{
  "servers": {
    "papilio-loader": {
      "type": "sse",
      "url": "http://localhost:8000/sse"
    }
  }
}
```

Reload VS Code window, then use GitHub Copilot Chat.

### With Claude Desktop

Add to Claude Desktop config (`%APPDATA%\Claude\claude_desktop_config.json`):

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

**Note:** VS Code uses `"servers"`, Claude Desktop uses `"mcpServers"`.

Then ask Claude/Copilot:
- "List available serial ports"
- "Flash the FPGA bitstream at C:/path/to/file.bin to COM4"
- "Get device info for COM3"

## Using the REST API

```bash
# List ports
curl http://localhost:8000/ports

# Flash device
curl -X POST http://localhost:8000/flash/upload \
  -F "file=@firmware.bin" \
  -F "port=COM4" \
  -F "device_type=esp32" \
  -F "address=0x1000"
```

## Configuration

Set environment variables to customize:

```powershell
$env:PAPILIO_WEB_USERNAME = "your_username"
$env:PAPILIO_WEB_PASSWORD = "your_password"
$env:PAPILIO_API_KEY = "your-api-key"
$env:PAPILIO_PORT = "8000"
```

## Troubleshooting

**No ports showing?**
- Click "🔄 Refresh" button
- Check device is connected and drivers installed

**Login not working?**
- Check credentials (default: admin/admin)
- Clear browser cookies
- Restart server

**Import errors?**
```powershell
uv pip install -e .
```

## Next Steps

- **Web Users**: See [WEB_INTERFACE_GUIDE.md](WEB_INTERFACE_GUIDE.md)
- **Developers**: See [ARCHITECTURE.md](ARCHITECTURE.md)
- **Comparison**: See [INTERFACE_COMPARISON.md](INTERFACE_COMPARISON.md)
