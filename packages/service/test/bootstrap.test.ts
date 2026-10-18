import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { bootstrap } from '../src/bootstrap.js';
import { ConfigError, DEFAULTS, loadConfig } from '../src/config.js';
import { loadFromFile, sourceKind } from '../src/loaders.js';
import { createLogger } from '../src/logger.js';
import { corrupt, fixtureBytes, startIndexHost, tempFile, testConfig } from './helpers.js';

function captureLogger() {
  const lines: Array<Record<string, unknown>> = [];
  const logger = createLogger('debug', {}, (line) => lines.push(JSON.parse(line)));
  return { logger, lines };
}

describe('config', () => {
  it('uses the documented defaults', () => {
    expect(loadConfig({})).toEqual(DEFAULTS);
    expect(DEFAULTS.indexSource).toBe('./data/postcodes.idx');
    expect(DEFAULTS.refreshMs).toBe(0);
    expect(DEFAULTS.searchDefaultLimit).toBe(10);
    expect(DEFAULTS.searchMaxLimit).toBe(50);
    expect(DEFAULTS.port).toBe(3000);
  });

  it('reads and validates environment variables', () => {
    const c = loadConfig({
      POSTCODE_INDEX: 'https://example.test/postcodes.idx',
      POSTCODE_INDEX_FALLBACK: './data/postcodes.idx',
      POSTCODE_INDEX_REFRESH_MS: '3600000',
      POSTCODE_INDEX_REFRESH_JITTER: '0.2',
      POSTCODE_INDEX_FETCH_TIMEOUT_MS: '5000',
      SEARCH_DEFAULT_LIMIT: '5',
      SEARCH_MAX_LIMIT: '20',
      PORT: '8080',
      LOG_LEVEL: 'debug',
    });
    expect(c).toMatchObject({
      indexSource: 'https://example.test/postcodes.idx',
      indexFallback: './data/postcodes.idx',
      refreshMs: 3_600_000,
      refreshJitter: 0.2,
      fetchTimeoutMs: 5000,
      searchDefaultLimit: 5,
      searchMaxLimit: 20,
      port: 8080,
      logLevel: 'debug',
    });
    expect(() => loadConfig({ POSTCODE_INDEX_REFRESH_MS: 'soon' })).toThrow(ConfigError);
    expect(() => loadConfig({ POSTCODE_INDEX_REFRESH_JITTER: '2' })).toThrow(ConfigError);
    expect(() => loadConfig({ SEARCH_DEFAULT_LIMIT: '60' })).toThrow(/exceed/);
    expect(() => loadConfig({ LOG_LEVEL: 'loud' })).toThrow(ConfigError);
  });

  it('selects the loader by scheme', () => {
    expect(sourceKind('./data/postcodes.idx')).toBe('file');
    expect(sourceKind('/abs/postcodes.idx')).toBe('file');
    expect(sourceKind('http://host/p.idx')).toBe('url');
    expect(sourceKind('HTTPS://host/p.idx')).toBe('url');
  });
});

describe('bootstrap', () => {
  it('starts from a file and records mtime and size', async () => {
    const path = tempFile('ze.idx', fixtureBytes());
    const { logger, lines } = captureLogger();
    const { holder, refresh } = await bootstrap(testConfig({ indexSource: path }), logger);
    refresh.stop();
    expect(holder.ready).toBe(true);
    expect(holder.current!.postcodeCount).toBe(658);
    expect(holder.info).toMatchObject({ source: path, sourceKind: 'file', fallback: false, size: readFileSync(path).byteLength });
    expect(holder.info!.mtimeMs).toBeGreaterThan(0);
    expect(holder.refresh.enabled).toBe(false);
    expect(lines.find((l) => l.msg === 'index loaded')).toMatchObject({ release: 'FEB_2026', postcodes: 658 });
  });

  it('starts from a URL and records the ETag', async () => {
    const host = await startIndexHost(fixtureBytes(), '"etag-1"');
    try {
      const { holder, refresh } = await bootstrap(testConfig({ indexSource: host.url }), captureLogger().logger);
      refresh.stop();
      expect(holder.current!.postcodeCount).toBe(658);
      expect(holder.info).toMatchObject({ source: host.url, sourceKind: 'url', etag: '"etag-1"', fallback: false });
      expect(host.requests).toEqual([{ ifNoneMatch: undefined, status: 200 }]);
    } finally {
      await host.close();
    }
  });

  it('refuses a corrupt file and uses the fallback, logging that it is in use', async () => {
    const bad = tempFile('bad.idx', corrupt(fixtureBytes()));
    const good = tempFile('good.idx', fixtureBytes());
    const { logger, lines } = captureLogger();
    const { holder, refresh } = await bootstrap(testConfig({ indexSource: bad, indexFallback: good }), logger);
    refresh.stop();
    expect(holder.ready).toBe(true);
    expect(holder.info).toMatchObject({ source: good, fallback: true });
    expect(lines.some((l) => l.msg === 'serving from fallback index')).toBe(true);
    expect(lines.find((l) => l.msg === 'primary index failed; trying fallback')!.error).toMatch(/checksum/);
  });

  it('exits non-zero (throws) when nothing loads', async () => {
    const bad = tempFile('bad.idx', corrupt(fixtureBytes()));
    const { logger } = captureLogger();
    await expect(bootstrap(testConfig({ indexSource: bad }), logger)).rejects.toThrow(/checksum/);
    await expect(bootstrap(testConfig({ indexSource: '/nonexistent/p.idx', indexFallback: bad }), logger)).rejects.toThrow(/checksum/);
  });

  it('a URL that fails falls back to the bundled file', async () => {
    const host = await startIndexHost(fixtureBytes());
    const good = tempFile('good.idx', fixtureBytes());
    try {
      const { holder, refresh } = await bootstrap(
        testConfig({ indexSource: host.url.replace('postcodes.idx', 'missing.idx'), indexFallback: good }),
        captureLogger().logger,
      );
      refresh.stop();
      expect(holder.info).toMatchObject({ source: good, fallback: true });
    } finally {
      await host.close();
    }
  });

  it('file loader reports unchanged when mtime and size match', async () => {
    const path = tempFile('ze.idx', fixtureBytes());
    const first = loadFromFile(path, { timeoutMs: 1000 });
    expect(first.kind).toBe('loaded');
    if (first.kind !== 'loaded') throw new Error('unreachable');
    expect(loadFromFile(path, { timeoutMs: 1000, previous: first.info }).kind).toBe('unchanged');
  });
});
