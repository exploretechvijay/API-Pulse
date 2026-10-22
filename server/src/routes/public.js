import { Router } from 'express';
import { db, getSetting } from '../db.js';
import { monitorSeries } from '../monitor/stats.js';
import { uptime24 } from '../monitor/model.js';

const r = Router();

r.get('/healthz', (req, res) => {
  try {
    db.prepare('SELECT 1').get();
    res.json({ status: 'ok' });
  } catch (e) {
    res.status(503).json({ status: 'error', error: e.message });
  }
});

/** Read-only public status page data (DSH-09). Only monitors flagged "show on status page". */
r.get('/public/status', (req, res) => {
  const sp = getSetting('statusPage');
  if (!sp.enabled) return res.status(404).json({ error: 'Status page is disabled' });
  const monitors = db.prepare('SELECT id, name, state, paused FROM monitors WHERE show_on_status_page = 1 ORDER BY name').all()
    .map((m) => {
      const s = monitorSeries(m.id, '90d');
      return {
        name: m.name,
        state: m.paused ? 'paused' : m.state,
        uptime24h: uptime24(m.id),
        uptime90d: s.summary.uptime,
        days: s.series.map((d) => ({ t: d.t, uptime: d.uptime })),
      };
    });
  const open = db.prepare(`SELECT a.type, a.started_at, m.name FROM alerts a JOIN monitors m ON m.id = a.monitor_id
    WHERE a.status != 'resolved' AND m.show_on_status_page = 1 AND a.suppressed = 0 ORDER BY a.started_at DESC`).all()
    .map((a) => ({ monitor: a.name, type: a.type, since: a.started_at }));
  res.json({ title: sp.title, monitors, incidents: open, updatedAt: Date.now() });
});

export default r;
