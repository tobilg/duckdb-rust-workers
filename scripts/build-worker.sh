#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/env.sh"
cd "$PROJECT_ROOT"
python3 scripts/check-pins.py
./scripts/build-native.sh
export RUSTFLAGS="--cfg=wasm_bindgen_unstable_jspi -Clink-arg=-Oz -Clink-arg=-sJSPI -Clink-arg=-sREENTRANT_JSPI -Clink-arg=-sSTACK_SIZE=1048576 -Clink-arg=-sJSPI_FIBER_STACK_SIZE=1048576 -Clink-arg=-sINITIAL_MEMORY=33554432 -Clink-arg=-sMAXIMUM_MEMORY=100663296"
exec "$PROJECT_ROOT/.tools/bin/worker-build" --emscripten --release "$@" --locked
