// One HTTP request with phase timings:
//   dns, tcp, tls (only for new connections), ttfb (connection ready -> first
//   response byte, includes sending the request), download (first byte -> end).
// All values are milliseconds.

import http from 'node:http';
import https from 'node:https';

const round = (n) => Math.round(n * 100) / 100;

export function classifyError(err) {
  if (!err) return null;
  const code = err.code || '';
  if (err.pulseTimeout || code === 'ETIMEDOUT') return 'timeout';
  if (err.phase === 'dns' || code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'dns_error';
  if (code === 'ECONNREFUSED') return 'connection_refused';
  if (code === 'ECONNRESET' || code === 'EPIPE' || code === 'ECONNABORTED') return 'connection_reset';
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return 'host_unreachable';
  if (/CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(code) || /certificate|ssl|tls/i.test(err.message || '')) return 'tls_error';
  return 'other_error';
}

/**
 * @param {object} o
 * @param {string} o.url
 * @param {string} [o.method]
 * @param {object} [o.headers]
 * @param {string|Buffer} [o.body]
 * @param {number} [o.timeoutMs]
 * @param {{http: http.Agent, https: https.Agent}} o.agents
 * @param {number} [o.maxBodyBytes] how much of the response body to keep (0 = discard)
 */
export function doRequest(o) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    let url;
    try { url = new URL(o.url); } catch {
      return resolve({ ok: false, error: 'invalid_url', errorMessage: `Invalid URL: ${o.url}`, timings: { total: 0 } });
    }
    const isHttps = url.protocol === 'https:';
    if (!isHttps && url.protocol !== 'http:') {
      return resolve({ ok: false, error: 'invalid_url', errorMessage: `Unsupported protocol ${url.protocol}`, timings: { total: 0 } });
    }
    const body = o.body == null || o.body === '' ? null : Buffer.isBuffer(o.body) ? o.body : Buffer.from(String(o.body));
    const headers = { 'user-agent': 'API-Pulse/1.0', ...(o.headers || {}) };
    if (body && !Object.keys(headers).some((h) => h.toLowerCase() === 'content-length')) headers['content-length'] = body.length;

    const maxBody = o.maxBodyBytes ?? 65536;
    let sockTimings = null;
    let reused = false;
    let firstByte = 0;
    let settled = false;
    let bytesReceived = 0;
    const chunks = [];
    let kept = 0;
    let timer = null;

    const finish = (res, err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const end = performance.now();
      const timings = { dns: 0, tcp: 0, tls: 0, ttfb: 0, download: 0, total: round(end - t0) };
      if (sockTimings && !reused) {
        timings.dns = round(sockTimings.dnsEnd - sockTimings.start);
        timings.tcp = sockTimings.connectEnd ? round(sockTimings.connectEnd - sockTimings.dnsEnd) : 0;
        timings.tls = sockTimings.tlsEnd ? round(sockTimings.tlsEnd - sockTimings.connectEnd) : 0;
        const ready = sockTimings.tlsEnd || sockTimings.connectEnd || t0;
        if (firstByte) timings.ttfb = round(firstByte - ready);
      } else if (firstByte) {
        timings.ttfb = round(firstByte - t0);
      }
      if (firstByte) timings.download = round(end - firstByte);
      const out = {
        ok: !err,
        status: res ? res.statusCode : 0,
        headers: res ? res.headers : {},
        body: maxBody > 0 ? Buffer.concat(chunks).toString('utf8') : '',
        bytesSent: body ? body.length : 0,
        bytesReceived,
        reused,
        remoteAddress: sockTimings?.remoteAddress || null,
        timings,
      };
      if (err) {
        out.error = classifyError(err);
        out.errorMessage = err.pulseTimeout ? `Timed out after ${o.timeoutMs} ms` : (err.message || String(err));
      }
      resolve(out);
    };

    const lib = isHttps ? https : http;
    let req;
    try {
      req = lib.request({
        protocol: url.protocol,
        hostname: url.hostname.replace(/^\[|\]$/g, ''),
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method: (o.method || 'GET').toUpperCase(),
        headers,
        agent: isHttps ? o.agents.https : o.agents.http,
      });
    } catch (e) {
      return finish(null, e);
    }

    if (o.timeoutMs) {
      timer = setTimeout(() => {
        const e = new Error('timeout');
        e.pulseTimeout = true;
        finish(null, e);
        req.destroy(e);
      }, o.timeoutMs);
    }

    req.on('socket', (s) => {
      if (s._pulseTimings && !s._pulseUsed) { sockTimings = s._pulseTimings; s._pulseUsed = true; }
      else { reused = true; sockTimings = s._pulseTimings || null; }
    });
    req.on('error', (e) => finish(null, e));
    req.on('response', (res) => {
      firstByte = performance.now();
      res.on('data', (c) => {
        bytesReceived += c.length;
        if (kept < maxBody) { chunks.push(c); kept += c.length; }
      });
      res.on('end', () => finish(res, null));
      res.on('error', (e) => finish(res, e));
      res.on('aborted', () => finish(res, Object.assign(new Error('response aborted'), { code: 'ECONNRESET' })));
    });
    if (body) req.end(body); else req.end();
  });
}
