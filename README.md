# Postcode autocomplete

Left-to-right UK postcode autocomplete and lookup, backed by a compact binary index built from the ONS Postcode Directory (ONSPD). Two tools and one shared package:

| Package | Purpose |
| --- | --- |
| `packages/index-format` | The index file format: encode, validate, and the `PostcodeIndex` query engine. No runtime dependencies, nothing asynchronous. |
| `packages/indexer` | `postcode-index build` turns ONSPD CSV releases into one `.idx` file; `postcode-index inspect` verifies and describes one. |
| `packages/service` | Hono HTTP service: `/postcodes/autocomplete`, `/postcodes/{postcode}`, `/health`, `/openapi.json`, `/docs`. |

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

Run these from the repository root; relative paths resolve against your current directory, and the output directory is created if missing. Flags: `--exclude-ni`, `--exclude-crown-dependencies`, `--gb-only`, `--release FEB_2026`, `--precision-threshold 5`. The build prints a report (counts, file size, ten worst districts by coordinate precision) and exits non-zero if any district exceeds the precision threshold, which usually means an outlier coordinate. Verify any index before deploying it:

```bash
pnpm index inspect packages/service/data/postcodes.idx
```

## Run the service

```bash
POSTCODE_INDEX=packages/service/data/postcodes.idx pnpm service
```

Then:

```bash
curl 'http://localhost:3000/postcodes/autocomplete?q=sw1a1&limit=5'
```

```bash
curl http://localhost:3000/postcodes/SW1A1AA
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
| `SEARCH_DEFAULT_LIMIT` / `SEARCH_MAX_LIMIT` | `10` / `50` | Result caps. |
| `CACHE_MAX_AGE_SECONDS` | `3600` | `Cache-Control` on autocomplete and lookup responses. |
| `PORT` | `3000` | Listen port. |
| `LOG_LEVEL` | `info` | `debug` also logs every hot-path request. |

### API

| Route | Parameters | Response |
| --- | --- | --- |
| `GET /postcodes/autocomplete` | `q` (1 to 8 characters, required), `limit` (1 to 50, default 10) | `{ results: [{ postcode, lat?, lon? }] }`. Empty list when nothing matches; 400 on invalid parameters. |
| `GET /postcodes/{postcode}` | Full postcode, space optional, any case | `{ postcode, lat?, lon? }`, or 404 `{ error: "not_found" }`. |
| `GET /health` | none | Readiness, index metadata, refresh state, memory. 503 until an index is loaded. |
| `GET /openapi.json` | none | OpenAPI 3.1 document. |

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
