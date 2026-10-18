import { QUANT_MAX } from './constants.js';

/** Metres per degree of latitude; longitude is scaled by cos(lat). */
const METRES_PER_DEGREE = 111_000;

/**
 * Worst-case error introduced by quantising a district's coordinates into
 * 65,535 steps across its bounding box, in metres. Zero spans give zero.
 */
export function districtPrecisionMetres(
  minLat: number,
  latSpan: number,
  lonSpan: number,
): number {
  const midLat = minLat + latSpan / 2;
  const latM = (latSpan / QUANT_MAX) * METRES_PER_DEGREE;
  const lonM = (lonSpan / QUANT_MAX) * METRES_PER_DEGREE * Math.cos((midLat * Math.PI) / 180);
  return Math.max(latM, Math.abs(lonM));
}

export interface DistrictPrecision {
  outward: string;
  postcodes: number;
  precisionM: number;
  latSpan: number;
  lonSpan: number;
}
