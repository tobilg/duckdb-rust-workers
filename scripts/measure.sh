#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/env.sh"
cd "$PROJECT_ROOT"
python3 scripts/collect-licenses.py
exec python3 scripts/measure.py
