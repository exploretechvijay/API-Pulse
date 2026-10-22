// Thin fetch wrapper + live event stream (SSE).

export class ApiError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export async function api(path, { method = 'GET', body, raw = false, headers = {} } = {}) {
  const isText = typeof body === 'string';
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: { ...(body !== undefined ? { 'content-type': isText ? 'text/plain' : 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : isText ? body : JSON.stringify(body),
  });
  if (raw) return res;
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/auth/')) window.dispatchEvent(new Event('pulse:unauthorized'));
    throw new ApiError(res.status, data?.error || `Request failed (${res.status})`, data?.details);
  }
  return data;
}

export const get = (p) => api(p);
export const post = (p, body) => api(p, { method: 'POST', body: body ?? {} });
export const put = (p, body) => api(p, { method: 'PUT', body });
export const del = (p) => api(p, { method: 'DELETE' });

// ---- live events ----
const listeners = new Map(); // type -> Set<fn>
let source = null;
let status = 'closed';
const statusListeners = new Set();

function setStatus(s) {
  status = s;
  for (const fn of statusListeners) fn(s);
}

export function connectEvents() {
  if (source) return;
  source = new EventSource('/api/stream');
  source.onopen = () => setStatus('open');
  source.onerror = () => setStatus('reconnecting');
  for (const type of ['check', 'monitor', 'monitorDeleted', 'alert', 'run', 'maintenance']) {
    source.addEventListener(type, (e) => {
      const data = JSON.parse(e.data);
      for (const fn of listeners.get(type) || []) fn(data);
    });
  }
}

export function disconnectEvents() {
  source?.close();
  source = null;
  setStatus('closed');
}

export function on(type, fn) {
  if (!listeners.has(type)) listeners.set(type, new Set());
  listeners.get(type).add(fn);
  return () => listeners.get(type).delete(fn);
}

export function onStatus(fn) {
  statusListeners.add(fn);
  fn(status);
  return () => statusListeners.delete(fn);
}
