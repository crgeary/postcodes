/**
 * Return an ArrayBuffer whose byte 0 is the first byte of `bytes` and whose
 * length is exactly `bytes.byteLength`, so typed-array views can be created at
 * computed, 4-byte-aligned offsets.
 *
 * `readFileSync` may return a Buffer that is a view into a pooled or shared
 * buffer with a non-zero `byteOffset`; in that case copy once.
 */
export function toAlignedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const { buffer, byteOffset, byteLength } = bytes;
  if (buffer instanceof ArrayBuffer && byteOffset === 0 && byteLength === buffer.byteLength) {
    return buffer;
  }
  const copy = new ArrayBuffer(byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}
