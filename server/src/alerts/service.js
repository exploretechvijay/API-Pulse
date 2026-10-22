// Alert lifecycle (ALR-01..07): raise on Down/Degraded, auto-close + recovery
// notice on Up, acknowledge/resolve, reminders, escalation, maintenance suppression.

import { db, now } from '../db.js';
import { publish } from '../events.js';
import { inMaintenance } from './maintenance.js';
import { sendToChannel, channelRows } from './channels.js';

export function toAlert(r) {
  if (!r) return null;
  return {
    id: r.id, monitorId: r.monitor_id, monitorName: r.monitor_name, environment: r.environment,
    type: r.type, status: r.status, message: r.message, startedAt: r.started_at, recoveredAt: r.recovered_at,
    acknowledgedBy: r.acknowledged_by, acknowledgedAt: r.acknowledged_at, resolvedBy: r.resolved_by,
    resolvedAt: r.resolved_at, suppressed: !!r.suppressed, lastNotifiedAt: r.last_notified_at,
    remindersSent: r.reminders_sent, escalatedAt: r.escalated_at,
  };
}

export const ALERT_SELECT = `SELECT a.*, m.name AS monitor_name, m.environment FROM alerts a JOIN monitors m ON m.id = a.monitor_id`;
export const getAlert = (id) => toAlert(db.prepare(`${ALERT_SELECT} WHERE a.id = ?`).get(id));

const openAlertFor = (monitorId) =>
  db.prepare(`SELECT * FROM alerts WHERE monitor_id = ? AND status != 'resolved' ORDER BY id DESC LIMIT 1`).get(monitorId);

async function notify(channelIds, evt, alertId) {
  const rows = channelRows(channelIds);
  await Promise.all(rows.map((r) => sendToChannel(r, evt, alertId)));
  return rows.length;
}

export async function onMonitorStateChange(monitor, prev, next, check) {
  const rules = monitor.alerts || {};
  const t = now();
  const suppressed = inMaintenance(monitor.id, t);
  const open = openAlertFor(monitor.id);
  const BAD = ['down', 'degraded'];

  // close any open alert when state moves on (recovered, or switched between down/degraded)
  if (open && (next === 'up' || (BAD.includes(next) && next !== open.type))) {
    db.prepare(`UPDATE alerts SET status = 'resolved', recovered_at = ?, resolved_at = COALESCE(resolved_at, ?),
      resolved_by = COALESCE(resolved_by, ?) WHERE id = ?`)
      .run(t, t, next === 'up' ? 'system (recovered)' : `system (now ${next})`, open.id);
    publish('alert', getAlert(open.id));
  }

  if (BAD.includes(next) && !(open && open.type === next)) {
    const r = db.prepare(`INSERT INTO alerts (monitor_id, type, status, message, started_at, suppressed) VALUES (?, ?, 'active', ?, ?, ?)`)
      .run(monitor.id, next, check?.error || null, t, suppressed ? 1 : 0);
    const alert = getAlert(r.lastInsertRowid);
    publish('alert', alert);
    const wanted = next === 'down' ? rules.onDown !== false : !!rules.onDegraded;
    if (wanted && !suppressed) {
      const sent = await notify(rules.channelIds, { kind: next, monitor, alert, check }, alert.id);
      if (sent) db.prepare('UPDATE alerts SET last_notified_at = ? WHERE id = ?').run(now(), alert.id);
    }
  }

  // recovery notice – only for alerts that actually went out
  if (next === 'up' && open && BAD.includes(prev) && rules.onRecovery !== false && !suppressed && open.last_notified_at) {
    await notify(rules.channelIds, { kind: 'recovered', monitor, alert: getAlert(open.id), check }, open.id);
  }
}

export function acknowledge(id, user) {
  const r = db.prepare(`UPDATE alerts SET status = 'acknowledged', acknowledged_by = ?, acknowledged_at = ?
    WHERE id = ? AND status = 'active'`).run(user.email, now(), id);
  const a = getAlert(id);
  if (r.changes) publish('alert', a);
  return a;
}

export function resolve(id, user) {
  const r = db.prepare(`UPDATE alerts SET status = 'resolved', resolved_by = ?, resolved_at = ?
    WHERE id = ? AND status != 'resolved'`).run(user.email, now(), id);
  const a = getAlert(id);
  if (r.changes) publish('alert', a);
  return a;
}

/** Reminders (ALR-05) and escalation (ALR-07); runs every 30 s. */
export async function alertTick() {
  const t = now();
  const rows = db.prepare(`SELECT a.*, m.alert_config, m.name AS monitor_name, m.request, m.environment, m.tags
    FROM alerts a JOIN monitors m ON m.id = a.monitor_id WHERE a.status = 'active' AND a.suppressed = 0`).all();
  for (const a of rows) {
    const rules = JSON.parse(a.alert_config || '{}');
    if (inMaintenance(a.monitor_id, t)) continue;
    const monitor = { id: a.monitor_id, name: a.monitor_name, request: JSON.parse(a.request), environment: a.environment, tags: JSON.parse(a.tags) };
    const alert = toAlert(a);
    const wanted = a.type === 'down' ? rules.onDown !== false : !!rules.onDegraded;
    if (!wanted) continue;
    if (rules.reminderMinutes > 0 && a.last_notified_at && t - a.last_notified_at >= rules.reminderMinutes * 60_000) {
      await notify(rules.channelIds, { kind: 'reminder', monitor, alert }, a.id);
      db.prepare('UPDATE alerts SET last_notified_at = ?, reminders_sent = reminders_sent + 1 WHERE id = ?').run(t, a.id);
    }
    if (rules.escalateAfterMinutes > 0 && !a.escalated_at && rules.escalationChannelIds?.length
      && t - a.started_at >= rules.escalateAfterMinutes * 60_000) {
      await notify(rules.escalationChannelIds, { kind: 'escalation', monitor, alert }, a.id);
      db.prepare('UPDATE alerts SET escalated_at = ? WHERE id = ?').run(t, a.id);
      publish('alert', getAlert(a.id));
    }
  }
}

let tickTimer = null;
export function startAlertTicker() {
  tickTimer = setInterval(() => alertTick().catch((e) => console.error('[alerts] tick', e)), 30_000);
  tickTimer.unref();
}
