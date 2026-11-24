export type BinaryImageType = "esp32" | "fpga" | "unknown";

const ESP32_IMAGE_MAGIC = 0xe9;
const GOWIN_PREAMBLE_LENGTH = 22;
const GOWIN_SYNC_A5 = 0xa5;
const GOWIN_SYNC_C3 = 0xc3;

/** Identify the binary formats accepted by the Papilio Retrocade loader. */
export function detectBinaryImageType(data: Uint8Array): BinaryImageType {
  if (data.length > 0 && data[0] === ESP32_IMAGE_MAGIC) {
    return "esp32";
  }

  if (
    data.length >= GOWIN_PREAMBLE_LENGTH + 2 &&
    data.subarray(0, GOWIN_PREAMBLE_LENGTH).every((value) => value === 0xff) &&
    data[GOWIN_PREAMBLE_LENGTH] === GOWIN_SYNC_A5 &&
    data[GOWIN_PREAMBLE_LENGTH + 1] === GOWIN_SYNC_C3
  ) {
    return "fpga";
  }

  return "unknown";
}

export function isEsp32Image(data: Uint8Array): boolean {
  return detectBinaryImageType(data) === "esp32";
}

export function isGowinFpgaBitstream(data: Uint8Array): boolean {
  return detectBinaryImageType(data) === "fpga";
}

export function validateRawEsp32AppImage(data: Uint8Array, maxSize = 0x180000): void {
  if (data.length < 33 || data.length > maxSize || data[0] !== ESP32_IMAGE_MAGIC) {
    throw new Error(`ESP32 app image must be a nonempty raw application binary no larger than ${maxSize} bytes.`);
  }
  const segmentCount = data[1];
  if (segmentCount === 0 || segmentCount > 16) throw new Error("ESP32 app image has an invalid segment count.");

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 24;
  for (let segment = 0; segment < segmentCount; segment++) {
    if (offset + 8 > data.length) throw new Error("ESP32 app image is truncated in its segment header.");
    const segmentLength = view.getUint32(offset + 4, true);
    if (segmentLength === 0 || offset + 8 + segmentLength > data.length) {
      throw new Error("ESP32 app image is truncated in its segment data.");
    }
    offset += 8 + segmentLength;
  }
  if (offset >= data.length) throw new Error("ESP32 app image is truncated before its checksum.");
}

export function validateFpgaBitstream(data: Uint8Array, maxSize = 0x200000): void {
  if (data.length < GOWIN_PREAMBLE_LENGTH + 2 || data.length > maxSize || !isGowinFpgaBitstream(data)) {
    throw new Error(`FPGA image must be a valid Gowin bitstream no larger than ${maxSize} bytes.`);
  }
}
