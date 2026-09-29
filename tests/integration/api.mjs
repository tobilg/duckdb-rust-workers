import assert from 'node:assert/strict';
import { availablePort } from './port.mjs';
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, createWriteStream } from 'node:fs';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { startFixtures } from '../fixtures/server.mjs';

const port=await availablePort();
const base=`http://127.0.0.1:${port}`;
const unrestrictedPort=await availablePort();
const unrestrictedBase=`http://127.0.0.1:${unrestrictedPort}`;
const invalidOriginPort=await availablePort();
const invalidOriginBase=`http://127.0.0.1:${invalidOriginPort}`;
const blockPort=await availablePort();
const blockBase=`http://127.0.0.1:${blockPort}`;
const transferWorkers=[];
for(const [name,value,kind='text'] of [['low','1'],['high','128'],['wide','4096'],
 ['zero','0'],['negative','-1'],['fraction','1.5'],['overflow','4294967296'],['invalid','invalid'],['object','{}','json']]) {
 const port=await availablePort();
 transferWorkers.push({name:`transfer-${name}`,value,kind,port,base:`http://127.0.0.1:${port}`});
}
const transferBase=name=>transferWorkers.find(w=>w.name===`transfer-${name}`).base;
const root=resolve(import.meta.dirname,'../..'); process.chdir(root);
mkdirSync('artifacts/logs',{recursive:true});
const dir=resolve('build/api-runtime'); mkdirSync(dir,{recursive:true});
writeFileSync(`${dir}/openssl.cnf`, '[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=localhost\n[ext]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\n');
execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','2','-config',`${dir}/openssl.cnf`,'-keyout',`${dir}/key.pem`,'-out',`${dir}/cert.pem`],{stdio:'ignore'});
const fixtureOptions={root,key:readFileSync(`${dir}/key.pem`),cert:readFileSync(`${dir}/cert.pem`)};
const secondFixture=await startFixtures(fixtureOptions);
const fixture=await startFixtures({...fixtureOptions,redirectOrigin:secondFixture.origin});
const workerService=(name,bindings)=>`(name="${name}", worker=(
 modules=[(name="index.js",esModule=embed "../index.js"),(name="index_bg.wasm",wasm=embed "../index_bg.wasm")],
 compatibilityDate="2026-09-26",compatibilityFlags=["new_module_registry"],
 bindings=[(name="API_KEY",text="local-test-token")${bindings}]
))`;
writeFileSync(`${dir}/workerd.capnp`, `using Workerd = import "../../node_modules/workerd/workerd.capnp";
const config :Workerd.Config = (
 services = [
  ${workerService('evaluation',`,(name="ALLOWED_ORIGIN",text="${fixture.origin}"),(name="ALLOWED_PATH_PREFIX",text="/data/")`)},
  ${workerService('unrestricted','')},
  ${workerService('invalid-origin',',(name="ALLOWED_ORIGIN",text="not-an-origin")')},
  ${workerService('blocks',',(name="RANGE_CACHE_BLOCK_BYTES",text="65536")')},
  ${transferWorkers.map(w=>workerService(w.name,`,(name="QUERY_TRANSFER_LIMIT_MIB",${w.kind}="${w.value}")`)).join(',\n')},
  (name="internet",network=(allow=["local"],tlsOptions=(trustedCertificates=[embed "cert.pem"])))
 ],sockets=[
  (name="http",address="127.0.0.1:${port}",http=(),service="evaluation"),
  (name="unrestricted-http",address="127.0.0.1:${unrestrictedPort}",http=(),service="unrestricted"),
  (name="invalid-origin-http",address="127.0.0.1:${invalidOriginPort}",http=(),service="invalid-origin"),
  (name="blocks-http",address="127.0.0.1:${blockPort}",http=(),service="blocks"),
  ${transferWorkers.map(w=>`(name="${w.name}-http",address="127.0.0.1:${w.port}",http=(),service="${w.name}")`).join(',\n')}
 ]
);
`);
const log=createWriteStream('artifacts/logs/api-workerd.txt');
const start=performance.now();
const executable=`node_modules/@cloudflare/workerd-${process.platform}-${process.arch}/bin/workerd`;
const runtime=spawn(executable,['serve','--experimental',`${dir}/workerd.capnp`],{stdio:['ignore','pipe','pipe']});
const closed=once(runtime,'close'); runtime.stdout.pipe(log,{end:false});runtime.stderr.pipe(log,{end:false});
const report={wasm_sha256:createHash('sha256').update(readFileSync('build/index_bg.wasm')).digest('hex'),tests:[],requests:fixture.requests,secondary_requests:secondFixture.requests};
const health=async()=> (await fetch(`${base}/healthz`)).json();
const queryAt=async(endpoint,sql,params=[],options={})=>{
 const response=await fetch(`${endpoint}/v1/query`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer local-test-token'},body:JSON.stringify({sql,params,...options})});
 return {status:response.status,body:await response.json()};
};
const query=(...args)=>queryAt(base,...args);
const unrestrictedQuery=(...args)=>queryAt(unrestrictedBase,...args);
async function check(name,fn) {
 const before=performance.now();
 try {await fn();report.tests.push({name,status:'passed',wall_ms:performance.now()-before});}
 catch(error) {report.tests.push({name,status:'failed',error:String(error.stack)});throw error;}
}
try {
 let ready;
 for(let i=0;i<200;++i){if(runtime.exitCode!==null)throw Error('workerd failed to start');try{ready=await health();break;}catch{} await new Promise(r=>setTimeout(r,50));}
 assert(ready);report.local_process_start_to_health_ms=performance.now()-start;
 await check('authentication and input limits',async()=>{
  for(const token of ['', 'Bearer wrong']) {
   const r=await fetch(`${base}/v1/query`,{method:'POST',headers:{Authorization:token},body:'{}'});
   assert.equal(r.status,403);
  }
  assert.equal((await query('x'.repeat(65536))).status,400);
  for(const max_rows of [0,-1,1.5,'3',10001]) {
   assert.equal((await query('SELECT 1',[],{max_rows})).status,400);
  }
  assert.equal((await query('SELECT ?',[[1]])).status,400);
 });
 await check('local SQL',async()=>{const r=await query('SELECT 42 AS answer');assert.equal(r.status,200,JSON.stringify(r));assert.deepEqual(r.body.rows,[[42]]);});
 await check('unset origin allows local SQL and multiple HTTPS origins',async()=>{
  const local=await unrestrictedQuery('SELECT 42');
  assert.equal(local.status,200,JSON.stringify(local));assert.deepEqual(local.body.rows,[[42]]);
  for(const source of [fixture,secondFixture]) {
   const r=await unrestrictedQuery('SELECT sum(value)::BIGINT FROM read_json_auto(?) WHERE category=?',[`${source.origin}/data/small.json`,'a']);
   assert.equal(r.status,200,JSON.stringify(r));assert.deepEqual(r.body.rows,[[40]]);
   assert(source.requests.some(x=>x.path==='/data/small.json'&&x.method==='GET'&&x.bytes>0));
  }
 });
 await check('unset origin retains authentication and HTTPS requirements',async()=>{
  const unauthenticated=await fetch(`${unrestrictedBase}/v1/query`,{method:'POST',body:'{"sql":"SELECT 42"}'});
  assert.equal(unauthenticated.status,403);
  const before=fixture.requests.length+secondFixture.requests.length;
  assert.equal((await unrestrictedQuery('SELECT * FROM read_json_auto(?)',[fixture.origin.replace('https:','http:')+'/data/small.json'])).status,502);
  assert.equal(fixture.requests.length+secondFixture.requests.length,before);
 });
 await check('unset path prefix allows all paths and configured prefixes restrict reads',async()=>{
  const url=`${fixture.origin}/outside/small.json`;
  const r=await unrestrictedQuery('SELECT sum(value)::BIGINT FROM read_json_auto(?) WHERE category=?',[url,'a']);
  assert.equal(r.status,200,JSON.stringify(r));assert.deepEqual(r.body.rows,[[40]]);
  const before=fixture.requests.length;
  assert.equal((await query('SELECT * FROM read_json_auto(?)',[url])).status,502);
  assert.equal(fixture.requests.length,before);
 });
 await check('malformed configured origin remains an error',async()=>{
  assert.equal((await queryAt(invalidOriginBase,'SELECT 42')).status,500);
 });
 await check('invalid transfer settings fail before network I/O',async()=>{
  const mark=fixture.requests.length;
  for(const name of ['zero','negative','fraction','overflow','invalid','object']) {
   const r=await queryAt(transferBase(name),'SELECT * FROM read_json_auto(?)',[`${fixture.origin}/data/small.json`]);
   assert.equal(r.status,500,JSON.stringify(r));
  }
  assert.equal(fixture.requests.length,mark);
 });
 await check('four static extensions and local functions',async()=>{
  const r=await query("SELECT extension_name FROM duckdb_extensions() WHERE loaded AND extension_name IN ('core_functions','parquet','json','httpfs') ORDER BY extension_name");
  assert.equal(r.status,200,JSON.stringify(r));assert.deepEqual(r.body.rows,[['core_functions'],['httpfs'],['json'],['parquet']]);
  const functions=await query("SELECT sum(i)::BIGINT, json_extract('{\"answer\":42}', '$.answer')::BIGINT FROM range(10) t(i)");
  assert.equal(functions.status,200,JSON.stringify(functions));assert.deepEqual(functions.body.rows,[[45,42]]);
 });
 await check('read-only ATTACH request',async()=>{
  const r=await query(`ATTACH '${fixture.origin}/data/reference.duckdb' AS auxiliary`);
  assert.equal(r.status,200,JSON.stringify(r));
  assert.equal((await query('SELECT * FROM auxiliary.information_schema.tables')).status,400);
 });
 await check('typed bounded rows and duplicate names',async()=>{
  const r=await query("SELECT NULL AS x, true AS x, 9007199254740993::BIGINT AS n, 123.45::DECIMAL(10,2) AS d, DATE '2026-09-29' AS day, TIMESTAMP '2026-09-29 12:34:56' AS ts, 'NaN'::DOUBLE AS nan");
  assert.equal(r.status,200,JSON.stringify(r));assert.deepEqual(r.body.rows[0],[null,true,'9007199254740993','123.45','2026-09-29','2026-09-29 12:34:56','NaN']);assert.equal(r.body.columns[0].name,r.body.columns[1].name);
 });
 await check('prepared scalar parameters',async()=>{const r=await query('SELECT ?::BIGINT + ?::BIGINT, ?::VARCHAR',[2,3,"a'b"]);assert.equal(r.status,200,JSON.stringify(r));assert.deepEqual(r.body.rows,[[5,"a'b"]]);});
 await check('window specializations and numeric/text sorts produce reference answers',async()=>{
  for(const [sql,expected] of [
   ['SELECT sum(q)::DOUBLE FROM (SELECT median(i) OVER (ORDER BY i ROWS BETWEEN 500 PRECEDING AND 500 FOLLOWING) q FROM range(200000) r(i))',[[19999900000]]],
   ['SELECT sum(q)::DOUBLE FROM (SELECT mad(i) OVER (ORDER BY i ROWS BETWEEN 500 PRECEDING AND 500 FOLLOWING) q FROM range(50000) r(i))',[[12437625]]],
   ['SELECT sum(i)::BIGINT, first(i), last(i) FROM (SELECT i FROM range(500000) r(i) ORDER BY (i*7919)%500000)',[[124999750000,0,482321]]],
   ["SELECT sum(i)::BIGINT, first(i), last(i) FROM (SELECT i FROM range(100000) r(i) ORDER BY md5(i::VARCHAR))",[[4999950000,5329,40691]]],
  ]) {
   const r=await query(sql);assert.equal(r.status,200,JSON.stringify(r));assert.deepEqual(r.body.rows,expected);
  }
 });
 await check('statement and unsupported type policy',async()=>{
  for(const sql of ['SELECT 1; SELECT 2','CREATE TABLE x(i INT)',"INSTALL httpfs","LOAD httpfs","SET threads=2",'SELECT [1,2]']) assert.equal((await query(sql)).status,400,sql);
 });
 await check('row limit streams a huge result',async()=>{const r=await query('SELECT i FROM range(1000000000) t(i)',[],{max_rows:3});assert.equal(r.status,200,JSON.stringify(r));assert.deepEqual(r.body.rows,[[0],[1],[2]]);assert.equal(r.body.truncated,true);});
 await check('omitted or null max_rows returns all rows',async()=>{
  const expected=Array.from({length:12000},(_,i)=>[i]);
  for(const options of [{},{max_rows:null}]) {
   const r=await query('SELECT i FROM range(12000) t(i)',[],options);
   assert.equal(r.status,200,JSON.stringify(r));assert.deepEqual(r.body.rows,expected);
   assert.equal(r.body.truncated,false);
  }
 });
 await check('explicit row caps only mark results truncated when rows are omitted',async()=>{
  for(const [count,max_rows] of [[0,1],[1,1],[2,1],[3,3],[4,3],[10000,10000],[10001,10000]]) {
   const r=await query('SELECT i FROM range(?) t(i)',[count],{max_rows});
   assert.equal(r.status,200,JSON.stringify(r));
   assert.deepEqual(r.body.rows,Array.from({length:Math.min(count,max_rows)},(_,i)=>[i]));
   assert.equal(r.body.truncated,count>max_rows);
  }
  const empty=await query('SELECT i FROM range(0) t(i)');
  assert.equal(empty.status,200,JSON.stringify(empty));assert.deepEqual(empty.body.rows,[]);
  assert.equal(empty.body.truncated,false);
 });
 await check('byte limit stops uncapped results and recovers',async()=>{
  for(const sql of ["SELECT repeat('x',600000) FROM range(2)",'SELECT i FROM range(1000000000) t(i)']) {
   const r=await query(sql);
   assert.equal(r.status,413,JSON.stringify(r));assert.equal(r.body.error.category,'output_limit');
   assert.equal(r.body.rows,undefined);
   const state=await health();assert.equal(state.busy,false);assert.equal(state.fatal,false);
   const recovered=await query('SELECT 42');
   assert.equal(recovered.status,200,JSON.stringify(recovered));assert.deepEqual(recovered.body.rows,[[42]]);
   assert.equal(recovered.body.truncated,false);
  }
 });
 await check('remote JSON',async()=>{const r=await query('SELECT sum(value)::BIGINT FROM read_json_auto(?) WHERE category=?',[`${fixture.origin}/data/small.json`,'a']);assert.equal(r.status,200,JSON.stringify(r));assert.deepEqual(r.body.rows,[[40]]);report.json=r.body.metrics;});
 await check('JSPI resumes a successful delayed fetch while the same module progresses',async()=>{
  const mark=fixture.requests.length;
  const pending=query('SELECT sum(value)::BIGINT FROM read_json_auto(?) WHERE category=?',[`${fixture.origin}/data/delay/small.json`,'a']);
  for(let i=0;i<100&&fixture.requests.length===mark;++i)await new Promise(r=>setTimeout(r,10));
  assert(fixture.requests.length>mark,'native query must reach the real HTTPS server');
  assert.equal(fixture.requests[mark].end_ms,undefined,'fixture must still be delayed');
  assert.equal((await health()).busy,true);
  assert.equal((await query('SELECT 42')).status,429);
  const r=await pending;
  assert.equal(r.status,200,JSON.stringify(r));assert.deepEqual(r.body.rows,[[40]]);
  assert(fixture.requests.slice(mark).some(x=>x.method==='GET'&&x.bytes>0));
  assert.equal((await health()).busy,false);
  report.delayed_json=r.body.metrics;
 });
 await check('native exceptions before and after suspension recover',async()=>{
  const before=fixture.requests.length;
  assert.equal((await query("SELECT error('controlled native error')")).status,400);
  assert.equal(fixture.requests.length,before);
  assert.equal((await query('SELECT 42')).status,200);
  const r=await query('SELECT error(category) FROM read_json_auto(?) LIMIT 1',[`${fixture.origin}/data/delay/small.json`]);
  assert.equal(r.status,400,JSON.stringify(r));
  assert(fixture.requests.slice(before).some(x=>x.method==='GET'&&x.bytes>0),'error must follow a real suspended fetch');
  assert.equal((await health()).fatal,false);
  assert.equal((await query('SELECT 42')).status,200);
 });
 const parquetSQL='SELECT count(*) AS n, sum(id)::BIGINT AS total FROM read_parquet(?) WHERE id < 1024 AND category=?';
 await check('remote Parquet ranges',async()=>{const mark=fixture.requests.length;const r=await query(parquetSQL,[`${fixture.origin}/data/small.parquet`,'a']);assert.equal(r.status,200,JSON.stringify(r));assert.deepEqual(r.body.rows,[[512,261632]]);assert(fixture.requests.slice(mark).some(x=>x.range));report.small_parquet=r.body.metrics;});
 const payloadSQL='SELECT sum(length(payload))::BIGINT FROM read_parquet(?) WHERE id < ?';
 const transferURL=`${fixture.origin}/data/transfer/large.parquet`;
 await check('default transfer budget permits over 32 MiB and rejects over 64 MiB',async()=>{
  const within=await query(payloadSQL,[transferURL,81920]);
  assert.equal(within.status,200,JSON.stringify(within));assert.deepEqual(within.body.rows,[[81920*512]]);
  assert(within.body.metrics.fetch_bytes>32*1024*1024&&within.body.metrics.fetch_bytes<=64*1024*1024,JSON.stringify(within));
  const over=await query(payloadSQL,[transferURL,147456]);
  assert.equal(over.status,502,JSON.stringify(over));assert.equal(over.body.error.diagnostic.reason,'query_transfer_limit');
  assert(over.body.metrics.fetch_bytes>56*1024*1024&&over.body.metrics.fetch_bytes<=64*1024*1024,JSON.stringify(over));
  const again=await query(payloadSQL,[transferURL,81920]);
  assert.equal(again.status,200,JSON.stringify(again));assert.deepEqual(again.body.rows,within.body.rows);
  assert.equal(again.body.metrics.fetch_bytes,within.body.metrics.fetch_bytes);
  report.transfer_limits={default_mib:64,within:within.body.metrics,rejected:over.body.metrics};
 });
 await check('configured transfer budget permits over 64 MiB and uses 64-bit bytes',async()=>{
  const raised=await queryAt(transferBase('high'),payloadSQL,[transferURL,147456]);
  assert.equal(raised.status,200,JSON.stringify(raised));assert.deepEqual(raised.body.rows,[[147456*512]]);
  assert(raised.body.metrics.fetch_bytes>64*1024*1024&&raised.body.metrics.fetch_bytes<=128*1024*1024,JSON.stringify(raised));
  const wide=await queryAt(transferBase('wide'),parquetSQL,[transferURL,'a']);
  assert.equal(wide.status,200,JSON.stringify(wide));assert.deepEqual(wide.body.rows,[[512,261632]]);
  report.transfer_limits.raised={limit_mib:128,...raised.body.metrics};
 });
 await check('lower transfer budgets bound ranges and cumulative full snapshots',async()=>{
  const low=(...args)=>queryAt(transferBase('low'),...args);
  for(const path of ['normal','no-length']) {
   const r=await low(payloadSQL,[`${fixture.origin}/data/transfer/${path}/large.parquet`,8192]);
   assert.equal(r.status,502,JSON.stringify(r));assert.equal(r.body.error.diagnostic.reason,'query_transfer_limit');
   assert(r.body.metrics.fetch_bytes<2*1024*1024,JSON.stringify(r));
  }
  const urls=Array.from({length:5},(_,i)=>`${fixture.origin}/data/weak-etag/transfer-${i}/small.parquet`);
  const sql='SELECT sum(n)::BIGINT FROM ('+urls.map(()=> 'SELECT count(*) n FROM read_parquet(?)').join(' UNION ALL ')+')';
  const full=await low(sql,urls);
  assert.equal(full.status,502,JSON.stringify(full));assert.equal(full.body.error.diagnostic.reason,'query_transfer_limit');
  assert(full.body.metrics.fetch_bytes>0&&full.body.metrics.fetch_bytes<=1024*1024,JSON.stringify(full));
  const recovered=await low(parquetSQL,[`${fixture.origin}/data/small.parquet`,'a']);
  assert.equal(recovered.status,200,JSON.stringify(recovered));assert.deepEqual(recovered.body.rows,[[512,261632]]);
 });
 await check('identity encoding selects strong validators for Parquet ranges',async()=>{
  const mark=fixture.requests.length;
  const r=await query(parquetSQL,[`${fixture.origin}/data/negotiate-encoding/small.parquet`,'a']);
  assert.equal(r.status,200,JSON.stringify(r));assert.deepEqual(r.body.rows,[[512,261632]]);
  const requests=fixture.requests.slice(mark);
  assert(requests.some(x=>x.method==='HEAD'));
  assert(requests.some(x=>x.method==='GET'&&x.range&&x.bytes>0));
  assert(requests.every(x=>x.accept_encoding==='identity'));
 });
 await check('weak and missing ETags use one full snapshot per query',async()=>{
  report.full_snapshots={};
  for(const mode of ['weak-etag/changing-after-download','no-etag']){
   for(let repeat=0;repeat<2;++repeat){
    const mark=fixture.requests.length;
    const r=await query(parquetSQL,[`${fixture.origin}/data/${mode}/small.parquet`,'a']);
    assert.equal(r.status,200,JSON.stringify(r));assert.deepEqual(r.body.rows,[[512,261632]]);
    const requests=fixture.requests.slice(mark);
    const gets=requests.filter(x=>x.method==='GET');
    assert.equal(gets.length,1,JSON.stringify(requests));assert.equal(gets[0].range,null);
    assert.equal(gets[0].bytes,269630);
    assert.equal(r.body.metrics.fetch_bytes,269630);
    report.full_snapshots[mode]=r.body.metrics;
   }
  }
  const r=await query('SELECT sum(value)::BIGINT FROM read_json_auto(?) WHERE category=?',[`${fixture.origin}/data/weak-etag/small.json`,'a']);
  assert.equal(r.status,200,JSON.stringify(r));assert.deepEqual(r.body.rows,[[40]]);
 });
 await check('full snapshots enforce size, streaming and cumulative budgets',async()=>{
  for(const mode of ['weak-etag','no-etag']){
   const mark=fixture.requests.length;
   const r=await query(parquetSQL,[`${fixture.origin}/data/${mode}/large.parquet`,'a']);
   assert.equal(r.status,502);assert.equal(r.body.error.diagnostic.reason,'full_download_limit');
   assert(fixture.requests.slice(mark).every(x=>x.method==='HEAD'));
   assert.equal(r.body.metrics.fetch_bytes,0);
  }
  const chunked=await query(parquetSQL,[`${fixture.origin}/data/weak-etag/head-no-length/no-length/large.parquet`,'a']);
  assert.equal(chunked.status,502,JSON.stringify(chunked));assert.equal(chunked.body.error.diagnostic.reason,'full_download_limit');
  assert(chunked.body.metrics.fetch_bytes>=4*1024*1024&&chunked.body.metrics.fetch_bytes<5*1024*1024);
  const sql='SELECT sum(n)::BIGINT FROM ('+Array.from({length:16},()=> 'SELECT count(*) AS n FROM read_parquet(?)').join(' UNION ALL ')+')';
  const urls=Array.from({length:16},(_,i)=>`${fixture.origin}/data/weak-etag/file-${i}/small.parquet`);
  const cumulative=await query(sql,urls);
  assert.equal(cumulative.status,502,JSON.stringify(cumulative));assert.equal(cumulative.body.error.diagnostic.reason,'full_download_limit');
  assert(cumulative.body.metrics.fetch_bytes>3*1024*1024&&cumulative.body.metrics.fetch_bytes<=4*1024*1024);
  assert.equal((await query('SELECT 42')).status,200);
 });
 await check('literal and repeated URLs retain one snapshot through prepare and execute',async()=>{
  for(const mode of ['weak-etag','no-etag']) {
   const url=`${fixture.origin}/data/${mode}/literal/small.parquet`;
   for(let repeat=0;repeat<2;repeat++) {
    const mark=fixture.requests.length;
    const r=await query(`SELECT sum(n)::BIGINT FROM (SELECT count(*) n FROM '${url}' UNION ALL SELECT count(*) n FROM '${url}')`);
    assert.equal(r.status,200,JSON.stringify(r));assert.deepEqual(r.body.rows,[[32768]]);
    const requests=fixture.requests.slice(mark);
    assert.equal(requests.filter(x=>x.method==='HEAD').length,1,JSON.stringify(requests));
    assert.equal(requests.filter(x=>x.method==='GET').length,1,JSON.stringify(requests));
    assert.equal(r.body.metrics.fetch_bytes,269630);
   }
  }
 });
 await check('range cache reuses footer bytes and remains bounded during eviction',async()=>{
  const url=`${fixture.origin}/data/cache/large.parquet`;
  const r=await query(parquetSQL,[url,'a']);
  assert.equal(r.status,200,JSON.stringify(r));assert.deepEqual(r.body.rows,[[512,261632]]);
  assert(r.body.metrics.cache_hits>=30,JSON.stringify(r));
  assert(r.body.metrics.fetch_count<=5,JSON.stringify(r));
  assert(r.body.metrics.fetch_bytes<400000,JSON.stringify(r));
  assert(r.body.metrics.staging_peak_bytes<=262144,JSON.stringify(r));
  const urls=Array.from({length:18},(_,i)=>`${fixture.origin}/data/cache/evict-${i}/large.parquet`);
  urls.push(urls[0]);
  const sql='SELECT sum(n)::BIGINT FROM ('+urls.map(()=>"SELECT sum(id)::BIGINT n FROM read_parquet(?) WHERE id<1024 AND category='a'").join(' UNION ALL ')+')';
  const evicted=await query(sql,urls);
  assert.equal(evicted.status,200,JSON.stringify(evicted));assert.deepEqual(evicted.body.rows,[[261632*urls.length]]);
  assert(evicted.body.metrics.cache_peak_bytes>3.5*1024*1024,JSON.stringify(evicted));
  assert(evicted.body.metrics.cache_peak_bytes<=4*1024*1024,JSON.stringify(evicted));
  assert(evicted.body.metrics.fetch_bytes<32*1024*1024);
  report.range_cache={single:r.body.metrics,eviction:evicted.body.metrics};
 });
 await check('error cleanup discards range and full caches before the next request',async()=>{
  for(const mode of ['normal','weak-etag']) {
   const url=`${fixture.origin}/data/${mode}/cleanup/small.parquet`;
   const r=await query(`SELECT CASE WHEN count(*)>0 THEN error('after fetch') END FROM '${url}'`);
   assert.equal(r.status,400,JSON.stringify(r));
   const mark=fixture.requests.length;
   const recovered=await query(parquetSQL,[url,'a']);
   assert.equal(recovered.status,200,JSON.stringify(recovered));
   assert(fixture.requests.slice(mark).some(x=>x.method==='GET'&&x.bytes>0));
  }
 });
 await check('optional aligned cache never widens signed query-string ranges',async()=>{
  for(const signed of [false,true]) {
   const mark=fixture.requests.length;
   const url=`${fixture.origin}/data/block-cache/small.parquet${signed?'?X-Amz-Signature=test-marker':''}`;
   const r=await queryAt(blockBase,parquetSQL,[url,'a']);
   assert.equal(r.status,200,JSON.stringify(r));assert.deepEqual(r.body.rows,[[512,261632]]);
   const ranges=fixture.requests.slice(mark).filter(x=>x.range);
   assert(ranges.length>0);
   const firstStart=Number(/^bytes=(\d+)-/.exec(ranges[0].range)[1]);
   assert.equal(signed?firstStart:firstStart%65536,signed?269630-16384:0,JSON.stringify(ranges));
   assert(r.body.metrics.cache_peak_bytes<=4*1024*1024);
  }
 });
 await check('Parquet coalescing trades bounded gap bytes for fewer requests',async()=>{
  const r=await query('SELECT sum(a+b+c+d)::BIGINT FROM read_parquet(?)',[`${fixture.origin}/data/coalescing.parquet`]);
  assert.equal(r.status,200,JSON.stringify(r));assert.deepEqual(r.body.rows,[[1342095360]]);
  assert.equal(r.body.metrics.fetch_count,27,JSON.stringify(r));
  assert.equal(r.body.metrics.fetch_bytes,886540,JSON.stringify(r));
  report.coalescing=r.body.metrics;
 });
 await check('changed weak validator rejects the full snapshot and recovers',async()=>{
  const r=await query(parquetSQL,[`${fixture.origin}/data/weak-etag/changing/small.parquet`,'a']);
  assert.equal(r.status,502);assert.equal(r.body.error.diagnostic.reason,'object_changed');
  assert.equal((await query('SELECT 42')).status,200);
 });
 await check('populated range cache cannot combine changed object versions',async()=>{
  const mark=fixture.requests.length;
  const r=await query(parquetSQL,[`${fixture.origin}/data/changing-after-download/cache-version/large.parquet`,'a']);
  assert.equal(r.status,502,JSON.stringify(r));assert.equal(r.body.error.diagnostic.reason,'object_changed');
  assert(r.body.metrics.cache_peak_bytes>0);
  const requests=fixture.requests.slice(mark);
  assert(requests.some(x=>x.range&&x.status===206));
  assert(requests.some(x=>x.range&&x.status===412&&x.if_match));
  assert.equal((await query('SELECT 42')).status,200);
 });
 await check('object larger than 128 MiB',async()=>{const r=await query(parquetSQL,[`${fixture.origin}/data/large.parquet`,'a']);assert.equal(r.status,200,JSON.stringify(r));assert.deepEqual(r.body.rows,[[512,261632]]);assert(r.body.metrics.fetch_bytes<137475588/4);report.large_parquet=r.body.metrics;});
 await check('configured origin rejects another reachable origin without fetching',async()=>{
  const n=secondFixture.requests.length;
  const r=await query(parquetSQL,[`${secondFixture.origin}/data/small.parquet`,'a']);
  assert.equal(r.status,502);
  assert.deepEqual(r.body.error.diagnostic,{reason:'source_policy',method:'HEAD'});
  assert.equal(r.body.metrics.fetch_count,0);
  assert.equal(secondFixture.requests.length,n);
 });
 await check('cross-origin redirects follow the optional origin restriction',async()=>{
  const url=`${fixture.origin}/data/redirect-cross-origin/small.parquet`;
  const mark=secondFixture.requests.length;
  assert.equal((await query(parquetSQL,[url,'a'])).status,502);
  assert.equal(secondFixture.requests.length,mark);
  const r=await unrestrictedQuery(parquetSQL,[url,'a']);
  assert.equal(r.status,200,JSON.stringify(r));assert.deepEqual(r.body.rows,[[512,261632]]);
  assert(secondFixture.requests.slice(mark).some(x=>x.range&&x.bytes>0));
 });
 await check('HTTP edge failures and cleanup',async()=>{
  report.transport_errors={};
  for(const mode of ['ignored','range-416','bad-range','changing','short','redirect-denied','reject','no-etag','weak-etag','no-range','redirect-missing','ignored/no-length']){
   const r=await query(parquetSQL,[`${fixture.origin}/data/${mode}/large.parquet`,'a']);assert.equal(r.status,502,`${mode}: ${JSON.stringify(r)}`);
   const diagnostic=r.body.error.diagnostic;
   assert(diagnostic?.reason,JSON.stringify(r));
   assert(['HEAD','GET'].includes(diagnostic.method));
   assert(r.body.metrics.fetch_count>0);
   const expected={ignored:'full_download_limit','range-416':'upstream_http_status','bad-range':'invalid_content_range',changing:'object_changed','redirect-denied':'redirect_policy','no-etag':'full_download_limit','weak-etag':'full_download_limit','no-range':'missing_content_range','redirect-missing':'missing_redirect_location','ignored/no-length':'full_download_limit'}[mode];
   if(expected)assert.equal(diagnostic.reason,expected,`${mode}: ${JSON.stringify(r)}`);
   if(mode==='range-416')assert.equal(diagnostic.upstream_status,416);
   if(mode==='reject'){assert.match(diagnostic.reason,/^fetch_(failed|type_error)$/);assert.equal(diagnostic.upstream_status,undefined);}
   report.transport_errors[mode]=r.body;
   assert.equal((await query('SELECT 42')).status,200);
  }
 });
 await check('transport diagnostics exclude URLs and credentials',async()=>{
  const url=`${fixture.origin}/data/weak-etag/large.parquet?X-Amz-Credential=private-credential-marker&X-Amz-Signature=private-signature-marker`;
  const r=await query(parquetSQL,[url,'a']);
  assert.equal(r.status,502);
  assert.deepEqual(r.body.error.diagnostic,{reason:'full_download_limit',method:'HEAD',upstream_status:200});
  const text=JSON.stringify(r.body);
  for(const secret of [url,fixture.origin,'private-credential-marker','private-signature-marker','local-test-token'])assert(!text.includes(secret),text);
  assert(text.length<1024);
  const recovered=await query('SELECT 42');
  assert.equal(recovered.status,200);assert.equal(recovered.body.error,undefined);assert.equal(recovered.body.metrics.fetch_count,0);
 });
 await check('ignored ranges use one bounded full snapshot for small objects',async()=>{
  for(const mode of ['ignored','ignored/no-length','ignored/no-head','ignored/head-no-length/no-length']) {
   const mark=fixture.requests.length;
   const url=`${fixture.origin}/data/${mode}/small.parquet`;
   const r=await query(parquetSQL.replace('read_parquet(?)',`read_parquet('${url}')`),['a']);
   assert.equal(r.status,200,`${mode}: ${JSON.stringify(r)}`);assert.deepEqual(r.body.rows,[[512,261632]]);
   const gets=fixture.requests.slice(mark).filter(x=>x.method==='GET');
   assert.equal(gets.filter(x=>x.range===null).length,1,JSON.stringify(gets));
   if(!mode.includes('head-no-length')) assert(gets.some(x=>x.range!==null));
   assert.equal(r.body.metrics.fetch_bytes,269630);
   assert(gets.filter(x=>x.range===null).every(x=>x.if_match));
  }
 });
 await check('ignored ranges cannot bypass size, version or streaming limits',async()=>{
  for(const mode of ['ignored','ignored/no-length']) {
   const mark=fixture.requests.length;
   const r=await query(parquetSQL,[`${fixture.origin}/data/${mode}/large.parquet`,'a']);
   assert.equal(r.status,502);assert.equal(r.body.error.diagnostic.reason,'full_download_limit');
   assert(fixture.requests.slice(mark).every(x=>x.method==='HEAD'||x.range!==null));
   assert.equal(r.body.metrics.fetch_bytes,0);
  }
  const unknown=await query(parquetSQL,[`${fixture.origin}/data/ignored/head-no-length/no-length/large.parquet`,'a']);
  assert.equal(unknown.status,502,JSON.stringify(unknown));assert.equal(unknown.body.error.diagnostic.reason,'full_download_limit');
  assert(unknown.body.metrics.fetch_bytes>=4*1024*1024&&unknown.body.metrics.fetch_bytes<5*1024*1024);
  const changed=await query(parquetSQL,[`${fixture.origin}/data/ignored/changing-after-download/small.parquet`,'a']);
  assert.equal(changed.status,502,JSON.stringify(changed));assert.equal(changed.body.error.diagnostic.reason,'object_changed');
  assert.equal((await query('SELECT 42')).status,200);
 });
 await check('allowed redirect',async()=>{const r=await query(parquetSQL,[`${fixture.origin}/data/redirect/small.parquet`,'a']);assert.equal(r.status,200,JSON.stringify(r));assert.deepEqual(r.body.rows,[[512,261632]]);});
 await check('no HEAD and absent content length have bounded outcomes',async()=>{
  report.http_optional={};
  for(const mode of ['no-head','no-length']){const r=await query(parquetSQL,[`${fixture.origin}/data/${mode}/small.parquet`,'a']);assert([200,502].includes(r.status),JSON.stringify(r));if(r.status===200)assert.deepEqual(r.body.rows,[[512,261632]]);report.http_optional[mode]=r.status;}
 });
 await check('deadline, overlap and event-loop progress',async()=>{
  const mark=fixture.requests.length;
  const pending=query(parquetSQL,[`${fixture.origin}/data/timeout/large.parquet`,'a']);
  for(let i=0;i<100&&fixture.requests.length===mark;++i)await new Promise(r=>setTimeout(r,10));
  assert(fixture.requests.length>mark);
  assert.equal((await health()).busy,true);
  assert.equal((await query('SELECT 42')).status,429);
  const r=await pending;
  assert.equal(r.status,504);
  assert.deepEqual(r.body.error.diagnostic,{reason:'fetch_timeout',method:'HEAD'});
  assert.equal((await query('SELECT 42')).status,200);
 });
 await check('100 alternating engine successes and errors',async()=>{
  report.repetition=[];
  for(let i=0;i<100;++i){const before=performance.now();const r=await query(i%2?'SELECT missing_column':'SELECT 42');assert.equal(r.status,i%2?400:200);report.repetition.push({wall_ms:performance.now()-before,...await health()});}
 });
 report.warm_ms=[];
 for(let i=0;i<35;++i){const before=performance.now();assert.equal((await query('SELECT 42')).status,200);if(i>=5)report.warm_ms.push(performance.now()-before);}
 assert([...fixture.requests,...secondFixture.requests].every(r=>!r.has_authorization), 'API bearer token must not be forwarded upstream');
 report.health=await health();report.status='passed';
} catch(error){report.health=await health().catch(()=>null);report.status='failed';report.error=String(error.stack);process.exitCode=1;}
finally{runtime.kill('SIGTERM');await closed;log.end();await Promise.all([fixture.close(),secondFixture.close()]);writeFileSync('artifacts/api-results.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({...report,requests:report.requests.length,secondary_requests:report.secondary_requests.length,repetition:report.repetition?.length},null,2));}
