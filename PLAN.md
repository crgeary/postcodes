# Postcode Autocomplete Service: Implementation Plan

Oct 18, 2026 · @Chris

## Overview

Two TypeScript packages: an **indexer CLI** that turns ONSPD CSV releases into a single binary index file (about 8.7 MB for the full UK with coordinates), and a **Hono service** that loads that file into typed arrays and answers left-to-right postcode autocomplete in microseconds.

**Constraints agreed**

- Data budget: 10 MB in memory for the index (process overhead is not counted). The budget is a soft limit, and can be raised.
- Matching: left-to-right prefix only. No suffix or substring search.
- Coordinates: lat/long included for every postcode.
- Coverage: all of ONSPD (England, Scotland, Wales, Northern Ireland, Channel Islands, Isle of Man) by default, with indexer flags to exclude NI and the Crown Dependencies.
- Index source: bundled with the service or fetched from a URL at startup, configurable, with optional periodic refresh.
- Stack: TypeScript, Node 22+, Hono, hono-openapi, spec served at `/openapi.json`.

## Key decisions

The index exploits UK postcode structure so memory is proportional to the number of districts (about 3,000), not postcodes (about 1.8M). Nothing is stored per postcode except its 4-byte coordinate.

| Decision                 | Choice                                                                                               | Why                                                                                                                                                                                                      |
| ------------------------ | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Postcode storage         | One 4,000-bit bitset per outward district (500 bytes each)                                           | Inward codes are `digit + 2 letters` from a 20-letter alphabet (no C, I, K, M, O, V), so only 4,000 are possible. Bit n set = that inward code exists. About 1.5 MB total, independent of postcode count |
| Inward encoding          | `digit × 400 + letter1 × 20 + letter2`                                                               | A typed prefix (`1`, `1A`) maps to one contiguous bit range, so prefix search is a range scan                                                                                                            |
| District ordering        | Sorted by plain UTF-16 code unit order, fixed 4-byte space-padded ASCII                              | Binary search for exact and prefix matches; `SW1 ` < `SW10` < `SW1A` is accepted as the result order                                                                                                     |
| Coordinates              | 2 × `Uint16` per postcode, quantised inside the district's bounding box (`Float32` × 4 per district) | 4 bytes per postcode (about 7.2 MB). Sub-metre precision for normal districts; worst case about 2 m for the largest rural ones                                                                           |
| Coordinate index         | Rank = cumulative count per district + popcount of bits before the postcode                          | No per-postcode pointer needed. Popcount covers at most 125 words                                                                                                                                        |
| Missing coordinates      | Both `Uint16` = `0xFFFF`                                                                             | ONSPD marks no-grid-ref rows with lat 99.999999; those stay searchable but return no lat/long                                                                                                            |
| In-memory representation | Typed-array views over one `ArrayBuffer` read in a single `readFileSync`                             | Zero parsing, zero per-postcode objects, no GC pressure. Only the \~3,000 outward strings live on the V8 heap                                                                                            |
| File format              | Little-endian, every section 4-byte aligned, header carries version, flags, checksum and metadata    | Views can be created directly; version and checksum are validated before any swap                                                                                                                        |
| Input without a space    | Try every valid split and merge                                                                      | `B11` is both the B11 district and `B1 1…`; both exist. Extra lookups cost microseconds                                                                                                                  |
| Exclusions               | By ONSPD `ctry25cd` country code, not postcode prefix                                                | Prefix rules are fragile; the country code is authoritative                                                                                                                                              |
| Live postcodes only      | Rows with empty `doterm`                                                                             | Terminated postcodes are about a third of ONSPD and never useful for autocomplete                                                                                                                        |

**Memory estimate for the full UK (about 1.8M live postcodes, about 3,000 districts)**

- Bitsets: about 1.5 MB
- Coordinates: about 7.2 MB
- Rank, bounding boxes, outward codes: about 0.1 MB
- Total: about 8.7 MB, leaving about 1.3 MB of the 10 MB budget. During a refresh the old and new indexes coexist briefly, so peak is about 2× for a few seconds.

If headroom is ever needed: 12-bit coordinates (3 bytes per postcode, saves about 1.8 MB), or excluding NI and the Crown Dependencies (about 60k postcodes, about 240 KB).

## Index file format

One binary file, little-endian, sections in this order, each starting on a 4-byte boundary. `D` = district count, `N` = postcode count.

| Section        | Size (bytes)          | Type                        | Contents                                                         |
| -------------- | --------------------- | --------------------------- | ---------------------------------------------------------------- |
| Header         | 64                    | mixed                       | See below                                                        |
| Metadata       | variable, padded to 4 | UTF-8 JSON                  | `{ release, builtAt, exclusions, sourceFiles, worstPrecisionM }` |
| Outwards       | 4 × D                 | ASCII                       | Space-padded outward codes, sorted by code unit                  |
| Rank           | 4 × (D + 1)           | `Uint32`                    | Cumulative postcode count before each district; last entry = N   |
| Bitsets        | 500 × D               | `Uint32` × 125 per district | Bit n = inward code n exists                                     |
| Bounding boxes | 16 × D                | `Float32` × 4               | `minLat, minLon, latSpan, lonSpan` per district                  |
| Coordinates    | 4 × N                 | `Uint16` × 2                | Quantised lat, lon in rank order                                 |

**Header (64 bytes)**

| Offset | Type        | Field                                                  |
| ------ | ----------- | ------------------------------------------------------ |
| 0      | `char[4]`   | Magic `PCIX`                                           |
| 4      | `Uint16`    | Format version (start at 1; bump on any layout change) |
| 6      | `Uint16`    | Flags (bit 0 = has coordinates; reserved otherwise)    |
| 8      | `Uint32`    | D                                                      |
| 12     | `Uint32`    | N                                                      |
| 16     | `Uint32`    | Metadata length in bytes                               |
| 20     | `Uint32`    | Total file length                                      |
| 24     | `Uint8[32]` | SHA-256 of everything after the header                 |
| 56     | 8 bytes     | Reserved, zero                                         |

**Encoding rules**

- Inward letters, in index order: `ABDEFGHJLNPQRSTUWXYZ`. Inward code = `digit × 400 + l1 × 20 + l2`, range 0 to 3,999.
- Bit n lives in word `n >> 5`, bit `n & 31`, of the district's 125 words.
- Quantised coordinate = `round((value − min) / span × 65534)`, so 65,535 (`0xFFFF`) is free to mean "no coordinates". Decode as `min + q / 65534 × span`.
- The indexer writes the bounding box as `Float32` first, then quantises against the rounded values, so decoding is exact to the quantisation step.
- A district whose postcodes all lack coordinates gets a zero bounding box.

**Loading**

Read the file into one `ArrayBuffer`, validate magic, version, length and checksum, then create typed-array views at computed offsets. `readFileSync` may return a `Buffer` with a non-zero `byteOffset` into a pooled buffer; copy to a fresh `ArrayBuffer` if `byteOffset % 4 !== 0` or the buffer is shared.

## Indexer CLI

An offline tool, run once per ONSPD release. It can use as much memory as it likes; only the output file is constrained.

```
postcode-index build [--exclude-ni] [--exclude-crown-dependencies] [--gb-only] [--release FEB_2026] -o postcodes.idx <onspd.csv>...
postcode-index inspect postcodes.idx
```

**Input**

- Accepts one or more ONSPD CSV files (the single UK file, or the per-area files like `ONSPD_FEB_2026_UK_ZE.csv`). Stream with `readline`; never load a CSV whole. The full UK file is about 1.3 GB.
- In the sample file the header row is unquoted and data rows are fully quoted. Strip surrounding quotes per field. ONSPD fields contain no commas, so a plain split is safe.
- Locate columns by header name, not position: `pcds`, `doterm`, `lat`, `long`, `ctry25cd`. Fail loudly if any is missing. Later releases rename year-suffixed columns (e.g. `ctry26cd`), so match `ctry\d{2}cd` by pattern.
- `pcds` always has exactly one space between outward and inward (`ZE1 0AA`), so split on it rather than re-deriving the inward code from the last three characters.

**Row rules**

1. Skip rows with a non-empty `doterm` (terminated).
2. Skip rows whose country code is excluded by the flags: NI = `N92000002`, Channel Islands = `L93000001`, Isle of Man = `M83000003`. `--gb-only` = both exclusions.
3. Reject and count rows whose outward is not 2 to 4 characters or whose inward fails `^[0-9][ABDEFGHJLNPQRSTUWXYZ]{2}$`. Expect zero; a non-zero count means the format changed.
4. Treat `lat > 90`, non-numeric, or empty coordinates as missing.
5. Deduplicate identical postcodes across input files.

**Build steps**

1. Collect `Map<outward, Array<{inward, lat, lon}>>` while streaming.
2. Sort outwards by code unit; sort each district's entries by inward code, so bit order equals rank order.
3. Compute each district's bounding box from rows that have coordinates, store as `Float32`, then quantise each entry against the stored values.
4. Fill header, metadata JSON, outwards, rank, bitsets, bounding boxes, coordinates into one `ArrayBuffer`; compute SHA-256; write once.

**Output report (stdout, also stored in metadata)**

- Postcodes, districts, file size.
- Counts skipped: terminated, excluded by flag, invalid, duplicates, without coordinates.
- Worst-case coordinate precision in metres per district, and the ten worst districts. Precision = `span / 65534` converted to metres (lat: × 111 km; lon: × 111 km × cos lat). Alert if any district exceeds an agreed threshold, e.g. 5 m, which usually indicates an outlier coordinate widening the box.

`inspect` prints the header, metadata and the same report from an existing index, and verifies the checksum. Use it in CI and before deploying a fetched index.

## Query engine

A `PostcodeIndex` class that owns the typed-array views and exposes two methods: `search(input, limit)` and `lookup(input)`. It holds no state beyond the views and the outward string array, so it can be swapped atomically.

**Normalisation**

1. Uppercase; drop every character except `A–Z`, `0–9` and space; collapse runs of spaces; trim leading space.
2. Empty input or `limit <= 0` returns `[]`.

**Choosing candidate splits**

A candidate is a district range `[dLo, dHi)` plus an inward bit range `[lo, hi)`.

- Input contains a space: exact outward = text before the space, inward prefix = text after it. One candidate.
- No space and length ≤ 4: the input may be an outward prefix. Binary-search the sorted outwards for the range starting with it; inward range = all 4,000 bits.
- No space: for `k` = 1 to 3, if `length − k ≥ 2`, treat the last `k` characters as an inward prefix and the rest as an exact outward. Keep the candidate only if the outward exists and the inward prefix is valid.

Inward prefix to bit range: `""` = `[0, 4000)`, `"1"` = `[400, 800)`, `"1A"` = `[400 + 20a, +20)`, `"1AA"` = a single bit. Any invalid character makes the candidate invalid.

**Scanning**

- For each district in the candidate, walk words `lo >> 5` to `(hi − 1) >> 5`. Mask off bits below `lo` in the first word and above `hi` in the last.
- Extract set bits lowest first with `t = word & -word`, position `31 − Math.clz32(t)`, then `word ^= t`.
- Stop as soon as `limit` results are collected, so cost is O(limit) regardless of how many matches exist.
- Compute the rank once at `lo` (cumulative count + popcount of preceding words) and increment it per result, so coordinate lookup is O(1) per result.

**Merging candidates**

When more than one candidate matched, order groups rather than sorting alphabetically: outward-prefix matches first, then the split candidates in order of shortest inward prefix. Within a group, results are already in district then inward order. Truncate to `limit`. This is a heuristic; keep it in one function so it can be tuned.

**Output**

Always format with the space (`ZE1 0AA`) so the user can see which interpretation each result came from. Decode coordinates from the district bounding box and round to 6 decimal places. Omit `lat`/`lon` when the stored value is `0xFFFF`.

`lookup` is the degenerate case: requires 5 to 7 characters after stripping spaces, exact outward, exact inward, single bit test.

## Service: loading and refresh

The service holds one `PostcodeIndex` reference behind an `IndexHolder`. Loading, validation and refresh all go through the holder; request handlers only ever read `holder.current`.

**Configuration (environment variables with constant defaults in `config.ts`)**

| Variable                                    | Default                | Meaning                                                              |
| ------------------------------------------- | ---------------------- | -------------------------------------------------------------------- |
| `POSTCODE_INDEX`                            | `./data/postcodes.idx` | A file path or an `http(s)://` URL. The scheme selects the loader    |
| `POSTCODE_INDEX_FALLBACK`                   | unset                  | Optional bundled path used if the primary fails at startup           |
| `POSTCODE_INDEX_REFRESH_MS`                 | `0`                    | Refresh interval; `0` disables. Applies to both URL and file sources |
| `POSTCODE_INDEX_REFRESH_JITTER`             | `0.1`                  | Fraction of the interval randomised each cycle                       |
| `POSTCODE_INDEX_FETCH_TIMEOUT_MS`           | `30000`                | Per-fetch timeout                                                    |
| `SEARCH_DEFAULT_LIMIT` / `SEARCH_MAX_LIMIT` | `10` / `50`            | Result caps                                                          |
| `PORT`                                      | `3000`                 | Listen port                                                          |

**Loaders**

- File: `readFileSync`, then validate. Record `mtime` for refresh comparisons.
- URL: `fetch` with `AbortSignal.timeout`; send `If-None-Match` / `If-Modified-Since` from the previous response. A `304` ends the cycle with no download. Read the body as an `ArrayBuffer` directly; never convert to a string.
- Both: validate magic, format version, declared length and SHA-256 before constructing the index. Reject on any mismatch and keep the current index.

**Startup**

1. Load from `POSTCODE_INDEX`. On failure, try `POSTCODE_INDEX_FALLBACK` if set; log that the fallback is in use.
2. If nothing loads, exit non-zero. Readiness is only true once an index is held.
3. Start the refresh timer if the interval is above zero. Use `timer.unref()` so it never keeps the process alive during shutdown.

**Refresh cycle**

1. Sleep `interval × (1 ± jitter)`.
2. File source: compare `mtime` and size; skip if unchanged. URL source: conditional request; skip on `304`.
3. Download or read, validate, construct a new `PostcodeIndex`.
4. Swap: `holder.current = next`. In-flight requests keep their reference to the old index. Drop every other reference to the old one so it is collectable.
5. On any error: log, record `lastError` and `lastAttemptAt`, keep serving the current index, never flip readiness.
6. Skip the cycle if a previous one is still running.

**Pros and cons of each source** (for the runbook)

- Bundled: no external dependency at start, version pinned to the deploy, works offline. Every ONSPD update needs a rebuild and redeploy, and the image grows by about 9 MB.
- Fetched: data updates without a redeploy, one index shared across instances, small image. Startup depends on the host; the running version is less obvious, hence `/health` metadata.

Fetched with a bundled fallback and refresh enabled is the recommended production setting.

## API (Hono + hono-openapi)

Four routes, all `GET`, JSON responses, schemas defined once in Zod and reused for validation and the spec.

| Route                     | Query / path                                          | Response                                                                                                                                                            | Notes                                                                    |
| ------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `/postcodes/autocomplete` | `q` (1–8 chars, required), `limit` (1–50, default 10) | `{ results: Result[] }`                                                                                                                                             | Returns `[]` rather than 404 for no match. 400 on invalid params         |
| `/postcodes/{postcode}`   | path, 5–8 chars                                       | `Result`                                                                                                                                                            | 404 with `{ error: "not_found" }` if unknown                             |
| `/health`                 | none                                                  | `{ status, ready, index: { release, builtAt, postcodes, districts, exclusions, loadedAt, source }, refresh: { enabled, lastAttemptAt, lastSuccessAt, lastError } }` | 503 while not ready, so orchestrators can gate traffic on it             |
| `/openapi.json`           | none                                                  | OpenAPI 3.1 JSON                                                                                                                                                    | Generated by hono-openapi; optionally `/docs` with Scalar pointing at it |

`Result` = `{ postcode: string, lat?: number, lon?: number }`, with `postcode` always formatted with the space.

**Implementation notes**

- Use `describeRoute` for the OpenAPI description and the `validator` middleware with Zod schemas for `query` and `param`. Declare the 400 and 404 error schemas so they appear in the spec.
- Mount the generated spec with `openAPIRouteHandler` (or the equivalent in the installed hono-openapi version) at `/openapi.json`, with title, version and a short description. Pin the hono-openapi version and check its current API, since the package has changed shape between releases.
- Handlers do no work beyond normalising input, calling `holder.current.search()` or `.lookup()`, and serialising. Keep them synchronous; nothing in the hot path awaits.
- Set `Cache-Control: public, max-age=…` on autocomplete and lookup responses. The index changes at most quarterly, so an hour is safe, and a CDN can absorb repeated prefixes.
- Add a request-id and structured logging middleware, but log at debug level on the hot path only.
- Validate `q` length before touching the index. Eight characters is the longest valid input with a space.

## Performance rules

These are the implementation details that keep memory at about 8.7 MB and searches at about 2 µs. Treat them as review criteria for every PR touching `PostcodeIndex`.

**Memory**

- One `ArrayBuffer` per index, views created with explicit `byteOffset` and `length`. Never `slice()` or copy sections.
- No per-postcode JavaScript values: no strings, objects, `Map` or `Set` entries. The only heap-resident data is the array of about 3,000 outward strings, built once at load.
- Build result strings only for the `limit` results returned, never for everything scanned.
- Hold exactly one reference to the current index, in the holder. Closures, caches or loggers that capture an index keep old copies alive across refreshes.
- Lookup tables used in the hot path (letter to index, popcount) are small typed arrays created once at module load.

**CPU**

- Bit extraction with `word & -word` and `Math.clz32`; no per-bit loops.
- Masks built with shifts, not loops; words outside `[lo, hi)` are never touched.
- Early exit on `limit` in every loop level.
- Rank computed once per candidate and incremented, not recomputed per result.
- Integer arithmetic only in the hot path (`| 0`, `>>> 0`). Floats appear only when decoding the returned coordinates.
- Keep hot functions monomorphic: same argument types every call, no optional fields on `PostcodeResult` added conditionally in different shapes. Create the object with `lat` and `lon` set to `undefined` when absent so the hidden class is stable.
- No `async` or `await` between receiving a request and returning results.

**Process**

- Pin the index format version and checksum validation at load; a corrupt file must fail before it is swapped in.
- Expose `process.memoryUsage().arrayBuffers` in `/health` or metrics. It should sit within a few hundred KB of the index size; growth across refreshes means an old index is being retained.
- Run with `--max-old-space-size` set modestly (e.g. 128 MB). The index is off-heap, so the heap only holds request-scoped garbage.

**Benchmarks to keep in CI**

- Load time under 20 ms for the full UK index.
- Median `search()` under 10 µs for a fixed set of prefixes, with `limit` 10.
- Peak `arrayBuffers` after ten consecutive refreshes under 2× index size.

## Project structure, tooling and testing

A single repository with three packages, so the file format lives in one place and both the indexer and the service depend on it.

```
packages/
  index-format/   encode/decode, PostcodeIndex class, format constants, validation   (no runtime deps)
  indexer/        CLI: build, inspect                                                 (depends on index-format)
  service/        Hono app, holder, loaders, routes, OpenAPI                           (depends on index-format)
```

**Tooling**

- Node 22 LTS or later, TypeScript 5.x, `module: NodeNext`, `strict: true`.
- pnpm workspaces; `tsx` for development, `tsc` build for production.
- Vitest for tests; a `bench` script using `node --expose-gc` for the CI benchmarks.
- Lint rule or review check: no `async` in `index-format`.
- Docker image for the service built from the compiled output, with `data/postcodes.idx` copied in when bundling is chosen.

**Tests**

| Package      | Test                                                                                                                                                            | Purpose                                     |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| index-format | Round-trip: encode every inward code 0–3,999, decode, compare                                                                                                   | Encoding is bijective                       |
| index-format | Build an index from the ZE sample CSV; for every live postcode, every prefix with and without the space, compare `search()` against a brute-force string filter | Query correctness, including split handling |
| index-format | Coordinates decode within 0.00002° of the CSV values; rows without coordinates return none                                                                      | Quantisation                                |
| index-format | Corrupt header, wrong version, bad checksum, truncated file are all rejected                                                                                    | Validation                                  |
| indexer      | Quoted and unquoted CSV rows, renamed `ctry` column, exclusion flags by country code, duplicate rows across files                                               | Parsing robustness                          |
| indexer      | Precision report flags an injected outlier coordinate                                                                                                           | Outlier detection                           |
| service      | `/health` returns 503 before load and 200 after; `/openapi.json` validates as OpenAPI 3.1; 400 and 404 shapes match the spec                                    | API contract                                |
| service      | Refresh: `304` is a no-op; a corrupt download keeps the old index and sets `lastError`; a valid one swaps and old `arrayBuffers` are released after GC          | Refresh behaviour                           |

The ZE sample file (658 live postcodes, 3 districts) is small enough to commit as a fixture. Add a generated full-scale fixture (about 1.6M synthetic postcodes) for the benchmarks only; do not commit it.

## Plan of action

Six phases, each with a done criterion. Phases 1 and 2 are the core and should be finished and tested before any service code is written.

1. **Repository and format package.** Workspace, tsconfig, Vitest, CI running tests and benchmarks. Implement constants, inward encode/decode, header read/write, checksum, `PostcodeIndex` with `search()` and `lookup()`. Done when: encode round-trip and validation tests pass; the ZE fixture brute-force comparison passes for every prefix.
2. **Indexer CLI.** Streaming CSV parser, row rules, exclusion flags, build, metadata, precision report, `inspect`. Done when: the full ONSPD UK file builds in one run, the output is about 8.7 MB, `inspect` verifies it, and the worst-district precision is reported.
3. **Benchmarks.** Synthetic full-scale fixture generator; load-time, search-latency and refresh-memory benchmarks in CI with thresholds. Done when: load under 20 ms, median search under 10 µs, `arrayBuffers` stable across ten refreshes.
4. **Service core.** `config.ts`, `IndexHolder`, file and URL loaders with validation, startup with fallback, readiness. Done when: the service starts from a file and from a URL, refuses a corrupt file, and `/health` reflects the loaded metadata.
5. **Routes and OpenAPI.** Zod schemas, `describeRoute` + `validator`, the four routes, `/openapi.json`, cache headers, logging. Done when: the spec validates as OpenAPI 3.1 and contract tests pass for 200, 400, 404 and 503.
6. **Refresh and deployment.** Refresh timer with jitter, conditional requests, swap and error handling, Dockerfile, runbook covering both source modes and the quarterly ONSPD update. Done when: refresh tests pass and a staging deploy picks up a newly published index without a restart.

**Quarterly operating procedure**

1. Download the new ONSPD release.
2. Run `build` with the agreed flags; review the precision report.
3. Run `inspect` on the output and compare postcode counts with the previous release (expect a small net increase).
4. Publish to the index host (fetched mode) or rebuild the image (bundled mode).
5. Confirm `/health` reports the new release on every instance.

## Risks and licensing

- **Northern Ireland postcodes.** ONSPD's NI data is supplied under separate terms from Land & Property Services and may need a licence for commercial use. Confirm before serving BT postcodes to customers; the `--exclude-ni` flag exists so the decision can be reversed without code changes.
- **Attribution.** ONSPD is published under the Open Government Licence but contains Royal Mail and Ordnance Survey data. Include the required attribution statements in the service's documentation and any customer-facing use.
- **Column renames.** ONSPD renames year-suffixed columns (`ctry25cd`) in later releases. Matching by pattern avoids a silent break; a hard fail on a missing column avoids a silent empty index.
- **Outlier coordinates.** One wrong coordinate widens a district's bounding box and degrades precision for every postcode in it. The precision report and threshold catch this at build time.
- **Refresh memory spike.** Old and new indexes coexist for a moment, about 18 MB. Acceptable now; if the budget tightens, refresh could stream the new file into a pre-allocated buffer, at the cost of serving nothing during validation.
- **Postcode format drift.** The 20-letter inward alphabet and 2–4 character outward are long-standing Royal Mail rules. The indexer rejects anything else, so a change would surface as a non-zero invalid count rather than a corrupt index.
- **hono-openapi churn.** The package's API has changed between versions. Pin it and wrap it in one module so an upgrade touches one file.
