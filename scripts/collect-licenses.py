#!/usr/bin/env python3
"""Collect native and Cargo dependency notices alongside the release package."""
import shutil
from pathlib import Path

root = Path(__file__).resolve().parent.parent
out = root / 'artifacts/licenses'
bases = ['vendor/duckdb', 'vendor/httpfs', 'vendor/workers-rs',
         '.tools/emscripten/system/lib', '.tools/cargo/registry/src']
count = 0
for base in bases:
    source = root / base
    for path in source.rglob('*'):
        if not path.is_file() or '.git' in path.parts:
            continue
        if not path.name.upper().startswith(('LICENSE', 'COPYING', 'NOTICE')):
            continue
        # Skip unrelated test/benchmark fixtures; preserve vendored dependency notices.
        if 'test' in path.relative_to(source).parts or 'tests' in path.relative_to(source).parts:
            continue
        target = out / base.lstrip('.') / path.relative_to(source)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path, target)
        count += 1
for name in ['LICENSE', 'AUTHORS']:
    source = root / '.tools/emscripten' / name
    if source.exists():
        target = out / 'emscripten' / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
print(f'Collected {count} dependency notice files in {out.relative_to(root)}')
