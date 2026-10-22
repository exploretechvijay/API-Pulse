export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export const badRequest = (msg, details) => new HttpError(400, msg, details);
export const notFound = (what = 'Resource') => new HttpError(404, `${what} not found`);
export const forbidden = (msg = 'Forbidden') => new HttpError(403, msg);

/** Wrap an async route handler so thrown errors reach the error middleware. */
export const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function int(v, { min = -Infinity, max = Infinity, def = null, name = 'value' } = {}) {
  if (v === undefined || v === null || v === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw badRequest(`${name} must be a number`);
  if (n < min || n > max) throw badRequest(`${name} must be between ${min} and ${max}`);
  return n;
}

export function str(v, { required = false, max = 10000, name = 'value', def = '' } = {}) {
  if (v === undefined || v === null || v === '') {
    if (required) throw badRequest(`${name} is required`);
    return def;
  }
  const s = String(v);
  if (s.length > max) throw badRequest(`${name} is too long (max ${max})`);
  return s;
}

export const arr = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Nearest-rank percentile on a sorted numeric array. */
export function percentile(sorted, p) {
  if (!sorted.length) return null;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

/** Hostname matching for the load-test allow-list. Supports "*.example.com" and "host:port". */
export function hostAllowed(urlStr, allowlist) {
  let u;
  try { u = new URL(urlStr); } catch { return false; }
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const port = u.port || (u.protocol === 'https:' ? '443' : '80');
  return (allowlist || []).some((raw) => {
    let entry = String(raw).trim().toLowerCase();
    if (!entry) return false;
    entry = entry.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    let ePort = null;
    const m = entry.match(/^(\[[^\]]+\]|[^:]+):(\d+)$/);
    if (m) { entry = m[1]; ePort = m[2]; }
    entry = entry.replace(/^\[|\]$/g, '');
    if (ePort && ePort !== port) return false;
    if (entry === '*') return true;
    if (entry.startsWith('*.')) return host.endsWith(entry.slice(1)) || host === entry.slice(2);
    return host === entry;
  });
}
