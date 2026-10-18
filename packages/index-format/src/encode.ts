import { computeChecksum } from './checksum.js';
import {
  BBOX_FLOATS,
  CHECKSUM_OFFSET,
  FLAG_HAS_COORDINATES,
  FORMAT_VERSION,
  INWARD_COUNT,
  NO_COORDINATE,
  OUTWARD_BYTES,
  OUTWARD_MAX_LENGTH,
  OUTWARD_MIN_LENGTH,
  QUANT_MAX,
  WORDS_PER_DISTRICT,
} from './constants.js';
import { computeLayout, IndexFormatError, writeHeader } from './header.js';
import type { IndexMetadata } from './metadata.js';
import { districtPrecisionMetres } from './precision.js';

/** One live postcode within a district. `lat`/`lon` are NaN when missing. */
export interface BuildEntry {
  /** Inward bit index 0..3999 (see `encodeInward`). */
  inward: number;
  lat: number;
  lon: number;
}

export interface BuildDistrict {
  /** Outward code, 2 to 4 characters, uppercase ASCII, no padding. */
  outward: string;
  entries: BuildEntry[];
}

/** Metadata supplied by the caller; `worstPrecisionM` is computed by the builder. */
export interface BuildMetadata {
  release: string;
  builtAt: string;
  exclusions: string[];
  sourceFiles: string[];
  [key: string]: unknown;
}

export interface BuildResult {
  buffer: ArrayBuffer;
  metadata: IndexMetadata;
  districtCount: number;
  postcodeCount: number;
  withoutCoordinates: number;
}

const encoder = new TextEncoder();

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function hasCoords(e: BuildEntry): boolean {
  return Number.isFinite(e.lat) && Number.isFinite(e.lon);
}

function quantise(value: number, min: number, span: number): number {
  if (span <= 0) return 0;
  const q = Math.round(((value - min) / span) * QUANT_MAX);
  return q < 0 ? 0 : q > QUANT_MAX ? QUANT_MAX : q;
}

/**
 * Build a complete index file image from in-memory districts. Districts and
 * entries are sorted here; callers do not need to pre-sort. Throws on invalid
 * outwards, inward indexes out of range, or duplicate postcodes.
 */
export function buildIndex(districtsIn: BuildDistrict[], metadataIn: BuildMetadata): BuildResult {
  const districts = districtsIn.slice().sort((a, b) => compareCodeUnits(a.outward, b.outward));
  const D = districts.length;
  let N = 0;
  let withoutCoordinates = 0;

  // Per-district bounding boxes, stored as Float32 first so quantisation
  // happens against the values the reader will decode with.
  const bbox = new Float32Array(D * BBOX_FLOATS);
  let worstPrecisionM = 0;

  for (let d = 0; d < D; d++) {
    const district = districts[d];
    const outward = district.outward;
    if (
      outward.length < OUTWARD_MIN_LENGTH ||
      outward.length > OUTWARD_MAX_LENGTH ||
      !/^[A-Z0-9]+$/.test(outward)
    ) {
      throw new IndexFormatError(`invalid outward ${JSON.stringify(outward)}`);
    }
    if (d > 0 && districts[d - 1].outward === outward) {
      throw new IndexFormatError(`duplicate district ${outward}`);
    }
    district.entries.sort((a, b) => a.inward - b.inward);
    let minLat = Infinity;
    let maxLat = -Infinity;
    let minLon = Infinity;
    let maxLon = -Infinity;
    for (let i = 0; i < district.entries.length; i++) {
      const e = district.entries[i];
      if (e.inward < 0 || e.inward >= INWARD_COUNT || (e.inward | 0) !== e.inward) {
        throw new IndexFormatError(`invalid inward index ${e.inward} in ${outward}`);
      }
      if (i > 0 && district.entries[i - 1].inward === e.inward) {
        throw new IndexFormatError(`duplicate postcode in ${outward} (inward ${e.inward})`);
      }
      if (hasCoords(e)) {
        if (e.lat < minLat) minLat = e.lat;
        if (e.lat > maxLat) maxLat = e.lat;
        if (e.lon < minLon) minLon = e.lon;
        if (e.lon > maxLon) maxLon = e.lon;
      } else {
        withoutCoordinates++;
      }
    }
    N += district.entries.length;
    const b = d * BBOX_FLOATS;
    if (minLat === Infinity) {
      // No coordinates at all: zero box.
      bbox[b] = 0;
      bbox[b + 1] = 0;
      bbox[b + 2] = 0;
      bbox[b + 3] = 0;
    } else {
      bbox[b] = minLat;
      bbox[b + 1] = minLon;
      bbox[b + 2] = maxLat - minLat;
      bbox[b + 3] = maxLon - minLon;
      const p = districtPrecisionMetres(bbox[b], bbox[b + 2], bbox[b + 3]);
      if (p > worstPrecisionM) worstPrecisionM = p;
    }
  }

  const metadata: IndexMetadata = {
    ...metadataIn,
    worstPrecisionM: Math.round(worstPrecisionM * 1000) / 1000,
  };
  const metadataBytes = encoder.encode(JSON.stringify(metadata));
  const flags = FLAG_HAS_COORDINATES;
  const layout = computeLayout(D, N, metadataBytes.byteLength, flags);

  const buffer = new ArrayBuffer(layout.fileLength);
  writeHeader(buffer, {
    version: FORMAT_VERSION,
    flags,
    districtCount: D,
    postcodeCount: N,
    metadataLength: metadataBytes.byteLength,
    fileLength: layout.fileLength,
  });
  new Uint8Array(buffer, layout.metadataOffset, metadataBytes.byteLength).set(metadataBytes);

  const outwards = new Uint8Array(buffer, layout.outwardsOffset, D * OUTWARD_BYTES);
  const rank = new Uint32Array(buffer, layout.rankOffset, D + 1);
  const bits = new Uint32Array(buffer, layout.bitsetsOffset, D * WORDS_PER_DISTRICT);
  new Float32Array(buffer, layout.bboxOffset, D * BBOX_FLOATS).set(bbox);
  const coords = new Uint16Array(buffer, layout.coordsOffset, layout.coordsLength / 2);

  let r = 0;
  for (let d = 0; d < D; d++) {
    const district = districts[d];
    const o = d * OUTWARD_BYTES;
    for (let i = 0; i < OUTWARD_BYTES; i++) {
      outwards[o + i] = i < district.outward.length ? district.outward.charCodeAt(i) : 0x20;
    }
    rank[d] = r;
    const b = d * BBOX_FLOATS;
    const minLat = bbox[b];
    const minLon = bbox[b + 1];
    const latSpan = bbox[b + 2];
    const lonSpan = bbox[b + 3];
    const wordBase = d * WORDS_PER_DISTRICT;
    for (const e of district.entries) {
      bits[wordBase + (e.inward >>> 5)] |= 1 << (e.inward & 31);
      if (hasCoords(e)) {
        coords[r * 2] = quantise(e.lat, minLat, latSpan);
        coords[r * 2 + 1] = quantise(e.lon, minLon, lonSpan);
      } else {
        coords[r * 2] = NO_COORDINATE;
        coords[r * 2 + 1] = NO_COORDINATE;
      }
      r++;
    }
  }
  rank[D] = r;

  new Uint8Array(buffer, CHECKSUM_OFFSET, 32).set(computeChecksum(buffer));
  return { buffer, metadata, districtCount: D, postcodeCount: N, withoutCoordinates };
}
