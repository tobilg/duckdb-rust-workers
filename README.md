# Rust DuckDB Worker evaluation

DuckDB 2.0 and Rust linked into one Emscripten Wasm module, with synchronous
native HTTP reads suspended through JSPI and real Workers `fetch()`.
`core_functions`, `parquet`, `json`, and `httpfs` are statically registered.
This is a local, trusted-caller evaluation, not a production SQL service.

Validation generates `artifacts/validation-report.md` with acceptance results
and limitations, and `artifacts/build-manifest.json` with exact pins, flags,
checksums, and output identities. The entire `artifacts/` directory is ignored
by Git and can be deleted. Run `./scripts/validate.sh` to regenerate it before
artifact verification. Wrangler uploads the Worker modules from `build/`.

## Reproduce locally

The evaluated build host is macOS arm64. Bootstrap deliberately rejects other
hosts rather than selecting unverified binary assets. Prerequisites: Git,
Python 3.11+, CMake, Ninja, rustup, OpenSSL CLI, and Node **22.22.2** (`.nvmrc`).
Allow several GiB of disk, plus compiler temporary space. Bootstrap downloads
immutable sources and checksum-verified tool archives into this checkout;
it does not modify a shared Emscripten SDK.

Vendor changes are stored in `patches/` and declared in `toolchain-lock.json`.
Bootstrap applies them automatically; builds reject unrecorded vendor edits.
See [build notes](docs/build-notes.md) for the patch inventory.

```sh
./scripts/bootstrap-toolchain.sh
npm ci
./scripts/validate.sh
```

`validate.sh` builds the Worker, runs the local tests, performs a packaging dry
run and startup profile, then generates and verifies the manifest and report.
It also works after `artifacts/` has been cleared. `verify-artifact.sh` checks
an existing manifest; it does not create one or run tests.

The build compiles DuckDB and its four static extensions, then links the Rust
API into the Worker. Native compilation uses two jobs by default
(`NATIVE_JOBS=4` to change it).
Subsequent builds are incremental. Testing generates the large fixture using
the separately pinned native DuckDB 1.5.5 CLI; this is only a fixture generator,
not the Worker engine. Tests start actual workerd and a local TLS fixture
server. Their temporary certificate is trusted only by that workerd process.
The harness selects free local ports. No Cloudflare account is needed.

The integration suite exercises the full API, including real JSPI suspension,
native exceptions before and after remote reads, static extension loading,
output bounds, request cleanup, and same-module overlap rejection.

`build/index.js` and `build/index_bg.wasm` form the local package. Verify its
manifest before deployment. `./scripts/build-native.sh` can rebuild only the
native archives when working on the C++ dependencies.
A packaging dry run does not upload or establish deployed startup/runtime
compatibility. Publishing an endpoint is outside these commands.

## Deploy to Cloudflare

Deployment is a separate evaluation step and has not yet been validated on
Cloudflare. Install the prerequisites from the local workflow above first.
Use an authorized Workers Paid test account with a workers.dev subdomain;
the deploy command below publishes an endpoint and its requests use that
account's quota.

Use remote Parquet, JSON, or CSV files served over HTTPS to test the Worker.
Large files require strong ETags and byte-range support. Files with weak or
missing ETags use one full GET, with a 4 MiB total full-read budget per query.
DuckDB reads that request-owned snapshot for the rest of the query.

### Configure the Worker

The default configuration permits remote reads from any HTTPS origin and path.
To restrict sources, add these optional top-level settings to `wrangler.jsonc`,
using your own host and path prefix. Keep the existing build and compatibility
settings. These commands use the top-level Worker configuration.

```jsonc
{
  "workers_dev": true,
  "vars": {
    "ALLOWED_ORIGIN": "https://data.example.com",
    "ALLOWED_PATH_PREFIX": "/data/"
  }
}
```

Wrangler runs the configured Rust build and bundles `build/index.js` and
`build/index_bg.wasm` for upload. Rebuild and rerun local validation before
deploying any source or toolchain changes.
`API_KEY` belongs in a secret, not in `vars` or a committed file.

### Authenticate, verify, and publish

Run these commands from the repository root with the pinned Node/npm tools:

```sh
npx --no-install wrangler login
npx --no-install wrangler whoami
export CLOUDFLARE_ACCOUNT_ID='your-test-account-id'

./scripts/validate.sh

# These commands publish the Worker and then configure its API secret.
npx --no-install wrangler deploy
npx --no-install wrangler secret put API_KEY
```

Enter a long random API key at the interactive secret prompt and retain it in
your password manager. On the first deployment, queries return 401 until the
secret is set because local access is disabled. Afterward, missing or incorrect
bearer tokens return 403; `/healthz` remains unauthenticated. Setting or rotating
a secret creates and immediately deploys a new Worker version, so record the
final version ID after that step. See [Wrangler secret behavior](https://developers.cloudflare.com/workers/configuration/secrets/).

For CI, supply `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` through the CI
secret store instead of running `wrangler login`. The Cloudflare API token
authorizes deployment; it is distinct from the Worker's `API_KEY`.

### Check the deployed Worker

Check health using the URL printed by Wrangler:

```sh
curl --fail-with-body 'https://duckdb-rust-workers.your-subdomain.workers.dev/healthz'
```

Health should report `busy: false` and `fatal: false` when idle.

To test remote Parquet, JSON, or CSV files, use `read_parquet(?)`,
`read_json_auto(?)`, or `read_csv_auto(?)` in a `POST /v1/query` request.
Pass the file URL in `params` and send `Authorization: Bearer <API_KEY>`.
Configured `ALLOWED_ORIGIN` and `ALLOWED_PATH_PREFIX` restrictions apply to
these URLs. The local integration suite covers Parquet and JSON.

Use `npx --no-install wrangler tail` while checking failures.
A 502 can indicate an origin/path mismatch, a transfer limit, invalid range
response, or upstream failure; 504 indicates the I/O deadline.
These responses include `error.diagnostic` with a reason code, HEAD/GET method,
and upstream status when a response was received, plus fetch counters in
`metrics`. For example:

```json
{"reason":"full_download_limit","method":"HEAD","upstream_status":200}
```

`source_policy` means the URL restriction rejected the read;
`upstream_http_status` reports an HTTP error from the source;
`fetch_failed`/`fetch_type_error` mean fetch failed before a response;
`missing_etag`/`weak_etag` identify an unvalidated range response;
`range_ignored`/`invalid_content_range` identify range failures;
`response_body_limit` means a response exceeded its transfer cap;
`full_download_limit` means a full read would exceed the 4 MiB query budget.
Diagnostics exclude URLs, credentials, raw headers, and exception messages.
Retain the complete error JSON when reporting a deployed failure.

The local integration suite is not a deployed test runner. Repeat the large-object and
error cases against remote test files before claiming deployed
acceptance, and retain server range logs and response metrics.

Record the account, Worker name, final version ID, tested artifact SHA-256,
upload size, reported startup time, query results, and available platform
CPU/memory outcomes in a separate deployment report. `/healthz` reports only
Wasm linear memory. Leave total isolate memory and S3 checks marked pending
until measured. Keep the existing local validation report as local evidence.

For a later deployment with a known working previous version, rollback with
`npx --no-install wrangler rollback <VERSION_ID>`.

### Query with curl

Set your Worker URL and read the API key interactively (paste it, then press
Enter). The examples pass authentication through stdin to keep the key out of
curl's command-line arguments. Leave the origin/path restrictions unset for
these examples, or configure them to allow the data URLs you use.

```sh
export WORKER_URL='https://duckdb-rust-workers.your-subdomain.workers.dev'
read -r -s API_KEY
```

Run local SQL:

```sh
curl --fail-with-body --header @- --json '{"sql":"SELECT 42 AS answer"}' \
  "$WORKER_URL/v1/query" <<EOF
Authorization: Bearer $API_KEY
EOF
```

Aggregate the public cloud provider IP ranges Parquet file. Passing the URL
as a parameter is equivalent to `FROM 'https://…/all.parquet'`:

```sh
curl --fail-with-body --header @- --json '{
  "sql": "SELECT cloud_provider, sum(ip_address_cnt)::int AS cnt FROM read_parquet(?) GROUP BY cloud_provider",
  "params": ["https://raw.githubusercontent.com/tobilg/public-cloud-provider-ip-ranges/main/data/providers/all.parquet"]
}' "$WORKER_URL/v1/query" <<EOF
Authorization: Bearer $API_KEY
EOF
```

Read a JSON file (replace the example URL with your file):

```sh
curl --fail-with-body --header @- --json '{
  "sql": "SELECT * FROM read_json_auto(?)",
  "params": ["https://data.example.com/data/example.json"],
  "max_rows": 10
}' "$WORKER_URL/v1/query" <<EOF
Authorization: Bearer $API_KEY
EOF
```

For CSV, use `read_csv_auto(?)` and a CSV URL. When finished, run `unset API_KEY`.

## API

`POST /v1/query` accepts a JSON object with `sql`, optional scalar `params`, and
optional `max_rows`. `GET /healthz` reports module busy/fatal state and allocated
Wasm linear memory. Responses include column names/types, row arrays,
`truncated`, a request ID, and wall/network metrics.

```json
{"sql":"SELECT * FROM read_parquet(?)","params":["https://data.example.com/data/example.parquet"],"max_rows":10}
```

Omit `ALLOWED_ORIGIN` to allow any HTTPS origin, or set it to restrict reads
to one origin. `ALLOWED_PATH_PREFIX` defaults to `/` (all paths) and can narrow
reads to a prefix such as `/data/`. Local SQL works with both settings unset.
A malformed configured origin returns a configuration error; it does not
disable the restriction. Set secret `API_KEY` for bearer authentication.

For local testing without an API key, `LOCAL_EVALUATION=1` permits
unauthenticated queries only when `API_KEY` is absent. This flag does not detect
whether the Worker is running locally; leave it unset for deployments.

Rust owns validation, authentication, URL policy, serialization, and the busy
state. DuckDB parses exactly one statement. SELECT must report no modified
databases. ATTACH is accepted with read-only forced by the bridge; attachments
exist only for that request. DuckLake/quack extensions are not included.
Mutation, configuration SQL, INSTALL, and user LOAD are rejected. This policy
is for trusted callers, not an adversarial SQL sandbox.

Integers outside JavaScript's safe range and exact decimals are strings;
dates/timestamps are strings, non-finite floats are `"NaN"`, `"Infinity"`, or
`"-Infinity"`. Duplicate names are preserved by row arrays. Complex types
return 400 until an encoding is defined. Errors are sanitized and use
400/401/403/413/429/500/502/504 according to their category.

## Budgets and boundaries

Each request owns a fresh in-memory database and connection. Only one query
may run per module; an overlapping request gets 429. Native exceptions are
caught before crossing into Rust. A Wasm trap marks the module unusable.

| Resource | Bound |
| --- | --- |
| Input / serialized output | 64 KiB / 1 MiB |
| Rows / columns / parameters | Default 1,000, maximum 10,000 / 256 / 256 |
| Linear memory / DuckDB managed memory | 96 MiB / 48 MiB |
| Execution / async threads | 1 / 0 |
| Spill / external file cache | Disabled / disabled |
| Response body / query transfer | 8 MiB / 32 MiB |
| Full reads and request-owned input snapshots | 4 MiB total per query |
| Fetch wait / query I/O deadline | 10 s / 30 s |
| Fetch concurrency / attempts | 1 / at most 3 including redirects |

The host copies response chunks only into a current Wasm memory view after
awaiting them. Outbound HEAD/GET requests use `Accept-Encoding: identity`.
Range reads require strong ETags. Weak or missing validators select httpfs's
full-download cache, bounded to 4 MiB across full reads in the query. Known
oversized objects are rejected at HEAD; unknown lengths are capped while
streaming. Snapshots are released with the request-owned database.
The adapter cancels error/timeout bodies, checks ranges, and
applies the configured origin/path restrictions to every redirect. Only absolute
HTTPS redirects are supported. Cross-origin redirects retain range/cache/accept
headers and drop origin-specific headers such as authorization and cookies. Range-ignored large objects
are rejected; they are never downloaded wholesale to satisfy a query.

The memory settings do **not** measure or cap total isolate memory. Wasm may
retain its allocated high-water memory after cleanup. JavaScript timers
cannot preempt CPU-bound Wasm; the I/O deadline is not a hard CPU deadline.
No pthread scheduler or automatic concurrent read-ahead is supplied by JSPI.
The linked httpfs signing/cryptography path is retained, but authenticated
S3 behavior requires separate credentials and validation.

See [architecture](docs/architecture.md), [build notes](docs/build-notes.md),
and [third-party notices](THIRD_PARTY_NOTICES.md).
