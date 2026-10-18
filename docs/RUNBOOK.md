# Runbook: postcode autocomplete service

## Choosing an index source

The service holds exactly one index in memory and swaps it atomically. Where that index comes from is a deployment choice.

**Bundled** (`POSTCODE_INDEX=/app/data/postcodes.idx`, index copied into the image)

- No external dependency at start; works offline; the running version is pinned to the deploy.
- Every ONSPD update needs a rebuild and redeploy, and the image grows by about 9 MB.

**Fetched** (`POSTCODE_INDEX=https://…/postcodes.idx`)

- Data updates without a redeploy, one index shared across instances, small image.
- Startup depends on the host being reachable; the running version is less obvious, so read it from `/health`.

**Recommended production setting**: fetched with a bundled fallback and refresh enabled.

```
POSTCODE_INDEX=https://index-host.example/postcodes/postcodes.idx
POSTCODE_INDEX_FALLBACK=/app/data/postcodes.idx
POSTCODE_INDEX_REFRESH_MS=3600000
```

Startup: the primary is loaded first; if it fails the fallback is used and a warning is logged with `"serving from fallback index"`; if neither loads the process exits non-zero. `/health` returns 503 until an index is held, so gate traffic on it. `health.index.fallback` is `true` while the fallback is in use; refresh keeps trying the primary and swaps as soon as it loads.

## Building the image

Fetched mode (no index in the image):

```bash
docker build -t postcode-service .
```

Bundled mode (requires `packages/service/data/postcodes.idx`):

```bash
docker build -t postcode-service --build-arg BUNDLE_INDEX=1 .
```

The image runs as `node` with `--max-old-space-size=128`. The index lives off-heap in a single `ArrayBuffer`, so the V8 heap only holds request-scoped garbage; `/health` reports `memory.arrayBuffers`, which should sit within a few hundred KB of `index.bytes`. If it grows across refreshes an old index is being retained somewhere.

## Shutdown and rolling deploys

On SIGTERM or SIGINT the service does not close immediately:

1. Readiness flips off: `/health` returns 503 with `status: "draining"`, while search and lookup keep answering. A load balancer or orchestrator polling `/health` stops routing new requests here.
2. After `SHUTDOWN_DRAIN_MS` (default 5 s) the refresh timer stops and the listener closes, waiting up to 10 s for in-flight requests.
3. The process exits 0. A second signal during the drain exits at once.

Set the orchestrator's termination grace period above `SHUTDOWN_DRAIN_MS` plus 10 s, and its readiness probe interval below the drain window, so the drain is long enough to be noticed.

## Refresh

With `POSTCODE_INDEX_REFRESH_MS` above zero the service sleeps `interval × (1 ± jitter)` and then:

1. File source: compares mtime and size; skips if unchanged. URL source: sends `If-None-Match` / `If-Modified-Since`; a 304 ends the cycle.
2. Reads or downloads (rejecting any body above `POSTCODE_INDEX_MAX_BYTES` before buffering it), validates magic, format version, length and SHA-256, and constructs a new index.
3. Swaps it in. In-flight requests finish on the old index, which is then collected.
4. On any error: logs, sets `health.refresh.lastError`, keeps serving the current index. Readiness never flips.

For a few seconds during a swap both indexes exist, so peak memory is about twice the index size.

Every search and lookup response carries an `ETag` equal to the index checksum, so after a swap the next conditional request from any client or CDN gets fresh data; nothing needs purging.

To publish a new index for fetched mode, upload the file to the index host with a new `ETag` (any static host that supports conditional requests is enough) and wait for the next cycle, or restart one instance to pick it up immediately.

## Quarterly ONSPD update

1. Download the new ONSPD release from the ONS Open Geography Portal.
2. Build with the agreed flags and review the precision report:

   ```bash
   pnpm index build --release MAY_2026 -o postcodes.idx /path/to/ONSPD_MAY_2026_UK.csv
   ```

   The build exits non-zero if any district exceeds the precision threshold (default 5 m). That usually means an outlier coordinate widening a district's bounding box; check the named district against the source rows before accepting the file.
3. Inspect the output and compare the postcode count with the previous release. Expect a small net increase; a large drop means rows were rejected (see the `invalid` count) or a column was renamed.

   ```bash
   pnpm index inspect postcodes.idx
   ```

4. Fetched mode: publish to the index host. Bundled mode: copy to `packages/service/data/postcodes.idx` and rebuild the image.
5. Confirm `/health` reports the new `index.release` on every instance.

## Interpreting /health

| Field | Meaning |
| --- | --- |
| `status`, `ready` | `ok`/`true` once an index is held; 503 with `starting`/`false` before, and 503 with `draining`/`false` once shutdown has begun. |
| `index.release`, `index.builtAt` | From the index metadata, written by the indexer. |
| `index.postcodes`, `index.districts`, `index.exclusions` | What is being served and which exclusion flags were applied at build. |
| `index.source`, `index.fallback`, `index.loadedAt` | Where the current index came from. |
| `index.worstPrecisionM` | Worst quantisation error across districts, in metres. |
| `refresh.lastAttemptAt`, `lastSuccessAt`, `lastSwapAt`, `lastError` | Refresh history. `lastError` is cleared by the next successful cycle. |
| `memory.arrayBuffers` | Should be close to `index.bytes`. |

## Known limits

- Matching is left-to-right prefix only. No suffix or substring search.
- Queries are capped at 8 characters after normalisation, the longest valid input with a space.
- Coordinates are quantised inside each district's bounding box: sub-metre for normal districts, about 2 m for the largest rural ones (ZE2, PH33). Rows ONSPD lists without a grid reference are returned without `lat`/`lon`.
- Format version 1. The service refuses any other version; bump the version on any layout change and rebuild.
