import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildIndex, INWARD_COUNT, type BuildDistrict } from '../src/index.js';

/** Deterministic PRNG so every run benchmarks the same data. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const AREAS = (() => {
  const out: string[] = [];
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  for (const a of letters) out.push(a);
  for (const a of letters) for (const b of letters) out.push(a + b);
  return out;
})();

/**
 * Generate roughly `districtCount` districts and `postcodeCount` postcodes
 * with UK-like outwards (`AB`, `AB1`, `AB12`, `AB1C`) and per-district
 * clusters of coordinates. Sizes follow a skewed distribution like the real
 * data: a few very large districts, many small ones.
 */
export function generateDistricts(districtCount = 3000, postcodeCount = 1_600_000, seed = 42): BuildDistrict[] {
  const rnd = mulberry32(seed);
  const outwards = new Set<string>();
  let areaIdx = 0;
  while (outwards.size < districtCount) {
    const area = AREAS[areaIdx % AREAS.length];
    areaIdx += 7; // stride so areas are spread across the alphabet
    const n = 1 + Math.floor(rnd() * 25);
    const suffix = rnd() < 0.08 ? 'ABCDEFGHJKLMNPRSTUWXYZ'[Math.floor(rnd() * 22)] : '';
    const outward = `${area}${n}${suffix}`;
    if (outward.length <= 4) outwards.add(outward);
  }
  const list = [...outwards];
  // Skewed sizes: weight ~ 1/(rank)^0.4, normalised to the postcode total.
  const weights = list.map((_, i) => 1 / Math.pow(i + 1, 0.4) + rnd() * 0.2);
  const total = weights.reduce((a, b) => a + b, 0);
  const districts: BuildDistrict[] = [];
  const pool = new Uint16Array(INWARD_COUNT);
  for (let i = 0; i < list.length; i++) {
    const size = Math.max(1, Math.min(INWARD_COUNT, Math.round((weights[i] / total) * postcodeCount)));
    // Partial Fisher-Yates over the 4,000 inward codes to pick `size` distinct ones.
    for (let k = 0; k < INWARD_COUNT; k++) pool[k] = k;
    const baseLat = 49.9 + rnd() * 10.8;
    const baseLon = -8 + rnd() * 9.7;
    const spread = 0.02 + rnd() * rnd() * 0.5;
    const entries = new Array(size);
    for (let k = 0; k < size; k++) {
      const j = k + Math.floor(rnd() * (INWARD_COUNT - k));
      const t = pool[k];
      pool[k] = pool[j];
      pool[j] = t;
      const missing = rnd() < 0.007;
      entries[k] = {
        inward: pool[k],
        lat: missing ? NaN : baseLat + (rnd() - 0.5) * spread,
        lon: missing ? NaN : baseLon + (rnd() - 0.5) * spread,
      };
    }
    districts.push({ outward: list[i], entries });
  }
  return districts;
}

/** Build the synthetic index once and cache it on disk (gitignored). */
export function syntheticIndexBytes(path: string): Uint8Array {
  if (existsSync(path)) return readFileSync(path);
  const started = performance.now();
  const districts = generateDistricts();
  const { buffer, postcodeCount, districtCount } = buildIndex(districts, {
    release: 'SYNTHETIC',
    builtAt: new Date(0).toISOString(),
    exclusions: [],
    sourceFiles: ['synthetic'],
  });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, new Uint8Array(buffer));
  const ms = (performance.now() - started).toFixed(0);
  console.log(`generated synthetic index: ${postcodeCount} postcodes, ${districtCount} districts, ${buffer.byteLength} bytes in ${ms} ms -> ${path}`);
  return new Uint8Array(buffer);
}
