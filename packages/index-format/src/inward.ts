import { INWARD_COUNT, INWARD_LETTERS, INWARD_LETTER_COUNT } from './constants.js';

/**
 * Letter to inward index, -1 for anything that is not an inward letter.
 * Indexed by char code; built once at module load.
 */
export const LETTER_INDEX: Int8Array = (() => {
  const t = new Int8Array(128).fill(-1);
  for (let i = 0; i < INWARD_LETTERS.length; i++) {
    t[INWARD_LETTERS.charCodeAt(i)] = i;
  }
  return t;
})();

/** Inward index to letter, by position. */
export const INDEX_LETTER: string[] = INWARD_LETTERS.split('');

const CODE_0 = 48; // '0'
const CODE_9 = 57; // '9'

function letterIndex(code: number): number {
  return code < 128 ? LETTER_INDEX[code] : -1;
}

/**
 * Encode a three-character inward code (`0AA`) to its bit index 0..3999,
 * or -1 if the string is not a valid inward code.
 */
export function encodeInward(inward: string): number {
  if (inward.length !== 3) return -1;
  const d = inward.charCodeAt(0) - CODE_0;
  if (d < 0 || d > 9) return -1;
  const l1 = letterIndex(inward.charCodeAt(1));
  if (l1 < 0) return -1;
  const l2 = letterIndex(inward.charCodeAt(2));
  if (l2 < 0) return -1;
  return d * 400 + l1 * INWARD_LETTER_COUNT + l2;
}

/** Decode a bit index 0..3999 back to its inward code string. */
export function decodeInward(n: number): string {
  if (n < 0 || n >= INWARD_COUNT || (n | 0) !== n) {
    throw new RangeError(`inward index out of range: ${n}`);
  }
  const d = (n / 400) | 0;
  const rest = n - d * 400;
  const l1 = (rest / INWARD_LETTER_COUNT) | 0;
  const l2 = rest - l1 * INWARD_LETTER_COUNT;
  return String.fromCharCode(CODE_0 + d) + INDEX_LETTER[l1] + INDEX_LETTER[l2];
}

/**
 * Map an inward prefix (0 to 3 characters) to the half-open bit range [lo, hi)
 * it covers, written into `out[0]` and `out[1]`. Returns false if the prefix
 * contains any character that cannot appear at that position.
 *
 * ""    -> [0, 4000)
 * "1"   -> [400, 800)
 * "1A"  -> [400, 420)
 * "1AA" -> [400, 401)
 */
export function inwardPrefixRange(prefix: string, out: Int32Array): boolean {
  const len = prefix.length;
  if (len > 3) return false;
  if (len === 0) {
    out[0] = 0;
    out[1] = INWARD_COUNT;
    return true;
  }
  const d = prefix.charCodeAt(0) - CODE_0;
  if (d < 0 || d > 9) return false;
  let lo = d * 400;
  let span = 400;
  if (len >= 2) {
    const l1 = letterIndex(prefix.charCodeAt(1));
    if (l1 < 0) return false;
    lo += l1 * INWARD_LETTER_COUNT;
    span = INWARD_LETTER_COUNT;
  }
  if (len === 3) {
    const l2 = letterIndex(prefix.charCodeAt(2));
    if (l2 < 0) return false;
    lo += l2;
    span = 1;
  }
  out[0] = lo;
  out[1] = lo + span;
  return true;
}

/** True if `c` is an ASCII digit code. */
export function isDigitCode(c: number): boolean {
  return c >= CODE_0 && c <= CODE_9;
}
