// index.ts — Electron main process entry point. Creates the app window
// (loading the same loader-ui bundle apps/web ships), wires up the
// select-serial-port handler Electron requires for WebSerial to work at all
// (Chrome's native device-chooser UI doesn't exist in Electron), a tray icon
// that keeps the app (and its MCP server) running after the window is
// closed, and IPC bridges for the desktop-only capabilities (LAN discovery,
// UDP WiFi log, saved files, GitHub release fetch with no CORS).
import { app, BrowserWindow, Tray, Menu, ipcMain, session, nativeImage, shell } from "electron";
import type { Session } from "electron";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { discoverOtaDevices, checkDeviceIp } from "./lan-discovery.js";
import { wifiLogManager } from "./wifi-log.js";
import { SavedFilesStore } from "./saved-files.js";
import { startHttpMcpServer, type HttpMcpServerHandle } from "./mcp-server.js";

// Fixed local port for the always-on MCP server the tray keeps alive (see
// startHttpMcpServer). Distinct from the board's own OTA port (3232).
const MCP_HTTP_PORT = 3939;

// The Retrocade board's native ESP32-S3 USB Serial/JTAG VID/PID — auto-select
// it without prompting when it's the only Papilio device plugged in. See the
// papilio-retrocade-usb-reset skill / repo memory for background.
const RETROCADE_VID = "303a";
const RETROCADE_PID = "1001";

const GITHUB_RELEASE_API = "https://api.github.com/repos/Papilio-Retrocade/FPGA-Companion/releases/latest";

// apps/web's HTML is copied verbatim from papilioworks.com, so its nav bar
// still links to site pages ("../#features", "../docs/", the home logo, etc.)
// that don't exist in this standalone bundle. Redirect any file:// navigation
// that doesn't resolve to a real file inside apps/web to the live site in the
// user's default browser instead of letting Electron fail with ERR_FILE_NOT_FOUND.
// electron-builder can't package files from outside apps/desktop via `files`
// (see electron-builder.yml's `extraResources`), so apps/web ends up under
// resourcesPath/web when packaged instead of alongside dist/ like in dev.
const WEB_ROOT = app.isPackaged ? path.join(process.resourcesPath, "web") : path.join(__dirname, "../../../web");

// build/tray.png is only used by electron-builder to fill electron-builder.yml's
// icon fields at pack time — it isn't bundled into dist/ automatically, so it's
// shipped via extraResources (see electron-builder.yml) and read back here.
const TRAY_ICON_PATH = app.isPackaged
  ? path.join(process.resourcesPath, "icons/tray.png")
  : path.join(__dirname, "../../build/tray.png");

function resolveExternalUrl(targetUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(targetUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== "file:") return `${parsed}`;

  const targetPath = fileURLToPath(parsed);
  const rel = path.relative(WEB_ROOT, targetPath);
  const insideWebRoot = rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  const isRealFile = fs.existsSync(targetPath) && fs.statSync(targetPath).isFile();
  if (insideWebRoot && isRealFile) return null;

  const relSlash = insideWebRoot ? rel.split(path.sep).join("/") : "";
  return `https://papilioworks.com/${relSlash}${parsed.hash}`;
}

let mainWindow: BrowserWindow | null = null;
let wifiLogWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;
let mcpServerHandle: HttpMcpServerHandle | null = null;
const savedFiles = new SavedFilesStore(app.getPath("userData"));

function showMainWindow(): void {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
  } else {
    createWindow();
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 900,
    title: "Papilio Loader",
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // apps/web must be built first (npm run build --workspace=apps/web) — the
  // desktop app reuses its exact HTML/CSS/JS output rather than duplicating it.
  mainWindow.loadFile(path.join(WEB_ROOT, "loader/index.html"));

  mainWindow.webContents.on("will-navigate", (event, targetUrl) => {
    const external = resolveExternalUrl(targetUrl);
    if (external) {
      event.preventDefault();
      void shell.openExternal(external);
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  // Closing the window shouldn't kill the MCP server the tray is meant to
  // keep running — hide it instead, unless we're actually quitting the app.
  mainWindow.on("close", (event) => {
    if (isQuitting) return;
    event.preventDefault();
    mainWindow?.hide();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

async function showWifiLogWindow(): Promise<void> {
  if (wifiLogWindow) {
    wifiLogWindow.show();
    wifiLogWindow.focus();
    return;
  }
  const window = new BrowserWindow({
    width: 1000,
    height: 680,
    title: "Papilio Loader - WiFi Log",
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  wifiLogWindow = window;
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.on("closed", () => { wifiLogWindow = null; });
  try {
    await window.loadFile(path.join(WEB_ROOT, "wifi-log/index.html"));
  } catch (err) {
    window.destroy();
    throw err;
  }
}

// --- WebSerial support: Electron has no built-in device chooser -----------
function wireSerialPortSelection(sess: Session): void {
  const grantedPorts = new Set<string>();

  sess.on("select-serial-port", (event, portList, _webContents, callback) => {
    event.preventDefault();

    const retrocade = portList.find(
      (p) => p.vendorId?.toLowerCase() === RETROCADE_VID && p.productId?.toLowerCase() === RETROCADE_PID
    );
    if (retrocade) {
      callback(retrocade.portId);
      return;
    }

    if (portList.length === 1) {
      callback(portList[0].portId);
      return;
    }

    if (portList.length === 0) {
      callback("");
      return;
    }

    // Multiple ambiguous candidates and no VID/PID match — ask the renderer
    // to show a picker (it already renders a "Connect USB" flow) rather than
    // guessing. Fall back to the first port if the renderer doesn't answer.
    mainWindow?.webContents
      .executeJavaScript(
        `window.papilioDesktop?.__pickSerialPort?.(${JSON.stringify(
          portList.map((p) => ({ portId: p.portId, displayName: p.displayName }))
        )})`
      )
      .then((chosenId: string | undefined) => callback(chosenId || portList[0].portId))
      .catch(() => callback(portList[0].portId));
  });

  sess.setPermissionCheckHandler((_wc, permission) => permission === "serial");
  sess.setDevicePermissionHandler((details) => details.deviceType === "serial");

  // Suppresses unused-var lint noise while documenting that we intentionally
  // don't persist per-device grants beyond the process lifetime — every
  // launch re-selects, matching the desktop app's "always ask" trust model.
  void grantedPorts;
}

function wireIpc(): void {
  ipcMain.handle("papilio:discover-lan", async () => {
    return discoverOtaDevices();
  });

  ipcMain.handle("papilio:check-device-ip", async (_event, ip: string) => {
    return checkDeviceIp(ip);
  });

  ipcMain.handle("papilio:fetch-latest-release", async (_event, method: "usb" | "ota" = "usb") => {
    const resp = await fetch(GITHUB_RELEASE_API);
    if (!resp.ok) throw new Error(`GitHub API HTTP ${resp.status}`);
    const release = (await resp.json()) as { tag_name: string; assets: Array<{ name: string; browser_download_url: string }> };
    // The -merged.bin (bootloader + partition table + app at 0x0) is only
    // valid for USB/Serial esptool flashing at offset 0x0. OTA writes
    // straight into an app partition, so it needs the app-only image —
    // sending the merged one makes the device try to validate the leading
    // bootloader bytes as the app image and fail with a nonsensical
    // "efuse blk rev" mismatch.
    const asset = method === "ota"
      ? release.assets.find((a) => /\.bin$/i.test(a.name) && !/-merged\.bin$/i.test(a.name) && !/^(bootloader|partition-table|ota_data_initial)\.bin$/i.test(a.name))
      : release.assets.find((a) => /-merged\.bin$/i.test(a.name));
    if (!asset) throw new Error(`No matching .bin asset found in the latest release for ${method} flashing.`);
    const assetResp = await fetch(asset.browser_download_url);
    if (!assetResp.ok) throw new Error(`Asset download HTTP ${assetResp.status}`);
    const data = Buffer.from(await assetResp.arrayBuffer());
    return { name: `${asset.name} (${release.tag_name})`, data };
  });

  ipcMain.handle("papilio:saved-files-list", async (_event, deviceType?: string) => savedFiles.list(deviceType));
  ipcMain.handle("papilio:saved-files-add", async (_event, originalFilename: string, deviceType: string, description: string, data: Uint8Array) =>
    savedFiles.add(originalFilename, deviceType, description, Buffer.from(data))
  );
  ipcMain.handle("papilio:saved-files-read", async (_event, id: string) => savedFiles.readFile(id));
  ipcMain.handle("papilio:saved-files-delete", async (_event, id: string) => savedFiles.delete(id));
  ipcMain.handle("papilio:saved-files-rename", async (_event, id: string, name: string) => savedFiles.rename(id, name));
  ipcMain.handle("papilio:saved-files-describe", async (_event, id: string, description: string) =>
    savedFiles.updateDescription(id, description)
  );
  ipcMain.handle("papilio:saved-files-export-zip", async () => savedFiles.exportZip());
  ipcMain.handle("papilio:saved-files-import-zip", async (_event, data: Uint8Array) => savedFiles.importZip(Buffer.from(data)));

  ipcMain.handle("papilio:wifi-log-open-window", showWifiLogWindow);
  const wifiSubscriptions = new Map<number, () => void>();
  ipcMain.handle("papilio:wifi-log-subscribe", (event) => {
    const webContents = event.sender;
    wifiSubscriptions.get(webContents.id)?.();
    const unsubscribe = wifiLogManager.subscribe((line) => {
      if (!webContents.isDestroyed()) webContents.send("papilio:wifi-log-line", line);
    }, (status) => {
      if (!webContents.isDestroyed()) webContents.send("papilio:wifi-log-status", status);
    });
    const cleanup = () => {
      unsubscribe();
      wifiSubscriptions.delete(webContents.id);
      webContents.removeListener("destroyed", cleanup);
    };
    wifiSubscriptions.set(webContents.id, cleanup);
    webContents.once("destroyed", cleanup);
    return true;
  });
  ipcMain.handle("papilio:wifi-log-unsubscribe", (event) => {
    wifiSubscriptions.get(event.sender.id)?.();
  });
}

function createTray(): void {
  // build/tray.png is a generated placeholder "brand dot" (see
  // scripts/generate-placeholder-icons.mjs) — swap in a real Papilio logo
  // asset and re-run that script once one exists.
  const icon = nativeImage.createFromPath(TRAY_ICON_PATH);
  tray = new Tray(icon);
  tray.setToolTip(`Papilio Loader — MCP server on http://127.0.0.1:${MCP_HTTP_PORT}/mcp`);
  tray.on("click", showMainWindow);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Show Papilio Loader", click: showMainWindow },
      { type: "separator" },
      { label: "Quit", click: () => app.quit() },
    ])
  );
}

app.whenReady().then(async () => {
  wireSerialPortSelection(session.defaultSession);
  wireIpc();
  createWindow();
  createTray();

  try {
    mcpServerHandle = await startHttpMcpServer(MCP_HTTP_PORT, app.getPath("appData"));
  } catch (err) {
    console.error(`MCP HTTP server failed to start on port ${MCP_HTTP_PORT}:`, err);
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else showMainWindow();
  });
});

// The app (and its MCP server) is meant to keep living in the tray after the
// window closes — only the tray's Quit item or an explicit app.quit() ends it.
app.on("window-all-closed", () => {
  // no-op: intentionally does not quit the app.
});

app.on("before-quit", () => {
  isQuitting = true;
  void mcpServerHandle?.close();
});
