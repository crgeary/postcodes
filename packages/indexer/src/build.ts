import { writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { buildIndex, PostcodeIndex } from '@postcode/index-format';
import { collectDistricts, type CollectCounts } from './collect.js';
import { DEFAULT_PRECISION_THRESHOLD_M, makeBuildReport, type BuildReport } from './report.js';

export interface BuildOptions {
  inputs: string[];
  output: string;
  release?: string;
  excludeNorthernIreland: boolean;
  excludeCrownDependencies: boolean;
  precisionThresholdM?: number;
  now?: () => Date;
  onProgress?: (counts: CollectCounts) => void;
}

export interface BuildOutcome {
  index: PostcodeIndex;
  report: BuildReport;
  counts: CollectCounts;
  fileBytes: number;
  thresholdM: number;
}

/** Derive a release label such as `FEB_2026` from an ONSPD file name. */
export function releaseFromFilename(path: string): string | undefined {
  const m = /ONSPD_([A-Z]{3}_\d{4})/i.exec(basename(path));
  return m ? m[1].toUpperCase() : undefined;
}

/**
 * Build an index file: stream the inputs, build the buffer once with the
 * metadata counts, then rebuild with the full report embedded so stdout and
 * the file agree. The second build is cheap compared with reading the CSV.
 */
export async function build(options: BuildOptions): Promise<BuildOutcome> {
  const thresholdM = options.precisionThresholdM ?? DEFAULT_PRECISION_THRESHOLD_M;
  const collected = await collectDistricts(options.inputs, {
    excludeNorthernIreland: options.excludeNorthernIreland,
    excludeCrownDependencies: options.excludeCrownDependencies,
    onProgress: options.onProgress,
  });
  const release = options.release ?? releaseFromFilename(options.inputs[0]) ?? 'unknown';
  const builtAt = (options.now ?? (() => new Date()))().toISOString();
  const base = {
    release,
    builtAt,
    exclusions: collected.exclusions,
    sourceFiles: collected.sourceFiles,
    countryColumn: collected.countryColumn,
  };

  const first = buildIndex(collected.districts, base);
  const firstIndex = PostcodeIndex.fromBuffer(first.buffer);
  // The report includes the file size, which depends on the metadata length.
  // Build once to measure, embed the report, then build again and re-measure;
  // the second size is the final one. Pad with the real size on the third pass
  // only if the digit count changed, which is vanishingly rare.
  let report = makeBuildReport(collected.counts, firstIndex, first.buffer.byteLength, thresholdM);
  let result = buildIndex(collected.districts, { ...base, report });
  if (result.buffer.byteLength !== report.fileBytes) {
    report = { ...report, fileBytes: result.buffer.byteLength };
    result = buildIndex(collected.districts, { ...base, report });
    if (result.buffer.byteLength !== report.fileBytes) {
      report = { ...report, fileBytes: result.buffer.byteLength };
      result = buildIndex(collected.districts, { ...base, report });
    }
  }
  writeFileSync(options.output, new Uint8Array(result.buffer));
  const index = PostcodeIndex.fromBuffer(result.buffer);
  return { index, report, counts: collected.counts, fileBytes: result.buffer.byteLength, thresholdM };
}
