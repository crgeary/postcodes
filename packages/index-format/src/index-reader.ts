import { toAlignedArrayBuffer } from './buffer.js';
import {
  BBOX_FLOATS,
  INWARD_COUNT,
  MAX_QUERY_LENGTH,
  NO_COORDINATE,
  OUTWARD_BYTES,
  OUTWARD_MAX_LENGTH,
  OUTWARD_MIN_LENGTH,
  QUANT_MAX,
  WORDS_PER_DISTRICT,
} from './constants.js';
import { hasCoordinates, type IndexHeader, type IndexLayout } from './header.js';
import { decodeInward, encodeInward, inwardPrefixRange } from './inward.js';
import type { IndexMetadata } from './metadata.js';
import { normalisePostcode, normaliseQuery } from './normalise.js';
import { districtPrecisionMetres, type DistrictPrecision } from './precision.js';
import { validateIndexBuffer } from './validate.js';

/**
 * One autocomplete or lookup result. `lat` and `lon` are always present as
 * keys (possibly `undefined`) so every result has the same hidden class.
 */
export interface PostcodeResult {
  postcode: string;
  lat: number | undefined;
  lon: number | undefined;
}

/** A district range plus an inward bit range to scan, with its merge group. */
interface Candidate {
  dLo: number;
  dHi: number;
  lo: number;
  hi: number;
  /** 0 = outward-prefix match, k = split with a k-character inward prefix. */
  group: number;
}

/** Scratch for inward prefix ranges; the engine is synchronous so sharing is safe. */
const RANGE = new Int32Array(2);

/** Loop-free 32-bit population count. */
export function popcount32(v: number): number {
  v = v - ((v >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return Math.imul((v + (v >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24;
}

/** Character just above 'Z' and '9' in code-unit order; bounds a prefix range. */
const AFTER_ALNUM = '{';

function round6(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}

/**
 * Read-only query engine over one index buffer. Holds the typed-array views
 * and the outward string array and nothing else, so instances can be swapped
 * atomically and the old one collected.
 */
export class PostcodeIndex {
  readonly header: IndexHeader;
  readonly layout: IndexLayout;
  readonly metadata: IndexMetadata;
  /** Outward codes without padding, in code-unit order. */
  readonly outwards: readonly string[];
  readonly hasCoordinates: boolean;

  private readonly buffer: ArrayBuffer;
  private readonly rank: Uint32Array;
  private readonly bits: Uint32Array;
  private readonly bbox: Float32Array;
  private readonly coords: Uint16Array;

  private constructor(buffer: ArrayBuffer, header: IndexHeader, layout: IndexLayout, metadata: IndexMetadata) {
    this.buffer = buffer;
    this.header = header;
    this.layout = layout;
    this.metadata = metadata;
    const D = header.districtCount;
    this.hasCoordinates = hasCoordinates(header.flags);
    this.rank = new Uint32Array(buffer, layout.rankOffset, D + 1);
    this.bits = new Uint32Array(buffer, layout.bitsetsOffset, D * WORDS_PER_DISTRICT);
    this.bbox = new Float32Array(buffer, layout.bboxOffset, D * BBOX_FLOATS);
    this.coords = new Uint16Array(buffer, layout.coordsOffset, layout.coordsLength / 2);

    const raw = new Uint8Array(buffer, layout.outwardsOffset, D * OUTWARD_BYTES);
    const outwards = new Array<string>(D);
    for (let d = 0; d < D; d++) {
      let s = '';
      for (let i = 0; i < OUTWARD_BYTES; i++) {
        const c = raw[d * OUTWARD_BYTES + i];
        if (c === 0x20) break;
        s += String.fromCharCode(c);
      }
      outwards[d] = s;
    }
    this.outwards = outwards;
  }

  /** Validate and open an index. Throws `IndexFormatError` if anything is wrong. */
  static fromBuffer(buffer: ArrayBuffer): PostcodeIndex {
    const { header, layout, metadata } = validateIndexBuffer(buffer);
    return new PostcodeIndex(buffer, header, layout, metadata);
  }

  /** As `fromBuffer`, copying to an aligned ArrayBuffer first if needed. */
  static fromBytes(bytes: Uint8Array): PostcodeIndex {
    return PostcodeIndex.fromBuffer(toAlignedArrayBuffer(bytes));
  }

  get districtCount(): number {
    return this.header.districtCount;
  }

  get postcodeCount(): number {
    return this.header.postcodeCount;
  }

  /** Size of the backing buffer in bytes. */
  get byteLength(): number {
    return this.buffer.byteLength;
  }

  // ---------------------------------------------------------------- search

  /**
   * Left-to-right prefix autocomplete. Returns at most `limit` results,
   * formatted with the space, in district then inward order within each
   * candidate interpretation.
   */
  search(input: string, limit: number): PostcodeResult[] {
    const out: PostcodeResult[] = [];
    if (!(limit > 0)) return out;
    // Clamp rather than `| 0`, which wraps values of 2^31 or more.
    limit = Math.min(Math.floor(limit), this.postcodeCount);
    if (limit === 0) return out;
    const q = normaliseQuery(input);
    if (q.length === 0 || q.length > MAX_QUERY_LENGTH) return out;

    const candidates = this.collectCandidates(q);
    if (candidates.length === 0) return out;
    orderCandidates(candidates);
    for (let i = 0; i < candidates.length && out.length < limit; i++) {
      const c = candidates[i];
      this.scan(c.dLo, c.dHi, c.lo, c.hi, limit, out);
    }
    return out;
  }

  /** Exact lookup of a full postcode, with or without the space. */
  lookup(input: string): PostcodeResult | null {
    const p = normalisePostcode(input);
    if (p.length < OUTWARD_MIN_LENGTH + 3 || p.length > OUTWARD_MAX_LENGTH + 3) return null;
    const n = encodeInward(p.slice(p.length - 3));
    if (n < 0) return null;
    const d = this.findOutward(p.slice(0, p.length - 3));
    if (d < 0) return null;
    const base = d * WORDS_PER_DISTRICT;
    const w = n >>> 5;
    const word = this.bits[base + w];
    const mask = 1 << (n & 31);
    if ((word & mask) === 0) return null;
    let rank = this.rank[d];
    for (let i = 0; i < w; i++) rank += popcount32(this.bits[base + i]);
    rank += popcount32(word & (mask - 1));
    return this.makeResult(d, n, rank);
  }

  // ------------------------------------------------------------- reporting

  /** Trimmed outward code for a district index. */
  districtOutward(d: number): string {
    return this.outwards[d];
  }

  /** Number of postcodes in a district. */
  districtSize(d: number): number {
    return this.rank[d + 1] - this.rank[d];
  }

  /** Bounding box as `[minLat, minLon, latSpan, lonSpan]`. */
  districtBounds(d: number): [number, number, number, number] {
    const b = d * BBOX_FLOATS;
    return [this.bbox[b], this.bbox[b + 1], this.bbox[b + 2], this.bbox[b + 3]];
  }

  /** Quantisation precision for every district, worst first. */
  precisionReport(): DistrictPrecision[] {
    const out: DistrictPrecision[] = [];
    for (let d = 0; d < this.districtCount; d++) {
      const [minLat, , latSpan, lonSpan] = this.districtBounds(d);
      out.push({
        outward: this.outwards[d],
        postcodes: this.districtSize(d),
        precisionM: districtPrecisionMetres(minLat, latSpan, lonSpan),
        latSpan,
        lonSpan,
      });
    }
    out.sort((a, b) => b.precisionM - a.precisionM);
    return out;
  }

  /** Iterate every postcode as a result, in rank order. For tests and tools, not the hot path. */
  *all(): IterableIterator<PostcodeResult> {
    for (let d = 0; d < this.districtCount; d++) {
      let rank = this.rank[d];
      const base = d * WORDS_PER_DISTRICT;
      for (let w = 0; w < WORDS_PER_DISTRICT; w++) {
        let word = this.bits[base + w];
        while (word !== 0) {
          const t = word & -word;
          const n = (w << 5) | (31 - Math.clz32(t));
          yield this.makeResult(d, n, rank);
          rank++;
          word ^= t;
        }
      }
    }
  }

  // ------------------------------------------------------------- internals

  /** First district index whose outward is >= key in code-unit order. */
  private lowerBound(key: string): number {
    const outwards = this.outwards;
    let lo = 0;
    let hi = outwards.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (outwards[mid] < key) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** District index for an exact outward, or -1. */
  private findOutward(outward: string): number {
    if (outward.length < OUTWARD_MIN_LENGTH || outward.length > OUTWARD_MAX_LENGTH) return -1;
    const i = this.lowerBound(outward);
    return i < this.outwards.length && this.outwards[i] === outward ? i : -1;
  }

  /**
   * Enumerate the interpretations of a normalised query. See PLAN.md,
   * "Choosing candidate splits".
   */
  private collectCandidates(q: string): Candidate[] {
    const candidates: Candidate[] = [];
    const sp = q.indexOf(' ');
    if (sp >= 0) {
      const d = this.findOutward(q.slice(0, sp));
      if (d >= 0) {
        if (inwardPrefixRange(q.slice(sp + 1), RANGE)) {
          candidates.push({ dLo: d, dHi: d + 1, lo: RANGE[0], hi: RANGE[1], group: 0 });
        }
        return candidates;
      }
      // `ZE10 `: the text before a trailing space is not a district, so the
      // space was typing noise rather than the separator. Retry without it.
      if (sp === q.length - 1) return this.collectCandidates(q.slice(0, sp));
      return candidates;
    }
    if (q.length <= OUTWARD_MAX_LENGTH) {
      const dLo = this.lowerBound(q);
      const dHi = this.lowerBound(q + AFTER_ALNUM);
      if (dLo < dHi) candidates.push({ dLo, dHi, lo: 0, hi: INWARD_COUNT, group: 0 });
    }
    for (let k = 1; k <= 3; k++) {
      const olen = q.length - k;
      if (olen < OUTWARD_MIN_LENGTH) break;
      if (olen > OUTWARD_MAX_LENGTH) continue;
      const d = this.findOutward(q.slice(0, olen));
      if (d < 0) continue;
      if (!inwardPrefixRange(q.slice(olen), RANGE)) continue;
      candidates.push({ dLo: d, dHi: d + 1, lo: RANGE[0], hi: RANGE[1], group: k });
    }
    return candidates;
  }

  /**
   * Append set bits in `[lo, hi)` of districts `[dLo, dHi)` to `out`, lowest
   * first, stopping at `limit`. Rank is computed once per district at `lo`
   * and incremented per result.
   */
  private scan(dLo: number, dHi: number, lo: number, hi: number, limit: number, out: PostcodeResult[]): void {
    const bits = this.bits;
    const wLo = lo >>> 5;
    const wHi = (hi - 1) >>> 5;
    const lowMask = -1 << (lo & 31);
    const hiBits = hi & 31;
    const highMask = hiBits === 0 ? -1 : (1 << hiBits) - 1;
    for (let d = dLo; d < dHi; d++) {
      const base = d * WORDS_PER_DISTRICT;
      let rank = this.rank[d];
      for (let w = 0; w < wLo; w++) rank += popcount32(bits[base + w]);
      rank += popcount32(bits[base + wLo] & ~lowMask);
      for (let w = wLo; w <= wHi; w++) {
        let word = bits[base + w];
        if (w === wLo) word &= lowMask;
        if (w === wHi) word &= highMask;
        while (word !== 0) {
          const t = word & -word;
          const n = (w << 5) | (31 - Math.clz32(t));
          out.push(this.makeResult(d, n, rank));
          if (out.length >= limit) return;
          rank++;
          word ^= t;
        }
      }
    }
  }

  private makeResult(d: number, n: number, rank: number): PostcodeResult {
    const postcode = this.outwards[d] + ' ' + decodeInward(n);
    let lat: number | undefined = undefined;
    let lon: number | undefined = undefined;
    if (this.hasCoordinates) {
      const qLat = this.coords[rank * 2];
      if (qLat !== NO_COORDINATE) {
        const qLon = this.coords[rank * 2 + 1];
        const b = d * BBOX_FLOATS;
        lat = round6(this.bbox[b] + (qLat / QUANT_MAX) * this.bbox[b + 2]);
        lon = round6(this.bbox[b + 1] + (qLon / QUANT_MAX) * this.bbox[b + 3]);
      }
    }
    return { postcode, lat, lon };
  }
}

/**
 * Merge heuristic: outward-prefix matches first, then split candidates with
 * the shortest inward prefix first. Kept in one place so it can be tuned.
 */
export function orderCandidates(candidates: Candidate[]): void {
  if (candidates.length < 2) return;
  candidates.sort((a, b) => a.group - b.group);
}
