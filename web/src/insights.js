// Turns raw test results into a plain-language summary: a verdict, what we
// found, and prioritised steps to improve. Rule-based and deterministic, so the
// same numbers always produce the same advice.

import { ms, num, pct, bytes, duration } from './format.js';

const median = (arr) => {
  const s = arr.filter((v) => v != null).sort((a, b) => a - b);
  return s.length ? s[Math.ceil(s.length / 2) - 1] : null;
};
const avg = (arr) => { const v = arr.filter((x) => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
const times = (a, b) => (b ? `${(a / b).toFixed(a / b >= 10 ? 0 : 1)}×` : '');

/** Speed band for one request as a user experiences it. */
function speedBand(p95) {
  if (p95 == null) return { level: 'bad', word: 'no successful responses' };
  if (p95 <= 300) return { level: 'good', word: 'fast' };
  if (p95 <= 1000) return { level: 'ok', word: 'acceptable' };
  if (p95 <= 3000) return { level: 'warn', word: 'slow' };
  return { level: 'bad', word: 'very slow' };
}

const RANK = { good: 0, info: 1, ok: 1, warn: 2, bad: 3 };
const worst = (...levels) => levels.reduce((a, b) => (RANK[b] > RANK[a] ? b : a), 'good');

const ERROR_HELP = {
  timeout: ['Requests timed out', 'The server took longer than the timeout to answer. Under load this usually means requests are queuing because the server, database or a downstream service cannot keep up.'],
  connection_refused: ['Connections were refused', 'Nothing accepted the connection – the service may be down, on a different port, or out of connection slots (listen backlog / max connections).'],
  connection_reset: ['Connections were reset', 'The server or a proxy/load balancer closed connections abruptly. Typical causes: connection limits, idle timeouts on the load balancer, crashes or out-of-memory restarts.'],
  dns_error: ['DNS lookup failed', 'The host name could not be resolved. Check the URL and DNS records.'],
  tls_error: ['TLS / certificate error', 'The HTTPS certificate is invalid, expired or self-signed. Fix the certificate, or enable “Skip TLS verification” only for internal test environments.'],
  host_unreachable: ['Host unreachable', 'The network route to the server failed. Check firewalls, VPN and security groups.'],
};

function httpErrorHelp(code) {
  const c = Number(code);
  if (c === 429) return ['Rate limited (HTTP 429)', 'The API is deliberately rejecting traffic above a limit. That is protection working, not a crash – raise the limit for test environments or test below it.', 'warn'];
  if (c === 401 || c === 403) return [`Not authorised (HTTP ${c})`, 'The request was rejected because of credentials. This is a test setup problem, not a performance problem – check the token / API key in the Auth tab or your {{VARIABLES}}.', 'bad'];
  if (c === 404) return ['Not found (HTTP 404)', 'The URL does not exist on the server. Check the path and environment.', 'bad'];
  if (c >= 400 && c < 500) return [`Client error (HTTP ${c})`, 'The server rejected the request itself (bad input, method or headers). Fix the request before measuring performance.', 'bad'];
  if (c === 502 || c === 504) return [`Gateway error (HTTP ${c})`, 'A proxy or load balancer could not get a timely answer from the application behind it – the app is overloaded, crashed, or slower than the gateway timeout.', 'bad'];
  if (c === 503) return ['Service unavailable (HTTP 503)', 'The service said it is overloaded or not ready. It hit a capacity limit (instances, worker threads, connection pool) or is being restarted.', 'bad'];
  if (c >= 500) return [`Server error (HTTP ${c})`, 'The application failed while handling requests. Check the server logs for exceptions – under load these are often database pool exhaustion, deadlocks or race conditions.', 'bad'];
  return [`HTTP ${c}`, 'Responses did not match the expected status codes.', 'warn'];
}

function errorFindings(errorsByType, total) {
  const out = [];
  for (const [type, count] of Object.entries(errorsByType || {}).sort((a, b) => b[1] - a[1])) {
    const share = total ? ` (${pct((count / total) * 100)} of requests)` : '';
    const http = type.match(/^HTTP (\d+)/);
    if (http) {
      const [title, text, level] = httpErrorHelp(http[1]);
      out.push({ level, title: `${title}: ${num(count)}${share}`, text });
    } else {
      const [title, text] = ERROR_HELP[type] || [type.replace(/_/g, ' '), 'Requests failed before a response was received.'];
      out.push({ level: 'bad', title: `${title}: ${num(count)}${share}`, text });
    }
  }
  return out;
}

class Recs {
  constructor() { this.list = []; this.keys = new Set(); }
  add(key, priority, title, text) {
    if (this.keys.has(key)) return;
    this.keys.add(key);
    this.list.push({ priority, title, text });
  }
  sorted() {
    const order = { high: 0, medium: 1, low: 2 };
    return this.list.sort((a, b) => order[a.priority] - order[b.priority]);
  }
}

// ======================================================================= latency

export function latencyInsights(run) {
  const s = run.summary;
  const profiles = s?.profiles || [];
  if (!profiles.length) return null;
  const findings = [];
  const recs = new Recs();
  const base = profiles.find((p) => p.profile.name === 'No throttling') || profiles[0];
  const keepAlive = !!run.config?.keepAlive;
  const st = base.stats;
  const band = speedBand(st.p95);
  const answered = base.requests.filter((r) => r[2] != null);

  // ---- verdict
  let level = band.level;
  if (base.errorRate >= 5) level = 'bad';
  else if (base.errorRate > 0) level = worst(level, 'warn');
  const verdict = {
    level,
    title: base.errorRate >= 50 ? 'Most requests failed'
      : `The API is ${band.word}${base.errorRate > 0 ? `, but ${pct(base.errorRate)} of requests failed` : ''}`,
    text: st.median != null
      ? `On ${base.profile.name === 'No throttling' ? 'this machine\'s normal connection' : base.profile.name}, a typical request took ${ms(st.median)} and 95 out of 100 requests finished within ${ms(st.p95)}.`
      + (profiles.length > 1 ? ` On the slowest network tested (${slowestOf(profiles).profile.name}) a typical request took ${ms(slowestOf(profiles).stats.median)}.` : '')
      : 'No request received a response, so no timing could be measured.',
  };

  // ---- speed in plain words
  if (st.median != null) {
    findings.push({
      level: band.level,
      title: `Typical response ${ms(st.median)} · 95% within ${ms(st.p95)} · slowest ${ms(st.max)}`,
      text: `Rule of thumb for APIs: under 300 ms feels instant, under 1 s is fine, over 3 s users start giving up. ${band.level === 'good' ? 'This endpoint is comfortably in the fast range.' : band.level === 'ok' ? 'This is acceptable, but noticeable when a screen makes several calls one after another.' : 'Users will notice this delay.'}`,
    });
  }

  // ---- consistency
  if (st.median && st.p95) {
    const spread = st.p95 / st.median;
    if (spread >= 3) {
      findings.push({ level: 'warn', title: 'Response times are inconsistent', text: `The slow requests (p95 ${ms(st.p95)}) take ${times(st.p95, st.median)} longer than a typical one (${ms(st.median)}). Some users get a much worse experience than the average suggests.` });
      recs.add('spikes', 'medium', 'Find the cause of the slow outliers', 'Inconsistent latency usually comes from cache misses, garbage-collection pauses, cold database queries, noisy neighbours on shared hosting, or a slow downstream call that only some requests make. Compare slow and fast requests in your server logs / APM traces.');
    } else if (spread >= 1.5) {
      findings.push({ level: 'ok', title: 'Some variation between requests', text: `Slow requests (p95 ${ms(st.p95)}) take ${times(st.p95, st.median)} as long as a typical one. Some variation is normal on real networks.` });
    } else {
      findings.push({ level: 'good', title: 'Response times are consistent', text: 'Almost every request took about the same time – predictable behaviour.' });
    }
  }

  // ---- warm-up / first request
  if (answered.length >= 5 && st.median) {
    const first = answered[0][2];
    if (first > 2 * st.median && first - st.median > 50) {
      findings.push({ level: 'info', title: `The first request was slower (${ms(first)})`, text: `That is ${times(first, st.median)} the typical time – a sign of a “cold start”: caches, connection pools or (on serverless) the function itself warming up.` });
      recs.add('coldstart', 'low', 'Reduce cold starts', 'Keep instances warm (minimum instances / provisioned concurrency on serverless), pre-warm caches and connection pools at startup, and avoid scaling to zero for user-facing APIs.');
    }
  }

  // ---- errors
  findings.push(...errorFindings(base.errorsByType, base.sent));
  if (base.errorRate > 0) recs.add('errors', 'high', 'Fix the failing requests first', 'Performance numbers are only meaningful when requests succeed. Resolve the errors listed above, then run the test again.');

  // ---- where the time goes
  const ph = base.phases || {};
  const total = (ph.dns || 0) + (ph.tcp || 0) + (ph.tls || 0) + (ph.ttfb || 0) + (ph.download || 0);
  if (total > 0) {
    const setup = (ph.dns || 0) + (ph.tcp || 0) + (ph.tls || 0);
    const rtt = ph.tcp || 0; // a TCP handshake takes one network round trip
    const serverTime = Math.max(0, (ph.ttfb || 0) - rtt);
    const share = (v) => Math.round(((v || 0) / total) * 100);

    if (!keepAlive && setup > 0) {
      const lvl = share(setup) >= 40 ? 'warn' : 'info';
      findings.push({
        level: lvl,
        title: `${share(setup)}% of the time is spent opening the connection`,
        text: `Before the server even sees the request, the client spends ${ms(ph.dns)} finding the server (DNS), ${ms(ph.tcp)} connecting (TCP) and ${ms(ph.tls)} setting up encryption (TLS) – ${ms(setup)} in total. This happens on every new connection.`,
      });
      if (share(setup) >= 25) {
        const reused = (ph.ttfb || 0) + (ph.download || 0);
        recs.add('keepalive', share(setup) >= 40 ? 'high' : 'medium', 'Reuse connections (keep-alive / HTTP/2)',
          `If apps keep the connection open between calls, each later request skips DNS, TCP and TLS: about ${ms(reused)} instead of ${ms(total)} (${Math.round((1 - reused / total) * 100)}% faster). Make sure clients use a shared HTTP client with keep-alive, the server/load balancer does not send "Connection: close", and its idle timeout is at least 60 s. Enable HTTP/2 so many calls share one connection.`);
      }
    }
    if (!keepAlive && (ph.tls || 0) > 50) {
      recs.add('tls', (ph.tls || 0) > 150 ? 'medium' : 'low', `Make the TLS handshake cheaper (now ${ms(ph.tls)})`,
        'Enable TLS 1.3 (one round trip instead of two) and TLS session resumption, use an ECDSA certificate, turn on OCSP stapling, and terminate TLS at a CDN / edge location close to users.');
    }
    if (!keepAlive && rtt > 60) {
      findings.push({ level: 'info', title: `The server is about ${ms(rtt)} away on the network`, text: 'The TCP connect time equals one network round trip. Every exchange between client and server pays this distance at least once.' });
      recs.add('distance', rtt > 150 ? 'medium' : 'low', 'Move the API closer to its users',
        `Each round trip costs ~${ms(rtt)}. Serve users from a nearby region, put a CDN or edge proxy in front of the API, and cache responses that do not change per user.`);
    }
    if (!keepAlive && (ph.dns || 0) > 50) {
      recs.add('dns', 'low', `Speed up DNS (now ${ms(ph.dns)})`, 'Use a fast, anycast DNS provider and a sensible TTL (e.g. 300 s or more) so resolvers can cache the answer.');
    }

    // server processing
    if (serverTime > 0) {
      const sLevel = serverTime > 1000 ? 'bad' : serverTime > 300 ? 'warn' : serverTime > 100 ? 'ok' : 'good';
      findings.push({
        level: sLevel,
        title: `The server spends about ${ms(serverTime)} preparing each response`,
        text: sLevel === 'good' ? 'The application itself is quick – most of the remaining time is network.'
          : `Time to first byte was ${ms(ph.ttfb)}; after subtracting one network round trip, roughly ${ms(serverTime)} is spent inside the application (code, database, other services).`,
      });
      if (serverTime > 200) {
        recs.add('server', serverTime > 500 ? 'high' : 'medium', 'Reduce server processing time',
          'Profile the endpoint (APM tracing or logs with timings). Usual wins: add database indexes and remove N+1 queries, cache results that rarely change (Redis / in-memory / HTTP caching), move slow work (emails, reports) to background jobs, and call downstream services in parallel instead of one after another.');
      }
    }

    // payload
    const sizes = base.requests.map((r) => r[11]).filter((v) => v != null && v > 0);
    const size = avg(sizes);
    const compressed = base.requests.some((r) => r[12] === 1);
    if (size != null) {
      findings.push({ level: size > 500_000 ? 'warn' : 'info', title: `Responses are ${bytes(size)} on average${compressed ? ' (compressed)' : ''}`,
        text: size > 100_000 ? 'Large responses take a long time to download on mobile networks.' : 'Payload size is small, so download time is not a concern.' });
      if (!compressed && size > 1500) {
        recs.add('compress', size > 50_000 ? 'high' : 'medium', 'Turn on response compression',
          `The server sent ${bytes(size)} uncompressed even though the client accepts gzip/brotli. Enabling compression usually shrinks JSON by 70–90%, which matters most on slow networks.`);
      }
      if (size > 100_000) {
        recs.add('payload', 'medium', 'Send less data per request', 'Add pagination, let clients request only the fields they need, remove unused fields, and avoid embedding large lists or base64 files in JSON.');
      }
    }
  }

  // ---- other network profiles
  const throttled = profiles.filter((p) => p !== base);
  for (const p of throttled) {
    if (p.stats.median == null) {
      findings.push({ level: 'bad', title: `${p.profile.name}: no successful responses`, text: 'Every request failed on this network – likely timeouts. Increase the timeout or reduce the response size.' });
      continue;
    }
    const factor = base.stats.median ? p.stats.median / base.stats.median : null;
    const b = speedBand(p.stats.p95);
    const lat = p.profile.latencyMs;
    const trips = lat ? Math.max(1, Math.round(((p.stats.median || 0) - (p.phases?.download || 0)) / lat)) : null;
    findings.push({
      level: b.level === 'good' ? 'good' : b.level,
      title: `${p.profile.name}: typical ${ms(p.stats.median)}${factor ? ` (${times(p.stats.median, base.stats.median)} slower)` : ''}, 95% within ${ms(p.stats.p95)}`,
      text: `Users on ${p.profile.name} experience this endpoint as ${b.word}.`
        + (trips && lat >= 100 ? ` Each request needs roughly ${trips} round trips of ${lat} ms – on slow networks the number of round trips matters more than server speed.` : '')
        + (p.errorRate > 0 ? ` ${pct(p.errorRate)} of requests failed on this network.` : ''),
    });
    if (b.level === 'warn' || b.level === 'bad') {
      recs.add('mobile', 'high', 'Optimise for users on slow mobile networks',
        `On ${p.profile.name} a request takes ${ms(p.stats.median)}. Biggest levers: reuse connections (avoid DNS+TCP+TLS on every call), combine several calls into one, compress and shrink responses, cache on the device (Cache-Control / ETag so unchanged data is not re-downloaded), and show cached data while refreshing in the background.`);
    }
  }

  // ---- reliability of the measurement itself
  if (base.sent < 30) {
    recs.add('samples', 'low', 'Run more requests for steadier numbers',
      `This test sent ${base.sent} request(s) per profile. p95 and p99 need at least 50–100 samples to be meaningful; with fewer, “p99” is effectively the single slowest request.`);
  }
  if (!profiles.some((p) => p.profile.name !== 'No throttling')) {
    recs.add('profiles', 'low', 'Test on a mobile network profile too', 'This run used only the unthrottled connection, which is usually much faster than what real users have. Add “4G” and “Slow 3G” to see what mobile users experience.');
  }

  return { verdict, findings, recommendations: recs.sorted() };
}

function slowestOf(profiles) {
  return profiles.reduce((a, p) => ((p.stats.median ?? 0) > (a.stats.median ?? 0) ? p : a), profiles[0]);
}

// ======================================================================= load

export function loadInsights(run) {
  const s = run.summary;
  if (!s) return null;
  const cfg = run.config || {};
  const unit = cfg.loadType === 'rps' ? 'requests/second (target)' : 'virtual users';
  const findings = [];
  const recs = new Recs();
  const lat = s.latency || {};
  const band = speedBand(lat.p95);
  const toolLimited = (run.warnings || []).some((w) => /saturated|CPU was above/i.test(w));
  const stages = s.stages || [];

  // ---- verdict
  let verdict;
  if (s.mode === 'stress') {
    if (s.breakingPoint) {
      verdict = {
        level: 'info',
        title: s.maxSustainable ? `Handles about ${num(s.maxSustainable.rps, 0)} requests/second reliably` : 'The API broke at the first load step',
        text: s.maxSustainable
          ? `The API stayed healthy up to ${num(s.maxSustainable.level)} ${unit} (${num(s.maxSustainable.rps, 0)} req/s, p95 ${ms(s.maxSustainable.p95)}). At ${num(s.breakingPoint.level)} ${unit} it broke: ${breakReason(s.breakingPoint)}.`
          : `Even the starting load of ${num(s.breakingPoint.level)} ${unit} was too much: ${breakReason(s.breakingPoint)}. Start the stress test lower.`,
      };
    } else if (s.stopReason === 'max_load_reached') {
      verdict = { level: 'good', title: 'The API did not break', text: `It stayed within all limits up to the hard maximum of ${num(cfg.stress?.max)} ${unit}, serving ${num(s.maxSustainable?.rps ?? s.throughput.peak, 0)} req/s. Raise the maximum to find the real limit.` };
    } else {
      verdict = { level: 'warn', title: 'Stress test stopped before a breaking point was found', text: 'The run was stopped manually. Run it to completion to find the API\'s limit.' };
    }
  } else {
    let level = band.level;
    if (s.errorRate >= 5) level = 'bad'; else if (s.errorRate >= 1) level = worst(level, 'warn'); else if (s.errorRate > 0) level = worst(level, 'ok');
    verdict = {
      level,
      title: s.errorRate >= 5 ? `The API struggled: ${pct(s.errorRate)} of requests failed`
        : `The API handled the load ${level === 'good' ? 'well' : level === 'ok' ? 'acceptably' : 'but was slow'}${s.errorRate > 0 ? ` with ${pct(s.errorRate)} errors` : ''}`,
      text: `It served ${num(s.totalRequests)} requests in ${duration(s.durationSec * 1000)} – on average ${num(s.throughput.avg, 0)} per second. 95 out of 100 requests finished within ${ms(lat.p95)}.`,
    };
  }
  if (toolLimited) verdict.text += ' Note: the testing machine itself was near its limit, so the real capacity may be higher.';

  // ---- throughput & latency in plain words
  // After a stress test breaks, fast failures inflate throughput and deflate latency,
  // so describe the last healthy step instead of the whole run.
  const healthy = s.mode === 'stress' && s.breakingPoint ? [...stages].reverse().find((x) => x.passed) : null;
  if (healthy) {
    const hb = speedBand(healthy.p95);
    findings.push({
      level: 'info',
      title: `At its healthy limit: ${num(healthy.rps, 0)} req/s with ${num(healthy.level)} ${unit}`,
      text: '“Throughput” is how many requests the API completed per second. Whole-run averages are not shown here because, after the breaking point, many requests failed instantly – that inflates throughput and makes latency look better than it was.',
    });
    findings.push({
      level: hb.level,
      title: `Response time at that load: typical ${ms(healthy.p50)}, 95% within ${ms(healthy.p95)}, 99% within ${ms(healthy.p99)}`,
      text: hb.level === 'good' ? 'Responses were still fast right up to the limit.' : 'Responses were already slowing down before the API broke.',
    });
  } else {
    findings.push({
      level: 'info',
      title: `Throughput: ${num(s.throughput.avg, 0)} req/s average, ${num(s.throughput.peak)} peak`,
      text: `“Throughput” is how many requests the API completed per second. Sustained (typical second) was ${num(s.throughput.sustained, 0)} req/s.`,
    });
    findings.push({
      level: band.level,
      title: `Response time under load: typical ${ms(lat.p50)}, 95% within ${ms(lat.p95)}, 99% within ${ms(lat.p99)}`,
      text: band.level === 'good' ? 'Responses stayed fast while under load.' : band.level === 'ok' ? 'Responses slowed down but stayed usable.' : 'Responses became slow under this load – users would notice.',
    });
  }

  // ---- latency growth across steps
  const okStages = stages.filter((x) => x.p95 != null && x.requests > 0);
  if (okStages.length >= 2 && (s.mode === 'ramp' || s.mode === 'stress')) {
    const first = okStages[0];
    const lastOk = [...okStages].reverse().find((x) => x.passed) || okStages[okStages.length - 1];
    const growth = first.p95 ? lastOk.p95 / first.p95 : 1;
    const rpsGrowth = first.rps ? lastOk.rps / first.rps : 1;
    const loadGrowth = first.level ? lastOk.level / first.level : 1;
    if (growth >= 2) {
      findings.push({ level: 'warn', title: `Latency grew ${times(lastOk.p95, first.p95)} as load increased`, text: `p95 went from ${ms(first.p95)} at ${num(first.level)} ${unit} to ${ms(lastOk.p95)} at ${num(lastOk.level)}. Requests are starting to queue – a resource is close to its limit.` });
    } else {
      findings.push({ level: 'good', title: 'Latency stayed flat as load increased', text: `p95 went from ${ms(first.p95)} to ${ms(lastOk.p95)} while load grew ${times(lastOk.level, first.level)} – the API scales well in this range.` });
    }
    if (loadGrowth >= 2 && rpsGrowth < loadGrowth * 0.6) {
      findings.push({ level: 'warn', title: 'Throughput did not keep up with load', text: `Load grew ${times(lastOk.level, first.level)} but completed requests per second only grew ${rpsGrowth.toFixed(1)}×. Extra users are waiting rather than being served.` });
    }
  }
  if (s.stopReason === 'throughput_plateau') {
    findings.push({ level: 'warn', title: 'Throughput stopped rising', text: 'Adding more load no longer increased completed requests per second – the API has reached a bottleneck.' });
  }

  // ---- errors
  findings.push(...errorFindings(s.errorsByType, s.totalRequests));
  const hasAuthOr404 = Object.keys(s.errorsByType || {}).some((k) => /^HTTP (401|403|404)/.test(k));
  if (hasAuthOr404) recs.add('setup', 'high', 'Fix the test setup first', 'Some requests failed with 401/403/404, which means the request itself is wrong (credentials, URL or environment). These are not performance problems – fix them so the test measures real behaviour.');

  // ---- spike recovery
  if (s.mode === 'spike' && stages.length === 3) {
    const [b0, peak, rec] = stages;
    findings.push({ level: peak.errorRate > 1 ? 'warn' : 'good', title: `During the spike: p95 ${ms(peak.p95)}, ${pct(peak.errorRate)} errors`, text: `Before the spike p95 was ${ms(b0.p95)}.` });
    const recovered = rec.p95 != null && b0.p95 != null && rec.p95 <= b0.p95 * 1.5 && rec.errorRate <= Math.max(1, b0.errorRate * 2);
    findings.push({ level: recovered ? 'good' : 'bad', title: recovered ? 'The API recovered after the spike' : 'The API did not fully recover after the spike',
      text: `After the spike p95 was ${ms(rec.p95)} with ${pct(rec.errorRate)} errors (before: ${ms(b0.p95)}, ${pct(b0.errorRate)}).` });
    if (!recovered) recs.add('recover', 'high', 'Make the API recover from bursts', 'Lingering slowness after a burst usually means queues that drain slowly, connection pools that stay exhausted, or retries amplifying load. Add timeouts and circuit breakers to downstream calls, bound queue sizes, and use retry with back-off and jitter.');
  }

  // ---- soak degradation
  const ts = run.timeseries || [];
  if ((s.mode === 'soak' || (s.mode === 'fixed' && ts.length >= 120)) && ts.length >= 20) {
    const k = Math.max(5, Math.floor(ts.length / 10));
    const head = ts.slice(1, k + 1); const tail = ts.slice(-k - 1, -1);
    const p95a = median(head.map((t) => t.p95)); const p95b = median(tail.map((t) => t.p95));
    const rpsA = median(head.map((t) => t.rps)); const rpsB = median(tail.map((t) => t.rps));
    if (p95a && p95b && p95b > p95a * 1.5) {
      findings.push({ level: 'warn', title: 'Performance degraded over time', text: `p95 rose from ${ms(p95a)} at the start to ${ms(p95b)} at the end (throughput ${num(rpsA)} → ${num(rpsB)} req/s) at the same load.` });
      recs.add('leak', 'high', 'Look for resource leaks', 'Slowing down at constant load is the classic sign of a memory leak, growing caches without limits, unclosed connections/file handles, or database tables/indexes that grow during the test. Watch memory, GC and connection counts on the server during a long run.');
    } else if (p95a && p95b) {
      findings.push({ level: 'good', title: 'Stable over the whole run', text: `p95 was ${ms(p95a)} at the start and ${ms(p95b)} at the end – no sign of degradation.` });
    }
  }

  // ---- recommendations from errors / limits
  const types = Object.keys(s.errorsByType || {});
  const serverSide = types.some((k) => /^HTTP 5|timeout|connection_(reset|refused)/.test(k));
  if (serverSide || s.breakingPoint || s.stopReason === 'throughput_plateau' || band.level === 'warn' || band.level === 'bad') {
    recs.add('bottleneck', 'high', 'Find the bottleneck while the test runs',
      'Run the test again and watch the server: CPU, memory, database connections and slow queries, thread/worker pool usage and downstream latency. The resource that hits 100% (or its pool limit) first is the bottleneck.');
    recs.add('scale', 'medium', 'Increase capacity where the bottleneck is',
      'Typical fixes: raise the database connection-pool size (and the DB max connections), add more app instances behind the load balancer (or enable autoscaling), increase worker/thread counts, add caching for hot read endpoints, and make sure slow downstream calls have timeouts.');
  }
  if (types.some((k) => /^HTTP 429/.test(k))) recs.add('ratelimit', 'medium', 'Review rate limits', 'HTTP 429 means a rate limiter rejected traffic. Confirm the limit matches expected peak traffic; for capacity testing, raise or bypass it in the test environment.');
  if (types.includes('timeout')) recs.add('timeouts', 'medium', 'Treat timeouts as overload, not slowness', 'Requests waited longer than the timeout. Instead of raising the timeout, find what they queue on (DB pool, thread pool, downstream service) and add capacity there; use fast-fail (circuit breakers) so overload does not cascade.');
  if (types.some((k) => /connection_(reset|refused)/.test(k))) recs.add('connlimits', 'medium', 'Check connection limits', 'Raise the server/load-balancer max connections and listen backlog, OS file-descriptor limits (ulimit -n), and align keep-alive idle timeouts between the load balancer and the app.');

  // ---- capacity planning
  const capacity = s.maxSustainable?.rps ?? (s.errorRate < 1 && band.level !== 'bad' ? s.throughput.sustained : null);
  if (capacity) {
    recs.add('capacity', 'medium', `Plan production traffic below ~${num(capacity * 0.7, 0)} req/s`,
      `This test shows about ${num(capacity, 0)} req/s ${s.maxSustainable ? 'before it breaks' : 'without problems'}. Keep normal peak traffic at or below 70% of that (≈ ${num(capacity * 0.7, 0)} req/s) so there is headroom for bursts, deploys and a failed instance. Re-run this test after each release to catch regressions.`);
  }

  // ---- measurement quality
  if (toolLimited) {
    findings.push({ level: 'warn', title: 'The testing machine was a bottleneck', text: 'The load generator itself was at its limit, so the API may be able to handle more than measured.' });
    recs.add('tool', 'medium', 'Get a more accurate measurement', 'Run API Pulse on a machine with more CPU, close to the API (same region/network), and avoid running the API and the tester on the same machine.');
  }
  if (s.droppedIterations > 0) {
    recs.add('dropped', 'low', 'Allow more concurrent requests', `${num(s.droppedIterations)} requests were not sent because the “max concurrent requests” limit was reached – the API was answering too slowly for the target rate. Raise the limit or treat it as a sign of overload.`);
  }
  if ((s.mode === 'fixed') && s.durationSec < 60) {
    recs.add('duration', 'low', 'Run for longer', `This test ran for ${duration(s.durationSec * 1000)}. Use at least 2–5 minutes so caches, connection pools and autoscaling settle and short blips do not dominate.`);
  }
  if (!s.totalErrors && band.level === 'good' && s.mode === 'fixed') {
    recs.add('next', 'low', 'Next step: find the limit', 'This load was handled comfortably. Run a Stress test to find out how much more the API can take before it breaks.');
  }

  return { verdict, findings, recommendations: recs.sorted() };
}

function breakReason(bp) {
  if (bp.reason === 'error_rate') return `${pct(bp.errorRate)} of requests failed`;
  if (bp.reason === 'p95_latency') return `95% of requests took up to ${ms(bp.p95)}, above your limit`;
  if (bp.reason === 'throughput_plateau') return 'adding more load no longer increased throughput';
  return bp.reason;
}

export function runInsights(run) {
  if (!run?.summary) return null;
  return run.kind === 'latency' ? latencyInsights(run) : loadInsights(run);
}

/** Plain-text version for copying into chat / tickets. */
export function insightsToText(run, ins) {
  const lines = [`${run.name} (run #${run.id})`, '', `RESULT: ${ins.verdict.title}`, ins.verdict.text, '', 'WHAT WE FOUND'];
  for (const f of ins.findings) lines.push(`- ${f.title}${f.text ? `: ${f.text}` : ''}`);
  if (ins.recommendations.length) {
    lines.push('', 'HOW TO IMPROVE');
    ins.recommendations.forEach((r, i) => lines.push(`${i + 1}. [${r.priority}] ${r.title} – ${r.text}`));
  }
  return lines.join('\n');
}
