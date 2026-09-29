#!/usr/bin/env python3
import datetime
import gzip
import hashlib
import json
import os
import platform
import re
import subprocess
from pathlib import Path

root = Path(__file__).resolve().parent.parent
os.chdir(root)
def run(*args):
    return subprocess.check_output(args, text=True, stderr=subprocess.STDOUT).strip()
def digest(path):
    return hashlib.file_digest(Path(path).open('rb'), 'sha256').hexdigest()
lock = json.loads(Path('toolchain-lock.json').read_text())
sources = []
for source in lock['sources']:
    actual = run('git', '-C', source['path'], 'rev-parse', 'HEAD')
    assert actual == source['commit'], f"source drift: {source['name']}"
    sources.append({**source, 'resolved_commit': actual})
outputs = []
for path in [Path('build/index.js'), Path('build/index_bg.wasm')]:
    data = path.read_bytes()
    outputs.append({'path':str(path), 'bytes':len(data), 'gzip_bytes':len(gzip.compress(data,mtime=0)), 'sha256':digest(path)})
native = None
if Path('build/duckdb/compile_commands.json').exists():
    commands = json.loads(Path('build/duckdb/compile_commands.json').read_text())
    bad = [x['file'] for x in commands if ' -O3' in x['command'] or '-pthread' in x['command'] or ' -Oz' not in x['command'] or '-DDUCKDB_NO_THREADS' not in x['command']]
    assert not bad, f'native flag audit failed: {bad[:5]}'
    cxx = [x for x in commands if Path(x['file']).suffix in ['.cpp','.cc','.cxx']]
    assert all('-fwasm-exceptions' in x['command'] and '-sWASM_LEGACY_EXCEPTIONS=0' in x['command'] for x in cxx), 'native C++ exception encoding mismatch'
    native = {'compile_commands_sha256':digest('build/duckdb/compile_commands.json'), 'entries':len(commands), 'effective_optimization':'-Oz', 'SMALLER_BINARY':'ON', 'no_threads':True, 'native_lto':False, 'flags_audit':'passed'}
manifest = {
    'generated_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'host':{'system':platform.system(),'architecture':platform.machine(),'release':platform.release()},
    'sources':sources,
    'archives':lock['archives'],
    'patches':[{'path':str(p),'sha256':digest(p)} for p in sorted(
        set(Path('patches').glob('*.patch')) |
        {Path(p) for checkout in lock.get('additional_checkouts', []) for p in checkout.get('patches', [])})],
    'tools':{
        'rustc':run('rustc','-Vv'), 'cargo':run('cargo','-V'), 'node':run('node','--version'),
        'emscripten':run('emcc','--version'), 'llvm':run('.tools/emsdk/upstream/bin/clang','--version'),
        'binaryen':run('.tools/binaryen-version_132_jspi_hooks_1/bin/wasm-opt','--version'),
        'wasm_bindgen':run('.tools/bin/wasm-bindgen','--version'),
        'worker_build':run('.tools/bin/worker-build','--version'),
        'wrangler':json.loads(Path('node_modules/wrangler/package.json').read_text())['version'],
        'workerd':json.loads(Path('node_modules/workerd/package.json').read_text())['version'],
        'cmake':run('cmake','--version').splitlines()[0], 'ninja':run('ninja','--version'),
    },
    'tool_binary_sha256': {name:digest(path) for name,path in {
        'rustc':run('rustup','which','rustc'),
        'node':run('node','-p','process.execPath'),
        'worker_build':'.tools/bin/worker-build',
        'wasm_bindgen':'.tools/bin/wasm-bindgen',
        'wasm_opt':'.tools/binaryen-version_132_jspi_hooks_1/bin/wasm-opt',
        'workerd':f'node_modules/@cloudflare/workerd-darwin-arm64/bin/workerd',
    }.items()},
    'effective_emscripten':{k:run('em-config',k) for k in ['LLVM_ROOT','BINARYEN_ROOT','NODE_JS','CACHE']},
    'generated_em_config':Path(os.environ['EM_CONFIG']).read_text(),
    'rust_profile':{'opt_level':'z','lto':'thin','panic':'abort','codegen_units':1},
    'link_flags':Path('scripts/build-worker.sh').read_text().split('export RUSTFLAGS=',1)[1].splitlines()[0],
    'native':native,
    'required_extensions':['core_functions','parquet','json','httpfs'],
    'compatibility_date':'2026-09-26','compatibility_flags':['new_module_registry'],
    'outputs':outputs,
    'native_archives': [{'path':str(p),'bytes':p.stat().st_size,'sha256':digest(p)} for p in
        [Path('build/duckdb/src/libduckdb_static.a')] +
        [Path(f'build/duckdb/extension/{ext}/lib{ext}_extension.a') for ext in ['core_functions','parquet','json','httpfs']]
        if p.exists()],
    'generated_static_loader_sha256':digest('build/generated/static_extension_loader.c'),
    'lockfiles': {str(p):digest(p) for p in [Path('Cargo.lock'),Path('package-lock.json'),Path('toolchain-lock.json')]},
    'raw_module_bytes':sum(p['bytes'] for p in outputs),
    'total_isolate_memory_bytes':None,
    'deployed_cpu_ms':None,
    'deployment':'not attempted',
    's3':'not attempted; no evaluation credentials configured',
}
package = Path('artifacts/wrangler')
if (package / 'index.js').exists():
    bundled_js = (package / 'index.js').read_text()
    referenced_wasm = [p for p in package.glob('*.wasm') if p.name in bundled_js]
    assert len(referenced_wasm) == 1, 'package must reference exactly one Wasm module'
    paths = [package / 'index.js', *referenced_wasm]
    manifest['packaging'] = {
        'kind':'Wrangler dry run; no upload',
        'files':[{'path':str(p),'bytes':p.stat().st_size,'sha256':digest(p)} for p in paths],
        'module_payload_bytes':sum(p.stat().st_size for p in paths),
    }
    packaged_wasm = referenced_wasm[0]
    assert digest(packaged_wasm) == digest('build/index_bg.wasm'), 'dry run contains stale Wasm'
    text = Path('artifacts/logs/packaging.txt').read_text()
    upload = re.search(r'Total Upload: ([0-9.]+) KiB / gzip: ([0-9.]+) KiB',text)
    if upload:
        manifest['packaging']['wrangler_reported_kib'] = float(upload[1])
        manifest['packaging']['wrangler_reported_gzip_kib'] = float(upload[2])
path = Path('artifacts/api-results.json')
result = json.loads(path.read_text())
assert result['status'] == 'passed', 'API validation must pass before measurement'
assert result['wasm_sha256'] == digest('build/index_bg.wasm'), 'stale API test results'
manifest['api_validation'] = {'path': str(path), 'sha256': digest(path), 'status': result['status']}
if Path('artifacts/startup.cpuprofile').exists():
    manifest['local_startup_profile']={'path':'artifacts/startup.cpuprofile','sha256':digest('artifacts/startup.cpuprofile')}
Path('artifacts/build-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
print(json.dumps({'outputs':outputs,'raw_module_bytes':manifest['raw_module_bytes']},indent=2))
