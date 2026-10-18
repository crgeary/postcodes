import { describe, expect, it } from 'vitest';
import {
  CHECKSUM_OFFSET,
  checksumHex,
  computeChecksum,
  storedChecksum,
  FORMAT_VERSION,
  HEADER_SIZE,
  IndexFormatError,
  PostcodeIndex,
  toAlignedArrayBuffer,
  validateIndexBuffer,
} from '../src/index.js';
import { buildFixture } from './helpers/fixture.js';

function copy(buffer: ArrayBuffer): ArrayBuffer {
  return buffer.slice(0);
}

describe('validation', () => {
  const { buffer } = buildFixture();

  it('accepts a freshly built index', () => {
    const v = validateIndexBuffer(buffer);
    expect(v.header.version).toBe(FORMAT_VERSION);
    expect(v.header.districtCount).toBe(3);
    expect(v.header.postcodeCount).toBe(658);
    expect(v.layout.fileLength).toBe(buffer.byteLength);
    expect(buffer.byteLength % 4).toBe(0);
  });

  it('rejects a corrupt magic', () => {
    const b = copy(buffer);
    new Uint8Array(b)[0] = 0x58;
    expect(() => PostcodeIndex.fromBuffer(b)).toThrow(IndexFormatError);
    expect(() => PostcodeIndex.fromBuffer(b)).toThrow(/magic/);
  });

  it('rejects a wrong format version', () => {
    const b = copy(buffer);
    new DataView(b).setUint16(4, FORMAT_VERSION + 1, true);
    expect(() => PostcodeIndex.fromBuffer(b)).toThrow(/version/);
  });

  it('rejects a bad checksum', () => {
    const b = copy(buffer);
    new Uint8Array(b)[CHECKSUM_OFFSET + 5] ^= 0xff;
    expect(() => PostcodeIndex.fromBuffer(b)).toThrow(/checksum/);
  });

  it('rejects a flipped bit in the body', () => {
    const b = copy(buffer);
    new Uint8Array(b)[b.byteLength - 1] ^= 0x01;
    expect(() => PostcodeIndex.fromBuffer(b)).toThrow(/checksum/);
  });

  it('rejects a truncated file', () => {
    expect(() => PostcodeIndex.fromBuffer(buffer.slice(0, buffer.byteLength - 4))).toThrow(/length/);
    expect(() => PostcodeIndex.fromBuffer(buffer.slice(0, HEADER_SIZE - 1))).toThrow(/short/);
    expect(() => PostcodeIndex.fromBuffer(new ArrayBuffer(0))).toThrow(IndexFormatError);
  });

  it('rejects a header whose counts do not match the layout', () => {
    const b = copy(buffer);
    new DataView(b).setUint32(8, 4, true); // districtCount
    expect(() => PostcodeIndex.fromBuffer(b)).toThrow(/layout/);
  });

  it('checksum matches an independent SHA-256 of the body', async () => {
    const { createHash } = await import('node:crypto');
    const expected = createHash('sha256').update(new Uint8Array(buffer, HEADER_SIZE)).digest('hex');
    expect(checksumHex(computeChecksum(buffer))).toBe(expected);
    expect(checksumHex(storedChecksum(buffer))).toBe(expected);
    expect(computeChecksum(buffer).byteOffset).toBe(0);
    expect(computeChecksum(buffer).length).toBe(32);
  });

  it('opens from a Buffer with a non-zero byteOffset', () => {
    const padded = new Uint8Array(buffer.byteLength + 6);
    padded.set(new Uint8Array(buffer), 6);
    const view = new Uint8Array(padded.buffer, 6, buffer.byteLength);
    const aligned = toAlignedArrayBuffer(view);
    expect(aligned.byteLength).toBe(buffer.byteLength);
    const idx = PostcodeIndex.fromBytes(view);
    expect(idx.postcodeCount).toBe(658);
    expect(idx.byteLength).toBe(buffer.byteLength);
  });
});
