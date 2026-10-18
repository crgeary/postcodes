/**
 * Service configuration from environment variables, with the constant
 * defaults from PLAN.md.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface ServiceConfig {
  /** File path or http(s) URL of the index. The scheme selects the loader. */
  indexSource: string;
  /** Optional bundled file used if the primary source fails at startup. */
  indexFallback: string | undefined;
  /** Refresh interval in ms; 0 disables. */
  refreshMs: number;
  /** Fraction of the interval randomised each cycle. */
  refreshJitter: number;
  /** Per-fetch timeout for URL sources. */
  fetchTimeoutMs: number;
  searchDefaultLimit: number;
  searchMaxLimit: number;
  /** Seconds for Cache-Control on autocomplete and lookup responses. */
  cacheMaxAgeSeconds: number;
  port: number;
  logLevel: LogLevel;
}

export const DEFAULTS: ServiceConfig = {
  indexSource: './data/postcodes.idx',
  indexFallback: undefined,
  refreshMs: 0,
  refreshJitter: 0.1,
  fetchTimeoutMs: 30_000,
  searchDefaultLimit: 10,
  searchMaxLimit: 50,
  cacheMaxAgeSeconds: 3600,
  port: 3000,
  logLevel: 'info',
};

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

type Env = Record<string, string | undefined>;

function num(env: Env, name: string, fallback: number, opts: { min?: number; max?: number; integer?: boolean } = {}): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const v = Number(raw);
  if (!Number.isFinite(v)) throw new ConfigError(`${name} must be a number, got ${JSON.stringify(raw)}`);
  if (opts.integer && !Number.isInteger(v)) throw new ConfigError(`${name} must be an integer`);
  if (opts.min !== undefined && v < opts.min) throw new ConfigError(`${name} must be >= ${opts.min}`);
  if (opts.max !== undefined && v > opts.max) throw new ConfigError(`${name} must be <= ${opts.max}`);
  return v;
}

const LOG_LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error'];

export function loadConfig(env: Env = process.env): ServiceConfig {
  const logLevel = (env.LOG_LEVEL ?? DEFAULTS.logLevel) as LogLevel;
  if (!LOG_LEVELS.includes(logLevel)) throw new ConfigError(`LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}`);
  const config: ServiceConfig = {
    indexSource: env.POSTCODE_INDEX || DEFAULTS.indexSource,
    indexFallback: env.POSTCODE_INDEX_FALLBACK || undefined,
    refreshMs: num(env, 'POSTCODE_INDEX_REFRESH_MS', DEFAULTS.refreshMs, { min: 0, integer: true }),
    refreshJitter: num(env, 'POSTCODE_INDEX_REFRESH_JITTER', DEFAULTS.refreshJitter, { min: 0, max: 1 }),
    fetchTimeoutMs: num(env, 'POSTCODE_INDEX_FETCH_TIMEOUT_MS', DEFAULTS.fetchTimeoutMs, { min: 1, integer: true }),
    searchDefaultLimit: num(env, 'SEARCH_DEFAULT_LIMIT', DEFAULTS.searchDefaultLimit, { min: 1, integer: true }),
    searchMaxLimit: num(env, 'SEARCH_MAX_LIMIT', DEFAULTS.searchMaxLimit, { min: 1, integer: true }),
    cacheMaxAgeSeconds: num(env, 'CACHE_MAX_AGE_SECONDS', DEFAULTS.cacheMaxAgeSeconds, { min: 0, integer: true }),
    port: num(env, 'PORT', DEFAULTS.port, { min: 0, max: 65535, integer: true }),
    logLevel,
  };
  if (config.searchDefaultLimit > config.searchMaxLimit) {
    throw new ConfigError('SEARCH_DEFAULT_LIMIT must not exceed SEARCH_MAX_LIMIT');
  }
  return config;
}
