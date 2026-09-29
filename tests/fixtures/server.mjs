import { createServer } from 'node:https';
import { createReadStream, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { once } from 'node:events';

// Real socket/TLS fixture server. No Worker fetch mocking or outbound override.
export async function startFixtures({ key, cert, root, redirectOrigin }) {
  const manifest = JSON.parse(readFileSync(resolve(root, 'tests/fixtures/manifest.json')));
  const files = new Map(manifest.files.map(f => [f.path.split('/').at(-1), f]));
  const requests = [];
  const counters = new Map();
  const server = createServer({ key, cert }, async (req, res) => {
    const url = new URL(req.url, 'https://localhost');
    const name = url.pathname.split('/').at(-1);
    const fixture = files.get(name);
    const record = { has_authorization: req.headers.authorization !== undefined, method: req.method, path: url.pathname, range: req.headers.range ?? null, if_match: req.headers['if-match'] ?? null, accept_encoding: req.headers['accept-encoding'] ?? null, bytes: 0, start_ms: performance.now() };
    requests.push(record);
    const finish = status => { record.status = status; record.end_ms = performance.now(); };
    res.on('close', () => { record.closed = true; });
    if (!fixture) { res.writeHead(404).end(); finish(404); return; }
    if (url.pathname.includes('/timeout/')) { return; }
    if (url.pathname.includes('/delay/')) { await new Promise(resolve => setTimeout(resolve, 500)); }
    if (url.pathname.includes('/reject/')) { req.socket.destroy(); return; }
    if (url.pathname.includes('/redirect-missing/')) { res.writeHead(302).end(); finish(302); return; }
    if (url.pathname.includes('/redirect-denied/')) { res.writeHead(302, { Location: 'https://example.invalid/stolen' }).end(); finish(302); return; }
    if (url.pathname.includes('/redirect-cross-origin/') && redirectOrigin) { res.writeHead(302, { Location: `${redirectOrigin}/data/${name}` }).end(); finish(302); return; }
    if (url.pathname.includes('/redirect/')) { res.writeHead(302, { Location: `https://${req.headers.host}/data/${name}` }).end(); finish(302); return; }
    if (url.pathname.includes('/no-head/') && req.method === 'HEAD') { res.writeHead(405).end(); finish(405); return; }
    const absolute = resolve(root, fixture.path);
    const size = statSync(absolute).size;
    const count = counters.get(url.pathname) ?? 0;
    counters.set(url.pathname, count + 1);
    const changed = (url.pathname.includes('/changing/') && count > 0) ||
      (url.pathname.includes('/changing-after-download/') && count > 1);
    const etag = `"${fixture.sha256}${changed ? '-changed' : ''}"`;
    if (req.headers['if-match'] && req.headers['if-match'] !== etag) { res.writeHead(412).end(); finish(412); return; }
    let start = 0, end = size - 1, status = 200;
    const headers = { ETag: etag, 'Accept-Ranges': 'bytes', 'Content-Type': name.endsWith('.json') ? 'application/json' : 'application/octet-stream' };
    if (url.pathname.includes('/no-etag/')) delete headers.ETag;
    if (url.pathname.includes('/weak-etag/')) headers.ETag = `W/${etag}`;
    // GitHub's raw file host returns a weak validator when compression is
    // negotiated. Require an explicit identity request to select strong bytes.
    if (url.pathname.includes('/negotiate-encoding/') && req.headers['accept-encoding'] !== 'identity') headers.ETag = `W/${etag}`;
    if (req.method === 'HEAD') {
      if (!url.pathname.includes('/head-no-length/')) headers['Content-Length'] = size;
      res.writeHead(200, headers).end(); finish(200); return;
    }
    if (req.method !== 'GET') { res.writeHead(405).end(); finish(405); return; }
    if (req.headers.range && !url.pathname.includes('/ignored/')) {
      const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range);
      if (!match || BigInt(match[1]) >= BigInt(size) || url.pathname.includes('/range-416/')) {
        res.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}` }).end(); finish(416); return;
      }
      start = Number(match[1]);
      end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
      if (end < start) { res.writeHead(416).end(); finish(416); return; }
      status = 206;
      headers['Content-Range'] = `bytes ${url.pathname.includes('/bad-range/') ? start + 1 : start}-${end}/${size}`;
      if (url.pathname.includes('/no-range/')) delete headers['Content-Range'];
    }
    const length = end - start + 1;
    if (!url.pathname.includes('/no-length/')) headers['Content-Length'] = length;
    res.writeHead(status, headers);
    const stream = createReadStream(absolute, { start, end: url.pathname.includes('/short/') ? Math.max(start, end - 1) : end, highWaterMark: 32 * 1024 });
    stream.on('data', chunk => { record.bytes += chunk.length; });
    stream.on('end', () => finish(status));
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { origin: `https://127.0.0.1:${server.address().port}`, requests, close: async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); } };
}
