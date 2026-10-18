import { describe, expect, it } from 'vitest';
import { buildIndex, NO_COORDINATE, PostcodeIndex } from '../src/index.js';
import * as helpers from './helpers/fixture.js';
import { buildFixture, openFixture, readLiveRows, type LiveRow } from './helpers/fixture.js';

describe('coordinates', () => {
  const rows = readLiveRows();
  const index = openFixture(rows);

  it('decode within 0.00002 degrees of the CSV values for every postcode', () => {
    let worst = 0;
    for (const r of rows) {
      const got = index.lookup(`${r.outward} ${r.inward}`);
      expect(got).not.toBeNull();
      expect(got!.lat).toBeDefined();
      const dLat = Math.abs(got!.lat! - r.lat);
      const dLon = Math.abs(got!.lon! - r.lon);
      worst = Math.max(worst, dLat, dLon);
      expect(dLat).toBeLessThan(0.00002);
      expect(dLon).toBeLessThan(0.00002);
    }
    expect(worst).toBeGreaterThan(0); // quantisation is lossy, sanity check the test bites
  });

  it('rows without coordinates stay searchable but return none', () => {
    const withGap: LiveRow[] = rows.map((r) =>
      r.outward === 'ZE1' && r.inward === '0AA' ? { ...r, lat: NaN, lon: NaN } : r,
    );
    withGap.push({ outward: 'ZE9', inward: '1AA', lat: NaN, lon: NaN });
    withGap.push({ outward: 'ZE9', inward: '1AB', lat: NaN, lon: NaN });
    const built = buildFixture(withGap);
    expect(built.withoutCoordinates).toBe(3);
    const idx = PostcodeIndex.fromBuffer(built.buffer);

    const gap = idx.lookup('ZE1 0AA');
    expect(gap).toEqual({ postcode: 'ZE1 0AA', lat: undefined, lon: undefined });
    expect(idx.search('ZE1 0AA', 1)[0]).toEqual(gap);

    // A district with no coordinates at all gets a zero bounding box.
    const d = idx.outwards.indexOf('ZE9');
    expect(idx.districtBounds(d)).toEqual([0, 0, 0, 0]);
    expect(idx.search('ZE9', 10).map((r) => r.postcode)).toEqual(['ZE9 1AA', 'ZE9 1AB']);
    expect(idx.search('ZE9', 10).every((r) => r.lat === undefined && r.lon === undefined)).toBe(true);

    // The neighbour keeps its coordinates.
    const next = idx.lookup('ZE1 0AB')!;
    expect(next.lat).toBeCloseTo(rows.find((r) => r.inward === '0AB' && r.outward === 'ZE1')!.lat, 4);
    expect(NO_COORDINATE).toBe(0xffff);
  });

  it('buildIndex leaves the caller\'s districts and entries untouched and reports a summary', () => {
    const { districtsFromRows } = helpers;
    const districts = districtsFromRows(rows).reverse();
    const beforeOutwards = districts.map((d) => d.outward);
    const beforeInwards = districts.map((d) => d.entries.map((e) => e.inward));
    const result = buildIndex(districts, { release: 'X', builtAt: 'now', exclusions: [], sourceFiles: [] }, {
      extendMetadata: (summary) => ({ districtsSeen: summary.districtCount, worst: summary.precision[0].outward }),
    });
    expect(districts.map((d) => d.outward)).toEqual(beforeOutwards);
    expect(districts.map((d) => d.entries.map((e) => e.inward))).toEqual(beforeInwards);
    expect(result.postcodeCount).toBe(658);
    expect(result.precision.length).toBe(3);
    expect(result.metadata.districtsSeen).toBe(3);
    expect(result.metadata.worst).toBe('ZE2');
    expect(result.metadata.worstPrecisionM).toBe(result.worstPrecisionM);
    expect(PostcodeIndex.fromBuffer(result.buffer).metadata.worst).toBe('ZE2');
  });

  it('precision report is sorted worst first and within the 5 m threshold for ZE', () => {
    const report = index.precisionReport();
    expect(report.length).toBe(3);
    expect(report[0].precisionM).toBeGreaterThanOrEqual(report[1].precisionM);
    for (const d of report) expect(d.precisionM).toBeLessThan(5);
    expect(report[0].outward).toBe('ZE2'); // the large rural district is the worst
    expect(index.metadata.worstPrecisionM).toBeCloseTo(report[0].precisionM, 3);
  });
});
