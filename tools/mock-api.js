// Mock API used for demos and acceptance testing. No dependencies.
//
//   node tools/mock-api.js [port]        (default 4000)
//
// GET  /fast                 small JSON, instant
// GET  /slow?ms=800          responds after a delay
// GET  /big?kb=500           large payload (to see bandwidth throttling)
// POST /echo                 echoes the request body
// GET  /flaky?rate=0.3       fails with 500 at the given rate
// GET  /health               200 while "up", 503 after POST /toggle
// POST /toggle               flips /health between up and down
// GET  /capacity?max=50      503 when more than `max` requests are in flight
//                            (each request takes ~20 ms) – for stress tests
// POST /login                returns {"token":"abc123"}; GET /me needs "Authorization: Bearer abc123"
// POST /webhook              receives alert webhooks and logs them

import http from 'node:http';

const port = Number(process.argv[2] || process.env.MOCK_PORT || 4000);
let up = true;
let inflight = 0;
const big = (kb) => JSON.stringify({ data: 'x'.repeat(Math.max(0, kb * 1024 - 12)) });

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const q = Object.fromEntries(url.searchParams);
  const json = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    switch (url.pathname) {
      case '/fast': return json(200, { ok: true, ts: Date.now() });
      case '/slow': return setTimeout(() => json(200, { ok: true, delayed: Number(q.ms || 800) }), Number(q.ms || 800));
      case '/big': res.writeHead(200, { 'content-type': 'application/json' }); return res.end(big(Number(q.kb || 500)));
      case '/echo': res.writeHead(200, { 'content-type': req.headers['content-type'] || 'text/plain' }); return res.end(body);
      case '/flaky': return Math.random() < Number(q.rate || 0.3) ? json(500, { ok: false }) : json(200, { ok: true });
      case '/health': return up ? json(200, { status: 'ok' }) : json(503, { status: 'down' });
      case '/toggle': up = !up; console.log(`[mock] /health is now ${up ? 'UP' : 'DOWN'}`); return json(200, { up });
      case '/capacity': {
        const max = Number(q.max || 50);
        if (inflight >= max) return json(503, { error: 'overloaded' });
        inflight++;
        return setTimeout(() => { inflight--; json(200, { ok: true }); }, Number(q.ms || 20));
      }
      case '/login': return json(200, { token: 'abc123' });
      case '/me': return req.headers.authorization === 'Bearer abc123' ? json(200, { user: 'demo' }) : json(401, { error: 'unauthorized' });
      case '/webhook': console.log('[mock] webhook received:', body.slice(0, 500)); return json(200, { received: true });
      default: return json(404, { error: 'not found' });
    }
  });
});
server.keepAliveTimeout = 30000;
server.listen(port, () => console.log(`Mock API listening on http://localhost:${port}`));
