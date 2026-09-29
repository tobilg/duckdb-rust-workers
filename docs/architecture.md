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
at HEAD. A server that ignores Range returns 200: the host cancels that body,
then signals upstream's unsupported-range error to select `ReadAtWithFallback`.
The resulting full GET retains read conditions and the same 4 MiB cumulative
budget. Known oversized files fail before the full GET; unknown lengths are
capped while streaming. Malformed 206 responses and changed validators never
select this fallback. Larger strongly validated files continue to use ranges.
Response/content callbacks follow the native HTTP request contract.

Owned subclasses of `HTTPState` and the query-local `HTTPMetadataCache` defer
their `QueryEnd` cleanup to connection destruction. DuckDB ends an internal
query during preparation; the API request spans preparation and execution.
This lifetime change preserves upstream's completed snapshot and metadata
without sharing them across requests. Upstream already checks for a cached
full file before HEAD, so this needs no additional vendor patch.

The transport also keeps an LRU of validated 206 responses within the request.
Its 4 MiB budget includes charged entry metadata, and it has at most 64 entries.
Keys include the exact URL and all effective headers except Range. Subranges
of cached bytes retain the original strong validator and total size. Network
counters count actual consumed bytes, while separate counters describe hits
and peak charged cache storage. Range staging buffers are sized to the wire
range, capped at 8 MiB; full reads remain capped at 4 MiB. Optional block
alignment never widens signed/query-string URLs or requests with credential
headers. This is sequential fetch reuse, not concurrent read-ahead.

Rust reads `QUERY_TRANSFER_LIMIT_MIB` from the deployment bindings, defaulting
to 64 MiB, validates a positive 32-bit integer, then converts it to a 64-bit
byte budget before passing it through the owned C ABI. The provider applies
the remaining cumulative budget to every network body, including full
snapshots and failed reads. Exceeding it returns `query_transfer_limit` and
releases the request state. Cached ranges consume no additional transfer.

Only the completed bounded response buffer crosses back into an HTTP
response. Row limits stop the result stream early; a byte breach discards
partial JSON and returns a small 413 error. Parameters, credentials embedded
in signed URLs/headers, and version state do not survive the request-owned
database or context.
