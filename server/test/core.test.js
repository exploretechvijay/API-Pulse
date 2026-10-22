import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { percentile, hostAllowed } from '../src/util.js';
import { summarize } from '../src/tests/stats.js';
import { parseCsv } from '../src/tests/csv.js';
import { parseStatusExpr, evaluate, nextState } from '../src/monitor/rules.js';
import { buildRequest, interpolate, jsonPath } from '../src/templating.js';
import { createAgents } from '../src/http/agent.js';
import { doRequest } from '../src/http/request.js';

test('nearest-rank percentiles match an offline calculation', () => {
  const v = Array.from({ length: 1000 }, (_, i) => i + 1); // 1..1000
  assert.equal(percentile(v, 50), 500);
  assert.equal(percentile(v, 95), 950);
  assert.equal(percentile(v, 99), 990);
  assert.equal(percentile([7], 99), 7);
  const shuffled = [...v].sort(() => Math.random() - 0.5);
  const s = summarize(shuffled);
  assert.deepEqual([s.min, s.max, s.p50, s.p90, s.p95, s.p99, s.avg], [1, 1000, 500, 900, 950, 990, 500.5]);
});

test('load-test allow-list matching', () => {
  const list = ['localhost', '*.staging.example.com', 'api.example.com:8443'];
  assert.ok(hostAllowed('http://localhost:3000/x', list));
  assert.ok(hostAllowed('https://a.staging.example.com/', list));
  assert.ok(hostAllowed('https://staging.example.com/', list));
  assert.ok(hostAllowed('https://api.example.com:8443/', list));
  assert.ok(!hostAllowed('https://api.example.com/', list));
  assert.ok(!hostAllowed('https://evil-staging.example.com.attacker.io/', list));
  assert.ok(!hostAllowed('https://google.com/', list));
});

test('expected status expressions', () => {
  const ok = parseStatusExpr('200-299, 301, 4xx');
  assert.ok(ok(204) && ok(301) && ok(404));
  assert.ok(!ok(302) && !ok(500));
  assert.throws(() => parseStatusExpr('abc'));
});

test('rule evaluation and the Down-after-N state machine', () => {
  const res = { ok: true, status: 200, body: '{"status":"ok","n":3}', timings: { total: 120 } };
  assert.equal(evaluate(res, { expectedStatus: '200' }, null).result, 'ok');
  assert.equal(evaluate(res, { expectedStatus: '200' }, 100).result, 'slow');
  assert.equal(evaluate(res, { jsonPath: 'status', jsonExpected: 'ok' }, null).result, 'ok');
  assert.equal(evaluate(res, { jsonPath: 'status', jsonExpected: 'down' }, null).result, 'fail');
  assert.equal(evaluate(res, { bodyContains: 'missing' }, null).result, 'fail');
  assert.equal(evaluate({ ok: false, errorMessage: 'refused', timings: {} }, {}, null).result, 'fail');

  let s = { state: 'up', consecutiveFailures: 0 };
  s = nextState(s.state, s.consecutiveFailures, 'fail', 3); assert.equal(s.state, 'up');
  s = nextState(s.state, s.consecutiveFailures, 'fail', 3); assert.equal(s.state, 'up');
  s = nextState(s.state, s.consecutiveFailures, 'fail', 3); assert.equal(s.state, 'down');
  s = nextState(s.state, s.consecutiveFailures, 'slow', 3); assert.equal(s.state, 'degraded');
  s = nextState(s.state, s.consecutiveFailures, 'ok', 3); assert.equal(s.state, 'up');
});

test('variables, auth and query building', () => {
  const r = buildRequest({ method: 'post', url: '{{BASE}}/items', query: [{ key: 'q', value: '{{Q}}' }], headers: [{ key: 'X-Id', value: '{{$uuid}}' }],
    bodyType: 'json', body: '{"a":"{{Q}}"}' }, { type: 'bearer', token: '{{TOKEN}}' }, { BASE: 'https://api.test', Q: 'x y', TOKEN: 't0k' });
  assert.equal(r.url, 'https://api.test/items?q=x+y');
  assert.equal(r.headers.authorization, 'Bearer t0k');
  assert.equal(r.headers['content-type'], 'application/json');
  assert.equal(r.body, '{"a":"x y"}');
  assert.match(r.headers['x-id'], /^[0-9a-f-]{36}$/);
  assert.deepEqual(buildRequest({ url: 'http://x/{{NOPE}}' }, {}, {}).missing, ['NOPE']);
  assert.equal(interpolate('{{ A }}-{{B}}', { A: 1 }), '1-{{B}}');
  assert.equal(jsonPath({ a: { b: [{ c: 5 }] } }, '$.a.b[0].c'), 5);
});

test('CSV parsing with quotes', () => {
  const { columns, rows } = parseCsv('user,pass\r\n"a,1","p""q"\nb,2\n');
  assert.deepEqual(columns, ['user', 'pass']);
  assert.deepEqual(rows, [{ user: 'a,1', pass: 'p"q' }, { user: 'b', pass: '2' }]);
});

test('throttled connections never drop data when the server closes the socket', async () => {
  const server = http.createServer((req, res) => { res.setHeader('connection', 'close'); res.end(Buffer.alloc(20_000, 98)); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/`;
  try {
    const agents = createAgents({ profile: { downloadKbps: 20000, uploadKbps: 10000, latencyMs: 50 } });
    const results = await Promise.all(Array.from({ length: 40 }, () => doRequest({ url, agents, timeoutMs: 10000 })));
    const failed = results.filter((r) => !r.ok || r.bytesReceived !== 20_000);
    assert.equal(failed.length, 0, failed.map((f) => f.errorMessage).join(', '));
    agents.destroy();
  } finally {
    server.close();
  }
});

test('network simulator slows latency and bandwidth in both directions', async () => {
  const server = http.createServer((req, res) => {
    let n = 0;
    req.on('data', (c) => (n += c.length));
    req.on('end', () => res.end(req.url === '/big' ? Buffer.alloc(50_000, 97) : String(n)));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const fast = createAgents();
    const a = await doRequest({ url: `${base}/`, agents: fast, timeoutMs: 5000 });
    assert.ok(a.ok && a.timings.total < 200);

    // 200 ms RTT: TCP connect ≈ 1 RTT, request/response ≈ 1 RTT
    const rtt = createAgents({ profile: { latencyMs: 200 } });
    const b = await doRequest({ url: `${base}/`, agents: rtt, timeoutMs: 5000 });
    assert.ok(b.timings.tcp >= 190, `tcp ${b.timings.tcp}`);
    assert.ok(b.timings.ttfb >= 190, `ttfb ${b.timings.ttfb}`);

    // 400 kbps down: 50 kB response ≈ 1 s
    const bw = createAgents({ profile: { downloadKbps: 400, uploadKbps: 400 } });
    const c = await doRequest({ url: `${base}/big`, agents: bw, timeoutMs: 10000 });
    assert.equal(c.bytesReceived, 50_000);
    assert.ok(c.timings.total > 900 && c.timings.total < 1600, `total ${c.timings.total}`);

    // upload is throttled too: 25 kB body at 200 kbps ≈ 1 s
    const up = createAgents({ profile: { uploadKbps: 200 } });
    const d = await doRequest({ url: `${base}/`, method: 'POST', body: 'x'.repeat(25_000), agents: up, timeoutMs: 10000 });
    assert.equal(d.body, '25000');
    assert.ok(d.timings.total > 900, `upload total ${d.timings.total}`);
    for (const ag of [fast, rtt, bw, up]) ag.destroy();
  } finally {
    server.close();
  }
});
