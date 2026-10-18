import type { PostcodeIndex } from '@postcode/index-format';

export type SourceKind = 'file' | 'url';

/** Where and when the current index came from, plus what refresh needs to compare against. */
export interface LoadedIndexInfo {
  source: string;
  sourceKind: SourceKind;
  loadedAt: string;
  /** True if the index came from POSTCODE_INDEX_FALLBACK. */
  fallback: boolean;
  etag?: string;
  lastModified?: string;
  mtimeMs?: number;
  size?: number;
}

export interface RefreshState {
  enabled: boolean;
  intervalMs: number;
  running: boolean;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastSwapAt: string | null;
  lastError: string | null;
}

/**
 * The single owner of the current index. Request handlers read
 * `holder.current` and nothing else; loading and refresh go through `swap`.
 */
export class IndexHolder {
  private index: PostcodeIndex | null = null;
  private indexInfo: LoadedIndexInfo | null = null;
  readonly refresh: RefreshState = {
    enabled: false,
    intervalMs: 0,
    running: false,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastSwapAt: null,
    lastError: null,
  };

  get current(): PostcodeIndex | null {
    return this.index;
  }

  get info(): LoadedIndexInfo | null {
    return this.indexInfo;
  }

  private drainingFlag = false;

  /** True once shutdown has begun: /health reports 503 while requests are still served. */
  get draining(): boolean {
    return this.drainingFlag;
  }

  /** Ready for traffic: an index is held and shutdown has not begun. */
  get ready(): boolean {
    return this.index !== null && !this.drainingFlag;
  }

  /** Flip readiness off so load balancers stop routing here before the server closes. */
  beginDrain(): void {
    this.drainingFlag = true;
  }

  /** Atomically replace the index. In-flight requests keep their old reference. */
  swap(next: PostcodeIndex, info: LoadedIndexInfo): void {
    this.index = next;
    this.indexInfo = info;
  }
}
