// Percentiles use the nearest-rank method on the full set of raw samples, so
// results can be reproduced offline from the exported CSV (MVP acceptance).

import { percentile } from '../util.js';

const r2 = (n) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 100) / 100);

/** @param {ArrayLike<number>} values (unsorted is fine; a sorted copy is made) */
export function summarize(values) {
  const n = values.length;
  if (!n) return { count: 0, min: null, max: null, avg: null, median: null, p50: null, p90: null, p95: null, p99: null, stddev: null };
  const sorted = Float64Array.from(values).sort();
  let sum = 0;
  for (let i = 0; i < n; i++) sum += sorted[i];
  const avg = sum / n;
  let sq = 0;
  for (let i = 0; i < n; i++) sq += (sorted[i] - avg) ** 2;
  const p50 = percentile(sorted, 50);
  return {
    count: n,
    min: r2(sorted[0]),
    max: r2(sorted[n - 1]),
    avg: r2(avg),
    median: r2(p50),
    p50: r2(p50),
    p90: r2(percentile(sorted, 90)),
    p95: r2(percentile(sorted, 95)),
    p99: r2(percentile(sorted, 99)),
    stddev: r2(Math.sqrt(sq / n)),
  };
}

export function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return percentile(s, 50);
}

export { r2 };
