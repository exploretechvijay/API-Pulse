// Machine-wide CPU sampler used to warn when the test machine itself is the
// bottleneck (PRD: Self-overhead, CPU above 85%).

import os from 'node:os';

let last = snapshot();
let current = 0;

function snapshot() {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) {
    for (const v of Object.values(c.times)) total += v;
    idle += c.times.idle;
  }
  return { idle, total };
}

setInterval(() => {
  const s = snapshot();
  const dt = s.total - last.total;
  current = dt > 0 ? Math.round((1 - (s.idle - last.idle) / dt) * 1000) / 10 : 0;
  last = s;
}, 1000).unref();

export const cpuPercent = () => current;
export const cpuCount = () => os.cpus().length;
