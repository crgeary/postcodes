import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildIndex, encodeInward, PostcodeIndex, type BuildDistrict } from '../../src/index.js';

export const ZE_CSV = fileURLToPath(new URL('../../../../fixtures/ONSPD_FEB_2026_UK_ZE.csv', import.meta.url));

export interface LiveRow {
  outward: string;
  inward: string;
  lat: number;
  lon: number;
}

/** Minimal ONSPD reader for tests only; the indexer package has the real one. */
export function readLiveRows(path: string = ZE_CSV): LiveRow[] {
  const lines = readFileSync(path, 'utf8').split(/\r?\n/).filter((l) => l.length > 0);
  const header = lines[0].split(',');
  const col = (name: string) => {
    const i = header.indexOf(name);
    if (i < 0) throw new Error(`missing column ${name}`);
    return i;
  };
  const pcds = col('pcds');
  const doterm = col('doterm');
  const lat = col('lat');
  const lon = col('long');
  const rows: LiveRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const f = lines[i].split(',').map((v) => (v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1) : v));
    if (f[doterm] !== '') continue;
    const [outward, inward] = f[pcds].split(' ');
    const la = Number(f[lat]);
    const lo = Number(f[lon]);
    rows.push({ outward, inward, lat: la > 90 ? NaN : la, lon: la > 90 ? NaN : lo });
  }
  return rows;
}

export function districtsFromRows(rows: LiveRow[]): BuildDistrict[] {
  const map = new Map<string, BuildDistrict>();
  for (const r of rows) {
    let d = map.get(r.outward);
    if (!d) {
      d = { outward: r.outward, entries: [] };
      map.set(r.outward, d);
    }
    const inward = encodeInward(r.inward);
    if (inward < 0) throw new Error(`bad inward ${r.inward}`);
    d.entries.push({ inward, lat: r.lat, lon: r.lon });
  }
  return [...map.values()];
}

export function buildFixture(rows: LiveRow[] = readLiveRows()) {
  return buildIndex(districtsFromRows(rows), {
    release: 'FEB_2026',
    builtAt: '2026-10-18T00:00:00.000Z',
    exclusions: [],
    sourceFiles: ['ONSPD_FEB_2026_UK_ZE.csv'],
  });
}

export function openFixture(rows?: LiveRow[]): PostcodeIndex {
  return PostcodeIndex.fromBuffer(buildFixture(rows).buffer);
}
