import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const HEADER = 'pcd7,pcd8,pcds,dointr,doterm,ctry25cd,lat,long,other';

export interface RowSpec {
  pcds: string;
  doterm?: string;
  ctry?: string;
  lat?: string;
  long?: string;
  quoted?: boolean;
}

export function row(spec: RowSpec): string {
  const [outward, inward] = spec.pcds.split(' ');
  const pcd7 = (outward + inward).padEnd(7, ' ');
  const fields = [pcd7, spec.pcds, spec.pcds, '198001', spec.doterm ?? '', spec.ctry ?? 'E92000001'];
  const q = spec.quoted ?? true;
  const quoted = fields.map((f) => (q ? `"${f}"` : f));
  return [...quoted, spec.lat ?? '51.5', spec.long ?? '-0.1', q ? '"x"' : 'x'].join(',');
}

export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'postcode-indexer-'));
}

export function writeCsv(dir: string, name: string, lines: string[], header = HEADER): string {
  const path = join(dir, name);
  writeFileSync(path, [header, ...lines].join('\n') + '\n');
  return path;
}
