import {
  BBOX_BYTES,
  BITSET_BYTES,
  CHECKSUM_BYTES,
  CHECKSUM_OFFSET,
  COORD_BYTES,
  FLAG_HAS_COORDINATES,
  FORMAT_VERSION,
  HEADER_SIZE,
  MAGIC,
  OUTWARD_BYTES,
} from './constants.js';

export interface IndexHeader {
  version: number;
  flags: number;
  districtCount: number;
  postcodeCount: number;
  metadataLength: number;
  fileLength: number;
  checksum: Uint8Array;
}

/** Byte offsets and lengths of every section, all 4-byte aligned. */
export interface IndexLayout {
  metadataOffset: number;
  metadataLength: number;
  outwardsOffset: number;
  rankOffset: number;
  bitsetsOffset: number;
  bboxOffset: number;
  coordsOffset: number;
  coordsLength: number;
  fileLength: number;
}

export function align4(n: number): number {
  return (n + 3) & ~3;
}

export function hasCoordinates(flags: number): boolean {
  return (flags & FLAG_HAS_COORDINATES) !== 0;
}

export function computeLayout(
  districtCount: number,
  postcodeCount: number,
  metadataLength: number,
  flags: number,
): IndexLayout {
  const metadataOffset = HEADER_SIZE;
  const outwardsOffset = align4(metadataOffset + metadataLength);
  const rankOffset = outwardsOffset + districtCount * OUTWARD_BYTES;
  const bitsetsOffset = rankOffset + (districtCount + 1) * 4;
  const bboxOffset = bitsetsOffset + districtCount * BITSET_BYTES;
  const coordsOffset = bboxOffset + districtCount * BBOX_BYTES;
  const coordsLength = hasCoordinates(flags) ? postcodeCount * COORD_BYTES : 0;
  const fileLength = coordsOffset + coordsLength;
  return {
    metadataOffset,
    metadataLength,
    outwardsOffset,
    rankOffset,
    bitsetsOffset,
    bboxOffset,
    coordsOffset,
    coordsLength,
    fileLength,
  };
}

export class IndexFormatError extends Error {
  override readonly name = 'IndexFormatError';
}

/** Read the magic string at offset 0 without decoding the whole buffer. */
function readMagic(view: DataView): string {
  return String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
}

/**
 * Parse the 64-byte header. Only checks that the buffer is large enough and
 * carries the magic and a known version; length and checksum validation is
 * done by `validateIndexBuffer`.
 */
export function readHeader(buffer: ArrayBuffer): IndexHeader {
  if (buffer.byteLength < HEADER_SIZE) {
    throw new IndexFormatError(`file too short for header: ${buffer.byteLength} bytes`);
  }
  const view = new DataView(buffer, 0, HEADER_SIZE);
  const magic = readMagic(view);
  if (magic !== MAGIC) {
    throw new IndexFormatError(`bad magic: expected ${MAGIC}, got ${JSON.stringify(magic)}`);
  }
  const version = view.getUint16(4, true);
  if (version !== FORMAT_VERSION) {
    throw new IndexFormatError(`unsupported format version ${version} (expected ${FORMAT_VERSION})`);
  }
  return {
    version,
    flags: view.getUint16(6, true),
    districtCount: view.getUint32(8, true),
    postcodeCount: view.getUint32(12, true),
    metadataLength: view.getUint32(16, true),
    fileLength: view.getUint32(20, true),
    checksum: new Uint8Array(buffer, CHECKSUM_OFFSET, CHECKSUM_BYTES).slice(),
  };
}

/** Write every header field except the checksum. */
export function writeHeader(buffer: ArrayBuffer, header: Omit<IndexHeader, 'checksum'>): void {
  const view = new DataView(buffer, 0, HEADER_SIZE);
  for (let i = 0; i < 4; i++) view.setUint8(i, MAGIC.charCodeAt(i));
  view.setUint16(4, header.version, true);
  view.setUint16(6, header.flags, true);
  view.setUint32(8, header.districtCount, true);
  view.setUint32(12, header.postcodeCount, true);
  view.setUint32(16, header.metadataLength, true);
  view.setUint32(20, header.fileLength, true);
  // Checksum (24..56) is written by the builder; 56..64 reserved and left zero.
}
