import { utimesSync, writeFileSync } from 'node:fs';
import { PostcodeIndex } from '@postcode/index-format';
import { describe, expect, it } from 'vitest';
import { bootstrap } from '../src/bootstrap.js';
import { createLogger } from '../src/logger.js';
import { createRefresh } from '../src/refresh.js';
import { corrupt, fixtureBytes, startIndexHost, tempFile, testConfig } from './helpers.js';

const gc = (globalThis as { gc?: () => void }).gc;

function captureLogger() {
  const lines: Array<Record<string, unknown>> = [];
  const logger = createLogger('debug', {}, (line) => lines.push(JSON.parse(line)));
  return { logger, lines };
}

describe('refresh over HTTP', () => {
  it('a 304 is a no-op; a corrupt download keeps the old index; a valid one swaps', async () => {
    const host = await startIndexHost(fixtureBytes(), '"v1"');
    try {
      const { logger, lines } = captureLogger();
      const { holder, refresh } = await bootstrap(testConfig({ indexSource: host.url }), logger);
      refresh.stop();
      const original = holder.current!;

      // Unchanged: conditional request answered 304, same index object kept.
      await refresh.runOnce();
      expect(host.requests.at(-1)).toEqual({ ifNoneMatch: '"v1"', status: 304 });
      expect(holder.current).toBe(original);
      expect(holder.refresh).toMatchObject({ lastError: null, running: false });
      expect(holder.refresh.lastSuccessAt).not.toBeNull();
      expect(holder.refresh.lastSwapAt).toBeNull();

      // Corrupt: downloaded, rejected, old index kept, lastError set, readiness untouched.
      host.setBody(corrupt(fixtureBytes({ release: 'MAY_2026' })), '"v2"');
      await refresh.runOnce();
      expect(host.requests.at(-1)).toEqual({ ifNoneMatch: '"v1"', status: 200 });
      expect(holder.current).toBe(original);
      expect(holder.ready).toBe(true);
      expect(holder.refresh.lastError).toMatch(/checksum/);
      expect(holder.info!.etag).toBe('"v1"');
      expect(lines.some((l) => l.msg === 'refresh failed; keeping current index')).toBe(true);

      // Valid: swapped, ETag advanced, error cleared.
      host.setBody(fixtureBytes({ release: 'MAY_2026', dropFirst: 8 }), '"v3"');
      await refresh.runOnce();
      expect(holder.current).not.toBe(original);
      expect(holder.current!.metadata.release).toBe('MAY_2026');
      expect(holder.current!.postcodeCount).toBe(650);
      expect(holder.info!.etag).toBe('"v3"');
      expect(holder.refresh.lastError).toBeNull();
      expect(holder.refresh.lastSwapAt).not.toBeNull();
      expect(lines.find((l) => l.msg === 'refresh: swapped index')).toMatchObject({ release: 'MAY_2026', previousRelease: 'FEB_2026' });

      // The old index is still usable by an in-flight request holding it.
      expect(original.lookup('ZE1 0AA')).not.toBeNull();
    } finally {
      await host.close();
    }
  });

  it('a transport error records lastError and keeps serving', async () => {
    const host = await startIndexHost(fixtureBytes());
    const { holder, refresh } = await bootstrap(testConfig({ indexSource: host.url }), captureLogger().logger);
    refresh.stop();
    await host.close();
    await refresh.runOnce();
    expect(holder.ready).toBe(true);
    expect(holder.refresh.lastError).toMatch(/fetch|ECONNREFUSED|TypeError/);
  });
});

describe('refresh from a file', () => {
  it('skips when mtime and size are unchanged and swaps when the file changes', async () => {
    const path = tempFile('ze.idx', fixtureBytes());
    const { holder, refresh } = await bootstrap(testConfig({ indexSource: path }), captureLogger().logger);
    refresh.stop();
    const original = holder.current!;
    await refresh.runOnce();
    expect(holder.current).toBe(original);

    writeFileSync(path, fixtureBytes({ release: 'MAY_2026', dropFirst: 1 }));
    const future = new Date(Date.now() + 10_000);
    utimesSync(path, future, future);
    await refresh.runOnce();
    expect(holder.current!.metadata.release).toBe('MAY_2026');
    expect(holder.current!.postcodeCount).toBe(657);
  });

  it('a corrupt replacement file keeps the old index', async () => {
    const path = tempFile('ze.idx', fixtureBytes());
    const { holder, refresh } = await bootstrap(testConfig({ indexSource: path }), captureLogger().logger);
    refresh.stop();
    const original = holder.current!;
    writeFileSync(path, corrupt(fixtureBytes({ dropFirst: 2 })));
    const future = new Date(Date.now() + 10_000);
    utimesSync(path, future, future);
    await refresh.runOnce();
    expect(holder.current).toBe(original);
    expect(holder.refresh.lastError).toMatch(/checksum/);
  });
});

describe('refresh scheduling', () => {
  it('starts an unref\'d timer with jitter when enabled and skips overlapping cycles', async () => {
    const path = tempFile('ze.idx', fixtureBytes());
    const scheduled: number[] = [];
    let unrefCalled = false;
    const fakeTimer = ((fn: () => void, ms: number) => {
      scheduled.push(ms);
      const handle = { unref: () => (unrefCalled = true), fn };
      return handle as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout;
    const { logger, lines } = captureLogger();
    const { holder, refresh } = await bootstrap(testConfig({ indexSource: path, refreshMs: 1000, refreshJitter: 0.1 }), logger, {
      random: () => 1, // +10% jitter
      setTimer: fakeTimer,
      clearTimer: (() => {}) as typeof clearTimeout,
    });
    expect(holder.refresh).toMatchObject({ enabled: true, intervalMs: 1000 });
    expect(scheduled).toEqual([1100]);
    expect(unrefCalled).toBe(true);

    // Overlap: a cycle that is still running makes the next one a no-op.
    holder.refresh.running = true;
    await refresh.runOnce();
    expect(lines.some((l) => String(l.msg).includes('skipped'))).toBe(true);
    holder.refresh.running = false;
    refresh.stop();
  });

  it('runs no timer when the interval is 0', async () => {
    const path = tempFile('ze.idx', fixtureBytes());
    const { holder } = await bootstrap(testConfig({ indexSource: path, refreshMs: 0 }), captureLogger().logger);
    expect(holder.refresh.enabled).toBe(false);
  });
});

describe('refresh memory', () => {
  it.skipIf(!gc)('old index buffers are released after GC across ten refreshes', async () => {
    const host = await startIndexHost(fixtureBytes(), '"v0"');
    try {
      const { holder, refresh } = await bootstrap(testConfig({ indexSource: host.url }), captureLogger().logger);
      refresh.stop();
      const indexBytes = holder.current!.byteLength;
      gc!();
      const baseline = process.memoryUsage().arrayBuffers;
      let peak = 0;
      for (let i = 1; i <= 10; i++) {
        host.setBody(fixtureBytes({ dropFirst: i }), `"v${i}"`);
        await refresh.runOnce();
        expect(holder.current!.postcodeCount).toBe(658 - i);
        gc!();
        peak = Math.max(peak, process.memoryUsage().arrayBuffers - baseline);
      }
      // Only the current index should remain; allow one extra copy for anything in flight.
      expect(peak).toBeLessThan(indexBytes * 2);
      expect(PostcodeIndex).toBeDefined();
    } finally {
      await host.close();
    }
  });
});
