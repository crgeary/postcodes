import { describe, expect, it } from 'vitest';
import { normaliseQuery, PostcodeIndex } from '../src/index.js';
import { openFixture, readLiveRows } from './helpers/fixture.js';

const rows = readLiveRows();
const index: PostcodeIndex = openFixture(rows);
const formatted = rows.map((r) => `${r.outward} ${r.inward}`);
const compact = formatted.map((p) => p.replace(' ', ''));

/** Brute-force reference: left-to-right prefix match with or without the space. */
function bruteForce(q: string): string[] {
  const out: string[] = [];
  if (q.includes(' ')) {
    for (const p of formatted) if (p.startsWith(q)) out.push(p);
  } else {
    for (let i = 0; i < compact.length; i++) if (compact[i].startsWith(q)) out.push(formatted[i]);
  }
  return out.sort();
}

describe('fixture', () => {
  it('matches the ZE sample: 658 live postcodes in 3 districts', () => {
    expect(index.postcodeCount).toBe(658);
    expect(index.districtCount).toBe(3);
    expect([...index.outwards]).toEqual(['ZE1', 'ZE2', 'ZE3']);
    expect(index.metadata.release).toBe('FEB_2026');
  });

  it('all() enumerates every postcode once in rank order', () => {
    const all = [...index.all()].map((r) => r.postcode);
    expect(all.length).toBe(658);
    expect(new Set(all).size).toBe(658);
    expect(all).toEqual(formatted.slice().sort());
  });
});

describe('search() against brute force', () => {
  const BIG = 10_000;

  it('agrees for every prefix of every live postcode, with and without the space', () => {
    const queries = new Set<string>();
    for (const p of formatted) {
      for (let i = 1; i <= p.length; i++) queries.add(p.slice(0, i));
      const c = p.replace(' ', '');
      for (let i = 1; i <= c.length; i++) queries.add(c.slice(0, i));
    }
    let checked = 0;
    for (const q of queries) {
      const got = index.search(q, BIG).map((r) => r.postcode);
      expect(new Set(got).size, `duplicates for ${q}`).toBe(got.length);
      expect(got.slice().sort(), `mismatch for ${JSON.stringify(q)}`).toEqual(bruteForce(q));
      checked++;
    }
    expect(checked).toBeGreaterThan(1000);
  });

  it('returns the first `limit` of the full result list', () => {
    for (const q of ['ZE', 'ZE1', 'ZE2 9', 'ZE10', 'Z']) {
      const full = index.search(q, BIG).map((r) => r.postcode);
      for (const limit of [1, 2, 5, 10, 50]) {
        expect(index.search(q, limit).map((r) => r.postcode)).toEqual(full.slice(0, limit));
      }
    }
  });

  it('orders outward-prefix matches before split interpretations', () => {
    // "ZE10": outward-prefix would be a district starting with ZE10 (none);
    // split k=1 is ZE1 + "0". Everything should be ZE1 0xx.
    const r = index.search('ZE10', BIG).map((x) => x.postcode);
    expect(r.length).toBeGreaterThan(0);
    expect(r.every((p) => p.startsWith('ZE1 0'))).toBe(true);
    // "ZE1" alone is an outward prefix: all of ZE1 only (no ZE10 district exists).
    const z = index.search('ZE1', BIG).map((x) => x.postcode);
    expect(z.every((p) => p.startsWith('ZE1 '))).toBe(true);
  });

  it('ignores a trailing space after the inward part or after a no-space postcode', () => {
    expect(index.search('ZE1 0AA ', 5).map((r) => r.postcode)).toEqual(['ZE1 0AA']);
    expect(index.search('ZE1 0 ', BIG).map((r) => r.postcode)).toEqual(index.search('ZE1 0', BIG).map((r) => r.postcode));
    expect(index.search('ZE10AA ', 5).map((r) => r.postcode)).toEqual(['ZE1 0AA']);
    expect(index.search('ZE10 ', BIG).map((r) => r.postcode)).toEqual(index.search('ZE10', BIG).map((r) => r.postcode));
    // A trailing space after a plausible outward still means "all of that district".
    expect(index.search('ZE1 ', BIG).map((r) => r.postcode)).toEqual(bruteForce('ZE1 '));
    expect(index.search('Z ', BIG).map((r) => r.postcode)).toEqual(index.search('Z', BIG).map((r) => r.postcode));
  });

  it('clamps absurd limits instead of wrapping them', () => {
    const all = index.search('ZE', BIG).length;
    expect(index.search('ZE', 2 ** 31).length).toBe(all);
    expect(index.search('ZE', 2 ** 32 + 5).length).toBe(all);
    expect(index.search('ZE', Infinity).length).toBe(all);
    expect(index.search('ZE', 2.9).length).toBe(2);
  });

  it('handles messy input: case, punctuation, extra spaces', () => {
    expect(index.search('ze1 0aa', 5)[0].postcode).toBe('ZE1 0AA');
    expect(index.search('  ze1   0a', 500).map((r) => r.postcode)).toEqual(
      index.search('ZE1 0A', 500).map((r) => r.postcode),
    );
    expect(index.search('ZE1-0AA', 5)[0].postcode).toBe('ZE1 0AA');
  });

  it('returns [] for empty input, non-positive limit, over-long or nonsense queries', () => {
    expect(index.search('', 10)).toEqual([]);
    expect(index.search('   ', 10)).toEqual([]);
    expect(index.search('ZE1', 0)).toEqual([]);
    expect(index.search('ZE1', -1)).toEqual([]);
    expect(index.search('ZE1 0AAX', 10)).toEqual([]);
    expect(index.search('ZE1 0AA 1', 10)).toEqual([]);
    expect(index.search('SW1A 1AA', 10)).toEqual([]);
    expect(index.search('ZE1 C', 10)).toEqual([]);
    expect(index.search('ZE1 A', 10)).toEqual([]);
  });

  it('results are monomorphic: lat and lon keys always present', () => {
    for (const r of index.search('ZE', 20)) {
      expect(Object.keys(r)).toEqual(['postcode', 'lat', 'lon']);
    }
  });
});

describe('lookup()', () => {
  it('finds every live postcode with or without the space, any case', () => {
    for (const p of formatted) {
      expect(index.lookup(p)?.postcode).toBe(p);
      expect(index.lookup(p.replace(' ', '').toLowerCase())?.postcode).toBe(p);
    }
  });

  it('returns null for unknown or malformed postcodes', () => {
    expect(index.lookup('ZE1 0ZZ')).toBeNull();
    expect(index.lookup('ZE9 0AA')).toBeNull();
    expect(index.lookup('ZE1')).toBeNull();
    expect(index.lookup('ZE1 0A')).toBeNull();
    expect(index.lookup('ZE1 0AAA')).toBeNull();
    expect(index.lookup('')).toBeNull();
  });

  it('agrees with search() on coordinates', () => {
    for (const r of index.search('ZE2 9', 100)) {
      expect(index.lookup(r.postcode)).toEqual(r);
    }
  });
});

describe('normaliseQuery()', () => {
  it('uppercases, strips punctuation, collapses spaces, keeps only a separator-like trailing space', () => {
    expect(normaliseQuery('  sw1a   1aa ')).toBe('SW1A 1AA');
    expect(normaliseQuery('sw1a-1aa')).toBe('SW1A1AA');
    expect(normaliseQuery('   ')).toBe('');
    expect(normaliseQuery('ze1 ')).toBe('ZE1 ');
    expect(normaliseQuery('sw1a ')).toBe('SW1A ');
    expect(normaliseQuery('sw1a1 ')).toBe('SW1A1');
    expect(normaliseQuery('sw1a 1 ')).toBe('SW1A 1');
    expect(normaliseQuery('b ')).toBe('B');
  });
});
