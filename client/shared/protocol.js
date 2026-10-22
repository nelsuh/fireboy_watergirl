// Shared protocol: constants + binary codec used by BOTH client and server.
// Hot-path messages (input up, snapshots down) are binary for minimal size;
// infrequent control messages (welcome/join/leave/level/death/victory) are JSON.
//
// This is a co-op platformer, so unlike the tank arena there are exactly TWO
// fixed seats: hero 0 = Fireboy, hero 1 = Watergirl. Each client drives only its
// own hero (left/right/jump); the server steps BOTH heroes plus the whole world
// (levers/plates/gates/lifts/gems/doors) and is the single source of truth.

// ---- Simulation constants (MUST be identical on client & server) ----
export const TICK_RATE = 60;
export const DT = 1 / TICK_RATE;

export const T = 32, COLS = 36, ROWS = 20;
export const WW = COLS * T, WH = ROWS * T;      // 1152 x 640
export const CHAR_W = 20, CHAR_H = 28;
export const SPEED = 170;                        // run speed u/s
export const JUMP_V = 575;                       // jump velocity
export const GRAV = 1500, MAX_FALL = 920;
export const LIFT_SPEED = 78;                    // platform glide u/s
export const COYOTE = 0.1, JUMP_BUFFER = 0.15;
export const JUMP_CUT_GRAV = 3;                  // gravity × while rising with jump released (short hops)
export const CORNER_NUDGE = 7;                   // px a head/ledge corner clip is slid around

export const TOTAL_LEVELS = 5;
export const MAX_PLAYERS_PER_ROOM = 2;           // co-op: Fireboy + Watergirl
export const INTERP_DELAY_MS = 100;              // remote hero rendered this far in the past (bigger buffer = smoother partner under real-network jitter)
export const RESET_DELAY = 0.9;                  // seconds a death freeze lasts before respawn
export const DOOR_HOLD = 0.45;                   // both-at-door dwell before advancing

// phase bitfield (snapshot header)
export const PH_RUNNING = 1;   // sim is live
export const PH_RESET = 2;     // a death freeze is counting down
export const PH_ENDED = 4;     // victory (all maps cleared)

// hero flags (per-hero snapshot byte)
export const HF_GROUND = 1;
export const HF_FACE_R = 2;    // facing right (else left)
export const HF_DEAD = 4;
export const HF_DOOR = 8;      // standing at own exit door

// ---- Binary message type ids ----
export const MSG = {
  // client -> server
  INPUT: 1,
  PING: 2,
  // server -> client
  SNAPSHOT: 16,
  PONG: 17,
};

// input button bits
export const BTN_LEFT = 1, BTN_RIGHT = 2, BTN_JUMP = 4;

const POS_SCALE = 16;   // px -> u16 (1/16 px)
const VEL_SCALE = 8;    // px/s -> i16 (max |920|*8 well within i16)

const clampU16 = (v) => Math.max(0, Math.min(65535, Math.round(v)));
const clampI16 = (v) => Math.max(-32767, Math.min(32767, Math.round(v)));

// ---- INPUT: c->s, 4 bytes ----
// [u8 type][u16 seq][u8 buttons]
export function encodeInput(seq, buttons) {
  const buf = new ArrayBuffer(4);
  const v = new DataView(buf);
  v.setUint8(0, MSG.INPUT);
  v.setUint16(1, seq & 0xffff, true);
  v.setUint8(3, buttons & 0xff);
  return buf;
}
export function decodeInput(v /* DataView */) {
  return { seq: v.getUint16(1, true), buttons: v.getUint8(3) };
}

// ---- PING/PONG ----
// PING: [u8 type][f64 clientTimeMs]           (9 bytes)
// PONG: [u8 type][f64 clientTimeMs][f64 serverTimeMs] (17 bytes)
export function encodePing(clientTimeMs) {
  const buf = new ArrayBuffer(9);
  const v = new DataView(buf);
  v.setUint8(0, MSG.PING);
  v.setFloat64(1, clientTimeMs, true);
  return buf;
}
export function encodePong(clientTimeMs, serverTimeMs) {
  const buf = new ArrayBuffer(17);
  const v = new DataView(buf);
  v.setUint8(0, MSG.PONG);
  v.setFloat64(1, clientTimeMs, true);
  v.setFloat64(9, serverTimeMs, true);
  return buf;
}
export function decodePong(v) {
  return { clientTimeMs: v.getFloat64(1, true), serverTimeMs: v.getFloat64(9, true) };
}

// ---- SNAPSHOT: s->c (variable length) ----
// header (18 B):
//   [u8 type][u32 tick][u16 lastAckSeq][u8 yourHero][u8 level][u8 phase]
//   [u16 deaths][u16 mapTimeCs][u8 leversOn][u32 gemsTaken]
// world:
//   [u8 nGates] nGates×[u8 open]           (open = 0..255, /255)
//   [u8 nLifts] nLifts×[u16 px][u16 py]
// heroes (fixed order f,w) 2×(9 B):
//   [u16 x][u16 y][i16 vx][i16 vy][u8 flags]
//
// `state` shape expected by encodeSnapshot:
//   { tick, lastAckSeq, yourHero, level, phase, deaths, mapTimeCs,
//     leversOn (u8 bitmask), gemsTaken (u32 bitmask),
//     gates:[open01,...], lifts:[{px,py},...], heroes:[{x,y,vx,vy,flags},{...}] }
export function encodeSnapshot(s) {
  const gates = s.gates || [], lifts = s.lifts || [], heroes = s.heroes || [];
  const buf = new ArrayBuffer(19 + 1 + gates.length + 1 + lifts.length * 4 + heroes.length * 9);
  const v = new DataView(buf);
  let o = 0;
  v.setUint8(o, MSG.SNAPSHOT); o += 1;
  v.setUint32(o, s.tick >>> 0, true); o += 4;
  v.setUint16(o, s.lastAckSeq & 0xffff, true); o += 2;
  v.setUint8(o, s.yourHero & 0xff); o += 1;
  v.setUint8(o, s.level & 0xff); o += 1;
  v.setUint8(o, s.phase & 0xff); o += 1;
  v.setUint16(o, Math.max(0, Math.min(65535, s.deaths)), true); o += 2;
  v.setUint16(o, Math.max(0, Math.min(65535, s.mapTimeCs)), true); o += 2;
  v.setUint8(o, s.leversOn & 0xff); o += 1;
  v.setUint32(o, s.gemsTaken >>> 0, true); o += 4;
  v.setUint8(o, gates.length & 0xff); o += 1;
  for (const g of gates) { v.setUint8(o, Math.max(0, Math.min(255, Math.round(g * 255)))); o += 1; }
  v.setUint8(o, lifts.length & 0xff); o += 1;
  for (const f of lifts) {
    v.setUint16(o, clampU16(f.px * POS_SCALE), true); o += 2;
    v.setUint16(o, clampU16(f.py * POS_SCALE), true); o += 2;
  }
  for (const h of heroes) {
    v.setUint16(o, clampU16(h.x * POS_SCALE), true); o += 2;
    v.setUint16(o, clampU16(h.y * POS_SCALE), true); o += 2;
    v.setInt16(o, clampI16(h.vx * VEL_SCALE), true); o += 2;
    v.setInt16(o, clampI16(h.vy * VEL_SCALE), true); o += 2;
    v.setUint8(o, h.flags & 0xff); o += 1;
  }
  return buf;
}
export function decodeSnapshot(v /* DataView */) {
  let o = 1;
  const tick = v.getUint32(o, true); o += 4;
  const lastAckSeq = v.getUint16(o, true); o += 2;
  const yourHero = v.getUint8(o); o += 1;
  const level = v.getUint8(o); o += 1;
  const phase = v.getUint8(o); o += 1;
  const deaths = v.getUint16(o, true); o += 2;
  const mapTimeCs = v.getUint16(o, true); o += 2;
  const leversOn = v.getUint8(o); o += 1;
  const gemsTaken = v.getUint32(o, true); o += 4;
  const nGates = v.getUint8(o); o += 1;
  const gates = [];
  for (let i = 0; i < nGates; i++) { gates.push(v.getUint8(o) / 255); o += 1; }
  const nLifts = v.getUint8(o); o += 1;
  const lifts = [];
  for (let i = 0; i < nLifts; i++) {
    lifts.push({ px: v.getUint16(o, true) / POS_SCALE, py: v.getUint16(o + 2, true) / POS_SCALE });
    o += 4;
  }
  const heroes = [];
  while (o + 9 <= v.byteLength) {
    heroes.push({
      x: v.getUint16(o, true) / POS_SCALE,
      y: v.getUint16(o + 2, true) / POS_SCALE,
      vx: v.getInt16(o + 4, true) / VEL_SCALE,
      vy: v.getInt16(o + 6, true) / VEL_SCALE,
      flags: v.getUint8(o + 8),
    });
    o += 9;
  }
  return { tick, lastAckSeq, yourHero, level, phase, deaths, mapTimeCs, leversOn, gemsTaken, gates, lifts, heroes };
}
