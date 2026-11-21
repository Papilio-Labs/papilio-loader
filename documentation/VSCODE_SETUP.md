# GitHub Copilot MCP Server Setup for VS Code

## Quick Setup

### Option 1: Standalone SSE Server (Recommended)

This is the most reliable method and allows the server to run independently.

**1. Start the Combined Server:**
```powershell
.\start.ps1
```

The server will start on port 8000 with SSE endpoint at `/sse`.

**2. Configure VS Code MCP:**

Create or update `.vscode/mcp.json` in your workspace:

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

**Important:** VS Code uses `"servers"` (not `"mcpServers"` which is for Claude Desktop).

**3. Reload VS Code:**

Press `Ctrl+Shift+P` → "Developer: Reload Window"

### Option 2: stdio Mode (Legacy)

This workspace can also be configured with `.vscode/settings.json` for stdio mode:

### 1. Install the Package (One Time)

```bash
cd papilio-loader

# Using uv (recommended)
uv venv
uv pip install -e .

# Or using regular pip
python -m venv .venv
# On Windows:
.venv\Scripts\activate
# On Linux/Mac:
source .venv/bin/activate
pip install -e .
```

This installs:
- The `papilio-loader-mcp` package  
- Official `esptool` for ESP32 programming
- All dependencies (FastAPI, MCP SDK, pyserial, etc.)

### 2. Select Python Interpreter in VS Code

Press `Ctrl+Shift+P` → "Python: Select Interpreter" → Choose the `.venv` interpreter

This ensures VS Code uses the venv for the MCP server.

### 2. Reload VS Code

Press `Ctrl+Shift+P` and run: **Developer: Reload Window**

That's it! The MCP server should now be available in GitHub Copilot Chat.

### 3. Use in GitHub Copilot Chat

Open GitHub Copilot Chat and you can now ask:

**List Serial Ports:**
```
@workspace List all serial ports on the system
```

**Flash FPGA:**
```
@workspace Flash the FPGA bitstream at c:/development/papilio-loader-mcp/debugging/papilio_arcade_template.bin to COM4
```

**Flash ESP32:**
```
@workspace Flash the ESP32 firmware at c:/development/papilio-loader-mcp/debugging/firmware.bin to COM4 at address 0x10000
```

**Get Device Info:**
```
@workspace Get device information for COM4 ESP32
```

## Available MCP Tools

The server provides these tools to GitHub Copilot:

1. **list_serial_ports** - Lists all COM ports with details
2. **get_device_info** - Gets information about a connected device
3. **get_flash_status** - Gets flash memory status
4. **flash_device** - Flashes FPGA (.bin) or ESP32 (.bin/.elf) firmware

## Configuration Details

**Location:** `.vscode/settings.json`

**MCP Server:** `papilio-loader`
- Command: `python -m papilio_loader_mcp.server`
- Working Directory: Workspace folder
- Enabled for GitHub Copilot Chat

## Tools Used

- **Official esptool v5.1.0** - For safe ESP32 programming
- **pesptool (GadgetFactory fork)** - For FPGA bitstream programming only

## Testing Without VS Code

You can still test the tools directly:

```bash
# Test both devices
python debugging\test_flash_both.py

# Test serial ports
python debugging\test_ports.py
```

## Troubleshooting

### MCP Server Not Loading or Hanging

If the MCP server doesn't appear or hangs:

1. **Check Python is in PATH:**
   ```bash
   python --version
   ```

2. **Verify package installation:**
   ```bash
   pip show papilio-loader-mcp
   ```

3. **Test server manually** (should start without errors):
   ```bash
   python -m papilio_loader_mcp.server
   ```
   Press Ctrl+C to stop. If it hangs here too, check for:
   - Missing dependencies: `pip install -e .`
   - Python version: Requires Python 3.12+

4. **Check VS Code Output panel** for MCP errors:
   - View → Output → Select "GitHub Copilot" from dropdown

5. **Reload VS Code window:**
   - `Ctrl+Shift+P` → "Developer: Reload Window"

6. **Try alternative configuration** in `.vscode/settings.json`:
   ```json
   {
     "github.copilot.chat.mcp.enabled": true,
     "github.copilot.chat.mcp.servers": {
       "papilio-loader": {
         "command": "python3",
         "args": ["-m", "papilio_loader_mcp.server"]
       }
     }
   }
   ```

## Example Workflow

1. Build your FPGA design or ESP32 firmware
2. Open GitHub Copilot Chat in VS Code
3. Ask: "Flash the FPGA bitstream to COM4"
4. Copilot will use the MCP server to flash the device
5. Get real-time results and feedback

The MCP server automatically detects file types and uses the correct tool!
