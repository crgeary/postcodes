import { describe, expect, it } from 'vitest';
import { locateColumns, OnspdFormatError, readOnspd, splitLine, unquote } from '../src/csv.js';
import { HEADER, row, tempDir, writeCsv } from './helpers.js';

describe('field parsing', () => {
  it('strips one pair of surrounding quotes only', () => {
    expect(unquote('"ZE1 0AA"')).toBe('ZE1 0AA');
    expect(unquote('60.15')).toBe('60.15');
    expect(unquote('""')).toBe('');
    expect(unquote('"')).toBe('"');
  });

  it('splits mixed quoted and unquoted fields', () => {
    expect(splitLine('"ZE1 0AA","",60.153231,-1.141602,"S92000003"')).toEqual([
      'ZE1 0AA',
      '',
      '60.153231',
      '-1.141602',
      'S92000003',
    ]);
  });
});

describe('column location', () => {
  it('finds columns by name, case-insensitively', () => {
    const c = locateColumns('PCDS,doterm,lat,long,ctry25cd');
    expect(c).toMatchObject({ pcds: 0, doterm: 1, lat: 2, long: 3, ctry: 4, ctryName: 'ctry25cd' });
  });

  it('matches a renamed year-suffixed country column', () => {
    const c = locateColumns('pcds,doterm,lat,long,ctry26cd');
    expect(c.ctry).toBe(4);
    expect(c.ctryName).toBe('ctry26cd');
  });

  it('fails loudly when a column is missing', () => {
    expect(() => locateColumns('pcds,doterm,lat,ctry25cd')).toThrow(OnspdFormatError);
    expect(() => locateColumns('pcds,doterm,lat,long')).toThrow(/ctry/);
    expect(() => locateColumns('pcd,doterm,lat,long,ctry25cd')).toThrow(/pcds/);
  });
});

describe('streaming reader', () => {
  it('reads quoted and unquoted rows and tolerates a BOM and CRLF', async () => {
    const dir = tempDir();
    const path = writeCsv(dir, 'a.csv', [row({ pcds: 'AB1 0AA', quoted: true }), row({ pcds: 'AB1 0AB', quoted: false })], '﻿' + HEADER + '\r');
    const rows = [];
    const gen = readOnspd(path);
    for (;;) {
      const n = await gen.next();
      if (n.done) {
        expect(n.value.ctryName).toBe('ctry25cd');
        break;
      }
      rows.push(n.value);
    }
    expect(rows.map((r) => r.pcds)).toEqual(['AB1 0AA', 'AB1 0AB']);
    expect(rows[0]).toMatchObject({ doterm: '', ctry: 'E92000001', lat: '51.5', long: '-0.1' });
  });

  it('rejects a short row', async () => {
    const dir = tempDir();
    const path = writeCsv(dir, 'a.csv', ['"AB1 0AA","x"']);
    await expect(async () => {
      for await (const _ of readOnspd(path)) void _;
    }).rejects.toThrow(/fewer than the header/);
  });

  it('rejects a row that stops just before the last required column, whichever it is', async () => {
    const dir = tempDir();
    // lat is the final column here; a row with every field but lat must fail loudly,
    // not be read as a postcode without coordinates.
    const path = writeCsv(dir, 'a.csv', ['"AB1 0AA","","E92000001",-0.1'], 'pcds,doterm,ctry25cd,long,lat');
    await expect(async () => {
      for await (const _ of readOnspd(path)) void _;
    }).rejects.toThrow(/4 fields, fewer than the header/);
    expect(locateColumns('pcds,doterm,ctry25cd,long,lat').maxIndex).toBe(4);
  });
});
