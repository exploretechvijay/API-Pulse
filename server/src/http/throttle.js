// Network condition simulator.
//
// ThrottledSocket wraps a real TCP socket in a Duplex that delays every chunk
// in both directions according to a network profile:
//   - bandwidth:   each direction is a serial link; a chunk occupies the link
//                  for bytes*8/bps seconds (so large payloads are slowed, NET-03)
//   - latency:     profile.latencyMs is round-trip time; each direction adds half
//   - jitter:      +/- random(jitterMs/2) per chunk, ordering is preserved
//   - packet loss: chunk is split into 1460-byte segments; each lost segment
//                  adds a retransmission timeout (max(200ms, 2*RTT)) – this
//                  models TCP head-of-line blocking rather than dropping data.
// TLS is layered on top of this socket, so handshakes pay the latency too.

import { Duplex } from 'node:stream';

const MSS = 1460;
const SEGMENT = 4096;

/** FIFO of callbacks with monotonic due times, driven by a single timer. */
class DeliveryQueue {
  constructor() { this.items = []; this.timer = null; }
  add(at, fn) {
    this.items.push({ at, fn });
    if (this.items.length === 1) this._arm();
  }
  _arm() {
    clearTimeout(this.timer);
    this.timer = null;
    if (!this.items.length) return;
    const delay = this.items[0].at - performance.now();
    if (delay <= 0.5) return void this._run();
    this.timer = setTimeout(() => this._run(), delay);
  }
  _run() {
    this.timer = null;
    const now = performance.now() + 0.5;
    while (this.items.length && this.items[0].at <= now) this.items.shift().fn();
    if (this.items.length && !this.timer) this._arm();
  }
  clear() { clearTimeout(this.timer); this.items = []; }
}

export function isUnthrottled(p) {
  return !p || (!p.downloadKbps && !p.uploadKbps && !p.latencyMs && !p.jitterMs && !p.packetLoss);
}

class Link {
  constructor(kbps, oneWayMs, jitterMs, lossPct, rttMs) {
    this.bps = kbps > 0 ? kbps * 1000 : 0;
    this.oneWay = oneWayMs;
    this.jitter = jitterMs;
    this.loss = lossPct / 100;
    this.rto = Math.max(200, 2 * rttMs);
    this.freeAt = 0;        // when the link finishes serialising the previous chunk
    this.lastDeliver = 0;   // keeps delivery order monotonic
  }

  /** Returns absolute delivery time (ms, performance clock) for a chunk of n bytes. */
  schedule(n, now) {
    const start = Math.max(now, this.freeAt);
    const tx = this.bps ? (n * 8 * 1000) / this.bps : 0;
    this.freeAt = start + tx;
    let penalty = 0;
    if (this.loss > 0) {
      const segs = Math.max(1, Math.ceil(n / MSS));
      for (let i = 0; i < segs; i++) if (Math.random() < this.loss) penalty += this.rto;
    }
    const jitter = this.jitter ? (Math.random() - 0.5) * this.jitter : 0;
    const at = Math.max(this.freeAt + this.oneWay + penalty + jitter, this.lastDeliver);
    this.lastDeliver = at;
    return at;
  }
}

export class ThrottledSocket extends Duplex {
  constructor(socket, profile) {
    super({ allowHalfOpen: false });
    const rtt = profile.latencyMs || 0;
    this.up = new Link(profile.uploadKbps || 0, rtt / 2, profile.jitterMs || 0, profile.packetLoss || 0, rtt);
    this.down = new Link(profile.downloadKbps || 0, rtt / 2, profile.jitterMs || 0, profile.packetLoss || 0, rtt);
    this.socket = socket;
    this.upQ = new DeliveryQueue();
    this.downQ = new DeliveryQueue();
    this.ending = false;
    this.connecting = false;
    this.timeout = 0;
    this._idleTimer = null;

    socket.on('data', (chunk) => {
      this._touch();
      // split into segments so the first bytes arrive before the whole payload
      for (let off = 0; off < chunk.length; off += SEGMENT) {
        const part = chunk.subarray(off, off + SEGMENT);
        const at = this.down.schedule(part.length, performance.now());
        this.downQ.add(at, () => { this._touch(); this.push(part); });
      }
    });
    this.gotEnd = false;
    socket.on('end', () => {
      this.gotEnd = true;
      this.downQ.add(this.down.lastDeliver, () => this.push(null));
    });
    socket.on('error', (err) => this.destroy(err));
    // A clean close (after 'end') finishes through push(null) + autoDestroy, so buffered
    // response bytes are never dropped. An abrupt close is surfaced after in-flight data.
    socket.on('close', () => {
      if (this.gotEnd) return;
      this.downQ.add(this.down.lastDeliver, () => {
        if (!this.destroyed) this.destroy(Object.assign(new Error('socket closed'), { code: 'ECONNRESET' }));
      });
    });
  }

  _write(chunk, enc, cb) {
    this._touch();
    for (let off = 0; off < chunk.length; off += SEGMENT) {
      const part = chunk.subarray(off, off + SEGMENT);
      const at = this.up.schedule(part.length, performance.now());
      this.upQ.add(at, () => { if (!this.socket.destroyed) this.socket.write(part); });
    }
    cb();
  }

  _final(cb) {
    this.ending = true;
    this.upQ.add(this.up.lastDeliver, () => this.socket.end());
    cb();
  }

  _read() {}

  _destroy(err, cb) {
    this.upQ.clear();
    this.downQ.clear();
    clearTimeout(this._idleTimer);
    this.socket.destroy();
    cb(err);
  }

  // --- net.Socket surface used by http.Agent / ClientRequest ---
  _touch() {
    if (!this.timeout) return;
    clearTimeout(this._idleTimer);
    this._idleTimer = setTimeout(() => this.emit('timeout'), this.timeout);
  }
  setTimeout(ms, cb) {
    this.timeout = ms;
    if (cb) this.once('timeout', cb);
    if (ms) this._touch(); else clearTimeout(this._idleTimer);
    return this;
  }
  setNoDelay(v) { this.socket.setNoDelay(v); return this; }
  setKeepAlive(e, d) { this.socket.setKeepAlive(e, d); return this; }
  ref() { this.socket.ref(); return this; }
  unref() { this.socket.unref(); return this; }
  destroySoon() { this.end(); }
  address() { return this.socket.address(); }
  get remoteAddress() { return this.socket.remoteAddress; }
  get remotePort() { return this.socket.remotePort; }
  get localAddress() { return this.socket.localAddress; }
  get localPort() { return this.socket.localPort; }
  get bytesWritten() { return this.socket.bytesWritten; }
  get bytesRead() { return this.socket.bytesRead; }
}

/** Extra delay to apply to TCP connect: one RTT plus jitter (SYN/SYN-ACK). */
export function connectDelay(profile) {
  if (isUnthrottled(profile)) return 0;
  let d = profile.latencyMs || 0;
  if (profile.jitterMs) d += (Math.random() - 0.5) * profile.jitterMs;
  if (profile.packetLoss && Math.random() < profile.packetLoss / 100) d += 1000; // SYN retransmit (1s initial RTO)
  return Math.max(0, d);
}
