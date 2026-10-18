import { createHash } from 'node:crypto';
import { CHECKSUM_BYTES, CHECKSUM_OFFSET, HEADER_SIZE } from './constants.js';

/** SHA-256 of everything after the header. */
export function computeChecksum(buffer: ArrayBuffer): Uint8Array {
  const body = new Uint8Array(buffer, HEADER_SIZE, buffer.byteLength - HEADER_SIZE);
  const digest = createHash('sha256').update(body).digest();
  // Respect byteOffset: a Buffer may be a view into a larger pooled buffer.
  return new Uint8Array(digest.buffer, digest.byteOffset, CHECKSUM_BYTES).slice();
}

/** Read the checksum stored in the header. */
export function storedChecksum(buffer: ArrayBuffer): Uint8Array {
  return new Uint8Array(buffer, CHECKSUM_OFFSET, CHECKSUM_BYTES);
}

export function checksumsEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export function checksumHex(c: Uint8Array): string {
  let s = '';
  for (let i = 0; i < c.length; i++) s += c[i].toString(16).padStart(2, '0');
  return s;
}
