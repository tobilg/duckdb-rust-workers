#!/usr/bin/env python3
"""Fetch immutable sources and checksum-verified archives; never reset checkouts."""
import hashlib
import json
import platform
import subprocess
from pathlib import Path
from vendor_patches import apply_patches, verify_sources

root = Path(__file__).resolve().parent.parent
lock = json.loads((root / 'toolchain-lock.json').read_text())
if f'{platform.system()}-{platform.machine()}' != lock['host']:
    raise SystemExit('This evaluated toolchain currently pins Darwin arm64 assets only.')

def run(*args, **kwargs):
    return subprocess.run(args, check=True, cwd=root, **kwargs)

for source in lock['sources']:
    path = root / source['path']
    if not (path / '.git').exists():
        if path.exists():
            raise SystemExit(f'{path}: existing non-checkout; refusing to overwrite')
        path.mkdir(parents=True)
        run('git', 'init', str(path))
        run('git', '-C', str(path), 'remote', 'add', 'origin', source['url'])
    head = subprocess.run(['git', '-C', str(path), 'rev-parse', 'HEAD'], capture_output=True, text=True)
    if head.returncode:
        run('git', '-C', str(path), 'fetch', '--depth=1', 'origin', source['commit'])
        run('git', '-C', str(path), 'checkout', '--detach', source['commit'])
    actual = subprocess.check_output(['git', '-C', str(path), 'rev-parse', 'HEAD'], text=True).strip()
    if actual != source['commit']:
        raise SystemExit(f'{path}: revision mismatch; refusing to reset local files')

for archive in lock['archives']:
    path = root / archive['path']
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists():
        temporary = path.with_suffix(path.suffix + '.partial')
        run('curl', '-fL', '--retry', '2', archive['url'], '-o', str(temporary))
        if hashlib.file_digest(temporary.open('rb'), 'sha256').hexdigest() != archive['sha256']:
            raise SystemExit(f'Checksum mismatch: {temporary}')
        temporary.rename(path)
    if hashlib.file_digest(path.open('rb'), 'sha256').hexdigest() != archive['sha256']:
        raise SystemExit(f'Checksum mismatch: {path}')

apply_patches(lock)
verify_sources(lock)
print('Pinned sources and archive checksums verified.')
