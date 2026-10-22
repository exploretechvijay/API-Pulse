// Time-series for the monitor detail page (DSH-05/07, US-08), hourly rollups
// and data retention (raw 30 d, rollups 1 y – configurable).

import fs from 'node:fs';
import path from 'node:path';
import { db, now, getSetting } from '../db.js';
import { percentile } from '../util.js';
import { config } from '../config.js';

const HOUR = 3600_000;
export const RANGES = {
  '1h': { ms: HOUR, bucket: 60_000 },
  '24h': { ms: 24 * HOUR, bucket: 15 * 60_000 },
  '7d': { ms: 7 * 24 * HOUR, bucket: 2 * HOUR },
  '30d': { ms: 30 * 24 * HOUR, bucket: 12 * HOUR },
  '90d': { ms: 90 * 24 * HOUR, bucket: 24 * HOUR },
};

const r2 = (n) => (n == null ? null : Math.round(n * 100) / 100);

function emptyBucket(t) {
  return { t, total: 0, ok: 0, slow: 0, fail: 0, sum: 0, n: 0, min: null, max: null, values: [], p95s: [] };
}

/** Series + summary for one monitor over a range. Raw checks where available, hourly rollups beyond. */
export function monitorSeries(monitorId, rangeKey = '24h') {
  const range = RANGES[rangeKey] || RANGES['24h'];
  const end = now();
  const start = end - range.ms;
  const firstBucket = Math.floor(start / range.bucket) * range.bucket;
  const buckets = new Map();
  const bucketFor = (t) => {
    const k = Math.floor(t / range.bucket) * range.bucket;
    if (!buckets.has(k)) buckets.set(k, emptyBucket(k));
    return buckets.get(k);
  };

  const rawFrom = Number(getSetting('rollup_cursor') || 0); // rollups cover hours < cursor
  const useRollupsUntil = rangeKey === '1h' || rangeKey === '24h' ? start : Math.min(rawFrom, end);
  const all = [];

  if (useRollupsUntil > start) {
    for (const r of db.prepare(`SELECT * FROM rollups_hourly WHERE monitor_id = ? AND hour >= ? AND hour < ? ORDER BY hour`)
      .all(monitorId, Math.floor(start / HOUR) * HOUR, useRollupsUntil)) {
      const b = bucketFor(r.hour);
      b.total += r.total; b.ok += r.ok; b.slow += r.slow; b.fail += r.fail;
      if (r.avg_ms != null) {
        const n = r.ok + r.slow;
        b.sum += r.avg_ms * n; b.n += n;
        b.min = b.min == null ? r.min_ms : Math.min(b.min, r.min_ms);
        b.max = b.max == null ? r.max_ms : Math.max(b.max, r.max_ms);
        b.p95s.push(r.p95_ms);
      }
    }
  }
  const rawStart = Math.max(start, useRollupsUntil);
  for (const c of db.prepare(`SELECT ts, result, response_ms FROM checks WHERE monitor_id = ? AND ts >= ? ORDER BY ts`)
    .all(monitorId, rawStart)) {
    const b = bucketFor(c.ts);
    b.total++; b[c.result]++;
    if (c.response_ms != null) {
      b.sum += c.response_ms; b.n++; b.values.push(c.response_ms); all.push(c.response_ms);
      b.min = b.min == null ? c.response_ms : Math.min(b.min, c.response_ms);
      b.max = b.max == null ? c.response_ms : Math.max(b.max, c.response_ms);
    }
  }

  const series = [];
  for (let t = firstBucket; t <= end; t += range.bucket) {
    const b = buckets.get(t) || emptyBucket(t);
    const sorted = b.values.sort((x, y) => x - y);
    series.push({
      t,
      total: b.total, ok: b.ok, slow: b.slow, fail: b.fail,
      avg: b.n ? r2(b.sum / b.n) : null,
      min: r2(b.min), max: r2(b.max),
      p95: sorted.length ? r2(percentile(sorted, 95)) : b.p95s.length ? r2(Math.max(...b.p95s)) : null,
      uptime: b.total ? r2(((b.ok + b.slow) / b.total) * 100) : null,
    });
  }

  const tot = series.reduce((a, s) => ({ total: a.total + s.total, up: a.up + s.ok + s.slow, slow: a.slow + s.slow, sum: a.sum + (s.avg ?? 0) * (s.ok + s.slow), n: a.n + (s.avg != null ? s.ok + s.slow : 0) }),
    { total: 0, up: 0, slow: 0, sum: 0, n: 0 });
  all.sort((a, b) => a - b);
  const incidents = db.prepare(`SELECT COUNT(*) AS n FROM alerts WHERE monitor_id = ? AND started_at >= ?`).get(monitorId, start).n;
  return {
    range: rangeKey, bucketMs: range.bucket, start, end, series,
    summary: {
      checks: tot.total,
      uptime: tot.total ? r2((tot.up / tot.total) * 100) : null,
      avgMs: tot.n ? r2(tot.sum / tot.n) : null,
      p95Ms: all.length ? r2(percentile(all, 95)) : null,
      p99Ms: all.length ? r2(percentile(all, 99)) : null,
      slowChecks: tot.slow,
      incidents,
    },
  };
}

/** Roll completed hours of raw checks into rollups_hourly. */
export function rollup() {
  const currentHour = Math.floor(now() / HOUR) * HOUR;
  let cursor = Number(getSetting('rollup_cursor') || 0);
  if (!cursor) {
    const first = db.prepare('SELECT MIN(ts) AS t FROM checks').get().t;
    if (!first) return;
    cursor = Math.floor(first / HOUR) * HOUR;
  }
  const ins = db.prepare(`INSERT OR REPLACE INTO rollups_hourly (monitor_id, hour, total, ok, slow, fail, avg_ms, min_ms, max_ms, p95_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const sel = db.prepare('SELECT monitor_id, result, response_ms FROM checks WHERE ts >= ? AND ts < ?');
  while (cursor < currentHour) {
    const groups = new Map();
    for (const c of sel.iterate(cursor, cursor + HOUR)) {
      if (!groups.has(c.monitor_id)) groups.set(c.monitor_id, { ok: 0, slow: 0, fail: 0, v: [] });
      const g = groups.get(c.monitor_id);
      g[c.result]++;
      if (c.response_ms != null) g.v.push(c.response_ms);
    }
    db.transaction(() => {
      for (const [id, g] of groups) {
        g.v.sort((a, b) => a - b);
        const avg = g.v.length ? g.v.reduce((a, b) => a + b, 0) / g.v.length : null;
        ins.run(id, cursor, g.ok + g.slow + g.fail, g.ok, g.slow, g.fail, avg, g.v[0] ?? null, g.v[g.v.length - 1] ?? null, percentile(g.v, 95));
      }
      cursor += HOUR;
      db.prepare(`INSERT INTO settings (key, value) VALUES ('rollup_cursor', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
        .run(String(cursor));
    })();
  }
}

export function applyRetention() {
  const ret = getSetting('retention');
  const t = now();
  const a = db.prepare('DELETE FROM checks WHERE ts < ?').run(t - ret.rawDays * 86400_000).changes;
  const b = db.prepare('DELETE FROM rollups_hourly WHERE hour < ?').run(t - ret.rollupDays * 86400_000).changes;
  const old = db.prepare(`SELECT id, raw_file FROM test_runs WHERE started_at < ? AND status NOT IN ('running','queued')`)
    .all(t - (ret.runDays || 365) * 86400_000);
  for (const r of old) {
    if (r.raw_file) fs.rm(path.join(config.runsDir, path.basename(r.raw_file)), { force: true }, () => {});
    db.prepare('DELETE FROM test_runs WHERE id = ?').run(r.id);
  }
  db.prepare('DELETE FROM notifications WHERE ts < ?').run(t - ret.rollupDays * 86400_000);
  db.prepare('DELETE FROM alerts WHERE started_at < ? AND status = ?').run(t - ret.rollupDays * 86400_000, 'resolved');
  if (a || b || old.length) console.log(`[retention] removed ${a} checks, ${b} rollups, ${old.length} runs`);
}

export function startMaintenanceJobs() {
  const job = () => { try { rollup(); applyRetention(); } catch (e) { console.error('[retention]', e); } };
  setTimeout(job, 5000).unref();
  setInterval(job, 10 * 60_000).unref();
}
