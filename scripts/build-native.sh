#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/env.sh"
cd "$PROJECT_ROOT"
python3 scripts/check-pins.py
# The audit above verifies the exact pinned source and patch contents. DuckDB's
# patch command otherwise resets and reapplies them on every configure, touching
# headers and forcing needless recompilation. Fresh checkouts still need patches.
if [[ -e build/duckdb/_deps/httpfs_extension_fc-src/.git ]]; then
  export DUCKDB_SKIP_APPLYING_PATCHES=1
else
  unset DUCKDB_SKIP_APPLYING_PATCHES
fi
python3 - <<'PY'
import json
import os
from pathlib import Path
# Native compilation precedes worker-build. Create its project-local config
# without relying on an earlier Worker build to initialize Emscripten.
sdk = Path(os.environ['EMSDK'])
node = sorted((sdk / 'node').glob('*/bin/node'))
assert len(node) == 1, 'bootstrap must provide exactly one pinned SDK Node runtime'
config = Path(os.environ['EM_CONFIG'])
config.parent.mkdir(parents=True, exist_ok=True)
contents = '\n'.join(f'{key} = {json.dumps(str(path))}' for key, path in {
    'LLVM_ROOT': sdk / 'upstream/bin',
    'BINARYEN_ROOT': sdk / 'upstream',
    'NODE_JS': node[0],
}.items()) + '\n'
if not config.exists() or config.read_text() != contents:
    config.write_text(contents)
PY
emcmake cmake -S vendor/duckdb -B build/duckdb -G Ninja \
  -DCMAKE_BUILD_TYPE=MinSizeRel \
  -DCMAKE_EXPORT_COMPILE_COMMANDS=ON \
  -DCMAKE_C_COMPILER_LAUNCHER= -DCMAKE_CXX_COMPILER_LAUNCHER= \
  -DCMAKE_C_FLAGS='-DDUCKDB_NO_THREADS' \
  -DCMAKE_CXX_FLAGS='-DDUCKDB_NO_THREADS -fwasm-exceptions -sWASM_LEGACY_EXCEPTIONS=0' \
  -DCMAKE_C_FLAGS_MINSIZEREL='-Oz -DNDEBUG -ffunction-sections -fdata-sections' \
  -DCMAKE_CXX_FLAGS_MINSIZEREL='-Oz -DNDEBUG -ffunction-sections -fdata-sections' \
  -DSMALLER_BINARY=ON \
  '-DBUILD_EXTENSIONS=core_functions;parquet;json;httpfs' \
  -DBUILD_SHELL=OFF -DBUILD_UNITTESTS=OFF -DBUILD_BENCHMARKS=OFF \
  -DDISABLE_THREADS=ON -DUSE_WASM_THREADS=OFF \
  -DDISABLE_EXTENSION_LOAD=ON -DDISABLE_BUILTIN_HTTPLIB=ON \
  -DENABLE_EXTENSION_AUTOLOADING=OFF -DENABLE_EXTENSION_AUTOINSTALL=OFF \
  -DWASM_LOADABLE_EXTENSIONS=OFF -DENABLE_JEMALLOC=OFF \
  -DENABLE_SANITIZER=OFF -DENABLE_UBSAN=OFF
cmake --build build/duckdb --target \
  duckdb_static core_functions_extension parquet_extension json_extension httpfs_extension \
  --parallel "${NATIVE_JOBS:-2}"
mkdir -p build/generated
python3 vendor/duckdb/scripts/generate_static_extension_loader.py \
  -o build/generated/static_extension_loader.c.tmp core_functions parquet json httpfs
if cmp -s build/generated/static_extension_loader.c.tmp build/generated/static_extension_loader.c; then
  rm build/generated/static_extension_loader.c.tmp
else
  mv build/generated/static_extension_loader.c.tmp build/generated/static_extension_loader.c
fi
