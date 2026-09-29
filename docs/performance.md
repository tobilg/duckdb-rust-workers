# Performance evaluation

These measurements use the pinned Rust/C++ Worker in local workerd, with real
HTTPS fixture servers. They do not establish deployed Cloudflare CPU or total
isolate memory. Raw benchmark reports are generated under the ignored
`artifacts/benchmarks/` directory; the source harness is
`tests/benchmarks/local.mjs`.

The cache/compiler evaluation on 2026-09-29 passed all **39 integration
groups**, the engine benchmark, the public GitHub example, and Wrangler
dry-run packaging. Its Wasm is **19,995,268 bytes**, generated JS **60,382
bytes**, and packaged module payload **20,080,498 bytes** (Wrangler reports
19,609.86 KiB uncompressed).
Wasm SHA-256:
`d8dac85bed54ed0881de2006381ee46298bad0b1ba86b1197b6e5a5b29b3f748`.
The Wasm increase over the original build is 94,548 bytes, about **0.48%**.

Those artifact identities precede the configurable transfer-budget change.
The current default is 64 MiB; generated `artifacts/validation-report.md`
records the current build and its transfer-limit tests.

The full suite observed 50,135,040 bytes of Wasm allocation (47.81 MiB).
Total isolate memory remains unmeasured. Local startup profiling recorded
116.7 ms of active sampled time; the acceptance harness's warm SELECT 42
median was 22.59 ms. These are separate measurements from the engine benchmarks
below and are not deployed startup/CPU evidence. The generated manifest and
validation report identify the exact tested/package hashes.

## Request snapshots and range caching

DuckDB preparation and execution each end an internal query. The bridge now
keeps httpfs state until the API connection is destroyed, so literal URLs and
reopened files reuse the same completed snapshot. No database or input cache
survives an API request, including one that fails.

The transport caches validated ranges in an LRU capped at 4 MiB of charged
storage and 64 entries. It includes headers and the full URL in cache identity.
Only subranges of a complete, validated response are reused. The optional
block mode does not widen credentialed requests or URLs with query strings.

| Controlled query | Previous requests / bytes | Exact-range cache requests / bytes |
| --- | ---: | ---: |
| Small Parquet, parameter | 11 / 33,744 | 3 / 33,368 |
| Large Parquet, parameter | 35 / 331,348 | 3 / 329,844 |
| Large Parquet, literal | 37 / 593,492 | 3 / 329,844 |
| Weak-ETag small Parquet, literal | 4 / 539,260 | 2 / 269,630 |

The large fixture is 137,475,588 bytes. The query selects `id < 1024` and
`category='a'`, returning count 512 and sum 261632. Its footer already contains
many of the tiny index reads: exact reuse removes 32 fetches without broad
prefetching. A 1 MiB aligned-block policy still uses 3 requests but consumes
2,209,284 bytes. The default therefore caches exact ranges.

Range staging buffers now match the wire range instead of always reserving
8 MiB. This selective query peaks at a 262,144-byte staging buffer. Full GETs
have their own 4 MiB cumulative budget. Cache accounting and staging capacity
are not measurements of total live heap or isolate memory.

## Parquet coalescing

The benchmark fixture `coalescing.parquet` contains eight row groups and four
projected numeric columns separated by unused string columns. Its hash and
expected aggregate are in `tests/fixtures/manifest.json`. It distinguishes
column coalescing from cache reuse; the ordinary selective fixture has too
few gaps to do that.

| Column gap, exact-range cache | Requests | Consumed bytes |
| --- | ---: | ---: |
| Upstream adaptive | 35 | 558,628 |
| 0 | 35 | 558,628 |
| 64 KiB | 27 | 886,540 |
| 512 KiB | 19 | 3,049,460 |

The default is **64 KiB**: eight fewer sequential fetches for 327,912 extra
bytes on this fixture. The larger gap spends substantially more of the
query transfer budget (32 MiB in this benchmark, now 64 MiB by default).
This is a workload-specific choice, not a universal
optimum. The benchmark adds 20 ms latency to each fixture request. Wall times
from runs overlapping native compilation are unsuitable for CPU comparisons;
request counts and consumed bytes determine this choice.

Trusted deployment bindings allow experiments without rebuilding the module:

| Binding | Default | Accepted values |
| --- | --- | --- |
| `RANGE_CACHE_BLOCK_BYTES` | `0` (cache exact ranges) | `-1` disables caching; positive values align uncredentialed, query-free URL ranges to blocks, up to 1 MiB |
| `PARQUET_PREFETCH_COLUMN_GAP` | `65536` | `-1` selects upstream adaptive behavior; `0` through `1048576` pins the gap |
| `QUERY_TRANSFER_LIMIT_MIB` | `64` | Positive whole MiB, up to `4294967295`; cumulative fetched response-body bytes per API request |

The client query API cannot set these bindings or increase memory budgets.
Coalescing and cache reuse remain sequential; no thread-pool replacement or
Promise-based concurrent read-ahead is introduced.

## Bounded fallback

A 200 response to a range request is canceled before its body is read. The
transport signals httpfs's unsupported-range condition, allowing its existing
conditional full GET and snapshot cache to handle the object. Large known
objects fail before a full GET; unknown lengths stop at the streaming cap.
The 4 MiB budget is cumulative across full downloads in the API request.
Changed versions, invalid Content-Range and truncated responses remain errors.
Server-written bytes can exceed consumed bytes when a body is canceled.

## Selective compiler specializations

The build keeps `-Oz` and `SMALLER_BINARY=ON` and sets
`SMALLER_BINARY_EXCEPT=window_specialization`. That retains only
`quantile_window` and `mad_window`. The 200,000-row median and 50,000-row MAD
window queries both returned HTTP 400 with every specialization trimmed.
With window specializations restored they returned the independently checked
sums 19,999,900,000 and 12,437,625 under the same 48 MiB DuckDB memory budget.
The API sanitizes native errors; the benchmark records those baseline failures
as HTTP 400 rather than claiming an exception message it did not observe.

The final window-only build passed nine executions of every engine case.
Its warm median was 235.4 ms for the median window and 2,400.3 ms for MAD;
the fresh engine-benchmark isolate stayed at 32 MiB Wasm allocation. The
reports are `artifacts/benchmarks/final-engine.json` and
`artifacts/benchmarks/engine-all-trimmed-recheck.json`.

Sort specializations were also built and tested. Initial separate-process
measurements suggested an improvement, but alternating queries between both
builds in the same workerd process did not confirm it:

| Alternating benchmark, eight warm samples | Fully trimmed | Window + sort retained |
| --- | ---: | ---: |
| SELECT 42, median wall ms | 39.1 | 45.9 |
| Numeric sort, 500,000 rows | 160.1 | 164.1 |
| Text sort, 100,000 rows | 71.1 | 76.0 |

These are end-to-end local wall times on a shared development host, not
isolated CPU measurements or Cloudflare performance promises. Both sort
queries check the sum and first/last values so their ordering is observable.
The evidence does not justify retaining the sort specializations, so they
remain trimmed in the final build.

One exploratory window+sort benchmark was interrupted by a local connection
reset after three correct MAD responses. Its original log is retained as
`artifacts/logs/benchmark-engine-specialized.txt`. A fresh nine-query MAD run
and a complete instrumented engine rerun then passed, with 32 MiB Wasm
allocation throughout. The cause of that first interruption was not established;
the subsequent harness records per-query health, watchdog state and process
exit to distinguish future failures.

The owner's public GitHub Parquet aggregate also passed four times in local
workerd, using 4 fetches and 49,593 consumed bytes per query. The result and
artifact identity are in `artifacts/benchmarks/public-github.json`. This live
source can change; the hashed controlled fixtures remain the reproducible
acceptance evidence. The owner subsequently confirmed that this release
works deployed for their query. Broader deployed acceptance and authenticated
S3 checks remain pending.

## Reproduce

Run bootstrap and the build as described in the README, then:

```sh
source scripts/env.sh
python3 scripts/generate-fixtures.py
BENCH_LABEL=io BENCH_MODE=io node tests/benchmarks/local.mjs
BENCH_LABEL=engine BENCH_MODE=engine node tests/benchmarks/local.mjs
```

For a compiler comparison, build the fully trimmed baseline with
`DUCKDB_SMALLER_BINARY_EXCEPT='' ./scripts/build-worker.sh`, save its two
modules in a separate directory, then rebuild with the default window-only
exceptions. Set `BENCH_COMPARE_BUNDLE` to the saved directory and
`BENCH_CASE=local,sort-numeric,sort-text` to alternate queries between the two
artifacts in the same workerd process. Compiler-profile changes trigger a
full native rebuild; leave the default build in place before validation or
deployment.

The I/O suite compares disabled caching, exact ranges, 64 KiB/256 KiB/1 MiB
blocks, and adaptive/0/64 KiB/512 KiB Parquet gaps. I/O cases have one cold
sample and three warm samples; engine cases use eight warm samples. The median
excludes the first sample. Failed cases stop after the first response. Every
query still opens a fresh database. A host-process watchdog kills workerd if
a benchmark hangs; it does not claim that a JavaScript timer can preempt Wasm.

Use `BENCH_BUNDLE` to test a saved directory containing `index.js` and
`index_bg.wasm`, `BENCH_LATENCY_MS=0` to remove injected fixture latency, and
`BENCH_CASE=separated-columns` to run only the coalescing case. Reports include
the module hash, sizes, responses, request records and Wasm allocation samples.
Certificates and workerd logs remain under ignored `build/benchmarks/`.
