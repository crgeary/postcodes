import { MAX_QUERY_LENGTH, normalisePostcode, normaliseQuery } from '@postcode/index-format';
import { z } from 'zod';

export const ResultSchema = z
  .object({
    postcode: z.string().meta({ description: 'Postcode formatted with the space', example: 'SW1A 1AA' }),
    lat: z.number().optional().meta({ description: 'WGS84 latitude; omitted when ONSPD has no grid reference' }),
    lon: z.number().optional().meta({ description: 'WGS84 longitude; omitted when ONSPD has no grid reference' }),
  })
  .meta({ id: 'Result' });

/** Successful responses wrap their payload in `data`: a list for search, an object for lookup and health. */
export const SearchResponseSchema = z.object({ data: z.array(ResultSchema) }).meta({ id: 'SearchResponse' });
export const LookupResponseSchema = z.object({ data: ResultSchema }).meta({ id: 'LookupResponse' });

/**
 * One validation issue in the Standard Schema format (https://standardschema.dev):
 * a message and the path to the offending value as an array of keys.
 */
export const IssueSchema = z
  .object({
    message: z.string(),
    path: z.array(z.union([z.string(), z.number()])).optional(),
  })
  .meta({ id: 'Issue' });

export const ErrorCodeSchema = z.enum(['bad_request', 'not_found', 'not_ready', 'internal']);

/** Every error response wraps its detail in `error`. */
export const ErrorSchema = z
  .object({
    error: z.object({
      code: ErrorCodeSchema,
      message: z.string(),
      issues: z.array(IssueSchema).optional().meta({ description: 'Present on validation errors' }),
    }),
  })
  .meta({ id: 'Error' });

export type ErrorCode = z.infer<typeof ErrorCodeSchema>;
export type Issue = z.infer<typeof IssueSchema>;

/** Raw length cap before normalisation; a cheap guard against junk input. */
export const MAX_RAW_QUERY_LENGTH = MAX_QUERY_LENGTH * 2;

export function autocompleteQuerySchema(defaultLimit: number, maxLimit: number) {
  return z.object({
    q: z
      .string({ error: 'q is required' })
      .trim()
      .min(1, { error: 'q is required', abort: true })
      .max(MAX_RAW_QUERY_LENGTH, { error: `q must be at most ${MAX_RAW_QUERY_LENGTH} characters`, abort: true })
      .refine(
        (s) => {
          const n = normaliseQuery(s).length;
          return n >= 1 && n <= MAX_QUERY_LENGTH;
        },
        { message: `q must contain 1 to ${MAX_QUERY_LENGTH} letters and digits (spaces and punctuation are ignored)` },
      )
      .meta({
        description:
          `Postcode prefix, case-insensitive, space optional. Punctuation and repeated spaces are ignored; ` +
          `what remains must be 1 to ${MAX_QUERY_LENGTH} characters.`,
        example: 'SW1A 1',
      }),
    limit: z.coerce
      .number({ error: 'limit must be a number' })
      .int('limit must be a whole number')
      .min(1, 'limit must be at least 1')
      .max(maxLimit, `limit must be at most ${maxLimit}`)
      .default(defaultLimit)
      .meta({ description: `Maximum results, 1 to ${maxLimit}` }),
  });
}

/** Outward of 2 to 4 characters followed by digit + two inward letters (no C, I, K, M, O, V). */
const FULL_POSTCODE = /^[A-Z0-9]{2,4}[0-9][ABDEFGHJLNPQRSTUWXYZ]{2}$/;

export const LookupParamSchema = z.object({
  postcode: z
    .string()
    .min(5, { error: 'postcode must be at least 5 characters', abort: true })
    .max(8, { error: 'postcode must be at most 8 characters', abort: true })
    .refine((s) => FULL_POSTCODE.test(normalisePostcode(s)), { message: 'postcode must be a complete postcode such as SW1A 1AA' })
    .meta({ description: 'Full postcode, with or without the space, any case', example: 'SW1A1AA' }),
});

export const HealthSchema = z
  .object({
    status: z.enum(['ok', 'starting', 'draining']).meta({ description: 'draining: shutdown has begun; requests are still served but new traffic should go elsewhere' }),
    ready: z.boolean(),
    index: z
      .object({
        release: z.string(),
        builtAt: z.string(),
        postcodes: z.number().int(),
        districts: z.number().int(),
        exclusions: z.array(z.string()),
        worstPrecisionM: z.number(),
        loadedAt: z.string(),
        source: z.string(),
        fallback: z.boolean(),
        bytes: z.number().int(),
      })
      .nullable(),
    refresh: z.object({
      enabled: z.boolean(),
      intervalMs: z.number().int(),
      running: z.boolean(),
      lastAttemptAt: z.string().nullable(),
      lastSuccessAt: z.string().nullable(),
      lastSwapAt: z.string().nullable(),
      lastError: z.string().nullable(),
    }),
    memory: z.object({
      arrayBuffers: z.number().int().meta({ description: 'process.memoryUsage().arrayBuffers; should sit near the index size' }),
      rss: z.number().int(),
      heapUsed: z.number().int(),
    }),
  })
  .meta({ id: 'Health' });

export const HealthResponseSchema = z.object({ data: HealthSchema }).meta({ id: 'HealthResponse' });

export type Health = z.infer<typeof HealthSchema>;
