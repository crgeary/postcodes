import SwaggerParser from '@apidevtools/swagger-parser';
import { PostcodeIndex } from '@postcode/index-format';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { IndexHolder } from '../src/holder.js';
import { silentLogger } from '../src/logger.js';
import { ErrorSchema, HealthResponseSchema } from '../src/schemas.js';
import { fixtureBytes, testConfig } from './helpers.js';

function loadedHolder(): IndexHolder {
  const holder = new IndexHolder();
  holder.swap(PostcodeIndex.fromBytes(fixtureBytes()), {
    source: '/tmp/ze.idx',
    sourceKind: 'file',
    loadedAt: '2026-10-18T12:00:00.000Z',
    fallback: false,
  });
  return holder;
}

describe('/health', () => {
  it('returns 503 before an index is loaded and 200 after', async () => {
    const holder = new IndexHolder();
    const app = createApp(holder, testConfig(), silentLogger);
    const before = await app.request('/health');
    expect(before.status).toBe(503);
    const bodyBefore = HealthResponseSchema.parse(await before.json()).data;
    expect(bodyBefore).toMatchObject({ status: 'starting', ready: false, index: null });

    holder.swap(PostcodeIndex.fromBytes(fixtureBytes()), {
      source: 'file.idx',
      sourceKind: 'file',
      loadedAt: '2026-10-18T12:00:00.000Z',
      fallback: true,
    });
    const after = await app.request('/health');
    expect(after.status).toBe(200);
    expect(after.headers.get('cache-control')).toBe('no-store');
    const body = HealthResponseSchema.parse(await after.json()).data;
    expect(body).toMatchObject({
      status: 'ok',
      ready: true,
      index: { release: 'FEB_2026', postcodes: 658, districts: 3, source: 'file.idx', fallback: true, exclusions: [] },
      refresh: { enabled: false, lastError: null },
    });
    expect(body.memory.arrayBuffers).toBeGreaterThan(0);
  });
});

describe('/search', () => {
  const app = createApp(loadedHolder(), testConfig(), silentLogger);

  it('returns data with the space, coordinates and a cache header', async () => {
    const res = await app.request('/search?q=ze1%200a&limit=3');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=3600');
    expect(res.headers.get('x-request-id')).toMatch(/[0-9a-f-]{36}/);
    const body = (await res.json()) as { data: Array<{ postcode: string; lat: number; lon: number }> };
    expect(Object.keys(body)).toEqual(['data']);
    expect(body.data.length).toBe(3);
    expect(body.data[0]).toEqual({ postcode: 'ZE1 0AA', lat: expect.any(Number), lon: expect.any(Number) });
    expect(body.data[0].lat).toBeCloseTo(60.153231, 4);
  });

  it('applies the default and maximum limits', async () => {
    const def = (await (await app.request('/search?q=ZE')).json()) as { data: unknown[] };
    expect(def.data.length).toBe(10);
    const max = (await (await app.request('/search?q=ZE&limit=50')).json()) as { data: unknown[] };
    expect(max.data.length).toBe(50);
  });

  it('accepts input that only normalises to a valid query (leading, trailing and doubled spaces)', async () => {
    for (const q of ['%20ze1%200aa', 'ZE1%200AA%20', 'ze1%20%200aa', '%20%20ZE1%20%200AA%20%20']) {
      const res = await app.request(`/search?q=${q}`);
      expect(res.status, q).toBe(200);
      const body = (await res.json()) as { data: Array<{ postcode: string }> };
      expect(body.data.map((r) => r.postcode)).toEqual(['ZE1 0AA']);
    }
  });

  it('returns an empty list, not 404, when nothing matches', async () => {
    const res = await app.request('/search?q=SW1A');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [] });
  });

  it('returns 400 in the documented shape for bad parameters', async () => {
    for (const qs of ['', 'q=', 'q=%20%20', 'q=---', 'q=ZE1%200AA%200', 'q=ZE1%200AA%200AA%200AA', 'q=ZE&limit=0', 'q=ZE&limit=51', 'q=ZE&limit=abc', 'q=ZE&limit=1.5']) {
      const res = await app.request(`/search?${qs}`);
      expect(res.status, qs).toBe(400);
      expect(res.headers.get('cache-control')).toBeNull();
      const raw = await res.json();
      expect(Object.keys(raw as object)).toEqual(['error']);
      const body = ErrorSchema.parse(raw);
      expect(body.error.code).toBe('bad_request');
      expect(body.error.issues!.length).toBeGreaterThan(0);
    }
  });

  it('reports validation issues in the Standard Schema shape with plain messages', async () => {
    const res = await app.request('/search?q=&limit=99');
    expect(res.status).toBe(400);
    const body = ErrorSchema.parse(await res.json());
    expect(body.error.issues).toEqual([
      { message: 'q is required', path: ['q'] },
      { message: 'limit must be at most 50', path: ['limit'] },
    ]);
    for (const issue of body.error.issues!) {
      expect(Object.keys(issue).sort()).toEqual(['message', 'path']);
      expect(issue.message).not.toMatch(/expected|Too (small|big)|invalid_type/i);
    }
  });

  it('echoes a supplied request id', async () => {
    const res = await app.request('/search?q=ZE', { headers: { 'x-request-id': 'abc-123' } });
    expect(res.headers.get('x-request-id')).toBe('abc-123');
  });

  it('returns 503 while no index is held', async () => {
    const empty = createApp(new IndexHolder(), testConfig(), silentLogger);
    const res = await empty.request('/search?q=ZE');
    expect(res.status).toBe(503);
    expect(ErrorSchema.parse(await res.json()).error).toEqual({ code: 'not_ready', message: 'index not loaded yet' });
  });
});

describe('/{postcode}', () => {
  const app = createApp(loadedHolder(), testConfig({ cacheMaxAgeSeconds: 60 }), silentLogger);

  it('looks up with or without the space, any case', async () => {
    for (const p of ['ZE1 0AA', 'ze10aa', 'ZE1%200AA']) {
      const res = await app.request(`/${p}`);
      expect(res.status, p).toBe(200);
      expect(res.headers.get('cache-control')).toBe('public, max-age=60');
      expect(await res.json()).toEqual({ data: { postcode: 'ZE1 0AA', lat: expect.any(Number), lon: expect.any(Number) } });
    }
  });

  it('returns 404 in the documented shape for an unknown postcode', async () => {
    const res = await app.request('/ZE1%200ZZ');
    expect(res.status).toBe(404);
    expect(ErrorSchema.parse(await res.json())).toEqual({ error: { code: 'not_found', message: 'unknown postcode' } });
  });

  it('returns 400 for a postcode-shaped segment that is not a complete postcode', async () => {
    for (const path of ['/ZE1%200', '/ZE1%200A', '/ZE10AAA', '/ZE1%200CA', '/1234567']) {
      const res = await app.request(path);
      expect(res.status, path).toBe(400);
      const body = ErrorSchema.parse(await res.json());
      expect(body.error.code).toBe('bad_request');
      expect(body.error.issues![0].path).toEqual(['postcode']);
    }
  });

  it('paths that are not postcode-shaped are unknown routes, not bad postcodes', async () => {
    for (const path of ['/nope', '/favicon.ico', '/robots.txt', '/metrics', '/healthz', '/ZE1', '/ZE1%200AAAA', '/postcodes/ZE1%200AA']) {
      const res = await app.request(path);
      expect(res.status, path).toBe(404);
      expect(ErrorSchema.parse(await res.json()).error.code).toBe('not_found');
    }
  });

  it('ops routes are never shadowed by the lookup route', async () => {
    expect((await app.request('/health')).status).toBe(200);
    expect((await app.request('/openapi.json')).status).toBe(200);
    expect((await app.request('/docs')).status).toBe(200);
  });
});

describe('CORS', () => {
  it('allows any origin by default and answers preflight', async () => {
    const app = createApp(loadedHolder(), testConfig(), silentLogger);
    const res = await app.request('/search?q=ZE', { headers: { origin: 'https://www.fixmycar.co.uk' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-expose-headers')).toContain('x-request-id');

    const preflight = await app.request('/search?q=ZE', {
      method: 'OPTIONS',
      headers: { origin: 'https://www.fixmycar.co.uk', 'access-control-request-method': 'GET' },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('*');
    expect(preflight.headers.get('access-control-allow-methods')).toContain('GET');
    expect(preflight.headers.get('access-control-max-age')).toBe('86400');
  });

  it('restricts to the configured origins when a list is given', async () => {
    const app = createApp(loadedHolder(), testConfig({ corsOrigins: ['https://www.fixmycar.co.uk', 'https://staging.fixmycar.co.uk'] }), silentLogger);
    const ok = await app.request('/ZE1%200AA', { headers: { origin: 'https://staging.fixmycar.co.uk' } });
    expect(ok.headers.get('access-control-allow-origin')).toBe('https://staging.fixmycar.co.uk');
    expect(ok.headers.get('vary')).toContain('Origin');
    const other = await app.request('/ZE1%200AA', { headers: { origin: 'https://evil.example' } });
    expect(other.status).toBe(200);
    expect(other.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('/openapi.json', () => {
  it('serves a valid OpenAPI 3.1 document describing the four routes and error shapes', async () => {
    const app = createApp(loadedHolder(), testConfig(), silentLogger);
    const res = await app.request('/openapi.json');
    expect(res.status).toBe(200);
    const spec = (await res.json()) as Record<string, any>;
    expect(spec.openapi).toBe('3.1.0');
    expect(spec.info.title).toContain('Postcode');
    expect(Object.keys(spec.paths).sort()).toEqual(['/health', '/search', '/{postcode}']);
    const auto = spec.paths['/search'].get;
    expect(auto.operationId).toBe('searchPostcodes');
    expect(spec.paths['/{postcode}'].get.operationId).toBe('lookupPostcode');
    expect(spec.paths['/health'].get.operationId).toBe('getHealth');
    const ids = Object.values(spec.paths).flatMap((p: any) => Object.values(p).map((op: any) => op.operationId));
    expect(new Set(ids).size).toBe(ids.length);
    expect(Object.keys(auto.responses).sort()).toEqual(['200', '400', '503']);
    expect(auto.responses['200'].headers['Cache-Control']).toBeDefined();
    const lookup = spec.paths['/{postcode}'].get;
    expect(Object.keys(lookup.responses).sort()).toEqual(['200', '400', '404', '503']);
    for (const name of ['Result', 'SearchResponse', 'LookupResponse', 'HealthResponse', 'Error', 'Issue']) {
      expect(spec.components.schemas, name).toHaveProperty(name);
    }
    expect(spec.components.schemas.SearchResponse.required).toEqual(['data']);
    expect(spec.components.schemas.Error.properties.error.properties.code.enum).toEqual(['bad_request', 'not_found', 'not_ready', 'internal']);
    const qParam = auto.parameters.find((p: { name: string }) => p.name === 'q');
    expect(qParam).toMatchObject({ in: 'query', required: true, schema: { type: 'string', minLength: 1, maxLength: 16 } });

    // Validate the document against the OpenAPI 3.1 schema.
    await expect(SwaggerParser.validate(structuredClone(spec))).resolves.toBeDefined();
  });

  it('/docs serves an HTML page pointing at the spec', async () => {
    const app = createApp(loadedHolder(), testConfig(), silentLogger);
    const res = await app.request('/docs');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('/openapi.json');
  });
});
