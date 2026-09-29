"""Apply declared vendor patches and audit working trees without resetting them."""
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def git(checkout, *args, check=True):
    return subprocess.run(['git', '-C', str(checkout), *args],
                          capture_output=True, check=check)


def apply_patches(lock):
    checkouts = lock['sources'] + [source for source in lock.get('additional_checkouts', [])
                                   if (ROOT / source['path'] / '.git').exists()]
    for source in checkouts:
        checkout = ROOT / source['path']
        revision = source.get('commit') or next(s['commit'] for s in lock['sources']
                                               if s['name'] == source['source'])
        if git(checkout, 'rev-parse', 'HEAD').stdout.decode().strip() != revision:
            raise SystemExit(f"Source revision mismatch: {source['path']}; refusing to apply patches")
        for filename in source.get('patches', []):
            patch = str(ROOT / filename)
            if git(checkout, 'apply', '--reverse', '--check', patch, check=False).returncode:
                git(checkout, 'apply', '--check', patch)
                git(checkout, 'apply', patch)
        for destination, filename in source.get('overlays', {}).items():
            target = checkout / destination
            data = (ROOT / filename).read_bytes()
            if target.exists() and target.read_bytes() != data:
                raise SystemExit(f'{target}: differs from declared overlay {filename}; refusing to overwrite')
            if not target.exists():
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(data)


def verify_checkout(source):
    checkout = ROOT / source['path']
    actual = git(checkout, 'rev-parse', 'HEAD').stdout.decode().strip()
    if actual != source['commit']:
        raise SystemExit(f"Source revision mismatch: {source['path']}")
    patches = [ROOT / name for name in source.get('patches', [])]
    overlays = source.get('overlays', {})
    # Reconstruct only the patched files from the pinned revision in a temporary
    # directory. This neither changes the checkout nor writes its Git index.
    paths = set()
    for patch in patches:
        records = git(checkout, 'apply', '--numstat', '-z', str(patch)).stdout
        paths.update(record.split(b'\t', 2)[2].decode() for record in records.split(b'\0') if record)
    with tempfile.TemporaryDirectory(prefix='duckdb-vendor-audit-') as temporary:
        expected = Path(temporary)
        for name in paths:
            if Path(name).is_absolute() or '..' in Path(name).parts:
                raise SystemExit(f'Invalid patch path: {name}')
            contents = git(checkout, 'show', f"{source['commit']}:{name}", check=False)
            if contents.returncode == 0:
                target = expected / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(contents.stdout)
                mode = git(checkout, 'ls-tree', source['commit'], '--', name).stdout.split()[0]
                target.chmod(int(mode, 8) & 0o777)
        for patch in patches:
            subprocess.run(['git', 'apply', '--no-index', str(patch)], cwd=expected,
                           capture_output=True, check=True)
        for destination, filename in overlays.items():
            target = expected / destination
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes((ROOT / filename).read_bytes())
        paths.update(overlays)
        changed = git(checkout, 'diff', '--name-only', '-z', 'HEAD').stdout
        untracked = git(checkout, 'ls-files', '--others', '--exclude-standard', '-z').stdout
        unexpected = {name.decode() for name in (changed + untracked).split(b'\0') if name} - paths
        drift = []
        for name in sorted(paths):
            want, have = expected / name, checkout / name
            if want.exists() != have.exists():
                drift.append(name)
            elif want.exists() and (want.read_bytes() != have.read_bytes() or
                                    (want.stat().st_mode & 0o111) != (have.stat().st_mode & 0o111)):
                drift.append(name)
        if unexpected or drift:
            names = ', '.join(sorted(unexpected | set(drift)))
            raise SystemExit(f"Unrecorded vendor changes in {source['path']}: {names}. "
                             'Encode changes in a patch declared in toolchain-lock.json; no files were reset.')


def verify_sources(lock, include_build=True):
    for source in lock['sources']:
        verify_checkout(source)
    if include_build:
        for checkout in lock.get('additional_checkouts', []):
            if (ROOT / checkout['path'] / '.git').exists():
                source = next(s for s in lock['sources'] if s['name'] == checkout['source'])
                verify_checkout({'commit': source['commit'], **checkout})
