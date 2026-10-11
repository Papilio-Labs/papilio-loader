// fetch-latest-firmware.mjs — downloads the latest Papilio ESP Bootloader
// recovery image and writes it (plus a small manifest) into
// apps/web/board-recovery/firmware/ so the Board Recovery page can flash it
// with no manual download step.
//
// This must run server-side (CI or a local dev machine) — GitHub only sends
// CORS headers on the release-metadata API, not on the binary asset itself,
// so the browser can never fetch it directly. Runs before `esbuild` builds
// apps/web; the firmware/ directory it writes to is gitignored and is not
// meant to be committed to this repo — only to the deployed static site.

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const RELEASES_API = "https://api.github.com/repos/Papilio-Labs/papilio-esp-bootloader/releases/latest";
const COMPANION_RELEASES_API = "https://api.github.com/repos/Papilio-Retrocade/FPGA-Companion/releases/latest";
const A2600_RELEASES_API = "https://api.github.com/repos/Papilio-Retrocade/A2600Nano/releases/latest";
const RECOVERY_ASSET_SUFFIX = "-recovery.bin";
const MIGRATION_ASSET_SUFFIX = "-merged.bin";
const A2600_CORE_NAME = "a2600nano_retrocade.bin";
const A2600_ROM_NAME = "a2600crt.bin";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(scriptDir, "..", "apps", "web", "board-recovery", "firmware");

async function main() {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "papilio-loader-mcp-fetch-latest-firmware",
  };
  console.log(`Fetching latest release metadata from ${RELEASES_API}, ${COMPANION_RELEASES_API}, and ${A2600_RELEASES_API}...`);
  const releaseResp = await fetch(RELEASES_API, { headers });
  if (!releaseResp.ok) {
    throw new Error(`GitHub releases API returned HTTP ${releaseResp.status}`);
  }
  const release = await releaseResp.json();
  const companionResp = await fetch(COMPANION_RELEASES_API, { headers });
  if (!companionResp.ok) {
    throw new Error(`FPGA-Companion release API returned HTTP ${companionResp.status}`);
  }
  const companionRelease = await companionResp.json();
  const a2600Resp = await fetch(A2600_RELEASES_API, { headers });
  if (!a2600Resp.ok) {
    throw new Error(`A2600 release API returned HTTP ${a2600Resp.status}`);
  }
  const a2600Release = await a2600Resp.json();

  const migrationAsset = (companionRelease.assets || []).find((a) => a.name.endsWith(MIGRATION_ASSET_SUFFIX));
  const recoveryAsset = migrationAsset || (release.assets || []).find((a) => a.name.endsWith(RECOVERY_ASSET_SUFFIX));
  const recoveryRelease = migrationAsset ? companionRelease : release;
  if (!recoveryAsset) {
    throw new Error(
      `No FPGA-Companion migration asset or Papilio ESP Bootloader recovery asset found`,
    );
  }
  const coreAsset = (a2600Release.assets || []).find((a) => a.name === A2600_CORE_NAME);
  const romAsset = (a2600Release.assets || []).find((a) => a.name === A2600_ROM_NAME);
  if (!coreAsset || !romAsset) {
    throw new Error(`A2600 release ${a2600Release.tag_name} must contain ${A2600_CORE_NAME} and ${A2600_ROM_NAME}`);
  }

  async function downloadAsset(asset, label) {
    console.log(`Downloading ${asset.name} (${asset.size} bytes) from ${label}...`);
    const assetResp = await fetch(asset.browser_download_url);
    if (!assetResp.ok) {
      throw new Error(`Asset download returned HTTP ${assetResp.status} for ${asset.name}`);
    }
    const bytes = new Uint8Array(await assetResp.arrayBuffer());
    return {
      fileName: asset.name,
      size: bytes.length,
      sourceUrl: asset.browser_download_url,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes,
    };
  }

  const bootloader = await downloadAsset(recoveryAsset, recoveryRelease.tag_name);
  const a2600Core = await downloadAsset(coreAsset, a2600Release.tag_name);
  const a2600Rom = await downloadAsset(romAsset, a2600Release.tag_name);

  await mkdir(outDir, { recursive: true });
  for (const artifact of [bootloader, a2600Core, a2600Rom]) {
    await writeFile(path.join(outDir, artifact.fileName), artifact.bytes);
  }

  const manifest = {
    version: recoveryRelease.tag_name,
    fileName: bootloader.fileName,
    size: bootloader.size,
    publishedAt: recoveryRelease.published_at,
    sourceUrl: bootloader.sourceUrl,
    releaseUrl: recoveryRelease.html_url,
    fetchedAt: new Date().toISOString(),
    // What the merged recovery image contains, for the Step 1 source links.
    components: {
      bootloader: {
        name: "Papilio ESP Bootloader",
        release: release.tag_name,
        releaseUrl: release.html_url,
        repoUrl: "https://github.com/Papilio-Labs/papilio-esp-bootloader",
      },
      companion: {
        name: "FPGA-Companion",
        release: companionRelease.tag_name,
        releaseUrl: companionRelease.html_url,
        repoUrl: "https://github.com/Papilio-Retrocade/FPGA-Companion",
      },
    },
    artifacts: {
      bootloader: { ...bootloader, bytes: undefined, release: recoveryRelease.tag_name },
      a2600Core: { ...a2600Core, bytes: undefined, release: a2600Release.tag_name },
      a2600Rom: { ...a2600Rom, bytes: undefined, release: a2600Release.tag_name },
    },
  };
  await writeFile(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));

  console.log(`Wrote ${bootloader.fileName}, ${a2600Core.fileName}, ${a2600Rom.fileName} + manifest.json to ${outDir}`);
}

main().catch((err) => {
  console.error(`fetch-latest-firmware failed: ${err.message}`);
  process.exit(1);
});
