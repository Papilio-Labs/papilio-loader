// flash-page.js — guided 4-step beginner flow (Flash ESP32 → WiFi → A2600 core → demo ROM).
// Ported from papilioworks.com/flash/flash.js onto @papilio-loader/flasher-core.
// UI copy/DOM structure intentionally unchanged — validated with real users.
import {
  SerialLineReader,
  flashEsp32,
  provisionBoardOverUsb,
  watchProvisioningLine,
  flashFpgaOverSerial,
  resumeAppOverSerial,
  SERIAL_FPGA_TARGET,
  flashFpgaOta,
  uploadRomOta,
  resumeEsp32Ota,
  requestGotoLoader,
  fetchDeviceStatusText,
  identifyDeviceText,
  recoverIntoLoader,
  createBrowserXhrPoster,
  detectBinaryImageType,
  seedBootSelectionInMergedImage,
  bootCompanionOverUsb,
} from "@papilio-loader/flasher-core";
import { makeLogger, setStatus } from "./dom.js";

export function initFlashPage(doc = document) {
  const els = {
    unsupportedBanner: doc.getElementById("unsupported-banner"),
    log: doc.getElementById("flash-log"),
    logWrap: doc.getElementById("flash-log-wrap"),
    btnOpenLog: doc.getElementById("btn-open-log"),
    btnCloseLog: doc.getElementById("btn-close-log"),

    esp32File: doc.getElementById("esp32-file"),
    esp32FileLabel: doc.getElementById("esp32-file-label"),
    esp32BundledVersion: doc.getElementById("esp32-bundled-version"),
    esp32Advanced: doc.getElementById("esp32-advanced"),
    btnConnect: doc.getElementById("btn-connect"),
    btnFlashEsp32: doc.getElementById("btn-flash-esp32"),
    progressEsp32: doc.getElementById("progress-esp32"),
    statusEsp32: doc.getElementById("status-esp32"),

    wifiSsid: doc.getElementById("wifi-ssid"),
    wifiPass: doc.getElementById("wifi-pass"),
    btnSendWifi: doc.getElementById("btn-send-wifi"),
    statusWifi: doc.getElementById("status-wifi"),
    deviceIp: doc.getElementById("device-ip"),
    deviceIpManual: doc.getElementById("device-ip-manual"),
    btnUseManualIp: doc.getElementById("btn-use-manual-ip"),
    btnFindIp: doc.getElementById("btn-find-ip"),

    fpgaFile: doc.getElementById("fpga-file"),
    fpgaFileLabel: doc.getElementById("fpga-file-label"),
    fpgaTarget: doc.getElementById("fpga-target"),
    btnFlashFpga: doc.getElementById("btn-flash-fpga"),
    progressFpga: doc.getElementById("progress-fpga"),
    statusFpga: doc.getElementById("status-fpga"),
    btnFlashA2600: doc.getElementById("btn-flash-a2600"),
    statusA2600: doc.getElementById("status-a2600"),
    btnLoadRom: doc.getElementById("btn-load-rom"),
    statusRom: doc.getElementById("status-rom"),
    progressRom: doc.getElementById("progress-rom"),
    transportPreference: doc.getElementById("transport-preference"),
  };

  if (els.fpgaTarget) els.fpgaTarget.value = "/fpga-update";

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const log = makeLogger(els.log);
  const otaPoster = createBrowserXhrPoster();
  let transportPreference = els.transportPreference?.value || "auto";

  els.btnOpenLog?.addEventListener("click", async () => {
    try {
      if (!serialPort) {
        serialPort = await navigator.serial.requestPort();
        reader = new SerialLineReader(serialPort);
        wireReaderEvents();
        log("Serial port selected for log monitoring.");
      }
      await startSerialListener();
      els.logWrap.open = true;
      setStatus(els.statusWifi, "USB log connection open.", "ok");
    } catch (err) {
      log(`Open log failed: ${err.message}`);
      setStatus(els.statusWifi, `Open log failed: ${err.message}`, "error");
    }
  });
  els.btnCloseLog?.addEventListener("click", async () => {
    try {
      await closeSerialSession();
      serialPort = null;
      reader = null;
      awaitingReconnect = false;
      setStatus(els.statusWifi, "USB log connection closed.");
      updateFlashEsp32Enabled();
      updateFlashFpgaEnabled();
    } catch (err) {
      log(`Close log failed: ${err.message}`);
      setStatus(els.statusWifi, `Close log failed: ${err.message}`, "error");
    }
  });
  els.transportPreference?.addEventListener("change", () => {
    transportPreference = els.transportPreference.value;
  });

  let serialPort = null;
  let reader = null;
  let esp32ImageType = null;
  let fpgaImageType = null;
  let deviceIp = null;
  let ipSeq = 0;
  let awaitingReconnect = false;
  // Bundled firmware manifest (same-origin firmware/manifest.json, written by
  // scripts/fetch-latest-firmware.mjs during the deploy build). Lets Step 1
  // flash the latest official release with no manual download — falls back
  // to the file picker below if the manifest can't be fetched.
  let bundledFirmware = null; // { version, fileName } once fetched
  let bundledA2600Core = null;
  let bundledA2600Rom = null;
  const assetVersion = typeof __LOADER_VERSION__ !== "undefined" ? __LOADER_VERSION__ : "dev";

  // Replace the static fallback links in Step 1 with the exact releases the
  // bundled recovery image was built from.
  function renderFirmwareSources(manifest) {
    const el = doc.getElementById("esp32-sources");
    const components = manifest.components;
    if (!el || !components) return;
    el.replaceChildren();
    el.append("Contains ");
    [components.bootloader, components.companion].filter(Boolean).forEach((c, i) => {
      if (i) el.append(" + ");
      const release = doc.createElement("a");
      release.href = c.releaseUrl;
      release.target = "_blank";
      release.rel = "noopener";
      release.textContent = `${c.name} ${c.release}`;
      const source = doc.createElement("a");
      source.href = c.repoUrl;
      source.target = "_blank";
      source.rel = "noopener";
      source.textContent = "source";
      el.append(release, " (", source, ")");
    });
    if (manifest.fileName) {
      const image = doc.createElement("a");
      image.href = `firmware/${encodeURIComponent(manifest.fileName)}?v=${encodeURIComponent(assetVersion)}`;
      image.target = "_blank";
      image.rel = "noopener";
      image.textContent = manifest.fileName;
      el.append(". Image: ", image, ".");
    }
  }

  if (!("serial" in navigator)) {
    els.unsupportedBanner.hidden = false;
    [els.btnConnect, els.btnFlashEsp32, els.btnSendWifi, els.btnFlashFpga, els.btnFlashA2600, els.btnLoadRom, els.btnFindIp, els.btnOpenLog, els.btnCloseLog].forEach(
      (btn) => (btn.disabled = true)
    );
    return;
  }

  if (els.esp32BundledVersion) {
    fetch(`firmware/manifest.json?v=${encodeURIComponent(assetVersion)}`)
      .then((resp) => {
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        return resp.json();
      })
      .then((manifest) => {
        bundledFirmware = manifest;
        bundledA2600Core = manifest.artifacts?.a2600Core || null;
        bundledA2600Rom = manifest.artifacts?.a2600Rom || null;
        els.esp32BundledVersion.textContent = manifest.version;
        renderFirmwareSources(manifest);
        updateFlashEsp32Enabled();
        updateA2600Enabled();
      })
      .catch((err) => {
        log(`Bundled firmware unavailable (${err.message}) — use "different firmware file" below.`);
        els.esp32BundledVersion.textContent = "unavailable";
        if (els.esp32Advanced) els.esp32Advanced.open = true;
        updateFlashEsp32Enabled();
        updateA2600Enabled();
      });
  }

  // A chip-level reset on native ESP32-S3 USB Serial/JTAG resets the USB
  // peripheral itself, so the OS briefly disconnects/reconnects the port.
  // Chrome creates a new SerialPort object for the reappeared device, so we
  // can't compare it against the stale reference — just take whatever port
  // reconnects (this app only ever talks to one board at a time).
  navigator.serial.addEventListener("connect", (event) => {
    if (!awaitingReconnect) return;
    awaitingReconnect = false;
    adoptPort(event.target);
    log("Board USB reconnected after reset, resuming serial listener…");
    startSerialListener().catch((err) => log(`Serial listener failed to resume: ${err.message}`));
  });

  function wireReaderEvents() {
    reader.onLine((line) => {
      log(line);
      watchProvisioningLine(line, {
        onIp: (ip) => setDeviceIp(ip),
        onStatus: (message, kind) => setStatus(els.statusWifi, message, kind),
      });
    });
    reader.onDisconnect(() => {
      log("Board USB is re-enumerating after reset — waiting to reconnect…");
      awaitingReconnect = true;
    });
  }

  async function startSerialListener() {
    if (!reader) return;
    if (reader.isRunning) return;
    await reader.start();
  }

  function adoptPort(port) {
    serialPort = port;
    reader = new SerialLineReader(port);
    wireReaderEvents();
  }

  // After a chip reset the board's native USB re-enumerates and Chrome hands
  // out a brand-new SerialPort object; the old reference can never be opened
  // again ("Failed to open serial port"). Previously granted ports for the
  // same device are listed by getPorts() without another user prompt, so
  // try each matching one until it opens.
  async function reacquireGrantedPort() {
    const prevInfo = serialPort?.getInfo?.() || {};
    const ports = await navigator.serial.getPorts();
    const candidates = ports.filter((port) => {
      if (port === serialPort) return false;
      const info = port.getInfo?.() || {};
      if (prevInfo.usbVendorId && info.usbVendorId !== prevInfo.usbVendorId) return false;
      if (prevInfo.usbProductId && info.usbProductId !== prevInfo.usbProductId) return false;
      return true;
    });
    for (const port of candidates) {
      const candidateReader = new SerialLineReader(port);
      try {
        await candidateReader.start();
      } catch {
        continue;
      }
      serialPort = port;
      reader = candidateReader;
      wireReaderEvents();
      log("Re-acquired the board's USB serial port after re-enumeration.");
      return true;
    }
    return false;
  }

  async function startSerialListenerWithRetry(maxAttempts = 3, delayMs = 750) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (reader?.isRunning) return;
      try {
        await startSerialListener();
        return;
      } catch (err) {
        if (await reacquireGrantedPort().catch(() => false)) return;
        if (attempt === maxAttempts) throw err;
        log(`USB serial port not ready (attempt ${attempt}/${maxAttempts}), retrying...`);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  async function closeSerialSession() {
    if (reader?.isRunning) await reader.stop();
    if (!serialPort?.close) return;
    for (let attempt = 0; attempt < 5; attempt++) {
      if (!serialPort.readable && !serialPort.writable) return;
      try {
        await serialPort.close();
        return;
      } catch {
        // Streams can stay locked briefly after cancel; retry before esptool opens the port.
        await sleep(200);
      }
    }
  }

  async function resumeAppAfterFpga(ip) {
    if (!(await returnToCompanion(ip))) {
      log(`FPGA-Companion did not come back${ip ? ` at ${ip}` : ""}.`);
    }
  }

  // FPGA-Companion can briefly answer on WiFi and then crash, so require it
  // to still be up a few seconds later.
  async function companionIsStable(ip) {
    if ((await probeRole(ip, 2000)) !== "app") return false;
    await sleep(6000);
    return (await probeRole(ip, 2000)) === "app";
  }

  async function bootCompanionViaUsb() {
    await closeSerialSession();
    const previousPort = serialPort;
    awaitingReconnect = true;
    await bootCompanionOverUsb(serialPort, { onLog: log });
    await waitForUsbPort(previousPort);
    await startSerialListenerWithRetry();
  }

  // Bring the board back to FPGA-Companion. Over USB (when connected) this
  // selects ota_0 and does a full watchdog reset — the bootloader's own
  // /resume uses a CPU-only restart that FPGA-Companion v2.0.0 can crash on
  // right after an FPGA write, which rollback turns into a return to the
  // loader. Without USB, fall back to repeated POST /resume over WiFi.
  async function returnToCompanion(ip, timeoutMs = 60000) {
    if (ip && (await companionIsStable(ip))) {
      log(`FPGA-Companion is running at ${ip}.`);
      return true;
    }

    if (serialPort) {
      log("Restarting into FPGA-Companion over USB…");
      await bootCompanionViaUsb();
      if (!ip) return true;
      const started = Date.now();
      while (Date.now() - started < timeoutMs) {
        if (await companionIsStable(ip)) {
          log(`FPGA-Companion is running at ${ip}.`);
          return true;
        }
        await sleep(1000);
      }
      return false;
    }

    if (!ip) return false;
    const started = Date.now();
    let lastResume = 0;
    while (Date.now() - started < timeoutMs) {
      const role = await probeRole(ip, 2000);
      if (role === "app" && (await companionIsStable(ip))) {
        log(`FPGA-Companion is running at ${ip}.`);
        return true;
      }
      if (role === "loader" && Date.now() - lastResume > 5000) {
        lastResume = Date.now();
        try {
          log(await resumeEsp32Ota(ip));
        } catch (err) {
          if (/no valid app image/i.test(err.message)) {
            throw new Error(
              "the bootloader does not know which slot holds FPGA-Companion. Enter your WiFi details and click Send to Board in Step 2 (with USB connected) to fix the boot selection, then retry."
            );
          }
          log(`Resume request: ${err.message}; checking again…`);
        }
      }
      await sleep(1000);
    }
    return false;
  }

  async function probeRole(ip, timeoutMs = 2000) {
    try {
      return identifyDeviceText(await fetchDeviceStatusText(ip, undefined, timeoutMs)).role;
    } catch {
      return null;
    }
  }

  async function waitForRoleOverWifi(ip, role, timeoutMs = 20000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if ((await probeRole(ip)) === role) return true;
      await sleep(500);
    }
    return false;
  }

  async function waitForUsbPort(previousPort, timeoutMs = 15000) {
    const started = Date.now();
    await sleep(500);
    while (Date.now() - started < timeoutMs) {
      if (serialPort && serialPort !== previousPort && !awaitingReconnect) return;
      if (await reacquireGrantedPort().catch(() => false)) {
        awaitingReconnect = false;
        return;
      }
      if (previousPort?.connected !== false) {
        try {
          await startSerialListener();
          awaitingReconnect = false;
          return;
        } catch {
          // Port is still re-enumerating.
        }
      }
      await sleep(500);
    }
    throw new Error("Timed out waiting for the board's USB port to come back.");
  }

  // FPGA-Companion v2+ no longer serves the flashing endpoints — only the
  // Papilio ESP Bootloader (factory partition) does. Hand off to the loader
  // first: over WiFi via the app's POST /goto-loader, otherwise over USB by
  // blanking otadata. Returns the IP to use for OTA, or null for USB serial.
  async function enterLoader(statusEl, preference = "auto") {
    if (preference !== "usb" && deviceIp) {
      const role = await probeRole(deviceIp, 3000);
      if (role === "loader") return deviceIp;
      try {
        setStatus(statusEl, "Switching the board to the Papilio ESP Bootloader over WiFi…");
        try {
          log(`goto-loader → HTTP ${await requestGotoLoader(deviceIp)}`);
        } catch (err) {
          // The app may reboot before its reply arrives.
          log(`goto-loader reply not received (${err.message}); waiting for the bootloader anyway.`);
        }
        if (await waitForRoleOverWifi(deviceIp, "loader")) {
          log(`Bootloader ready at ${deviceIp}.`);
          return deviceIp;
        }
        throw new Error("the bootloader did not come back over WiFi");
      } catch (err) {
        if (preference === "ota" || !serialPort) {
          throw new Error(`Could not switch to the bootloader over WiFi (${err.message}).`);
        }
        log(`WiFi handoff failed (${err.message}); falling back to USB.`);
      }
    }

    if (preference === "ota") throw new Error("OTA / WiFi was selected, but the device IP is not available.");
    if (!serialPort) throw new Error("Connect USB (Step 1) or set the board IP (Step 2) first.");

    setStatus(statusEl, "Switching the board to the Papilio ESP Bootloader over USB…");
    await closeSerialSession();
    const previousPort = serialPort;
    awaitingReconnect = true;
    await recoverIntoLoader(serialPort, { onLog: log });
    await waitForUsbPort(previousPort);
    await startSerialListenerWithRetry();
    if (deviceIp && preference !== "usb" && (await waitForRoleOverWifi(deviceIp, "loader", 10000))) {
      return deviceIp;
    }
    return null;
  }

  async function waitForNewIp(seqBefore, timeoutMs) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (ipSeq !== seqBefore) return true;
      await sleep(250);
    }
    return false;
  }

  function setDeviceIp(ip) {
    deviceIp = ip;
    ipSeq += 1;
    els.deviceIp.textContent = ip;
    setStatus(els.statusWifi, `Board connected — IP ${ip}`, "ok");
    updateFlashFpgaEnabled();
    updateA2600Enabled();
  }

  /* -------------------------------------------------------------------- */
  /* File pickers                                                          */
  /* -------------------------------------------------------------------- */

  els.esp32File.addEventListener("change", async () => {
    const file = els.esp32File.files[0];
    els.esp32FileLabel.textContent = file ? file.name : "Choose *-merged.bin…";
    esp32ImageType = file ? detectBinaryImageType(new Uint8Array(await file.arrayBuffer())) : null;
    if (file && esp32ImageType !== "esp32") setStatus(els.statusEsp32, "Selected file is not ESP32 firmware.", "error");
    updateFlashEsp32Enabled();
  });

  els.fpgaFile.addEventListener("change", async () => {
    const file = els.fpgaFile.files[0];
    els.fpgaFileLabel.textContent = file ? file.name : "Choose bitstream .bin…";
    fpgaImageType = file ? detectBinaryImageType(new Uint8Array(await file.arrayBuffer())) : null;
    if (file && fpgaImageType !== "fpga") setStatus(els.statusFpga, "Selected file is not a Gowin FPGA bitstream.", "error");
    updateFlashFpgaEnabled();
  });

  els.fpgaTarget.addEventListener("change", updateFlashFpgaEnabled);

  function updateFlashEsp32Enabled() {
    const hasFirmware = Boolean(bundledFirmware) || (Boolean(els.esp32File.files[0]) && esp32ImageType === "esp32");
    els.btnFlashEsp32.disabled = !(serialPort && hasFirmware);
  }

  function updateFlashFpgaEnabled() {
    const isRecovery = els.fpgaTarget.value === "/fpga-recover";
    const hasTransport = Boolean(deviceIp || serialPort);
    const hasFile = isRecovery ? Boolean(deviceIp) : Boolean(els.fpgaFile.files[0]) && fpgaImageType === "fpga";
    els.btnFlashFpga.disabled = !(hasTransport && hasFile);
  }

  function updateA2600Enabled() {
    const hasTransport = Boolean(deviceIp || serialPort);
    if (els.btnFlashA2600) els.btnFlashA2600.disabled = !(hasTransport && bundledA2600Core);
    if (els.btnLoadRom) els.btnLoadRom.disabled = !(deviceIp && bundledA2600Rom);
  }

  // The firmware streams the uploaded bytes verbatim to flash or JTAG SRAM —
  // it never strips Gowin's ASCII comment header, so only headerless .bin
  // ("Binary File" export) works.
  function validateFpgaFileTarget(file, target) {
    if (!file || target === "/fpga-recover") return null;
    if (!/\.bin$/i.test(file.name)) {
      return "Only .bin (Gowin \"Binary File\") bitstreams are supported right now — .fs files are not yet parsed by the firmware.";
    }
    return null;
  }

  /* -------------------------------------------------------------------- */
  /* Step 1 — Connect + flash ESP32 firmware                                */
  /* -------------------------------------------------------------------- */

  els.btnConnect.addEventListener("click", async () => {
    try {
      serialPort = await navigator.serial.requestPort();
      reader = new SerialLineReader(serialPort);
      wireReaderEvents();
      log("Serial port selected.");
      setStatus(
        els.statusEsp32,
        bundledFirmware ? "USB connected. Ready to flash." : "USB connected. Choose a firmware file, then flash.",
        "ok"
      );
      updateFlashEsp32Enabled();
    } catch (err) {
      log(`Connect failed: ${err.message}`);
      setStatus(els.statusEsp32, `Connect failed: ${err.message}`, "error");
    }
  });

  els.btnFlashEsp32.addEventListener("click", async () => {
    const customFile = els.esp32File.files[0];
    if (!serialPort || !(customFile || bundledFirmware)) return;

    els.btnFlashEsp32.disabled = true;
    els.btnConnect.disabled = true;
    els.progressEsp32.hidden = false;
    setStatus(els.statusEsp32, customFile ? "Connecting to ESP32…" : `Downloading bundled firmware ${bundledFirmware.version}…`);

    try {
      let data;
      if (customFile) {
        data = new Uint8Array(await customFile.arrayBuffer());
        if (detectBinaryImageType(data) !== "esp32") {
          setStatus(els.statusEsp32, "Selected file is not ESP32 firmware.", "error");
          return;
        }
      } else {
        const resp = await fetch(
          `firmware/${bundledFirmware.fileName}?v=${encodeURIComponent(assetVersion)}`
        );
        if (!resp.ok) throw new Error(`Firmware download failed (HTTP ${resp.status})`);
        data = new Uint8Array(await resp.arrayBuffer());
        setStatus(els.statusEsp32, "Connecting to ESP32…");
      }
      // esptool-js must own the Web Serial port exclusively while flashing.
      // A log reader left open here causes the browser's "port is already open"
      // error before esptool can enter the ROM bootloader.
      const seeded = seedBootSelectionInMergedImage(data);
      if (seeded) {
        data = seeded;
        log("Seeded otadata (boot FPGA-Companion in ota_0) and loader last_slot=0 into the image.");
      }
      await closeSerialSession();
      await flashEsp32(serialPort, data, {
        onLog: log,
        onProgress: (written, total) => {
          const pct = Math.round((written / total) * 100);
          els.progressEsp32.querySelector(".progress-bar").style.width = `${pct}%`;
        },
      });

      await closeSerialSession();
      // The watchdog reset re-enumerates USB; let the connect listener pick up
      // the new port object (Send to Board also re-acquires it if needed).
      awaitingReconnect = true;
      log("ESP32 write complete; USB serial port closed.");
      setStatus(els.statusEsp32, "ESP32 flashed.", "ok");
      els.btnSendWifi.disabled = false;
      setStatus(els.statusWifi, "Board rebooting automatically. USB serial port closed.");
    } catch (err) {
      log(`Flash failed: ${err.message}`);
      setStatus(els.statusEsp32, `Flash failed: ${err.message}`, "error");
      els.btnConnect.disabled = false;
      updateFlashEsp32Enabled();
    }
  });

  /* -------------------------------------------------------------------- */
  /* Step 2 — Send WiFi credentials over serial                             */
  /* -------------------------------------------------------------------- */

  els.btnSendWifi.addEventListener("click", async () => {
    const ssid = els.wifiSsid.value.trim();
    const pass = els.wifiPass.value;
    if (!ssid) {
      setStatus(els.statusWifi, "Enter a WiFi network name first.", "error");
      return;
    }
    if (new TextEncoder().encode(ssid).length > 32 || new TextEncoder().encode(pass).length > 63) {
      setStatus(els.statusWifi, "WiFi name must be at most 32 bytes and password at most 63.", "error");
      return;
    }

    els.btnSendWifi.disabled = true;
    try {
      // Neither firmware listens for serial WiFi commands, so write the
      // settings (and the boot selection for FPGA-Companion) into flash.
      if (!serialPort) throw new Error("No USB port selected.");
      // A port from before the Step 1 reset can't be reopened; swap in the re-enumerated one.
      if (!reader?.isRunning) await startSerialListenerWithRetry(10, 750);
      await closeSerialSession();
      const previousPort = serialPort;
      const ipSeqBefore = ipSeq;
      setStatus(els.statusWifi, "Writing WiFi settings to the board…");
      await provisionBoardOverUsb(serialPort, { ssid, password: pass, onLog: log });
      awaitingReconnect = true;
      setStatus(els.statusWifi, "Settings saved. Board is restarting into FPGA-Companion and joining WiFi…");
      await waitForUsbPort(previousPort);
      await startSerialListenerWithRetry();
      if (!(await waitForNewIp(ipSeqBefore, 30000))) {
        setStatus(
          els.statusWifi,
          "Settings saved, but the board hasn't reported an IP yet. Check the WiFi name/password (2.4 GHz only), or click Find My IP.",
          "error"
        );
      }
    } catch (err) {
      log(`Send WiFi credentials failed: ${err.message}`);
      setStatus(
        els.statusWifi,
        `Send failed: ${err.message} Unplug and replug the board's USB cable, click Find My IP to pick its port again, then click Send to Board.`,
        "error"
      );
    } finally {
      els.btnSendWifi.disabled = false;
    }
  });

  els.btnUseManualIp.addEventListener("click", () => {
    const ip = els.deviceIpManual.value.trim();
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
      setStatus(els.statusWifi, "Enter a valid IP address (e.g. 192.168.1.42).", "error");
      return;
    }
    setDeviceIp(ip);
    setStatus(els.statusWifi, `Using manually entered IP ${ip}.`, "ok");
    updateA2600Enabled();
  });

  // Two clicks, not one: the port picker only lists devices the OS has
  // already enumerated. The first click tells the user to plug in/power the
  // board; the second (a fresh user gesture, required for requestPort())
  // opens the picker.
  let findIpArmed = false;

  els.btnFindIp.addEventListener("click", async () => {
    if (!findIpArmed) {
      findIpArmed = true;
      els.btnFindIp.textContent = "Now click again to select the port…";
      setStatus(els.statusWifi, "Plug your board into USB now (or press RESET if it's already plugged in), then click the button again.");
      return;
    }

    try {
      const picked = await navigator.serial.requestPort();
      await closeSerialSession();
      adoptPort(picked);
      log("Serial port selected.");
      await startSerialListener();
      els.btnSendWifi.disabled = false;
      setStatus(els.statusWifi, "Listening on USB — press the RESET button on your board to see its IP.");
      updateA2600Enabled();
    } catch (err) {
      log(`Find IP failed: ${err.message}`);
      setStatus(els.statusWifi, `Find IP failed: ${err.message}`, "error");
    } finally {
      findIpArmed = false;
      els.btnFindIp.textContent = "Find My IP";
    }
  });

  /* -------------------------------------------------------------------- */
  /* Step 3 — Flash FPGA bitstream: WiFi OTA first, USB serial fallback      */
  /* -------------------------------------------------------------------- */

  function updateFpgaProgress(loaded, total) {
    const pct = total ? Math.round((loaded / total) * 100) : 0;
    els.progressFpga.querySelector(".progress-bar").style.width = `${pct}%`;
  }

  function updateRomProgress(loaded, total) {
    const bar = (els.progressRom || els.progressFpga).querySelector(".progress-bar");
    bar.style.width = `${total ? Math.round((loaded / total) * 100) : 0}%`;
  }

  els.btnFlashFpga.addEventListener("click", async () => {
    const target = els.fpgaTarget.value;
    const file = els.fpgaFile.files[0];
    const isRecovery = target === "/fpga-recover";
    if (!isRecovery && !file) return;

    const mismatchError = validateFpgaFileTarget(file, target);
    if (mismatchError) {
      setStatus(els.statusFpga, mismatchError, "error");
      return;
    }
    if (isRecovery && !deviceIp) {
      setStatus(els.statusFpga, "Recovery requires a known device IP — use Find My IP or send WiFi credentials first.", "error");
      return;
    }

    els.btnFlashFpga.disabled = true;
    els.progressFpga.hidden = false;
    updateFpgaProgress(0, 1);
    setStatus(els.statusFpga, "Uploading to board…");

    try {
      const body = isRecovery ? new ArrayBuffer(0) : await file.arrayBuffer();
      if (!isRecovery && detectBinaryImageType(new Uint8Array(body)) !== "fpga") {
        setStatus(els.statusFpga, "Selected file is not a Gowin FPGA bitstream.", "error");
        return;
      }
      setStatus(els.statusFpga, "Preparing the board…");
      const ip = await enterLoader(els.statusFpga, transportPreference);
      let usedPath;
      if (ip) {
        setStatus(els.statusFpga, "Uploading to board over WiFi…");
        log(await flashFpgaOta(otaPoster, ip, target, body, updateFpgaProgress));
        await resumeAppAfterFpga(ip);
        usedPath = "network";
      } else {
        if (isRecovery) throw new Error("Recovery requires a working network/IP path — no USB serial equivalent yet.");
        const serialTarget = SERIAL_FPGA_TARGET[target];
        if (!serialTarget) throw new Error("This target has no USB serial equivalent yet — use WiFi OTA.");
        setStatus(els.statusFpga, "Flashing over USB serial (slower than WiFi)…");
        await flashFpgaOverSerial(serialPort, reader, serialTarget, new Uint8Array(body), updateFpgaProgress);
        await resumeAppAfterFpga();
        log("FPGA write complete; user app resume requested.");
        usedPath = "serial";
      }
      setStatus(
        els.statusFpga,
        usedPath === "network" ? "FPGA programmed successfully via network." : "FPGA programmed successfully via USB serial.",
        "ok"
      );
    } catch (err) {
      log(`FPGA flash failed: ${err.message}`);
      setStatus(els.statusFpga, `Flash failed: ${err.message}`, "error");
    } finally {
      els.btnFlashFpga.disabled = false;
    }
  });

  async function fetchBundledArtifact(artifact) {
    const response = await fetch(`firmware/${artifact.fileName}?v=${encodeURIComponent(assetVersion)}`);
    if (!response.ok) throw new Error(`Download failed (HTTP ${response.status})`);
    return new Uint8Array(await response.arrayBuffer());
  }

  async function flashBundledA2600() {
    els.btnFlashA2600.disabled = true;
    els.progressFpga.hidden = false;
    updateFpgaProgress(0, 1);
    setStatus(els.statusA2600, `Downloading A2600 core ${bundledA2600Core.release}…`);
    try {
      const data = await fetchBundledArtifact(bundledA2600Core);
      if (detectBinaryImageType(data) !== "fpga") throw new Error("The bundled A2600 file is not a Gowin FPGA bitstream.");
      const ip = await enterLoader(els.statusA2600);
      setStatus(els.statusA2600, `Writing A2600 core ${bundledA2600Core.release}…`);
      if (ip) {
        log(await flashFpgaOta(otaPoster, ip, "/fpga-update", data.buffer, updateFpgaProgress));
      } else {
        await flashFpgaOverSerial(serialPort, reader, SERIAL_FPGA_TARGET["/fpga-update"], data, updateFpgaProgress);
      }
      setStatus(els.statusA2600, "Core written — restarting FPGA-Companion…");
      if (!(await returnToCompanion(ip))) {
        throw new Error(`the core was written, but the board did not return to FPGA-Companion${ip ? ` at ${ip}` : ""}. Step 4 will retry the switch.`);
      }
      setStatus(els.statusA2600, `A2600 core programmed successfully via ${ip ? "WiFi" : "USB"}.`, "ok");
    } catch (err) {
      log(`A2600 core flash failed: ${err.message}`);
      setStatus(els.statusA2600, `A2600 core flash failed: ${err.message}`, "error");
    } finally {
      updateA2600Enabled();
    }
  }

  async function loadBundledRom() {
    els.btnLoadRom.disabled = true;
    if (els.progressRom) els.progressRom.hidden = false;
    setStatus(els.statusRom, "Downloading the Papilio Splash demo ROM…");
    try {
      const data = await fetchBundledArtifact(bundledA2600Rom);
      // /rom-load lives in FPGA-Companion, not the bootloader — always make
      // sure the board is back in the user app first.
      setStatus(els.statusRom, "Making sure the board is running FPGA-Companion…");
      if (!(await returnToCompanion(deviceIp))) {
        throw new Error(`FPGA-Companion did not answer at ${deviceIp}. Check the board is on WiFi, then retry.`);
      }
      setStatus(els.statusRom, "Uploading the Papilio Splash demo ROM…");
      const responseText = await uploadRomOta(otaPoster, deviceIp, bundledA2600Rom.fileName, data.buffer, updateRomProgress);
      log(responseText);
      setStatus(els.statusRom, "Papilio Splash ROM uploaded and inserted. A FAT-formatted SD card is required.", "ok");
    } catch (err) {
      log(`ROM upload failed: ${err.message}`);
      const hint = /HTTP 5\d\d|f_open|SD/i.test(err.message) ? " Make sure a FAT-formatted microSD card is inserted in the board." : "";
      setStatus(els.statusRom, `ROM upload failed: ${err.message}.${hint}`, "error");
    } finally {
      updateA2600Enabled();
    }
  }

  els.btnFlashA2600?.addEventListener("click", flashBundledA2600);
  els.btnLoadRom?.addEventListener("click", loadBundledRom);
}
