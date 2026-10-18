import type { IndexHolder } from './holder.js';
import type { Logger } from './logger.js';
import type { RefreshController } from './refresh.js';

export interface ShutdownDeps {
  holder: IndexHolder;
  refresh: RefreshController;
  logger: Logger;
  /** Drain window: readiness is off but requests are still served. */
  drainMs: number;
  /** Stop accepting connections and wait for in-flight requests. */
  close: () => Promise<void>;
  /** Hard deadline for close() after the drain window. */
  closeTimeoutMs?: number;
  exit?: (code: number) => void;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms).unref?.());

/**
 * Graceful shutdown for rolling deploys:
 *
 * 1. Flip readiness off, so /health returns 503 and the load balancer stops
 *    routing new traffic here, while existing and in-flight requests are
 *    still answered.
 * 2. Wait `drainMs` for the balancer to notice.
 * 3. Stop the refresh timer, close the listener, wait for in-flight
 *    requests (bounded by `closeTimeoutMs`), then exit 0.
 *
 * A second signal during the drain skips the wait and exits at once.
 */
export function createShutdown(deps: ShutdownDeps): (signal: string) => Promise<void> {
  const exit = deps.exit ?? ((code) => process.exit(code));
  const sleep = deps.sleep ?? defaultSleep;
  const closeTimeoutMs = deps.closeTimeoutMs ?? 10_000;
  let started = false;

  return async (signal: string): Promise<void> => {
    if (started) {
      deps.logger.warn('second signal during shutdown; exiting now', { signal });
      exit(0);
      return;
    }
    started = true;
    deps.holder.beginDrain();
    deps.logger.info('shutdown: draining', { signal, drainMs: deps.drainMs });
    if (deps.drainMs > 0) await sleep(deps.drainMs);
    deps.refresh.stop();
    const timeout = sleep(closeTimeoutMs).then(() => 'timeout' as const);
    const outcome = await Promise.race([deps.close().then(() => 'closed' as const), timeout]);
    if (outcome === 'timeout') deps.logger.warn('shutdown: close timed out; exiting anyway', { closeTimeoutMs });
    else deps.logger.info('shutdown: closed');
    exit(0);
  };
}
