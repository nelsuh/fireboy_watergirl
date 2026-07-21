// Connection + wire handling. Binary hot path (input up / snapshot+pong down),
// JSON for control events. Auto-reconnects with backoff. Estimates server time
// from snapshot ticks (EMA) so interpolation has a stable clock. Ported from the
// tank direct-mode reference.

import { MSG, DT, decodeSnapshot, decodePong, encodeInput, encodePing } from '../shared/protocol.js';

export class Net {
  // `resolveUrl` is an async () => wsUrl-with-token, called on every (re)connect
  // so a fresh access token is minted each time (platform tokens are short-lived).
  constructor(resolveUrl, { name, onSnapshot, onEvent, onStatus }) {
    this.resolveUrl = resolveUrl;
    this.name = name;
    this.onSnapshot = onSnapshot;
    this.onEvent = onEvent;
    this.onStatus = onStatus;
    this.ws = null;
    this.connected = false;
    this.rtt = 0;
    this.closedByUs = false;
    this.backoff = 500;
    this.clockOffset = 0;
    this._clockInit = false;
    this._pingTimer = null;
    this.connect();
  }

  connect() {
    this.onStatus(this._clockInit ? 'reconnecting' : 'connecting');
    Promise.resolve()
      .then(() => this.resolveUrl())
      .then((url) => { if (!this.closedByUs) this._open(url); })
      .catch(() => this._scheduleReconnect());
  }

  _open(url) {
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.onopen = () => {
      this.backoff = 500;
      this._clockInit = false;   // re-anchor the server-clock estimate on reconnect
      ws.send(JSON.stringify({ t: 'hello', name: this.name }));
      this._pingTimer = setInterval(() => {
        if (ws.readyState === 1) ws.send(encodePing(performance.now()));
      }, 2000);
      ws.send(encodePing(performance.now()));
    };

    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.t === 'welcome') { this.connected = true; this.onStatus('connected'); }
        this.onEvent(msg);
        return;
      }
      const v = new DataView(ev.data);
      const type = v.getUint8(0);
      if (type === MSG.SNAPSHOT) {
        const snap = decodeSnapshot(v);
        this._updateClock(snap.tick);
        this.onSnapshot(snap);
      } else if (type === MSG.PONG) {
        const { clientTimeMs } = decodePong(v);
        this.rtt = Math.round(performance.now() - clientTimeMs);
      }
    };

    ws.onclose = () => {
      this.connected = false;
      clearInterval(this._pingTimer);
      if (this.closedByUs) return;
      this._scheduleReconnect();
    };
    ws.onerror = () => { /* onclose follows */ };
  }

  _scheduleReconnect() {
    if (this.closedByUs) return;
    this.onStatus('reconnecting');
    setTimeout(() => this.connect(), this.backoff);
    this.backoff = Math.min(5000, this.backoff * 1.7);
  }

  _updateClock(tick) {
    const serverMs = tick * DT * 1000;
    const off = serverMs - performance.now();
    if (!this._clockInit) { this.clockOffset = off; this._clockInit = true; return; }
    this.clockOffset += (off - this.clockOffset) * 0.05;
    if (off > this.clockOffset) this.clockOffset = off;
  }

  serverNowMs() { return performance.now() + this.clockOffset; }

  sendInput(seq, buttons) {
    if (this.ws && this.ws.readyState === 1 && this.connected) {
      this.ws.send(encodeInput(seq, buttons));
    }
  }

  sendJson(obj) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj));
  }

  close() {
    this.closedByUs = true;
    clearInterval(this._pingTimer);
    if (this.ws) this.ws.close();
  }
}
