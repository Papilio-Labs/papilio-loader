# System Architecture

## Complete System Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                           CLIENT LAYER                              │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌──────────────┐   ┌──────────────┐   ┌──────────────┐          │
│  │ Web Browser  │   │    Claude    │   │ REST Client  │          │
│  │              │   │   Desktop    │   │  (curl, etc) │          │
│  │ - HTML/CSS   │   │              │   │              │          │
│  │ - JavaScript │   │ - MCP Client │   │ - Scripts    │          │
│  └──────┬───────┘   └──────┬───────┘   └──────┬───────┘          │
│         │                  │                  │                    │
│         │ HTTP/Session     │ SSE/MCP          │ HTTP/API Key       │
│         │                  │                  │                    │
└─────────┼──────────────────┼──────────────────┼────────────────────┘
          │                  │                  │
          │                  │                  │
┌─────────┼──────────────────┼──────────────────┼────────────────────┐
│         │                  │                  │                    │
│         ▼                  ▼                  ▼                    │
│  ┌─────────────────────────────────────────────────────┐          │
│  │     Starlette App (Combined Server - Port 8000)     │          │
│  ├─────────────────────────────────────────────────────┤          │
│  │                                                      │          │
│  │  ┌──────────────────────────────────────────────┐  │          │
│  │  │  FastAPI App (Mounted at /)                  │  │          │
│  │  ├──────────────────────────────────────────────┤  │          │
│  │  │                                               │  │          │
│  │  │  Web Routes (/web/*)                         │  │          │
│  │  │  ├─ GET  /web/login → login.html            │  │          │
│  │  │  ├─ POST /web/login → session auth           │  │          │
│  │  │  ├─ POST /web/logout → clear session         │  │          │
│  │  │  ├─ GET  /web/upload → upload.html           │  │          │
│  │  │  ├─ GET  /web/ports → list ports             │  │          │
│  │  │  └─ POST /web/flash → flash device           │  │          │
│  │  │                                               │  │          │
│  │  │  API Routes (/)                               │  │          │
│  │  │  ├─ GET  /health → health check              │  │          │
│  │  │  ├─ GET  /docs → Swagger UI                  │  │          │
│  │  │  ├─ GET  /ports → list ports (API key)       │  │          │
│  │  │  ├─ POST /device/info → device info          │  │          │
│  │  │  ├─ POST /device/flash-status → flash status │  │          │
│  │  │  └─ POST /flash/upload → upload & flash      │  │          │
│  │  │                                               │  │          │
│  │  │  Session Middleware                           │  │          │
│  │  │  └─ Encrypts/validates session cookies        │  │          │
│  │  │                                               │  │          │
│  │  │  CORS Middleware                              │  │          │
│  │  │  └─ Handles cross-origin requests             │  │          │
│  │  │                                               │  │          │
│  │  └───────────────────────────────────────────────┘  │          │
│  │                                                      │          │
│  │  MCP Routes (SSE)                                   │          │
│  │  ├─ GET  /sse → SSE connection                      │          │
│  │  └─ POST /messages/* → MCP messages                 │          │
│  │                                                      │          │
│  └──────────────────────┬───────────────────────────────┘          │
│                         │                                          │
│                         ▼                                          │
│           ┌──────────────────────────────┐                        │
│           │   MCP Server (server.py)     │                        │
│           ├──────────────────────────────┤                        │
│           │  MCP Tools:                  │                        │
│           │  - list_serial_ports         │                        │
│           │  - get_device_info           │                        │
│           │  - get_flash_status          │                        │
│           │  - flash_fpga_device         │                        │
│           │  - flash_esp_device          │                        │
│           └──────────────┬───────────────┘                        │
│                          │                                         │
│                          ▼                                         │
│         ┌────────────────────────────────────┐                    │
│         │      Tool Implementations          │                    │
│         ├────────────────────────────────────┤                    │
│         │  serial_ports.py → pyserial        │                    │
│         │  device_info.py → esptool/pesptool │                    │
│         │  flash_status.py → esptool/pesptool│                    │
│         │  fpga_flash.py → pesptool          │                    │
│         │  esp_flash.py → esptool            │                    │
│         └─────────────┬──────────────────────┘                    │
│                       │                                            │
│                       ▼                                            │
│         ┌─────────────────────────────┐                           │
│         │   External Tools            │                           │
│         ├─────────────────────────────┤                           │
│         │  pyserial                   │                           │
│         │  esptool (official ESP32)   │                           │
│         │  pesptool (GadgetFactory)   │                           │
│         └─────────────┬───────────────┘                           │
│                       │                                            │
│         PAPILIO LOADER SERVER (Windows)                           │
└───────────────────────┼───────────────────────────────────────────┘
                        │
                        │ USB/Serial
                        │
┌───────────────────────┼───────────────────────────────────────────┐
│                       ▼                                            │
│              ┌──────────────────┐                                 │
│              │  Hardware Layer  │                                 │
│              ├──────────────────┤                                 │
│              │  COM Ports       │                                 │
│              │  - COM3, COM4... │                                 │
│              └────────┬─────────┘                                 │
│                       │                                            │
                        Execute: pesptool.exe --port COM4 write-flash 0x100000 bitstream.bin
│         ┌─────────────────────────┐                               │
│         │   Physical Devices      │                               │
│         ├─────────────────────────┤                               │
│         │  Papilio Board (FPGA)   │                               │
│         │  ESP32 Modules          │                               │
│         └─────────────────────────┘                               │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
```

## Data Flow Examples

### 1. Web User Flashing FPGA

```
Browser → HTTP POST /web/flash
    ↓
FastAPI Session Auth Check
    ↓
Save uploaded .bin file to temp/
    ↓
Call flash_fpga_device(port, file_path, verify)
    ↓
                        Execute: esptool.exe --port COM3 write-flash 0x1000 firmware.bin
    ↓
pesptool → USB/Serial → Papilio Board
    ↓
Return status to browser
    ↓
Display in Status Log
```

### 2. MCP Client via Claude

```
Claude Desktop → SSE Connection /sse
    ↓
Establish bidirectional streams
    ↓
User: "Flash ESP32 on COM3"
    ↓
Claude → MCP Request: list_tools()
    ↓
                        Execute: esptool.exe --port COM5 write-flash 0x1000 app.bin
    ↓
Claude → MCP Request: flash_esp_device(...)
    ↓
Execute: python -m esptool --port COM3 write-flash 0x1000 firmware.bin
    ↓
esptool → USB/Serial → ESP32 Module
    ↓
Return JSON result via MCP
    ↓
Claude → User: "Device flashed successfully!"
```

### 3. REST API via Script

```
Script → HTTP POST /flash/upload (with API key header)
    ↓
FastAPI API Key Auth Check
    ↓
Save uploaded firmware to temp/
    ↓
Call flash_esp_device(port, file_path, address, verify)
    ↓
Execute: python -m esptool --port COM5 write-flash 0x1000 app.bin
    ↓
esptool → USB/Serial → ESP32 Module
    ↓
Return JSON response to script
    ↓
Script parses JSON and continues CI/CD pipeline
```

## Configuration Flow

```
Environment Variables
    ↓
    PAPILIO_WEB_USERNAME=admin
    PAPILIO_WEB_PASSWORD=admin
    PAPILIO_SESSION_SECRET_KEY=secret
    PAPILIO_API_KEY=key123
    PAPILIO_PORT=8000
    ↓
config.py (BaseSettings)
    ↓
Loaded by:
    - api.py (for web/API settings)
    - start_combined_server.py (for server settings)
    ↓
Used throughout application
```

## File Organization

```
papilio-loader/
│
├── start_combined_server.py    ← Entry point (combines everything)
├── start.ps1                    ← Convenience script
│
├── src/papilio_loader_mcp/
│   ├── server.py                ← MCP server core
│   ├── api.py                   ← FastAPI app (Web + REST)
│   ├── config.py                ← Configuration management
│   │
│   └── tools/                   ← Tool implementations
│       ├── serial_ports.py
│       ├── device_info.py
│       ├── flash_status.py
│       ├── fpga_flash.py
│       └── esp_flash.py
│
├── templates/                   ← Web UI templates
│   ├── login.html
│   └── upload.html
│
├── temp/                        ← Temporary uploads (dev-only)
│                                 Installed executables use
│                                 %LOCALAPPDATA%\papilio-loader-mcp\temp
│
└── tools/
    └── pesptool/                ← GadgetFactory esptool fork
```

## Security Boundaries

```
┌─────────────────────────────────────────┐
│  Public Network                         │
│  (Untrusted)                            │
└─────────────┬───────────────────────────┘
              │
              │ HTTPS (via reverse proxy)
              │
┌─────────────▼───────────────────────────┐
│  Web Interface                          │
│  Authentication: Session + Password     │
│  Authorization: Check session cookie    │
└─────────────┬───────────────────────────┘
              │
              │ Internal
              │
┌─────────────▼───────────────────────────┐
│  REST API                               │
│  Authentication: Optional API Key       │
│  Authorization: Check X-API-Key header  │
└─────────────┬───────────────────────────┘
              │
              │ Internal
              │
┌─────────────▼───────────────────────────┐
│  MCP Server                             │
│  Authentication: None (local only)      │
│  Authorization: N/A (trusted client)    │
└─────────────┬───────────────────────────┘
              │
              │ Internal function calls
              │
┌─────────────▼───────────────────────────┐
│  Tool Layer                             │
│  - Serial port access                   │
│  - File system access                   │
│  - Process execution (esptool/pesptool) │
└─────────────┬───────────────────────────┘
              │
              │ System calls
              │
┌─────────────▼───────────────────────────┐
│  Operating System                       │
│  - USB/Serial drivers                   │
│  - COM port access                      │
└─────────────────────────────────────────┘
```

## Summary

- **Single Process**: One Python application
- **Single Port**: Default 8000 (configurable)
- **Three Interfaces**: Web, MCP, REST API
- **Shared Backend**: All use same tools
- **Independent Auth**: Each interface has appropriate security
- **Concurrent Access**: All interfaces work simultaneously
