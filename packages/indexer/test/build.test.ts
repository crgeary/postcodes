import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostcodeIndex } from '@postcode/index-format';
import { describe, expect, it } from 'vitest';
import { build, releaseFromFilename } from '../src/build.js';
import { collectDistricts, COUNTRY_CHANNEL_ISLANDS, COUNTRY_ISLE_OF_MAN, COUNTRY_NORTHERN_IRELAND } from '../src/collect.js';
import { inspect } from '../src/inspect.js';
import { districtsOverThreshold, type BuildReport } from '../src/report.js';
import { row, tempDir, writeCsv } from './helpers.js';

const ZE_CSV = fileURLToPath(new URL('../../../fixtures/ONSPD_FEB_2026_UK_ZE.csv', import.meta.url));

describe('row rules', () => {
  it('skips terminated rows, counts invalid ones and deduplicates across files', async () => {
    const dir = tempDir();
    const a = writeCsv(dir, 'a.csv', [
      row({ pcds: 'AB1 0AA' }),
      row({ pcds: 'AB1 0AB', doterm: '202001' }),
      row({ pcds: 'AB1 0AD', quoted: false }),
      row({ pcds: 'AB1 0CA' }), // C is not an inward letter
      row({ pcds: 'A 0AA' }), // outward too short
    ]);
    const b = writeCsv(dir, 'b.csv', [row({ pcds: 'AB1 0AA' }), row({ pcds: 'AB2 1ZZ' })]);
    const r = await collectDistricts([a, b], { excludeNorthernIreland: false, excludeCrownDependencies: false });
    expect(r.counts).toEqual({
      rows: 7,
      live: 3,
      terminated: 1,
      excluded: 0,
      invalid: 2,
      duplicates: 1,
      withoutCoordinates: 0,
    });
    expect(r.districts.map((d) => d.outward).sort()).toEqual(['AB1', 'AB2']);
    expect(r.sourceFiles).toEqual(['a.csv', 'b.csv']);
    expect(r.countryColumn).toBe('ctry25cd');
  });

  it('excludes by country code according to the flags', async () => {
    const dir = tempDir();
    const path = writeCsv(dir, 'a.csv', [
      row({ pcds: 'BT1 1AA', ctry: COUNTRY_NORTHERN_IRELAND }),
      row({ pcds: 'GY1 1AA', ctry: COUNTRY_CHANNEL_ISLANDS }),
      row({ pcds: 'IM1 1AA', ctry: COUNTRY_ISLE_OF_MAN }),
      row({ pcds: 'SW1A 1AA', ctry: 'E92000001' }),
    ]);
    const all = await collectDistricts([path], { excludeNorthernIreland: false, excludeCrownDependencies: false });
    expect(all.counts.live).toBe(4);
    expect(all.exclusions).toEqual([]);

    const noNi = await collectDistricts([path], { excludeNorthernIreland: true, excludeCrownDependencies: false });
    expect(noNi.counts.excluded).toBe(1);
    expect(noNi.districts.map((d) => d.outward).sort()).toEqual(['GY1', 'IM1', 'SW1A']);
    expect(noNi.exclusions).toEqual(['ni']);

    const gb = await collectDistricts([path], { excludeNorthernIreland: true, excludeCrownDependencies: true });
    expect(gb.counts.excluded).toBe(3);
    expect(gb.districts.map((d) => d.outward)).toEqual(['SW1A']);
    expect(gb.exclusions).toEqual(['ni', 'crown-dependencies']);
  });

  it('treats lat > 90, empty and non-numeric coordinates as missing', async () => {
    const dir = tempDir();
    const path = writeCsv(dir, 'a.csv', [
      row({ pcds: 'AB1 0AA', lat: '99.999999', long: '0.000000' }),
      row({ pcds: 'AB1 0AB', lat: '', long: '' }),
      row({ pcds: 'AB1 0AD', lat: 'abc', long: '1' }),
      row({ pcds: 'AB1 0AE', lat: '57.1', long: '-2.1' }),
    ]);
    const r = await collectDistricts([path], { excludeNorthernIreland: false, excludeCrownDependencies: false });
    expect(r.counts.withoutCoordinates).toBe(3);
    expect(r.counts.live).toBe(4);
  });

  it('uses a renamed country column', async () => {
    const dir = tempDir();
    const path = writeCsv(dir, 'a.csv', [row({ pcds: 'BT1 1AA', ctry: COUNTRY_NORTHERN_IRELAND })], 'pcd7,pcd8,pcds,dointr,doterm,ctry26cd,lat,long,other');
    const r = await collectDistricts([path], { excludeNorthernIreland: true, excludeCrownDependencies: false });
    expect(r.counts.excluded).toBe(1);
    expect(r.countryColumn).toBe('ctry26cd');
  });
});

describe('build and inspect', () => {
  it('builds the ZE sample, embeds the report, and inspect verifies it', async () => {
    const dir = tempDir();
    const out = join(dir, 'ze.idx');
    const outcome = await build({
      inputs: [ZE_CSV],
      output: out,
      excludeNorthernIreland: false,
      excludeCrownDependencies: false,
      now: () => new Date('2026-10-18T12:00:00Z'),
    });
    expect(outcome.index.postcodeCount).toBe(658);
    expect(outcome.index.districtCount).toBe(3);
    expect(outcome.index.metadata.release).toBe('FEB_2026');
    expect(outcome.index.metadata.builtAt).toBe('2026-10-18T12:00:00.000Z');
    expect(outcome.index.metadata.sourceFiles).toEqual(['ONSPD_FEB_2026_UK_ZE.csv']);
    expect(statSync(out).size).toBe(outcome.fileBytes);

    const loaded = PostcodeIndex.fromBytes(readFileSync(out));
    const report = loaded.metadata.report as BuildReport;
    expect(report.postcodes).toBe(658);
    expect(report).not.toHaveProperty('fileBytes');
    expect(existsSync(out + '.tmp')).toBe(false);
    expect(outcome.precision[0].outward).toBe('ZE2');
    expect(report.skipped.terminated).toBe(762 - 1 - 658);
    expect(report.worstDistricts[0].outward).toBe('ZE2');
    expect(loaded.metadata.worstPrecisionM).toBeCloseTo(report.worstPrecisionM, 2);

    const text = inspect(out).text;
    expect(text).toContain('Postcodes:      658');
    expect(text).toContain('(verified)');
    expect(text).toContain('Ten worst districts:');
    expect(text).not.toContain('ALERT');
  });

  it('flags an injected outlier coordinate in the precision report', async () => {
    const dir = tempDir();
    const lines: string[] = [];
    for (let i = 0; i < 20; i++) {
      lines.push(row({ pcds: `AB1 0A${'ABDEFGHJLNPQRSTUWXYZ'[i]}`, lat: (57.1 + i * 0.0001).toFixed(6), long: '-2.1' }));
    }
    // One postcode 1 degree away widens the box to ~111 km, about 1.7 m per step.
    lines.push(row({ pcds: 'AB1 0BA', lat: '58.1', long: '-2.1' }));
    lines.push(row({ pcds: 'AB2 0AA', lat: '57.1', long: '-2.1' }));
    const path = writeCsv(dir, 'ONSPD_MAY_2026_UK_AB.csv', lines);
    const outcome = await build({
      inputs: [path],
      output: join(dir, 'ab.idx'),
      excludeNorthernIreland: false,
      excludeCrownDependencies: false,
      precisionThresholdM: 1,
    });
    expect(outcome.index.metadata.release).toBe('MAY_2026');
    const over = districtsOverThreshold(outcome.precision, outcome.thresholdM);
    expect(outcome.precision).toEqual(outcome.index.precisionReport());
    expect(over.map((d) => d.outward)).toEqual(['AB1']);
    expect(over[0].precisionM).toBeGreaterThan(1.5);
    const text = inspect(join(dir, 'ab.idx')).text;
    expect(text).toContain('ALERT: 1 district(s) exceed 1 m: AB1');
  });

  it('derives the release from the file name', () => {
    expect(releaseFromFilename('/x/ONSPD_FEB_2026_UK.csv')).toBe('FEB_2026');
    expect(releaseFromFilename('/x/multi_csv/ONSPD_feb_2026_UK_ZE.csv')).toBe('FEB_2026');
    expect(releaseFromFilename('/x/postcodes.csv')).toBeUndefined();
  });

  it('inspect rejects a corrupt file', async () => {
    const dir = tempDir();
    const out = join(dir, 'ze.idx');
    await build({ inputs: [ZE_CSV], output: out, excludeNorthernIreland: false, excludeCrownDependencies: false });
    const bytes = readFileSync(out);
    bytes[bytes.length - 2] ^= 0xff;
    const { writeFileSync } = await import('node:fs');
    writeFileSync(out, bytes);
    expect(() => inspect(out)).toThrow(/checksum/);
  });
});
