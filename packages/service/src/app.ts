import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { ServiceConfig } from './config.js';
import type { IndexHolder } from './holder.js';
import type { Logger } from './logger.js';
import { requestLogging, type AppEnv } from './logging.js';
import { describeRoute, jsonResponse, specHandler, validator } from './openapi.js';
import {
  autocompleteQuerySchema,
  ErrorSchema,
  HealthResponseSchema,
  LookupParamSchema,
  LookupResponseSchema,
  SearchResponseSchema,
  type ErrorCode,
  type Health,
  type Issue,
} from './schemas.js';

export const SERVICE_VERSION = '0.1.0';

/**
 * Pattern for the root lookup segment. Requiring a digit and 5 to 8 postcode
 * characters keeps paths such as /favicon.ico, /metrics or /health from being
 * treated as postcodes; they fall through to the JSON 404 instead.
 */
export const POSTCODE_SEGMENT = '(?=[A-Za-z ]*[0-9])[A-Za-z0-9 ]{5,8}';

/** Literal routes that are not part of the hot path and are logged at info level. */
export const OPS_PATHS: ReadonlySet<string> = new Set(['/health', '/openapi.json', '/docs']);

/** Standard Schema issue as the validator hook receives it. */
type StandardIssue = { message: string; path?: ReadonlyArray<PropertyKey | { key: PropertyKey }> };
type ValidationResult = { success: true; data: unknown } | { success: false; error: ReadonlyArray<StandardIssue> };

/** Error envelope shared by every non-2xx response. */
export function errorBody(code: ErrorCode, message: string, issues?: Issue[]) {
  return { error: issues ? { code, message, issues } : { code, message } };
}

/** Standard Schema path segments are keys or `{ key }` objects; symbols cannot be serialised. */
function toIssue(issue: StandardIssue): Issue {
  const path = (issue.path ?? []).map((p) => {
    const key = typeof p === 'object' ? p.key : p;
    return typeof key === 'number' ? key : String(key);
  });
  return path.length > 0 ? { message: issue.message, path } : { message: issue.message };
}

function badRequest(result: ValidationResult, c: { json: (body: unknown, status: 400) => Response }): Response | undefined {
  if (result.success) return undefined;
  return c.json(errorBody('bad_request', 'invalid request', result.error.map(toIssue)), 400);
}

/**
 * Build the Hono app. Handlers are synchronous: normalise, call the current
 * index, serialise. Nothing in the hot path awaits.
 */
export function createApp(holder: IndexHolder, config: ServiceConfig, logger: Logger): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const cacheControl = `public, max-age=${config.cacheMaxAgeSeconds}`;
  const cacheHeader = { 'Cache-Control': { description: 'Results change at most quarterly', schema: { type: 'string' as const } } };

  app.use(requestLogging(logger, OPS_PATHS));
  // Browsers call this API directly from autocomplete widgets, so CORS is on
  // by default. GET only; the request id is exposed so clients can quote it.
  app.use(
    cors({
      origin: config.corsOrigins.includes('*') ? '*' : config.corsOrigins,
      allowMethods: ['GET', 'HEAD', 'OPTIONS'],
      exposeHeaders: ['x-request-id'],
      maxAge: 86_400,
    }),
  );

  app.get(
    '/search',
    describeRoute({
      tags: ['postcodes'],
      summary: 'Search postcodes by prefix',
      description:
        'Left-to-right prefix match. Input is uppercased and stripped of punctuation; the space is optional. ' +
        'Without a space every valid outward/inward split is tried, so `B11` matches both the B11 district and `B1 1..`. ' +
        'Returns an empty list rather than 404 when nothing matches.',
      responses: {
        200: jsonResponse('Matching postcodes', SearchResponseSchema, cacheHeader),
        400: jsonResponse('Invalid query parameters', ErrorSchema),
        503: jsonResponse('Index not loaded yet', ErrorSchema),
      },
    }),
    validator('query', autocompleteQuerySchema(config.searchDefaultLimit, config.searchMaxLimit), badRequest),
    (c) => {
      const index = holder.current;
      if (index === null) return c.json(errorBody('not_ready', 'index not loaded yet'), 503);
      const { q, limit } = c.req.valid('query');
      const data = index.search(q, limit);
      c.header('Cache-Control', cacheControl);
      return c.json({ data }, 200);
    },
  );

  app.get(
    '/health',
    describeRoute({
      tags: ['ops'],
      summary: 'Readiness and index metadata',
      description: '503 until an index is held, so orchestrators can gate traffic on it.',
      responses: {
        200: jsonResponse('Ready', HealthResponseSchema),
        503: jsonResponse('Not ready; the same document, so the diagnostics are available', HealthResponseSchema),
      },
    }),
    (c) => {
      const index = holder.current;
      const info = holder.info;
      const mem = process.memoryUsage();
      const body: Health = {
        status: index ? 'ok' : 'starting',
        ready: index !== null,
        index:
          index && info
            ? {
                release: index.metadata.release,
                builtAt: index.metadata.builtAt,
                postcodes: index.postcodeCount,
                districts: index.districtCount,
                exclusions: index.metadata.exclusions,
                worstPrecisionM: index.metadata.worstPrecisionM,
                loadedAt: info.loadedAt,
                source: info.source,
                fallback: info.fallback,
                bytes: index.byteLength,
              }
            : null,
        refresh: { ...holder.refresh },
        memory: { arrayBuffers: mem.arrayBuffers, rss: mem.rss, heapUsed: mem.heapUsed },
      };
      c.header('Cache-Control', 'no-store');
      return c.json({ data: body }, index ? 200 : 503);
    },
  );

  app.get(
    '/openapi.json',
    specHandler(app, {
      title: 'FixMyCar Postcode Autocomplete',
      version: SERVICE_VERSION,
      description:
        'Left-to-right UK postcode autocomplete and lookup backed by a compact ONSPD index. ' +
        'Contains OS data © Crown copyright and database right; contains Royal Mail data © Royal Mail copyright and database right; ' +
        'contains National Statistics data © Crown copyright and database right.',
    }),
  );

  app.get('/docs', (c) =>
    c.html(
      `<!doctype html><html><head><meta charset="utf-8"><title>Postcode API</title></head>` +
        `<body><script id="api-reference" data-url="/openapi.json"></script>` +
        `<script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.25.0/dist/browser/standalone.min.js"></script></body></html>`,
    ),
  );

  app.get(
    `/:postcode{${POSTCODE_SEGMENT}}`,
    describeRoute({
      tags: ['postcodes'],
      summary: 'Look up one postcode',
      description:
        'Exact match, with or without the space, any case. The segment must look like a postcode ' +
        '(5 to 8 letters, digits and spaces, containing a digit); anything else is an unknown route.',
      responses: {
        200: jsonResponse('The postcode', LookupResponseSchema, cacheHeader),
        400: jsonResponse('Malformed postcode', ErrorSchema),
        404: jsonResponse('Unknown postcode', ErrorSchema),
        503: jsonResponse('Index not loaded yet', ErrorSchema),
      },
    }),
    validator('param', LookupParamSchema, badRequest),
    (c) => {
      const index = holder.current;
      if (index === null) return c.json(errorBody('not_ready', 'index not loaded yet'), 503);
      const { postcode } = c.req.valid('param');
      const data = index.lookup(postcode);
      c.header('Cache-Control', cacheControl);
      if (data === null) return c.json(errorBody('not_found', 'unknown postcode'), 404);
      return c.json({ data }, 200);
    },
  );

  app.notFound((c) => c.json(errorBody('not_found', `no route for ${c.req.method} ${c.req.path}`), 404));
  app.onError((err, c) => {
    logger.error('unhandled error', { requestId: c.get('requestId'), error: err.message, stack: err.stack });
    return c.json(errorBody('internal', 'internal error'), 500);
  });

  return app;
}
