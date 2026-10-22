// Runs every active monitor on its own interval (MON-03), records each check
// (MON-07), drives the state machine and hands state changes to the alert service.

import { db, j, now, getProfile } from '../db.js';
import { decryptJson } from '../crypto.js';
import { createAgents } from '../http/agent.js';
import { doRequest } from '../http/request.js';
import { buildRequest } from '../templating.js';
import { loadVariables } from '../variables.js';
import { publish } from '../events.js';
import { evaluate, nextState } from './rules.js';
import { effectiveSettings, getMonitorRow, toMonitor } from './model.js';
import { onMonitorStateChange } from '../alerts/service.js';

const timers = new Map();
const running = new Set();
let stopped = false;

export async function runCheck(id) {
  const row = getMonitorRow(id);
  if (!row) return null;
  if (running.has(id)) return null;
  running.add(id);
  try {
    const eff = effectiveSettings(row);
    const def = j(row.request, {});
    const auth = decryptJson(row.auth_enc);
    const built = buildRequest(def, auth, loadVariables());
    const rules = j(row.rules, {});

    let res;
    if (built.invalidUrl) {
      res = { ok: false, error: 'invalid_url', errorMessage: `Invalid URL after substitution: ${built.url}`, timings: { total: 0 } };
    } else if (built.missing.length) {
      res = { ok: false, error: 'missing_variable', errorMessage: `Unknown variable(s): ${built.missing.join(', ')}`, timings: { total: 0 } };
    } else {
      const agents = createAgents({ profile: getProfile(row.network_profile_id), keepAlive: false, rejectUnauthorized: !def.ignoreTls });
      res = await doRequest({ ...built, timeoutMs: eff.timeoutMs, agents,
        maxBodyBytes: rules.bodyContains || rules.jsonPath ? 2_000_000 : 0 });
      agents.destroy();
    }

    const { result, error } = evaluate(res, rules, eff.degradedMs);
    const ts = now();
    const fresh = getMonitorRow(id); // may have been edited/paused/deleted while the request ran
    if (!fresh) return null;

    db.prepare(`INSERT INTO checks (monitor_id, ts, result, status_code, response_ms, error, timings) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(id, ts, result, res.status || null, res.ok ? res.timings.total : null, error, res.ok ? JSON.stringify(res.timings) : null);

    const prevState = fresh.state;
    const ns = fresh.paused ? { state: prevState, consecutiveFailures: fresh.consecutive_failures }
      : nextState(prevState, fresh.consecutive_failures, result, eff.failureThreshold);
    const changed = ns.state !== prevState;
    db.prepare(`UPDATE monitors SET state = ?, consecutive_failures = ?, last_check_at = ?, last_response_ms = ?,
      last_status_code = ?, last_error = ?, state_changed_at = COALESCE(?, state_changed_at) WHERE id = ?`)
      .run(ns.state, ns.consecutiveFailures, ts, res.ok ? res.timings.total : null, res.status || null, error,
        changed ? ts : null, id);

    const monitor = toMonitor(getMonitorRow(id), { withAuth: false });
    const check = { monitorId: id, ts, result, statusCode: res.status || null, responseMs: res.ok ? res.timings.total : null, error, timings: res.timings };
    publish('check', { monitor, check });
    if (changed && !fresh.paused) {
      await onMonitorStateChange(monitor, prevState, ns.state, check).catch((e) => console.error('[alerts]', e));
    }
    return check;
  } finally {
    running.delete(id);
  }
}

function schedule(id, delayMs) {
  clearTimeout(timers.get(id));
  if (stopped) return;
  timers.set(id, setTimeout(async () => {
    const row = getMonitorRow(id);
    if (!row || row.paused) return void timers.delete(id);
    const started = Date.now();
    try { await runCheck(id); } catch (e) { console.error(`[scheduler] monitor ${id}:`, e); }
    const again = getMonitorRow(id);
    if (!again || again.paused) return void timers.delete(id);
    const intervalMs = effectiveSettings(again).intervalSec * 1000;
    schedule(id, Math.max(1000, intervalMs - (Date.now() - started)));
  }, delayMs));
}

/** Start (or restart) a monitor now – used on create, edit and resume. */
export function startMonitor(id, delayMs = 0) {
  schedule(id, delayMs);
}

export function stopMonitor(id) {
  clearTimeout(timers.get(id));
  timers.delete(id);
}

export function startScheduler() {
  stopped = false;
  const rows = db.prepare('SELECT id, interval_sec FROM monitors WHERE paused = 0').all();
  // spread the first checks over a few seconds so a restart doesn't fire everything at once
  const spread = Math.min(10_000, rows.length * 20);
  for (const r of rows) startMonitor(r.id, Math.floor(Math.random() * spread));
  console.log(`[scheduler] resumed ${rows.length} monitor(s)`);
}

export function stopScheduler() {
  stopped = true;
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
}

export const scheduledCount = () => timers.size;
