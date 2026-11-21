# Installation Guide

## Choose Your Installation Method

### Option A: Windows Installer (Recommended)

1. Download: PapilioLoader-Setup-x.x.x.exe
2. Run the installer and follow prompts
3. Optional tasks:
  - Add Papilio Loader to PATH (command-line tools)
  - Create Desktop/Start Menu shortcuts
  - Enable auto-start at login

Includes:
- GUI apps: PapilioLoader.exe and PapilioLoader-Console.exe
- Standalone tools: pesptool.exe (FPGA) and esptool.exe (ESP32)
- User data: %LOCALAPPDATA%\\papilio-loader-mcp\\ (temp, saved_files, DB)

### Option B: Developer Install (Source)

Prerequisites
- **Python 3.12+**
- **Git** with submodule support
- **Windows** (required for COM port access)

```bash
# Clone repository with submodules
git clone https://github.com/papilio-labs/papilio-loader.git
cd papilio-loader
git submodule update --init --recursive

# Install dependencies
uv pip install -e .
```

This installs:
- Official esptool for ESP32
- All Python dependencies (FastAPI, MCP SDK, pyserial)
- pesptool submodule for FPGA (GadgetFactory fork)

## Configuration

### For MCP (VS Code)

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

Reload VS Code window after updating the config.

### For MCP (Claude Desktop)

Add to `%APPDATA%\Claude\claude_desktop_config.json`:

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

Restart Claude Desktop after updating the config.

### For Web Interface

Set environment variables (optional, defaults to admin/admin):

```powershell
$env:PAPILIO_WEB_USERNAME = "your_username"
$env:PAPILIO_WEB_PASSWORD = "your_password"
$env:PAPILIO_SESSION_SECRET_KEY = "random-secret-key"
```

## Starting the Server

```powershell
.\start.ps1
```

Access points:
- **Web**: http://localhost:8000/web/login
- **MCP**: http://localhost:8000/sse (for Claude)
- **API**: http://localhost:8000/docs

Installed Desktop app:

```powershell
PapilioLoader.exe
```

Use the tray icon to open the web interface quickly.

## Testing

### Test MCP Tools

In Claude Desktop, ask:
- "List the serial ports on my system"
- "Get device info for COM4"
- "Flash the FPGA bitstream at C:/path/to/file.bin to COM4"

### Test Web Interface

1. Open http://localhost:8000/web/login
2. Login with credentials (default: admin/admin)
3. Select port and upload firmware file
4. Click Flash button

### Test REST API

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

## Troubleshooting

**Import errors?**
```powershell
uv pip install -e .
```

**Submodule missing?**
```bash
git submodule update --init --recursive
```

**COM port access denied?**
- Run PowerShell as Administrator
- Check drivers are installed
- Close other programs using the port

**Write errors in installed app?**
- Installed executables write to %LOCALAPPDATA%\\papilio-loader-mcp\\ (temp, saved files, DB)
- Do not write to Program Files; use the user data directory

## Next Steps

- **Quick Start**: See [QUICKSTART.md](QUICKSTART.md)
- **Web Guide**: See [WEB_INTERFACE_GUIDE.md](WEB_INTERFACE_GUIDE.md)
- **Architecture**: See [ARCHITECTURE.md](ARCHITECTURE.md)

## Command-Line Tools (Installed Version)

If PATH integration is selected during installation, use:

```powershell
# FPGA: write bitstream at 0x100000
pesptool.exe --port COM4 write-flash 0x100000 C:\path\to\bitstream.bin

# ESP32: write firmware at 0x1000
esptool.exe --port COM4 write-flash 0x1000 C:\path\to\firmware.bin
```
