import { Router } from 'express';
import { db, now } from '../db.js';
import { ah, notFound, badRequest, int, str } from '../util.js';
import { audit } from '../audit.js';
import { requireLogin, requireEditor } from '../auth.js';
import { publish } from '../events.js';
import { ALERT_SELECT, toAlert, acknowledge, resolve } from '../alerts/service.js';
import { toChannel, channelColumns, sendToChannel } from '../alerts/channels.js';
import { toWindow } from '../alerts/maintenance.js';

const r = Router();

// ---------------- alerts ----------------
r.get('/alerts', requireLogin, (req, res) => {
  const status = req.query.status || 'open';
  const limit = int(req.query.limit, { min: 1, max: 1000, def: 200 });
  const where = status === 'open' ? `WHERE a.status != 'resolved'` : status === 'all' ? '' : `WHERE a.status = ?`;
  const args = status === 'open' || status === 'all' ? [] : [status];
  res.json(db.prepare(`${ALERT_SELECT} ${where} ORDER BY a.started_at DESC LIMIT ?`).all(...args, limit).map(toAlert));
});

r.post('/alerts/:id/ack', requireEditor, ah(async (req, res) => {
  const a = acknowledge(Number(req.params.id), req.user);
  if (!a) throw notFound('Alert');
  audit(req.user, 'alert.acknowledge', 'alert', a.id, { monitor: a.monitorName });
  res.json(a);
}));

r.post('/alerts/:id/resolve', requireEditor, ah(async (req, res) => {
  const a = resolve(Number(req.params.id), req.user);
  if (!a) throw notFound('Alert');
  audit(req.user, 'alert.resolve', 'alert', a.id, { monitor: a.monitorName });
  res.json(a);
}));

r.get('/alerts/:id/notifications', requireLogin, (req, res) => {
  res.json(db.prepare('SELECT * FROM notifications WHERE alert_id = ? ORDER BY ts').all(req.params.id)
    .map((n) => ({ id: n.id, channel: n.channel_name, kind: n.kind, ok: !!n.ok, error: n.error, ts: n.ts })));
});

// ---------------- channels ----------------
const loadChannel = (id) => { const c = db.prepare('SELECT * FROM channels WHERE id = ?').get(id); if (!c) throw notFound('Channel'); return c; };

r.get('/channels', requireLogin, (req, res) => {
  res.json(db.prepare('SELECT * FROM channels ORDER BY name').all().map((c) => toChannel(c)));
});

r.post('/channels', requireEditor, ah(async (req, res) => {
  const c = channelColumns(req.body || {}, null);
  const t = now();
  const id = db.prepare('INSERT INTO channels (name, type, config_enc, enabled, is_default, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(c.name, c.type, c.config_enc, c.enabled, c.is_default, t, t).lastInsertRowid;
  audit(req.user, 'channel.create', 'channel', id, { name: c.name, type: c.type });
  res.status(201).json(toChannel(loadChannel(id)));
}));

r.put('/channels/:id', requireEditor, ah(async (req, res) => {
  const ex = loadChannel(req.params.id);
  const c = channelColumns(req.body || {}, ex);
  db.prepare('UPDATE channels SET name = ?, type = ?, config_enc = ?, enabled = ?, is_default = ?, updated_at = ? WHERE id = ?')
    .run(c.name, c.type, c.config_enc, c.enabled, c.is_default, now(), ex.id);
  audit(req.user, 'channel.update', 'channel', ex.id, { name: c.name });
  res.json(toChannel(loadChannel(ex.id)));
}));

r.delete('/channels/:id', requireEditor, ah(async (req, res) => {
  const ex = loadChannel(req.params.id);
  db.prepare('DELETE FROM channels WHERE id = ?').run(ex.id);
  audit(req.user, 'channel.delete', 'channel', ex.id, { name: ex.name });
  res.json({ ok: true });
}));

r.post('/channels/:id/test', requireEditor, ah(async (req, res) => {
  const ex = loadChannel(req.params.id);
  const out = await sendToChannel(ex, { kind: 'test' });
  audit(req.user, 'channel.test', 'channel', ex.id, { ok: out.ok });
  res.json(out);
}));

// ---------------- maintenance windows ----------------
function windowInput(b) {
  const startsAt = typeof b.startsAt === 'number' ? b.startsAt : Date.parse(b.startsAt);
  const endsAt = typeof b.endsAt === 'number' ? b.endsAt : Date.parse(b.endsAt);
  if (!startsAt || !endsAt) throw badRequest('Start and end are required');
  if (endsAt <= startsAt) throw badRequest('End must be after start');
  const recurrence = ['none', 'daily', 'weekly'].includes(b.recurrence) ? b.recurrence : 'none';
  if (recurrence === 'daily' && endsAt - startsAt >= 86400_000) throw badRequest('A daily window must be shorter than 24 hours');
  if (recurrence === 'weekly' && endsAt - startsAt >= 7 * 86400_000) throw badRequest('A weekly window must be shorter than 7 days');
  return {
    name: str(b.name, { required: true, max: 200, name: 'Name' }),
    starts_at: startsAt, ends_at: endsAt, recurrence,
    monitor_ids: JSON.stringify((Array.isArray(b.monitorIds) ? b.monitorIds : []).map(Number).filter(Number.isFinite)),
  };
}

r.get('/maintenance', requireLogin, (req, res) => {
  res.json(db.prepare('SELECT * FROM maintenance_windows ORDER BY starts_at DESC').all().map(toWindow));
});

r.post('/maintenance', requireEditor, ah(async (req, res) => {
  const w = windowInput(req.body || {});
  const id = db.prepare('INSERT INTO maintenance_windows (name, starts_at, ends_at, recurrence, monitor_ids, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(w.name, w.starts_at, w.ends_at, w.recurrence, w.monitor_ids, req.user.id, now()).lastInsertRowid;
  audit(req.user, 'maintenance.create', 'maintenance', id, { name: w.name });
  publish('maintenance', {});
  res.status(201).json(toWindow(db.prepare('SELECT * FROM maintenance_windows WHERE id = ?').get(id)));
}));

r.put('/maintenance/:id', requireEditor, ah(async (req, res) => {
  const ex = db.prepare('SELECT * FROM maintenance_windows WHERE id = ?').get(req.params.id);
  if (!ex) throw notFound('Maintenance window');
  const w = windowInput({ ...toWindow(ex), ...req.body });
  db.prepare('UPDATE maintenance_windows SET name = ?, starts_at = ?, ends_at = ?, recurrence = ?, monitor_ids = ? WHERE id = ?')
    .run(w.name, w.starts_at, w.ends_at, w.recurrence, w.monitor_ids, ex.id);
  audit(req.user, 'maintenance.update', 'maintenance', ex.id, { name: w.name });
  publish('maintenance', {});
  res.json(toWindow(db.prepare('SELECT * FROM maintenance_windows WHERE id = ?').get(ex.id)));
}));

r.delete('/maintenance/:id', requireEditor, ah(async (req, res) => {
  const ex = db.prepare('SELECT * FROM maintenance_windows WHERE id = ?').get(req.params.id);
  if (!ex) throw notFound('Maintenance window');
  db.prepare('DELETE FROM maintenance_windows WHERE id = ?').run(ex.id);
  audit(req.user, 'maintenance.delete', 'maintenance', ex.id, { name: ex.name });
  publish('maintenance', {});
  res.json({ ok: true });
}));

export default r;
