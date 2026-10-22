// Load engine (LOAD-01..08). Runs inside a worker thread.
//
// Every mode is a sequence of *stages*; a stage holds a load *level* for some
// seconds. The level is either a number of virtual users (closed model: each
// VU loops iterations back-to-back) or a request rate (open model: iterations
// start at a fixed arrival rate, capped by maxVus concurrent iterations).
//
//   fixed / soak : one stage
//   ramp         : start → target in steps, then a final hold at target
//   spike        : base → spike → base (recovery)
//   stress       : start, +step each stage, until a stop condition triggers
//
// Every request is recorded (latency, status, error, stage, scenario step) so
// percentiles are exact and the raw data can be exported.

import fs from 'node:fs';
import zlib from 'node:zlib';
import { performance } from 'node:perf_hooks';
import { createAgents } from '../http/agent.js';
import { doRequest } from '../http/request.js';
import { buildRequest, jsonPath } from '../templating.js';
import { parseStatusExpr } from '../monitor/rules.js';
import { summarize, median, r2 } from './stats.js';
import { sleep } from '../util.js';

const RAW_CAP = 20_000_000;

class Recorder {
  constructor() {
    this.size = 1 << 16;
    this.n = 0;
    this.alloc(this.size);
    this.errTypes = [null];
    this.errIndex = new Map();
    this.total = 0;
    this.errors = 0;
    this.statusCounts = {};
    this.errorCounts = {};
    this.bytesIn = 0;
    this.bytesOut = 0;
    this.capped = false;
    this.bucket = this.newBucket();
  }
  alloc(size, old) {
    const mk = (T, prev) => { const a = new T(size); if (prev) a.set(prev.subarray(0, this.n)); return a; };
    this.t = mk(Float32Array, old?.t);
    this.lat = mk(Float32Array, old?.lat);
    this.status = mk(Uint16Array, old?.status);
    this.err = mk(Uint8Array, old?.err);
    this.stage = mk(Uint16Array, old?.stage);
    this.step = mk(Uint8Array, old?.step);
  }
  newBucket() { return { n: 0, errors: 0, lat: [] }; }
  errCode(name) {
    if (!this.errIndex.has(name)) {
      if (this.errTypes.length >= 255) return 255;
      this.errIndex.set(name, this.errTypes.length);
      this.errTypes.push(name);
    }
    return this.errIndex.get(name);
  }
  record(tMs, latency, status, errName, stage, step, bytesIn, bytesOut) {
    this.total++;
    this.bytesIn += bytesIn;
    this.bytesOut += bytesOut;
    if (status) this.statusCounts[status] = (this.statusCounts[status] || 0) + 1;
    if (errName) { this.errors++; this.errorCounts[errName] = (this.errorCounts[errName] || 0) + 1; }
    const b = this.bucket;
    b.n++;
    if (errName) b.errors++;
    if (latency != null) b.lat.push(latency);
    if (this.n >= RAW_CAP) { this.capped = true; return; }
    if (this.n >= this.size) {
      const old = { t: this.t, lat: this.lat, status: this.status, err: this.err, stage: this.stage, step: this.step };
      this.size *= 2;
      this.alloc(this.size, old);
    }
    const i = this.n++;
    this.t[i] = tMs;
    this.lat[i] = latency == null ? NaN : latency;
    this.status[i] = status || 0;
    this.err[i] = errName ? this.errCode(errName) : 0;
    this.stage[i] = stage;
    this.step[i] = step;
  }
  takeBucket() { const b = this.bucket; this.bucket = this.newBucket(); return b; }
  latencies(from = 0, to = this.n, pred) {
    const out = [];
    for (let i = from; i < to; i++) if (!Number.isNaN(this.lat[i]) && (!pred || pred(i))) out.push(this.lat[i]);
    return out;
  }
  countErrors(from, to) {
    let e = 0;
    for (let i = from; i < to; i++) if (this.err[i]) e++;
    return e;
  }
}

function extractValue(res, ex) {
  if (ex.source === 'header') return res.headers[String(ex.path).toLowerCase()];
  if (ex.source === 'regex') {
    try { const m = res.body.match(new RegExp(ex.path)); return m ? (m[1] ?? m[0]) : undefined; } catch { return undefined; }
  }
  try { const v = jsonPath(JSON.parse(res.body), ex.path); return typeof v === 'object' ? JSON.stringify(v) : v; } catch { return undefined; }
}

/** Builds the list of stages for non-stress modes. */
export function planStages(cfg) {
  const L = cfg.loadType === 'rps' ? cfg.rps : cfg.vus;
  switch (cfg.mode) {
    case 'ramp': {
      const { start, target, step, stepDurationSec } = cfg.ramp;
      const stages = [];
      for (let lvl = start; lvl < target; lvl += step) stages.push({ level: lvl, durationSec: stepDurationSec });
      stages.push({ level: target, durationSec: cfg.ramp.holdSec ?? stepDurationSec });
      return stages;
    }
    case 'spike':
      return [
        { level: cfg.spike.base, durationSec: cfg.spike.baseDurationSec },
        { level: cfg.spike.peak, durationSec: cfg.spike.spikeDurationSec },
        { level: cfg.spike.base, durationSec: cfg.spike.recoveryDurationSec },
      ];
    default: // fixed, soak
      return [{ level: L, durationSec: cfg.durationSec }];
  }
}

export async function runLoad(cfg, vars, ctl, emit, rawFile) {
  const rec = new Recorder();
  const rpsMode = cfg.loadType === 'rps';
  const agents = createAgents({ profile: cfg.profile?.id ? cfg.profile : null, keepAlive: cfg.keepAlive !== false,
    rejectUnauthorized: !cfg.ignoreTls });
  const steps = cfg.steps.map((s) => {
    const needsVars = JSON.stringify([s.request, s.auth]).includes('{{') || cfg.csvRows.length > 0;
    return { ...s, isOk: parseStatusExpr(s.expectStatus || cfg.successStatus),
      prebuilt: needsVars ? null : buildRequest(s.request, s.auth, vars) };
  });

  const t0 = performance.now();
  const elapsed = () => performance.now() - t0;
  let recording = true;
  let ended = false;
  let level = 0;
  let stageIdx = 0;
  let inflight = 0;
  let iterations = 0;
  let dropped = 0;
  const running = new Set();
  const timeseries = [];
  const stages = [];
  const warnings = [];

  async function iteration() {
    const n = iterations++;
    let local = vars;
    if (cfg.csvRows.length) {
      const row = cfg.csvMode === 'random' ? cfg.csvRows[Math.floor(Math.random() * cfg.csvRows.length)] : cfg.csvRows[n % cfg.csvRows.length];
      local = { ...vars, ...row };
    }
    inflight++;
    try {
      for (let si = 0; si < steps.length; si++) {
        const st = steps[si];
        const built = st.prebuilt || buildRequest(st.request, st.auth, local);
        const res = await doRequest({ ...built, timeoutMs: cfg.timeoutMs, agents, maxBodyBytes: st.extract?.length ? 1_000_000 : 0 });
        if (!recording) return;
        const ok = res.ok && st.isOk(res.status);
        const errName = ok ? null : res.ok ? `HTTP ${res.status}` : res.error;
        rec.record(elapsed(), res.ok ? res.timings.total : null, res.status, errName, stageIdx, si, res.bytesReceived || 0, res.bytesSent || 0);
        if (!ok) return;
        if (st.extract?.length) {
          if (local === vars) local = { ...vars };
          for (const ex of st.extract) { const v = extractValue(res, ex); if (v !== undefined) local[ex.var] = v; }
        }
      }
    } finally {
      inflight--;
    }
  }

  // ---- closed model: virtual users ----
  async function vu(id) {
    running.add(id);
    try {
      while (!ended && id < level) {
        await iteration();
        if (cfg.thinkTimeMs && !ended) await sleep(cfg.thinkTimeMs);
      }
    } finally {
      running.delete(id);
    }
  }
  const spawnVus = () => { for (let id = 0; id < level; id++) if (!running.has(id)) vu(id); };

  // ---- open model: arrival rate ----
  let credit = 0;
  let lastDispatch = performance.now();
  const dispatcher = rpsMode ? setInterval(() => {
    const t = performance.now();
    credit += (level * (t - lastDispatch)) / 1000;
    lastDispatch = t;
    while (credit >= 1 && !ended) {
      credit--;
      if (inflight < cfg.maxVus) iteration(); else dropped++;
    }
  }, 5) : null;

  const setLevel = (l) => {
    level = l;
    if (!rpsMode) spawnVus();
  };

  // ---- per-second ticks (LOAD-04) ----
  let elu = performance.eventLoopUtilization();
  let tickNo = 0;
  const ticker = setInterval(() => {
    const b = rec.takeBucket();
    const now = performance.eventLoopUtilization();
    const loop = performance.eventLoopUtilization(now, elu);
    elu = now;
    b.lat.sort((x, y) => x - y);
    const s = summarize(b.lat);
    const tick = {
      t: ++tickNo, rps: b.n, errors: b.errors, errorRate: b.n ? r2((b.errors / b.n) * 100) : 0,
      p50: s.p50, p95: s.p95, p99: s.p99, avg: s.avg,
      level, vus: rpsMode ? inflight : running.size, inflight, stage: stageIdx, elu: r2(loop.utilization * 100),
    };
    timeseries.push(tick);
    emit({ type: 'tick', data: tick });
  }, 1000);

  // ---- stage runner ----
  let stopReason = 'completed';
  let breakingPoint = null;

  const stageStats = (st, endN, endT) => {
    const lat = rec.latencies(st.startN, endN);
    const reqs = endN - st.startN;
    const errs = rec.countErrors(st.startN, endN);
    const dur = Math.max(0.001, (endT - st.startT) / 1000);
    return { requests: reqs, errors: errs, errorRate: reqs ? r2((errs / reqs) * 100) : 0, rps: r2(reqs / dur), durationSec: r2(dur), ...summarize(lat) };
  };

  const stopCheck = (stats, final) => {
    const sc = cfg.stress;
    if (!sc) return null;
    if (sc.stopErrorRate != null && stats.requests >= 20 && stats.errorRate > sc.stopErrorRate) return 'error_rate';
    if (sc.stopP95Ms != null && stats.count >= 20 && stats.p95 > sc.stopP95Ms) return 'p95_latency';
    if (final && sc.stopOnPlateau) {
      const passed = stages.filter((s) => s.passed);
      const best = Math.max(0, ...passed.map((s) => s.rps));
      if (passed.length >= 1 && stats.rps < best * (1 + (sc.plateauPct ?? 5) / 100)) {
        st_plateau++;
        if (st_plateau >= (sc.plateauSteps ?? 2)) return 'throughput_plateau';
      } else st_plateau = 0;
    }
    return null;
  };
  let st_plateau = 0;

  async function runStage(level_, durationSec) {
    const st = { index: stages.length, level: level_, startN: rec.n, startT: elapsed() };
    stageIdx = st.index;
    setLevel(level_);
    emit({ type: 'stage', data: { index: st.index, level: level_, durationSec } });
    const until = st.startT + durationSec * 1000;
    let violation = null;
    let lastCheck = 0;
    while (elapsed() < until && !ctl.stopped) {
      await sleep(Math.min(100, Math.max(1, until - elapsed())));
      if (cfg.mode === 'stress' && elapsed() - st.startT >= 3000 && elapsed() - lastCheck >= 1000) {
        lastCheck = elapsed();
        const reason = stopCheck(stageStats(st, rec.n, elapsed()), false);
        if (reason) { violation = reason; break; }
      }
    }
    const stats = stageStats(st, rec.n, elapsed());
    if (!violation && !ctl.stopped) violation = stopCheck(stats, true);
    const done = { index: st.index, level: level_, ...stats, passed: !violation, violation };
    stages.push(done);
    emit({ type: 'stageDone', data: done });
    return violation;
  }

  try {
    if (cfg.mode === 'stress') {
      const sc = cfg.stress;
      let lvl = sc.start;
      while (!ctl.stopped) {
        const violation = await runStage(lvl, sc.stepDurationSec);
        if (ctl.stopped) break;
        if (violation) {
          stopReason = violation;
          const last = stages[stages.length - 1];
          breakingPoint = { level: lvl, rps: last.rps, errorRate: last.errorRate, p95: last.p95, reason: violation };
          break;
        }
        if (lvl >= sc.max) { stopReason = 'max_load_reached'; break; }
        lvl = Math.min(sc.max, lvl + sc.step);
      }
    } else {
      for (const s of planStages(cfg)) {
        if (ctl.stopped) break;
        await runStage(s.level, s.durationSec);
      }
    }
    if (ctl.stopped) stopReason = 'stopped_by_user';
  } finally {
    ended = true;
    level = 0;
    if (dispatcher) clearInterval(dispatcher);
    if (ctl.stopped) {
      recording = false;
      agents.destroy();
    } else {
      // let in-flight iterations finish (bounded by the request timeout)
      const deadline = performance.now() + cfg.timeoutMs + 1000;
      while (inflight > 0 && performance.now() < deadline) await sleep(50);
      recording = false;
      agents.destroy();
    }
    clearInterval(ticker);
  }

  const durationSec = elapsed() / 1000;
  if (rec.capped) warnings.push(`More than ${RAW_CAP.toLocaleString()} requests: percentiles use the first ${RAW_CAP.toLocaleString()} samples; counts are exact.`);
  if (dropped) warnings.push(`${dropped} iterations were dropped because ${cfg.maxVus} concurrent iterations (max VUs) were already in flight – the target rate was not reached.`);

  const allLat = rec.latencies();
  const tickRps = timeseries.map((t) => t.rps);
  const steady = tickRps.length > 2 ? tickRps.slice(1, -1) : tickRps;
  const passedStages = stages.filter((s) => s.passed);
  const bestStage = passedStages.reduce((a, s) => (!a || s.rps > a.rps ? s : a), null);

  const perStep = steps.length > 1 ? steps.map((s, si) => {
    let reqs = 0; let errs = 0;
    for (let i = 0; i < rec.n; i++) if (rec.step[i] === si) { reqs++; if (rec.err[i]) errs++; }
    return { name: s.name || `Step ${si + 1}`, requests: reqs, errors: errs, ...summarize(rec.latencies(0, rec.n, (i) => rec.step[i] === si)) };
  }) : null;

  const summary = {
    kind: 'load',
    mode: cfg.mode,
    loadType: cfg.loadType,
    stopReason,
    durationSec: r2(durationSec),
    totalRequests: rec.total,
    totalErrors: rec.errors,
    errorRate: rec.total ? r2((rec.errors / rec.total) * 100) : 0,
    iterations,
    droppedIterations: dropped,
    bytesReceived: rec.bytesIn,
    bytesSent: rec.bytesOut,
    throughput: {
      avg: r2(rec.total / Math.max(0.001, durationSec)),
      peak: tickRps.length ? Math.max(...tickRps) : 0,
      sustained: r2(median(steady)),
    },
    latency: summarize(allLat),
    statusCodes: rec.statusCounts,
    errorsByType: rec.errorCounts,
    stages,
    perStep,
    breakingPoint,
    maxSustainable: cfg.mode === 'stress' && bestStage ? { level: bestStage.level, rps: bestStage.rps, p95: bestStage.p95, errorRate: bestStage.errorRate } : null,
    maxEventLoopUtilization: timeseries.length ? Math.max(...timeseries.map((t) => t.elu)) : 0,
  };

  if (rawFile && rec.n) await writeRaw(rawFile, rec);
  return { summary, timeseries, warnings };
}

async function writeRaw(file, rec) {
  const gz = zlib.createGzip({ level: 6 });
  const out = fs.createWriteStream(file);
  gz.pipe(out);
  const write = (s) => (gz.write(s) ? null : new Promise((r) => gz.once('drain', r)));
  await write('elapsed_ms,latency_ms,status,error,stage,step\n');
  let buf = '';
  for (let i = 0; i < rec.n; i++) {
    const lat = rec.lat[i];
    buf += `${rec.t[i].toFixed(1)},${Number.isNaN(lat) ? '' : lat.toFixed(2)},${rec.status[i]},${rec.err[i] ? rec.errTypes[rec.err[i]] : ''},${rec.stage[i]},${rec.step[i]}\n`;
    if (buf.length > 1 << 16) { const p = write(buf); buf = ''; if (p) await p; }
  }
  if (buf) await write(buf);
  await new Promise((resolve, reject) => { out.on('finish', resolve); out.on('error', reject); gz.end(); });
}
