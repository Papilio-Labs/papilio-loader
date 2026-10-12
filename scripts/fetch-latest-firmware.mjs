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
const PARTITION_TABLE_OFFSET = 0x8000;
const BOOTLOADER_PARTITION_SIZE = 0x8000;

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(scriptDir, "..", "apps", "web", "board-recovery", "firmware");

function parsePartitionTable(table) {
  const entries = [];
  const view = new DataView(table.buffer, table.byteOffset, table.byteLength);

  for (let offset = 0; offset + 32 <= table.length; offset += 32) {
    const magic = view.getUint16(offset, true);
    if (magic === 0xffff || magic === 0xebeb) break;
    if (magic !== 0x50aa) {
      throw new Error(`Invalid ESP partition-table entry at offset 0x${offset.toString(16)}`);
    }

    entries.push({
      type: table[offset + 2],
      subtype: table[offset + 3],
      offset: view.getUint32(offset + 4, true),
      size: view.getUint32(offset + 8, true),
      label: new TextDecoder().decode(table.subarray(offset + 12, offset + 28)).split("\0", 1)[0],
    });
  }

  return entries;
}

function overlayLatestBootloader(migration, app, secondStage, partitionTable) {
  if (app.bytes[0] !== 0xe9) {
    throw new Error(`Latest bootloader app ${app.fileName} does not have ESP image magic`);
  }
  if (secondStage.bytes.length > BOOTLOADER_PARTITION_SIZE) {
    throw new Error(`Latest second-stage bootloader ${secondStage.fileName} is too large`);
  }

  const tableOffset = PARTITION_TABLE_OFFSET;
  const embeddedTable = migration.bytes.subarray(tableOffset, tableOffset + partitionTable.bytes.length);
  if (embeddedTable.length !== partitionTable.bytes.length ||
      !embeddedTable.every((byte, index) => byte === partitionTable.bytes[index])) {
    throw new Error("Companion migration image partition table does not match the latest Papilio ESP Bootloader");
  }

  const partitions = parsePartitionTable(partitionTable.bytes);
  const factory = partitions.find((entry) => entry.type === 0 && entry.subtype === 0);
  const ota0 = partitions.find((entry) => entry.type === 0 && entry.subtype === 0x10);
  if (!factory || !ota0 || factory.offset + factory.size !== ota0.offset) {
    throw new Error("Latest bootloader partition table has an unsupported factory/ota_0 layout");
  }
  if (app.bytes.length > factory.size) {
    throw new Error(`Latest bootloader app (${app.bytes.length} bytes) exceeds factory partition (${factory.size} bytes)`);
  }
  if (migration.bytes.length <= ota0.offset || migration.bytes[ota0.offset] !== 0xe9) {
    throw new Error("Companion migration image does not contain a valid ota_0 app at the expected offset");
  }

  const bytes = new Uint8Array(migration.bytes);
  bytes.fill(0xff, 0, PARTITION_TABLE_OFFSET);
  bytes.set(secondStage.bytes, 0);
  bytes.set(partitionTable.bytes, PARTITION_TABLE_OFFSET);
  bytes.fill(0xff, factory.offset, factory.offset + factory.size);
  bytes.set(app.bytes, factory.offset);

  return bytes;
}

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

  let recoveryImage = await downloadAsset(recoveryAsset, recoveryRelease.tag_name);
  let bootloaderApp = null;
  if (migrationAsset) {
    const appAsset = (release.assets || []).find((a) => a.name === `papilio-esp-bootloader-${release.tag_name}.bin`);
    const secondStageAsset = (release.assets || []).find((a) => a.name === "bootloader.bin");
    const partitionTableAsset = (release.assets || []).find((a) => a.name === "partition-table.bin");
    if (!appAsset || !secondStageAsset || !partitionTableAsset) {
      throw new Error(`Papilio ESP Bootloader ${release.tag_name} is missing an app, bootloader, or partition-table release asset`);
    }

    const [appImage, secondStage, partitionTable] = await Promise.all([
      downloadAsset(appAsset, release.tag_name),
      downloadAsset(secondStageAsset, release.tag_name),
      downloadAsset(partitionTableAsset, release.tag_name),
    ]);
    bootloaderApp = appImage;
    const bytes = overlayLatestBootloader(recoveryImage, appImage, secondStage, partitionTable);
    recoveryImage = {
      fileName: `papilio-migration-${companionRelease.tag_name}-bootloader-${release.tag_name}-merged.bin`,
      size: bytes.length,
      sourceUrl: recoveryImage.sourceUrl,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes,
    };
  }

  const a2600Core = await downloadAsset(coreAsset, a2600Release.tag_name);
  const a2600Rom = await downloadAsset(romAsset, a2600Release.tag_name);

  await mkdir(outDir, { recursive: true });
  for (const artifact of [recoveryImage, a2600Core, a2600Rom]) {
    await writeFile(path.join(outDir, artifact.fileName), artifact.bytes);
  }

  const manifest = {
    version: migrationAsset
      ? `Bootloader ${release.tag_name} + FPGA-Companion ${companionRelease.tag_name}`
      : recoveryRelease.tag_name,
    fileName: recoveryImage.fileName,
    size: recoveryImage.size,
    publishedAt: recoveryRelease.published_at,
    sourceUrl: recoveryImage.sourceUrl,
    sourceAssets: migrationAsset
      ? {
          bootloaderApp: bootloaderApp.sourceUrl,
          companionMigration: recoveryAsset.browser_download_url,
        }
      : undefined,
    fetchedAt: new Date().toISOString(),
    components: {
      bootloader: {
        name: "Papilio ESP Bootloader",
        release: release.tag_name,
        releaseUrl: release.html_url,
        repoUrl: "https://github.com/Papilio-Labs/papilio-esp-bootloader",
      },
      ...(migrationAsset ? { companion: {
        name: "FPGA-Companion",
        release: companionRelease.tag_name,
        releaseUrl: companionRelease.html_url,
        repoUrl: "https://github.com/Papilio-Retrocade/FPGA-Companion",
      } } : {}),
    },
    artifacts: {
      bootloader: { ...recoveryImage, bytes: undefined, release: release.tag_name },
      a2600Core: { ...a2600Core, bytes: undefined, release: a2600Release.tag_name },
      a2600Rom: { ...a2600Rom, bytes: undefined, release: a2600Release.tag_name },
    },
  };
  await writeFile(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));

  console.log(`Wrote ${recoveryImage.fileName}, ${a2600Core.fileName}, ${a2600Rom.fileName} + manifest.json to ${outDir}`);
}

main().catch((err) => {
  console.error(`fetch-latest-firmware failed: ${err.message}`);
  process.exit(1);
});
