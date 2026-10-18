import { createServer, type Server } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { buildIndex } from '@postcode/index-format';
import { buildFixture, districtsFromRows, readLiveRows, type LiveRow } from '../../index-format/test/helpers/fixture.js';
import { DEFAULTS, type ServiceConfig } from '../src/config.js';

export { buildFixture, readLiveRows };

/** Index bytes for the ZE fixture, optionally with a different release label or rows removed. */
export function fixtureBytes(opts: { release?: string; dropFirst?: number } = {}): Uint8Array {
  const rows: LiveRow[] = readLiveRows().slice(opts.dropFirst ?? 0);
  const built = buildIndex(districtsFromRows(rows), {
    release: opts.release ?? 'FEB_2026',
    builtAt: '2026-10-18T00:00:00.000Z',
    exclusions: [],
    sourceFiles: ['ONSPD_FEB_2026_UK_ZE.csv'],
  });
  return new Uint8Array(built.buffer);
}

export function corrupt(bytes: Uint8Array): Uint8Array {
  const c = bytes.slice();
  c[c.length - 3] ^= 0x55;
  return c;
}

export function tempFile(name: string, bytes: Uint8Array): string {
  const dir = mkdtempSync(join(tmpdir(), 'postcode-service-'));
  const path = join(dir, name);
  writeFileSync(path, bytes);
  return path;
}

export function testConfig(overrides: Partial<ServiceConfig> = {}): ServiceConfig {
  return { ...DEFAULTS, ...overrides };
}

/** A tiny index host with ETag support, so bootstrap and refresh can be tested over real HTTP. */
export interface IndexHost {
  url: string;
  server: Server;
  setBody(bytes: Uint8Array, etag: string): void;
  requests: Array<{ ifNoneMatch: string | undefined; status: number }>;
  close(): Promise<void>;
}

export async function startIndexHost(bytes: Uint8Array, etag = '"v1"'): Promise<IndexHost> {
  let body = bytes;
  let currentEtag = etag;
  const requests: IndexHost['requests'] = [];
  const server = createServer((req, res) => {
    const inm = req.headers['if-none-match'];
    if (req.url !== '/postcodes.idx') {
      requests.push({ ifNoneMatch: inm, status: 404 });
      res.writeHead(404).end();
      return;
    }
    if (inm === currentEtag) {
      requests.push({ ifNoneMatch: inm, status: 304 });
      res.writeHead(304, { etag: currentEtag }).end();
      return;
    }
    requests.push({ ifNoneMatch: inm, status: 200 });
    res.writeHead(200, { 'content-type': 'application/octet-stream', etag: currentEtag, 'content-length': body.byteLength });
    res.end(Buffer.from(body.buffer, body.byteOffset, body.byteLength));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/postcodes.idx`,
    server,
    requests,
    setBody(b, e) {
      body = b;
      currentEtag = e;
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
