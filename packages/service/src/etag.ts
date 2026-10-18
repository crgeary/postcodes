import { checksumHex, type PostcodeIndex } from '@postcode/index-format';
import type { MiddlewareHandler } from 'hono';
import type { IndexHolder } from './holder.js';

/**
 * ETag for every hot-path response: the index checksum. A search or lookup
 * response is a pure function of the URL and the loaded index, so one
 * validator serves every URL, a 304 costs no search at all, and every
 * client's cache invalidates exactly when the data changes. Strong, because
 * the bytes for a given URL and index are identical.
 */
const etags = new WeakMap<PostcodeIndex, string>();

export function indexEtag(index: PostcodeIndex): string {
  let tag = etags.get(index);
  if (tag === undefined) {
    tag = `"${checksumHex(index.header.checksum).slice(0, 32)}"`;
    etags.set(index, tag);
  }
  return tag;
}

/**
 * RFC 9110 If-None-Match: `*`, or a comma-separated list of entity tags,
 * compared weakly (a `W/` prefix on either side is ignored).
 */
export function ifNoneMatchMatches(header: string | undefined, etag: string): boolean {
  if (header === undefined) return false;
  const trimmed = header.trim();
  if (trimmed === '*') return true;
  const want = etag.startsWith('W/') ? etag.slice(2) : etag;
  for (const part of trimmed.split(',')) {
    let tag = part.trim();
    if (tag.startsWith('W/')) tag = tag.slice(2);
    if (tag === want) return true;
  }
  return false;
}

/**
 * Route-level middleware for search and lookup. Placed after the validator
 * so malformed requests still get their 400, and before the handler so a
 * matching If-None-Match short-circuits before any work is done.
 */
export function conditionalGet(holder: IndexHolder, cacheControl: string): MiddlewareHandler {
  return async (c, next) => {
    const index = holder.current;
    if (index === null) return next();
    const etag = indexEtag(index);
    if (ifNoneMatchMatches(c.req.header('if-none-match'), etag)) {
      c.header('ETag', etag);
      c.header('Cache-Control', cacheControl);
      return c.body(null, 304);
    }
    await next();
    const status = c.res.status;
    if (status === 200 || status === 404) c.res.headers.set('ETag', etag);
  };
}
