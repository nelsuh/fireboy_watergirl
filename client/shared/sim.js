// Shared deterministic platformer sim — the SAME code steps heroes on the server
// (authoritative, both heroes + full world) and on the client (prediction of the
// LOCAL hero only). Everything here is pure: no DOM, no rendering, no globals.
//
// Split of responsibilities:
//   • stepHeroKinematics(world, h, input, dt)  — movement + collision + jump.
//     Runs on BOTH sides. The client predicts its own hero with this against the
//     latest snapshot's gate/lift geometry.
//   • the gameplay layer (levers, gems, liquids/death, plates→gates/lifts, doors,
//     level completion) runs ONLY on the server (authoritative) via stepServer().

import {
  T, COLS, ROWS, WH, CHAR_W, CHAR_H, SPEED, JUMP_V, GRAV, MAX_FALL,
  LIFT_SPEED, COYOTE, JUMP_BUFFER, RESET_DELAY, DOOR_HOLD, TOTAL_LEVELS,
} from './protocol.js';
import { MAPS } from './maps.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// ---- level state ----
function makeHero(kind) {
  return {
    kind, x: 0, y: 0, vx: 0, vy: 0, face: 1,
    grounded: false, onLift: -1,
    coyote: 0, jumpBuf: 0, jumpHeld: false,
    dead: false, deadT: 0, atDoor: 0,
    leverTouch: [],
  };
}

// Build a fresh, fully-parsed world for level n (0-based).
export function makeWorld(n) {
  const world = { heroes: { f: makeHero('f'), w: makeHero('w') }, deaths: 0, ended: false };
  loadLevel(world, n);
  return world;
}

export function loadLevel(world, n) {
  const level = clamp(n, 0, TOTAL_LEVELS - 1);
  const M = MAPS[level];
  world.level = level;
  world.name = M.name;
  world.grid = M.grid;
  world.gems = [];
  world.liquids = [];
  world.doors = {};
  world.spawns = {};
  world.plates = M.plates.map((p) => ({ x: p.x, y: p.y, ch: p.ch, pressed: false }));
  world.levers = M.levers.map((v) => ({ x: v.x, y: v.y, ch: v.ch, cd: 0 }));
  world.leverOn = {};
  world.gates = M.gates.map((g) => ({ x: g.x, y: g.y, h: g.h, ch: g.ch, open: 0 }));
  world.lifts = M.lifts.map((f) => ({
    x0: f.x * T, y0: f.y * T, x1: (f.x + f.dx) * T, y1: (f.y + f.dy) * T,
    w: f.w * T, ch: f.ch, px: f.x * T, py: f.y * T, vx: 0, vy: 0,
  }));
  for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) {
    const c = M.grid[y][x];
    if (c === 'r' || c === 'b') world.gems.push({ x, y, kind: c, taken: false });
    else if (c === 'F' || c === 'W' || c === 'G') world.liquids.push({ x, y, kind: c });
    else if (c === 'A') world.spawns.f = { x, y };
    else if (c === 'B') world.spawns.w = { x, y };
    else if (c === 'D') world.doors.f = { x, y };
    else if (c === 'E') world.doors.w = { x, y };
  }
  respawnHeroes(world);
  world.resetPending = false;
  world.resetT = 0;
  world.doneT = 0;
  world.mapTime = 0;
}

export function respawnHeroes(world) {
  for (const k of ['f', 'w']) {
    const h = world.heroes[k], s = world.spawns[k];
    h.x = s.x * T + (T - CHAR_W) / 2;
    h.y = (s.y + 1) * T - CHAR_H;
    h.vx = 0; h.vy = 0; h.face = 1;
    h.dead = false; h.deadT = 0;
    h.grounded = true; h.onLift = -1;
    h.atDoor = 0; h.coyote = 0; h.jumpBuf = 0; h.jumpHeld = false;
    h.leverTouch = world.levers.map(() => false);
  }
}

// Restore the current level after a death (gems of this level respawn).
export function resetLevel(world) {
  for (const g of world.gems) g.taken = false;
  for (const g of world.gates) g.open = 0;
  world.leverOn = {};
  for (const f of world.lifts) { f.px = f.x0; f.py = f.y0; f.vx = 0; f.vy = 0; }
  for (const p of world.plates) p.pressed = false;
  respawnHeroes(world);
  world.resetPending = false;
}

// ---- collision ----
export function tileAt(world, cx, cy) {
  if (cx < 0 || cx >= COLS || cy < 0 || cy >= ROWS) return '#';
  return world.grid[cy][cx];
}

function gateRects(world) {
  const out = [];
  for (const g of world.gates) {
    const hpx = (1 - g.open) * g.h * T;
    if (hpx > 2) out.push({ x: g.x * T, y: g.y * T, w: T, h: hpx });
  }
  return out;
}

export function rectHitsSolid(world, x, y, w, h) {
  const x0 = Math.floor(x / T), x1 = Math.floor((x + w - 0.01) / T);
  const y0 = Math.floor(y / T), y1 = Math.floor((y + h - 0.01) / T);
  for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++)
    if (tileAt(world, cx, cy) === '#') return true;
  for (const r of gateRects(world))
    if (x < r.x + r.w && x + w > r.x && y < r.y + r.h && y + h > r.y) return true;
  return false;
}

function moveX(world, h, dx) {
  if (!dx) return;
  const step = Math.sign(dx) * Math.min(Math.abs(dx), 8);
  let left = dx;
  while (Math.abs(left) > 0.0001) {
    const d = Math.abs(left) > 8 ? step : left;
    if (rectHitsSolid(world, h.x + d, h.y, CHAR_W, CHAR_H)) {
      const dir = Math.sign(d);
      let lo = 0, hi = Math.abs(d);
      for (let i = 0; i < 8; i++) { const m = (lo + hi) / 2; if (rectHitsSolid(world, h.x + dir * m, h.y, CHAR_W, CHAR_H)) hi = m; else lo = m; }
      h.x += Math.sign(d) * lo;
      h.vx = 0;
      return;
    }
    h.x += d;
    left -= d;
  }
}

function moveY(world, h, dy) {
  h.grounded = false;
  h.onLift = -1;
  if (dy === 0) dy = 0.0001;
  const dir = Math.sign(dy);
  let left = dy;
  while (Math.abs(left) > 0.0001) {
    const d = dir * Math.min(Math.abs(left), 8);
    const prevBottom = h.y + CHAR_H;
    const ny = h.y + d;

    if (rectHitsSolid(world, h.x, ny, CHAR_W, CHAR_H)) {
      let lo = 0, hi = Math.abs(d);
      for (let i = 0; i < 8; i++) { const m = (lo + hi) / 2; if (rectHitsSolid(world, h.x, h.y + dir * m, CHAR_W, CHAR_H)) hi = m; else lo = m; }
      h.y += dir * lo;
      if (dir > 0) h.grounded = true;
      h.vy = 0;
      return;
    }

    if (dir > 0) {
      const nb = ny + CHAR_H;
      const rowTop = Math.floor(nb / T) * T;
      if (prevBottom <= rowTop + 2 && nb >= rowTop) {
        const row = Math.floor(nb / T);
        const c0 = Math.floor(h.x / T), c1 = Math.floor((h.x + CHAR_W - 0.01) / T);
        for (let cx = c0; cx <= c1; cx++) {
          if (tileAt(world, cx, row) === '=') {
            h.y = rowTop - CHAR_H; h.vy = 0; h.grounded = true; return;
          }
        }
      }
      for (let i = 0; i < world.lifts.length; i++) {
        const f = world.lifts[i];
        if (h.x + CHAR_W > f.px && h.x < f.px + f.w && prevBottom <= f.py + 6 && nb >= f.py) {
          h.y = f.py - CHAR_H; h.vy = 0; h.grounded = true; h.onLift = i; return;
        }
      }
    }
    h.y = ny;
    left -= d;
  }
}

// ---- kinematics (client-predicted + server) ----
// input: { left, right, jump }. Carrying on a moving lift is applied here using
// world.lifts[onLift].vx/vy (server fills these in updateChannels; the client
// fills them from snapshot deltas) so a rider tracks a horizontal ferry.
export function stepHeroKinematics(world, h, input, dt) {
  if (h.dead) { h.deadT += dt; return; }

  // carry by the lift we were standing on last tick (before we re-solve ground)
  if (h.onLift >= 0 && h.onLift < world.lifts.length) {
    const f = world.lifts[h.onLift];
    const nx = h.x + f.vx * dt;
    if (!rectHitsSolid(world, nx, h.y, CHAR_W, CHAR_H)) h.x = nx;
  }

  h.vx = input.left ? -SPEED : input.right ? SPEED : 0;
  if (h.vx) h.face = Math.sign(h.vx);

  if (input.jump && !h.jumpHeld) h.jumpBuf = JUMP_BUFFER;
  h.jumpHeld = input.jump;
  if (h.grounded) h.coyote = COYOTE;
  if (h.jumpBuf > 0 && h.coyote > 0) {
    h.vy = -JUMP_V;
    h.jumpBuf = 0; h.coyote = 0; h.grounded = false; h.onLift = -1;
  }
  h.jumpBuf = Math.max(0, h.jumpBuf - dt);
  h.coyote = Math.max(0, h.coyote - dt);

  h.vy = Math.min(h.vy + GRAV * dt, MAX_FALL);
  moveX(world, h, h.vx * dt);
  moveY(world, h, h.vy * dt);
}

// ---- channels (plates + levers → gates + lifts) — server authority ----
function heroRect(h) { return { x: h.x, y: h.y, w: CHAR_W, h: CHAR_H }; }
function overlaps(r, x, y, w, h) { return r.x < x + w && r.x + r.w > x && r.y < y + h && r.y + r.h > y; }

function channelActive(world, ch) {
  for (const p of world.plates) if (p.ch === ch && p.pressed) return true;
  return !!world.leverOn[ch];
}

function updateChannels(world, dt) {
  const rects = [];
  for (const k of ['f', 'w']) if (!world.heroes[k].dead) rects.push(heroRect(world.heroes[k]));
  for (const v of world.levers) v.cd = Math.max(0, v.cd - dt);
  for (const p of world.plates) {
    const px = p.x * T + 4, py = p.y * T + T - 12, pw = T - 8, ph = 14;
    p.pressed = rects.some((r) => overlaps(r, px, py, pw, ph));
  }
  for (const g of world.gates) {
    const target = channelActive(world, g.ch) ? 1 : 0;
    const rate = 2.6 / g.h;
    g.open = clamp(g.open + (target > g.open ? 1 : -1) * rate * dt, 0, 1);
    if (Math.abs(g.open - target) < 0.01) g.open = target;
  }
  for (let i = 0; i < world.lifts.length; i++) {
    const f = world.lifts[i];
    const act = channelActive(world, f.ch);
    const tx = act ? f.x1 : f.x0, ty = act ? f.y1 : f.y0;
    const dx = tx - f.px, dy = ty - f.py;
    const dist = Math.hypot(dx, dy);
    let mdx = 0, mdy = 0;
    if (dist > 0.01) {
      const m = Math.min(dist, LIFT_SPEED * dt);
      mdx = dx / dist * m; mdy = dy / dist * m;
      f.px += mdx; f.py += mdy;
    }
    f.vx = dt > 0 ? mdx / dt : 0;
    f.vy = dt > 0 ? mdy / dt : 0;
    for (const k of ['f', 'w']) {
      const h = world.heroes[k];
      if (h.onLift === i && !h.dead) {
        h.x += mdx;
        h.y = f.py - CHAR_H;
        if (rectHitsSolid(world, h.x, h.y, CHAR_W, CHAR_H)) h.x -= mdx;
      }
    }
  }
}

// ---- per-hero gameplay (levers/gems/liquids/doors) — server authority ----
// Returns a list of {type,...} events for the caller to broadcast.
function heroGameplay(world, key, events) {
  const h = world.heroes[key];
  if (h.dead) return;

  for (let i = 0; i < world.levers.length; i++) {
    const v = world.levers[i];
    const inside = overlaps(heroRect(h), v.x * T + 2, v.y * T - 6, T - 4, T + 6);
    if (inside && !h.leverTouch[i] && v.cd <= 0) {
      v.cd = 0.6;
      world.leverOn[v.ch] = !world.leverOn[v.ch];
      events.push({ type: 'lever', ch: v.ch, on: !!world.leverOn[v.ch] });
    }
    h.leverTouch[i] = inside;
  }

  for (let i = 0; i < world.gems.length; i++) {
    const g = world.gems[i];
    if (g.taken) continue;
    if ((g.kind === 'r') !== (key === 'f')) continue;
    const gx = g.x * T + T / 2, gy = g.y * T + T / 2;
    const cx = h.x + CHAR_W / 2, cy = h.y + CHAR_H / 2;
    if (Math.abs(gx - cx) < 22 && Math.abs(gy - cy) < 24) {
      g.taken = true;
      events.push({ type: 'gem', i, kind: g.kind });
    }
  }

  const feetY = h.y + CHAR_H - 8;
  for (const q of world.liquids) {
    const qx = q.x * T, qy = q.y * T + T * 0.5;
    if (h.x + CHAR_W - 4 > qx && h.x + 4 < qx + T && h.y + CHAR_H > qy + 4 && feetY < qy + T) {
      const fatal = q.kind === 'G' || (q.kind === 'W' && key === 'f') || (q.kind === 'F' && key === 'w');
      if (fatal) { killHero(world, key, q.kind, events); break; }
    }
  }

  if (h.y > WH + 60) killHero(world, key, 'G', events);

  const d = world.doors[key];
  h.atDoor = 0;
  if (d && !h.dead) {
    const dx = d.x * T, dy = (d.y - 1) * T;
    if (overlaps(heroRect(h), dx - 2, dy, T + 4, 2 * T) && h.grounded) h.atDoor = 1;
  }
}

function killHero(world, key, by, events) {
  const h = world.heroes[key];
  if (h.dead || world.resetPending) return;
  h.dead = true; h.deadT = 0;
  world.deaths++;
  world.resetPending = true;
  world.resetT = RESET_DELAY;
  events.push({ type: 'death', kind: by, hero: key === 'f' ? 0 : 1, n: world.deaths });
}

// ---- full authoritative tick (server) ----
// inputs: { f:{left,right,jump}, w:{...} }. Returns { events, completed }.
// `completed` is true on the tick both heroes finish the exit doors.
export function stepServer(world, inputs, dt) {
  const events = [];
  if (world.ended) return { events, completed: false };

  world.mapTime += dt;
  updateChannels(world, dt);
  for (const k of ['f', 'w']) stepHeroKinematics(world, world.heroes[k], inputs[k] || {}, dt);
  for (const k of ['f', 'w']) heroGameplay(world, k, events);

  // completion: both heroes standing at their doors for DOOR_HOLD
  let completed = false;
  const bothIn = world.heroes.f.atDoor && world.heroes.w.atDoor && !world.resetPending;
  if (bothIn) {
    world.doneT = (world.doneT || 0) + dt;
    if (world.doneT > DOOR_HOLD) completed = true;
  } else {
    world.doneT = 0;
  }

  if (world.resetPending) {
    world.resetT -= dt;
    if (world.resetT <= 0) resetLevel(world);
  }

  return { events, completed };
}

// ---- snapshot helpers ----
export function heroFlags(h, HF) {
  let f = 0;
  if (h.grounded) f |= HF.HF_GROUND;
  if (h.face >= 0) f |= HF.HF_FACE_R;
  if (h.dead) f |= HF.HF_DEAD;
  if (h.atDoor) f |= HF.HF_DOOR;
  return f;
}

export function gemsBitmask(world) {
  let m = 0;
  for (let i = 0; i < world.gems.length && i < 32; i++) if (world.gems[i].taken) m |= (1 << i);
  return m >>> 0;
}

export function leversBitmask(world) {
  let m = 0;
  for (const ch in world.leverOn) if (world.leverOn[ch]) m |= (1 << (Number(ch) - 1));
  return m & 0xff;
}
