#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/env.sh"
cd "$PROJECT_ROOT"
if [[ ! -f artifacts/build-manifest.json ]]; then
  printf '%s\n' \
    'Missing artifacts/build-manifest.json; no recorded build is available to verify.' \
    'Run ./scripts/validate.sh to build, test, package and generate the local manifest.' >&2
  exit 1
fi
python3 scripts/check-pins.py
python3 - <<'PY'
import hashlib, json, subprocess
from pathlib import Path
m=json.loads(Path('artifacts/build-manifest.json').read_text())
records=m['outputs'] + m.get('packaging',{}).get('files',[]) + m['patches'] + m['native_archives']
records += [m[kind] for kind in ['api_validation','local_startup_profile'] if kind in m]
missing=sorted({record['path'] for record in records if not Path(record['path']).is_file()} |
               {filename for filename in m['lockfiles'] if not Path(filename).is_file()})
if missing:
    raise SystemExit('Missing files required by the recorded manifest:\n  ' + '\n  '.join(missing) +
                     '\nRun ./scripts/validate.sh to regenerate local validation evidence.')
for output in m['outputs'] + m.get('packaging',{}).get('files',[]):
    p=Path(output['path'])
    assert hashlib.sha256(p.read_bytes()).hexdigest() == output['sha256'], str(p)
for kind in ['api_validation','local_startup_profile']:
    if kind in m:
        result=m[kind]
        assert hashlib.file_digest(Path(result['path']).open('rb'),'sha256').hexdigest() == result['sha256']
        assert result.get('status','passed') == 'passed'
for source in m['sources']:
    actual=subprocess.check_output(['git','-C',source['path'],'rev-parse','HEAD'],text=True).strip()
    assert actual == source['commit'], source['name']
js=Path('build/index.js').read_text()
assert 'WebAssembly.promising' in js and 'WebAssembly.Suspending' in js
assert b'\x00asm' == Path('build/index_bg.wasm').read_bytes()[:4]
for patch in m['patches']:
    assert hashlib.sha256(Path(patch['path']).read_bytes()).hexdigest() == patch['sha256']
for filename, expected in m['lockfiles'].items():
    assert hashlib.sha256(Path(filename).read_bytes()).hexdigest() == expected
for archive in m['native_archives']:
    path=Path(archive['path'])
    assert hashlib.file_digest(path.open('rb'), 'sha256').hexdigest() == archive['sha256']
    with path.open('rb') as f:
        assert f.read(8) == b'!<arch>\n'
        while header := f.read(60):
            size=int(header[48:58]); name=header[:16].decode().strip()
            data=f.read(size)
            if size % 2: f.read(1)
            if name in ['/', '//', '/SYM64/']: continue
            if name.startswith('#1/'): data=data[int(name[3:]):]
            assert data[:4] == b'\x00asm', f'Non-Wasm native archive member: {path}/{name}'
print('Artifact hashes, source pins, patches and JSPI wrappers verified.')
PY
