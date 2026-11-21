# Building Papilio Loader Desktop Application

Quick reference guide for building the desktop application.

## Prerequisites

- Python 3.12 or later
- Git
- Windows (for full build)
- Node.js and npm for building the web UI and Electron installer

## Quick Build

### Build Everything

```powershell
# Clone and setup
git clone https://github.com/Papilio-Labs/papilio-loader.git
cd papilio-loader

# Install dependencies
pip install -e .[desktop]

# Build executable and installer
.\build.ps1
```

Output:
- `dist/PapilioLoader.exe` - Desktop GUI executable
- `dist/PapilioLoader-Console.exe` - Console variant (debug output)
- `dist/pesptool.exe` - Standalone FPGA flashing tool
- `dist/esptool.exe` - Standalone ESP32 flashing tool
- `installer_output/PapilioLoader-Setup-x.x.x.exe` - Windows installer
- `apps/desktop/release/Papilio Loader Setup x.x.x.exe` - Electron Builder output

### Build Executable Only

```powershell
.\build.ps1 -NoInstaller
```

or

```bash
python build.py --no-installer
```

This still builds `pesptool.exe` and `esptool.exe` alongside the main app.

### Build Installer from Existing Executable

```powershell
.\build.ps1 -InstallerOnly
```

## Manual Steps

### 1. Install Dependencies

```bash
pip install -e .[desktop]
```

This installs:
- Core dependencies (esptool, fastapi, mcp, etc.)
- Desktop dependencies (pystray, Pillow, pyinstaller)

### 2. Build with PyInstaller

```bash
pyinstaller papilio_loader.spec --clean
```

The spec file is pre-configured to:
- Bundle all dependencies
- Include templates and tools/pesptool
- Create a single-file executable
- Hide console window
- Use appropriate data directories

Standalone tools:
- `pesptool.spec` builds the FPGA tool
- `esptool.spec` builds the ESP32 tool and collects chip stub JSON data

### 3. Create Windows Installer (Optional)

The installer is built with Electron Builder and packages the current web UI.
Run the release build from the repository root:

```powershell
.\build.ps1 -InstallerOnly
```

The canonical installer is copied to `installer_output/`. The legacy
`installer.iss` Inno Setup script is not used for current releases.

## Build Options

### Build Script Options

```powershell
.\build.ps1 [options]
```

- `-NoClean` - Skip cleaning previous build artifacts
- `-NoInstaller` - Build executable only
- `-InstallerOnly` - Only create installer
- `-Help` - Show help

Python equivalent:

```bash
python build.py [--no-clean] [--no-installer] [--installer-only]
```

## Troubleshooting

### "ModuleNotFoundError" during build

Install desktop dependencies:
```bash
pip install -e .[desktop]
```

### PyInstaller can't find modules

Add missing imports to `hiddenimports` in `papilio_loader.spec`:

```python
hiddenimports = [
    'your_missing_module',
    # ... existing imports
]
```

### Template files not bundled

Check `datas` section in `papilio_loader.spec`:

```python
datas = [
    ('templates', 'templates'),
    ('tools/pesptool', 'tools/pesptool'),
]

For `esptool.exe`, ensure JSON stubs are bundled via `esptool.spec`:

```python
from PyInstaller.utils.hooks import collect_data_files
datas = collect_data_files('esptool')
```
```

### Executable is too large

The single-file build includes all dependencies. To reduce size:

1. Switch to directory build (uncomment `COLLECT` in spec file)
2. Exclude unnecessary packages in `excludes` list
3. Use UPX compression (already enabled)

### Inno Setup not found

Download from: https://jrsoftware.org/isinfo.php

Or skip installer creation:
```powershell
.\build.ps1 -NoInstaller
```

## Testing the Build

### Test Executable

```powershell
.\dist\PapilioLoader.exe
```

Should:
- Show system tray icon
- Start web server on port 8000
- Open browser when clicking "Open Web Interface"

Also verify standalone tools:

```powershell
./dist/pesptool.exe --help
./dist/esptool.exe --help
```

### Test Installer

1. Run the installer
2. Check installation in Program Files
3. Verify Start Menu shortcuts
4. Test auto-start option (if selected)
5. Verify user data directory created in `%LOCALAPPDATA%\papilio-loader-mcp\`

## Customization

### Change Application Icon

1. Create/obtain an `.ico` file
2. Update `papilio_loader.spec`:
   ```python
   exe = EXE(
       ...,
       icon='path/to/your/icon.ico',
       ...
   )
   ```

### Version Information

Update the workspace package versions consistently in `package.json`,
`apps/web/package.json`, and `apps/desktop/package.json`.

Note: Update both GUI and tool versions consistently.

### Application Name

Update in:
- `apps/desktop/electron-builder.yml` - `productName`

## Distribution

### Files to Distribute

**Standalone Executable:**
- `dist/PapilioLoader.exe`

**Windows Installer:**
- `installer_output/PapilioLoader-Setup-x.x.x.exe`

**Source Distribution:**
```bash
python -m build
```
Creates wheel and sdist in `dist/`

### GitHub Releases

1. Tag version:
   ```bash
   git tag v0.1.0
   git push origin v0.1.0
   ```

2. Create release on GitHub

3. Upload build artifacts:
   - `PapilioLoader.exe`
   - `PapilioLoader-Setup-x.x.x.exe`
   - Source distributions (optional)

## CI/CD

For automated builds, see `.github/workflows/` (if configured).

Example GitHub Actions workflow:
```yaml
- name: Build Desktop App
  run: |
    pip install -e .[desktop]
    python build.py --no-installer
    
- name: Upload Artifact
  uses: actions/upload-artifact@v3
  with:
    name: PapilioLoader
    path: dist/PapilioLoader.exe
```

## See Also

- [DESKTOP_APP.md](DESKTOP_APP.md) - Usage instructions
- [ARCHITECTURE.md](ARCHITECTURE.md) - System architecture
- [README.md](../README.md) - Main documentation

## Release Checklist

1. Verify version numbers
  - Confirm the root and desktop package versions match the release
2. Merge to main
  - Merge `packaging` branch into `main`
3. Build artifacts on main
  - Run `./build.ps1` and confirm outputs in `dist/` and `installer_output/`
4. Compute SHA256 checksums
  - Use `Get-FileHash` or `CertUtil` for `PapilioLoader-Setup-*.exe`, `PapilioLoader.exe`, `pesptool.exe`, `esptool.exe`
5. Update release notes
  - Paste checksums into [RELEASE_NOTES.md](RELEASE_NOTES.md)
6. Tag and push
  - `git tag v0.1.0 && git push origin v0.1.0`
7. Publish GitHub release
  - Upload installer and executables; use [RELEASE_NOTES.md](RELEASE_NOTES.md) content
