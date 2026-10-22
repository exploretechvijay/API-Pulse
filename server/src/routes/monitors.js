import { Router } from 'express';
import { db, j, getProfile } from '../db.js';
import { ah, notFound, int } from '../util.js';
import { audit } from '../audit.js';
import { requireLogin, requireEditor } from '../auth.js';
import { publish } from '../events.js';
import { toMonitor, getMonitorRow, monitorColumns, insertMonitor, updateMonitor, effectiveSettings } from '../monitor/model.js';
import { startMonitor, stopMonitor, runCheck } from '../monitor/scheduler.js';
import { monitorSeries, RANGES } from '../monitor/stats.js';
import { evaluate } from '../monitor/rules.js';
import { buildRequest } from '../templating.js';
import { loadVariables } from '../variables.js';
import { createAgents } from '../http/agent.js';
import { doRequest } from '../http/request.js';
import { decryptJson } from '../crypto.js';
import { ALERT_SELECT, toAlert } from '../alerts/service.js';

const r = Router();
const load = (id) => { const row = getMonitorRow(id); if (!row) throw notFound('Monitor'); return row; };

r.get('/monitors', requireLogin, (req, res) => {
  res.json(db.prepare('SELECT * FROM monitors ORDER BY name').all().map((m) => toMonitor(m, { withAuth: false })));
});

r.get('/monitors/:id', requireLogin, (req, res) => res.json(toMonitor(load(req.params.id))));

r.post('/monitors', requireEditor, ah(async (req, res) => {
  const cols = monitorColumns(req.body || {}, null);
  const id = insertMonitor(cols, req.user.id);
  audit(req.user, 'monitor.create', 'monitor', id, { name: cols.name });
  if (!cols.paused) startMonitor(id);
  const m = toMonitor(getMonitorRow(id));
  publish('monitor', m);
  res.status(201).json(m);
}));

r.put('/monitors/:id', requireEditor, ah(async (req, res) => {
  const row = load(req.params.id);
  const cols = monitorColumns(req.body || {}, row);
  updateMonitor(row.id, cols);
  audit(req.user, 'monitor.update', 'monitor', row.id, { name: cols.name });
  if (cols.paused) stopMonitor(row.id); else startMonitor(row.id);
  const m = toMonitor(getMonitorRow(row.id));
  publish('monitor', m);
  res.json(m);
}));

r.delete('/monitors/:id', requireEditor, ah(async (req, res) => {
  const row = load(req.params.id);
  stopMonitor(row.id);
  db.prepare('DELETE FROM monitors WHERE id = ?').run(row.id);
  audit(req.user, 'monitor.delete', 'monitor', row.id, { name: row.name });
  publish('monitorDeleted', { id: row.id });
  res.json({ ok: true });
}));

r.post('/monitors/:id/clone', requireEditor, ah(async (req, res) => {
  const row = load(req.params.id);
  const src = toMonitor(row, { withAuth: false, withUptime: false });
  let name = `${row.name} (copy)`;
  for (let i = 2; db.prepare('SELECT 1 FROM monitors WHERE name = ?').get(name); i++) name = `${row.name} (copy ${i})`;
  const cols = monitorColumns({ ...src, name, paused: true, auth: undefined }, null);
  cols.auth_enc = row.auth_enc; // keep secrets
  const id = insertMonitor(cols, req.user.id);
  audit(req.user, 'monitor.clone', 'monitor', id, { from: row.id, name });
  const m = toMonitor(getMonitorRow(id));
  publish('monitor', m);
  res.status(201).json(m);
}));

for (const [action, paused] of [['pause', 1], ['resume', 0]]) {
  r.post(`/monitors/:id/${action}`, requireEditor, ah(async (req, res) => {
    const row = load(req.params.id);
    db.prepare('UPDATE monitors SET paused = ?, updated_at = ? WHERE id = ?').run(paused, Date.now(), row.id);
    if (paused) stopMonitor(row.id);
    else {
      db.prepare(`UPDATE monitors SET state = 'pending', consecutive_failures = 0 WHERE id = ?`).run(row.id);
      startMonitor(row.id);
    }
    audit(req.user, `monitor.${action}`, 'monitor', row.id, { name: row.name });
    const m = toMonitor(getMonitorRow(row.id), { withAuth: false });
    publish('monitor', m);
    res.json(m);
  }));
}

r.post('/monitors/:id/check', requireEditor, ah(async (req, res) => {
  const row = load(req.params.id);
  const check = await runCheck(row.id);
  res.json({ check, monitor: toMonitor(getMonitorRow(row.id), { withAuth: false }) });
}));

/** Dry-run a monitor definition without saving it (used by the editor's "Test" button). */
r.post('/monitors/test', requireEditor, ah(async (req, res) => {
  const existing = req.body.id ? getMonitorRow(req.body.id) : null;
  const cols = monitorColumns({ ...req.body, name: req.body.name || 'test' }, existing);
  const def = j(cols.request);
  const rules = j(cols.rules);
  const built = buildRequest(def, decryptJson(cols.auth_enc), loadVariables());
  if (built.missing.length) return res.json({ result: 'fail', error: `Unknown variable(s): ${built.missing.join(', ')}` });
  const eff = effectiveSettings(cols);
  const agents = createAgents({ profile: getProfile(cols.network_profile_id), rejectUnauthorized: !def.ignoreTls });
  const out = await doRequest({ ...built, timeoutMs: eff.timeoutMs, agents, maxBodyBytes: 100_000 });
  agents.destroy();
  const ev = evaluate(out, rules, eff.degradedMs);
  res.json({ ...ev, status: out.status, timings: out.timings, headers: out.headers, body: out.body?.slice(0, 20_000), bytes: out.bytesReceived, errorMessage: out.errorMessage });
}));

r.get('/monitors/:id/stats', requireLogin, (req, res) => {
  const row = load(req.params.id);
  const range = RANGES[req.query.range] ? req.query.range : '24h';
  res.json(monitorSeries(row.id, range));
});

/** Newest first. Paging: limit + offset (or a `before` timestamp cursor). Total count in X-Total-Count. */
r.get('/monitors/:id/checks', requireLogin, (req, res) => {
  const row = load(req.params.id);
  const limit = int(req.query.limit, { min: 1, max: 1000, def: 50 });
  const offset = int(req.query.offset, { min: 0, def: 0 });
  const before = int(req.query.before, { def: Number.MAX_SAFE_INTEGER });
  const problems = req.query.result === 'problems' ? " AND result != 'ok'" : '';
  const where = `WHERE monitor_id = ? AND ts < ?${problems}`;
  res.setHeader('x-total-count', db.prepare(`SELECT COUNT(*) AS n FROM checks ${where}`).get(row.id, before).n);
  res.json(db.prepare(`SELECT * FROM checks ${where} ORDER BY ts DESC LIMIT ? OFFSET ?`).all(row.id, before, limit, offset)
    .map((c) => ({ id: c.id, ts: c.ts, result: c.result, statusCode: c.status_code, responseMs: c.response_ms, error: c.error, timings: j(c.timings) })));
});

r.get('/monitors/:id/alerts', requireLogin, (req, res) => {
  const row = load(req.params.id);
  res.json(db.prepare(`${ALERT_SELECT} WHERE a.monitor_id = ? ORDER BY a.started_at DESC LIMIT 100`).all(row.id).map(toAlert));
});

export default r;
