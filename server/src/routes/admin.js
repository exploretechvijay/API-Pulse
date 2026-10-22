import { Router } from 'express';
import express from 'express';
import { db, j, getSetting, setSetting } from '../db.js';
import { ah, notFound, badRequest, int } from '../util.js';
import { audit } from '../audit.js';
import { requireLogin, requireEditor, requireAdmin } from '../auth.js';
import { toVariable, upsertVariable } from '../variables.js';
import { exportConfig, serialize, parseConfigText, importConfig } from '../configio.js';
import { stopScheduler, startScheduler, scheduledCount } from '../monitor/scheduler.js';
import { cpuPercent, cpuCount } from '../cpu.js';
import { clientCount } from '../events.js';
import { activeRuns } from '../tests/manager.js';
import { config } from '../config.js';

const r = Router();

// ---------------- settings (CFG-04, allow-list, status page) ----------------
r.get('/settings', requireLogin, (req, res) => {
  res.json({
    defaults: getSetting('defaults'),
    retention: getSetting('retention'),
    loadAllowlist: getSetting('loadAllowlist'),
    statusPage: getSetting('statusPage'),
  });
});

r.put('/settings', requireAdmin, ah(async (req, res) => {
  const b = req.body || {};
  if (b.defaults) {
    const d = b.defaults;
    setSetting('defaults', {
      intervalSec: int(d.intervalSec, { min: 10, max: 86400, def: 60, name: 'Default interval' }),
      timeoutMs: int(d.timeoutMs, { min: 100, max: 300000, def: 10000, name: 'Default timeout' }),
      failureThreshold: int(d.failureThreshold, { min: 1, max: 100, def: 3, name: 'Default failure threshold' }),
      degradedMs: int(d.degradedMs, { min: 1, max: 600000, name: 'Default degraded threshold' }),
    });
  }
  if (b.retention) {
    const x = b.retention;
    setSetting('retention', {
      rawDays: int(x.rawDays, { min: 1, max: 3650, def: 30, name: 'Raw retention' }),
      rollupDays: int(x.rollupDays, { min: 1, max: 3650, def: 365, name: 'Rollup retention' }),
      runDays: int(x.runDays, { min: 1, max: 3650, def: 365, name: 'Test run retention' }),
    });
  }
  if (b.loadAllowlist) {
    if (!Array.isArray(b.loadAllowlist)) throw badRequest('loadAllowlist must be a list of hosts');
    setSetting('loadAllowlist', b.loadAllowlist.map((s) => String(s).trim()).filter(Boolean));
  }
  if (b.statusPage) setSetting('statusPage', { enabled: !!b.statusPage.enabled, title: String(b.statusPage.title || 'Service Status').slice(0, 100) });
  audit(req.user, 'settings.update', 'settings', null, Object.keys(b));
  res.json({ defaults: getSetting('defaults'), retention: getSetting('retention'), loadAllowlist: getSetting('loadAllowlist'), statusPage: getSetting('statusPage') });
}));

// ---------------- variables & secrets (CFG-05) ----------------
r.get('/variables', requireLogin, (req, res) => {
  res.json(db.prepare('SELECT * FROM variables ORDER BY name').all().map((v) => toVariable(v)));
});

r.post('/variables', requireEditor, ah(async (req, res) => {
  const id = upsertVariable(req.body || {}, null);
  const v = db.prepare('SELECT * FROM variables WHERE id = ?').get(id);
  audit(req.user, 'variable.create', 'variable', id, { name: v.name, secret: !!v.is_secret });
  res.status(201).json(toVariable(v));
}));

r.put('/variables/:id', requireEditor, ah(async (req, res) => {
  const ex = db.prepare('SELECT * FROM variables WHERE id = ?').get(req.params.id);
  if (!ex) throw notFound('Variable');
  upsertVariable(req.body || {}, ex);
  const v = db.prepare('SELECT * FROM variables WHERE id = ?').get(ex.id);
  audit(req.user, 'variable.update', 'variable', ex.id, { name: v.name });
  res.json(toVariable(v));
}));

r.delete('/variables/:id', requireEditor, ah(async (req, res) => {
  const ex = db.prepare('SELECT * FROM variables WHERE id = ?').get(req.params.id);
  if (!ex) throw notFound('Variable');
  db.prepare('DELETE FROM variables WHERE id = ?').run(ex.id);
  audit(req.user, 'variable.delete', 'variable', ex.id, { name: ex.name });
  res.json({ ok: true });
}));

// ---------------- config import / export (CFG-03) ----------------
r.get('/config/export', requireEditor, ah(async (req, res) => {
  const includeSecrets = req.query.secrets === 'true';
  if (includeSecrets && req.user.role !== 'admin') throw badRequest('Only admins can export secrets');
  const format = req.query.format === 'json' ? 'json' : 'yaml';
  audit(req.user, 'config.export', 'config', null, { includeSecrets, format });
  res.setHeader('content-type', format === 'json' ? 'application/json' : 'application/yaml');
  res.setHeader('content-disposition', `attachment; filename="api-pulse-config.${format === 'json' ? 'json' : 'yaml'}"`);
  res.send(serialize(exportConfig({ includeSecrets }), format));
}));

r.post('/config/import', requireAdmin, express.text({ type: '*/*', limit: '20mb' }), ah(async (req, res) => {
  const text = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
  const doc = parseConfigText(text);
  const mode = req.query.mode === 'replace' ? 'replace' : 'merge';
  const report = importConfig(doc, { mode, userId: req.user.id });
  stopScheduler();
  startScheduler();
  audit(req.user, 'config.import', 'config', null, { mode, created: report.created.length, updated: report.updated.length, deleted: report.deleted.length });
  res.json(report);
}));

// ---------------- audit log ----------------
r.get('/audit', requireAdmin, (req, res) => {
  const limit = int(req.query.limit, { min: 1, max: 1000, def: 200 });
  const before = int(req.query.before, { def: Number.MAX_SAFE_INTEGER });
  const where = ['id < ?'];
  const args = [before];
  if (req.query.entityType) { where.push('entity_type = ?'); args.push(req.query.entityType); }
  if (req.query.q) { where.push('(action LIKE ? OR user_email LIKE ? OR details LIKE ?)'); args.push(...Array(3).fill(`%${req.query.q}%`)); }
  res.json(db.prepare(`SELECT * FROM audit_log WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`).all(...args, limit)
    .map((a) => ({ id: a.id, ts: a.ts, userEmail: a.user_email, action: a.action, entityType: a.entity_type, entityId: a.entity_id, details: j(a.details) })));
});

// ---------------- system info ----------------
r.get('/system', requireLogin, (req, res) => {
  res.json({
    version: config.version,
    uptimeSec: Math.round(process.uptime()),
    cpuPercent: cpuPercent(),
    cpuCount: cpuCount(),
    memoryMb: Math.round(process.memoryUsage().rss / 1048576),
    monitors: db.prepare('SELECT COUNT(*) AS n FROM monitors').get().n,
    scheduled: scheduledCount(),
    liveClients: clientCount(),
    activeRuns: activeRuns(),
    dataDir: config.dataDir,
  });
});

export default r;
