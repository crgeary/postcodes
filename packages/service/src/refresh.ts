import type { ServiceConfig } from './config.js';
import type { IndexHolder } from './holder.js';
import { loadSource } from './loaders.js';
import type { Logger } from './logger.js';

export interface RefreshController {
  /** Run one cycle now (used by tests and the timer). Never throws. */
  runOnce(): Promise<void>;
  /** Stop the timer. */
  stop(): void;
}

export interface RefreshDeps {
  fetchImpl?: typeof fetch;
  random?: () => number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}

/**
 * Periodic refresh of the primary source. Each cycle: conditional load, swap
 * on success, log and record on failure, never flip readiness. A cycle is
 * skipped while a previous one is still running.
 */
export function createRefresh(holder: IndexHolder, config: ServiceConfig, logger: Logger, deps: RefreshDeps = {}): RefreshController {
  const random = deps.random ?? Math.random;
  const setTimer = deps.setTimer ?? setTimeout;
  const clearTimer = deps.clearTimer ?? clearTimeout;
  const state = holder.refresh;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  async function runOnce(): Promise<void> {
    if (state.running) {
      logger.warn('refresh skipped: previous cycle still running');
      return;
    }
    state.running = true;
    state.lastAttemptAt = new Date().toISOString();
    try {
      const previous = holder.info && !holder.info.fallback ? holder.info : null;
      const result = await loadSource(config.indexSource, {
        previous,
        timeoutMs: config.fetchTimeoutMs,
        maxBytes: config.fetchMaxBytes,
        fetchImpl: deps.fetchImpl,
      });
      state.lastSuccessAt = new Date().toISOString();
      state.lastError = null;
      if (result.kind === 'unchanged') {
        logger.debug('refresh: source unchanged');
        return;
      }
      const old = holder.current;
      holder.swap(result.index, result.info);
      state.lastSwapAt = result.info.loadedAt;
      logger.info('refresh: swapped index', {
        release: result.index.metadata.release,
        postcodes: result.index.postcodeCount,
        previousRelease: old?.metadata.release,
        bytes: result.index.byteLength,
      });
    } catch (err) {
      const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      state.lastError = message;
      logger.error('refresh failed; keeping current index', { error: message });
    } finally {
      state.running = false;
    }
  }

  function schedule(): void {
    if (stopped) return;
    const jitter = 1 + (random() * 2 - 1) * config.refreshJitter;
    const delay = Math.max(1, Math.round(config.refreshMs * jitter));
    timer = setTimer(() => {
      void runOnce().finally(schedule);
    }, delay);
    // Never keep the process alive for a refresh.
    timer.unref?.();
  }

  if (config.refreshMs > 0) {
    state.enabled = true;
    state.intervalMs = config.refreshMs;
    schedule();
  }

  return {
    runOnce,
    stop() {
      stopped = true;
      if (timer !== undefined) clearTimer(timer);
    },
  };
}
