import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { db, now, profileFromRow } from '../db.js';
import { config } from '../config.js';
import { ah, notFound, badRequest, int, str, HttpError } from '../util.js';
import { audit } from '../audit.js';
import { requireLogin, requireEditor } from '../auth.js';
import {
  startRun, stopRun, getRun, toRun, preflight, waitForRun, toTemplate, templateColumns, runTemplate, activeRuns,
} from '../tests/manager.js';

const r = Router();

// ---------------- network profiles (NET-01/02) ----------------
function profileInput(b) {
  const num = (v, name, max) => int(v, { min: 0, max, def: 0, name });
  return {
    name: str(b.name, { required: true, max: 100, name: 'Name' }).trim(),
    description: str(b.description, { max: 300 }),
    download_kbps: num(b.downloadKbps, 'Download', 10_000_000),
    upload_kbps: num(b.uploadKbps, 'Upload', 10_000_000),
    latency_ms: num(b.latencyMs, 'Latency', 60_000),
    jitter_ms: num(b.jitterMs, 'Jitter', 60_000),
    packet_loss: num(b.packetLoss, 'Packet loss', 100),
  };
}
const loadProfile = (id) => { const p = db.prepare('SELECT * FROM network_profiles WHERE id = ?').get(id); if (!p) throw notFound('Profile'); return p; };

r.get('/profiles', requireLogin, (req, res) => {
  res.json(db.prepare('SELECT * FROM network_profiles ORDER BY builtin DESC, sort, name').all().map(profileFromRow));
});

r.post('/profiles', requireEditor, ah(async (req, res) => {
  const p = profileInput(req.body || {});
  if (db.prepare('SELECT 1 FROM network_profiles WHERE name = ?').get(p.name)) throw badRequest('A profile with this name already exists');
  const t = now();
  const id = db.prepare(`INSERT INTO network_profiles (name, description, download_kbps, upload_kbps, latency_ms, jitter_ms, packet_loss, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(p.name, p.description, p.download_kbps, p.upload_kbps, p.latency_ms, p.jitter_ms, p.packet_loss, t, t).lastInsertRowid;
  audit(req.user, 'profile.create', 'profile', id, { name: p.name });
  res.status(201).json(profileFromRow(loadProfile(id)));
}));

r.put('/profiles/:id', requireEditor, ah(async (req, res) => {
  const ex = loadProfile(req.params.id);
  if (ex.builtin) throw badRequest('Built-in profiles cannot be edited – create a custom profile instead');
  const p = profileInput({ ...profileFromRow(ex), ...req.body });
  db.prepare(`UPDATE network_profiles SET name = ?, description = ?, download_kbps = ?, upload_kbps = ?, latency_ms = ?, jitter_ms = ?, packet_loss = ?, updated_at = ? WHERE id = ?`)
    .run(p.name, p.description, p.download_kbps, p.upload_kbps, p.latency_ms, p.jitter_ms, p.packet_loss, now(), ex.id);
  audit(req.user, 'profile.update', 'profile', ex.id, { name: p.name });
  res.json(profileFromRow(loadProfile(ex.id)));
}));

r.delete('/profiles/:id', requireEditor, ah(async (req, res) => {
  const ex = loadProfile(req.params.id);
  if (ex.builtin) throw badRequest('Built-in profiles cannot be deleted');
  db.prepare('DELETE FROM network_profiles WHERE id = ?').run(ex.id);
  audit(req.user, 'profile.delete', 'profile', ex.id, { name: ex.name });
  res.json({ ok: true });
}));

// ---------------- ad-hoc runs ----------------
r.post('/tests/preflight', requireEditor, ah(async (req, res) => {
  res.json(preflight(req.body.kind, req.body.config));
}));

r.post('/tests/run', requireEditor, ah(async (req, res) => {
  const { kind, config: cfg, name, confirm, passCriteria } = req.body || {};
  const id = startRun({ kind, config: cfg, name, user: req.user, trigger: req.viaToken ? 'api' : 'manual', confirm: !!confirm, criteria: passCriteria });
  if (req.query.wait === 'true') await waitForRun(id, int(req.query.timeoutSec, { min: 1, max: 86400, def: 3600 }) * 1000);
  res.status(201).json(getRun(id, { full: req.query.wait === 'true' }));
}));

// ---------------- saved tests / templates (CFG-02, CFG-06) ----------------
const loadTemplate = (id) => { const t = db.prepare('SELECT * FROM test_templates WHERE id = ?').get(id); if (!t) throw notFound('Saved test'); return t; };

r.get('/templates', requireLogin, (req, res) => {
  const rows = db.prepare(req.query.kind ? 'SELECT * FROM test_templates WHERE kind = ? ORDER BY name' : 'SELECT * FROM test_templates ORDER BY name')
    .all(...(req.query.kind ? [req.query.kind] : []));
  const last = db.prepare('SELECT id, status, passed, started_at FROM test_runs WHERE template_id = ? ORDER BY id DESC LIMIT 1');
  res.json(rows.map((t) => ({ ...toTemplate(t), lastRun: last.get(t.id) || null })));
});

r.get('/templates/:id', requireLogin, (req, res) => res.json(toTemplate(loadTemplate(req.params.id))));

r.post('/templates', requireEditor, ah(async (req, res) => {
  const c = templateColumns(req.body || {}, null);
  const t = now();
  const id = db.prepare('INSERT INTO test_templates (name, kind, config, schedule, pass_criteria, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(c.name, c.kind, c.config, c.schedule, c.pass_criteria, req.user.id, t, t).lastInsertRowid;
  audit(req.user, 'test.template.create', 'template', id, { name: c.name, kind: c.kind });
  res.status(201).json(toTemplate(loadTemplate(id)));
}));

r.put('/templates/:id', requireEditor, ah(async (req, res) => {
  const ex = loadTemplate(req.params.id);
  const c = templateColumns(req.body || {}, ex);
  db.prepare('UPDATE test_templates SET name = ?, kind = ?, config = ?, schedule = ?, pass_criteria = ?, updated_at = ? WHERE id = ?')
    .run(c.name, c.kind, c.config, c.schedule, c.pass_criteria, now(), ex.id);
  audit(req.user, 'test.template.update', 'template', ex.id, { name: c.name });
  res.json(toTemplate(loadTemplate(ex.id)));
}));

r.delete('/templates/:id', requireEditor, ah(async (req, res) => {
  const ex = loadTemplate(req.params.id);
  db.prepare('DELETE FROM test_templates WHERE id = ?').run(ex.id);
  audit(req.user, 'test.template.delete', 'template', ex.id, { name: ex.name });
  res.json({ ok: true });
}));

/** Run a saved test. CI/CD: POST with ?wait=true and an API token; check `passed` in the response (US-12). */
r.post('/templates/:id/run', requireEditor, ah(async (req, res) => {
  loadTemplate(req.params.id);
  const id = runTemplate(Number(req.params.id), req.user, { trigger: req.viaToken ? 'api' : 'manual', confirm: !!req.body?.confirm });
  if (req.query.wait === 'true') {
    await waitForRun(id, int(req.query.timeoutSec, { min: 1, max: 86400, def: 3600 }) * 1000);
    const run = getRun(id);
    return res.status(run.status === 'running' ? 202 : 200).json(run);
  }
  res.status(201).json(getRun(id, { full: false }));
}));

// ---------------- run history (US-09) ----------------
r.get('/runs', requireLogin, (req, res) => {
  const where = [];
  const args = [];
  if (req.query.kind) { where.push('kind = ?'); args.push(req.query.kind); }
  if (req.query.templateId) { where.push('template_id = ?'); args.push(Number(req.query.templateId)); }
  if (req.query.status) { where.push('status = ?'); args.push(req.query.status); }
  const limit = int(req.query.limit, { min: 1, max: 500, def: 100 });
  const rows = db.prepare(`SELECT id, template_id, name, kind, status, trigger, started_at, finished_at, passed, warnings, error,
    created_by_email, raw_file, config, headline FROM test_runs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`)
    .all(...args, limit);
  res.json(rows.map((x) => toRun(x, { full: false })));
});

r.get('/runs/active', requireLogin, (req, res) => res.json(activeRuns()));

r.get('/runs/:id', requireLogin, (req, res) => {
  const run = getRun(Number(req.params.id));
  if (!run) throw notFound('Run');
  res.json(run);
});

r.post('/runs/:id/stop', requireEditor, ah(async (req, res) => {
  stopRun(Number(req.params.id), req.user);
  res.json({ ok: true });
}));

r.delete('/runs/:id', requireEditor, ah(async (req, res) => {
  const row = db.prepare('SELECT * FROM test_runs WHERE id = ?').get(req.params.id);
  if (!row) throw notFound('Run');
  if (row.status === 'running') throw new HttpError(409, 'Stop the run before deleting it');
  if (row.raw_file) fs.rmSync(path.join(config.runsDir, path.basename(row.raw_file)), { force: true });
  db.prepare('DELETE FROM test_runs WHERE id = ?').run(row.id);
  audit(req.user, 'test.run.delete', 'run', row.id, { name: row.name });
  res.json({ ok: true });
}));

/** Raw per-request results (gzip CSV) for offline analysis. */
r.get('/runs/:id/raw', requireLogin, (req, res) => {
  const row = db.prepare('SELECT raw_file FROM test_runs WHERE id = ?').get(req.params.id);
  if (!row?.raw_file) throw notFound('Raw results');
  const file = path.join(config.runsDir, path.basename(row.raw_file));
  if (!fs.existsSync(file)) throw notFound('Raw results');
  res.setHeader('content-type', 'application/gzip');
  res.setHeader('content-disposition', `attachment; filename="api-pulse-run-${req.params.id}.csv.gz"`);
  fs.createReadStream(file).pipe(res);
});

export default r;
