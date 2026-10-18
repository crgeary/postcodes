import type { ServiceConfig } from './config.js';
import { IndexHolder } from './holder.js';
import { loadSource } from './loaders.js';
import type { Logger } from './logger.js';
import { createRefresh, type RefreshController, type RefreshDeps } from './refresh.js';

export interface Bootstrapped {
  holder: IndexHolder;
  refresh: RefreshController;
}

/**
 * Startup from PLAN.md: load the primary source; on failure try the fallback
 * and log that it is in use; if nothing loads, throw so the process exits
 * non-zero. Then start the refresh timer if enabled.
 */
export async function bootstrap(config: ServiceConfig, logger: Logger, deps: RefreshDeps = {}): Promise<Bootstrapped> {
  const holder = new IndexHolder();
  const loadOptions = { timeoutMs: config.fetchTimeoutMs, maxBytes: config.fetchMaxBytes, fetchImpl: deps.fetchImpl };
  try {
    const result = await loadSource(config.indexSource, loadOptions);
    if (result.kind !== 'loaded') throw new Error('unexpected unchanged result on first load');
    holder.swap(result.index, result.info);
  } catch (primaryErr) {
    const message = primaryErr instanceof Error ? primaryErr.message : String(primaryErr);
    if (!config.indexFallback) {
      logger.error('failed to load index and no fallback configured', { source: config.indexSource, error: message });
      throw primaryErr;
    }
    logger.warn('primary index failed; trying fallback', { source: config.indexSource, error: message, fallback: config.indexFallback });
    try {
      const result = await loadSource(config.indexFallback, { ...loadOptions, fallback: true });
      if (result.kind !== 'loaded') throw new Error('unexpected unchanged result on first load');
      holder.swap(result.index, result.info);
      logger.warn('serving from fallback index', { fallback: config.indexFallback });
    } catch (fallbackErr) {
      logger.error('fallback index failed too', {
        fallback: config.indexFallback,
        error: fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr),
      });
      throw fallbackErr;
    }
  }
  const index = holder.current!;
  logger.info('index loaded', {
    source: holder.info!.source,
    fallback: holder.info!.fallback,
    release: index.metadata.release,
    builtAt: index.metadata.builtAt,
    postcodes: index.postcodeCount,
    districts: index.districtCount,
    bytes: index.byteLength,
  });
  const refresh = createRefresh(holder, config, logger, deps);
  return { holder, refresh };
}
