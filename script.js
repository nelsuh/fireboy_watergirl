// ╔══════════════════════════════════════════════════════════╗
// ║  FIRE & WATER — a Fireboy & Watergirl style co-op          ║
// ║  platformer for Usion.                                     ║
// ║                                                            ║
// ║  Landscape mobile: ◀ ▶ + jump. 5 maps, easy → hard.        ║
// ║                                                            ║
// ║  Modes:                                                    ║
// ║   • solo (Explore / GameTok) — you control BOTH heroes,    ║
// ║     swapping with ⇄; the idle hero stands still (and can   ║
// ║     hold pressure plates).                                 ║
// ║   • multiplayer (chat invite, 2 players) — host is         ║
// ║     Fireboy, guest is Watergirl. Each client simulates     ║
// ║     ONLY its own hero and broadcasts position at 20 Hz     ║
// ║     (authoritative-shooter model, like table_soccer).      ║
// ║     Levers/gems/deaths/level-advance are events; the host  ║
// ║     decides level completion.                              ║
// ╚══════════════════════════════════════════════════════════╝

"use strict";

// ── World constants (fixed logical units — never px) ──────
const T = 32, COLS = 36, ROWS = 20;
const WW = COLS * T, WH = ROWS * T;          // 1152 x 640
const CHAR_W = 20, CHAR_H = 28;
const SPEED = 170;                            // run speed u/s
const JUMP_V = 575;                           // jump velocity (≈3.3 tiles high — 3-tile ledges reachable, 4-tile gates are not)
const GRAV = 1500, MAX_FALL = 920;
const LIFT_SPEED = 78;                        // platform glide u/s
const COYOTE = 0.08, JUMP_BUFFER = 0.12;      // jump feel helpers
const DT = 1 / 60;

const CH_COLORS = { 1: "#ffd34d", 2: "#b98bff", 3: "#59e0d8", 4: "#ff7ab8" };
const TOTAL_LEVELS = MAPS.length;

// ── DOM ───────────────────────────────────────────────────
const rot = document.getElementById("rot");
const canvas = document.getElementById("board");
const ctx = canvas.getContext("2d");
const btnLeft = document.getElementById("btnLeft");
const btnRight = document.getElementById("btnRight");
const btnJump = document.getElementById("btnJump");
const btnSwap = document.getElementById("btnSwap");
const waitingOverlay = document.getElementById("waitingOverlay");
const pauseOverlay = document.getElementById("pauseOverlay");
const pauseText = document.getElementById("pauseText");
const endOverlay = document.getElementById("endOverlay");
const endTitle = document.getElementById("endTitle");
const endStats = document.getElementById("endStats");
const endEmoji = document.getElementById("endEmoji");
const againBtn = document.getElementById("againBtn");
const soloBtn = document.getElementById("soloBtn");
const toastEl = document.getElementById("toast");

// ── Game state ────────────────────────────────────────────
let level = 0;              // 0-based index into MAPS
let L = null;               // parsed current level
let chars = null;           // { f: hero, w: hero }
let deaths = 0;
let gemsGot = 0;            // banked gems (completed levels) + current takes
let startedAt = 0, finishedAt = 0;
let running = false, ended = false, paused = false;
let introT = 0;             // level-name splash timer
let resetPending = false;
let resetT = 0;             // countdown to level reset after a death
let time = 0;               // sim clock (visuals)

// Solo control
let soloControlBoth = true; // true when one human drives both heroes
let activeChar = "f";

// Multiplayer
let isMultiplayer = false;
let myId = null;
let players = [];           // canonical roster (config.playerIds order)
let myChar = "f", remoteChar = "w";
let partnerHere = false;
let partnerName = "Partner";
let playerNames = {};
let remote = { x: 0, y: 0, vx: 0, vy: 0, face: 1, g: 1, d: 0, dead: 0, lvl: -1, fresh: false };
let netPaused = false;
let lastRestartAt = 0;

// FX
let particles = [];         // {x,y,vx,vy,life,max,col,r}

// Total gems across all maps (for the victory screen)
const TOTAL_GEMS = MAPS.reduce((n, m) => n + m.grid.join("").replace(/[^rb]/g, "").length, 0);

// ── Helpers ───────────────────────────────────────────────
function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
function lerp(a, b, t) { return a + (b - a) * t; }
function hash2(x, y) { let h = (x * 374761393 + y * 668265263) | 0; h = (h ^ (h >> 13)) * 1274126177; return ((h ^ (h >> 16)) >>> 0) / 4294967296; }

function showToast(msg, ms) {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => { toastEl.hidden = true; }, ms || 2600);
}

// ── Level parsing ─────────────────────────────────────────
function mkHero(kind) {
  return {
    kind,                    // 'f' | 'w'
    x: 0, y: 0,              // top-left, logical units
    vx: 0, vy: 0,
    face: 1,
    grounded: false,
    onLift: -1,
    coyote: 0, jumpBuf: 0, jumpHeld: false,
    dead: false, deadT: 0,
    atDoor: 0,
    doorT: 0,
    leverTouch: [],
    rx: 0, ry: 0,            // render position (lerped for the remote hero)
  };
}

function loadLevel(n, opts) {
  opts = opts || {};
  level = clamp(n, 0, TOTAL_LEVELS - 1);
  const M = MAPS[level];
  L = {
    name: M.name,
    grid: M.grid,
    gems: [],
    liquids: [],
    doors: {},
    spawns: {},
    plates: M.plates.map(p => ({ x: p.x, y: p.y, ch: p.ch, pressed: false })),
    levers: M.levers.map(v => ({ x: v.x, y: v.y, ch: v.ch, cd: 0 })),
    leverOn: {},
    gates: M.gates.map(g => ({ x: g.x, y: g.y, h: g.h, ch: g.ch, open: 0 })),
    lifts: M.lifts.map(f => ({
      x0: f.x * T, y0: f.y * T, x1: (f.x + f.dx) * T, y1: (f.y + f.dy) * T,
      w: f.w * T, ch: f.ch, px: f.x * T, py: f.y * T,
    })),
  };
  for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) {
    const c = M.grid[y][x];
    if (c === "r" || c === "b") L.gems.push({ x, y, kind: c, taken: false });
    else if (c === "F" || c === "W" || c === "G") L.liquids.push({ x, y, kind: c });
    else if (c === "A") L.spawns.f = { x, y };
    else if (c === "B") L.spawns.w = { x, y };
    else if (c === "D") L.doors.f = { x, y };
    else if (c === "E") L.doors.w = { x, y };
  }
  if (!chars) chars = { f: mkHero("f"), w: mkHero("w") };
  respawnHeroes();
  resetPending = false;
  if (!opts.silent) introT = 1.4;
}

function respawnHeroes() {
  for (const k of ["f", "w"]) {
    const h = chars[k], s = L.spawns[k];
    h.x = s.x * T + (T - CHAR_W) / 2;
    h.y = (s.y + 1) * T - CHAR_H;
    h.vx = 0; h.vy = 0; h.face = 1;
    h.dead = false; h.deadT = 0;
    h.grounded = true; h.onLift = -1;
    h.atDoor = 0; h.doorT = 0;
    h.coyote = 0; h.jumpBuf = 0;
    h.leverTouch = L.levers.map(() => false);
    h.rx = h.x; h.ry = h.y;
  }
}

// Restore the current level after a death (gems of this level respawn).
function resetLevel() {
  let back = 0;
  for (const g of L.gems) if (g.taken) { g.taken = false; back++; }
  gemsGot = Math.max(0, gemsGot - back);
  for (const g of L.gates) g.open = 0;
  L.leverOn = {};
  for (const f of L.lifts) { f.px = f.x0; f.py = f.y0; }
  for (const p of L.plates) p.pressed = false;
  respawnHeroes();
  resetPending = false;
}

// ── Collision ─────────────────────────────────────────────
function tileAt(cx, cy) {
  if (cx < 0 || cx >= COLS || cy < 0 || cy >= ROWS) return "#";
  return L.grid[cy][cx];
}

// Gates behave as solid rects anchored at their top, shrinking
// upward from the bottom as they open (a blade retracting up).
function gateRects() {
  const out = [];
  for (const g of L.gates) {
    const hpx = (1 - g.open) * g.h * T;
    if (hpx > 2) out.push({ x: g.x * T, y: g.y * T, w: T, h: hpx });
  }
  return out;
}

function rectHitsSolid(x, y, w, h) {
  const x0 = Math.floor(x / T), x1 = Math.floor((x + w - 0.01) / T);
  const y0 = Math.floor(y / T), y1 = Math.floor((y + h - 0.01) / T);
  for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++)
    if (tileAt(cx, cy) === "#") return true;
  for (const r of gateRects())
    if (x < r.x + r.w && x + w > r.x && y < r.y + r.h && y + h > r.y) return true;
  return false;
}

function moveX(h, dx) {
  if (!dx) return;
  const step = Math.sign(dx) * Math.min(Math.abs(dx), 8);
  let left = dx;
  while (Math.abs(left) > 0.0001) {
    const d = Math.abs(left) > 8 ? step : left;
    if (rectHitsSolid(h.x + d, h.y, CHAR_W, CHAR_H)) {
      // snap flush to the obstruction
      const dir = Math.sign(d);
      let lo = 0, hi = Math.abs(d);
      for (let i = 0; i < 8; i++) { const m = (lo + hi) / 2; if (rectHitsSolid(h.x + dir * m, h.y, CHAR_W, CHAR_H)) hi = m; else lo = m; }
      h.x += Math.sign(d) * lo;
      h.vx = 0;
      return;
    }
    h.x += d;
    left -= d;
  }
}

function moveY(h, dy) {
  h.grounded = false;
  h.onLift = -1;
  if (dy === 0) dy = 0.0001;
  const dir = Math.sign(dy);
  let left = dy;
  while (Math.abs(left) > 0.0001) {
    const d = dir * Math.min(Math.abs(left), 8);
    const prevBottom = h.y + CHAR_H;
    let ny = h.y + d;

    // solid tiles + gates
    if (rectHitsSolid(h.x, ny, CHAR_W, CHAR_H)) {
      let lo = 0, hi = Math.abs(d);
      for (let i = 0; i < 8; i++) { const m = (lo + hi) / 2; if (rectHitsSolid(h.x, h.y + dir * m, CHAR_W, CHAR_H)) hi = m; else lo = m; }
      h.y += dir * lo;
      if (dir > 0) { h.grounded = true; }
      h.vy = 0;
      return;
    }

    if (dir > 0) {
      // one-way platforms: land only when falling from above
      const nb = ny + CHAR_H;
      const rowTop = Math.floor(nb / T) * T;
      if (prevBottom <= rowTop + 2 && nb >= rowTop) {
        const row = Math.floor(nb / T);
        const c0 = Math.floor(h.x / T), c1 = Math.floor((h.x + CHAR_W - 0.01) / T);
        for (let cx = c0; cx <= c1; cx++) {
          if (tileAt(cx, row) === "=") {
            h.y = rowTop - CHAR_H;
            h.vy = 0; h.grounded = true;
            return;
          }
        }
      }
      // lifts: land on the platform's top surface
      for (let i = 0; i < L.lifts.length; i++) {
        const f = L.lifts[i];
        if (h.x + CHAR_W > f.px && h.x < f.px + f.w &&
            prevBottom <= f.py + 6 && nb >= f.py) {
          h.y = f.py - CHAR_H;
          h.vy = 0; h.grounded = true; h.onLift = i;
          return;
        }
      }
    }
    h.y = ny;
    left -= d;
  }
}

// ── Channels (plates + levers) ────────────────────────────
function heroRect(h) { return { x: h.x, y: h.y, w: CHAR_W, h: CHAR_H }; }
function remoteRect() { return { x: remote.x, y: remote.y, w: CHAR_W, h: CHAR_H }; }

function overlaps(r, x, y, w, h) {
  return r.x < x + w && r.x + r.w > x && r.y < y + h && r.y + r.h > y;
}

function pressRects() {
  // rects that can press plates: living heroes (local sim + remote net pos)
  const out = [];
  if (isMultiplayer && partnerHere) {
    if (!chars[myChar].dead) out.push(heroRect(chars[myChar]));
    if (!remote.dead && remote.lvl === level) out.push(remoteRect());
  } else {
    for (const k of ["f", "w"]) if (!chars[k].dead) out.push(heroRect(chars[k]));
  }
  return out;
}

function channelActive(ch) {
  for (const p of L.plates) if (p.ch === ch && p.pressed) return true;
  return !!L.leverOn[ch];
}

function updateChannels(dt) {
  const rects = pressRects();
  for (const v of L.levers) v.cd = Math.max(0, v.cd - dt);
  for (const p of L.plates) {
    const px = p.x * T + 4, py = p.y * T + T - 12, pw = T - 8, ph = 14;
    p.pressed = rects.some(r => overlaps(r, px, py, pw, ph));
  }
  for (const g of L.gates) {
    const target = channelActive(g.ch) ? 1 : 0;
    const rate = 2.6 / g.h;
    g.open = clamp(g.open + (target > g.open ? 1 : -1) * rate * dt, 0, 1);
    if (Math.abs(g.open - target) < 0.01) g.open = target;
  }
  for (const f of L.lifts) {
    const act = channelActive(f.ch);
    const tx = act ? f.x1 : f.x0, ty = act ? f.y1 : f.y0;
    const dx = tx - f.px, dy = ty - f.py;
    const dist = Math.hypot(dx, dy);
    let mdx = 0, mdy = 0;
    if (dist > 0.01) {
      const m = Math.min(dist, LIFT_SPEED * dt);
      mdx = dx / dist * m; mdy = dy / dist * m;
      f.px += mdx; f.py += mdy;
    }
    // carry riders
    for (const k of simulatedHeroes()) {
      const h = chars[k];
      if (h.onLift === L.lifts.indexOf(f) && !h.dead) {
        h.x += mdx;
        h.y = f.py - CHAR_H;
        if (rectHitsSolid(h.x, h.y, CHAR_W, CHAR_H)) h.x -= mdx; // pushed into a wall — undo
      }
    }
  }
}

function simulatedHeroes() {
  return (isMultiplayer && partnerHere) ? [myChar] : ["f", "w"];
}

// ── Hero simulation ───────────────────────────────────────
const input = { left: false, right: false, jump: false };

function stepHero(k, dt) {
  const h = chars[k];
  if (h.dead) { h.deadT += dt; return; }
  const drives = (k === activeChar) || (isMultiplayer && partnerHere && k === myChar);
  const inp = drives ? input : { left: false, right: false, jump: false };

  h.vx = inp.left ? -SPEED : inp.right ? SPEED : 0;
  if (h.vx) h.face = Math.sign(h.vx);

  // jump buffering + coyote time
  if (inp.jump && !h.jumpHeld) h.jumpBuf = JUMP_BUFFER;
  h.jumpHeld = inp.jump;
  if (h.grounded) h.coyote = COYOTE;
  if (h.jumpBuf > 0 && h.coyote > 0) {
    h.vy = -JUMP_V;
    h.jumpBuf = 0; h.coyote = 0; h.grounded = false; h.onLift = -1;
  }
  h.jumpBuf = Math.max(0, h.jumpBuf - dt);
  h.coyote = Math.max(0, h.coyote - dt);

  h.vy = Math.min(h.vy + GRAV * dt, MAX_FALL);
  moveX(h, h.vx * dt);
  moveY(h, h.vy * dt);

  // levers: edge-triggered on touch
  for (let i = 0; i < L.levers.length; i++) {
    const v = L.levers[i];
    const inside = overlaps(heroRect(h), v.x * T + 2, v.y * T - 6, T - 4, T + 6);
    if (inside && !h.leverTouch[i] && v.cd <= 0) {
      v.cd = 0.6;      // debounce: a jump arc can graze the zone twice
      L.leverOn[v.ch] = !L.leverOn[v.ch];
      spawnBurst(v.x * T + T / 2, v.y * T + T / 2, CH_COLORS[v.ch] || "#fff", 8);
      if (isMultiplayer) sendRT("lever", { lvl: level, ch: v.ch, on: !!L.leverOn[v.ch] });
    }
    h.leverTouch[i] = inside;
  }

  // gems (color-matched)
  for (let i = 0; i < L.gems.length; i++) {
    const g = L.gems[i];
    if (g.taken) continue;
    if ((g.kind === "r") !== (k === "f")) continue;
    const gx = g.x * T + T / 2, gy = g.y * T + T / 2;
    const cx = h.x + CHAR_W / 2, cy = h.y + CHAR_H / 2;
    if (Math.abs(gx - cx) < 22 && Math.abs(gy - cy) < 24) {
      g.taken = true; gemsGot++;
      spawnBurst(gx, gy, g.kind === "r" ? "#ff8a5a" : "#6db9ff", 10);
      if (isMultiplayer) sendRT("gem", { lvl: level, i });
    }
  }

  // liquids: feet dipping into a fatal pool
  const feetY = h.y + CHAR_H - 8;
  for (const q of L.liquids) {
    const qx = q.x * T, qy = q.y * T + T * 0.5;
    if (h.x + CHAR_W - 4 > qx && h.x + 4 < qx + T && h.y + CHAR_H > qy + 4 && feetY < qy + T) {
      const fatal = q.kind === "G" || (q.kind === "W" && k === "f") || (q.kind === "F" && k === "w");
      if (fatal) { killHero(k, q.kind); break; }
    }
  }

  // fell out of the world (safety)
  if (h.y > WH + 60) killHero(k, "G");

  // exit door
  const d = L.doors[k];
  h.atDoor = 0;
  if (d && !h.dead) {
    const dx = d.x * T, dy = (d.y - 1) * T;
    if (overlaps(heroRect(h), dx - 2, dy, T + 4, 2 * T) && h.grounded) h.atDoor = 1;
  }
}

function killHero(k, by) {
  const h = chars[k];
  if (h.dead || resetPending) return;
  h.dead = true; h.deadT = 0;
  deaths++;
  spawnBurst(h.x + CHAR_W / 2, h.y + CHAR_H / 2,
    by === "F" ? "#ff7a3c" : by === "W" ? "#4da3ff" : "#7ed957", 16);
  resetPending = true;
  resetT = 0.9;
  if (isMultiplayer) sendRT("death", { lvl: level, n: deaths });
}

// ── Level completion ──────────────────────────────────────
function updateDoors(dt) {
  let bothIn;
  if (isMultiplayer && partnerHere) {
    // Host decides; the guest only reports its own door state via pos msgs.
    if (players[0] !== myId) return;
    bothIn = chars[myChar].atDoor && remote.d && remote.lvl === level && !remote.dead;
  } else {
    bothIn = chars.f.atDoor && chars.w.atDoor;
  }
  if (bothIn && !resetPending) {
    L._doneT = (L._doneT || 0) + dt;
    if (L._doneT > 0.45) advanceLevel();
  } else L._doneT = 0;
}

function advanceLevel() {
  const to = level + 1;
  if (isMultiplayer) {
    sendRT("advance", { to, deaths, gems: gemsGot });
    hostCheckpoint(to);
  }
  applyAdvance(to);
}

function applyAdvance(to) {
  if (to >= TOTAL_LEVELS) { showVictory(); return; }
  loadLevel(to);
}

function showVictory() {
  ended = true;
  finishedAt = Date.now();
  const secs = Math.max(1, Math.round((finishedAt - startedAt) / 1000));
  const mm = Math.floor(secs / 60), ss = ("0" + (secs % 60)).slice(-2);
  endEmoji.textContent = "🏆";
  endTitle.textContent = "All 5 maps cleared!";
  endStats.textContent = `💎 ${gemsGot}/${TOTAL_GEMS} gems · ☠ ${deaths} falls · ⏱ ${mm}:${ss}`;
  endOverlay.hidden = false;
  if (isMultiplayer) hostCheckpoint(TOTAL_LEVELS);
}

function restartAll(broadcast) {
  endOverlay.hidden = true;
  ended = false;
  deaths = 0; gemsGot = 0;
  startedAt = Date.now();
  lastRestartAt = Date.now();
  loadLevel(0);
  if (broadcast && isMultiplayer) { sendRT("restart", {}); hostCheckpoint(0); }
}

// ── FX ────────────────────────────────────────────────────
function spawnBurst(x, y, col, n) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2, s = 60 + Math.random() * 160;
    particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 60, life: 0, max: 0.5 + Math.random() * 0.4, col, r: 2 + Math.random() * 3 });
  }
}
function stepParticles(dt) {
  for (const p of particles) { p.life += dt; p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 500 * dt; }
  particles = particles.filter(p => p.life < p.max);
}

// ── Main loop ─────────────────────────────────────────────
window.addEventListener("error", e => { window.__err = (window.__err || []).concat(String(e.message)); });

let lastFrame = 0, acc = 0, sizeCheckT = 0, lastRafAt = 0;
// rAF is throttled to zero in hidden/backgrounded webviews — keep the
// simulation stepping with a low-rate fallback so the game never freezes.
// The fallback calls frame() directly and must NOT schedule extra rAF chains.
setInterval(() => {
  if (performance.now() - lastRafAt > 220) frame(performance.now(), true);
}, 66);

function simStep() {
  time += DT;
  updateChannels(DT);
  for (const k of simulatedHeroes()) stepHero(k, DT);
  updateDoors(DT);
  stepParticles(DT);
  if (resetPending) {
    resetT -= DT;
    if (resetT <= 0) resetLevel();
  }
}

function frame(ts, fromWatchdog) {
  window.__frames = (window.__frames || 0) + 1;
  if (!fromWatchdog) {
    lastRafAt = performance.now();
    requestAnimationFrame(frame);
  }
  if (!lastFrame) lastFrame = ts;
  // auto-heal canvas size (initial layout may land after first resize())
  if (ts - sizeCheckT > 500) {
    sizeCheckT = ts;
    if (canvas.width !== Math.round(rot.clientWidth * dpr)) resize();
  }
  let dt = Math.min(0.1, (ts - lastFrame) / 1000);
  lastFrame = ts;
  if (!L || !chars) return;
  if (running && !paused && !ended && !netPaused) {
    acc += dt;
    let steps = 0;
    while (acc >= DT && steps < 5) {
      simStep();
      acc -= DT; steps++;
    }
    if (steps === 5) acc = 0;
  }
  // remote hero render smoothing
  if (isMultiplayer && partnerHere) {
    const h = chars[remoteChar];
    h.x = remote.x; h.y = remote.y; h.face = remote.face; h.dead = !!remote.dead;
    h.rx = lerp(h.rx, remote.x, Math.min(1, dt * 14));
    h.ry = lerp(h.ry, remote.y, Math.min(1, dt * 14));
  }
  for (const k of simulatedHeroes()) { const h = chars[k]; h.rx = h.x; h.ry = h.y; }
  introT = Math.max(0, introT - dt);
  draw();
}

// ── Rendering ─────────────────────────────────────────────
let cw = 0, chh = 0, dpr = 1, scale = 1, ox = 0, oy = 0;

function resize() {
  const portrait = window.innerHeight > window.innerWidth * 1.05;
  rot.classList.toggle("rotated", portrait);
  const w = rot.clientWidth, h = rot.clientHeight;
  dpr = Math.min(2, window.devicePixelRatio || 1);
  cw = w; chh = h;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  scale = Math.min(w / WW, h / WH);
  ox = (w - WW * scale) / 2;
  oy = (h - WH * scale) / 2;
}
window.addEventListener("resize", () => setTimeout(resize, 50));

function draw() {
  if (!L) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  // letterbox background
  const bg = ctx.createLinearGradient(0, 0, 0, chh);
  bg.addColorStop(0, "#11141f"); bg.addColorStop(1, "#0a0c13");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, cw, chh);

  ctx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * ox, dpr * oy);
  ctx.save();
  ctx.beginPath(); ctx.rect(0, 0, WW, WH); ctx.clip();

  // cave backdrop
  const cave = ctx.createLinearGradient(0, 0, 0, WH);
  cave.addColorStop(0, "#1b2030"); cave.addColorStop(0.6, "#171c2a"); cave.addColorStop(1, "#131722");
  ctx.fillStyle = cave;
  ctx.fillRect(0, 0, WW, WH);
  // faint background rocks
  for (let i = 0; i < 26; i++) {
    const rx = hash2(i, 7) * WW, ry = hash2(i, 13) * WH, rr = 30 + hash2(i, 3) * 80;
    ctx.fillStyle = "rgba(255,255,255,0.018)";
    ctx.beginPath(); ctx.arc(rx, ry, rr, 0, 7); ctx.fill();
  }

  drawTiles();
  drawDoors();
  drawGates();
  drawLifts();
  drawPlates();
  drawLevers();
  drawLiquids();
  drawGems();
  drawHero(chars.w);
  drawHero(chars.f);
  drawParticles();
  drawHUD();
  ctx.restore();
}

function drawTiles() {
  for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) {
    const c = L.grid[y][x];
    if (c === "#") {
      const shade = 0.9 + hash2(x, y) * 0.2;
      const px = x * T, py = y * T;
      ctx.fillStyle = `rgb(${(42 * shade) | 0},${(47 * shade) | 0},${(62 * shade) | 0})`;
      ctx.fillRect(px, py, T, T);
      if (tileAt(x, y - 1) !== "#") {                       // grassy-glow top edge
        ctx.fillStyle = "rgba(130,150,190,0.5)";
        ctx.fillRect(px, py, T, 3);
      }
      ctx.fillStyle = "rgba(0,0,0,0.14)";
      ctx.fillRect(px + T - 3, py + 3, 3, T - 3);
    } else if (c === "=") {
      const px = x * T, py = y * T;
      ctx.fillStyle = "#5b4a35";
      ctx.fillRect(px, py, T, 8);
      ctx.fillStyle = "#7a6448";
      ctx.fillRect(px, py, T, 3);
    }
  }
}

function drawLiquids() {
  for (const q of L.liquids) {
    const px = q.x * T, py = q.y * T + T * 0.5;
    const col = q.kind === "F" ? ["#ff6a2a", "#c93a10"] : q.kind === "W" ? ["#48a7ff", "#1c62c9"] : ["#7ed941", "#3f9a1e"];
    const g = ctx.createLinearGradient(0, py, 0, py + T * 0.5);
    g.addColorStop(0, col[0]); g.addColorStop(1, col[1]);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(px, py + 4 + Math.sin(time * 4 + q.x * 1.7) * 2);
    for (let i = 1; i <= 4; i++) {
      const wx = px + (T / 4) * i;
      ctx.lineTo(wx, py + 4 + Math.sin(time * 4 + (q.x + i / 4) * 1.7) * 2);
    }
    ctx.lineTo(px + T, py + T * 0.5); ctx.lineTo(px, py + T * 0.5);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = q.kind === "F" ? "rgba(255,140,60,0.15)" : q.kind === "W" ? "rgba(90,170,255,0.12)" : "rgba(130,220,70,0.12)";
    ctx.fillRect(px, py - 10, T, 10);
  }
}

function drawGems() {
  for (const g of L.gems) {
    if (g.taken) continue;
    const x = g.x * T + T / 2, y = g.y * T + T / 2 + Math.sin(time * 3 + g.x) * 3;
    const r = 7;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(Math.sin(time * 2 + g.y) * 0.2);
    ctx.fillStyle = g.kind === "r" ? "#ff5f3c" : "#3e9bff";
    ctx.beginPath();
    ctx.moveTo(0, -r); ctx.lineTo(r * 0.8, 0); ctx.lineTo(0, r); ctx.lineTo(-r * 0.8, 0);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.65)";
    ctx.beginPath(); ctx.moveTo(0, -r + 2); ctx.lineTo(3, -1); ctx.lineTo(-2, 0); ctx.closePath(); ctx.fill();
    ctx.restore();
  }
}

function drawDoors() {
  for (const k of ["f", "w"]) {
    const d = L.doors[k];
    if (!d) continue;
    const px = d.x * T, py = (d.y - 1) * T;
    const fire = k === "f";
    ctx.fillStyle = "#3a4157";
    ctx.beginPath();
    ctx.moveTo(px - 3, py + 2 * T);
    ctx.lineTo(px - 3, py + 10);
    ctx.arc(px + T / 2, py + 10, T / 2 + 3, Math.PI, 0);
    ctx.lineTo(px + T + 3, py + 2 * T);
    ctx.closePath(); ctx.fill();
    const glow = fire ? "#ff8a4a" : "#4da3ff";
    const g = ctx.createLinearGradient(0, py, 0, py + 2 * T);
    g.addColorStop(0, glow); g.addColorStop(1, fire ? "#8a2f0e" : "#123c7a");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(px + 2, py + 2 * T);
    ctx.lineTo(px + 2, py + 12);
    ctx.arc(px + T / 2, py + 12, T / 2 - 2, Math.PI, 0);
    ctx.lineTo(px + T - 2, py + 2 * T);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.font = "13px sans-serif"; ctx.textAlign = "center";
    ctx.fillText(fire ? "🔥" : "💧", px + T / 2, py + T + 6);
  }
}

function drawPlates() {
  for (const p of L.plates) {
    const px = p.x * T, py = p.y * T;
    const col = CH_COLORS[p.ch] || "#fff";
    const off = p.pressed ? 5 : 0;
    ctx.fillStyle = "#20242f";
    ctx.fillRect(px + 2, py + T - 6, T - 4, 6);
    ctx.fillStyle = col;
    ctx.fillRect(px + 6, py + T - 12 + off, T - 12, 7 - off);
  }
}

function drawLevers() {
  for (const v of L.levers) {
    const cx = v.x * T + T / 2, cy = v.y * T + T - 6;
    const on = !!L.leverOn[v.ch];
    const col = CH_COLORS[v.ch] || "#fff";
    ctx.fillStyle = "#2a2f3e";
    ctx.beginPath(); ctx.arc(cx, cy, 6, 0, 7); ctx.fill();
    ctx.strokeStyle = col; ctx.lineWidth = 4; ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + (on ? 12 : -12), cy - 16);
    ctx.stroke();
    ctx.fillStyle = col;
    ctx.beginPath(); ctx.arc(cx + (on ? 12 : -12), cy - 16, 4.5, 0, 7); ctx.fill();
  }
}

function drawGates() {
  for (const g of L.gates) {
    const hpx = (1 - g.open) * g.h * T;
    if (hpx < 2) continue;
    const px = g.x * T, py = g.y * T;
    const col = CH_COLORS[g.ch] || "#fff";
    ctx.fillStyle = "#242938";
    ctx.fillRect(px + 4, py, T - 8, hpx);
    ctx.fillStyle = col;
    for (let yy = 6; yy < hpx - 4; yy += 14) ctx.fillRect(px + 8, py + yy, T - 16, 4);
    ctx.fillStyle = "rgba(255,255,255,0.25)";
    ctx.fillRect(px + 4, py + hpx - 4, T - 8, 4);
  }
}

function drawLifts() {
  for (const f of L.lifts) {
    const col = CH_COLORS[f.ch] || "#fff";
    ctx.fillStyle = "#3a4157";
    ctx.fillRect(f.px, f.py, f.w, 14);
    ctx.fillStyle = col;
    ctx.fillRect(f.px, f.py, f.w, 4);
    ctx.fillStyle = "rgba(0,0,0,0.25)";
    ctx.fillRect(f.px, f.py + 10, f.w, 4);
  }
}

function drawHero(h) {
  if (h.dead && h.deadT > 0.35) return;
  const fire = h.kind === "f";
  const x = h.rx, y = h.ry;
  const dim = (!isMultiplayer || !partnerHere) && soloControlBoth && h.kind !== activeChar;
  ctx.save();
  ctx.globalAlpha = h.dead ? Math.max(0, 1 - h.deadT * 3) : dim ? 0.62 : 1;

  // body
  const grad = ctx.createLinearGradient(x, y, x, y + CHAR_H);
  if (fire) { grad.addColorStop(0, "#ffb35c"); grad.addColorStop(1, "#ff5a2a"); }
  else { grad.addColorStop(0, "#8fd0ff"); grad.addColorStop(1, "#2f7fe0"); }
  ctx.fillStyle = grad;
  ctx.beginPath();
  const r = 8;
  ctx.moveTo(x + r, y + 6);
  ctx.arcTo(x + CHAR_W, y + 6, x + CHAR_W, y + CHAR_H, r);
  ctx.arcTo(x + CHAR_W, y + CHAR_H, x, y + CHAR_H, 6);
  ctx.arcTo(x, y + CHAR_H, x, y + 6, 6);
  ctx.arcTo(x, y + 6, x + CHAR_W, y + 6, r);
  ctx.closePath(); ctx.fill();

  // hair: flame / droplet
  const cx = x + CHAR_W / 2;
  if (fire) {
    const fl = Math.sin(time * 12 + x) * 2;
    ctx.fillStyle = "#ffdf5c";
    ctx.beginPath();
    ctx.moveTo(cx - 8, y + 8);
    ctx.quadraticCurveTo(cx - 6, y - 4 + fl, cx - 1, y + 2);
    ctx.quadraticCurveTo(cx + 1, y - 8 - fl, cx + 5, y + 3);
    ctx.quadraticCurveTo(cx + 9, y - 2 + fl, cx + 8, y + 8);
    ctx.closePath(); ctx.fill();
  } else {
    ctx.fillStyle = "#bfe4ff";
    ctx.beginPath();
    ctx.moveTo(cx, y - 7);
    ctx.quadraticCurveTo(cx + 8, y + 4, cx, y + 9);
    ctx.quadraticCurveTo(cx - 8, y + 4, cx, y - 7);
    ctx.closePath(); ctx.fill();
  }

  // eyes
  const ey = y + 13, eo = h.face * 2;
  ctx.fillStyle = "#fff";
  ctx.beginPath(); ctx.arc(cx - 4 + eo, ey, 3.4, 0, 7); ctx.arc(cx + 4 + eo, ey, 3.4, 0, 7); ctx.fill();
  ctx.fillStyle = "#1a1e2a";
  ctx.beginPath(); ctx.arc(cx - 4 + eo + h.face, ey, 1.6, 0, 7); ctx.arc(cx + 4 + eo + h.face, ey, 1.6, 0, 7); ctx.fill();

  ctx.restore();

  // active marker in solo
  if (dim === false && (!isMultiplayer || !partnerHere) && soloControlBoth && h.kind === activeChar && !h.dead) {
    ctx.fillStyle = "rgba(255,255,255,0.8)";
    ctx.beginPath();
    ctx.moveTo(cx, y - 14); ctx.lineTo(cx - 5, y - 21); ctx.lineTo(cx + 5, y - 21);
    ctx.closePath(); ctx.fill();
  }
}

function drawParticles() {
  for (const p of particles) {
    ctx.globalAlpha = 1 - p.life / p.max;
    ctx.fillStyle = p.col;
    ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 7); ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function drawHUD() {
  ctx.fillStyle = "rgba(10,12,20,0.55)";
  ctx.fillRect(0, 0, WW, 26);
  ctx.fillStyle = "#e8ecf5";
  ctx.font = "600 13px sans-serif";
  ctx.textAlign = "left";
  ctx.fillText(`MAP ${level + 1}/${TOTAL_LEVELS} · ${L.name}`, 10, 17);
  ctx.textAlign = "right";
  ctx.fillText(`💎 ${gemsGot}   ☠ ${deaths}`, WW - 10, 17);

  if (introT > 0) {
    ctx.globalAlpha = Math.min(1, introT / 0.4);
    ctx.fillStyle = "rgba(8,10,16,0.6)";
    ctx.fillRect(0, WH / 2 - 44, WW, 88);
    ctx.fillStyle = "#fff";
    ctx.font = "700 30px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(`MAP ${level + 1} — ${L.name}`, WW / 2, WH / 2 + 10);
    ctx.globalAlpha = 1;
  }
}

// ── Input ─────────────────────────────────────────────────
function bindHold(el, key) {
  const down = e => { e.preventDefault(); input[key] = true; el.classList.add("held"); };
  const up = e => { e.preventDefault(); input[key] = false; el.classList.remove("held"); };
  el.addEventListener("pointerdown", down);
  el.addEventListener("pointerup", up);
  el.addEventListener("pointercancel", up);
  el.addEventListener("pointerleave", up);
}
bindHold(btnLeft, "left");
bindHold(btnRight, "right");
bindHold(btnJump, "jump");

btnSwap.addEventListener("pointerdown", e => { e.preventDefault(); swapHero(); });

function swapHero() {
  if (isMultiplayer && partnerHere) return;
  activeChar = activeChar === "f" ? "w" : "f";
}

window.addEventListener("keydown", e => {
  if (e.repeat) return;
  if (e.key === "ArrowLeft" || e.key === "a") input.left = true;
  if (e.key === "ArrowRight" || e.key === "d") input.right = true;
  if (e.key === "ArrowUp" || e.key === "w" || e.key === " ") input.jump = true;
  if (e.key === "Tab" || e.key === "s") { e.preventDefault(); swapHero(); }
});
window.addEventListener("keyup", e => {
  if (e.key === "ArrowLeft" || e.key === "a") input.left = false;
  if (e.key === "ArrowRight" || e.key === "d") input.right = false;
  if (e.key === "ArrowUp" || e.key === "w" || e.key === " ") input.jump = false;
});

// ── Multiplayer ───────────────────────────────────────────
function sendRT(type, data) {
  try { if (window.Usion && Usion.game) Usion.game.realtime(type, data); } catch (_) {}
}

function hostCheckpoint(lvl) {
  // Server-side recovery snapshot — host only (platform rule).
  if (!isMultiplayer || players[0] !== myId) return;
  try {
    Usion.game.setState({ lvl, deaths, gems: gemsGot, ts: Date.now() });
  } catch (_) {}
}

function sendWorld() {
  if (!isMultiplayer || players[0] !== myId) return;
  sendRT("world", {
    lvl: level, deaths, gems: gemsGot,
    taken: L.gems.map((g, i) => g.taken ? i : -1).filter(i => i >= 0),
    levers: L.leverOn,
  });
  hostCheckpoint(level);
}

function applyWorld(d) {
  if (typeof d.lvl !== "number") return;
  deaths = d.deaths || 0;
  gemsGot = d.gems || 0;
  if (d.lvl >= TOTAL_LEVELS) { showVictory(); return; }
  loadLevel(d.lvl, { silent: false });
  if (Array.isArray(d.taken)) for (const i of d.taken) if (L.gems[i]) L.gems[i].taken = true;
  if (d.levers) L.leverOn = Object.assign({}, d.levers);
}

function handleRealtime(m) {
  const t = m.action_type, d = m.action_data || {};
  if (m.player_id === myId) return;
  switch (t) {
    case "pos":
      if (d.c !== remoteChar) return;
      remote.x = d.x; remote.y = d.y; remote.vx = d.vx; remote.vy = d.vy;
      remote.face = d.f || 1; remote.g = d.g; remote.d = d.d; remote.dead = d.dead;
      remote.lvl = d.lvl;
      // guest fell behind a level change (dropped advance packet) → catch up
      if (players[0] !== myId && typeof d.lvl === "number" && d.lvl > level && d.lvl < TOTAL_LEVELS) {
        loadLevel(d.lvl);
      }
      if (!partnerHere) { partnerHere = true; hideWaiting(); }
      break;
    case "lever":
      if (d.lvl === level) L.leverOn[d.ch] = !!d.on;
      break;
    case "gem":
      if (d.lvl === level && L.gems[d.i] && !L.gems[d.i].taken) { L.gems[d.i].taken = true; gemsGot++; }
      break;
    case "death":
      if (d.lvl === level && !resetPending) {
        deaths = Math.max(deaths, d.n || deaths + 1);
        resetPending = true;
        resetT = 0.9;
        const rk = chars[remoteChar]; rk.dead = true; rk.deadT = 0;
      }
      break;
    case "advance":
      if (typeof d.to === "number" && d.to > level) {
        deaths = d.deaths != null ? d.deaths : deaths;
        gemsGot = d.gems != null ? d.gems : gemsGot;
        applyAdvance(d.to);
      }
      break;
    case "world":
      applyWorld(d);
      partnerHere = true;
      hideWaiting();
      running = true;
      break;
    case "hello":
      sendWorld();
      break;
    case "restart":
      if (Date.now() - lastRestartAt > 1500) restartAll(false);
      break;
  }
}

let posTimer = 0;
setInterval(() => {
  if (!isMultiplayer || !running || ended || netPaused) return;
  const h = chars && chars[myChar];
  if (!h) return;
  sendRT("pos", {
    c: myChar,
    x: Math.round(h.x * 10) / 10, y: Math.round(h.y * 10) / 10,
    vx: Math.round(h.vx), vy: Math.round(h.vy),
    f: h.face, g: h.grounded ? 1 : 0, d: h.atDoor, dead: h.dead ? 1 : 0,
    lvl: level,
  });
}, 50);

// ── Overlays ──────────────────────────────────────────────
function showWaiting() { waitingOverlay.hidden = false; }
function hideWaiting() { waitingOverlay.hidden = true; }

soloBtn.addEventListener("click", () => {
  hideWaiting();
  isMultiplayer = false;     // partner can still join → onPlayerJoined flips us back
  soloControlBoth = true;
  btnSwap.hidden = false;
  startGame();
});

againBtn.addEventListener("click", () => restartAll(true));

// ── Boot ──────────────────────────────────────────────────
function startGame() {
  if (!chars || !L) loadLevel(startLevelParam());
  running = true;
  startedAt = startedAt || Date.now();
  resize();
}

function startLevelParam() {
  try {
    const m = location.search.match(/[?&]lvl=(\d+)/);
    if (m) return clamp(parseInt(m[1], 10) - 1, 0, TOTAL_LEVELS - 1);
  } catch (_) {}
  return 0;
}

function launchedSolo(config) {
  try {
    let lp = {};
    if (window.Usion && typeof Usion.getLaunchParams === "function") lp = Usion.getLaunchParams() || {};
    if (lp.mode === "single") return true;
    if (lp.mode === "multiplayer") return false;
    if (window.Usion && Usion.game && typeof Usion.game.isMultiplayer === "function")
      return !Usion.game.isMultiplayer();
    const rid = config && config.roomId ? String(config.roomId) : "";
    return !rid || /^standalone[_-]/i.test(rid);
  } catch (_) { return false; }
}

function registerGameHandlers() {
  Usion.game.onRealtime(handleRealtime);

  Usion.game.onPlayerJoined(d => {
    if (d && d.player_ids && d.player_ids.length) {
      for (const id of d.player_ids) if (!players.includes(id)) players.push(id);
    } else if (d && d.player_id && !players.includes(d.player_id)) players.push(d.player_id);
    if (d && d.player_id === myId) return;
    // a partner (re)joined: I keep my seat, they take the other hero
    isMultiplayer = true;
    partnerHere = true;
    soloControlBoth = false;
    btnSwap.hidden = true;
    myChar = players[0] === myId ? "f" : "w";
    remoteChar = myChar === "f" ? "w" : "f";
    activeChar = myChar;
    hideWaiting();
    if (players[0] === myId) {
      resetLevel();          // fair restart of the current map for both
      sendWorld();
      showToast("Partner joined! You are Fireboy 🔥");
    }
    running = true;
  });

  Usion.game.onPlayerLeft(d => {
    if (!isMultiplayer) return;
    partnerHere = false;
    soloControlBoth = true;
    btnSwap.hidden = false;
    activeChar = myChar;
    showToast("Partner left — you control both heroes (⇄)");
  });

  Usion.game.onJoined(() => {
    if (players[0] !== myId) sendRT("hello", {});
  });

  Usion.game.onSync(d => {
    // Reconnect recovery: the host checkpoint carries the level/progress.
    if (d && d.game_state && typeof d.game_state.lvl === "number" && players[0] !== myId) {
      const gs = d.game_state;
      if (gs.lvl !== level || !running) applyWorld({ lvl: gs.lvl, deaths: gs.deaths, gems: gs.gems });
    }
    netPaused = false;
    pauseOverlay.hidden = true;
  });

  Usion.game.onDisconnect(() => {
    if (!isMultiplayer || !partnerHere) return;
    netPaused = true;
    pauseText.textContent = "Reconnecting…";
    pauseOverlay.hidden = false;
  });

  Usion.game.onReconnect(() => {
    try { Usion.game.requestSync(); } catch (_) {}
  });

  Usion.game.onReconnected(() => {
    netPaused = false;
    pauseOverlay.hidden = true;
    if (players[0] === myId) sendWorld(); else sendRT("hello", {});
  });

  Usion.game.onRoomAssigned(() => {
    // Solo play promoted to a hosted room via the Share button.
    isMultiplayer = true;
    myChar = "f"; remoteChar = "w";
    activeChar = "f";
    showToast("Room created — waiting for your partner…");
  });

  Usion.game.onGameRestarted(() => restartAll(false));
}

async function setupMultiplayer(roomId) {
  await Usion.game.connect();
  await Usion.game.join(roomId);
  isMultiplayer = true;
  myChar = players[0] === myId ? "f" : "w";
  remoteChar = myChar === "f" ? "w" : "f";
  activeChar = myChar;
  soloControlBoth = false;
  btnSwap.hidden = true;
  loadLevel(startLevelParam());
  if (players.length >= 2 || players[0] !== myId) {
    // roster already known or I'm the guest — ask for state, play as soon as it lands
    if (players[0] !== myId) { sendRT("hello", {}); showWaiting(); }
    else { showWaiting(); running = true; }
  } else {
    showWaiting();
    running = true;         // host plays while waiting; partner join resets the map
  }
}

let initFired = false, bootedStandalone = false;
Usion.init(async function (config) {
  initFired = true;
  if (bootedStandalone) return;
  myId = config.userId;
  playerNames[myId] = config.userName || "You";
  if (config.playerIds && config.playerIds.length) players = config.playerIds.slice();
  registerGameHandlers();
  resize();
  loadLevel(startLevelParam());

  if (!launchedSolo(config) && config.roomId) {
    await setupMultiplayer(config.roomId);
  } else {
    // Explore / GameTok solo: zero-tap start, you drive both heroes.
    soloControlBoth = true;
    btnSwap.hidden = false;
    // still connect so a Share-button promotion can find us
    try { await Usion.game.connect(); if (config.roomId) await Usion.game.join(config.roomId); } catch (_) {}
    startGame();
  }
});

// Standalone fallback (opened directly / local preview) — top-level only.
setTimeout(() => {
  if (initFired || bootedStandalone) return;
  let embedded = true;
  try { embedded = window.self !== window.top; } catch (_) { embedded = true; }
  if (embedded) return;
  bootedStandalone = true;
  myId = "local-" + Math.random().toString(36).slice(2, 8);
  soloControlBoth = true;
  btnSwap.hidden = false;
  resize();
  loadLevel(startLevelParam());
  startGame();
}, 1200);

resize();
requestAnimationFrame(frame);

// ── Debug hooks (local testing only) ──────────────────────
window.FW = {
  load: n => { loadLevel(clamp(n - 1, 0, TOTAL_LEVELS - 1)); running = true; },
  tp: (k, tx, ty) => { const h = chars[k]; h.x = tx * T + 6; h.y = ty * T + T - CHAR_H; h.vx = 0; h.vy = 0; },
  state: () => ({ level: level + 1, deaths, gemsGot, active: activeChar, f: { x: chars.f.x, y: chars.f.y, dead: chars.f.dead, atDoor: chars.f.atDoor }, w: { x: chars.w.x, y: chars.w.y, dead: chars.w.dead, atDoor: chars.w.atDoor } }),
  input,
  swap: swapHero,
  step: n => { for (let i = 0; i < (n || 1); i++) simStep(); draw(); },
  flags: () => ({ running, paused, ended, netPaused, resetPending, acc, frames: window.__frames || 0, grounded: chars && chars.f.grounded, vy: chars && chars.f.vy, coyote: chars && chars.f.coyote }),
  chans: () => ({ levers: L.leverOn, plates: L.plates.map(p => [p.ch, p.pressed]), gates: L.gates.map(g => g.open), lifts: L.lifts.map(f => [f.px, f.py]) }),
};
