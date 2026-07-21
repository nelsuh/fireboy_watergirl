// Client game state — the zero-lag core for the co-op platformer:
//  * PREDICTION: MY hero is simulated locally every fixed tick with the shared
//    kinematics, inputs seq-numbered and buffered.
//  * RECONCILIATION: each snapshot acks a seq; my hero is reset to the
//    authoritative state and unacked inputs replayed. Residual error (≈0 thanks
//    to the shared sim) is smoothed visually, never snapped.
//  * INTERPOLATION: the PARTNER hero renders ~66 ms in the past between two
//    snapshots — smooth regardless of jitter.
//  * WORLD (levers/gates/lifts/gems/level/deaths/timer) is authoritative: taken
//    straight from the latest snapshot (lift positions interpolated for smoothness).

import {
  DT, INTERP_DELAY_MS, TOTAL_LEVELS, HF_GROUND, HF_FACE_R, HF_DEAD, HF_DOOR,
  PH_RESET, PH_ENDED, BTN_LEFT, BTN_RIGHT, BTN_JUMP, T, CHAR_W,
} from '../shared/protocol.js';
import { makeWorld, loadLevel, stepHeroKinematics } from '../shared/sim.js';

const BUFFER_MS = 1000;
const MAX_EXTRAP_MS = 120;
const HERO_KEYS = ['f', 'w'];

export class Game {
  constructor(net) {
    this.net = net;
    this.myHero = -1;               // 0 = Fireboy, 1 = Watergirl
    this.myKey = 'f';
    this.remoteKey = 'w';
    this.names = new Map();         // hero -> name
    this.ready = false;             // welcome received

    this.world = makeWorld(0);      // prediction + render world (partner has both heroes)
    this.seq = 0;
    this.pending = [];              // unacked [{seq, buttons}]
    this.errX = 0; this.errY = 0;   // visual smoothing for my hero

    this.remotes = [];              // partner snapshot buffer [{tMs,x,y,vx,vy,flags}]
    this.lastServerLevel = 0;

    // world-status mirror (from snapshots)
    this.deaths = 0;
    this.mapTime = 0;
    this.phase = 0;
    this.ended = false;
    this.level = 0;

    // one-shot transitions surfaced to main.js for FX/overlays
    this.pendingEvents = [];        // {type,...}
  }

  // ---------- fixed 60 Hz tick: sample input, predict my hero, send ----------
  tick(input) {
    if (!this.ready || this.myHero < 0) return;
    let buttons = 0;
    if (input.left) buttons |= BTN_LEFT;
    if (input.right) buttons |= BTN_RIGHT;
    if (input.jump) buttons |= BTN_JUMP;

    this.seq = (this.seq + 1) & 0xffff;
    const inp = { seq: this.seq, buttons };
    this.pending.push(inp);
    if (this.pending.length > 180) this.pending.shift();

    const me = this.world.heroes[this.myKey];
    if (!me.dead && !this.ended && !(this.phase & PH_RESET)) {
      stepHeroKinematics(this.world, me, decodeButtons(buttons), DT);
    }
    this.net.sendInput(inp.seq, buttons);
  }

  // ---------- snapshots ----------
  onSnapshot(snap) {
    if (!this.ready) return;

    // level change → reload the render/prediction world's level
    if (snap.level !== this.world.level) {
      loadLevel(this.world, snap.level);
      this.remotes.length = 0;
      this.pending.length = 0;
      this.errX = 0; this.errY = 0;
      this._lastSnapTick = null;
    }
    this.level = snap.level;
    this.deaths = snap.deaths;
    this.mapTime = snap.mapTimeCs / 100;
    this.phase = snap.phase;
    this.ended = !!(snap.phase & PH_ENDED);

    // authoritative world state
    for (let i = 0; i < this.world.gems.length; i++) this.world.gems[i].taken = !!(snap.gemsTaken & (1 << i));
    this.world.leverOn = {};
    for (let ch = 1; ch <= 8; ch++) if (snap.leversOn & (1 << (ch - 1))) this.world.leverOn[ch] = true;
    for (let i = 0; i < this.world.gates.length && i < snap.gates.length; i++) this.world.gates[i].open = snap.gates[i];
    // Derive lift velocity from the position delta over the snapshot interval so
    // a rider is carried between snapshots during prediction (horizontal ferries).
    const snapDt = (this._lastSnapTick != null)
      ? Math.min(0.2, Math.max(DT, (snap.tick - this._lastSnapTick) * DT)) : 0;
    for (let i = 0; i < this.world.lifts.length && i < snap.lifts.length; i++) {
      const f = this.world.lifts[i], s = snap.lifts[i];
      f.vx = snapDt > 0 ? (s.px - f.px) / snapDt : 0;
      f.vy = snapDt > 0 ? (s.py - f.py) / snapDt : 0;
      f.px = s.px; f.py = s.py;
    }
    this._lastSnapTick = snap.tick;

    // partner hero → interpolation buffer
    const tMs = snap.tick * DT * 1000;
    const rp = snap.heroes[1 - this.myHero];
    if (rp) {
      this.remotes.push({ tMs, ...rp });
      const cutoff = tMs - BUFFER_MS;
      while (this.remotes.length > 2 && this.remotes[0].tMs < cutoff) this.remotes.shift();
    }

    // my hero → reconcile
    this._reconcile(snap.heroes[this.myHero], snap.lastAckSeq);
  }

  _reconcile(server, ackSeq) {
    if (!server) return;
    const me = this.world.heroes[this.myKey];
    const wasDead = me.dead;
    const nowDead = !!(server.flags & HF_DEAD);

    if (nowDead) {
      me.x = server.x; me.y = server.y; me.vx = 0; me.vy = 0;
      me.dead = true; me.grounded = !!(server.flags & HF_GROUND);
      this.pending.length = 0; this._lastAckedBtns = 0;
      this.errX = 0; this.errY = 0;
      return;
    }
    if (wasDead && !nowDead) {
      // respawned: adopt server state wholesale
      me.x = server.x; me.y = server.y; me.vx = server.vx; me.vy = server.vy;
      me.dead = false; me.grounded = true; me.onLift = -1;
      me.coyote = 0; me.jumpBuf = 0; me.jumpHeld = false;
      me.face = (server.flags & HF_FACE_R) ? 1 : -1;
      this.pending.length = 0; this._lastAckedBtns = 0;
      this.errX = 0; this.errY = 0;
      return;
    }

    // drop acked inputs, remembering the LAST acked button state. The jump is
    // edge-triggered (`input.jump && !h.jumpHeld`): if we replay held-jump inputs
    // with a stale `jumpHeld`, the rising edge is missed and the predicted hero
    // fails to re-jump → it snaps back to the ground every frame (the takeoff
    // hitch). Reconstructing jumpHeld from the last acked input makes the replay
    // reproduce the jump exactly. (jumpBuf/coyote are left intact so buffered and
    // coyote jumps still replay.)
    let ackedBtns = this._lastAckedBtns || 0;
    while (this.pending.length && seqLte(this.pending[0].seq, ackSeq)) ackedBtns = this.pending.shift().buttons;
    this._lastAckedBtns = ackedBtns;
    const oldX = me.x, oldY = me.y;
    me.x = server.x; me.y = server.y; me.vx = server.vx; me.vy = server.vy;
    me.dead = false;
    me.grounded = !!(server.flags & HF_GROUND);
    me.face = (server.flags & HF_FACE_R) ? 1 : -1;
    // Rebuild the edge/timer state from scratch so the replay is deterministic:
    // jumpHeld from the last acked input; jumpBuf/coyote cleared (any pre-window
    // jump is already reflected in server.vy/grounded, any in-window press
    // re-derives them during replay). Leftover forward-prediction values here
    // belong to a different tick and cause phantom snaps on rapid taps.
    me.jumpHeld = !!(ackedBtns & BTN_JUMP);
    me.jumpBuf = 0;
    me.coyote = 0;
    for (const inp of this.pending) stepHeroKinematics(this.world, me, decodeButtons(inp.buttons), DT);

    // absorb the correction into a decaying visual offset (no visible snapping)
    this.errX += oldX - me.x;
    this.errY += oldY - me.y;
    if (Math.hypot(this.errX, this.errY) > 140) { this.errX = 0; this.errY = 0; }
  }

  // ---------- events ----------
  onEvent(msg) {
    switch (msg.t) {
      case 'welcome':
        this.myHero = msg.hero;
        this.myKey = HERO_KEYS[msg.hero];
        this.remoteKey = HERO_KEYS[1 - msg.hero];
        this.names.clear();
        for (const p of msg.players) this.names.set(p.hero, p.name);
        if (typeof msg.level === 'number' && msg.level !== this.world.level) loadLevel(this.world, msg.level);
        this.remotes.length = 0;
        this.pending.length = 0;
        this.ready = true;
        break;
      case 'join': this.names.set(msg.hero, msg.name); this.pendingEvents.push({ type: 'join', hero: msg.hero, name: msg.name }); break;
      case 'leave': this.names.delete(msg.hero); this.pendingEvents.push({ type: 'leave', hero: msg.hero }); break;
      case 'level': this.pendingEvents.push({ type: 'level', to: msg.to, secs: msg.secs }); break;
      case 'victory': this.pendingEvents.push({ type: 'victory', total: msg.total, per: msg.per || [] }); break;
      case 'restart':
        loadLevel(this.world, 0);
        this.remotes.length = 0; this.pending.length = 0;
        this.deaths = 0; this.ended = false;
        this.pendingEvents.push({ type: 'restart' });
        break;
      case 'error': this.pendingEvents.push({ type: 'error', reason: msg.reason }); break;
    }
  }

  // ---------- per render frame: place the interpolated partner into the world ----------
  frame() {
    this.errX *= 0.86;
    this.errY *= 0.86;
    if (!this.ready) return;
    const renderMs = this.net.serverNowMs() - INTERP_DELAY_MS;
    const partner = this.world.heroes[this.remoteKey];
    const st = this._sampleRemote(renderMs);
    if (st) {
      partner.x = st.x; partner.y = st.y;
      partner.face = (st.flags & HF_FACE_R) ? 1 : -1;
      partner.dead = !!(st.flags & HF_DEAD);
      partner.grounded = !!(st.flags & HF_GROUND);
    }
  }

  _sampleRemote(renderMs) {
    const buf = this.remotes;
    if (buf.length === 0) return null;
    let a = buf[0], b = buf[buf.length - 1];
    for (let i = buf.length - 1; i >= 0; i--) {
      if (buf[i].tMs <= renderMs) { a = buf[i]; b = buf[Math.min(i + 1, buf.length - 1)]; break; }
    }
    if (b.tMs <= renderMs) {
      const dtMs = Math.min(renderMs - b.tMs, MAX_EXTRAP_MS);
      return { ...b, x: b.x + b.vx * dtMs / 1000, y: b.y + b.vy * dtMs / 1000 };
    }
    const f = Math.min(1, Math.max(0, (renderMs - a.tMs) / Math.max(1, b.tMs - a.tMs)));
    return { ...b, x: lerp(a.x, b.x, f), y: lerp(a.y, b.y, f) };
  }

  // my hero's render position (predicted + decaying correction offset)
  myRenderPos() {
    const me = this.world.heroes[this.myKey];
    return { x: me.x + this.errX, y: me.y + this.errY };
  }

  drainEvents() { const e = this.pendingEvents; this.pendingEvents = []; return e; }
}

const lerp = (a, b, f) => a + (b - a) * f;
const seqLte = (a, b) => ((b - a + 65536) % 65536) < 32768;
function decodeButtons(b) { return { left: !!(b & BTN_LEFT), right: !!(b & BTN_RIGHT), jump: !!(b & BTN_JUMP) }; }
