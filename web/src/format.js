export function ms(v, digits) {
  if (v == null || Number.isNaN(v)) return '—';
  if (v >= 10000) return `${(v / 1000).toFixed(1)} s`;
  if (v >= 1000) return `${(v / 1000).toFixed(2)} s`;
  const d = digits ?? (v < 10 ? 1 : 0);
  return `${Number(v).toFixed(d)} ms`;
}

export function num(v, digits = 0) {
  if (v == null || Number.isNaN(v)) return '—';
  return Number(v).toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}

export function pct(v, digits = 2) {
  if (v == null || Number.isNaN(v)) return '—';
  return `${Number(v).toFixed(v === 100 || v === 0 ? 0 : digits)}%`;
}

export function bytes(n) {
  if (n == null) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i ? 1 : 0)} ${u[i]}`;
}

export function ago(ts) {
  if (!ts) return 'never';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function duration(msVal) {
  if (msVal == null) return '—';
  const s = Math.round(msVal / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export const dateTime = (ts) => (ts ? new Date(ts).toLocaleString() : '—');
export const time = (ts) => (ts ? new Date(ts).toLocaleTimeString() : '—');

export function kbps(v) {
  if (!v) return 'Unlimited';
  if (v >= 1000) return `${+(v / 1000).toFixed(1)} Mbps`;
  return `${v} kbps`;
}

export const STATE_LABEL = { up: 'Up', degraded: 'Degraded', down: 'Down', paused: 'Paused', pending: 'Pending' };

export const STOP_REASON = {
  completed: 'Completed',
  stopped_by_user: 'Stopped by user',
  error_rate: 'Error rate exceeded limit',
  p95_latency: 'p95 latency exceeded limit',
  throughput_plateau: 'Throughput stopped rising',
  max_load_reached: 'Reached maximum load without breaking',
};
