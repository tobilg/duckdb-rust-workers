#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/env.sh"
cd "$PROJECT_ROOT"
if [[ "$(node --version)" != v22.22.2 ]]; then
  echo 'Use Node 22.22.2 (see .nvmrc) before bootstrap.' >&2
  exit 1
fi
mkdir -p artifacts/logs .tools/bin
python3 scripts/bootstrap-sources.py
rustup toolchain install 1.98.0 --profile minimal --target wasm32-unknown-emscripten --component rustfmt
EMSDK_KEEP_DOWNLOADS=1 python3 .tools/emsdk/emsdk.py install 6.0.10
tar -xzf .tools/binaryen.tar.gz -C .tools
tar -xzf .tools/wasm-bindgen.tar.gz -C .tools
python3 - <<'PY'
from pathlib import Path
from zipfile import ZipFile
with ZipFile('.tools/fixture-duckdb.zip') as archive:
    archive.extractall('.tools/fixture-duckdb')
Path('.tools/fixture-duckdb/duckdb').chmod(0o755)
PY
cp .tools/wasm-bindgen-0.2.129-aarch64-apple-darwin/wasm-bindgen .tools/bin/
python3 .tools/emscripten/bootstrap.py
cargo build --locked --manifest-path vendor/workers-rs/Cargo.toml \
  -p worker-build --bin worker-build --release --target-dir .tools/host-target-1.98
cp .tools/host-target-1.98/release/worker-build .tools/bin/
echo 'Local toolchain ready. Run npm ci, then ./scripts/build-worker.sh.'
