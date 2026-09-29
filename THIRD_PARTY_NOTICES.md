# Third-party software

This evaluation incorporates the following upstream projects. Preserve their
license texts when redistributing compiled artifacts. Source checkouts are
created at the immutable revisions in `toolchain-lock.json`.

* DuckDB and its built-in core_functions, parquet, and json extensions:
  MIT, `vendor/duckdb/LICENSE`. DuckDB's `third_party/` contains component
  notices for libraries including zstd, zlib, Snappy, RE2, yyjson, fast_float,
  utf8proc, miniz, mbedTLS, and other embedded components. Retain those files.
* duckdb-httpfs: MIT, `vendor/httpfs/LICENSE`; additional vendored dependencies
  retain their own licenses in that checkout. The Wasm build retains mbedTLS.
* workers-rs: Apache-2.0, `vendor/workers-rs/LICENSE`.
* Rust runtime and standard library: MIT OR Apache-2.0; LLVM components use
  Apache-2.0 with LLVM exceptions. Toolchain distribution includes notices.
* Emscripten: MIT OR NCSA, `.tools/emscripten/LICENSE`; libc/libc++ and other
  system libraries retain notices under `.tools/emscripten/system/lib/`.
* wasm-bindgen, js-sys, and Rust dependencies: see `Cargo.lock` and each
  downloaded crate's license files in `.tools/cargo/registry/src/`.
* Wrangler/workerd and npm build dependencies: see `package-lock.json` and
  package license files under `node_modules/`. These are local build/test
  tooling, not bundled application dependencies.

`./scripts/collect-licenses.py` copies available license/notice files for the
native inputs and locked Rust crates to `artifacts/licenses/` for packaging.
Project patches are described in `docs/build-notes.md` and hashed in the build
manifest. No upstream authors endorse this evaluation.
