import { readFileSync } from 'node:fs';
import { checksumHex, PostcodeIndex } from '@postcode/index-format';
import { DEFAULT_PRECISION_THRESHOLD_M, formatReport, type BuildReport } from './report.js';

export interface InspectResult {
  index: PostcodeIndex;
  text: string;
}

/** Load, validate (magic, version, length, checksum) and describe an index file. */
export function inspect(path: string, thresholdM?: number): InspectResult {
  const bytes = readFileSync(path);
  const index = PostcodeIndex.fromBytes(bytes);
  const h = index.header;
  const report = index.metadata.report as BuildReport | undefined;
  const threshold = thresholdM ?? report?.precisionThresholdM ?? DEFAULT_PRECISION_THRESHOLD_M;
  const lines = [
    `File:           ${path}`,
    `Format version: ${h.version}`,
    `Flags:          0x${h.flags.toString(16).padStart(4, '0')} (coordinates: ${index.hasCoordinates ? 'yes' : 'no'})`,
    `Checksum:       sha256:${checksumHex(h.checksum)} (verified)`,
    `Metadata:       ${h.metadataLength} bytes`,
    formatReport(index.metadata, index, bytes.byteLength, threshold, index.precisionReport()),
  ];
  return { index, text: lines.join('\n') };
}
