import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { buildIndex, PostcodeIndex, type DistrictPrecision } from '@postcode/index-format';
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
  /** Per-district precision, worst first, from the build. */
  precision: DistrictPrecision[];
}

/** Derive a release label such as `FEB_2026` from an ONSPD file name. */
export function releaseFromFilename(path: string): string | undefined {
  const m = /ONSPD_([A-Z]{3}_\d{4})/i.exec(basename(path));
  return m ? m[1].toUpperCase() : undefined;
}

/**
 * Build an index file: stream the inputs, build the buffer once with the
 * report embedded via the builder's summary callback, and write it
 * atomically (temp file + rename) so a reader never sees a partial file.
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

  let report: BuildReport | undefined;
  const result = buildIndex(collected.districts, base, {
    extendMetadata: (summary) => {
      report = makeBuildReport(collected.counts, summary, thresholdM);
      return { report };
    },
  });
  mkdirSync(dirname(options.output), { recursive: true });
  const tmp = `${options.output}.tmp`;
  writeFileSync(tmp, new Uint8Array(result.buffer));
  renameSync(tmp, options.output);
  const index = PostcodeIndex.fromBuffer(result.buffer);
  return {
    index,
    report: report!,
    counts: collected.counts,
    fileBytes: result.buffer.byteLength,
    thresholdM,
    precision: result.precision,
  };
}
