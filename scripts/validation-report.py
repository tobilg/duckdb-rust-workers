#!/usr/bin/env python3
"""Write the measured evaluation report after tests, packaging and measurement."""
import json
import math
import statistics
from pathlib import Path

root=Path(__file__).resolve().parent.parent
m=json.loads((root/'artifacts/build-manifest.json').read_text())
r=json.loads((root/'artifacts/api-results.json').read_text())
assert r['status']=='passed'
wasm=next(x for x in m['outputs'] if x['path'].endswith('.wasm'))
js=next(x for x in m['outputs'] if x['path'].endswith('.js'))
assert wasm['sha256']==r['wasm_sha256']
warm=sorted(r['warm_ms'])
mem=[x['wasm_memory_bytes'] for x in r['repetition']]
profile=json.loads((root/'artifacts/startup.cpuprofile').read_text())
names={n['id']:n['callFrame']['functionName'] for n in profile['nodes']}
idle=sum(d for sample,d in zip(profile['samples'],profile['timeDeltas']) if names.get(sample)=='(idle)')
active=(sum(profile['timeDeltas'])-idle)/1000
large=r['large_parquet']
fixture=json.loads((root/'tests/fixtures/manifest.json').read_text())
large_size=next(x['bytes'] for x in fixture['files'] if x['path'].endswith('large.parquet'))
local=next(t['wall_ms'] for t in r['tests'] if t['name']=='local SQL')
checks='\n'.join(f"| {t['name']} | {t['status']} | {t['wall_ms']:.1f} |" for t in r['tests'])
snapshots='\n'.join(f"| Full snapshot ({name}) | {sample['fetch_count']} requests, "
                    f"{sample['fetch_bytes']:,} body bytes, {sample['wall_ms']} ms |"
                    for name,sample in r['full_snapshots'].items())
report=f'''# Validation report

**Working locally.** Evaluated on {m['generated_at'][:10]}, macOS arm64,
Node {m['tools']['node']}, Wrangler {m['tools']['wrangler']}, workerd
{m['tools']['workerd']}. Actual workerd runs the Rust/C++ Worker; separate
Node HTTPS fixture servers supply bytes over TLS. Fetch is not mocked. This run
did not upload a Worker, publish an endpoint, create an account resource, or
use S3 credentials. This is an evaluation, not a production-readiness claim.

## Exact artifact

* Wasm SHA-256: `{wasm['sha256']}`
* Raw Wasm: **{wasm['bytes']:,} bytes**; generated JS: **{js['bytes']:,} bytes**.
* Raw modules combined: **{m['raw_module_bytes']:,} bytes**.
* Wrangler dry-run uncompressed upload: **{m['packaging']['wrangler_reported_kib']:,.2f} KiB**.
  The emitted JS/Wasm module payload is {m['packaging']['module_payload_bytes']:,} bytes.
  Source maps and the packaging README are excluded from that payload.
* The packaged Wasm has the same hash as the successful API integration report.
* Full pins, tool binary/archive checksums, effective Emscripten config, flags,
  static archive hashes and lockfile hashes: [build-manifest.json](build-manifest.json).

All four required extensions are retained. MinSizeRel uses `-Oz` and
`SMALLER_BINARY=ON`, with exceptions `{m['native']['SMALLER_BINARY_EXCEPT']}`;
all {m['native']['entries']} native compile-command entries
passed the size/no-thread audit. Native C++ uses exnref exceptions; Rust uses
`opt-level="z"`, thin LTO and `panic=abort`. All 391 selected archive members
were checked as Wasm objects. No host curl/OpenSSL archives are linked.

Native LTO remains disabled because raw LLVM bitcode fails the pinned
Emscripten wasm-bindgen marker scan. This is a documented optimization
limitation; the final bundle retains every required extension.

## Passing acceptance evidence

| Contract | Evidence |
| --- | --- |
| A1 Rust Worker | Full Rust/C++ module serves health and SQL in local workerd |
| A2–A3 actual JSPI and native exceptions | API query suspends on delayed HTTPS fetch and returns the expected JSON aggregate; same-module health progresses and overlap gets 429. Native errors before and after a remote read are caught; subsequent SQL succeeds |
| A4–A5 engine and static-only extensions | API checks SELECT 42, core aggregate, local JSON, loaded state of all four built-ins, and remote Parquet/JSON; user INSTALL/LOAD rejected |
| A6 remote Parquet | Correct reference answer, server-observed HEAD/ranges, transfer below 25% for the selective fixture query |
| A7 object larger than memory | {large_size:,}-byte object queried successfully without full download; Wasm remains below its 96 MiB cap. Total isolate memory is not established by this local measurement |
| Origin policy | Unset origin/path permits local SQL and reads across HTTPS origins/paths; explicit restrictions and malformed configuration are tested, including cross-origin redirects |
| A8 transport behavior | Identity encoding is explicit; weak/missing validators and ignored ranges use one full snapshot within a 4 MiB cumulative budget, including unknown-length caps and change detection. Snapshots survive preparation and execution. Range-cache eviction stays within 4 MiB. Large strong-validator files retain ranges. Oversized fallback, 416, short body, incorrect range, changed ETag, denied redirects, fetch rejection and timeout fail safely |
| Query transfer budget | Defaults to 64 MiB; a scan above 32 MiB succeeds, a scan above 64 MiB fails with query_transfer_limit, and a 128 MiB binding permits that scan. Lower limits cover range and full reads, invalid bindings fail before I/O, and a 4 GiB setting verifies 64-bit byte conversion. A fresh request recovers its full budget after an error |
| A9 result limits | Typed values/duplicate names, parameters, 12,000 rows returned when max_rows is omitted or null, explicit row caps and truncation boundaries, 1-billion-row query stopped by an explicit cap or the 1 MiB byte budget without materializing all rows, error cleanup and recovery |
| A10 ownership and overlap | Same service/module returns 429 during suspended query while health progresses; ATTACH is read-only and request-scoped; API bearer token is not forwarded to fixtures |
| A11 cleanup | 100 alternating successful and failing SQL requests, successful queries after transport failures; fixed Wasm allocation after warm-up |
| A12 release artifact | Native flags/member audit, exact package/test hashes, dry-run packaging |
| A13 local/deployed distinction | Local workerd and local startup profile measured; Cloudflare deployment pending |

The API report contains {len(r['tests'])} focused test groups:

| Test group | Result | Wall ms |
| --- | --- | ---: |
{checks}

See [api-results.json](api-results.json) for each fixture request, range,
response outcome, timings and repeated-request observations. All tests exercise
the full API artifact; no diagnostic endpoints or alternative build stages are
required.

## Measurements and limits

| Measurement | Observed value / method |
| --- | --- |
| Local startup active sampled time | {active:.1f} ms; Wrangler `check startup`, [profile](startup.cpuprofile) |
| Local startup profile window | {(profile['endTime']-profile['startTime'])/1000:.1f} ms; includes profiler/runtime overhead |
| Cold process launch to health | {r['local_process_start_to_health_ms']:.1f} ms; includes executable launch and HTTP polling, not platform startup CPU |
| First SQL request | {local:.1f} ms end-to-end from local harness; fresh database initialization included |
| Warm SELECT 42 | 5 warm-ups, 30 samples: median {statistics.median(warm):.2f} ms, mean {statistics.mean(warm):.2f} ms, p95 {warm[math.ceil(len(warm)*.95)-1]:.2f} ms |
| Wasm linear-memory high water | {r['health']['wasm_memory_bytes']:,} bytes ({r['health']['wasm_memory_bytes']/1048576:.2f} MiB) |
| 100-request repetition memory | min {min(mem):,}, max {max(mem):,} bytes; no growth in this sample |
| Total isolate memory | **Unavailable**, not inferred from linear memory or host RSS |
| Cloudflare startup/CPU/resource outcome | **Not measured**, no deployment |
| Remote JSON | {r['json']['fetch_count']} requests, {r['json']['fetch_bytes']:,} consumed body bytes, {r['json']['wall_ms']} ms Worker wall time |
| Small Parquet | {r['small_parquet']['fetch_count']} requests, {r['small_parquet']['fetch_bytes']:,} body bytes, {r['small_parquet']['wall_ms']} ms |
{snapshots}
| Large Parquet | {large['fetch_count']} requests, {large['fetch_bytes']:,} body bytes ({100*large['fetch_bytes']/large_size:.3f}% of object), {large['wall_ms']} ms |
| Large Parquet range-cache hits / staging buffer | {r['range_cache']['single']['cache_hits']} hits / {r['range_cache']['single']['staging_peak_bytes']:,} bytes |
| Cache eviction stress high water | {r['range_cache']['eviction']['cache_peak_bytes']:,} charged bytes; 4 MiB budget |
| Separated-column Parquet, 64 KiB coalescing | {r['coalescing']['fetch_count']} requests / {r['coalescing']['fetch_bytes']:,} consumed bytes |
| Scan within default 64 MiB transfer budget | {r['transfer_limits']['within']['fetch_bytes']:,} consumed bytes; reference result passed |
| Scan exceeding default 64 MiB transfer budget | Stopped after {r['transfer_limits']['rejected']['fetch_bytes']:,} consumed bytes with query_transfer_limit |
| Same larger scan with 128 MiB transfer budget | {r['transfer_limits']['raised']['fetch_bytes']:,} consumed bytes; reference result passed |

Memory is sampled from the non-shrinking Wasm linear-memory allocation after
requests. It includes retained heap capacity and stacks; it is not live
DuckDB allocations or total isolate memory. Stable allocation in this finite
sample does not prove absence of every leak. Network counters count consumed
response body bytes, including re-reads, and exclude headers/TLS overhead.
Server-written bytes can be higher when a body is canceled.

The large fixture contains 262,144 rows in 8,192-row groups, with `id BIGINT`,
`category VARCHAR`, and an uncompressed 512-byte payload column. The fixed
query projects count/sum of id with `id < 1024 AND category='a'`; expected
result is `512, 261632`. All fixture hashes are verified before integration tests.
This transfer ratio is fixture-specific, not an arbitrary-workload promise.
The cache/coalescing/compiler tradeoffs and benchmark commands are in
[performance evaluation](../docs/performance.md). Benchmark JSON remains
local and ignored under `artifacts/benchmarks/`.

[Cloudflare's limits](https://developers.cloudflare.com/workers/platform/limits/)
were checked on 2026-09-29: 64 MiB uncompressed bundle, 128 MB isolate memory,
1 second startup, six concurrent outgoing connections, and a default paid
CPU limit of 30 seconds. The package fits the size limit and the 48 MiB stretch
target. Local results cannot establish deployed startup or total memory fit.

## Failures resolved and tests not run

**Current local failures:** none in the acceptance suite or packaging checks.
An exploratory window+sort benchmark had one connection reset after three
correct MAD responses. An isolated MAD run and full engine rerun passed;
the interruption's cause was not established. The final build retains window
specializations only. Details and the preserved log are listed in
[performance evaluation](../docs/performance.md).
Build constraints and narrow patches are documented in
[build notes](../docs/build-notes.md), including the Rust snippet layout,
native exception encoding, Wasm httpfs dependency guards, HTTP provider
installation on the live database, and 1 MiB JSPI fiber stacks.

**Not run / pending:** deployed Cloudflare startup and runtime acceptance,
total isolate-memory/CPU measurement, authenticated S3/R2 (A14), and Linux
builds. No corresponding test credentials or authorized deployment environment
were configured. S3 signing and mbedTLS are retained, but linking them is not
proof of authenticated S3 compatibility. DuckLake/quack are outside the four
included extensions. Read-only remote DuckDB ATTACH passes, but a request-owned
attachment does not persist for a later query.

**Owner-reported deployment:** the public GitHub Parquet query worked after
the weak-validator snapshot fix and after the cache, range-fallback and
compiler changes. The configurable transfer budget has local evidence only;
this run did not deploy it.

The I/O timer aborts fetches and cancels bodies. It cannot preempt CPU-bound
Wasm. DuckDB's 30-second execution setting is cooperative, not a separately
validated hard CPU interrupt. Arbitrary client-disconnect cancellation was
not separately exercised. Fetches are sequential; no background thread-pool
read-ahead or Promise prefetch scheduler is claimed. Strong ETags are required
for range reads; weak/missing validators use a request-owned full snapshot
within the 4 MiB query budget. Absolute HTTPS redirects are required.
Origin and path restrictions are
optional; when configured, they apply to both initial reads and redirects.

## Reproduce and next step

Exact clean-checkout prerequisites/commands are in [README](../README.md).
The default full-API build, `test-local.sh`, source/fixture checksum checks,
artifact verification, Wrangler dry-run packaging and local startup profiling
were run. Native compilation initializes its project-local Emscripten configuration
without requiring an earlier Worker build.
Dependency and native compiler caches were retained; a second independent
empty-checkout rebuild was not run.

Next: in an authorized Cloudflare test environment, upload the **same tested
artifact**, confirm platform startup and total memory/CPU acceptance, then
run the controlled remote fixtures and credentialed S3 test. No infrastructure
or endpoint is created by this local evaluation.
'''
(root/'artifacts/validation-report.md').write_text(report)
print('Wrote artifacts/validation-report.md')
