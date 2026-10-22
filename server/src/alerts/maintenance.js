// Maintenance windows (ALR-06). A window applies to the listed monitors
// (or every monitor when the list is empty). Recurring windows repeat the
// first occurrence's time span every day or week.

import { db, j } from '../db.js';

const PERIOD = { daily: 86400_000, weekly: 7 * 86400_000 };

export function windowActive(w, t = Date.now()) {
  const start = w.starts_at;
  const dur = w.ends_at - w.starts_at;
  if (t < start || dur <= 0) return false;
  if (w.recurrence === 'none' || !PERIOD[w.recurrence]) return t < w.ends_at;
  return (t - start) % PERIOD[w.recurrence] < dur;
}

export function activeWindowsFor(monitorId, t = Date.now()) {
  return db.prepare('SELECT * FROM maintenance_windows').all().filter((w) => {
    const ids = j(w.monitor_ids, []);
    return (ids.length === 0 || ids.includes(monitorId)) && windowActive(w, t);
  });
}

export const inMaintenance = (monitorId, t) => activeWindowsFor(monitorId, t).length > 0;

export function toWindow(w) {
  return { id: w.id, name: w.name, startsAt: w.starts_at, endsAt: w.ends_at, recurrence: w.recurrence,
    monitorIds: j(w.monitor_ids, []), active: windowActive(w), createdAt: w.created_at };
}
