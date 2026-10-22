// HTTP(S) agents that (a) record per-connection phase timings and
// (b) optionally route the connection through the network simulator.

import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns';
import { ThrottledSocket, connectDelay, isUnthrottled } from './throttle.js';

function createConnection(options, cb, profile) {
  const t = { start: performance.now(), dnsEnd: 0, connectEnd: 0, tlsEnd: 0, remoteAddress: null };
  const host = options.host || options.hostname || 'localhost';
  const port = Number(options.port);
  const secure = options._pulseSecure;
  let done = false;
  const finish = (err, sock) => { if (!done) { done = true; cb(err, sock); } };

  const afterLookup = (address) => {
    t.dnsEnd = performance.now();
    t.remoteAddress = address;
    const raw = net.connect({ host: address, port });
    raw.once('error', (e) => finish(e));
    raw.once('connect', () => {
      const proceed = () => {
        t.connectEnd = performance.now();
        if (raw.destroyed) return finish(new Error('socket closed during connect'));
        const base = isUnthrottled(profile) ? raw : new ThrottledSocket(raw, profile);
        if (!secure) {
          raw.removeAllListeners('error');
          if (base !== raw) raw.on('error', () => {});
          base._pulseTimings = t;
          return finish(null, base);
        }
        const tlsSock = tls.connect({
          socket: base,
          servername: net.isIP(host) ? undefined : host,
          rejectUnauthorized: options.rejectUnauthorized !== false,
          ALPNProtocols: ['http/1.1'],
        });
        tlsSock.once('secureConnect', () => {
          t.tlsEnd = performance.now();
          tlsSock.removeListener('error', onTlsErr);
          tlsSock._pulseTimings = t;
          finish(null, tlsSock);
        });
        const onTlsErr = (e) => finish(e);
        tlsSock.once('error', onTlsErr);
        raw.removeAllListeners('error');
        raw.on('error', () => {});
      };
      const d = connectDelay(profile);
      if (d > 0) setTimeout(proceed, d); else proceed();
    });
  };

  if (net.isIP(host)) {
    afterLookup(host);
  } else {
    dns.lookup(host, { family: options.family || 0 }, (err, address) => {
      if (err) { err.code = err.code || 'ENOTFOUND'; err.phase = 'dns'; return finish(err); }
      // DNS goes over the simulated network too (one round trip)
      const d = connectDelay(profile);
      if (d > 0) setTimeout(() => afterLookup(address), d); else afterLookup(address);
    });
  }
}

export class PulseHttpAgent extends http.Agent {
  constructor(opts = {}) {
    super({ keepAlive: !!opts.keepAlive, maxSockets: opts.maxSockets || Infinity, keepAliveMsecs: 1000 });
    this.profile = opts.profile || null;
  }
  createConnection(options, cb) {
    createConnection({ ...options, _pulseSecure: false }, cb, this.profile);
  }
}

export class PulseHttpsAgent extends https.Agent {
  constructor(opts = {}) {
    super({ keepAlive: !!opts.keepAlive, maxSockets: opts.maxSockets || Infinity, keepAliveMsecs: 1000,
      rejectUnauthorized: opts.rejectUnauthorized !== false });
    this.profile = opts.profile || null;
    this.rejectUnauthorizedOpt = opts.rejectUnauthorized !== false;
  }
  createConnection(options, cb) {
    createConnection({ ...options, rejectUnauthorized: this.rejectUnauthorizedOpt, _pulseSecure: true }, cb, this.profile);
  }
}

/** A pair of agents (http + https) bound to one network profile. */
export function createAgents({ profile = null, keepAlive = false, rejectUnauthorized = true } = {}) {
  return {
    http: new PulseHttpAgent({ profile, keepAlive }),
    https: new PulseHttpsAgent({ profile, keepAlive, rejectUnauthorized }),
    destroy() { this.http.destroy(); this.https.destroy(); },
  };
}
