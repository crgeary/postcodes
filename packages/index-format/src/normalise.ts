const CODE_SPACE = 32;
const CODE_0 = 48;
const CODE_9 = 57;
const CODE_A = 65;
const CODE_Z = 90;
const CODE_a = 97;
const CODE_z = 122;

/**
 * Uppercase; keep only A-Z, 0-9 and space; collapse runs of spaces; drop a
 * leading space. A trailing space is kept because it is meaningful: `SW1 `
 * means "all of SW1", whereas `SW1` also matches SW10, SW11, ...
 */
export function normaliseQuery(input: string): string {
  let out = '';
  let pendingSpace = false;
  for (let i = 0; i < input.length; i++) {
    let c = input.charCodeAt(i);
    if (c >= CODE_a && c <= CODE_z) c -= 32;
    if ((c >= CODE_A && c <= CODE_Z) || (c >= CODE_0 && c <= CODE_9)) {
      if (pendingSpace) {
        out += ' ';
        pendingSpace = false;
      }
      out += String.fromCharCode(c);
    } else if (c === CODE_SPACE) {
      if (out.length > 0) pendingSpace = true;
    }
    // every other character is dropped
  }
  if (pendingSpace) out += ' ';
  return out;
}

/** Uppercase and keep only A-Z and 0-9; used by `lookup`. */
export function normalisePostcode(input: string): string {
  let out = '';
  for (let i = 0; i < input.length; i++) {
    let c = input.charCodeAt(i);
    if (c >= CODE_a && c <= CODE_z) c -= 32;
    if ((c >= CODE_A && c <= CODE_Z) || (c >= CODE_0 && c <= CODE_9)) {
      out += String.fromCharCode(c);
    }
  }
  return out;
}
