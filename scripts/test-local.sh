#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/env.sh"
cd "$PROJECT_ROOT"
[[ -f build/fixtures/large.parquet && -f build/fixtures/reference.duckdb ]] || python3 scripts/generate-fixtures.py
python3 - <<'PY'
import hashlib, json
from pathlib import Path
for fixture in json.loads(Path('tests/fixtures/manifest.json').read_text())['files']:
    with Path(fixture['path']).open('rb') as f:
        assert hashlib.file_digest(f, 'sha256').hexdigest() == fixture['sha256'], fixture['path']
PY
exec node tests/integration/api.mjs
