import { PostcodeIndex } from '@postcode/index-format';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { IndexHolder } from '../src/holder.js';
import { createLogger, silentLogger } from '../src/logger.js';
import { HealthResponseSchema } from '../src/schemas.js';
import { createShutdown } from '../src/shutdown.js';
import { fixtureBytes, testConfig } from './helpers.js';

function loadedHolder(): IndexHolder {
  const holder = new IndexHolder();
  holder.swap(PostcodeIndex.fromBytes(fixtureBytes()), { source: 'f', sourceKind: 'file', loadedAt: 'now', fallback: false });
  return holder;
}

describe('draining', () => {
  it('turns /health to 503 draining while requests are still served', async () => {
    const holder = loadedHolder();
    const app = createApp(holder, testConfig(), silentLogger);
    expect((await app.request('/health')).status).toBe(200);

    holder.beginDrain();
    const res = await app.request('/health');
    expect(res.status).toBe(503);
    expect(HealthResponseSchema.parse(await res.json()).data).toMatchObject({ status: 'draining', ready: false });
    expect(holder.ready).toBe(false);
    expect(holder.current).not.toBeNull();

    const search = await app.request('/search?q=ZE1&limit=1');
    expect(search.status).toBe(200);
    expect((await app.request('/ZE1%200AA')).status).toBe(200);
  });
});

describe('createShutdown', () => {
  function harness(drainMs: number, closeDelayMs = 0, closeTimeoutMs = 1000) {
    const events: string[] = [];
    const lines: Array<Record<string, unknown>> = [];
    const holder = loadedHolder();
    let now = 0;
    const timers: Array<{ at: number; resolve: () => void }> = [];
    const sleep = (ms: number) =>
      new Promise<void>((resolve) => {
        timers.push({ at: now + ms, resolve });
      });
    const tick = (ms: number) => {
      now += ms;
      for (const t of timers.splice(0).sort((a, b) => a.at - b.at)) {
        if (t.at <= now) t.resolve();
        else timers.push(t);
      }
    };
    const shutdown = createShutdown({
      holder,
      refresh: { runOnce: async () => {}, stop: () => events.push('refresh.stop') },
      logger: createLogger('debug', {}, (l) => lines.push(JSON.parse(l))),
      drainMs,
      closeTimeoutMs,
      close: async () => {
        events.push('close.begin');
        if (closeDelayMs > 0) await sleep(closeDelayMs);
        events.push('close.done');
      },
      exit: (code) => events.push(`exit:${code}`),
      sleep,
    });
    return { shutdown, holder, events, lines, tick };
  }

  it('drains, then stops refresh, closes and exits 0', async () => {
    const h = harness(5000);
    const done = h.shutdown('SIGTERM');
    await Promise.resolve();
    expect(h.holder.draining).toBe(true);
    expect(h.events).toEqual([]); // still inside the drain window
    h.tick(4999);
    await Promise.resolve();
    expect(h.events).toEqual([]);
    h.tick(1);
    await done;
    expect(h.events).toEqual(['refresh.stop', 'close.begin', 'close.done', 'exit:0']);
    expect(h.lines.map((l) => l.msg)).toEqual(['shutdown: draining', 'shutdown: closed']);
  });

  it('skips the drain window when it is 0', async () => {
    const h = harness(0);
    await h.shutdown('SIGINT');
    expect(h.events).toEqual(['refresh.stop', 'close.begin', 'close.done', 'exit:0']);
  });

  it('exits immediately on a second signal', async () => {
    const h = harness(5000);
    const first = h.shutdown('SIGTERM');
    await Promise.resolve();
    await h.shutdown('SIGTERM');
    expect(h.events).toEqual(['exit:0']);
    h.tick(5000);
    await first;
    expect(h.events.filter((e) => e === 'exit:0').length).toBe(2);
  });

  it('gives up waiting for in-flight requests after the close timeout', async () => {
    const h = harness(0, 60_000, 1000);
    const done = h.shutdown('SIGTERM');
    await Promise.resolve();
    await Promise.resolve();
    h.tick(1000);
    await done;
    expect(h.events).toEqual(['refresh.stop', 'close.begin', 'exit:0']);
    expect(h.lines.some((l) => String(l.msg).includes('timed out'))).toBe(true);
  });
});
