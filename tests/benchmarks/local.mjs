// Actual local workerd execution; no mocked fetch or Node-hosted Wasm.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, createWriteStream, statSync, existsSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { availablePort } from '../integration/port.mjs';
import { startFixtures } from '../fixtures/server.mjs';

const root=resolve(import.meta.dirname,'../..'); process.chdir(root);
const bundle=resolve(process.env.BENCH_BUNDLE ?? 'build');
const compare=process.env.BENCH_COMPARE_BUNDLE ? resolve(process.env.BENCH_COMPARE_BUNDLE) : null;
const label=process.env.BENCH_LABEL ?? 'current';
assert.match(label,/^[a-z0-9-]+$/);
const dir=resolve(`build/benchmarks/${label}-runtime`); mkdirSync(dir,{recursive:true});
mkdirSync('artifacts/benchmarks',{recursive:true});
writeFileSync(`${dir}/openssl.cnf`,'[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=localhost\n[ext]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\n');
execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','2','-config',`${dir}/openssl.cnf`,'-keyout',`${dir}/key.pem`,'-out',`${dir}/cert.pem`],{stdio:'ignore'});
const latencyMs=Number(process.env.BENCH_LATENCY_MS ?? 20);
assert(Number.isInteger(latencyMs)&&latencyMs>=0&&latencyMs<=1000);
const fixture=await startFixtures({root,latencyMs,key:readFileSync(`${dir}/key.pem`),cert:readFileSync(`${dir}/cert.pem`)});
const report={label,runtime:'local workerd',fixture_delay_ms:latencyMs,wasm_sha256:createHash('sha256').update(readFileSync(`${bundle}/index_bg.wasm`)).digest('hex'),
 wasm_bytes:statSync(`${bundle}/index_bg.wasm`).size,js_bytes:statSync(`${bundle}/index.js`).size,variants:[]};
report.created_at=new Date().toISOString();
report.host=`${process.platform}-${process.arch}`;
report.node=process.version;
report.workerd=JSON.parse(readFileSync('node_modules/workerd/package.json')).version;
report.fixtures=JSON.parse(readFileSync('tests/fixtures/manifest.json')).files;
const cmake=[`${bundle}/CMakeCache.txt`,`${bundle}/duckdb/CMakeCache.txt`].find(existsSync);
if(cmake) report.smaller_binary_except=/^SMALLER_BINARY_EXCEPT:STRING=(.*)$/m.exec(readFileSync(cmake,'utf8'))?.[1];
if(compare) report.comparison={wasm_sha256:createHash('sha256').update(readFileSync(`${compare}/index_bg.wasm`)).digest('hex'),wasm_bytes:statSync(`${compare}/index_bg.wasm`).size};
const median=a=>{const b=[...a].sort((x,y)=>x-y);return (b[Math.floor((b.length-1)/2)]+b[Math.floor(b.length/2)])/2;};
const mode=process.env.BENCH_MODE ?? 'all';
const variants=mode==='io' ? [
 ['no-cache',-1,-1],['exact',0,-1],['64k',65536,-1],['256k',262144,-1],['1m',1048576,-1],
 ['gap-0',0,0],['gap-64k',0,65536],['gap-512k',0,524288],
] : [['default',null,null]];
const embed=p=>JSON.stringify(relative(dir,p));
try {
 for(const [name,block,gap] of variants) {
  const port=await availablePort(); const base=`http://127.0.0.1:${port}`;
  const comparePort=compare ? await availablePort() : null;
  const compareBase=`http://127.0.0.1:${comparePort}`;
  const bindings=[['API_KEY','benchmark-key']];
  if(block!==null) bindings.push(['RANGE_CACHE_BLOCK_BYTES',String(block)],['PARQUET_PREFETCH_COLUMN_GAP',String(gap)]);
  writeFileSync(`${dir}/workerd.capnp`,`using Workerd = import ${embed(resolve('node_modules/workerd/workerd.capnp'))};
const config :Workerd.Config = (services=[
 (name="evaluation",worker=(modules=[(name="index.js",esModule=embed ${embed(`${bundle}/index.js`)}),(name="index_bg.wasm",wasm=embed ${embed(`${bundle}/index_bg.wasm`)})],compatibilityDate="2026-09-26",compatibilityFlags=["new_module_registry"],bindings=[${bindings.map(([k,v])=>`(name="${k}",text="${v}")`).join(',')}])),
 ${compare?`(name="comparison",worker=(modules=[(name="index.js",esModule=embed ${embed(`${compare}/index.js`)}),(name="index_bg.wasm",wasm=embed ${embed(`${compare}/index_bg.wasm`)})],compatibilityDate="2026-09-26",compatibilityFlags=["new_module_registry"],bindings=[(name="API_KEY",text="benchmark-key")])),`:''}
 (name="internet",network=(allow=["local","public"],tlsOptions=(trustBrowserCas=true,trustedCertificates=[embed "cert.pem"])))
 ],sockets=[(name="http",address="127.0.0.1:${port}",http=(),service="evaluation")${compare?`,(name="comparison-http",address="127.0.0.1:${comparePort}",http=(),service="comparison")`:''}]);`);
  const log=createWriteStream(`${dir}/${name}.log`);
  const runtime=spawn(`node_modules/@cloudflare/workerd-${process.platform}-${process.arch}/bin/workerd`,['serve','--experimental',`${dir}/workerd.capnp`],{stdio:['ignore','pipe','pipe']});
  const closed=once(runtime,'close'); runtime.stdout.pipe(log,{end:false}); runtime.stderr.pipe(log,{end:false});
  const variant={name,block,gap,cases:[]}; report.variants.push(variant);
  async function query(sql,params=[],endpoint=base) {
   const start=performance.now(); const mark=fixture.requests.length;
   // A host process watchdog, not a claim that a JS timer can preempt Wasm.
   let timedOut=false;
   const watchdog=setTimeout(()=>{timedOut=true;runtime.kill('SIGKILL');},45000);
   try {
    const r=await fetch(`${endpoint}/v1/query`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer benchmark-key'},body:JSON.stringify({sql,params})});
    const body=await r.json();
    const wall_ms=performance.now()-start;
    const health=await (await fetch(`${endpoint}/healthz`)).json();
    return {status:r.status,body,wall_ms,health,requests:fixture.requests.slice(mark).map(x=>({...x}))};
   } catch(error) {
    variant.failure={error:String(error),watchdog_fired:timedOut,wall_ms:performance.now()-start};
    throw error;
   } finally {clearTimeout(watchdog);}
  }
  try {
   let ready=false;
   for(let i=0;i<200;i++) {if(runtime.exitCode!==null)throw Error('workerd exited');try{ready=(await fetch(`${base}/healthz`)).ok;if(ready)break;}catch{}await new Promise(r=>setTimeout(r,50));}
   assert(ready);
   const cases=[];
   if(mode!=='engine') {
    for(const file of ['small.parquet','large.parquet']) for(const literal of [false,true]) {
     const url=`${fixture.origin}/data/${file}`;
     cases.push([`${file}-${literal?'literal':'parameter'}`,`SELECT count(*)::BIGINT, sum(id)::BIGINT FROM read_parquet(${literal?`'${url}'`:'?'}) WHERE id<1024 AND category='a'`,literal?[]:[url],[[512,261632]]]);
    }
    cases.push(['weak-literal',`SELECT count(*)::BIGINT FROM '${fixture.origin}/data/weak-etag/small.parquet'`,[],[[16384]]]);
    // Projected payload plus filtered id: exercises Parquet column coalescing.
    cases.push(['payload',"SELECT sum(length(payload))::BIGINT FROM read_parquet(?) WHERE id<8192",[`${fixture.origin}/data/large.parquet`],[[4194304]]]);
    cases.push(['separated-columns','SELECT sum(a+b+c+d)::BIGINT FROM read_parquet(?)',[`${fixture.origin}/data/coalescing.parquet`],[[1342095360]]]);
   }
   if(mode!=='io') cases.push(
    ['local','SELECT 42',[],[[42]]],
    ['aggregate','SELECT sum(i)::BIGINT FROM range(1000000) r(i)',[],[[499999500000]]],
    ['sort-numeric','SELECT sum(i)::BIGINT, first(i), last(i) FROM (SELECT i FROM range(500000) r(i) ORDER BY (i*7919)%500000)',[],[[124999750000,0,482321]]],
    ['sort-text',"SELECT sum(i)::BIGINT, first(i), last(i) FROM (SELECT i FROM range(100000) r(i) ORDER BY md5(i::VARCHAR))",[],[[4999950000,5329,40691]]],
    ['median-window','SELECT sum(q)::DOUBLE FROM (SELECT median(i) OVER (ORDER BY i ROWS BETWEEN 500 PRECEDING AND 500 FOLLOWING) q FROM range(200000) r(i))',[],[[19999900000]]],
    ['mad-window','SELECT sum(q)::DOUBLE FROM (SELECT mad(i) OVER (ORDER BY i ROWS BETWEEN 500 PRECEDING AND 500 FOLLOWING) q FROM range(50000) r(i))',[],[[12437625]]],
   );
   if(process.env.BENCH_PUBLIC==='1') cases.push(['public-github',
    'SELECT cloud_provider, sum(ip_address_cnt)::int AS cnt FROM read_parquet(?) GROUP BY cloud_provider',
    ['https://raw.githubusercontent.com/tobilg/public-cloud-provider-ip-ranges/main/data/providers/all.parquet'],null]);
   for(const [test,sql,params,expected] of cases) {
    if(process.env.BENCH_CASE && !process.env.BENCH_CASE.split(',').includes(test)) continue;
    const result={name:test,sql,samples:[]}; variant.cases.push(result);
    if(compare) result.comparison={samples:[]};
    for(let i=0;i<(mode==='engine'?9:4);i++) {
     const targets=[[result,base]];
     if(compare) targets.push([result.comparison,compareBase]);
     if(i%2) targets.reverse();
     for(const [target,endpoint] of targets) {
      if(target.samples.at(-1)?.status!==200&&target.samples.length) continue;
      const sample=await query(sql,params,endpoint); target.samples.push(sample);
      if(test==='public-github') {assert.equal(sample.status,200,JSON.stringify(sample));assert(sample.body.rows.length>0);}
      if(sample.status===200&&expected) assert.deepEqual(sample.body.rows,expected,`${test}: ${JSON.stringify(sample)}`);
     }
    }
    result.median_ms=median(result.samples.slice(result.samples.length>1?1:0).map(s=>s.wall_ms));
    if(compare) result.comparison.median_ms=median(result.comparison.samples.slice(result.comparison.samples.length>1?1:0).map(s=>s.wall_ms));
    result.health=await (await fetch(`${base}/healthz`)).json();
    console.log(JSON.stringify({variant:name,case:test,status:result.samples[0].status,median_ms:result.median_ms,comparison_median_ms:result.comparison?.median_ms,metrics:result.samples.at(-1).body.metrics,health:result.health}));
   }
  } finally {runtime.kill('SIGTERM');await closed;variant.process_exit={code:runtime.exitCode,signal:runtime.signalCode};log.end();}
 }
} finally {await fixture.close();writeFileSync(`artifacts/benchmarks/${label}.json`,JSON.stringify(report,null,2)+'\n');}
