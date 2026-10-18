import { describe, expect, it } from 'vitest';
import { decodeInward, encodeInward, INWARD_COUNT, inwardPrefixRange } from '../src/index.js';

describe('inward encoding', () => {
  it('round-trips every code 0..3999 and is bijective', () => {
    const seen = new Set<string>();
    for (let n = 0; n < INWARD_COUNT; n++) {
      const s = decodeInward(n);
      expect(s).toMatch(/^[0-9][ABDEFGHJLNPQRSTUWXYZ]{2}$/);
      expect(encodeInward(s)).toBe(n);
      seen.add(s);
    }
    expect(seen.size).toBe(INWARD_COUNT);
  });

  it('rejects invalid inward codes', () => {
    for (const bad of ['', '0A', '0AAA', 'A0A', '0CA', '0AI', '0ak', '0 A', '0A ']) {
      expect(encodeInward(bad)).toBe(-1);
    }
  });

  it('decode rejects out-of-range indexes', () => {
    expect(() => decodeInward(-1)).toThrow(RangeError);
    expect(() => decodeInward(4000)).toThrow(RangeError);
    expect(() => decodeInward(1.5)).toThrow(RangeError);
  });

  it('maps prefixes to contiguous bit ranges', () => {
    const r = new Int32Array(2);
    expect(inwardPrefixRange('', r)).toBe(true);
    expect([...r]).toEqual([0, 4000]);
    expect(inwardPrefixRange('1', r)).toBe(true);
    expect([...r]).toEqual([400, 800]);
    expect(inwardPrefixRange('1A', r)).toBe(true);
    expect([...r]).toEqual([400, 420]);
    expect(inwardPrefixRange('1B', r)).toBe(true);
    expect([...r]).toEqual([420, 440]);
    expect(inwardPrefixRange('1AA', r)).toBe(true);
    expect([...r]).toEqual([400, 401]);
    expect(inwardPrefixRange('9ZZ', r)).toBe(true);
    expect([...r]).toEqual([3999, 4000]);
  });

  it('prefix ranges contain exactly the codes that start with the prefix', () => {
    const r = new Int32Array(2);
    for (const prefix of ['3', '3F', '3FQ', '0', '9Z']) {
      expect(inwardPrefixRange(prefix, r)).toBe(true);
      for (let n = 0; n < INWARD_COUNT; n++) {
        const inRange = n >= r[0] && n < r[1];
        expect(inRange).toBe(decodeInward(n).startsWith(prefix));
      }
    }
  });

  it('rejects invalid prefixes', () => {
    const r = new Int32Array(2);
    for (const bad of ['A', '1C', '1AC', '1AAA', ' ', '1 ']) {
      expect(inwardPrefixRange(bad, r)).toBe(false);
    }
  });
});
