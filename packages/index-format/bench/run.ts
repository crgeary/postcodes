/**
 * CI benchmarks from PLAN.md. Run with `node --expose-gc --import tsx bench/run.ts`.
 *
 *   - load time under LOAD_MS for a full-scale index
 *   - median search() under SEARCH_US for a fixed set of prefixes, limit 10
 *   - peak arrayBuffers after ten consecutive refreshes under 2x index size
 *
 * Set BENCH_INDEX=<path> to benchmark a real index instead of the synthetic one.
 *
 * Each section is a function so its locals (and the index they hold) are
 * unreachable once it returns; the memory section must see only the index
 * it is holding itself.
 */
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PostcodeIndex } from '../src/index.js';
import { syntheticIndexBytes } from './synthetic.js';

const LOAD_MS = Number(process.env.BENCH_LOAD_MS ?? 20);
const SEARCH_US = Number(process.env.BENCH_SEARCH_US ?? 10);
const REFRESH_FACTOR = Number(process.env.BENCH_REFRESH_FACTOR ?? 2);
const LIMIT = 10;

const gc: (() => void) | undefined = (globalThis as { gc?: () => void }).gc;
if (!gc) {
  console.error('run with --expose-gc');
  process.exit(2);
}
const collect = gc;

const indexPath =
  process.env.BENCH_INDEX ?? fileURLToPath(new URL('../../../bench-data/synthetic.idx', import.meta.url));
// Generate (and cache on disk) the synthetic index if needed, but do not keep
// its bytes: every section reads the file, so the bench itself never holds a
// copy that would distort the memory measurement.
if (!process.env.BENCH_INDEX) syntheticIndexBytes(indexPath);
const indexBytes = statSync(indexPath).size;
const readIndex = (): Uint8Array => readFileSync(indexPath);

let failed = false;
function check(name: string, value: number, limit: number, unit: string): void {
  const ok = value <= limit;
  if (!ok) failed = true;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${value.toFixed(3)} ${unit} (limit ${limit} ${unit})`);
}

function median(xs: number[]): number {
  const s = xs.slice().sort((a, b) => a - b);
  return s[s.length >> 1];
}

/**
 * ArrayBuffer backing stores are freed by V8's array-buffer sweeper after the
 * owning objects die, which can finish after gc() returns. Collect twice
 * around a macrotask so readings reflect the steady state rather than sweeper
 * timing (otherwise seen as exactly 2.0x on CI runners).
 */
async function settle(): Promise<void> {
  collect();
  await new Promise<void>((resolve) => setImmediate(resolve));
  collect();
}

// ---------------------------------------------------------------- load time
function benchLoad(): void {
  const times: number[] = [];
  let index: PostcodeIndex | undefined;
  for (let i = 0; i < 7; i++) {
    collect();
    const fresh = readIndex();
    const t0 = performance.now();
    index = PostcodeIndex.fromBytes(fresh);
    times.push(performance.now() - t0);
  }
  console.log(
    `index: ${index!.postcodeCount.toLocaleString('en-GB')} postcodes, ${index!.districtCount.toLocaleString('en-GB')} districts, ${(indexBytes / 1e6).toFixed(2)} MB`,
  );
  check('load time (median of 7, includes SHA-256)', median(times), LOAD_MS, 'ms');
}

// ------------------------------------------------------------ search latency
function benchSearch(): void {
  const index = PostcodeIndex.fromBytes(readIndex());
  const outwards = index.outwards;
  const pick = (i: number) => outwards[(i * 7919) % outwards.length];
  // Mix of single letters, outward prefixes, full outwards, space + inward
  // prefix, and no-space splits.
  const queries: string[] = [];
  for (let i = 0; i < 8; i++) {
    const o = pick(i);
    const first = index.search(o + ' ', 1)[0]?.postcode ?? `${o} 1AA`;
    const inward = first.slice(first.indexOf(' ') + 1);
    queries.push(o[0], o.slice(0, 2), o, `${o} `, `${o} ${inward[0]}`, `${o} ${inward.slice(0, 2)}`, `${o}${inward[0]}`, `${o}${inward.slice(0, 2)}`, first, first.replace(' ', ''));
  }
  // Warm up so the JIT settles on the hot path.
  for (let r = 0; r < 2000; r++) for (const q of queries) index.search(q, LIMIT);

  const ROUNDS = 200;
  const perQuery: number[] = [];
  let sink = 0;
  for (const q of queries) {
    const t0 = process.hrtime.bigint();
    for (let r = 0; r < ROUNDS; r++) sink += index.search(q, LIMIT).length;
    const ns = Number(process.hrtime.bigint() - t0);
    perQuery.push(ns / ROUNDS / 1000);
  }
  const med = median(perQuery);
  const worst = Math.max(...perQuery);
  console.log(`search: ${queries.length} queries x ${ROUNDS} rounds, worst ${worst.toFixed(2)} us, results ${sink}`);
  check(`search() median, limit ${LIMIT}`, med, SEARCH_US, 'us');

  // lookup() for reference, no threshold.
  const full = index.search(pick(3) + ' ', 1)[0].postcode;
  const t0 = process.hrtime.bigint();
  for (let r = 0; r < 10_000; r++) sink += index.lookup(full) ? 1 : 0;
  console.log(`lookup(): ${(Number(process.hrtime.bigint() - t0) / 10_000 / 1000).toFixed(3)} us`);
}

// ---------------------------------------------------------- refresh memory
// Criterion from PLAN.md: peak arrayBuffers after ten consecutive refreshes
// under 2x the index size. Steady state is about 1x (the one held index);
// 2x means an old index is being retained across swaps.
async function benchRefresh(): Promise<void> {
  let current: PostcodeIndex | null = null;
  let peak = 0;
  for (let i = 0; i < 10; i++) {
    const next = PostcodeIndex.fromBytes(readIndex());
    current = next; // the only reference to the old index is dropped here
    await settle();
    const now = process.memoryUsage().arrayBuffers;
    if (now > peak) peak = now;
  }
  console.log(`refresh: held ${current!.postcodeCount} postcodes, peak arrayBuffers ${(peak / 1e6).toFixed(2)} MB over 10 refreshes`);
  check('peak arrayBuffers / index size', peak / indexBytes, REFRESH_FACTOR, 'x');
}

benchLoad();
benchSearch();
await settle();
await benchRefresh();
process.exit(failed ? 1 : 0);
