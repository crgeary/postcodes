import { readFileSync, statSync } from 'node:fs';
import { PostcodeIndex } from '@postcode/index-format';
import type { LoadedIndexInfo, SourceKind } from './holder.js';

export type LoadResult = { kind: 'loaded'; index: PostcodeIndex; info: LoadedIndexInfo } | { kind: 'unchanged' };

export interface LoadOptions {
  /** Info from the previous load of the same source, for conditional loads. */
  previous?: LoadedIndexInfo | null;
  timeoutMs: number;
  /** Reject URL bodies larger than this before (Content-Length) or while (streaming) reading them. */
  maxBytes?: number;
  fallback?: boolean;
  fetchImpl?: typeof fetch;
}

export function sourceKind(source: string): SourceKind {
  return /^https?:\/\//i.test(source) ? 'url' : 'file';
}

export class LoadError extends Error {
  override readonly name = 'LoadError';
}

/**
 * File source. With `previous`, an unchanged mtime and size skips the read.
 * The file is read whole, validated, then wrapped; a corrupt file throws
 * before anything is swapped.
 */
export function loadFromFile(path: string, options: LoadOptions): LoadResult {
  const stat = statSync(path);
  const prev = options.previous;
  if (prev && prev.sourceKind === 'file' && prev.source === path && prev.mtimeMs === stat.mtimeMs && prev.size === stat.size) {
    return { kind: 'unchanged' };
  }
  const index = PostcodeIndex.fromBytes(readFileSync(path));
  return {
    kind: 'loaded',
    index,
    info: {
      source: path,
      sourceKind: 'file',
      loadedAt: new Date().toISOString(),
      fallback: options.fallback ?? false,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
    },
  };
}

/** Default ceiling for a downloaded index: several times the full UK size. */
export const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

/**
 * Read a response body into one ArrayBuffer without ever holding more than
 * `maxBytes`. A declared Content-Length above the cap is rejected before any
 * byte is read. With an acceptable declared length the body is read with
 * `arrayBuffer()`, which releases its internal chunks immediately; only an
 * undeclared length is streamed, with the read aborted as soon as it passes
 * the cap. A body that disagrees with its declared length is rejected.
 */
export async function readBodyCapped(response: Response, maxBytes: number): Promise<ArrayBuffer> {
  const declared = response.headers.get('content-length');
  if (declared !== null) {
    const expected = Number(declared);
    if (!Number.isInteger(expected) || expected < 0) throw new LoadError(`invalid Content-Length ${JSON.stringify(declared)}`);
    if (expected > maxBytes) throw new LoadError(`index is ${expected} bytes, above the ${maxBytes} byte limit`);
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength !== expected) {
      throw new LoadError(`index download was ${buffer.byteLength} bytes but Content-Length said ${expected}`);
    }
    return buffer;
  }
  if (response.body === null) return new ArrayBuffer(0);

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new LoadError(`index download exceeded the ${maxBytes} byte limit`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(new ArrayBuffer(total));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out.buffer;
}

/**
 * URL source. Sends If-None-Match / If-Modified-Since from the previous
 * response; a 304 ends the cycle with no download. The body is read into an
 * ArrayBuffer under a size cap and never converted to a string.
 */
export async function loadFromUrl(url: string, options: LoadOptions): Promise<LoadResult> {
  const headers = new Headers({ accept: 'application/octet-stream' });
  const prev = options.previous;
  if (prev && prev.sourceKind === 'url' && prev.source === url) {
    if (prev.etag) headers.set('if-none-match', prev.etag);
    if (prev.lastModified) headers.set('if-modified-since', prev.lastModified);
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(options.timeoutMs) });
  if (response.status === 304) return { kind: 'unchanged' };
  if (!response.ok) throw new LoadError(`${url}: HTTP ${response.status}`);
  const buffer = await readBodyCapped(response, options.maxBytes ?? DEFAULT_MAX_BYTES);
  const index = PostcodeIndex.fromBuffer(buffer);
  return {
    kind: 'loaded',
    index,
    info: {
      source: url,
      sourceKind: 'url',
      loadedAt: new Date().toISOString(),
      fallback: options.fallback ?? false,
      etag: response.headers.get('etag') ?? undefined,
      lastModified: response.headers.get('last-modified') ?? undefined,
      size: buffer.byteLength,
    },
  };
}

/** Dispatch on the source scheme. */
export function loadSource(source: string, options: LoadOptions): Promise<LoadResult> {
  if (sourceKind(source) === 'url') return loadFromUrl(source, options);
  return Promise.resolve().then(() => loadFromFile(source, options));
}
