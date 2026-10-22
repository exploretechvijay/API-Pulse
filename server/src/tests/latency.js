// Latency test (LAT-01..05): N sequential requests per network profile; all
// selected profiles run at the same time so their results are directly comparable.

import { createAgents } from '../http/agent.js';
import { doRequest } from '../http/request.js';
import { buildRequest } from '../templating.js';
import { parseStatusExpr } from '../monitor/rules.js';
import { summarize, r2 } from './stats.js';
import { sleep } from '../util.js';

const PHASES = ['dns', 'tcp', 'tls', 'ttfb', 'download'];

/**
 * @param {object} cfg  normalised latency config (see manager.normaliseLatency)
 * @param {object} vars resolved variables
 * @param {object} ctl  { stopped: boolean }
 * @param {(msg:object)=>void} emit
 */
export async function runLatency(cfg, vars, ctl, emit) {
  const isOk = parseStatusExpr(cfg.successStatus);
  const started = Date.now();
  const progress = cfg.profiles.map(() => 0);
  const results = cfg.profiles.map((p) => ({ profile: p, requests: [] }));
  let lastEmit = 0;

  const emitProgress = (force = false) => {
    const t = Date.now();
    if (!force && t - lastEmit < 300) return;
    lastEmit = t;
    emit({ type: 'progress', data: {
      done: progress.reduce((a, b) => a + b, 0), total: cfg.count * cfg.profiles.length,
      profiles: results.map((r, i) => ({ profileId: r.profile.id, done: progress[i], last: r.requests.slice(-50) })),
    } });
  };

  await Promise.all(cfg.profiles.map(async (profile, pi) => {
    const agents = createAgents({ profile: profile.id ? profile : null, keepAlive: cfg.keepAlive, rejectUnauthorized: !cfg.request.ignoreTls });
    try {
      for (let i = 0; i < cfg.count && !ctl.stopped; i++) {
        const built = buildRequest(cfg.request, cfg.auth, vars);
        // behave like real browsers/apps so compressed responses are measured as users see them
        if (!built.headers['accept-encoding']) built.headers['accept-encoding'] = 'gzip, deflate, br';
        const t = Date.now() - started;
        const res = await doRequest({ ...built, timeoutMs: cfg.timeoutMs, agents, maxBodyBytes: 0 });
        const failed = !res.ok || !isOk(res.status);
        // compact row: [index, offsetMs, total, dns, tcp, tls, ttfb, download, status, error, reused, bytes, compressed]
        const enc = String(res.headers?.['content-encoding'] || '');
        results[pi].requests.push([i, t, res.ok ? res.timings.total : null, ...PHASES.map((p) => (res.ok ? res.timings[p] : null)),
          res.status || 0, failed ? (res.error || `HTTP ${res.status}`) : null, res.reused ? 1 : 0, res.bytesReceived || 0,
          /gzip|br|deflate|zstd/i.test(enc) ? 1 : 0]);
        progress[pi] = i + 1;
        emitProgress();
        if (cfg.delayMs && i < cfg.count - 1) await sleep(cfg.delayMs);
      }
    } finally {
      agents.destroy();
    }
  }));
  emitProgress(true);

  const profiles = results.map(({ profile, requests }) => {
    const answered = requests.filter((r) => r[2] != null);
    const errors = requests.filter((r) => r[9]);
    const phaseAvg = {};
    for (const [k, p] of PHASES.entries()) {
      const vals = answered.map((r) => r[3 + k]);
      phaseAvg[p] = vals.length ? r2(vals.reduce((a, b) => a + b, 0) / vals.length) : null;
    }
    const errorsByType = {};
    for (const e of errors) errorsByType[e[9]] = (errorsByType[e[9]] || 0) + 1;
    return {
      profile,
      requests,
      sent: requests.length,
      errors: errors.length,
      errorRate: requests.length ? r2((errors.length / requests.length) * 100) : 0,
      errorsByType,
      stats: summarize(answered.map((r) => r[2])),
      phases: phaseAvg,
    };
  });

  return {
    kind: 'latency',
    durationSec: r2((Date.now() - started) / 1000),
    stopReason: ctl.stopped ? 'stopped_by_user' : 'completed',
    columns: ['index', 'offsetMs', 'totalMs', 'dnsMs', 'tcpMs', 'tlsMs', 'ttfbMs', 'downloadMs', 'status', 'error', 'reused', 'bytes', 'compressed'],
    profiles,
  };
}
