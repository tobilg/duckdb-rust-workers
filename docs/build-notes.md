# Build decisions

The build and API behavior are documented in the [README](../README.md) and
[architecture notes](architecture.md). Exact source and archive pins are in
`toolchain-lock.json`; Cargo and npm dependencies have lockfiles. The current
evaluated host is macOS arm64.

Every vendored modification is declared in `toolchain-lock.json`:

| Checkout | Reproduced changes |
| --- | --- |
| `vendor/workers-rs` | `patches/worker-build-local-cache.patch`, applied by bootstrap |
| `vendor/httpfs` | `patches/httpfs-wasm-dependencies.patch` and `patches/httpfs-full-snapshot.patch`, applied by bootstrap |
| `vendor/duckdb` | Project httpfs patches are copied into `.github/patches/extensions/httpfs/` as `0002-wasm-dependencies.patch` and `0003-full-snapshot.patch`; engine source is unchanged |
| CMake's fetched httpfs checkout | DuckDB's pinned upstream `0001-skip-tests-on-windows.patch`, then project patches `0002` and `0003` |
| Emscripten frontend and SDK | Unmodified pinned checkouts |

`scripts/check-pins.py` reconstructs patched files from their pinned Git
revisions in a temporary directory and compares them with each working tree.
It rejects additional tracked or untracked source changes without resetting
files. Builds and artifact verification run this audit. Bootstrap applies the
declared patches idempotently, including reference and existing build checkouts;
the native build applies the same patches through DuckDB's extension loader
when fetching httpfs from scratch.
For an existing fetched checkout that passes this audit, the native build sets
upstream's `DUCKDB_SKIP_APPLYING_PATCHES=1` to avoid resetting and retouching
unchanged source files on every configure. Fresh fetches still apply all patches.
The build manifest records checksums for both project patches and DuckDB's
upstream httpfs patch.

* workers-rs and worker-build use the same reviewed revision.
* Rust 1.98.0 preserves the `deps/snippets` layout expected by the pinned
  builder. Newer Cargo layouts require a builder update before changing this pin.
* Emscripten uses the documented `6.0.10-cf.emscripten` frontend over the SDK
  6.0.10 LLVM backend. `EM_BINARYEN_ROOT` overrides the builder-written SDK
  Binaryen root; `em-config BINARYEN_ROOT` verifies the effective hook release.
  `build-native.sh` creates the same project-local config before native
  compilation, so it does not depend on a prior Worker build. No shared SDK
  is modified.
* `patches/worker-build-local-cache.patch` adds `WORKER_BUILD_CACHE` to the
  pinned builder so its generated config stays inside this checkout. All
  external tools are supplied explicitly, avoiding its download-cache cleanup.
* Native C++ and the final link use `-fwasm-exceptions` and
  `-sWASM_LEGACY_EXCEPTIONS=0`; the pinned builder translates Rust std to
  exnref. `-sDEFAULT_TO_CXX` includes the exception runtime in the Rust-driven
  emcc link. Rust's panic strategy remains abort.
* Native raw `-flto` bitcode failed Emscripten's wasm-bindgen marker scan:
  `llvm-objdump --section-headers` rejected the bitcode object. Native inputs
  use Wasm objects at `-Oz`; Rust uses thin LTO. No cross-language bitcode
  compatibility is assumed.
* Calls from EM_ASYNC_JS must use `globalThis.fetch`: the generated module also
  exports the Rust handler under `fetch`. Workers rejects `redirect: 'error'`;
  the adapter uses manual redirects and checks status.
* `patches/httpfs-wasm-dependencies.patch` is based on the specified httpfs
  revision and applies after DuckDB's existing `0001` patch. It conditionally
  confines curl/OpenSSL discovery to native targets and defines `EMSCRIPTEN`
  for httpfs's existing C++ guards (the compiler defines `__EMSCRIPTEN__`).
  Without this definition, `http_settings.cpp` still includes curl headers.
  It does not remove
  mbedTLS or alter S3 signing code. Bootstrap copies it as `0002` into
  DuckDB's upstream extension patch mechanism, which the native build uses.
* DuckDB uses MinSizeRel and explicit size flags so its Release `-O3` is not
  effective. `DUCKDB_NO_THREADS` is applied across native compilation,
  including sibling extension targets. Compiler launchers are explicitly empty:
  the host's optional ccache binary has a broken shared-library dependency.
* `SMALLER_BINARY=ON` is retained, with
  `SMALLER_BINARY_EXCEPT=window_specialization`. This preserves the quantile
  and MAD window implementations that completed the bounded-memory benchmark
  queries. Sort specializations were evaluated but did not give a repeatable
  improvement, so their size reduction stays enabled. Set
  `DUCKDB_SMALLER_BINARY_EXCEPT=''` when reproducing the fully trimmed baseline.
  This is an upstream CMake option, not a vendor source edit. Measurement audits
  the effective per-feature compiler flags and records them in the manifest.

Wrangler 4.143.0 pins workerd 1.20260926.1 through its lockfile. The tested
compatibility date is 2026-09-26, with `new_module_registry` and without
`nodejs_compat`.

The fixture generator is native DuckDB 1.5.5, independently versioned and
hashed in `tests/fixtures/manifest.json`. It is used only to write standard
Parquet/JSON fixtures and reference answers. The Worker engine remains the
required DuckDB 2.0 revision. `-init /dev/null` avoids user CLI startup files.

The API integration exposed a second provider initialization boundary:
`DatabaseInstance::Configure` at this pin does not copy `DBConfig`'s HTTP
transport manager. The bridge installs its request-owned provider on the
live database immediately after open, before explicit LOAD and any remote
access. Its identity is checked after loading all four extensions. This is
an application fix, not a DuckDB patch.

DuckDB 2.0's `QueryResult::Fetch()` materializes the result. The API instead
uses `PreparedStatement::Submit()` and `QueryResultStream::Fetch()`, applying
Rust row/byte budgets as chunks arrive. A billion-row range with max_rows=3
is a purposeful check of this boundary.

Remote JSON binding needs more than the default 64 KiB Emscripten JSPI fiber
stack. Main and JSPI fiber stacks are explicitly 1 MiB, inside the same 96 MiB
linear-memory ceiling.

The HTTP adapter requires strong ETags for range reads. Missing or weak
validators select a bounded full-file snapshot. The pinned upstream
[`httpfs.cpp`](https://github.com/duckdb/duckdb-httpfs/blob/3f81d9749e538adc6e4882616fb2c9966e0cb0dd/src/http/httpfs.cpp)
has `FullDownload`, `ReadAtWithFallback`, and size/forced-download paths in
`InitializeFileInfo`. Its automatic fallback handles unsupported ranges;
`BuildReadConfig` skips `If-Match` for weak validators but does not itself
select a full download for them. The project's `httpfs-full-snapshot.patch`
adds opt-in `force_download_without_strong_etag`, which the bridge enables.
It routes weak/missing validators through the existing request-scoped cache.
The adapter caps all full GETs at 4 MiB total per query, rejects known oversized
weakly validated sources at HEAD, and caps unknown lengths while streaming.
It checks any known ETag across HEAD/GET and retains native ETag checks.
Subsequent reads use the single cached byte snapshot. Automatic fallback is
enabled for ignored ranges, but every full GET passes through the same
transport budget. The ignored response body is canceled before reading; the
subsequent conditional full GET is retained by httpfs. A changed version or
malformed 206 remains a hard error.

The host explicitly sets `Accept-Encoding: identity` for every HEAD/GET,
including redirects. [Production Workers automatically negotiate compression](https://developers.cloudflare.com/workers/runtime-apis/fetch/#how-the-accept-encoding-header-is-handled)
when this header is absent. GitHub's raw Parquet example returned a strong
ETag with `identity`, but a weak ETag with `gzip` or `br, gzip` during the
2026-09-29 investigation. The adapter originally rejected that weak ETag with
502; earlier local workerd tests did not cover this negotiation. A real HTTPS fixture now
requires explicit identity encoding for a strong validator; the old artifact
fails that regression and the fixed
artifact must complete the HEAD/range query. Strong-validator checks remain
enabled for ranges. Identity encoding did not resolve the owner's deployed
weak-ETag response, which prompted the bounded snapshot fallback above. The
transport reports bounded reason codes, method, upstream status (if received),
and fetch counters so the failing boundary can be identified. It never returns
raw native/host exception messages, source URLs, or response headers.

Native archive verification parses each archive member and requires Wasm
magic; it checks all 391 members of the five selected archives. The final
manifest also hashes these archives, the generated registration source,
lockfiles, package modules, and local test reports. `measure.sh` refuses to
associate a test report or dry-run Wasm with a different release hash.

`HTTPHeaders::GetHeaderValue` throws an internal exception for an absent
header at this pin. The adapter checks presence before reading ETag,
Content-Range or redirect Location, turning malformed upstream responses
into recoverable 502 errors. Edge tests include all three absent headers,
weak validators and a full fallback that reaches the streaming byte cap when
neither HEAD nor GET provides Content-Length.

The local test harness asks the OS for free ports and cleans up its own
workerd process and fixture sockets. It validates the same full API artifact
used for packaging. Delayed HTTPS reads exercise real JSPI continuation,
same-module event-loop progress and native exceptions after suspension.
