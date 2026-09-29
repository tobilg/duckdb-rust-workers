#!/usr/bin/env python3
"""Generate controlled fixtures with a pinned native reference executable."""
import hashlib
import json
import os
import shutil
import subprocess
from pathlib import Path

root = Path(__file__).resolve().parent.parent
os.chdir(root)
executable = os.environ.get('FIXTURE_DUCKDB', str(root / '.tools/fixture-duckdb/duckdb'))
if not executable:
    raise SystemExit('Set FIXTURE_DUCKDB to native DuckDB 1.5.5 (fixture generator only).')
def sql(query):
    return subprocess.check_output([executable, '-init', '/dev/null', '-json', '-c', query], text=True)
version = json.loads(sql('SELECT version() AS version'))[0]['version']
if version != 'v1.5.5':
    raise SystemExit(f'Expected fixture generator v1.5.5, got {version}')
directory = root / 'tests/fixtures'
directory.mkdir(parents=True, exist_ok=True)
large = root / 'build/fixtures/large.parquet'
large.parent.mkdir(parents=True, exist_ok=True)
reference = root / 'build/fixtures/reference.duckdb'
reference.unlink(missing_ok=True)
(directory / 'small.json').write_text('[{"id":1,"category":"a","value":10},{"id":2,"category":"b","value":20},{"id":3,"category":"a","value":30}]\n')
# Filenames are fixed project-owned paths, not caller input.
sql("""
SET threads=1;
SET enable_progress_bar=false;
SET autoinstall_known_extensions=false;
SET autoload_known_extensions=false;
COPY (SELECT i::BIGINT AS id, CASE WHEN i%2=0 THEN 'a' ELSE 'b' END AS category,
  (i*3)::BIGINT AS value FROM range(16384) t(i))
TO 'tests/fixtures/small.parquet' (FORMAT PARQUET, COMPRESSION UNCOMPRESSED, ROW_GROUP_SIZE 2048);
COPY (SELECT i::BIGINT AS id, CASE WHEN i%2=0 THEN 'a' ELSE 'b' END AS category,
  repeat(md5(i::VARCHAR),16) AS payload FROM range(262144) t(i))
TO 'build/fixtures/large.parquet' (FORMAT PARQUET, COMPRESSION UNCOMPRESSED, ROW_GROUP_SIZE 8192);
ATTACH 'build/fixtures/reference.duckdb' AS fixture;
CREATE TABLE fixture.answer AS SELECT 42 AS value;
DETACH fixture;
""")
assert large.stat().st_size > 128 * 1024 * 1024
files = []
for path in [directory / 'small.json', directory / 'small.parquet', large, reference]:
    files.append({'path': str(path.relative_to(root)), 'bytes': path.stat().st_size, 'sha256': hashlib.file_digest(path.open('rb'), 'sha256').hexdigest()})
queries = [
    ("SELECT count(*) AS n, sum(id)::BIGINT AS total FROM read_parquet('tests/fixtures/small.parquet') WHERE id < 1024 AND category='a'", {'n':512,'total':261632}),
    ("SELECT count(*) AS n, sum(id)::BIGINT AS total FROM read_parquet('build/fixtures/large.parquet') WHERE id < 1024 AND category='a'", {'n':512,'total':261632}),
    ("SELECT sum(value)::BIGINT AS total FROM read_json_auto('tests/fixtures/small.json') WHERE category='a'", {'total':40}),
]
for query, expected in queries:
    assert json.loads(sql(query))[0] == expected
manifest = {'generator_version': version, 'generator_sha256': hashlib.file_digest(Path(executable).open('rb'), 'sha256').hexdigest(), 'files': files, 'queries': [{'sql':q,'expected':e} for q,e in queries], 'large_layout': {'rows':262144,'row_group_rows':8192,'columns':['id BIGINT','category VARCHAR','payload VARCHAR (512 bytes)'],'compression':'UNCOMPRESSED'}}
(directory / 'manifest.json').write_text(json.dumps(manifest, indent=2)+'\n')
print(json.dumps(manifest, indent=2))
