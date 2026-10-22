// Main-thread side of latency/load tests: validation, allow-list, run records,
// worker lifecycle, live events, pass/fail criteria and scheduled runs.

import path from 'node:path';
import fs from 'node:fs';
import { Worker } from 'node:worker_threads';
import { db, j, now, getSetting, getProfile, profileFromRow } from '../db.js';
import { config } from '../config.js';
import { publish } from '../events.js';
import { audit } from '../audit.js';
import { cpuPercent } from '../cpu.js';
import { loadVariables } from '../variables.js';
import { buildRequest } from '../templating.js';
import { parseStatusExpr } from '../monitor/rules.js';
import { maskAuth, mergeAuth } from '../monitor/model.js';
import { encryptJson, decryptJson } from '../crypto.js';
import { HttpError, badRequest, int, str, hostAllowed } from '../util.js';
import { parseCsv } from './csv.js';

const active = new Map(); // runId -> { worker, kind, timeseries, cpuPeak, cpuHighTicks, eluHigh }
const MODES = ['fixed', 'ramp', 'stress', 'spike', 'soak'];

// ---------------------------------------------------------------- validation

function normaliseRequest(r = {}) {
  const method = String(r.method || 'GET').toUpperCase();
  const url = str(r.url, { required: true, name: 'URL', max: 4000 }).trim();
  return {
    method, url,
    headers: Array.isArray(r.headers) ? r.headers.filter((h) => h?.key) : [],
    query: Array.isArray(r.query) ? r.query.filter((h) => h?.key) : [],
    bodyType: ['none', 'json', 'text', 'form'].includes(r.bodyType) ? r.bodyType : 'none',
    body: str(r.body, { max: 5_000_000 }),
    ignoreTls: !!r.ignoreTls,
  };
}

function profilesFor(ids) {
  const list = (Array.isArray(ids) ? ids : [ids]).filter((x) => x != null && x !== '').map(Number);
  if (!list.length) return [profileFromRow(db.prepare(`SELECT * FROM network_profiles WHERE name = 'No throttling'`).get())];
  return list.map((id) => {
    const p = getProfile(id);
    if (!p) throw badRequest(`Unknown network profile ${id}`);
    return p;
  });
}

export function normaliseLatency(c) {
  const successStatus = str(c.successStatus, { def: '200-399' }) || '200-399';
  parseStatusExpr(successStatus);
  return {
    request: normaliseRequest(c.request),
    auth: c.auth || { type: 'none' },
    count: int(c.count, { min: 1, max: 10000, def: 20, name: 'Request count' }),
    delayMs: int(c.delayMs, { min: 0, max: 600000, def: 0, name: 'Delay' }),
    timeoutMs: int(c.timeoutMs, { min: 100, max: 300000, def: 30000, name: 'Timeout' }),
    keepAlive: !!c.keepAlive,
    successStatus,
    profileIds: (Array.isArray(c.profileIds) ? c.profileIds : []).map(Number),
  };
}

export function normaliseLoad(c) {
  const mode = MODES.includes(c.mode) ? c.mode : 'fixed';
  const loadType = c.loadType === 'rps' ? 'rps' : 'vus';
  const maxLevel = loadType === 'rps' ? 100000 : 10000;
  const lvl = (v, name, def) => int(v, { min: 1, max: maxLevel, def, name });
  const secs = (v, name, def, max = 86400) => int(v, { min: 1, max, def, name });
  const successStatus = str(c.successStatus, { def: '200-399' }) || '200-399';
  parseStatusExpr(successStatus);

  const rawSteps = Array.isArray(c.steps) && c.steps.length ? c.steps : [{ name: 'Request', request: c.request, auth: c.auth }];
  if (rawSteps.length > 20) throw badRequest('A scenario can have at most 20 steps');
  const steps = rawSteps.map((s, i) => {
    if (s.expectStatus) parseStatusExpr(s.expectStatus);
    return {
      name: str(s.name, { def: `Step ${i + 1}`, max: 100 }),
      request: normaliseRequest(s.request),
      auth: s.auth || { type: 'none' },
      expectStatus: s.expectStatus || '',
      extract: (Array.isArray(s.extract) ? s.extract : []).filter((e) => e?.var && e?.path)
        .map((e) => ({ var: String(e.var), source: ['json', 'header', 'regex'].includes(e.source) ? e.source : 'json', path: String(e.path) })),
    };
  });

  const out = {
    mode, loadType, steps, successStatus,
    vus: lvl(c.vus, 'Virtual users', 10),
    rps: lvl(c.rps, 'Requests/second', 50),
    durationSec: secs(c.durationSec, 'Duration', 60, mode === 'soak' ? 3 * 86400 : 86400),
    maxVus: int(c.maxVus, { min: 1, max: 20000, def: 1000, name: 'Max VUs' }),
    thinkTimeMs: int(c.thinkTimeMs, { min: 0, max: 60000, def: 0, name: 'Think time' }),
    timeoutMs: int(c.timeoutMs, { min: 100, max: 300000, def: 30000, name: 'Timeout' }),
    keepAlive: c.keepAlive !== false,
    ignoreTls: steps.some((s) => s.request.ignoreTls),
    profileId: c.profileId == null || c.profileId === '' ? null : Number(c.profileId),
    csv: str(c.csv, { max: 10_000_000 }),
    csvMode: c.csvMode === 'random' ? 'random' : 'sequential',
  };
  const r = c.ramp || {};
  out.ramp = { start: lvl(r.start, 'Ramp start', 1), target: lvl(r.target, 'Ramp target', 50), step: lvl(r.step, 'Ramp step', 10),
    stepDurationSec: secs(r.stepDurationSec, 'Step duration', 30), holdSec: secs(r.holdSec, 'Hold', 30) };
  if (out.ramp.target < out.ramp.start) throw badRequest('Ramp target must be ≥ start');
  const sp = c.spike || {};
  out.spike = { base: lvl(sp.base, 'Spike base', 5), peak: lvl(sp.peak, 'Spike peak', 100),
    baseDurationSec: secs(sp.baseDurationSec, 'Base duration', 30), spikeDurationSec: secs(sp.spikeDurationSec, 'Spike duration', 30),
    recoveryDurationSec: secs(sp.recoveryDurationSec, 'Recovery duration', 60) };
  const st = c.stress || {};
  out.stress = {
    start: lvl(st.start, 'Stress start', 10), step: lvl(st.step, 'Stress step', 10),
    stepDurationSec: secs(st.stepDurationSec, 'Step duration', 20), max: lvl(st.max, 'Max load', loadType === 'rps' ? 10000 : 1000),
    stopErrorRate: st.stopErrorRate === '' || st.stopErrorRate == null ? null : int(st.stopErrorRate, { min: 0, max: 100, name: 'Error-rate stop' }),
    stopP95Ms: st.stopP95Ms === '' || st.stopP95Ms == null ? null : int(st.stopP95Ms, { min: 1, max: 600000, name: 'p95 stop' }),
    stopOnPlateau: !!st.stopOnPlateau,
    plateauPct: int(st.plateauPct, { min: 0, max: 100, def: 5, name: 'Plateau growth %' }),
    plateauSteps: int(st.plateauSteps, { min: 1, max: 20, def: 2, name: 'Plateau steps' }),
  };
  // stress always stops at the hard maximum (stress.max), so other stop conditions are optional
  if (out.profileId != null && !getProfile(out.profileId)) throw badRequest('Unknown network profile');
  return out;
}

export function normalise(kind, c) {
  if (kind === 'latency') return normaliseLatency(c || {});
  if (kind === 'load') return normaliseLoad(c || {});
  throw badRequest('kind must be latency or load');
}

/** Secrets in test configs (auth fields) are masked for clients and restored on save. */
export function maskTestConfig(kind, c) {
  const out = structuredClone(c);
  if (kind === 'latency') out.auth = maskAuth(out.auth);
  else out.steps = (out.steps || []).map((s) => ({ ...s, auth: maskAuth(s.auth) }));
  return out;
}

export function unmaskTestConfig(kind, incoming, previous) {
  const out = structuredClone(incoming);
  if (kind === 'latency') out.auth = mergeAuth(out.auth, previous?.auth);
  else out.steps = (out.steps || []).map((s, i) => ({ ...s, auth: mergeAuth(s.auth, previous?.steps?.[i]?.auth) }));
  return out;
}

// ---------------------------------------------------------------- safety

/** Hosts a load test will hit, after variable + CSV substitution. */
export function loadTargets(cfg, vars) {
  const rows = cfg.csv ? parseCsv(cfg.csv).rows.slice(0, 1000) : [];
  const ctxs = rows.length ? rows.map((r) => ({ ...vars, ...r })) : [vars];
  const urls = new Set();
  for (const s of cfg.steps) for (const ctx of ctxs) urls.add(buildRequest(s.request, s.auth, ctx).url);
  const hosts = new Map();
  for (const u of urls) {
    try { const p = new URL(u); hosts.set(p.host, u); } catch { hosts.set(u, u); }
  }
  return [...hosts.entries()].map(([host, url]) => ({ host, url }));
}

export function preflight(kind, rawConfig) {
  const cfg = normalise(kind, rawConfig);
  const vars = loadVariables();
  if (kind !== 'load') return { allowed: true, targets: [], notAllowed: [], productionHosts: [] };
  const allow = getSetting('loadAllowlist');
  const targets = loadTargets(cfg, vars);
  const notAllowed = targets.filter((t) => !hostAllowed(t.url, allow)).map((t) => t.host);
  const prodHosts = new Set();
  for (const m of db.prepare(`SELECT request, environment, tags FROM monitors`).all()) {
    const isProd = /^prod/i.test(m.environment) || j(m.tags, []).some((t) => /^prod/i.test(t));
    if (!isProd) continue;
    try { prodHosts.add(new URL(buildRequest(j(m.request, {}), {}, vars).url).host); } catch { /* ignore */ }
  }
  const productionHosts = targets.filter((t) => prodHosts.has(t.host) || /(^|[.-])prod(uction)?([.-]|$)/i.test(t.host)).map((t) => t.host);
  let estimate = null;
  if (cfg.mode === 'fixed' || cfg.mode === 'soak') estimate = { durationSec: cfg.durationSec };
  else if (cfg.mode === 'ramp') estimate = { durationSec: Math.ceil((cfg.ramp.target - cfg.ramp.start) / cfg.ramp.step) * cfg.ramp.stepDurationSec + cfg.ramp.holdSec };
  else if (cfg.mode === 'spike') estimate = { durationSec: cfg.spike.baseDurationSec + cfg.spike.spikeDurationSec + cfg.spike.recoveryDurationSec };
  else estimate = { maxDurationSec: (Math.ceil((cfg.stress.max - cfg.stress.start) / cfg.stress.step) + 1) * cfg.stress.stepDurationSec };
  return { allowed: notAllowed.length === 0, targets: targets.map((t) => t.host), notAllowed, productionHosts, estimate, allowlist: allow };
}

// ---------------------------------------------------------------- pass criteria

export function evaluateCriteria(kind, summary, criteria = {}) {
  const checks = [];
  const add = (name, actual, limit, ok) => checks.push({ name, actual, limit, passed: ok });
  const rows = kind === 'latency'
    ? summary.profiles.map((p) => ({ label: p.profile.name, lat: p.stats, errorRate: p.errorRate, rps: null }))
    : [{ label: null, lat: summary.latency, errorRate: summary.errorRate, rps: summary.throughput.avg }];
  for (const r of rows) {
    const pre = r.label ? `${r.label}: ` : '';
    if (criteria.maxAvgMs != null && criteria.maxAvgMs !== '') add(`${pre}avg ≤ ${criteria.maxAvgMs} ms`, r.lat.avg, Number(criteria.maxAvgMs), r.lat.avg != null && r.lat.avg <= criteria.maxAvgMs);
    if (criteria.maxP95Ms != null && criteria.maxP95Ms !== '') add(`${pre}p95 ≤ ${criteria.maxP95Ms} ms`, r.lat.p95, Number(criteria.maxP95Ms), r.lat.p95 != null && r.lat.p95 <= criteria.maxP95Ms);
    if (criteria.maxP99Ms != null && criteria.maxP99Ms !== '') add(`${pre}p99 ≤ ${criteria.maxP99Ms} ms`, r.lat.p99, Number(criteria.maxP99Ms), r.lat.p99 != null && r.lat.p99 <= criteria.maxP99Ms);
    if (criteria.maxErrorRate != null && criteria.maxErrorRate !== '') add(`${pre}error rate ≤ ${criteria.maxErrorRate}%`, r.errorRate, Number(criteria.maxErrorRate), r.errorRate <= criteria.maxErrorRate);
    if (r.rps != null && criteria.minRps != null && criteria.minRps !== '') add(`throughput ≥ ${criteria.minRps} req/s`, r.rps, Number(criteria.minRps), r.rps >= criteria.minRps);
  }
  return { passed: checks.length ? checks.every((c) => c.passed) : null, checks };
}

// ---------------------------------------------------------------- runs

export function toRun(r, { full = true } = {}) {
  if (!r) return null;
  const out = {
    id: r.id, templateId: r.template_id, name: r.name, kind: r.kind, status: r.status, trigger: r.trigger,
    startedAt: r.started_at, finishedAt: r.finished_at, passed: r.passed == null ? null : !!r.passed,
    warnings: j(r.warnings, []), error: r.error, createdBy: r.created_by_email, hasRaw: !!r.raw_file,
    config: j(r.config, {}),
  };
  out.headline = j(r.headline, null);
  if (full) {
    out.summary = j(r.summary, null);
    out.timeseries = j(r.timeseries, null);
  }
  if (r.status === 'running' && active.has(r.id)) out.live = { timeseries: active.get(r.id).timeseries, cpu: cpuPercent() };
  return out;
}

export const getRun = (id, opts) => toRun(db.prepare('SELECT * FROM test_runs WHERE id = ?').get(id), opts);
export const activeRuns = () => [...active.keys()];

const waiters = new Map(); // runId -> [resolve]
export function waitForRun(id, timeoutMs) {
  const row = db.prepare('SELECT status FROM test_runs WHERE id = ?').get(id);
  if (!row || !['running', 'queued'].includes(row.status)) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(resolve, timeoutMs);
    const list = waiters.get(id) || [];
    list.push(() => { clearTimeout(t); resolve(); });
    waiters.set(id, list);
  });
}

/**
 * @param {object} o { kind, config, name, templateId, user, trigger, confirm, criteria }
 */
export function startRun(o) {
  const kind = o.kind;
  const cfg = normalise(kind, o.config);
  const vars = loadVariables();

  if (kind === 'load') {
    const pf = preflight(kind, o.config);
    if (!pf.allowed) {
      throw new HttpError(403, `Load tests are only allowed against hosts on the allow-list. Not allowed: ${pf.notAllowed.join(', ')}. An admin can add them under Settings → Load-test allow-list.`, { notAllowed: pf.notAllowed });
    }
    if (!o.confirm && o.trigger !== 'schedule') throw new HttpError(428, 'Load tests must be confirmed (send "confirm": true)');
    if ([...active.values()].some((a) => a.kind === 'load')) throw new HttpError(409, 'Another load test is already running – stop it first so results stay reliable');
  } else if ([...active.values()].filter((a) => a.kind === 'latency').length >= 5) {
    throw new HttpError(409, 'Too many latency tests running – wait for one to finish');
  }

  // resolve profiles + CSV for the worker
  const workerCfg = structuredClone(cfg);
  if (kind === 'latency') workerCfg.profiles = profilesFor(cfg.profileIds);
  else {
    workerCfg.profile = cfg.profileId ? getProfile(cfg.profileId) : null;
    workerCfg.csvRows = cfg.csv ? parseCsv(cfg.csv).rows : [];
    delete workerCfg.csv;
  }
  if (kind === 'latency') {
    const missing = buildRequest(cfg.request, cfg.auth, vars).missing;
    if (missing.length) throw badRequest(`Unknown variable(s): ${missing.join(', ')}`);
  } else {
    const csvCols = cfg.csv ? parseCsv(cfg.csv).columns : [];
    const extracted = cfg.steps.flatMap((s) => s.extract.map((e) => e.var));
    const ctx = { ...vars, ...Object.fromEntries([...csvCols, ...extracted].map((c) => [c, 'x'])) };
    const missing = [...new Set(cfg.steps.flatMap((s) => buildRequest(s.request, s.auth, ctx).missing))];
    if (missing.length) throw badRequest(`Unknown variable(s): ${missing.join(', ')}`);
  }

  // stored config: secrets masked, CSV kept (it is test data, not a secret)
  const stored = maskTestConfig(kind, cfg);
  stored.profileNames = kind === 'latency' ? workerCfg.profiles.map((p) => p.name) : [workerCfg.profile?.name || 'No throttling'];
  const name = str(o.name, { max: 200 }) || defaultName(kind, cfg);
  const t = now();
  const runId = db.prepare(`INSERT INTO test_runs (template_id, name, kind, config, status, trigger, started_at, created_by, created_by_email)
    VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?)`)
    .run(o.templateId ?? null, name, kind, JSON.stringify(stored), o.trigger || 'manual', t, o.user?.id ?? null, o.user?.email ?? 'system').lastInsertRowid;

  const rawFile = kind === 'load' ? path.join(config.runsDir, `run-${runId}.csv.gz`) : null;
  const worker = new Worker(new URL('./worker.js', import.meta.url), { workerData: { kind, config: workerCfg, vars, rawFile } });
  const state = { worker, kind, timeseries: [], cpuPeak: 0, cpuHighTicks: 0, eluHighTicks: 0, finished: false, criteria: o.criteria || {} };
  active.set(runId, state);
  audit(o.user, `test.run.${kind}`, 'run', runId, { name, trigger: o.trigger || 'manual', mode: cfg.mode, targets: kind === 'load' ? loadTargets(cfg, vars).map((x) => x.host) : undefined });

  worker.on('message', (m) => {
    if (m.type === 'tick') {
      const cpu = cpuPercent();
      const tick = { ...m.data, cpu };
      state.timeseries.push(tick);
      state.cpuPeak = Math.max(state.cpuPeak, cpu);
      if (cpu > config.cpuWarnPercent) state.cpuHighTicks++;
      if (m.data.elu > 90) state.eluHighTicks++;
      publish('run', { id: runId, type: 'tick', data: tick });
    } else if (m.type === 'progress' || m.type === 'stage' || m.type === 'stageDone') {
      publish('run', { id: runId, type: m.type, data: m.data });
    } else if (m.type === 'done') {
      finish(runId, state, m);
    } else if (m.type === 'error') {
      finish(runId, state, null, m.message);
    }
  });
  worker.on('error', (e) => finish(runId, state, null, e.stack || String(e)));
  worker.on('exit', (code) => { if (!state.finished) finish(runId, state, null, `Worker exited with code ${code}`); });

  publish('run', { id: runId, type: 'started', data: getRun(runId, { full: false }) });
  return runId;
}

function defaultName(kind, cfg) {
  const url = kind === 'latency' ? cfg.request.url : cfg.steps[0].request.url;
  let short = url;
  try { const u = new URL(url); short = u.host + u.pathname; } catch { /* keep */ }
  return kind === 'latency' ? `Latency · ${short}` : `${cfg.mode[0].toUpperCase()}${cfg.mode.slice(1)} load · ${short}`;
}

/** Compact numbers for run lists, so lists never parse full summaries. */
function headlineOf(kind, s) {
  if (kind === 'load') {
    return { requests: s.totalRequests, errorRate: s.errorRate, rps: s.throughput?.avg, peakRps: s.throughput?.peak,
      p95: s.latency?.p95, stopReason: s.stopReason, breakingPoint: s.breakingPoint, mode: s.mode };
  }
  return { profiles: s.profiles?.map((p) => ({ name: p.profile.name, p95: p.stats.p95, avg: p.stats.avg, errorRate: p.errorRate })) };
}

function finish(runId, state, msg, error) {
  if (state.finished) return;
  state.finished = true;
  active.delete(runId);
  const warnings = [...(msg?.warnings || [])];
  if (state.cpuHighTicks >= 2) {
    warnings.push(`The test machine's CPU was above ${config.cpuWarnPercent}% (peak ${state.cpuPeak}%) – results may be limited by this machine, not by the API.`);
  }
  if (state.eluHighTicks >= 2) {
    warnings.push('The load generator thread was saturated (event loop > 90% busy) – the measured throughput may be the tool\'s limit, not the API\'s. Reduce load or use a faster machine.');
  }
  const row = db.prepare('SELECT * FROM test_runs WHERE id = ?').get(runId);
  if (error) {
    db.prepare(`UPDATE test_runs SET status = 'failed', finished_at = ?, error = ?, warnings = ?, timeseries = ? WHERE id = ?`)
      .run(now(), String(error).slice(0, 4000), JSON.stringify(warnings), JSON.stringify(state.timeseries), runId);
    console.error(`[tests] run ${runId} failed: ${error}`);
  } else {
    const summary = msg.summary;
    let criteria = state.criteria;
    if (!criteria || !Object.keys(criteria).length) {
      const tpl = row.template_id ? db.prepare('SELECT pass_criteria FROM test_templates WHERE id = ?').get(row.template_id) : null;
      criteria = j(tpl?.pass_criteria, {});
    }
    const evaln = evaluateCriteria(row.kind, summary, criteria);
    summary.criteria = evaln;
    const status = summary.stopReason === 'stopped_by_user' ? 'stopped' : 'completed';
    const rawFile = row.kind === 'load' && fs.existsSync(path.join(config.runsDir, `run-${runId}.csv.gz`)) ? `run-${runId}.csv.gz` : null;
    // timeseries from the worker carries no CPU; merge it from what we recorded
    const ts = (msg.timeseries || state.timeseries).map((t, i) => ({ ...t, cpu: state.timeseries[i]?.cpu ?? null }));
    db.prepare(`UPDATE test_runs SET status = ?, finished_at = ?, summary = ?, headline = ?, timeseries = ?, warnings = ?, passed = ?, raw_file = ? WHERE id = ?`)
      .run(status, now(), JSON.stringify(summary), JSON.stringify(headlineOf(row.kind, summary)), JSON.stringify(ts), JSON.stringify(warnings),
        evaln.passed == null ? null : evaln.passed ? 1 : 0, rawFile, runId);
  }
  publish('run', { id: runId, type: 'finished', data: getRun(runId, { full: false }) });
  for (const w of waiters.get(runId) || []) w();
  waiters.delete(runId);
}

export function stopRun(runId, user) {
  const st = active.get(runId);
  if (!st) throw new HttpError(409, 'Run is not active');
  st.worker.postMessage({ type: 'stop' });
  audit(user, 'test.stop', 'run', runId);
  setTimeout(() => { if (!st.finished) st.worker.terminate(); }, 15_000).unref();
}

/** Called on boot: runs that were active when the process died are marked failed. */
export function recoverRuns() {
  db.prepare(`UPDATE test_runs SET status = 'failed', error = 'Server restarted while the test was running', finished_at = ?
    WHERE status IN ('running','queued')`).run(now());
}

// ---------------------------------------------------------------- templates & schedules (CFG-02, CFG-06)

export function toTemplate(r, { reveal = false } = {}) {
  const cfg = decryptJson(r.config);
  return {
    id: r.id, name: r.name, kind: r.kind,
    config: reveal ? cfg : maskTestConfig(r.kind, cfg),
    schedule: j(r.schedule, {}), passCriteria: j(r.pass_criteria, {}),
    lastScheduledAt: r.last_scheduled_at, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

export function templateColumns(body, existing) {
  const kind = body.kind ?? existing?.kind;
  if (!['latency', 'load'].includes(kind)) throw badRequest('kind must be latency or load');
  const prevCfg = existing ? decryptJson(existing.config) : null;
  const rawCfg = unmaskTestConfig(kind, body.config ?? prevCfg ?? {}, prevCfg);
  normalise(kind, rawCfg); // validate
  const sch = body.schedule ?? j(existing?.schedule, {});
  const schedule = {
    enabled: !!sch.enabled,
    type: sch.type === 'daily' ? 'daily' : 'interval',
    everyMinutes: int(sch.everyMinutes, { min: 5, max: 10080, def: 1440, name: 'Schedule interval' }),
    time: /^\d{2}:\d{2}$/.test(sch.time || '') ? sch.time : '02:00',
  };
  const pc = body.passCriteria ?? j(existing?.pass_criteria, {});
  const num = (v) => (v === '' || v == null ? null : Number(v));
  const passCriteria = { maxAvgMs: num(pc.maxAvgMs), maxP95Ms: num(pc.maxP95Ms), maxP99Ms: num(pc.maxP99Ms), maxErrorRate: num(pc.maxErrorRate), minRps: num(pc.minRps) };
  return {
    name: str(body.name ?? existing?.name, { required: true, max: 200, name: 'Name' }),
    kind,
    config: encryptJson(rawCfg),
    schedule: JSON.stringify(schedule),
    pass_criteria: JSON.stringify(passCriteria),
  };
}

export function runTemplate(id, user, { trigger = 'manual', confirm = false } = {}) {
  const r = db.prepare('SELECT * FROM test_templates WHERE id = ?').get(id);
  if (!r) throw new HttpError(404, 'Saved test not found');
  return startRun({ kind: r.kind, config: decryptJson(r.config), name: r.name, templateId: r.id, user, trigger, confirm,
    criteria: j(r.pass_criteria, {}) });
}

function isDue(tpl, t) {
  const s = j(tpl.schedule, {});
  if (!s.enabled) return false;
  const last = tpl.last_scheduled_at || 0;
  if (s.type === 'daily') {
    const [h, m] = s.time.split(':').map(Number);
    const d = new Date(t);
    d.setHours(h, m, 0, 0);
    if (d.getTime() > t) d.setDate(d.getDate() - 1);
    return last < d.getTime() && t - d.getTime() < 3600_000;
  }
  return t - last >= s.everyMinutes * 60_000;
}

export function startTestScheduler() {
  setInterval(() => {
    const t = now();
    for (const tpl of db.prepare('SELECT * FROM test_templates').all()) {
      if (!isDue(tpl, t)) continue;
      try {
        runTemplate(tpl.id, null, { trigger: 'schedule' });
        db.prepare('UPDATE test_templates SET last_scheduled_at = ? WHERE id = ?').run(t, tpl.id);
      } catch (e) {
        if (e.status !== 409) {
          console.error(`[tests] scheduled run of "${tpl.name}" failed: ${e.message}`);
          db.prepare('UPDATE test_templates SET last_scheduled_at = ? WHERE id = ?').run(t, tpl.id);
        } // 409 = busy, try again next minute
      }
    }
  }, 60_000).unref();
}
