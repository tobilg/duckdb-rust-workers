# Rust, C++ and JSPI boundary

The Rust binary crate targets `wasm32-unknown-emscripten` and links DuckDB
into the same Wasm module. The workers-rs handler owns routing and the busy
flag. Each query owns its database, connection, parameters and result stream.
There is one generated module per isolate, serving `/healthz` and `/v1/query`.

The demonstrated call path is:

```text
Rust async handler
  -> wasm-bindgen invokeQuery import (returns Promise)
  -> installed JS function
  -> Emscripten _bridge_run generated promising wrapper
  -> synchronous C++ bridge_run / DuckDB / httpfs
  -> EM_ASYNC_JS worker_fetch / WebAssembly.Suspending
  -> globalThis.fetch over real HTTPS
  -> native continuation, bounded rows or caught C++ error
  -> settled Promise awaited by Rust
```

`JSPI_EXPORTS=bridge_run` selects the native entry. Emscripten's
`instrumentWasmExports` matches it and calls `WebAssembly.promising`.
`instrumentWasmImports` wraps `__asyncjs__worker_fetch` in
`WebAssembly.Suspending`. Binaryen's `--jspi-hooks` pass instruments the native
boundary; `REENTRANT_JSPI` allocates separate shadow stacks. The cfg
`wasm_bindgen_unstable_jspi` integrates wasm-bindgen with these lifecycle hooks.
The generated JS calls this runtime object `Asyncify`, but its implementation
uses JSPI; no Asyncify stack-rewriting transform is enabled.

The installed global symbol contains only a function, never credentials or
request data. A CString remains owned by the Rust future until settlement.
The host copies the URL before waiting, then reacquires `HEAPU8` each time it
copies received bytes. Native exceptions are caught entirely in C++; host
fetch failures become numeric statuses. A rejected outer Promise marks the
module unusable. No Rust mutable borrow or blocking application lock survives
a suspension. A guard clears the busy flag on ordinary exits.

The test uses one workerd service/module, an actual Node HTTPS fixture server,
and a freshly generated local certificate trusted only by that test runtime.
During its delayed response, `/healthz` observes `busy=true` in that same
module and a second operation receives 429 before the fixture replies.

The bridge explicitly invokes the upstream-generated static registration
function before opening any database, then loads all four built-in extensions
on each new database. The API tests inspect their loaded state and exercise
local functions and remote Parquet/JSON reads. Native exceptions cannot cross
the C ABI.

Wasm linear memory is not total isolate memory. JS timers cannot preempt
CPU-bound Wasm. The no-thread DuckDB build does not gain native async
read-ahead from JSPI.

A boxed Rust `QueryContext` remains allocated until the outer Promise settles.
The native ABI receives
only its opaque pointer and an owned SQL C string. Synchronous callbacks
read parameters, authorize transport URLs and statement classes, serialize
columns/cells/rows under budgets, and report counters. No native C++ object
layout appears in Rust. Native locals own the database, connection, stream,
provider, version map, and response storage; C++ unwinding releases them.
The same request-owned context receives bounded transport reason codes,
method, upstream status and counters before native cleanup completes. Rust
adds these diagnostics only to upstream/deadline errors. URLs, raw headers
and exception messages never cross this diagnostic boundary.

`WorkerHTTPUtil` subclasses the pinned `HTTPFSUtil` to preserve its parameter
and signing setup, advertises `CLIENT_FREE`, and overrides `SendRequest`.
It is named `WasmHTTPUtils` to satisfy httpfs's initialization contract. The
bridge installs it on the live database before explicitly loading httpfs and
checks that loading did not replace it. All remote requests, including
redirects, pass back through the Rust HTTPS origin/path policy. An unset
`ALLOWED_ORIGIN` permits any HTTPS origin; an unset `ALLOWED_PATH_PREFIX`
permits any path. Configured restrictions still apply. Signed URL strings are
forwarded unchanged. Same-origin request headers are preserved except for
`Accept-Encoding`, which is set to `identity` on every HEAD/GET to avoid
compression negotiation changing byte representations or validators.
Cross-origin redirects retain only range/cache/accept headers to avoid
forwarding credentials.

The adapter issues sequential HEAD/GET operations. Native range arithmetic
uses uint64_t and JavaScript validates lengths with BigInt. Received bytes
are bounded while streaming, including when Content-Length is absent; each
await is followed by a fresh Wasm memory view. Strong ETags are required for
range reads and remembered per query; inconsistent versions or Content-Range
fail the query. When HEAD has a weak or missing validator, an opt-in httpfs
patch selects its existing `FullDownload`/`CachedFileHandle` path. It fetches
one complete snapshot and serves subsequent reads from that request-owned
buffer. All full GETs share a 4 MiB budget, checked against declared lengths
and while streaming. A known oversized weakly validated object is rejected
at HEAD. Larger strongly validated files continue to use remote ranges.
Response/content callbacks follow the native HTTP request contract.

Only the completed bounded response buffer crosses back into an HTTP
response. Row limits stop the result stream early; a byte breach discards
partial JSON and returns a small 413 error. Parameters, credentials embedded
in signed URLs/headers, and version state do not survive the request-owned
database or context.
