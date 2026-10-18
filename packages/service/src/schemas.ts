import { MAX_QUERY_LENGTH, normaliseQuery } from '@postcode/index-format';
import { z } from 'zod';

export const ResultSchema = z
  .object({
    postcode: z.string().meta({ description: 'Postcode formatted with the space', example: 'SW1A 1AA' }),
    lat: z.number().optional().meta({ description: 'WGS84 latitude; omitted when ONSPD has no grid reference' }),
    lon: z.number().optional().meta({ description: 'WGS84 longitude; omitted when ONSPD has no grid reference' }),
  })
  .meta({ id: 'Result' });

export const AutocompleteResponseSchema = z.object({ results: z.array(ResultSchema) }).meta({ id: 'AutocompleteResponse' });

export const ErrorSchema = z
  .object({
    error: z.enum(['bad_request', 'not_found', 'not_ready']),
    message: z.string().optional(),
    issues: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
  })
  .meta({ id: 'Error' });

/** Raw length cap before normalisation; a cheap guard against junk input. */
export const MAX_RAW_QUERY_LENGTH = MAX_QUERY_LENGTH * 2;

export function autocompleteQuerySchema(defaultLimit: number, maxLimit: number) {
  return z.object({
    q: z
      .string()
      .trim()
      .min(1)
      .max(MAX_RAW_QUERY_LENGTH)
      .refine(
        (s) => {
          const n = normaliseQuery(s).length;
          return n >= 1 && n <= MAX_QUERY_LENGTH;
        },
        { message: `must contain 1 to ${MAX_QUERY_LENGTH} letters and digits after normalisation` },
      )
      .meta({
        description:
          `Postcode prefix, case-insensitive, space optional. Punctuation and repeated spaces are ignored; ` +
          `what remains must be 1 to ${MAX_QUERY_LENGTH} characters.`,
        example: 'SW1A 1',
      }),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(maxLimit)
      .default(defaultLimit)
      .meta({ description: `Maximum results, 1 to ${maxLimit}` }),
  });
}

export const LookupParamSchema = z.object({
  postcode: z.string().min(5).max(8).meta({ description: 'Full postcode, with or without the space', example: 'SW1A1AA' }),
});

export const HealthSchema = z
  .object({
    status: z.enum(['ok', 'starting']),
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

export type Health = z.infer<typeof HealthSchema>;
