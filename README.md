# Postcode autocomplete

Left-to-right UK postcode autocomplete and lookup, backed by a compact binary index built from the ONS Postcode Directory (ONSPD). Two tools and one shared package:

| Package | Purpose |
| --- | --- |
| `packages/index-format` | The index file format: encode, validate, and the `PostcodeIndex` query engine. No runtime dependencies, nothing asynchronous. |
| `packages/indexer` | `postcode-index build` turns ONSPD CSV releases into one `.idx` file; `postcode-index inspect` verifies and describes one. |
| `packages/service` | Hono HTTP service: `/search`, `/{postcode}`, `/health`, `/openapi.json`, `/docs`. |

The full UK index (1.8 million live postcodes with coordinates, 2,977 districts) is 8.8 MB, loads in about 3 ms, and answers a search in well under 10 µs. Memory is proportional to the number of districts, not postcodes: each district holds a 4,000-bit set of possible inward codes, and each postcode stores only a 4-byte quantised coordinate. See [PLAN.md](PLAN.md) for the design and [docs/RUNBOOK.md](docs/RUNBOOK.md) for operations.

## Requirements

Node 22 or later and pnpm 10.

```bash
pnpm install
```

## Build an index

Download an ONSPD release (the single UK file, or the per-area files under `multi_csv/`), then:

```bash
pnpm index build -o packages/service/data/postcodes.idx /path/to/ONSPD_FEB_2026_UK.csv
```

Run these from the repository root; relative paths resolve against your current directory, and the output directory is created if missing. Flags: `--exclude-ni`, `--exclude-crown-dependencies`, `--gb-only`, `--release FEB_2026`, `--precision-threshold 5`. The build prints a report (counts, file size, ten worst districts by coordinate precision) and exits non-zero if any district exceeds the precision threshold, which usually means an outlier coordinate (see below). Verify any index before deploying it:

```bash
pnpm index inspect packages/service/data/postcodes.idx
```

### Coordinate precision and the threshold

Coordinates are not stored as floats. Each district has a bounding box (`minLat`, `minLon`, `latSpan`, `lonSpan`), and every postcode inside it stores its position as two 16-bit integers: how far across the box it sits in 65,534 equal steps. Decoding gives back `min + step × span / 65534`. The size of one step is therefore the worst-case error for that district:

```
precision (m) = max(latSpan × 111 000, lonSpan × 111 000 × cos(midLat)) / 65 534
```

A compact urban district spans a few hundred metres and quantises to centimetres; a district covering a whole island group spans a degree or more and quantises to about two metres. The build report prints the ten worst districts and `inspect` prints the same figures for an existing file; `/health` reports the worst value as `worstPrecisionM`.

**What the threshold does.** `--precision-threshold <metres>` (default 5) is an alert level, not a storage setting. It changes nothing in the file. After building, every district's precision is compared with it; any district above it is listed on an `ALERT` line and the command exits with status 1, so a CI job or release script stops. The index is still written and still valid, and the threshold used is recorded in the metadata so `inspect` applies the same one by default (pass `--precision-threshold` to `inspect` to re-check with another value).

**Why it exists.** One wrong coordinate in a district (an ONSPD row placed hundreds of kilometres away) widens that district's bounding box and degrades the precision of every other postcode in it. Nothing else in the pipeline would notice. A district that suddenly exceeds the threshold between releases is the signal to look at its source rows before publishing the index.

**Levels, measured on ONSPD FEB_2026 (2,977 districts, full UK).**

| Precision | Districts | What it means |
| --- | --- | --- |
| up to 0.1 m | 1,305 (44%) | Dense urban districts. Error is far below the accuracy of the source grid reference. |
| up to 0.25 m | 2,432 (82%) | Typical towns and suburbs. |
| up to 0.5 m | 2,904 (98%) | Market towns with a rural hinterland. |
| up to 1 m | 2,973 | Large rural districts such as DG7, DG8 and DL8. |
| up to 2.2 m | 2,977 (all) | The handful of districts covering whole island groups or Highland areas: ZE2, PH33, IV27, KW17 and KW14. |

The median district is 0.116 m, the postcode-weighted mean is 0.17 m, and nothing exceeds 2.17 m. ONSPD grid references are themselves given to 1 m, so no district loses meaningful accuracy at these levels.

**Choosing a value.**

| Threshold | Use |
| --- | --- |
| 5 m (default) | Passes every genuine district with room to spare; only an outlier coordinate trips it. Recommended. |
| 3 m | Tighter guard that still passes the current data; trips sooner if a large rural district grows. |
| 1 m | Strict. Fails the five largest districts in the current data, so only useful for GB-only or regional builds where none of them is present. |
| above 5 m | Loosens the guard; a real outlier can slip through and quietly degrade a whole district. Not recommended. |

If the alert fires on a district that is genuinely large rather than corrupt, raising the threshold is the right response. If the error budget ever matters more than file size, the format can move to 12-bit or 8-bit coordinates per the plan, which trades bytes for metres uniformly rather than per district.

## Run the service

```bash
POSTCODE_INDEX=packages/service/data/postcodes.idx pnpm service
```

Then:

```bash
curl 'http://localhost:3000/search?q=sw1a1&limit=5'
```

```bash
curl http://localhost:3000/SW1A1AA
```

Interactive documentation is at `/docs`; the OpenAPI 3.1 document is at `/openapi.json`.

### Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `POSTCODE_INDEX` | `./data/postcodes.idx` | File path or `http(s)://` URL. The scheme selects the loader. |
| `POSTCODE_INDEX_FALLBACK` | unset | Bundled file used if the primary fails at startup. |
| `POSTCODE_INDEX_REFRESH_MS` | `0` | Refresh interval; `0` disables. Applies to both source kinds. |
| `POSTCODE_INDEX_REFRESH_JITTER` | `0.1` | Fraction of the interval randomised each cycle. |
| `POSTCODE_INDEX_FETCH_TIMEOUT_MS` | `30000` | Per-fetch timeout for URL sources. |
| `POSTCODE_INDEX_MAX_BYTES` | `67108864` (64 MiB) | Largest index download accepted from a URL. Larger bodies are rejected before or while reading, never buffered whole. |
| `SEARCH_DEFAULT_LIMIT` / `SEARCH_MAX_LIMIT` | `10` / `50` | Result caps. |
| `CACHE_MAX_AGE_SECONDS` | `3600` | `Cache-Control` on autocomplete and lookup responses. |
| `CORS_ORIGINS` | `*` | Comma-separated origins allowed to call the API from a browser. `*` allows any; list specific origins to restrict. |
| `PORT` | `3000` | Listen port. |
| `SHUTDOWN_DRAIN_MS` | `5000` | After SIGTERM, how long `/health` reports 503 while requests are still served, before the listener closes. `0` closes at once. |
| `LOG_LEVEL` | `info` | `debug` also logs every hot-path request. |

### API

| Route | Parameters | Response |
| --- | --- | --- |
| `GET /search` | `q` (1 to 8 characters after normalisation, required), `limit` (1 to 50, default 10) | `{ data: [{ postcode, lat?, lon? }] }`. Empty list when nothing matches; 400 on invalid parameters. |
| `GET /{postcode}` | Full postcode, space optional, any case | `{ data: { postcode, lat?, lon? } }`, 400 if the segment is not a complete postcode, 404 if unknown. |
| `GET /health` | none | `{ data: { status, ready, index, refresh, memory } }`. 503 with the same document until an index is loaded (`starting`) and again once shutdown begins (`draining`). |
| `GET /openapi.json` | none | OpenAPI 3.1 document. Operations are `searchPostcodes`, `lookupPostcode` and `getHealth`, so generated clients get stable method names. |

The lookup route lives at the root, so it only matches segments that look like a postcode: 5 to 8 letters, digits and spaces including at least one digit. Anything else (`/favicon.ico`, `/metrics`) is an unknown route and gets the JSON 404. New literal routes must not be postcode-shaped; the existing ones (`/health`, `/openapi.json`, `/docs`) are registered first and are not.

**Caching.** Search and lookup responses (including 404s for unknown postcodes) carry `Cache-Control: public, max-age=3600` and an `ETag`. The ETag is the checksum of the loaded index rather than a hash of the body: a response is a pure function of the URL and the index, so one validator serves every URL, a request with a matching `If-None-Match` is answered 304 before any search runs, and every cached response everywhere invalidates exactly when a new index is loaded.

**CORS.** Browsers may call the API directly; every response carries `Access-Control-Allow-Origin` for the configured origins (any origin by default, since the data is public and the API is read-only) and preflight requests are answered with a one-day cache. Set `CORS_ORIGINS` to restrict it.

**Response envelope.** Every successful response puts its payload under `data`: a list for search, an object for lookup and health. Every error puts its detail under `error`:

```json
{ "error": { "code": "bad_request", "message": "invalid request", "issues": [{ "message": "limit must be at most 50", "path": ["limit"] }] } }
```

`code` is one of `bad_request`, `not_found`, `not_ready` or `internal`. `issues` appears on validation errors only and follows the [Standard Schema](https://standardschema.dev) issue format: a `message` and the `path` to the offending value as an array of keys.

Postcodes are always returned with the space. Without a space in the query every valid outward/inward split is tried, so `B11` returns the B11 district first and then `B1 1…`. `lat` and `lon` are omitted for the few postcodes ONSPD lists without a grid reference.

## Development

```bash
pnpm check
```

runs the synchronous-only lint on `index-format`, the TypeScript build, and the tests. Benchmarks (load time, search latency, memory across refreshes) run with:

```bash
pnpm bench
```

They use a generated 1.6 million postcode fixture cached under `bench-data/`; set `BENCH_INDEX=path/to/postcodes.idx` to benchmark a real index instead.

## Licensing and attribution

ONSPD is published under the Open Government Licence v3 and contains Royal Mail and Ordnance Survey data. Any use of the output must carry these statements:

- Contains OS data © Crown copyright and database right [year]
- Contains Royal Mail data © Royal Mail copyright and database right [year]
- Contains National Statistics data © Crown copyright and database right [year]

Northern Ireland postcodes in ONSPD are supplied under separate terms from Land & Property Services and may need a licence for commercial use. Confirm before serving BT postcodes to customers; build with `--exclude-ni` until that is settled.
