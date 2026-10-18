import type { BuildSummary, DistrictPrecision, IndexMetadata, PostcodeIndex } from '@postcode/index-format';
import type { CollectCounts } from './collect.js';

/** Default alert threshold: a district worse than this usually has an outlier coordinate. */
export const DEFAULT_PRECISION_THRESHOLD_M = 5;

/** Counts stored in the index metadata under `report`. The file size is not embedded; inspect reads it from disk. */
export interface BuildReport {
  postcodes: number;
  districts: number;
  skipped: {
    terminated: number;
    excluded: number;
    invalid: number;
    duplicates: number;
  };
  withoutCoordinates: number;
  precisionThresholdM: number;
  worstPrecisionM: number;
  worstDistricts: Array<{ outward: string; postcodes: number; precisionM: number }>;
}

export function makeBuildReport(counts: CollectCounts, summary: BuildSummary, thresholdM: number): BuildReport {
  const precision = summary.precision;
  return {
    postcodes: summary.postcodeCount,
    districts: summary.districtCount,
    skipped: {
      terminated: counts.terminated,
      excluded: counts.excluded,
      invalid: counts.invalid,
      duplicates: counts.duplicates,
    },
    withoutCoordinates: counts.withoutCoordinates,
    precisionThresholdM: thresholdM,
    worstPrecisionM: precision.length > 0 ? round3(precision[0].precisionM) : 0,
    worstDistricts: precision.slice(0, 10).map((d) => ({
      outward: d.outward,
      postcodes: d.postcodes,
      precisionM: round3(d.precisionM),
    })),
  };
}

export function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

export function districtsOverThreshold(precision: DistrictPrecision[], thresholdM: number): DistrictPrecision[] {
  return precision.filter((d) => d.precisionM > thresholdM);
}

function fmtBytes(n: number): string {
  if (n >= 1 << 20) return `${(n / (1 << 20)).toFixed(2)} MiB`;
  if (n >= 1 << 10) return `${(n / (1 << 10)).toFixed(1)} KiB`;
  return `${n} B`;
}

/** Human-readable report for stdout, shared by `build` and `inspect`. `precision` is `index.precisionReport()`, computed once by the caller. */
export function formatReport(
  metadata: IndexMetadata,
  index: PostcodeIndex,
  fileBytes: number,
  thresholdM: number,
  precision: DistrictPrecision[],
): string {
  const lines: string[] = [];
  const report = metadata.report as BuildReport | undefined;
  lines.push(`Release:        ${metadata.release}`);
  lines.push(`Built at:       ${metadata.builtAt}`);
  lines.push(`Source files:   ${metadata.sourceFiles.join(', ')}`);
  lines.push(`Exclusions:     ${metadata.exclusions.length ? metadata.exclusions.join(', ') : 'none'}`);
  lines.push(`Postcodes:      ${index.postcodeCount.toLocaleString('en-GB')}`);
  lines.push(`Districts:      ${index.districtCount.toLocaleString('en-GB')}`);
  lines.push(`File size:      ${fmtBytes(fileBytes)} (${fileBytes.toLocaleString('en-GB')} bytes)`);
  if (report) {
    lines.push('Skipped rows:');
    lines.push(`  terminated:   ${report.skipped.terminated.toLocaleString('en-GB')}`);
    lines.push(`  excluded:     ${report.skipped.excluded.toLocaleString('en-GB')}`);
    lines.push(`  invalid:      ${report.skipped.invalid.toLocaleString('en-GB')}`);
    lines.push(`  duplicates:   ${report.skipped.duplicates.toLocaleString('en-GB')}`);
    lines.push(`Without coords: ${report.withoutCoordinates.toLocaleString('en-GB')}`);
  }
  const worst = precision.length > 0 ? precision[0].precisionM : 0;
  lines.push(`Worst precision: ${worst.toFixed(3)} m (threshold ${thresholdM} m)`);
  lines.push('Ten worst districts:');
  for (const d of precision.slice(0, 10)) {
    lines.push(
      `  ${d.outward.padEnd(4)}  ${d.precisionM.toFixed(3).padStart(8)} m  ${String(d.postcodes).padStart(6)} postcodes  ` +
        `lat span ${d.latSpan.toFixed(4)}  lon span ${d.lonSpan.toFixed(4)}`,
    );
  }
  const over = districtsOverThreshold(precision, thresholdM);
  if (over.length > 0) {
    lines.push(
      `ALERT: ${over.length} district(s) exceed ${thresholdM} m: ${over.map((d) => d.outward).join(', ')}. ` +
        'This usually means an outlier coordinate is widening the bounding box.',
    );
  }
  return lines.join('\n');
}
