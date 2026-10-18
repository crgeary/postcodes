import { readFileSync, statSync } from 'node:fs';
import { PostcodeIndex } from '@postcode/index-format';
import type { LoadedIndexInfo, SourceKind } from './holder.js';

export type LoadResult = { kind: 'loaded'; index: PostcodeIndex; info: LoadedIndexInfo } | { kind: 'unchanged' };

export interface LoadOptions {
  /** Info from the previous load of the same source, for conditional loads. */
  previous?: LoadedIndexInfo | null;
  timeoutMs: number;
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

/**
 * URL source. Sends If-None-Match / If-Modified-Since from the previous
 * response; a 304 ends the cycle with no download. The body is read as an
 * ArrayBuffer and never converted to a string.
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
  const buffer = await response.arrayBuffer();
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
