#!/usr/bin/env bash
# Source this file; all mutable compiler caches stay in this checkout.
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export RUSTUP_HOME="$PROJECT_ROOT/.tools/rustup"
export RUSTUP_TOOLCHAIN=1.98.0
export CARGO_HOME="$PROJECT_ROOT/.tools/cargo"
export EMSCRIPTEN="$PROJECT_ROOT/.tools/emscripten"
export EMSDK="$PROJECT_ROOT/.tools/emsdk"
export EM_BINARYEN_ROOT="$PROJECT_ROOT/.tools/binaryen-version_132_jspi_hooks_1"
export EM_CACHE="$PROJECT_ROOT/.tools/em-cache"
export EM_CONFIG="$PROJECT_ROOT/.tools/worker-build/emscripten-6.0.10.config"
export WORKER_BUILD_CACHE="$PROJECT_ROOT/.tools/worker-build"
export WASM_BINDGEN_BIN="$PROJECT_ROOT/.tools/bin/wasm-bindgen"
export ESBUILD_BIN="$PROJECT_ROOT/node_modules/.bin/esbuild"
export BINARYEN_CORES=1
export npm_config_cache="$PROJECT_ROOT/.tools/npm-cache"
export WRANGLER_LOG_PATH="$PROJECT_ROOT/artifacts/logs/wrangler"
export WRANGLER_SEND_METRICS=false
export PATH="$PROJECT_ROOT/.tools/bin:$EMSCRIPTEN:$PATH"
