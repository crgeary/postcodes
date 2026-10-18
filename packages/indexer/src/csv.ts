import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

/** The ONSPD columns the indexer needs, located by header name. */
export interface OnspdColumns {
  pcds: number;
  doterm: number;
  lat: number;
  long: number;
  ctry: number;
  ctryName: string;
  /** Highest index among the located columns; a row must have more fields than this. */
  maxIndex: number;
}

export interface OnspdRow {
  pcds: string;
  doterm: string;
  lat: string;
  long: string;
  ctry: string;
}

export class OnspdFormatError extends Error {
  override readonly name = 'OnspdFormatError';
}

/** Strip one pair of surrounding double quotes, if present. */
export function unquote(field: string): string {
  const n = field.length;
  if (n >= 2 && field.charCodeAt(0) === 34 && field.charCodeAt(n - 1) === 34) {
    return field.slice(1, n - 1);
  }
  return field;
}

/** Split a line on commas and unquote each field. ONSPD fields never contain commas. */
export function splitLine(line: string): string[] {
  const parts = line.split(',');
  for (let i = 0; i < parts.length; i++) parts[i] = unquote(parts[i]);
  return parts;
}

const CTRY_PATTERN = /^ctry\d{2}cd$/;

/**
 * Locate the required columns in a header row. Year-suffixed names such as
 * `ctry25cd` are matched by pattern so a renamed column in a later release
 * does not silently break the build; a missing column fails loudly.
 */
export function locateColumns(headerLine: string): OnspdColumns {
  const names = splitLine(headerLine).map((n) => n.trim().toLowerCase());
  const find = (name: string): number => {
    const i = names.indexOf(name);
    if (i < 0) throw new OnspdFormatError(`required column "${name}" not found in header`);
    return i;
  };
  const ctryIdx = names.findIndex((n) => CTRY_PATTERN.test(n));
  if (ctryIdx < 0) {
    throw new OnspdFormatError('required column matching ctry\\d{2}cd not found in header');
  }
  const columns = {
    pcds: find('pcds'),
    doterm: find('doterm'),
    lat: find('lat'),
    long: find('long'),
    ctry: ctryIdx,
  };
  return {
    ...columns,
    ctryName: names[ctryIdx],
    maxIndex: Math.max(columns.pcds, columns.doterm, columns.lat, columns.long, columns.ctry),
  };
}

/**
 * Stream an ONSPD CSV file line by line. The full UK file is about 1.4 GB and
 * must never be read whole.
 */
export async function* readOnspd(path: string): AsyncGenerator<OnspdRow, OnspdColumns, void> {
  const rl = createInterface({
    input: createReadStream(path, { encoding: 'utf8', highWaterMark: 1 << 20 }),
    crlfDelay: Infinity,
  });
  let columns: OnspdColumns | undefined;
  let lineNo = 0;
  for await (const line of rl) {
    lineNo++;
    if (columns === undefined) {
      columns = locateColumns(line.charCodeAt(0) === 0xfeff ? line.slice(1) : line);
      continue;
    }
    if (line.length === 0) continue;
    const f = splitLine(line);
    if (f.length <= columns.maxIndex) {
      throw new OnspdFormatError(`${path}:${lineNo}: row has ${f.length} fields, fewer than the header`);
    }
    yield {
      pcds: f[columns.pcds],
      doterm: f[columns.doterm],
      lat: f[columns.lat],
      long: f[columns.long],
      ctry: f[columns.ctry],
    };
  }
  if (columns === undefined) throw new OnspdFormatError(`${path}: empty file`);
  return columns;
}
