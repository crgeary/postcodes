import { randomUUID } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import type { Logger } from './logger.js';

export type AppEnv = { Variables: { requestId: string } };

/**
 * Request id (honouring an incoming `x-request-id`) and one structured line
 * per request. Everything except the ops paths is the hot path and is logged
 * at debug level only.
 */
export function requestLogging(logger: Logger, opsPaths: ReadonlySet<string>): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const requestId = c.req.header('x-request-id') ?? randomUUID();
    c.set('requestId', requestId);
    const started = performance.now();
    await next();
    c.header('x-request-id', requestId);
    const path = c.req.path;
    const level = opsPaths.has(path) ? 'info' : 'debug';
    if (!logger.enabled(level)) return; // skip building fields for lines that would be dropped
    logger[level]('request', {
      requestId,
      method: c.req.method,
      path,
      status: c.res.status,
      durationMs: Math.round((performance.now() - started) * 1000) / 1000,
    });
  };
}
