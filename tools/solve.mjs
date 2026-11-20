#!/usr/bin/env node
// Дөл ба Дусал — headless SOLO-mode level solver.
//
// Proves every level in client/shared/maps.js can be finished by ONE person
// driving both heroes in turn (the idle hero gets no input and just stands —
// it may keep holding a plate or ride a lift). Runs the real game code:
// makeWorld/stepServer from client/shared/sim.js at DT = 1/60. No audio, no
// browser, fully deterministic.
//
// Usage (from the game folder):
//   node tools/solve.mjs            solve every level, print a table; exit 1 on any failure
//   node tools/solve.mjs 3          solve level index 3 only (0-based)
//   node tools/solve.mjs 3 --path   …and print the winning move list
//   node tools/solve.mjs 3 --trace  …and replay it step by step (hero tiles, plates, levers, gates, lifts)
//   node tools/solve.mjs --quiet    table only
//
// Env knobs (debugging): SOLVE_SECONDS=<n> wall-clock cap per level (default
// 55); SOLVE_TRACE=1 prints search progress to stderr.
//
// Columns: solo s = sim time of the found solo route (one hero moves at a
// time); par = value in maps.js; par* = what it should be, ceil(solo × 1.5) + 5
// (marked ! when maps.js differs); nodes = A* expansions; unreachable = gems no
// explored state ever took.
//
// How it works
//   • Each search node is a whole-world clone. A move = pick a hero ('f'|'w')
//     and a macro, then step stepServer tick by tick with the other hero's input {}.
//     Macros steer the hero to tile-column centres so positions stay discrete:
//       walk ±1 column · full jump to land 0, ±2..±4 columns away (steering at
//       once) or ±1..±3 (rising first, steering near the apex) · short hop ±2 ·
//       wait 0.5 s · wait until every gate/lift has stopped.
//     Every macro keeps stepping until the hero is grounded again; jump is
//     released on the way down so the next jump is a fresh press.
//   • Any tick that kills a hero (world.resetPending / hero.dead) prunes the move.
//   • Control passes to the other hero only once the mover is parked somewhere
//     idling can matter (plate, lift, door, spawn, next to a gate or lift stop).
//   • States dedup on a quantized key: each hero's tile column + foot row
//     (+ which lift it rides), lever bitmask, each gate closed / moving / open,
//     each lift at start / in transit / at end.
//   • Weighted A* (w = 1.5) on sim time. h = physics-aware seconds-to-door of
//     Дөл + of Дусал, from a per-hero exploration of a relaxed copy of the level
//     (gates open, lifts at both stops with real ride time). In solo only one
//     hero moves at a time, so the two add up.
//   • Macro outcomes are cached while the idle hero is standing still; every
//     reported route is replayed on the untouched sim before it counts.
//   • Goal = stepServer reports `completed`.
//   • Gems: every live state ever generated adds its taken gems to a union.
//     Gems still missing get a follow-up search (seeded with every state of
//     the winning route, h = owner's distance to the nearest missing gem).
//     Each gem's route is replayed too; any gem never taken = failure.
//   • Each search has a node cap and the level a wall-clock cap; hitting one
//     = "gave up" = failure.
//   • The grid and objects are validated first (20 rows × 36 chars, legal
//     characters, solid border, exactly one A/B/D/E, doors/spawns standing on
//     something, objects in bounds and not inside rock, channels 1-8).

import { makeWorld, stepServer } from '../client/shared/sim.js';
import { MAPS } from '../client/shared/maps.js';
import { T, COLS, ROWS, CHAR_W, CHAR_H, DT, TOTAL_LEVELS, LIFT_SPEED } from '../client/shared/protocol.js';

const MAX_EXPANSIONS = 120000;      // per search
const MAX_SECONDS = Number(process.env.SOLVE_SECONDS) || 55;   // per level, wall clock

// ---------------------------------------------------------------- validation
const LEGAL = new Set('.#=FWGrbABDE'.split(''));

function validate(M, idx) {
  const errs = [];
  const where = `level ${idx}`;
  if (!M || typeof M !== 'object') return [`${where}: not an object`];
  if (!M.name || typeof M.name.mn !== 'string' || typeof M.name.en !== 'string' || !M.name.mn || !M.name.en)
    errs.push(`${where}: name must be { mn, en } strings`);
  if (!(Number.isFinite(M.par) && M.par > 0)) errs.push(`${where}: par must be a positive number`);
  const g = M.grid;
  if (!Array.isArray(g) || g.length !== ROWS) { errs.push(`${where}: grid must have ${ROWS} rows (has ${g && g.length})`); return errs; }
  const count = {};
  for (let y = 0; y < ROWS; y++) {
    const row = g[y];
    if (typeof row !== 'string' || row.length !== COLS) { errs.push(`${where}: row ${y} must be ${COLS} chars (is ${row && row.length}): "${row}"`); continue; }
    for (let x = 0; x < COLS; x++) {
      const c = row[x];
      if (!LEGAL.has(c)) errs.push(`${where}: illegal char '${c}' at ${x},${y}`);
      count[c] = (count[c] || 0) + 1;
      const border = y === 0 || y >= ROWS - 2 || x === 0 || x === COLS - 1;
      if (border && c !== '#') errs.push(`${where}: border tile ${x},${y} must be '#' (is '${c}')`);
    }
  }
  if (errs.length) return errs;
  for (const c of 'ABDE') if (count[c] !== 1) errs.push(`${where}: need exactly one '${c}' (found ${count[c] || 0})`);
  const gems = (count.r || 0) + (count.b || 0);
  if (gems > 32) errs.push(`${where}: ${gems} gems (max 32)`);
  const at = (x, y) => (x < 0 || y < 0 || x >= COLS || y >= ROWS ? '#' : g[y][x]);
  const inB = (x, y) => Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < COLS && y < ROWS;
  const solidBelow = (x, y) => at(x, y + 1) === '#' || at(x, y + 1) === '=';
  for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) {
    const c = g[y][x];
    if ((c === 'D' || c === 'E') && at(x, y - 1) === '#') errs.push(`${where}: door '${c}' at ${x},${y} needs open tile above`);
    if ((c === 'D' || c === 'E' || c === 'A' || c === 'B') && !solidBelow(x, y)) errs.push(`${where}: '${c}' at ${x},${y} must stand on rock or '='`);
  }
  const chOk = (ch) => Number.isInteger(ch) && ch >= 1 && ch <= 8;
  for (const k of ['plates', 'levers', 'gates', 'lifts']) if (!Array.isArray(M[k])) errs.push(`${where}: ${k} must be an array`);
  if (errs.length) return errs;
  M.plates.forEach((p, i) => {
    if (!inB(p.x, p.y) || at(p.x, p.y) === '#') errs.push(`${where}: plate ${i} at ${p.x},${p.y} out of bounds or in rock`);
    else if (!solidBelow(p.x, p.y)) errs.push(`${where}: plate ${i} at ${p.x},${p.y} floats (no rock/'=' below)`);
    if (!chOk(p.ch)) errs.push(`${where}: plate ${i} bad channel ${p.ch}`);
  });
  M.levers.forEach((v, i) => {
    if (!inB(v.x, v.y) || at(v.x, v.y) === '#') errs.push(`${where}: lever ${i} at ${v.x},${v.y} out of bounds or in rock`);
    if (!chOk(v.ch)) errs.push(`${where}: lever ${i} bad channel ${v.ch}`);
  });
  M.gates.forEach((q, i) => {
    if (!Number.isInteger(q.h) || q.h < 1) errs.push(`${where}: gate ${i} bad height`);
    for (let y = q.y; y < q.y + (q.h | 0); y++)
      if (!inB(q.x, y) || at(q.x, y) === '#') errs.push(`${where}: gate ${i} cell ${q.x},${y} out of bounds or in rock`);
    if (!chOk(q.ch)) errs.push(`${where}: gate ${i} bad channel ${q.ch}`);
  });
  M.lifts.forEach((f, i) => {
    if (!Number.isInteger(f.w) || f.w < 1 || !Number.isInteger(f.dx) || !Number.isInteger(f.dy)) errs.push(`${where}: lift ${i} bad w/dx/dy`);
    for (const [ox, oy] of [[0, 0], [f.dx, f.dy]])
      for (let x = f.x + ox; x < f.x + ox + (f.w | 0); x++)
        if (!inB(x, f.y + oy) || at(x, f.y + oy) === '#') errs.push(`${where}: lift ${i} cell ${x},${f.y + oy} out of bounds or in rock`);
    if (!chOk(f.ch)) errs.push(`${where}: lift ${i} bad channel ${f.ch}`);
  });
  const used = new Set([...M.plates, ...M.levers].map((o) => o.ch));
  for (const o of [...M.gates, ...M.lifts]) if (!used.has(o.ch)) errs.push(`${where}: channel ${o.ch} drives something but has no plate/lever`);
  return errs;
}

// ---------------------------------------------------------------- world helpers
function freshWorld(n) {
  if (n < TOTAL_LEVELS) return makeWorld(n);
  // protocol's TOTAL_LEVELS lags MAPS: borrow slot 0 so loadLevel still runs the real code
  const keep = MAPS[0];
  MAPS[0] = MAPS[n];
  try { const w = makeWorld(0); w.level = n; return w; } finally { MAPS[0] = keep; }
}

const SHARED = new Set(['grid', 'liquids', 'doors', 'spawns', 'name']);
function clone(v, depth = 0) {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) { const a = new Array(v.length); for (let i = 0; i < v.length; i++) a[i] = clone(v[i], depth + 1); return a; }
  const o = {};
  for (const k in v) o[k] = depth === 0 && SHARED.has(k) ? v[k] : clone(v[k], depth + 1);
  return o;
}
// Fast path for the world: one level of spread per record (all records here
// hold primitives, plus each hero's leverTouch array). Unknown nested shapes
// fall back to the generic deep clone, so a sim change can't alias state.
const flat = (e) => {
  const o = { ...e };
  for (const k in o) { const v = o[k]; if (v !== null && typeof v === 'object') o[k] = clone(v, 1); }
  return o;
};
function cloneWorld(w) {
  const o = {};
  for (const k in w) {
    const v = w[k];
    if (SHARED.has(k) || v === null || typeof v !== 'object') o[k] = v;
    else if (k === 'heroes') o.heroes = { f: flat(v.f), w: flat(v.w) };
    else if (Array.isArray(v)) o[k] = v.map((e) => (e !== null && typeof e === 'object' ? flat(e) : e));
    else o[k] = flat(v);
  }
  return o;
}

const OTHER = { f: 'w', w: 'f' };
const cxOf = (h) => h.x + CHAR_W / 2;
const colOf = (h) => Math.floor(cxOf(h) / T);
const footRow = (h) => Math.floor((h.y + CHAR_H - 1) / T);

// A hero is keyed by the tile column it stands in and its foot row (macros
// steer to column centres, so finer buckets mostly split the same spot); a
// rider is marked with its lift. Machinery is keyed coarsely — each gate
// closed / moving / open, each lift at its start / in transit / at its end —
// because transit positions multiplied the state space ~30× without adding
// routes: riders still key by where they are, and "settle" finishes a trip.
const heroKey = (h) => `${colOf(h)},${footRow(h)}${h.onLift >= 0 ? 'L' + h.onLift : ''}${h.grounded ? '' : '^'}`;
function stateKey(w) {
  let k = heroKey(w.heroes.f) + '|' + heroKey(w.heroes.w) + '|';
  let lv = 0;
  for (const ch in w.leverOn) if (w.leverOn[ch]) lv |= 1 << ch;
  k += lv;
  for (const g of w.gates) k += g.open === 0 ? 'c' : g.open === 1 ? 'o' : 'm';
  for (const l of w.lifts) k += Math.hypot(l.px - l.x0, l.py - l.y0) < 1 ? 's' : Math.hypot(l.px - l.x1, l.py - l.y1) < 1 ? 'e' : 't';
  return k;
}

function gemMask(w) {
  let m = 0;
  for (let i = 0; i < w.gems.length; i++) if (w.gems[i].taken) m |= 1 << i;
  return m >>> 0;
}

function settled(w) {
  for (const g of w.gates) { const t = g.open; if (t !== 0 && t !== 1) return false; }
  for (const l of w.lifts) if (l.vx !== 0 || l.vy !== 0) return false;
  // a channel whose target differs from the current position isn't settled either
  for (const g of w.gates) {
    const act = channelActive(w, g.ch);
    if ((act ? 1 : 0) !== g.open) return false;
  }
  for (const l of w.lifts) {
    const act = channelActive(w, l.ch);
    const tx = act ? l.x1 : l.x0, ty = act ? l.y1 : l.y0;
    if (Math.hypot(tx - l.px, ty - l.py) > 0.01) return false;
  }
  return true;
}
function channelActive(w, ch) {
  for (const p of w.plates) if (p.ch === ch && p.pressed) return true;
  return !!w.leverOn[ch];
}

// ---------------------------------------------------------------- macros
// Each macro is { hero, kind, dx }; runMacro(world, macro) steps it in place.
const INPUT_NONE = {};

function tick(w, key, input) {
  const inputs = key === 'f' ? { f: input, w: INPUT_NONE } : { f: INPUT_NONE, w: input };
  const r = stepServer(w, inputs, DT);
  const dead = w.resetPending || w.heroes[key].dead;   // an idle hero's death sets resetPending
  return { dead, completed: r.completed };
}

function steer(h, target) {
  const d = target - cxOf(h);
  return d > 1.5 ? 1 : d < -1.5 ? -1 : 0;
}

// returns { ticks, dead, completed, valid }
function runMacro(w, m) {
  const h = w.heroes[m.hero];
  let n = 0;
  const step = (input) => { n++; return tick(w, m.hero, input); };
  let r = { dead: false, completed: false };

  if (m.kind === 'walk') {
    if (!h.grounded) return { valid: false };
    const target = (colOf(h) + m.dx) * T + T / 2;
    let lastX = h.x, still = 0;
    while (n < 120) {
      const s = steer(h, target);
      r = step({ left: s < 0, right: s > 0 });
      if (r.dead || r.completed) break;
      if (h.grounded && s === 0) break;
      if (h.grounded && Math.abs(h.x - lastX) < 0.01) { if (++still >= 2) break; } else still = 0;
      lastX = h.x;
      if (h.grounded && steer(h, target) === 0) break;
    }
  } else if (m.kind === 'jump' || m.kind === 'hop' || m.kind === 'late') {
    if (!h.grounded) return { valid: false };
    const target = (colOf(h) + m.dx) * T + T / 2;
    let air = false;
    while (n < 150) {
      const holdJump = m.kind === 'hop' ? n < 6 : (n === 0 || h.vy < 0);
      let s = steer(h, target);
      if (m.kind === 'late' && h.vy < -150 && !(air && h.grounded)) s = 0;
      r = step({ left: s < 0, right: s > 0, jump: holdJump });
      if (r.dead || r.completed) break;
      if (!h.grounded) air = true;
      else if (air) break;
      if (!air && n > 8) return { valid: false };
    }
  } else if (m.kind === 'wait') {
    while (n < 30) { r = step(INPUT_NONE); if (r.dead || r.completed) break; }
  } else if (m.kind === 'settle') {
    if (settled(w)) return { valid: false };
    while (n < 400) { r = step(INPUT_NONE); if (r.dead || r.completed) break; if (settled(w)) break; }
  }

  // let anybody still airborne (idle hero knocked off a lift, etc.) land
  let guard = 0;
  while (!r.dead && !r.completed && (!w.heroes.f.grounded || !w.heroes.w.grounded) && guard++ < 120) {
    r = step(INPUT_NONE);
  }
  // both heroes in front of their doors → stand still through DOOR_HOLD
  guard = 0;
  while (!r.dead && !r.completed && w.heroes.f.atDoor && w.heroes.w.atDoor && guard++ < 40) {
    r = step(INPUT_NONE);
  }
  return { valid: true, ticks: n, dead: r.dead, completed: r.completed };
}

const MACROS = [];
for (const hero of ['f', 'w']) {
  MACROS.push({ hero, kind: 'walk', dx: -1 }, { hero, kind: 'walk', dx: 1 });
  for (const dx of [-4, -3, -2, 0, 2, 3, 4]) MACROS.push({ hero, kind: 'jump', dx });
  for (const dx of [-3, -2, -1, 1, 2, 3]) MACROS.push({ hero, kind: 'late', dx });
  for (const dx of [-2, 2]) MACROS.push({ hero, kind: 'hop', dx });
  MACROS.push({ hero, kind: 'wait', dx: 0 }, { hero, kind: 'settle', dx: 0 });
}
const label = (m) => `${m.hero === 'f' ? 'Дөл ' : 'Дусал'} ${m.kind}${m.kind === 'wait' || m.kind === 'settle' ? '' : (m.dx >= 0 ? '+' : '') + m.dx}`;

// ---------------------------------------------------------------- heuristic
// Physics-aware distances. For each hero, explore a RELAXED copy of the level
// with the real macros: every gate open, every lift parked at both of its stops
// at once (riding between them costs the real travel time), no plates/levers,
// partner removed. Reverse Dijkstra over that graph gives, for each grounded
// position, the seconds needed to reach the door (or to take a given gem).
// Only one hero moves at a time in solo, so the two heroes' distances add up
// to an estimate of the remaining solo time (it ignores detours to plates).
const hkey = (h) => `${Math.floor((h.x + 14) / 8)},${Math.floor((h.y + CHAR_H + 4) / 8)}`;

function relaxedWorld(n, k) {
  const w = freshWorld(n);
  w.gates = []; w.plates = []; w.levers = [];
  // each lift becomes two static platforms (its two stops) joined by a "ride"
  // edge that costs the real travel time — so waiting for a lift isn't free
  const lifts = [];
  for (const l of w.lifts) {
    const sec = Math.hypot(l.x1 - l.x0, l.y1 - l.y0) / LIFT_SPEED;
    const i = lifts.length;
    lifts.push({ x0: l.x0, y0: l.y0, x1: l.x0, y1: l.y0, w: l.w, ch: 99, px: l.x0, py: l.y0, vx: 0, vy: 0, pair: i + 1, sec });
    lifts.push({ x0: l.x1, y0: l.y1, x1: l.x1, y1: l.y1, w: l.w, ch: 99, px: l.x1, py: l.y1, vx: 0, vy: 0, pair: i, sec });
  }
  w.lifts = lifts;
  for (const hk of ['f', 'w']) w.heroes[hk].leverTouch = [];
  w.heroes[OTHER[k]].dead = true;
  return w;
}

function relaxedGraph(n, k) {
  const w0 = relaxedWorld(n, k);
  const ids = new Map([[hkey(w0.heroes[k]), 0]]);
  const keys = [hkey(w0.heroes[k])];
  const rev = [[]];          // rev[to] = [[from, seconds]]
  const door = [];
  const gemEdges = [];       // [from, seconds, gemIndex]
  const q = [w0];
  const macros = MACROS.filter((m) => m.hero === k);
  for (let qi = 0; qi < q.length; qi++) {
    const cur = q[qi];
    const from = ids.get(hkey(cur.heroes[k]));
    for (const m of macros) {
      const w = cloneWorld(cur);
      for (const g of w.gems) g.taken = false;
      const r = runMacro(w, m);
      if (!r.valid || r.dead || !r.ticks) continue;
      const sec = r.ticks * DT;
      w.gems.forEach((g, i) => { if (g.taken) gemEdges.push([from, sec, i]); });
      const key = hkey(w.heroes[k]);
      let to = ids.get(key);
      if (to === undefined) {
        to = keys.length; ids.set(key, to); keys.push(key); rev.push([]); q.push(w);
        if (w.heroes[k].atDoor) door.push(to);
      }
      rev[to].push([from, sec]);
    }
    const h0 = cur.heroes[k];
    if (h0.onLift >= 0) {            // ride to the lift's other stop
      const a = cur.lifts[h0.onLift], b = cur.lifts[a.pair];
      const w = cloneWorld(cur), h = w.heroes[k];
      h.x += b.px - a.px; h.y = b.py - CHAR_H; h.onLift = a.pair; h.grounded = true; h.vy = 0;
      const key = hkey(h);
      let to = ids.get(key);
      if (to === undefined) { to = keys.length; ids.set(key, to); keys.push(key); rev.push([]); q.push(w); }
      rev[to].push([from, a.sec]);
    }
  }
  const dijkstra = (seed) => {
    const D = new Float64Array(keys.length).fill(Infinity);
    const heap = new Heap();
    for (const [i, d] of seed) if (d < D[i]) { D[i] = d; heap.push({ f: d, g: 0, i }); }
    while (heap.size) {
      const { f, i } = heap.pop();
      if (f > D[i]) continue;
      for (const [j, c] of rev[i]) if (f + c < D[j]) { D[j] = f + c; heap.push({ f: f + c, g: 0, i: j }); }
    }
    const M = new Map();
    keys.forEach((key, i) => M.set(key, D[i]));
    return M;
  };
  const toDoor = dijkstra(door.map((i) => [i, 0]));
  const toGem = (gi) => dijkstra(gemEdges.filter((e) => e[2] === gi).map((e) => [e[0], e[1]]));
  return { toDoor, toGem, size: keys.length };
}

// h lookup with a small neighbourhood search for positions the relaxed run
// never stood on (mid-ride on a lift, a closed gate's top, …).
function lookup(M, fallback) {
  return (h) => {
    const d = M.get(hkey(h));
    if (d !== undefined) return d === Infinity ? fallback : d;
    const bx = Math.floor((h.x + 14) / 8), by = Math.floor((h.y + CHAR_H + 4) / 8);
    let best = Infinity;
    for (let r = 1; r <= 4 && best === Infinity; r++)
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        const v = M.get(`${bx + dx},${by + dy}`);
        if (v !== undefined && v < best) best = v;
      }
    return best === Infinity ? fallback : best;
  };
}

// ---------------------------------------------------------------- A*
class Heap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(n) { const a = this.a; a.push(n); let i = a.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (less(a[i], a[p])) { [a[i], a[p]] = [a[p], a[i]]; i = p; } else break; } }
  pop() {
    const a = this.a, top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last; let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1; let m = i;
        if (l < a.length && less(a[l], a[m])) m = l;
        if (r < a.length && less(a[r], a[m])) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]]; i = m;
      }
    }
    return top;
  }
}
const less = (a, b) => a.f < b.f || (a.f === b.f && a.g > b.g);

// ---------------------------------------------------------------- macro memo
// While the idle hero stands still — on rock or '=' (not a gate top), or on a
// lift that is not moving, and not at its door — nothing it does changes during
// the mover's macro, so the outcome depends only on the mover's exact state,
// the channel machinery and which plates / lift the idle hero holds. Those outcomes are cached per level — the
// search revisits the same mover state with the idle hero parked in hundreds
// of places. Every path the search reports is replayed afterwards on the real
// sim WITHOUT the cache (verify()), so a wrong cache entry can't fake a win.
function plateMask(w, h) {
  let m = 0;
  for (let i = 0; i < w.plates.length; i++) {
    const p = w.plates[i];
    const px = p.x * T + 4, py = p.y * T + T - 12;
    if (h.x < px + T - 8 && h.x + CHAR_W > px && h.y < py + 14 && h.y + CHAR_H > py) m |= 1 << i;
  }
  return m;
}
function anchored(w, h) {
  if (!h.grounded || h.atDoor || h.jumpBuf !== 0 || h.dead) return false;
  // on a lift that is standing still right now (if the mover's macro sets it
  // moving, the partner moves and that outcome is simply not cached)
  if (h.onLift >= 0) { const l = w.lifts[h.onLift]; return !!l && l.vx === 0 && l.vy === 0; }
  const bottom = h.y + CHAR_H;
  const row = Math.round(bottom / T);
  if (Math.abs(row * T - bottom) > 0.25) return false;
  for (let cx = Math.floor(h.x / T); cx <= Math.floor((h.x + CHAR_W - 0.01) / T); cx++) {
    const c = row >= 0 && row < ROWS ? w.grid[row][cx] : '#';
    if (c === '#' || c === '=') return true;
  }
  return false;
}
function memoKey(w, mi, k) {
  const o = w.heroes[OTHER[k]];
  if (!anchored(w, o)) return null;
  const h = w.heroes[k];
  // h.vx is overwritten from input before use, and so is coyote while grounded
  let s = `${mi}|${h.x},${h.y},${h.vy},${h.grounded ? 1 : h.coyote},${h.onLift},${h.jumpBuf},${h.jumpHeld ? 1 : 0},${h.leverTouch.join('')}|${plateMask(w, o)},${o.onLift}|`;
  for (const ch in w.leverOn) if (w.leverOn[ch]) s += ch;
  for (const v of w.levers) s += ',' + v.cd;
  for (const g of w.gates) s += ';' + g.open;
  for (const l of w.lifts) s += `:${l.px},${l.py},${l.vx},${l.vy}`;
  return s;
}

// Run macro m on world w in place. Gems never influence physics, so the
// mover's colour of gems is cleared for the run and the touched set OR-ed back
// afterwards — that makes the cached "touched" set independent of history.
function applyMacro(w, m, mi, memo) {
  const k = m.hero, o = OTHER[k];
  const key = memo ? memoKey(w, mi, k) : null;
  const myKind = k === 'f' ? 'r' : 'b';
  if (key !== null) {
    const e = memo.get(key);
    if (e) {
      if (!e.valid || e.dead) return e;
      Object.assign(w.heroes[k], clone(e.hero));
      Object.assign(w.heroes[o], e.other);
      w.leverOn = { ...e.leverOn };
      e.cd.forEach((v, i) => { w.levers[i].cd = v; });
      e.open.forEach((v, i) => { w.gates[i].open = v; });
      e.lifts.forEach((v, i) => { const l = w.lifts[i]; l.px = v[0]; l.py = v[1]; l.vx = v[2]; l.vy = v[3]; });
      e.pressed.forEach((v, i) => { w.plates[i].pressed = v; });
      for (let i = 0; i < w.gems.length; i++) if (e.touched & (1 << i)) w.gems[i].taken = true;
      w.mapTime += e.ticks * DT;
      w.doneT = 0;
      return e;
    }
  }
  const before = w.gems.map((g) => g.taken);
  for (const g of w.gems) if (g.kind === myKind) g.taken = false;
  const ox = w.heroes[o].x, oy = w.heroes[o].y;
  const r = runMacro(w, m);
  let touched = 0;
  for (let i = 0; i < w.gems.length; i++) {
    if (w.gems[i].taken && w.gems[i].kind === myKind) touched |= 1 << i;
    if (before[i]) w.gems[i].taken = true;
  }
  if (key !== null && !r.completed) {
    const oh = w.heroes[o];
    if (!r.valid || r.dead) memo.set(key, r);
    else if (oh.x === ox && oh.y === oy && anchored(w, oh)) {
      const h = w.heroes[k];
      memo.set(key, {
        ...r, touched,
        hero: clone(h),
        other: { vx: oh.vx, vy: oh.vy, coyote: oh.coyote, jumpBuf: oh.jumpBuf, jumpHeld: oh.jumpHeld, grounded: oh.grounded, onLift: oh.onLift, atDoor: oh.atDoor },
        leverOn: { ...w.leverOn },
        cd: w.levers.map((v) => v.cd),
        open: w.gates.map((g) => g.open),
        lifts: w.lifts.map((l) => [l.px, l.py, l.vx, l.vy]),
        pressed: w.plates.map((p) => p.pressed),
      });
    }
  }
  return r;
}

// goal(world, completed) → bool;  h(world) → seconds
// Returns { path, ticks } or { gaveUp }. `firstGem[i]` records a path that took gem i.
// `seed` (optional): a move list from the start; every state along it joins
// the frontier too, so a gem hunt can branch off anywhere on the winning route.
function search(n, { goal, h, deadline, gemUnion, memo, firstGem, near, weight = 1.5, seed = [] }) {
  const start = freshWorld(n);
  const nodes = [{ parent: -1, m: null, ticks: 0 }];
  const seen = new Map([[stateKey(start), 0]]);
  const open = new Heap();
  open.push({ id: 0, w: start, g: 0, f: weight * h(start), mover: null });
  let sw = start, sg = 0;
  for (const st of seed) {
    sw = cloneWorld(sw);
    const r = applyMacro(sw, st.m, MACROS.indexOf(st.m), memo);
    if (!r.valid || r.dead || r.completed) break;
    sg += r.ticks;
    const id = nodes.length;
    nodes.push({ parent: id - 1, m: st.m, ticks: r.ticks });
    const key = parked(sw, sw.heroes[st.m.hero], near) ? stateKey(sw) : stateKey(sw) + st.m.hero;
    if (!seen.has(key)) seen.set(key, id);
    open.push({ id, w: sw, g: sg, f: sg * DT + weight * h(sw), mover: st.m.hero });
  }
  let expansions = 0;
  while (open.size) {
    const cur = open.pop();
    const stop = ++expansions > MAX_EXPANSIONS ? 'node cap' : (expansions & 63) === 0 && Date.now() > deadline ? 'time cap' : null;
    if (stop) {
      if (process.env.SOLVE_TRACE) {
        const pairs = new Map();
        for (const k of seen.keys()) { const pk = k.split('|').slice(0, 2).join('|'); pairs.set(pk, (pairs.get(pk) || 0) + 1); }
        const fpos = new Set([...seen.keys()].map((k) => k.split('|')[0])), wpos = new Set([...seen.keys()].map((k) => k.split('|')[1]));
        console.error(`seen ${seen.size} heroPairs ${pairs.size} fpos ${fpos.size} wpos ${wpos.size} open ${open.size}`);
      }
      return { gaveUp: stop, expansions };
    }
    if (process.env.SOLVE_TRACE && expansions % 1000 === 0) { const F = cur.w.heroes.f, W = cur.w.heroes.w; console.error(`exp ${expansions} f=${cur.f.toFixed(2)} g=${(cur.g * DT).toFixed(2)} F(${colOf(F)},${footRow(F)}) W(${colOf(W)},${footRow(W)}) lev=${JSON.stringify(cur.w.leverOn)} gates=${cur.w.gates.map((g) => g.open.toFixed(2))} lifts=${cur.w.lifts.map((l) => (l.py / T).toFixed(1))} open=${open.size}`); }
    // hand control to the other hero only once the mover has parked somewhere useful
    const free = cur.mover === null || parked(cur.w, cur.w.heroes[cur.mover], near);
    for (let mi = 0; mi < MACROS.length; mi++) {
      const m = MACROS[mi];
      if (!free && m.hero !== cur.mover) continue;
      const w = cloneWorld(cur.w);
      const r = applyMacro(w, m, mi, memo);
      if (!r.valid || r.dead || r.ticks === 0) continue;
      const gm = gemMask(w);
      const g = cur.g + r.ticks;
      const fresh = gm & ~gemUnion.v;
      let id = -1;
      const node = () => { if (id < 0) { id = nodes.length; nodes.push({ parent: cur.id, m, ticks: r.ticks }); } return id; };
      if (fresh) {
        gemUnion.v |= gm;
        const path = unwind(nodes, node());
        for (let i = 0; i < w.gems.length; i++) if (fresh & (1 << i)) firstGem[i] = path;
      }
      if (goal(w, r.completed)) return { path: unwind(nodes, node()), ticks: g, expansions };
      const key = parked(w, w.heroes[m.hero], near) ? stateKey(w) : stateKey(w) + m.hero;
      if (seen.has(key)) continue;
      seen.set(key, node());
      open.push({ id: node(), w, g, f: g * DT + weight * h(w), mover: m.hero });
    }
  }
  return { gaveUp: 'exhausted (unsolvable with these macros)', expansions };
}

// A hero may be left idle (control switches to the partner) only where idling
// can matter: holding a plate, riding a lift, at its door, at its spawn, or
// next to a gate or a lift stop (just through a gate / just off a lift).
function nearMap(w0) {
  const N = new Uint8Array(COLS * ROWS);
  const mark = (x0, x1, y0, y1) => {
    for (let y = Math.max(0, y0); y <= Math.min(ROWS - 1, y1); y++)
      for (let x = Math.max(0, x0); x <= Math.min(COLS - 1, x1); x++) N[x + y * COLS] = 1;
  };
  for (const g of w0.gates) mark(g.x - 2, g.x + 2, g.y - 1, g.y + g.h);
  for (const l of w0.lifts) for (const [px, py] of [[l.x0, l.y0], [l.x1, l.y1]]) {
    const x = Math.round(px / T), y = Math.round(py / T), wt = Math.round(l.w / T);
    mark(x - 2, x + wt + 1, y - 3, y + 1);
  }
  for (const k of ['f', 'w']) { const s = w0.spawns[k]; mark(s.x, s.x, s.y, s.y); }
  return N;
}
function parked(w, h, near) {
  if (h.onLift >= 0 || h.atDoor || plateMask(w, h)) return true;
  const x = colOf(h), y = footRow(h);
  return x >= 0 && y >= 0 && x < COLS && y < ROWS && near[x + y * COLS] === 1;
}

// Replay a move list on a fresh world with the real sim (no cache).
function verify(n, path) {
  const w = freshWorld(n);
  let ticks = 0, completed = false;
  for (const s of path) {
    const r = runMacro(w, s.m);
    if (!r.valid || r.dead) return { ok: false, w, ticks };
    ticks += r.ticks;
    if (r.completed) { completed = true; break; }
  }
  return { ok: true, completed, w, ticks };
}
function unwind(nodes, id) {
  const out = [];
  while (id > 0) { out.push(nodes[id]); id = nodes[id].parent; }
  return out.reverse();
}

// ---------------------------------------------------------------- per level
function solveLevel(n) {
  const M = MAPS[n];
  const errs = validate(M, n);
  if (errs.length) return { n, M, errors: errs };
  const t0 = Date.now();
  const deadline = t0 + MAX_SECONDS * 1000;
  const w0 = freshWorld(n);
  const RG = { f: relaxedGraph(n, 'f'), w: relaxedGraph(n, 'w') };
  const FALLBACK = 30;
  const hf = lookup(RG.f.toDoor, FALLBACK), hw = lookup(RG.w.toDoor, FALLBACK);
  const gemUnion = { v: 0 };
  const firstGem = [];
  const memo = new Map();
  const near = nearMap(w0);
  let expansions = 0;

  const main = search(n, {
    goal: (w, done) => done,
    h: (w) => hf(w.heroes.f) + hw(w.heroes.w),
    deadline, gemUnion, memo, firstGem, near,
  });
  expansions += main.expansions;
  if (process.env.SOLVE_TRACE) console.error(`main: ${main.expansions} exp, ${((Date.now() - t0) / 1000).toFixed(1)} s, ${main.path ? 'solved' : main.gaveUp}`);
  let solved = !!main.path, gaveUp = main.gaveUp, seconds = null;
  if (solved) {
    const v = verify(n, main.path);
    if (!v.ok || !v.completed) { solved = false; gaveUp = 'path failed real-sim replay'; }
    else seconds = v.ticks * DT;
  }

  // gems the main search never touched: search toward whichever is nearest,
  // restarting (fresh frontier, shared cache) each time one more is taken
  const gems = w0.gems;
  const toGem = gems.map((g, i) => lookup(RG[g.kind === 'r' ? 'f' : 'w'].toGem(i), FALLBACK));
  for (;;) {
    const missing = gems.map((_, i) => i).filter((i) => !(gemUnion.v & (1 << i)));
    if (!missing.length || Date.now() > deadline) break;
    const r = search(n, {
      goal: (w) => missing.some((i) => w.gems[i].taken),
      h: (w) => Math.min(...missing.map((i) => toGem[i](w.heroes[gems[i].kind === 'r' ? 'f' : 'w']))),
      deadline, gemUnion, memo, firstGem, near, weight: 3, seed: main.path || [],
    });
    expansions += r.expansions;
    if (process.env.SOLVE_TRACE) console.error(`gems ${missing.join(',')}: ${r.expansions} exp, ${((Date.now() - t0) / 1000).toFixed(1)} s, ${r.path ? 'took ' + missing.filter((i) => gemUnion.v & (1 << i)).join(',') : r.gaveUp}`);
    if (!r.path) break;
  }
  // every gem claim is replayed on the real sim
  const gemFail = [];
  for (let i = 0; i < gems.length; i++) {
    const p = firstGem[i];
    const v = p && verify(n, p);
    if (!v || !v.ok || !v.w.gems[i].taken) gemFail.push(i);
  }
  const unreachable = gemFail.map((i) => `${gems[i].kind}@${gems[i].x},${gems[i].y}`);
  return {
    n, M, solved, gaveUp, seconds,
    path: main.path, expansions, unreachable, firstGem,
    gems: { r: gems.filter((g) => g.kind === 'r').length, b: gems.filter((g) => g.kind === 'b').length },
    wall: (Date.now() - t0) / 1000,
  };
}

// ---------------------------------------------------------------- CLI
export { validate, solveLevel, runMacro, applyMacro, MACROS, freshWorld, stateKey, parked, nearMap, label, relaxedGraph, lookup, search };
import { pathToFileURL } from 'node:url';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

function main() {
  const args = process.argv.slice(2);
  const showPath = args.includes('--path');
  const quiet = args.includes('--quiet');
  const trace = args.includes('--trace');
  const idxArg = args.find((a) => /^\d+$/.test(a));
  const which = idxArg != null ? [Number(idxArg)] : MAPS.map((_, i) => i);
  if (idxArg != null && !(Number(idxArg) < MAPS.length)) { console.error(`no level ${idxArg} (have ${MAPS.length})`); process.exit(1); }

  const pad = (s, n) => String(s).padEnd(n);
  const lpad = (s, n) => String(s).padStart(n);
  console.log(`${pad('#', 3)}${pad('name', 34)}${pad('solved', 8)}${lpad('solo s', 7)}${lpad('par', 5)}${lpad('par*', 6)}${lpad('gems r/b', 10)}${lpad('nodes', 8)}${lpad('wall s', 8)}  unreachable`);
  let failed = 0;
  for (const n of which) {
    const r = solveLevel(n);
    const nm = r.M && r.M.name ? `${r.M.name.en} / ${r.M.name.mn}` : '?';
    if (r.errors) {
      failed++;
      console.log(`${pad(n, 3)}${pad(nm, 34)}INVALID`);
      for (const e of r.errors) console.log('     ' + e);
      continue;
    }
    const ok = r.solved && r.unreachable.length === 0;
    if (!ok) failed++;
    const suggested = r.solved ? Math.ceil(r.seconds * 1.5) + 5 : '-';
    const parMark = r.solved && r.M.par !== suggested ? `${suggested}!` : `${suggested}`;
    console.log(
      `${pad(n, 3)}${pad(nm.slice(0, 33), 34)}${pad(r.solved ? 'yes' : 'NO', 8)}`
      + `${lpad(r.solved ? r.seconds.toFixed(1) : '-', 7)}${lpad(r.M.par, 5)}${lpad(parMark, 6)}`
      + `${lpad(`${r.gems.r}/${r.gems.b}`, 10)}${lpad(r.expansions, 8)}${lpad(r.wall.toFixed(1), 8)}  `
      + ([r.solved ? '' : `gave up: ${r.gaveUp}`, r.unreachable.length ? 'unreachable: ' + r.unreachable.join(' ') : ''].filter(Boolean).join('; ') || '-'),
    );
    if (showPath && r.path && !quiet) console.log('     ' + r.path.map((s) => label(s.m)).join(' · '));
    if (trace && r.path) {
      const w = freshWorld(n);
      const at = (h) => `${colOf(h)},${footRow(h)}`;
      for (const s of r.path) {
        runMacro(w, s.m);
        const ch = Object.keys(w.leverOn).filter((k) => w.leverOn[k]).join('');
        console.log(`     ${label(s.m).padEnd(16)} Дөл ${at(w.heroes.f).padEnd(6)} Дусал ${at(w.heroes.w).padEnd(6)}`
          + `${w.plates.some((p) => p.pressed) ? ' plates:' + w.plates.map((p) => (p.pressed ? p.ch : '-')).join('') : ''}`
          + `${ch ? ' levers:' + ch : ''}${w.gates.length ? ' gates:' + w.gates.map((g) => g.open.toFixed(1)).join(',') : ''}`
          + `${w.lifts.length ? ' lifts:' + w.lifts.map((l) => `${(l.px / T).toFixed(1)},${(l.py / T).toFixed(1)}`).join(' ') : ''}`);
      }
    }
  }
  if (!quiet) console.log(`\npar* = ceil(solo × 1.5) + 5 (marked ! when maps.js par differs). ${failed ? failed + ' level(s) FAILED' : 'all levels OK'}`);
  process.exit(failed ? 1 : 0);
}
