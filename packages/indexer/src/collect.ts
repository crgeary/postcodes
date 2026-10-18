import { basename } from 'node:path';
import { encodeInward, OUTWARD_MAX_LENGTH, OUTWARD_MIN_LENGTH, type BuildDistrict, type BuildEntry } from '@postcode/index-format';
import { readOnspd } from './csv.js';

/** ONSPD country codes used for exclusions. */
export const COUNTRY_NORTHERN_IRELAND = 'N92000002';
export const COUNTRY_CHANNEL_ISLANDS = 'L93000001';
export const COUNTRY_ISLE_OF_MAN = 'M83000003';

export interface CollectOptions {
  excludeNorthernIreland: boolean;
  excludeCrownDependencies: boolean;
  /** Called every `progressEvery` rows with the running counts. */
  onProgress?: (counts: CollectCounts) => void;
  progressEvery?: number;
}

export interface CollectCounts {
  rows: number;
  live: number;
  terminated: number;
  excluded: number;
  invalid: number;
  duplicates: number;
  withoutCoordinates: number;
}

export interface CollectResult {
  districts: BuildDistrict[];
  counts: CollectCounts;
  sourceFiles: string[];
  exclusions: string[];
  /** The ctry column name actually used, for the report. */
  countryColumn: string;
}

const INWARD_PATTERN = /^[0-9][ABDEFGHJLNPQRSTUWXYZ]{2}$/;
const OUTWARD_PATTERN = /^[A-Z0-9]{2,4}$/;

/** Parse an ONSPD coordinate; `lat > 90` is the no-grid-reference sentinel. */
export function parseCoordinate(lat: string, lon: string): [number, number] {
  if (lat === '' || lon === '') return [NaN, NaN];
  const la = Number(lat);
  const lo = Number(lon);
  if (!Number.isFinite(la) || !Number.isFinite(lo) || la > 90) return [NaN, NaN];
  return [la, lo];
}

export function exclusionLabels(options: Pick<CollectOptions, 'excludeNorthernIreland' | 'excludeCrownDependencies'>): string[] {
  const out: string[] = [];
  if (options.excludeNorthernIreland) out.push('ni');
  if (options.excludeCrownDependencies) out.push('crown-dependencies');
  return out;
}

/**
 * Stream one or more ONSPD files and collect live postcodes per district,
 * applying the row rules from PLAN.md. Memory is unconstrained here; only the
 * output file is.
 */
export async function collectDistricts(files: string[], options: CollectOptions): Promise<CollectResult> {
  const byOutward = new Map<string, Map<number, BuildEntry>>();
  const counts: CollectCounts = {
    rows: 0,
    live: 0,
    terminated: 0,
    excluded: 0,
    invalid: 0,
    duplicates: 0,
    withoutCoordinates: 0,
  };
  const excludedCountries = new Set<string>();
  if (options.excludeNorthernIreland) excludedCountries.add(COUNTRY_NORTHERN_IRELAND);
  if (options.excludeCrownDependencies) {
    excludedCountries.add(COUNTRY_CHANNEL_ISLANDS);
    excludedCountries.add(COUNTRY_ISLE_OF_MAN);
  }
  const progressEvery = options.progressEvery ?? 250_000;
  let countryColumn = '';

  for (const file of files) {
    const gen = readOnspd(file);
    for (;;) {
      const next = await gen.next();
      if (next.done) {
        countryColumn = next.value.ctryName;
        break;
      }
      const row = next.value;
      counts.rows++;
      if (options.onProgress && counts.rows % progressEvery === 0) options.onProgress(counts);

      if (row.doterm !== '') {
        counts.terminated++;
        continue;
      }
      if (excludedCountries.has(row.ctry)) {
        counts.excluded++;
        continue;
      }
      const sp = row.pcds.indexOf(' ');
      const outward = sp < 0 ? '' : row.pcds.slice(0, sp);
      const inward = sp < 0 ? '' : row.pcds.slice(sp + 1).trim();
      if (
        outward.length < OUTWARD_MIN_LENGTH ||
        outward.length > OUTWARD_MAX_LENGTH ||
        !OUTWARD_PATTERN.test(outward) ||
        !INWARD_PATTERN.test(inward)
      ) {
        counts.invalid++;
        continue;
      }
      const code = encodeInward(inward);
      let district = byOutward.get(outward);
      if (district === undefined) {
        district = new Map();
        byOutward.set(outward, district);
      }
      if (district.has(code)) {
        counts.duplicates++;
        continue;
      }
      const [lat, lon] = parseCoordinate(row.lat, row.long);
      if (Number.isNaN(lat)) counts.withoutCoordinates++;
      district.set(code, { inward: code, lat, lon });
      counts.live++;
    }
  }

  const districts: BuildDistrict[] = [];
  for (const [outward, entries] of byOutward) {
    districts.push({ outward, entries: [...entries.values()] });
  }
  return {
    districts,
    counts,
    sourceFiles: files.map((f) => basename(f)),
    exclusions: exclusionLabels(options),
    countryColumn,
  };
}
