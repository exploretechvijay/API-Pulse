import { db, j, now, getSetting } from '../db.js';
import { encryptJson, decryptJson, SECRET_MASK } from '../crypto.js';
import { badRequest, int, str } from '../util.js';
import { parseStatusExpr } from './rules.js';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
const SECRET_AUTH_FIELDS = ['token', 'password', 'value'];

export function maskAuth(auth) {
  const a = { ...(auth || { type: 'none' }) };
  for (const f of SECRET_AUTH_FIELDS) if (a[f]) a[f] = SECRET_MASK;
  return a;
}

/** Keep previous secret values where the client sent back the mask. */
export function mergeAuth(incoming, previous) {
  const a = { type: 'none', ...(incoming || {}) };
  for (const f of SECRET_AUTH_FIELDS) if (a[f] === SECRET_MASK) a[f] = previous?.[f] ?? '';
  return a;
}

export function effectiveSettings(m) {
  const d = getSetting('defaults');
  return {
    intervalSec: m.interval_sec ?? d.intervalSec,
    timeoutMs: m.timeout_ms ?? d.timeoutMs,
    failureThreshold: m.failure_threshold ?? d.failureThreshold,
    degradedMs: j(m.rules, {}).degradedMs ?? d.degradedMs ?? null,
  };
}

export function uptime24(monitorId) {
  const r = db.prepare(`SELECT COUNT(*) AS total, SUM(result != 'fail') AS up FROM checks WHERE monitor_id = ? AND ts > ?`)
    .get(monitorId, now() - 86400_000);
  return r.total ? Math.round((r.up / r.total) * 10000) / 100 : null;
}

/** Row → API object. */
export function toMonitor(row, { withAuth = true, withUptime = true } = {}) {
  if (!row) return null;
  const eff = effectiveSettings(row);
  const m = {
    id: row.id,
    name: row.name,
    description: row.description,
    request: j(row.request, {}),
    intervalSec: row.interval_sec,
    timeoutMs: row.timeout_ms,
    failureThreshold: row.failure_threshold,
    effective: eff,
    rules: j(row.rules, {}),
    tags: j(row.tags, []),
    project: row.project,
    environment: row.environment,
    networkProfileId: row.network_profile_id,
    alerts: j(row.alert_config, {}),
    showOnStatusPage: !!row.show_on_status_page,
    paused: !!row.paused,
    state: row.paused ? 'paused' : row.state,
    consecutiveFailures: row.consecutive_failures,
    lastCheckAt: row.last_check_at,
    lastResponseMs: row.last_response_ms,
    lastStatusCode: row.last_status_code,
    lastError: row.last_error,
    stateChangedAt: row.state_changed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (withAuth) m.auth = maskAuth(decryptJson(row.auth_enc));
  if (withUptime) m.uptime24h = uptime24(row.id);
  return m;
}

export const getMonitorRow = (id) => db.prepare('SELECT * FROM monitors WHERE id = ?').get(id);

function cleanKv(list) {
  if (!Array.isArray(list)) return [];
  return list.filter((x) => x && String(x.key || '').trim())
    .map((x) => ({ key: String(x.key).trim(), value: String(x.value ?? ''), ...(x.enabled === false ? { enabled: false } : {}) }));
}

/** Validates API input and returns column values. */
export function monitorColumns(body, existingRow) {
  const prev = existingRow ? toMonitor(existingRow, { withAuth: false, withUptime: false }) : null;
  const src = { ...(prev || {}), ...body };
  const reqIn = { ...(prev?.request || {}), ...(body.request || {}) };

  const name = str(src.name, { required: true, max: 200, name: 'Name' }).trim();
  const url = str(reqIn.url, { required: true, max: 4000, name: 'URL' }).trim();
  if (!/^https?:\/\//i.test(url) && !/^\{\{/.test(url)) throw badRequest('URL must start with http:// or https://');
  const method = String(reqIn.method || 'GET').toUpperCase();
  if (!METHODS.includes(method)) throw badRequest(`Method must be one of ${METHODS.join(', ')}`);

  const request = {
    method, url,
    headers: cleanKv(reqIn.headers),
    query: cleanKv(reqIn.query),
    bodyType: ['none', 'json', 'text', 'form'].includes(reqIn.bodyType) ? reqIn.bodyType : 'none',
    body: str(reqIn.body, { max: 1_000_000, name: 'Body' }),
    ignoreTls: !!reqIn.ignoreTls,
  };

  const rulesIn = src.rules || {};
  const expectedStatus = str(rulesIn.expectedStatus, { def: '200-299', max: 200 }).trim() || '200-299';
  parseStatusExpr(expectedStatus); // throws if invalid
  const rules = {
    expectedStatus,
    degradedMs: int(rulesIn.degradedMs, { min: 1, max: 600000, name: 'Degraded threshold' }),
    bodyContains: str(rulesIn.bodyContains, { max: 2000 }),
    jsonPath: str(rulesIn.jsonPath, { max: 500 }),
    jsonOperator: ['equals', 'notEquals', 'contains', 'exists'].includes(rulesIn.jsonOperator) ? rulesIn.jsonOperator : 'equals',
    jsonExpected: str(rulesIn.jsonExpected, { max: 2000 }),
  };

  const a = src.alerts || {};
  const ids = (v) => (Array.isArray(v) ? v.map(Number).filter(Number.isFinite) : []);
  const alerts = {
    onDown: a.onDown !== false,
    onDegraded: !!a.onDegraded,
    onRecovery: a.onRecovery !== false,
    channelIds: ids(a.channelIds),
    reminderMinutes: int(a.reminderMinutes, { min: 0, max: 10080, def: 0, name: 'Reminder interval' }),
    escalateAfterMinutes: int(a.escalateAfterMinutes, { min: 0, max: 10080, def: 0, name: 'Escalation delay' }),
    escalationChannelIds: ids(a.escalationChannelIds),
  };

  let profileId = src.networkProfileId == null || src.networkProfileId === '' ? null : Number(src.networkProfileId);
  if (profileId != null && !db.prepare('SELECT 1 FROM network_profiles WHERE id = ?').get(profileId)) throw badRequest('Unknown network profile');
  const noThrottle = db.prepare(`SELECT id FROM network_profiles WHERE name = 'No throttling'`).get();
  if (profileId === noThrottle?.id) profileId = null;

  const prevAuth = existingRow ? decryptJson(existingRow.auth_enc) : {};
  const authIn = body.auth !== undefined ? body.auth : prevAuth;
  const auth = mergeAuth(authIn, prevAuth);
  if (!['none', 'bearer', 'basic', 'apiKey'].includes(auth.type)) throw badRequest('Invalid auth type');

  const tags = (Array.isArray(src.tags) ? src.tags : String(src.tags || '').split(','))
    .map((t) => String(t).trim()).filter(Boolean).slice(0, 30);

  return {
    name,
    description: str(src.description, { max: 2000 }),
    request: JSON.stringify(request),
    auth_enc: encryptJson(auth),
    interval_sec: int(src.intervalSec, { min: 10, max: 86400, name: 'Interval' }),
    timeout_ms: int(src.timeoutMs, { min: 100, max: 300000, name: 'Timeout' }),
    failure_threshold: int(src.failureThreshold, { min: 1, max: 100, name: 'Failure threshold' }),
    rules: JSON.stringify(rules),
    tags: JSON.stringify(tags),
    project: str(src.project, { max: 200 }).trim(),
    environment: str(src.environment, { max: 100 }).trim(),
    network_profile_id: profileId,
    alert_config: JSON.stringify(alerts),
    show_on_status_page: src.showOnStatusPage ? 1 : 0,
    paused: src.paused ? 1 : 0,
  };
}

export function insertMonitor(cols, userId) {
  const t = now();
  const keys = Object.keys(cols);
  const r = db.prepare(`INSERT INTO monitors (${keys.join(', ')}, created_by, created_at, updated_at)
    VALUES (${keys.map(() => '?').join(', ')}, ?, ?, ?)`).run(...keys.map((k) => cols[k]), userId ?? null, t, t);
  return r.lastInsertRowid;
}

export function updateMonitor(id, cols) {
  const keys = Object.keys(cols);
  db.prepare(`UPDATE monitors SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
    .run(...keys.map((k) => cols[k]), now(), id);
}
