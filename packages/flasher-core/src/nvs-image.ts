// nvs-image.ts — build ESP-IDF flash data images (partition table parsing,
// NVS key/value pages, otadata) in the browser. Byte-compatible with
// Espressif's esp-idf-nvs-partition-gen and otatool.
//
// Why: FPGA-Companion v2 and Papilio ESP Bootloader v0.1 have no serial WiFi
// provisioning listener and ship with blank otadata (so a fresh board always
// boots the factory loader). Writing these regions directly over esptool is
// the only way to provision WiFi + boot selection with today's firmware.

const NVS_PAGE_SIZE = 4096;
const NVS_ENTRY_SIZE = 32;
const NVS_ENTRIES_PER_PAGE = 126;
const NVS_FIRST_ENTRY_OFFSET = 64;
const NVS_PAGE_STATE_ACTIVE = 0xfffffffe;
const NVS_PAGE_VERSION_2 = 0xfe;
const NVS_TYPE_U8 = 0x01;
const NVS_TYPE_STR = 0x21;
const NVS_KEY_MAX = 15;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

// Same semantics as Python's zlib.crc32(data, start).
export function crc32(data: Uint8Array, start = 0): number {
  let crc = ~start >>> 0;
  for (let i = 0; i < data.length; i++) crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return ~crc >>> 0;
}

export interface PartitionEntry {
  label: string;
  type: number;
  subtype: number;
  offset: number;
  size: number;
}

export function parsePartitionTable(table: Uint8Array): PartitionEntry[] {
  const view = new DataView(table.buffer, table.byteOffset, table.byteLength);
  const entries: PartitionEntry[] = [];
  for (let pos = 0; pos + 32 <= table.length; pos += 32) {
    if (table[pos] !== 0xaa || table[pos + 1] !== 0x50) break;
    const labelBytes = table.subarray(pos + 12, pos + 28);
    const nul = labelBytes.indexOf(0);
    entries.push({
      type: table[pos + 2],
      subtype: table[pos + 3],
      offset: view.getUint32(pos + 4, true),
      size: view.getUint32(pos + 8, true),
      label: new TextDecoder().decode(nul >= 0 ? labelBytes.subarray(0, nul) : labelBytes),
    });
  }
  return entries;
}

export type NvsValue = { type: "u8"; value: number } | { type: "string"; value: string };
export type NvsNamespaces = Record<string, Record<string, NvsValue>>;

function writeKey(entry: Uint8Array, key: string): void {
  const bytes = new TextEncoder().encode(key);
  if (bytes.length > NVS_KEY_MAX) throw new Error(`NVS key "${key}" is longer than ${NVS_KEY_MAX} bytes.`);
  entry.fill(0, 8, 24);
  entry.set(bytes, 8);
}

function finishEntryCrc(entry: Uint8Array): void {
  const crcInput = new Uint8Array(28);
  crcInput.set(entry.subarray(0, 4), 0);
  crcInput.set(entry.subarray(8, 32), 4);
  new DataView(entry.buffer, entry.byteOffset, 32).setUint32(4, crc32(crcInput, 0xffffffff), true);
}

// Builds a complete NVS partition image (single active page, remaining pages
// left erased) holding the given namespaces/keys.
export function buildNvsPartition(namespaces: NvsNamespaces, partitionSize: number): Uint8Array {
  if (partitionSize < NVS_PAGE_SIZE * 2 || partitionSize % NVS_PAGE_SIZE !== 0) {
    throw new Error(`Invalid NVS partition size 0x${partitionSize.toString(16)}.`);
  }
  const image = new Uint8Array(partitionSize).fill(0xff);
  const page = image.subarray(0, NVS_PAGE_SIZE);
  const header = new DataView(page.buffer, page.byteOffset, 32);
  header.setUint32(0, NVS_PAGE_STATE_ACTIVE, true);
  header.setUint32(4, 0, true);
  page[8] = NVS_PAGE_VERSION_2;
  header.setUint32(28, crc32(page.subarray(4, 28), 0xffffffff), true);

  let index = 0;
  const allocate = (span: number): Uint8Array => {
    if (index + span > NVS_ENTRIES_PER_PAGE) throw new Error("NVS data does not fit in one page.");
    const start = NVS_FIRST_ENTRY_OFFSET + index * NVS_ENTRY_SIZE;
    for (let i = index; i < index + span; i++) {
      // Entry state bitmap: 2 bits per entry, 0b10 = written.
      page[32 + (i >> 2)] &= ~(1 << ((i % 4) * 2));
    }
    index += span;
    return page.subarray(start, start + span * NVS_ENTRY_SIZE);
  };

  let nsIndex = 0;
  for (const [nsName, keys] of Object.entries(namespaces)) {
    nsIndex += 1;
    const nsEntry = allocate(1);
    nsEntry.set([0, NVS_TYPE_U8, 1, 0xff]);
    writeKey(nsEntry, nsName);
    nsEntry[24] = nsIndex;
    finishEntryCrc(nsEntry);

    for (const [key, item] of Object.entries(keys)) {
      if (item.type === "u8") {
        const entry = allocate(1);
        entry.set([nsIndex, NVS_TYPE_U8, 1, 0xff]);
        writeKey(entry, key);
        entry[24] = item.value & 0xff;
        finishEntryCrc(entry);
        continue;
      }
      const encoded = new TextEncoder().encode(item.value);
      const data = new Uint8Array(encoded.length + 1);
      data.set(encoded);
      const dataEntries = Math.ceil(data.length / NVS_ENTRY_SIZE);
      const block = allocate(1 + dataEntries);
      const entry = block.subarray(0, NVS_ENTRY_SIZE);
      entry.set([nsIndex, NVS_TYPE_STR, 1 + dataEntries, 0xff]);
      writeKey(entry, key);
      const dv = new DataView(entry.buffer, entry.byteOffset, NVS_ENTRY_SIZE);
      dv.setUint16(24, data.length, true);
      dv.setUint16(26, 0xffff, true);
      dv.setUint32(28, crc32(data, 0xffffffff), true);
      finishEntryCrc(entry);
      block.set(data, NVS_ENTRY_SIZE);
    }
  }
  return image;
}

// otadata image selecting ota_<slot> (sequence slot+1, state UNDEFINED).
export function buildOtadataSelectingSlot(slot: number, partitionSize = 0x2000): Uint8Array {
  const image = new Uint8Array(partitionSize).fill(0xff);
  const seq = slot + 1;
  const seqBytes = new Uint8Array(4);
  new DataView(seqBytes.buffer).setUint32(0, seq, true);
  const dv = new DataView(image.buffer);
  dv.setUint32(0, seq, true);
  dv.setUint32(28, crc32(seqBytes, 0xffffffff), true);
  return image;
}

export interface FlashRegion {
  address: number;
  data: Uint8Array;
}

export interface BoardProvisioningOptions {
  ssid: string;
  password: string;
}

const PARTITION_TYPE_APP = 0x00;
const PARTITION_TYPE_DATA = 0x01;
const SUBTYPE_OTA_DATA = 0x00;
const SUBTYPE_OTA_0 = 0x10;

// Regions that give a Papilio Retrocade (factory loader + FPGA-Companion in
// ota_0) its WiFi credentials and make it boot FPGA-Companion:
//   nvs        wifi_cfg/{ssid,pass}            — read by FPGA-Companion
//   nvs_loader wifi_cfg/{ssid,pass}, loader/last_slot=0
//              — the bootloader's WiFi, and makes its /resume pick ota_0
//   otadata    select ota_0
export function buildBoardProvisioningRegions(partitions: PartitionEntry[], options: BoardProvisioningOptions): FlashRegion[] {
  const find = (label: string) => partitions.find((p) => p.label === label);
  const otadata = partitions.find((p) => p.type === PARTITION_TYPE_DATA && p.subtype === SUBTYPE_OTA_DATA);
  const ota0 = partitions.find((p) => p.type === PARTITION_TYPE_APP && p.subtype === SUBTYPE_OTA_0);
  const nvs = find("nvs");
  const nvsLoader = find("nvs_loader");
  if (!otadata || !ota0 || !nvs) {
    throw new Error("The board's partition table has no nvs/otadata/ota_0 partition — flash the Step 1 firmware first.");
  }

  const wifi: Record<string, NvsValue> = {
    ssid: { type: "string", value: options.ssid },
    pass: { type: "string", value: options.password },
  };
  const regions: FlashRegion[] = [
    { address: nvs.offset, data: buildNvsPartition({ wifi_cfg: wifi }, nvs.size) },
    { address: otadata.offset, data: buildOtadataSelectingSlot(0, otadata.size) },
  ];
  if (nvsLoader) {
    regions.push({
      address: nvsLoader.offset,
      data: buildNvsPartition({ wifi_cfg: wifi, loader: { last_slot: { type: "u8", value: 0 } } }, nvsLoader.size),
    });
  }
  return regions.sort((a, b) => a.address - b.address);
}

const MERGED_PARTITION_TABLE_OFFSET = 0x8000;
const MERGED_PARTITION_TABLE_SIZE = 0xc00;

// Writes the WiFi settings and boot selection (the same regions
// provisionBoardOverUsb writes) straight into a merged image, so the image and
// the WiFi settings go to the board in ONE esptool session with ONE reset at
// the end. Replaces a separate "send WiFi" step, which needed a second USB
// reset into the bootloader (the unreliable part on this board). Returns a
// patched copy; throws if the image is not a merged image or a region would
// fall outside it.
export function provisionMergedImage(image: Uint8Array, options: BoardProvisioningOptions): Uint8Array {
  if (image.length < MERGED_PARTITION_TABLE_OFFSET + MERGED_PARTITION_TABLE_SIZE) {
    throw new Error("This firmware file is not a merged image, so WiFi settings cannot be added to it.");
  }
  const partitions = parsePartitionTable(
    image.subarray(MERGED_PARTITION_TABLE_OFFSET, MERGED_PARTITION_TABLE_OFFSET + MERGED_PARTITION_TABLE_SIZE)
  );
  const regions = buildBoardProvisioningRegions(partitions, options);
  const patched = image.slice();
  for (const region of regions) {
    if (region.address + region.data.length > patched.length) {
      throw new Error("This firmware image does not cover the board's WiFi settings area, so WiFi settings cannot be added to it.");
    }
    patched.set(region.data, region.address);
  }
  return patched;
}

function isErased(data: Uint8Array): boolean {
  return data.every((b) => b === 0xff);
}

// Release merged images ship blank otadata and nvs_loader, so a freshly
// flashed board boots the factory loader and the loader's /resume (which
// derives the app slot from last_slot) picks the empty ota_1. Patch a copy of
// the image so it boots ota_0 and seeds loader/last_slot=0. Only blank
// regions are filled; images that already carry this data are left alone.
// Returns null when the image is not a merged image with an app in ota_0.
export function seedBootSelectionInMergedImage(image: Uint8Array): Uint8Array | null {
  if (image.length < MERGED_PARTITION_TABLE_OFFSET + MERGED_PARTITION_TABLE_SIZE) return null;
  const partitions = parsePartitionTable(
    image.subarray(MERGED_PARTITION_TABLE_OFFSET, MERGED_PARTITION_TABLE_OFFSET + MERGED_PARTITION_TABLE_SIZE)
  );
  const otadata = partitions.find((p) => p.type === PARTITION_TYPE_DATA && p.subtype === SUBTYPE_OTA_DATA);
  const ota0 = partitions.find((p) => p.type === PARTITION_TYPE_APP && p.subtype === SUBTYPE_OTA_0);
  if (!otadata || !ota0 || image.length <= ota0.offset || image[ota0.offset] !== 0xe9) return null;
  if (image.length < otadata.offset + otadata.size) return null;

  const patched = image.slice();
  let changed = false;
  if (isErased(patched.subarray(otadata.offset, otadata.offset + otadata.size))) {
    patched.set(buildOtadataSelectingSlot(0, otadata.size), otadata.offset);
    changed = true;
  }
  const nvsLoader = partitions.find((p) => p.label === "nvs_loader");
  if (nvsLoader && image.length >= nvsLoader.offset + nvsLoader.size &&
      isErased(patched.subarray(nvsLoader.offset, nvsLoader.offset + nvsLoader.size))) {
    patched.set(buildNvsPartition({ loader: { last_slot: { type: "u8", value: 0 } } }, nvsLoader.size), nvsLoader.offset);
    changed = true;
  }
  return changed ? patched : null;
}
