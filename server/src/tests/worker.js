// Worker thread entry: runs one latency or load test, isolated from the
// API/scheduler event loop so heavy load never delays monitor checks.

import { parentPort, workerData } from 'node:worker_threads';
import { runLatency } from './latency.js';
import { runLoad } from './load.js';

const ctl = { stopped: false };
parentPort.on('message', (m) => { if (m?.type === 'stop') ctl.stopped = true; });
const emit = (msg) => parentPort.postMessage(msg);

const { kind, config, vars, rawFile } = workerData;
try {
  const result = kind === 'latency'
    ? { summary: await runLatency(config, vars, ctl, emit), timeseries: null, warnings: [] }
    : await runLoad(config, vars, ctl, emit, rawFile);
  emit({ type: 'done', ...result });
} catch (e) {
  emit({ type: 'error', message: e?.stack || String(e) });
}
