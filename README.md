# DuckDB on Cloudflare Workers

Cloudflare announced on 2026-09-28 that they now support [Rust Workers via Emscripten](https://blog.cloudflare.com/rust-workers-emscripten-target/). This project enables [DuckDB](https://duckdb.org) builds via Emscripten, and deploys them via Rust/Wasm to the Cloudflare Workers platform.

You can query remote Parquet, JSON, and CSV files with DuckDB directly inside a
Cloudflare Worker. The request handler and application logic are written in
Rust, linked with DuckDB into a single WebAssembly module using Emscripten.
Network reads use Workers `fetch()` and JSPI to suspend and resume native code.

The project uses DuckDB **v2.0-cyanoptera**, with `core_functions`, `parquet`,
`json`, and `httpfs` built in. It provides an authenticated, read-only SQL API
with parameterized queries, bounded results, and configurable transfer limits.
Each request runs against a fresh in-memory database.

This is an experimental project for trusted callers. See
[runtime limits](#runtime-limits) for its operational constraints.

## Build and test

The bootstrap currently supports **macOS arm64**. Install Git, Python 3.11+,
CMake, Ninja, rustup, the OpenSSL CLI, and Node **22.22.2** (see `.nvmrc`).
Allow several GiB of disk space for the toolchain and native build.

Run from the repository root:

```sh
./scripts/bootstrap-toolchain.sh
npm ci
./scripts/validate.sh
```

Bootstrap installs pinned tools and sources into the checkout without changing
a shared Emscripten SDK. Dependency patches are tracked in `patches/`, declared
in `toolchain-lock.json`, and applied automatically. Builds reject unrecorded
changes to vendored dependencies.

Validation builds the Worker, runs integration tests in local workerd,
performs a deployment packaging dry run, and profiles startup. It requires
no Cloudflare account and does not deploy the Worker. Tests use a local HTTPS
fixture server and cover JSPI suspension, native exceptions, built-in
extensions, remote reads, transfer and output limits, cleanup, and overlapping
requests.

The resulting package is `build/index.js` and `build/index_bg.wasm`. Subsequent
builds are incremental. Native compilation uses two jobs by default; set
`NATIVE_JOBS` to adjust it, for example `NATIVE_JOBS=4 ./scripts/validate.sh`.

To run individual steps:

```sh
./scripts/build-worker.sh
./scripts/test-local.sh
```

Generated logs, measurements, `build-manifest.json`, and `validation-report.md`
are written to the Git-ignored `artifacts/` directory. It can be deleted;
`./scripts/validate.sh` regenerates it. `./scripts/verify-artifact.sh` checks an
existing manifest against the build outputs.

## Deploy to Cloudflare

Complete the local setup above and use a Cloudflare Workers Paid account.
Set the Worker name in `wrangler.jsonc`, then authenticate and deploy:

```sh
npx --no-install wrangler login
npx --no-install wrangler deploy
npx --no-install wrangler secret put API_KEY
```

Wrangler runs the configured build before uploading the Worker. Enter a long,
random API key at the secret prompt and save it for client requests. Queries
are rejected until the secret is configured. `/healthz` is unauthenticated.
The commands use the top-level configuration; no named Worker environment is
required.

If you have multiple Cloudflare accounts, set `CLOUDFLARE_ACCOUNT_ID` to select
one. For CI, provide `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` through
your CI secret store instead of using `wrangler login`. The Cloudflare API
token authorizes deployments; `API_KEY` authenticates SQL requests.

## Query examples

Set the URL printed by Wrangler and read your API key interactively. The
examples pass the authorization header through stdin to keep the key out of
curl's command-line arguments.

```sh
export WORKER_URL='https://duckdb-rust-workers.your-subdomain.workers.dev'
read -r -s API_KEY
```

Check health:

```sh
curl --fail-with-body "$WORKER_URL/healthz"
```

Run SQL without a remote data source:

```sh
curl --fail-with-body --header @- --json '{"sql":"SELECT 42 AS answer"}' \
  "$WORKER_URL/v1/query" <<EOF
Authorization: Bearer $API_KEY
EOF
```

Aggregate a public Parquet file containing cloud provider IP ranges:

```sh
curl --fail-with-body --header @- --json '{
  "sql": "SELECT cloud_provider, sum(ip_address_cnt)::int AS cnt FROM read_parquet(?) GROUP BY cloud_provider",
  "params": ["https://raw.githubusercontent.com/tobilg/public-cloud-provider-ip-ranges/main/data/providers/all.parquet"]
}' "$WORKER_URL/v1/query" <<EOF
Authorization: Bearer $API_KEY
EOF
```

Read JSON or CSV by replacing the placeholder URLs with your own HTTPS files:

```sh
curl --fail-with-body --header @- --json '{
  "sql": "SELECT * FROM read_json_auto(?)",
  "params": ["https://data.example.com/data/example.json"],
  "max_rows": 10
}' "$WORKER_URL/v1/query" <<EOF
Authorization: Bearer $API_KEY
EOF

curl --fail-with-body --header @- --json '{
  "sql": "SELECT * FROM read_csv_auto(?)",
  "params": ["https://data.example.com/data/example.csv"],
  "max_rows": 10
}' "$WORKER_URL/v1/query" <<EOF
Authorization: Bearer $API_KEY
EOF
```

Remote reads allow any HTTPS origin by default. If source restrictions are
configured, they must permit the URLs used in your queries. Large objects
require byte-range support and strong ETags; see [remote reads](#remote-reads).
Run `unset API_KEY` when finished.

## Configuration

Set non-secret bindings in the top-level `vars` object in `wrangler.jsonc`.
Store `API_KEY` with `wrangler secret put API_KEY`.

| Binding | Default | Purpose |
| --- | --- | --- |
| `API_KEY` | Unset; queries rejected | Secret used for `Authorization: Bearer <API_KEY>`. |
| `QUERY_TRANSFER_LIMIT_MIB` | `"64"` | Maximum cumulative response-body bytes fetched per query, in MiB. |
| `ALLOWED_ORIGIN` | Any HTTPS origin | Optionally restrict remote reads to one origin, such as `https://data.example.com`. This is an outbound source restriction, not a CORS setting. |
| `ALLOWED_PATH_PREFIX` | `"/"` | Restrict remote reads to a path prefix, such as `/data/`. Applies to every allowed origin. |
| `LOCAL_EVALUATION` | Unset | Set to `"1"` to allow unauthenticated queries when `API_KEY` is absent. Intended for local testing; leave unset when deploying. |

For example, to raise the transfer budget to **128 MiB**, update the existing
`vars` object:

```jsonc
{
  "vars": {
    "QUERY_TRANSFER_LIMIT_MIB": "128"
  }
}
```

The transfer budget counts consumed response-body bytes across all files in
a query, including failed reads. Cache hits consume no transfer budget.
Increasing it does not allocate more memory or change the per-response and
full-download limits. Values must be strings containing positive whole
numbers of MiB, up to 4,294,967,295; invalid values return a configuration
error. Omitting the binding uses 64 MiB.

Origin and path restrictions also apply to redirects. `LOCAL_EVALUATION`
does not detect where the Worker is running; it enables the same authentication
bypass locally and when deployed if no API key is configured.

See [performance tuning](docs/performance.md) for `RANGE_CACHE_BLOCK_BYTES`
and `PARQUET_PREFETCH_COLUMN_GAP`.

## API

### `POST /v1/query`

Send a JSON body with a bearer token:

| Field | Type | Description |
| --- | --- | --- |
| `sql` | String, required | One SQL statement with optional `?` parameter placeholders. |
| `params` | Array, optional | Positional parameters: strings, numbers, booleans, or null. Defaults to `[]`. |
| `max_rows` | Integer, optional | Cap returned rows from 1 to 10,000. Omit it to return all rows, subject to the response-size limit. |

Successful responses contain column names and DuckDB types, row arrays,
`truncated`, a request ID, and timing/network metrics. Row arrays preserve
duplicate column names. Without `max_rows`, all rows are returned. When a cap
is supplied, results beyond it are omitted and `truncated` is `true`.
Exceeding the 1 MiB serialized output budget returns 413 rather than a partial
result, with or without `max_rows`.

Integers outside JavaScript's safe range and exact decimals are encoded as
strings. Dates and timestamps are strings; non-finite floats are `"NaN"`,
`"Infinity"`, or `"-Infinity"`. Complex result types return 400.

The API accepts read-only SELECT statements and forces ATTACH statements to
be read-only. Attachments exist only for the current request. Mutations,
configuration SQL, INSTALL, and user LOAD are rejected. DuckLake and quack
extensions are not included. This policy is intended for trusted callers
and does not provide an adversarial SQL sandbox.

### `GET /healthz`

Returns `busy`, `fatal`, `request_id`, and `wasm_memory_bytes` without
authentication. An idle, healthy module reports `busy: false` and
`fatal: false`. Memory is allocated Wasm linear memory, not total isolate
memory.

### Errors and diagnostics

Errors include `request_id` and an `error` object with `category` and `message`.

| Status | Meaning |
| --- | --- |
| 400 | Invalid input, rejected SQL, or unsupported result type. |
| 401 | API key has not been configured. |
| 403 | Missing or incorrect bearer token. |
| 413 | Serialized result exceeds the output budget. |
| 429 | Another query is active in the same module. |
| 500 | Invalid configuration or engine/module failure. |
| 502 | Remote read failed or violated source/transfer policy. |
| 504 | Remote read deadline exceeded. |

Remote-read errors can include `error.diagnostic` with a reason, HTTP method,
and upstream status. Common reasons are `source_policy`,
`upstream_http_status`, `invalid_content_range`, `response_body_limit`,
`query_transfer_limit`, and `full_download_limit`. Diagnostics omit source
URLs, credentials, and raw exception messages.

Use `npx --no-install wrangler tail` to inspect deployed Worker logs. Response
metrics include fetch counts and bytes, cache hits, peak cache storage, and
peak transport staging bytes. These counters describe query activity rather
than total isolate memory.

## Runtime limits

Each request owns its database, connection, and input caches. Only one query
can run per module at a time; overlapping requests receive 429. There is no
persistence or spill to disk. Fetches run sequentially.

| Resource | Limit |
| --- | --- |
| Request body / serialized response | 64 KiB / 1 MiB |
| Rows | All by default; optional `max_rows` cap from 1 to 10,000 |
| Columns / parameters | 256 / 256 |
| Wasm linear memory / DuckDB managed memory | 96 MiB / 48 MiB |
| Individual response body | 8 MiB |
| Query transfer | 64 MiB by default; configurable with `QUERY_TRANSFER_LIMIT_MIB` |
| Full-download snapshots | 4 MiB total per query |
| Range cache | 4 MiB, at most 64 entries per request |
| Fetch wait / query I/O deadline | 10 s / 30 s |
| Fetch attempts | At most 3, including redirects |

Wasm can retain allocated memory after a request completes. Its linear-memory
limit does not cap total isolate memory. JavaScript timers cannot interrupt
CPU-bound Wasm, so the I/O deadline is not a hard CPU deadline.

### Remote reads

Large files are read with byte ranges and strong ETags to detect object
changes between requests. Weak or missing ETags, or a server that ignores
Range, trigger a bounded full download through httpfs. Full-download
snapshots share a **4 MiB budget per query** and are reused during query
preparation and execution. Larger objects that require a full download are
rejected. Malformed ranges and changed object versions are also rejected.

Only HTTPS sources and absolute HTTPS redirects are supported. Cross-origin
redirects strip origin-specific headers such as authorization and cookies.
The httpfs S3 signing and cryptography code is included; authenticated S3
access is not covered by the integration suite.

## Further documentation

- [Architecture](docs/architecture.md): Rust/C++ boundary, JSPI, request lifecycle, and HTTP transport.
- [Build notes](docs/build-notes.md): toolchain pins, dependency patches, and compilation details.
- [Performance](docs/performance.md): benchmarks, memory accounting, and tuning options.

## License

[MIT](LICENSE). Dependency licenses are listed in
[third-party notices](THIRD_PARTY_NOTICES.md).
