// Canvas renderer for «Дөл ба Дусал». Draws the shared `world` (tiles, doors,
// gates, lifts, plates, levers, liquids, gems, both heroes) plus a HUD, with
// landscape rotation + letterbox scaling. Pure view: it reads world state and a
// small status object; it never mutates gameplay.
//
// Art direction: an old underground steppe temple at night — indigo stone with
// worn gold meander ("алхан хээ") trim, painted orange ger-style doors, coral
// (шүр) gems for Дөл and turquoise (оюу) for Дусал, lava / water / violet
// poison. Every shape is drawn in code; optional artist images in
// client/assets/ (see art/PROMPTS.md) replace the backdrop, stone and heroes
// automatically when present.

import { T, COLS, ROWS, WW, WH, CHAR_W, CHAR_H, TOTAL_LEVELS } from '../shared/protocol.js';
import { MAPS } from '../shared/maps.js';
import { nameOf, t } from './i18n.js';

const CH_COLORS = { 1: '#ffcf4a', 2: '#c08cff', 3: '#4fe3d2', 4: '#ff7eb6', 5: '#9be15d', 6: '#ff9b4a', 7: '#7fb2ff', 8: '#f2f2f2' };
const hash2 = (x, y) => { let h = (x * 374761393 + y * 668265263) | 0; h = (h ^ (h >> 13)) * 1274126177; return ((h ^ (h >> 16)) >>> 0) / 4294967296; };
const fmtTime = (s) => { s = Math.floor(s); if (!isFinite(s) || s < 0) s = 0; const m = Math.floor(s / 60); return m + ':' + (s % 60 < 10 ? '0' : '') + (s % 60); };
const lerp = (a, b, f) => a + (b - a) * f;
const MAX_PARTICLES = 320;

// ---- optional artist images (client/assets) -------------------------------
const IMG = {};
function loadImg(key, src) {
  const im = new Image();
  im.decoding = 'async';
  im.onload = () => { IMG[key] = im; if (loadImg.onChange) loadImg.onChange(key); };
  im.onerror = () => {};
  im.src = src;
}

export class Renderer {
  constructor(rot, canvas) {
    this.rot = rot;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.time = 0;
    this.particles = [];
    this.anim = { f: this._blankAnim(), w: this._blankAnim() };
    this.shakeT = 0; this.shakeA = 0; this.flash = 0; this.flashCol = '#fff';
    this.dpr = 1; this.scale = 1; this.ox = 0; this.oy = 0; this.cw = 0; this.chh = 0;
    this.resize();
    window.addEventListener('resize', () => setTimeout(() => this.resize(), 50));
    loadImg.onChange = () => { this._staticKey = null; };
    for (const [k, f] of [['bg', 'bg-cave'], ['stone', 'tile-stone'], ['heroF', 'hero-dul'], ['heroW', 'hero-dusal']]) {
      loadImg(k, `assets/${f}.webp`);
    }
  }

  _blankAnim() { return { sq: 0, sqV: 0, lastG: true, lastVy: 0, run: 0, blink: 2 + Math.random() * 2, lean: 0, px: null, emit: 0 }; }

  resize() {
    // Always LANDSCAPE. When the viewport is portrait (GameTok feed / portrait-
    // locked webview) rotate the whole stage 90° so the game fills the screen
    // sideways; the player holds the phone landscape. Controls live inside #rot,
    // so they rotate with the game and stay a coherent gamepad at its bottom.
    const portrait = window.innerHeight > window.innerWidth * 1.05;
    this.rot.classList.toggle('rotated', portrait);
    const w = this.rot.clientWidth, h = this.rot.clientHeight;
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.cw = w; this.chh = h;
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    // The canvas bleeds edge to edge (under the notch / home indicator); the
    // world and HUD fit inside the safe area. Insets are #rot's own edges, so
    // they are already mapped through the rotation (see --c-* in style.css).
    const s = this.safe = this._safeInsets();
    const padH = Math.min(h * 0.2, 88);
    const aw = w - s.left - s.right, ah = h - s.top - padH;
    this.scale = Math.min(aw / WW, ah / WH);
    this.ox = s.left + (aw - WW * this.scale) / 2;
    this.oy = s.top + Math.max(0, (ah - WH * this.scale) / 2);
    this._staticKey = null;           // rebuild the static layer at the new resolution
  }

  // Custom properties holding env() don't resolve through getPropertyValue, so
  // measure them as padding on a probe inside #rot (which remaps them).
  _safeInsets() {
    const p = document.createElement('div');
    p.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none;padding:var(--c-top) var(--c-right) var(--c-bottom) var(--c-left)';
    this.rot.appendChild(p);
    const c = getComputedStyle(p);
    const r = { top: parseFloat(c.paddingTop) || 0, right: parseFloat(c.paddingRight) || 0, bottom: parseFloat(c.paddingBottom) || 0, left: parseFloat(c.paddingLeft) || 0 };
    p.remove();
    return r;
  }

  // ---- particles / juice (fed by fx.js) -------------------------------------
  _p(o) { if (this.particles.length < MAX_PARTICLES) this.particles.push(o); }

  burst(kind, x, y, n = 12) {
    const R = Math.random;
    for (let i = 0; i < n; i++) {
      const a = R() * Math.PI * 2, s = 50 + R() * 170;
      if (kind === 'coral' || kind === 'turq') {
        this._p({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 40, g: 260, life: 0, max: 0.45 + R() * 0.35, r: 1.5 + R() * 2.5,
          col: kind === 'coral' ? (R() < 0.5 ? '#ff7a59' : '#ffd0a8') : (R() < 0.5 ? '#3fe0cf' : '#c9fff8'), glow: true, star: R() < 0.35 });
      } else if (kind === 'steam') {
        this._p({ x: x + (R() - 0.5) * 16, y: y + (R() - 0.5) * 10, vx: (R() - 0.5) * 60, vy: -40 - R() * 90, g: -30, life: 0, max: 0.8 + R() * 0.6, r: 5 + R() * 7, grow: 14, col: 'rgba(220,230,240,0.55)' });
      } else if (kind === 'sizzle') {
        this._p({ x, y, vx: Math.cos(a) * s * 0.8, vy: Math.sin(a) * s * 0.8 - 80, g: 420, life: 0, max: 0.4 + R() * 0.4, r: 2 + R() * 2.5, col: R() < 0.5 ? '#7fd8ff' : '#e6fbff', glow: true });
      } else if (kind === 'goo') {
        this._p({ x, y, vx: Math.cos(a) * s * 0.6, vy: -60 - R() * 140, g: 520, life: 0, max: 0.5 + R() * 0.4, r: 2.5 + R() * 3, col: R() < 0.5 ? '#b65cff' : '#7cff9a' });
      } else if (kind === 'dust') {
        this._p({ x: x + (R() - 0.5) * 14, y, vx: (R() - 0.5) * 70, vy: -10 - R() * 30, g: 40, life: 0, max: 0.3 + R() * 0.2, r: 2 + R() * 2, grow: 6, col: 'rgba(190,180,220,0.35)' });
      } else if (kind === 'confetti') {
        const cols = ['#ff7a59', '#ffcf4a', '#3fe0cf', '#7fb2ff', '#ff7eb6', '#ffffff'];
        this._p({ x: R() * WW, y: -10 - R() * 60, vx: (R() - 0.5) * 80, vy: 60 + R() * 120, g: 60, life: 0, max: 2.4 + R(), r: 3 + R() * 3, col: cols[(R() * cols.length) | 0], spin: R() * 6, rect: true });
      } else if (kind === 'spark') {
        this._p({ x, y, vx: Math.cos(a) * s * 0.5, vy: Math.sin(a) * s * 0.5, g: 0, life: 0, max: 0.3 + R() * 0.3, r: 1.5 + R() * 1.5, col: '#fff1b0', glow: true });
      }
    }
  }
  shake(a = 6, d = 0.35) { this.shakeA = Math.max(this.shakeA, a); this.shakeT = Math.max(this.shakeT, d); }
  flashScreen(col = '#fff', a = 0.35) { this.flashCol = col; this.flash = Math.max(this.flash, a); }
  squash(key, amount) { const a = this.anim[key]; if (a) a.sqV += amount; }

  // world: shared world; status: { myKey, remoteKey, myRenderPos, deaths, mapTime,
  //   best, partnerHere, intro, solo }
  draw(world, dt, status) {
    this.time += dt;
    this._stepParticles(dt);
    this._ambient(world, dt);

    const { ctx, dpr, scale, ox, oy, cw, chh } = this;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#07061a'; ctx.fillRect(0, 0, cw, chh);

    // screen shake (world only, HUD stays put)
    let sx = 0, sy = 0;
    if (this.shakeT > 0) {
      this.shakeT -= dt;
      const k = Math.max(0, this.shakeT) * this.shakeA * 3;
      sx = (Math.random() - 0.5) * k; sy = (Math.random() - 0.5) * k;
      if (this.shakeT <= 0) this.shakeA = 0;
    }

    const key = world.level + ':' + this.scale + ':' + this.dpr;
    if (this._staticKey !== key) this._buildStatic(world, key);

    ctx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * (ox + sx), dpr * (oy + sy));
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, WW, WH); ctx.clip();
    ctx.drawImage(this._static, 0, 0, WW, WH);

    this._liquidGlow(world);
    this._doors(world);
    this._gates(world);
    this._lifts(world);
    this._plates(world);
    this._levers(world);
    this._liquids(world);
    this._gems(world);
    // partner first, then own hero on top
    const rk = status.remoteKey, mk = status.myKey;
    this._hero(world, rk, null, !status.partnerHere && !status.solo, dt, false);
    this._hero(world, mk, status.myRenderPos, false, dt, status.solo);
    this._particles();
    if (this.flash > 0) {
      ctx.globalAlpha = Math.min(1, this.flash); ctx.fillStyle = this.flashCol; ctx.fillRect(0, 0, WW, WH); ctx.globalAlpha = 1;
      this.flash = Math.max(0, this.flash - dt * 1.8);
    }
    // soft vignette
    if (!this._vig) {
      const v = document.createElement('canvas'); v.width = 288; v.height = 160;
      const vc = v.getContext('2d'); const g = vc.createRadialGradient(144, 80, 50, 144, 80, 170);
      g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(3,2,14,0.55)');
      vc.fillStyle = g; vc.fillRect(0, 0, 288, 160); this._vig = v;
    }
    ctx.drawImage(this._vig, 0, 0, WW, WH);
    ctx.restore();
    ctx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * ox, dpr * oy);
    this._hud(world, status);
  }

  // ---- static layer --------------------------------------------------------
  // Backdrop + stone + beams are identical every frame for a level: render them
  // once into an offscreen canvas at the on-screen resolution and blit it.
  _buildStatic(world, key) {
    const res = Math.max(1, Math.min(2.5, this.scale * this.dpr));
    if (!this._static) this._static = document.createElement('canvas');
    this._static.width = Math.round(WW * res); this._static.height = Math.round(WH * res);
    const ctx = this._static.getContext('2d');
    ctx.setTransform(res, 0, 0, res, 0, 0);
    ctx.clearRect(0, 0, WW, WH);
    const solid = (x, y) => x < 0 || x >= COLS || y < 0 || y >= ROWS || world.grid[y][x] === '#';

    this._backdrop(ctx, world);

    // ambient occlusion under ledges and beside walls (onto the backdrop)
    for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) {
      if (solid(x, y)) continue;
      if (solid(x, y - 1)) { const g = ctx.createLinearGradient(0, y * T, 0, y * T + 18); g.addColorStop(0, 'rgba(2,1,12,0.55)'); g.addColorStop(1, 'rgba(2,1,12,0)'); ctx.fillStyle = g; ctx.fillRect(x * T, y * T, T, 18); }
      if (solid(x - 1, y)) { const g = ctx.createLinearGradient(x * T, 0, x * T + 10, 0); g.addColorStop(0, 'rgba(2,1,12,0.35)'); g.addColorStop(1, 'rgba(2,1,12,0)'); ctx.fillStyle = g; ctx.fillRect(x * T, y * T, 10, T); }
      if (solid(x + 1, y)) { const g = ctx.createLinearGradient(x * T + T, 0, x * T + T - 10, 0); g.addColorStop(0, 'rgba(2,1,12,0.35)'); g.addColorStop(1, 'rgba(2,1,12,0)'); ctx.fillStyle = g; ctx.fillRect(x * T + T - 10, y * T, 10, T); }
    }

    const stonePat = IMG.stone ? ctx.createPattern(IMG.stone, 'repeat') : null;
    // the artist texture holds 4 block rows per 256 px: scale it so a block ≈ a tile
    if (stonePat && stonePat.setTransform && window.DOMMatrix) stonePat.setTransform(new DOMMatrix().scale(0.5));
    for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) {
      const c = world.grid[y][x];
      if (c === '#') this._stone(ctx, x, y, solid, stonePat);
      else if (c === '=') this._beam(ctx, world, x, y);
    }
    this._hints(ctx, world);
    this._staticKey = key;
  }

  _backdrop(ctx, world) {
    if (IMG.bg) {
      const im = IMG.bg, s = Math.max(WW / im.width, WH / im.height);
      // soften the painted backdrop so the playfield in front reads first
      try { ctx.filter = 'blur(1.2px) saturate(0.85)'; } catch { /* Safari: no canvas filters */ }
      ctx.drawImage(im, (WW - im.width * s) / 2, (WH - im.height * s) / 2, im.width * s, im.height * s);
      try { ctx.filter = 'none'; } catch { /* ignore */ }
      ctx.fillStyle = 'rgba(10,8,30,0.42)'; ctx.fillRect(0, 0, WW, WH);
      return;
    }
    const lv = world.level;
    const g = ctx.createLinearGradient(0, 0, 0, WH);
    g.addColorStop(0, '#1d1a45'); g.addColorStop(0.55, '#15133a'); g.addColorStop(1, '#0c0a24');
    ctx.fillStyle = g; ctx.fillRect(0, 0, WW, WH);
    // warm (fire) and cool (water) light washes
    const warm = ctx.createRadialGradient(80, WH * 0.75, 20, 80, WH * 0.75, 520);
    warm.addColorStop(0, 'rgba(255,120,50,0.16)'); warm.addColorStop(1, 'rgba(255,120,50,0)');
    ctx.fillStyle = warm; ctx.fillRect(0, 0, WW, WH);
    const cool = ctx.createRadialGradient(WW - 80, WH * 0.3, 20, WW - 80, WH * 0.3, 560);
    cool.addColorStop(0, 'rgba(60,200,230,0.13)'); cool.addColorStop(1, 'rgba(60,200,230,0)');
    ctx.fillStyle = cool; ctx.fillRect(0, 0, WW, WH);

    // far colonnade of carved arches (two depths)
    for (const [depth, alpha, w, step, top] of [[0, 0.07, 70, 190, 120], [1, 0.11, 46, 150, 190]]) {
      ctx.fillStyle = `rgba(150,140,230,${alpha})`;
      const off = (hash2(lv, depth) * step) | 0;
      for (let x = -off; x < WW + step; x += step) {
        ctx.beginPath();
        ctx.moveTo(x - w, WH); ctx.lineTo(x - w, top); ctx.arc(x, top, w, Math.PI, 0); ctx.lineTo(x + w, WH);
        ctx.lineTo(x + w + 14, WH); ctx.lineTo(x + w + 14, top - 8); ctx.arc(x, top - 8, w + 14, 0, Math.PI, true); ctx.lineTo(x - w - 14, WH);
        ctx.closePath(); ctx.fill();
        // ulzii knot on the keystone
        this._ulzii(ctx, x, top - w - 2, 9, `rgba(232,190,100,${alpha * 1.4})`);
      }
    }
    // faint meander frieze high on the wall
    ctx.strokeStyle = 'rgba(230,185,95,0.08)'; ctx.lineWidth = 2;
    this._meanderRow(ctx, 0, 70, WW, 10);
    // turquoise crystals growing out of the far wall
    for (let i = 0; i < 9; i++) {
      const cx = hash2(i, lv + 3) * WW, cy = 120 + hash2(lv, i + 9) * (WH - 200), s = 6 + hash2(i, i + lv) * 10;
      const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, s * 4);
      glow.addColorStop(0, 'rgba(80,230,220,0.18)'); glow.addColorStop(1, 'rgba(80,230,220,0)');
      ctx.fillStyle = glow; ctx.fillRect(cx - s * 4, cy - s * 4, s * 8, s * 8);
      ctx.fillStyle = 'rgba(110,235,225,0.35)';
      for (let k = -1; k <= 1; k++) {
        ctx.beginPath(); ctx.moveTo(cx + k * s * 0.7, cy + s); ctx.lineTo(cx + k * s * 0.9 + k * 3, cy - s * (1.2 - Math.abs(k) * 0.4)); ctx.lineTo(cx + k * s * 0.7 + s * 0.45, cy + s); ctx.closePath(); ctx.fill();
      }
    }
  }

  _ulzii(ctx, x, y, r, col) {
    // endless knot: a rotated square lattice loop
    ctx.save(); ctx.translate(x, y); ctx.rotate(Math.PI / 4);
    ctx.strokeStyle = col; ctx.lineWidth = Math.max(1.2, r * 0.22);
    const s = r * 0.5;
    ctx.strokeRect(-r * 0.7, -r * 0.7, r * 1.4, r * 1.4);
    ctx.beginPath(); ctx.moveTo(-s, -r * 0.7); ctx.lineTo(-s, r * 0.7); ctx.moveTo(s, -r * 0.7); ctx.lineTo(s, r * 0.7);
    ctx.moveTo(-r * 0.7, -s); ctx.lineTo(r * 0.7, -s); ctx.moveTo(-r * 0.7, s); ctx.lineTo(r * 0.7, s); ctx.stroke();
    ctx.restore();
  }

  _meanderRow(ctx, x0, y, len, h) {
    // the Mongolian "hammer" key pattern: ┐└┐└ in one continuous line
    ctx.beginPath();
    for (let x = x0; x < x0 + len; x += h * 2) {
      ctx.moveTo(x, y + h); ctx.lineTo(x, y); ctx.lineTo(x + h * 1.5, y); ctx.lineTo(x + h * 1.5, y + h * 0.65);
      ctx.lineTo(x + h * 0.6, y + h * 0.65); ctx.lineTo(x + h * 0.6, y + h * 0.35);
    }
    ctx.moveTo(x0, y + h + 3); ctx.lineTo(x0 + len, y + h + 3);
    ctx.stroke();
  }

  _stone(ctx, x, y, solid, pat) {
    const px = x * T, py = y * T;
    const up = solid(x, y - 1), dn = solid(x, y + 1), lf = solid(x - 1, y), rt = solid(x + 1, y);
    const inner = up && dn && lf && rt;
    const v = hash2(x, y);
    if (pat) {
      ctx.fillStyle = pat; ctx.fillRect(px, py, T, T);
      ctx.fillStyle = inner ? 'rgba(8,6,28,0.45)' : 'rgba(8,6,28,0.12)'; ctx.fillRect(px, py, T, T);
    } else {
      const l = inner ? 0.78 : 1;
      const r = (52 + v * 10) * l, g = (47 + v * 9) * l, b = (96 + v * 16) * l;
      ctx.fillStyle = `rgb(${r | 0},${g | 0},${b | 0})`; ctx.fillRect(px, py, T, T);
      // block seams: running-bond bricks, 2 per tile row, offset every other row
      ctx.fillStyle = 'rgba(10,8,34,0.55)';
      ctx.fillRect(px, py + T / 2 - 1, T, 2);
      const o = (y % 2) ? T / 2 : 0;
      ctx.fillRect(px + ((o + 0) % T), py, 2, T / 2);
      ctx.fillRect(px + ((o + T / 2) % T), py + T / 2, 2, T / 2);
      // chisel speckles
      ctx.fillStyle = 'rgba(200,190,255,0.06)';
      for (let i = 0; i < 3; i++) ctx.fillRect(px + hash2(x * 3 + i, y) * (T - 3), py + hash2(x, y * 3 + i) * (T - 3), 2, 1.5);
      // bevel
      if (!inner) {
        ctx.fillStyle = 'rgba(190,180,255,0.10)'; ctx.fillRect(px, py, T, 2); ctx.fillRect(px, py, 2, T);
        ctx.fillStyle = 'rgba(5,3,20,0.35)'; ctx.fillRect(px, py + T - 2, T, 2); ctx.fillRect(px + T - 2, py, 2, T);
      }
    }
    // exposed top surface: gold trim + meander band — this is what players stand on
    if (!up) {
      ctx.fillStyle = '#e2b25a'; ctx.fillRect(px, py, T, 3);
      ctx.fillStyle = 'rgba(255,230,160,0.55)'; ctx.fillRect(px, py, T, 1);
      ctx.fillStyle = '#6b4f2a'; ctx.fillRect(px, py + 3, T, 1);
      ctx.strokeStyle = 'rgba(226,178,90,0.55)'; ctx.lineWidth = 1.4;
      ctx.beginPath();
      for (let i = 0; i < 4; i++) {
        const bx = px + i * 8 + 1;
        ctx.moveTo(bx, py + 11); ctx.lineTo(bx, py + 6); ctx.lineTo(bx + 6, py + 6); ctx.lineTo(bx + 6, py + 9); ctx.lineTo(bx + 3, py + 9);
      }
      ctx.stroke();
    }
    if (!dn) { ctx.fillStyle = 'rgba(226,178,90,0.35)'; ctx.fillRect(px, py + T - 2, T, 2); }
    if (!lf) { ctx.fillStyle = 'rgba(226,178,90,0.22)'; ctx.fillRect(px, py, 2, T); }
    if (!rt) { ctx.fillStyle = 'rgba(226,178,90,0.22)'; ctx.fillRect(px + T - 2, py, 2, T); }
  }

  _beam(ctx, world, x, y) {
    // painted wooden beam (one-way): orange lacquer with blue-gold ornament
    const px = x * T, py = y * T;
    const L = x > 0 && world.grid[y][x - 1] === '=', R = x < COLS - 1 && world.grid[y][x + 1] === '=';
    ctx.fillStyle = 'rgba(2,1,12,0.35)'; ctx.fillRect(px, py + 9, T, 4);
    const g = ctx.createLinearGradient(0, py, 0, py + 9);
    g.addColorStop(0, '#f08a3c'); g.addColorStop(1, '#a8431c');
    ctx.fillStyle = g; ctx.fillRect(px, py, T, 9);
    ctx.fillStyle = 'rgba(255,220,170,0.6)'; ctx.fillRect(px, py, T, 1.5);
    ctx.fillStyle = '#2f6fa8'; ctx.fillRect(px, py + 4, T, 2);
    ctx.fillStyle = '#e2b25a';
    for (let i = 4; i < T; i += 8) ctx.fillRect(px + i, py + 4, 2, 2);
    if (!L) { ctx.fillStyle = '#6b2a12'; ctx.fillRect(px, py, 3, 9); ctx.fillStyle = '#5a3a20'; ctx.fillRect(px + 4, py + 9, 3, 7); }
    if (!R) { ctx.fillStyle = '#6b2a12'; ctx.fillRect(px + T - 3, py, 3, 9); ctx.fillStyle = '#5a3a20'; ctx.fillRect(px + T - 7, py + 9, 3, 7); }
  }

  _hints(ctx, world) {
    const M = MAPS[world.level];
    if (!M || !M.hints) return;
    ctx.save();
    ctx.font = '600 13px "Trebuchet MS", sans-serif'; ctx.textAlign = 'center';
    for (const h of M.hints) {
      const s = nameOf(h);
      ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.fillText(s, h.x * T + T / 2 + 1, h.y * T + T / 2 + 1);
      ctx.fillStyle = 'rgba(240,215,160,0.7)'; ctx.fillText(s, h.x * T + T / 2, h.y * T + T / 2);
    }
    ctx.restore();
  }

  // ---- ambient particles: embers off lava, bubbles in poison, drips --------
  _ambient(world, dt) {
    for (const q of world.liquids) {
      const rate = q.pw / T;
      if (Math.random() < dt * rate * (q.kind === 'F' ? 1.6 : q.kind === 'G' ? 1.1 : 0.5)) {
        const x = q.px + Math.random() * q.pw, y = q.y * T + T * 0.55;
        if (q.kind === 'F') this._p({ x, y, vx: (Math.random() - 0.5) * 20, vy: -30 - Math.random() * 50, g: -10, life: 0, max: 1 + Math.random(), r: 1.2 + Math.random() * 1.6, col: Math.random() < 0.5 ? '#ffb347' : '#ff6a2a', glow: true });
        else if (q.kind === 'G') this._p({ x, y: y + 6, vx: 0, vy: -12, g: 0, life: 0, max: 0.6 + Math.random() * 0.5, r: 2 + Math.random() * 3, col: 'rgba(200,140,255,0.6)', ring: true });
        else this._p({ x, y: y + 2, vx: 0, vy: -6, g: 0, life: 0, max: 0.5, r: 1.5, col: 'rgba(200,255,255,0.7)', glow: true });
      }
    }
  }

  _stepParticles(dt) {
    for (const p of this.particles) {
      p.life += dt; p.x += p.vx * dt; p.y += p.vy * dt; p.vy += (p.g || 0) * dt;
      if (p.grow) p.r += p.grow * dt;
      if (p.spin) p.spin += dt * 6;
    }
    this.particles = this.particles.filter((p) => p.life < p.max);
  }

  _particles() {
    const ctx = this.ctx;
    for (const p of this.particles) {
      const a = 1 - p.life / p.max;
      ctx.globalAlpha = Math.max(0, a);
      if (p.glow) ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = p.col; ctx.strokeStyle = p.col;
      if (p.rect) {
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.spin); ctx.fillRect(-p.r, -p.r * 0.5, p.r * 2, p.r); ctx.restore();
      } else if (p.ring) {
        ctx.lineWidth = 1.2; ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 7); ctx.stroke();
      } else if (p.star) {
        const r = p.r * 1.8;
        ctx.beginPath(); ctx.moveTo(p.x, p.y - r); ctx.lineTo(p.x + r * 0.3, p.y); ctx.lineTo(p.x, p.y + r); ctx.lineTo(p.x - r * 0.3, p.y); ctx.closePath(); ctx.fill();
        ctx.beginPath(); ctx.moveTo(p.x - r, p.y); ctx.lineTo(p.x, p.y + r * 0.3); ctx.lineTo(p.x + r, p.y); ctx.lineTo(p.x, p.y - r * 0.3); ctx.closePath(); ctx.fill();
      } else {
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 7); ctx.fill();
      }
      ctx.globalCompositeOperation = 'source-over';
    }
    ctx.globalAlpha = 1;
  }

  // ---- liquids ---------------------------------------------------------------
  _liquidGlow(world) {
    const ctx = this.ctx;
    ctx.globalCompositeOperation = 'lighter';
    for (const q of world.liquids) {
      if (q.kind !== 'F' && q.kind !== 'G') continue;
      const cx = q.px + q.pw / 2, cy = q.y * T + T * 0.6, r = Math.max(60, q.pw * 0.9);
      const fl = 0.85 + Math.sin(this.time * 3 + q.x) * 0.15;
      const g = ctx.createRadialGradient(cx, cy, 4, cx, cy, r);
      g.addColorStop(0, q.kind === 'F' ? `rgba(255,110,40,${0.22 * fl})` : `rgba(170,80,255,${0.14 * fl})`);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g; ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  _liquids(world) {
    const ctx = this.ctx, tm = this.time;
    for (const q of world.liquids) {
      const px = q.px, pw = q.pw, top = q.y * T + T * 0.5, bot = q.y * T + T;
      const pal = q.kind === 'F' ? ['#ffd25a', '#ff6a1f', '#b8280c'] : q.kind === 'W' ? ['#9cf3ff', '#2fb7e8', '#155aa8'] : ['#d79bff', '#8a3cd6', '#3d1470'];
      const amp = q.kind === 'W' ? 2.4 : q.kind === 'F' ? 1.8 : 1.4, sp = q.kind === 'W' ? 3.2 : 2.2;
      const N = Math.max(4, Math.round(pw / 6));
      const surf = (i) => top + 3 + Math.sin(tm * sp + (px + (pw / N) * i) * 0.09) * amp + Math.sin(tm * sp * 1.7 + i) * amp * 0.35;
      const g = ctx.createLinearGradient(0, top, 0, bot);
      g.addColorStop(0, pal[1]); g.addColorStop(1, pal[2]);
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.moveTo(px, surf(0));
      for (let i = 1; i <= N; i++) ctx.lineTo(px + (pw / N) * i, surf(i));
      ctx.lineTo(px + pw, bot); ctx.lineTo(px, bot); ctx.closePath(); ctx.fill();
      // bright surface line
      ctx.strokeStyle = pal[0]; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(px, surf(0));
      for (let i = 1; i <= N; i++) ctx.lineTo(px + (pw / N) * i, surf(i));
      ctx.stroke();
      // inner motion: lava cracks / water glints / poison blobs
      ctx.save(); ctx.beginPath(); ctx.rect(px, top, pw, T * 0.5); ctx.clip();
      if (q.kind === 'F') {
        ctx.strokeStyle = 'rgba(255,220,120,0.45)'; ctx.lineWidth = 1.2;
        for (let i = 0; i < pw / 18; i++) { const x = px + ((i * 18 + tm * 9) % pw); ctx.beginPath(); ctx.moveTo(x, top + 10); ctx.lineTo(x + 5, top + 13); ctx.lineTo(x + 2, bot - 2); ctx.stroke(); }
      } else if (q.kind === 'W') {
        ctx.fillStyle = 'rgba(230,255,255,0.35)';
        for (let i = 0; i < pw / 14; i++) { const x = px + ((i * 14 + tm * 18) % pw), y = top + 8 + ((i * 7) % 6); ctx.fillRect(x, y, 5, 1.2); }
      } else {
        ctx.fillStyle = 'rgba(150,255,170,0.35)';
        for (let i = 0; i < pw / 16; i++) { const x = px + ((i * 16 + 7) % pw), y = bot - ((tm * 10 + i * 5) % (T * 0.5)); ctx.beginPath(); ctx.arc(x, y, 1.8, 0, 7); ctx.fill(); }
      }
      ctx.restore();
    }
  }

  // ---- gems: coral for Дөл, turquoise for Дусал --------------------------
  _gems(world) {
    const ctx = this.ctx;
    for (const g of world.gems) {
      if (g.taken) continue;
      const fire = g.kind === 'r';
      const x = g.x * T + T / 2, y = g.y * T + T / 2 + Math.sin(this.time * 2.6 + g.x * 0.7) * 3;
      ctx.globalCompositeOperation = 'lighter';
      const gl = ctx.createRadialGradient(x, y, 1, x, y, 16);
      gl.addColorStop(0, fire ? 'rgba(255,110,80,0.5)' : 'rgba(60,230,210,0.5)'); gl.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = gl; ctx.fillRect(x - 16, y - 16, 32, 32);
      ctx.globalCompositeOperation = 'source-over';
      ctx.save(); ctx.translate(x, y);
      if (fire) {
        // faceted coral bead
        const r = 9;
        ctx.rotate(Math.sin(this.time * 1.8 + g.y) * 0.25);
        ctx.fillStyle = '#c92a2a';
        ctx.beginPath(); for (let i = 0; i < 6; i++) { const a = i / 6 * Math.PI * 2 - Math.PI / 2; ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r * 1.1); } ctx.closePath(); ctx.fill();
        ctx.fillStyle = '#ff6b5b';
        ctx.beginPath(); ctx.moveTo(0, -r * 1.1); ctx.lineTo(r * 0.87, -r * 0.55); ctx.lineTo(0, 0); ctx.lineTo(-r * 0.87, -r * 0.55); ctx.closePath(); ctx.fill();
        ctx.fillStyle = '#ff9c84';
        ctx.beginPath(); ctx.moveTo(-r * 0.87, -r * 0.55); ctx.lineTo(0, 0); ctx.lineTo(-r * 0.87, r * 0.55); ctx.closePath(); ctx.fill();
        ctx.strokeStyle = '#e2b25a'; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.arc(0, -r * 1.25, 2, 0, 7); ctx.stroke();
      } else {
        // turquoise cabochon with dark matrix veins in a silver rim
        const rx = 8, ry = 9.8;
        ctx.fillStyle = '#d9e3ea'; ctx.beginPath(); ctx.ellipse(0, 0, rx + 1.6, ry + 1.6, 0, 0, 7); ctx.fill();
        const tg = ctx.createRadialGradient(-2, -3, 1, 0, 0, ry);
        tg.addColorStop(0, '#9ffff0'); tg.addColorStop(0.6, '#22c7b5'); tg.addColorStop(1, '#0d8a82');
        ctx.fillStyle = tg; ctx.beginPath(); ctx.ellipse(0, 0, rx, ry, 0, 0, 7); ctx.fill();
        ctx.strokeStyle = 'rgba(40,40,30,0.45)'; ctx.lineWidth = 0.9;
        ctx.beginPath(); ctx.moveTo(-5, -2); ctx.lineTo(-1, 0); ctx.lineTo(2, -3); ctx.moveTo(-1, 0); ctx.lineTo(1, 4); ctx.lineTo(5, 3); ctx.stroke();
        ctx.fillStyle = 'rgba(255,255,255,0.8)'; ctx.beginPath(); ctx.ellipse(-2.5, -4, 2, 1.2, -0.5, 0, 7); ctx.fill();
      }
      ctx.restore();
    }
  }

  // ---- doors: painted ger doors ---------------------------------------------
  _doors(world) {
    const ctx = this.ctx;
    for (const k of ['f', 'w']) {
      const d = world.doors[k]; if (!d) continue;
      const fire = k === 'f', h = world.heroes[k];
      const at = !!(h && h.atDoor && !h.dead);
      const a = this._doorOpen = this._doorOpen || { f: 0, w: 0 };
      a[k] = lerp(a[k], at ? 1 : 0, 0.15);
      const px = d.x * T - 4, py = (d.y - 1) * T - 2, w = T + 8, hh = 2 * T + 2;
      const glow = fire ? '255,120,50' : '60,210,230';
      // light spilling from inside
      ctx.globalCompositeOperation = 'lighter';
      const sp = ctx.createRadialGradient(px + w / 2, py + hh * 0.55, 4, px + w / 2, py + hh * 0.55, 46 + a[k] * 30);
      sp.addColorStop(0, `rgba(${glow},${0.25 + a[k] * 0.4})`); sp.addColorStop(1, `rgba(${glow},0)`);
      ctx.fillStyle = sp; ctx.fillRect(px - 50, py - 40, w + 100, hh + 80);
      ctx.globalCompositeOperation = 'source-over';
      // frame + lintel
      ctx.fillStyle = '#4a2410'; ctx.fillRect(px - 3, py - 6, w + 6, hh + 6);
      ctx.fillStyle = '#e2b25a'; ctx.fillRect(px - 5, py - 9, w + 10, 5);
      // doorway glow behind the panels
      const ins = ctx.createLinearGradient(0, py, 0, py + hh);
      ins.addColorStop(0, fire ? '#ffd27a' : '#bffcff'); ins.addColorStop(1, fire ? '#ff6a2a' : '#2aa8d8');
      ctx.fillStyle = ins; ctx.fillRect(px, py, w, hh);
      // two painted panels swinging open (narrowing)
      const pw = (w / 2) * (1 - a[k] * 0.78);
      for (const side of [0, 1]) {
        const x = side ? px + w - pw : px;
        const pg = ctx.createLinearGradient(x, 0, x + pw, 0);
        pg.addColorStop(0, '#d9572a'); pg.addColorStop(1, '#b8401c');
        ctx.fillStyle = pg; ctx.fillRect(x, py, pw, hh);
        if (pw > 5) {
          ctx.strokeStyle = '#e2b25a'; ctx.lineWidth = 1.2;
          ctx.strokeRect(x + 2.5, py + 3, pw - 5, hh * 0.42); ctx.strokeRect(x + 2.5, py + hh * 0.5, pw - 5, hh * 0.45);
          ctx.fillStyle = '#2f6fa8'; ctx.fillRect(x + 4, py + hh * 0.22, pw - 8, 3);
        }
      }
      // emblem medallion on the lintel
      const ex = px + w / 2, ey = py - 13;
      ctx.fillStyle = '#4a2410'; ctx.beginPath(); ctx.arc(ex, ey, 9, 0, 7); ctx.fill();
      ctx.fillStyle = fire ? '#ff7a2a' : '#2fd0c4'; ctx.beginPath(); ctx.arc(ex, ey, 7, 0, 7); ctx.fill();
      ctx.fillStyle = '#fff6dc';
      if (fire) { ctx.beginPath(); ctx.moveTo(ex, ey - 5); ctx.quadraticCurveTo(ex + 5, ey + 1, ex, ey + 4); ctx.quadraticCurveTo(ex - 5, ey + 1, ex, ey - 5); ctx.fill(); }
      else { ctx.beginPath(); ctx.moveTo(ex, ey - 5); ctx.quadraticCurveTo(ex + 4.5, ey + 1, ex, ey + 4); ctx.quadraticCurveTo(ex - 4.5, ey + 1, ex, ey - 5); ctx.fill(); ctx.fillStyle = '#2fd0c4'; ctx.beginPath(); ctx.arc(ex - 1, ey + 1, 1.3, 0, 7); ctx.fill(); }
      // door step
      ctx.fillStyle = '#e2b25a'; ctx.fillRect(px - 4, py + hh - 1, w + 8, 3);
    }
  }

  _plates(world) {
    const ctx = this.ctx;
    for (const p of world.plates) {
      const px = p.x * T, py = p.y * T, col = CH_COLORS[p.ch] || '#fff';
      let pressed = false;
      for (const k of ['f', 'w']) { const h = world.heroes[k]; if (!h.dead && h.x < px + T - 4 && h.x + CHAR_W > px + 4 && h.y + CHAR_H > py + T - 12 && h.y + CHAR_H < py + T + 6) pressed = true; }
      const off = pressed ? 4 : 0;
      // stone socket with gold rim
      ctx.fillStyle = '#2a1d10'; ctx.fillRect(px - 1, py + T - 6, T + 2, 6);
      ctx.fillStyle = '#e2b25a'; ctx.fillRect(px - 1, py + T - 6, T + 2, 1.5);
      // bronze button cap, glowing jewel strip in the channel colour
      const capY = py + T - 13 + off, capH = 8 - off;
      const cg = ctx.createLinearGradient(0, capY, 0, capY + capH);
      cg.addColorStop(0, pressed ? '#b98a40' : '#f0c46a'); cg.addColorStop(1, pressed ? '#7a5422' : '#a8742c');
      ctx.fillStyle = cg;
      ctx.beginPath(); ctx.moveTo(px + 3, capY + capH); ctx.lineTo(px + 6, capY); ctx.lineTo(px + T - 6, capY); ctx.lineTo(px + T - 3, capY + capH); ctx.closePath(); ctx.fill();
      ctx.fillStyle = col;
      ctx.fillRect(px + 9, capY + 2, T - 18, 3);
      if (pressed) {
        ctx.globalCompositeOperation = 'lighter';
        const g = ctx.createRadialGradient(px + T / 2, py + T - 6, 1, px + T / 2, py + T - 6, 20);
        g.addColorStop(0, col + '88'); g.addColorStop(1, col + '00'); ctx.fillStyle = g; ctx.fillRect(px - 4, py + T - 26, T + 8, 30);
        ctx.globalCompositeOperation = 'source-over';
      }
    }
  }

  _levers(world) {
    const ctx = this.ctx;
    for (const v of world.levers) {
      const cx = v.x * T + T / 2, cy = v.y * T + T - 5, on = !!world.leverOn[v.ch], col = CH_COLORS[v.ch] || '#fff';
      const ang = (this._lev = this._lev || {});
      const id = v.x + ',' + v.y;
      ang[id] = lerp(ang[id] == null ? (on ? 0.6 : -0.6) : ang[id], on ? 0.6 : -0.6, 0.25);
      ctx.fillStyle = '#3a2a18'; ctx.beginPath(); ctx.moveTo(cx - 10, cy + 5); ctx.lineTo(cx - 7, cy - 3); ctx.lineTo(cx + 7, cy - 3); ctx.lineTo(cx + 10, cy + 5); ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#e2b25a'; ctx.fillRect(cx - 7, cy - 3, 14, 1.5);
      ctx.save(); ctx.translate(cx, cy - 2); ctx.rotate(ang[id]);
      ctx.strokeStyle = '#8a5a2b'; ctx.lineWidth = 3.5; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, -18); ctx.stroke();
      ctx.fillStyle = col; ctx.beginPath(); ctx.arc(0, -19, 4.5, 0, 7); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.6)'; ctx.beginPath(); ctx.arc(-1.4, -20.4, 1.4, 0, 7); ctx.fill();
      ctx.restore();
    }
  }

  _gates(world) {
    const ctx = this.ctx;
    for (const g of world.gates) {
      const hpx = (1 - g.open) * g.h * T; if (hpx < 2) continue;
      const px = g.x * T, py = g.y * T, col = CH_COLORS[g.ch] || '#fff';
      ctx.fillStyle = '#2a2550'; ctx.fillRect(px + 3, py, T - 6, hpx);
      ctx.fillStyle = 'rgba(190,180,255,0.12)'; ctx.fillRect(px + 3, py, 2, hpx);
      // carved bars + channel-colour inlays
      ctx.fillStyle = '#463e86';
      for (let yy = 4; yy < hpx - 4; yy += 12) ctx.fillRect(px + 6, py + yy, T - 12, 8);
      ctx.fillStyle = col;
      for (let yy = 7; yy < hpx - 4; yy += 12) ctx.fillRect(px + T / 2 - 3, py + yy, 6, 2);
      ctx.fillStyle = '#e2b25a'; ctx.fillRect(px + 2, py + hpx - 4, T - 4, 4);
      ctx.fillStyle = 'rgba(255,240,200,0.5)'; ctx.fillRect(px + 2, py + hpx - 4, T - 4, 1);
    }
  }

  _lifts(world) {
    const ctx = this.ctx;
    for (const f of world.lifts) {
      const col = CH_COLORS[f.ch] || '#fff';
      // dpx/dpy = the ~present draw position (game.frame advances a moving ferry to
      // match the predicted rider); falls back to px/py in solo / before first frame.
      const px = f.dpx != null ? f.dpx : f.px, py = f.dpy != null ? f.dpy : f.py;
      ctx.fillStyle = 'rgba(2,1,12,0.35)'; ctx.fillRect(px + 2, py + 14, f.w - 4, 4);
      ctx.fillStyle = '#3d3678'; ctx.fillRect(px, py, f.w, 14);
      ctx.fillStyle = '#e2b25a'; ctx.fillRect(px, py, f.w, 3);
      ctx.fillStyle = 'rgba(255,240,200,0.5)'; ctx.fillRect(px, py, f.w, 1);
      ctx.fillStyle = col; ctx.globalAlpha = 0.85;
      for (let x = 8; x < f.w - 6; x += 16) ctx.fillRect(px + x, py + 6, 6, 3);
      ctx.globalAlpha = 1;
      ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.fillRect(px, py + 11, f.w, 3);
    }
  }

  // ---- heroes --------------------------------------------------------------
  _hero(world, key, renderPos, dim, dt, marker) {
    const ctx = this.ctx;
    const h = world.heroes[key];
    const fire = key === 'f';
    const a = this.anim[key];
    const x = renderPos ? renderPos.x : h.x, y = renderPos ? renderPos.y : h.y;

    // animation state from motion (works for predicted, interpolated and solo heroes)
    const vxEst = a.px == null || dt <= 0 ? 0 : (x - a.px) / dt;
    a.px = x;
    const moving = Math.abs(vxEst) > 20 && h.grounded;
    a.run += dt * (moving ? 14 : 0);
    a.lean = lerp(a.lean, Math.max(-1, Math.min(1, vxEst / 170)) * (h.grounded ? 0.12 : 0.06), 0.2);
    // spring for squash & stretch
    const target = !h.grounded ? Math.max(-0.22, Math.min(0.18, -(h.vy || 0) / 2600)) : 0;
    a.sqV += (target - a.sq) * 0.35 - a.sqV * 0.22;
    a.sq += a.sqV * Math.min(2, dt * 60) * 0.5;
    a.sq = Math.max(-0.35, Math.min(0.35, a.sq));
    a.blink -= dt; if (a.blink < -0.12) a.blink = 2 + Math.random() * 3;

    if (h.dead) { a.sq = 0; a.sqV = 0; return; }   // fx.js already burst it into steam/sparks

    // trail particles: embers rise off Дөл, droplets fall off Дусал
    a.emit += dt * (moving || !h.grounded ? 22 : 7);
    while (a.emit > 1) {
      a.emit -= 1;
      const ex = x + CHAR_W / 2 + (Math.random() - 0.5) * 14;
      if (fire) this._p({ x: ex, y: y + 4 + Math.random() * 8, vx: (Math.random() - 0.5) * 20 - vxEst * 0.15, vy: -40 - Math.random() * 50, g: -20, life: 0, max: 0.4 + Math.random() * 0.4, r: 1 + Math.random() * 1.8, col: Math.random() < 0.5 ? '#ffd25a' : '#ff7a2a', glow: true });
      else if (Math.random() < 0.55) this._p({ x: ex, y: y + CHAR_H - 6, vx: -vxEst * 0.1, vy: 10, g: 500, life: 0, max: 0.35, r: 1.4 + Math.random(), col: '#8ff0ff', glow: true });
    }

    const cx = x + CHAR_W / 2, by = y + CHAR_H;
    ctx.save();
    ctx.globalAlpha = dim ? 0.5 : 1;
    // ground shadow
    ctx.fillStyle = 'rgba(2,1,12,0.35)';
    ctx.beginPath(); ctx.ellipse(cx, by + 1, 11 * (1 + a.sq * 0.5), 3, 0, 0, 7); ctx.fill();
    // glow
    ctx.globalCompositeOperation = 'lighter';
    const gl = ctx.createRadialGradient(cx, by - 14, 2, cx, by - 14, 36);
    gl.addColorStop(0, fire ? 'rgba(255,140,50,0.35)' : 'rgba(60,220,230,0.25)'); gl.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = gl; ctx.fillRect(cx - 36, by - 50, 72, 72);
    ctx.globalCompositeOperation = 'source-over';

    ctx.translate(cx, by);
    ctx.rotate(a.lean);
    const bob = h.grounded ? (moving ? Math.abs(Math.sin(a.run)) * -2 : Math.sin(this.time * 3 + (fire ? 0 : 1.5)) * 0.8) : 0;
    ctx.translate(0, bob);
    ctx.scale(1 + a.sq * 0.6, 1 - a.sq);
    const face = h.face || 1;
    const img = fire ? IMG.heroF : IMG.heroW;
    if (img) {
      const s = 50 / img.height;
      ctx.scale(face, 1);
      ctx.drawImage(img, -img.width * s / 2, -img.height * s + 1, img.width * s, img.height * s);
    } else if (fire) this._drawDul(ctx, a, face, moving);
    else this._drawDusal(ctx, a, face, moving);
    ctx.restore();

    if (marker) {
      // solo: a small bobbing arrow above the hero you are driving
      const my = by - 58 + Math.sin(this.time * 5) * 2.5;
      ctx.fillStyle = fire ? '#ffb347' : '#5fe8dc';
      ctx.beginPath(); ctx.moveTo(cx - 6, my - 6); ctx.lineTo(cx + 6, my - 6); ctx.lineTo(cx, my + 1); ctx.closePath(); ctx.fill();
    }
  }

  _feet(ctx, a, moving, col) {
    const sw = moving ? Math.sin(a.run) * 4 : 0;
    ctx.fillStyle = col;
    ctx.beginPath(); ctx.ellipse(-5 + sw, -2, 4.2, 2.6, 0, 0, 7); ctx.fill();
    ctx.beginPath(); ctx.ellipse(5 - sw, -2, 4.2, 2.6, 0, 0, 7); ctx.fill();
  }

  _eyes(ctx, a, face, y) {
    const eo = face * 2.2;
    const blink = a.blink < 0;
    ctx.fillStyle = '#fff';
    if (blink) {
      ctx.fillRect(-7 + eo, y, 5, 1.5); ctx.fillRect(2 + eo, y, 5, 1.5);
      return;
    }
    ctx.beginPath(); ctx.ellipse(-4.2 + eo, y, 3.3, 4, 0, 0, 7); ctx.ellipse(4.2 + eo, y, 3.3, 4, 0, 0, 7); ctx.fill();
    ctx.fillStyle = '#1b1530';
    ctx.beginPath(); ctx.ellipse(-4.2 + eo + face * 1.1, y + 0.5, 1.9, 2.5, 0, 0, 7); ctx.ellipse(4.2 + eo + face * 1.1, y + 0.5, 1.9, 2.5, 0, 0, 7); ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(-4.8 + eo + face * 1.1, y - 0.8, 0.8, 0, 7); ctx.arc(3.6 + eo + face * 1.1, y - 0.8, 0.8, 0, 7); ctx.fill();
  }

  // Дөл: a round flame spirit in a tiny pointed fur hat (toortsog)
  _drawDul(ctx, a, face, moving) {
    const tm = this.time;
    this._feet(ctx, a, moving, '#c4400f');
    // flame tongues behind the hat
    const tongues = [[-8, -30, 0], [0, -38, 1.3], [8, -31, 2.4]];
    for (const [tx, ty, ph] of tongues) {
      const fl = Math.sin(tm * 11 + ph) * 3;
      ctx.fillStyle = '#ffb02e';
      ctx.beginPath(); ctx.moveTo(tx - 6, -20); ctx.quadraticCurveTo(tx - 4 + fl * 0.4, ty + 8, tx + fl, ty); ctx.quadraticCurveTo(tx + 4 + fl * 0.4, ty + 8, tx + 6, -20); ctx.closePath(); ctx.fill();
    }
    // body
    const g = ctx.createRadialGradient(-2, -13, 2, 0, -12, 15);
    g.addColorStop(0, '#fff3a6'); g.addColorStop(0.45, '#ffb22e'); g.addColorStop(1, '#f2541b');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(-12, -9); ctx.quadraticCurveTo(-13, -26, 0, -27); ctx.quadraticCurveTo(13, -26, 12, -9);
    ctx.quadraticCurveTo(11, -1, 0, -1); ctx.quadraticCurveTo(-11, -1, -12, -9); ctx.closePath(); ctx.fill();
    // cheeks + collar sash with a coral bead
    ctx.fillStyle = 'rgba(255,90,60,0.45)'; ctx.beginPath(); ctx.arc(-7 + face * 2, -10, 2.2, 0, 7); ctx.arc(7 + face * 2, -10, 2.2, 0, 7); ctx.fill();
    ctx.fillStyle = '#b3261e'; ctx.beginPath(); ctx.moveTo(-10, -6); ctx.quadraticCurveTo(0, -2, 10, -6); ctx.lineTo(10, -4); ctx.quadraticCurveTo(0, 0, -10, -4); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#ff6b5b'; ctx.beginPath(); ctx.arc(face * 3, -3.4, 1.8, 0, 7); ctx.fill();
    this._eyes(ctx, a, face, -16);
    // toortsog hat: upturned brim + pointed crown + gold knot
    ctx.save(); ctx.translate(face * 1.5, -25); ctx.rotate(face * -0.12);
    ctx.fillStyle = '#7a1a10';
    ctx.beginPath(); ctx.ellipse(0, 0, 10, 3.6, 0, 0, 7); ctx.fill();
    ctx.fillStyle = '#c0301c';
    ctx.beginPath(); ctx.moveTo(-7, -1); ctx.quadraticCurveTo(-5, -10, 1, -15); ctx.quadraticCurveTo(5, -9, 7, -1); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#e2b25a'; ctx.beginPath(); ctx.arc(1, -15.5, 1.8, 0, 7); ctx.fill();
    ctx.fillRect(-7, -2, 14, 1.4);
    ctx.restore();
  }

  // Дусал: a water drop spirit with a turquoise stone ornament
  _drawDusal(ctx, a, face, moving) {
    const tm = this.time;
    this._feet(ctx, a, moving, '#1f6fb0');
    const curl = Math.sin(tm * 4) * 1.5;
    const g = ctx.createRadialGradient(-3, -14, 2, 0, -12, 16);
    g.addColorStop(0, '#d8fffd'); g.addColorStop(0.45, '#4fd6e8'); g.addColorStop(1, '#1c6fd0');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(face * 2 + curl, -36);
    ctx.quadraticCurveTo(13, -20, 12, -9); ctx.quadraticCurveTo(11, -1, 0, -1);
    ctx.quadraticCurveTo(-11, -1, -12, -9); ctx.quadraticCurveTo(-13, -20, face * 2 + curl, -36);
    ctx.closePath(); ctx.fill();
    // inner bubbles drifting up
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    for (let i = 0; i < 3; i++) { const by = -4 - ((tm * 9 + i * 7) % 20); ctx.beginPath(); ctx.arc(-5 + i * 5, by, 1 + (i % 2) * 0.6, 0, 7); ctx.fill(); }
    // highlight
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.beginPath(); ctx.ellipse(-6.5, -17, 2, 5, 0.35, 0, 7); ctx.fill();
    // collar sash
    ctx.fillStyle = '#1a4f9c'; ctx.beginPath(); ctx.moveTo(-10, -6); ctx.quadraticCurveTo(0, -2, 10, -6); ctx.lineTo(10, -4); ctx.quadraticCurveTo(0, 0, -10, -4); ctx.closePath(); ctx.fill();
    ctx.fillStyle = 'rgba(80,190,255,0.5)'; ctx.beginPath(); ctx.arc(-7 + face * 2, -10, 2.2, 0, 7); ctx.arc(7 + face * 2, -10, 2.2, 0, 7); ctx.fill();
    this._eyes(ctx, a, face, -15);
    // turquoise stone in a silver setting, on the curl
    const ox = face * 6 + curl * 0.5, oy = -27;
    ctx.fillStyle = '#d9e3ea'; ctx.beginPath(); ctx.arc(ox, oy, 3.6, 0, 7); ctx.fill();
    ctx.fillStyle = '#22c7b5'; ctx.beginPath(); ctx.arc(ox, oy, 2.5, 0, 7); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.8)'; ctx.beginPath(); ctx.arc(ox - 0.8, oy - 0.9, 0.8, 0, 7); ctx.fill();
  }

  // ---- HUD -------------------------------------------------------------------
  _gemIcon(ctx, x, y, fire, s) {
    ctx.save(); ctx.translate(x, y); ctx.scale(s, s);
    if (fire) {
      ctx.fillStyle = '#ff6b5b';
      ctx.beginPath(); for (let i = 0; i < 6; i++) { const a = i / 6 * Math.PI * 2 - Math.PI / 2; ctx.lineTo(Math.cos(a) * 6, Math.sin(a) * 6.6); } ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#ffb3a0'; ctx.beginPath(); ctx.moveTo(0, -6.6); ctx.lineTo(5.2, -3.3); ctx.lineTo(0, 0); ctx.lineTo(-5.2, -3.3); ctx.closePath(); ctx.fill();
    } else {
      ctx.fillStyle = '#d9e3ea'; ctx.beginPath(); ctx.ellipse(0, 0, 6.4, 7.4, 0, 0, 7); ctx.fill();
      ctx.fillStyle = '#22c7b5'; ctx.beginPath(); ctx.ellipse(0, 0, 5, 6, 0, 0, 7); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.8)'; ctx.beginPath(); ctx.ellipse(-1.8, -2.8, 1.6, 1, -0.5, 0, 7); ctx.fill();
    }
    ctx.restore();
  }

  _hud(world, status) {
    const ctx = this.ctx;
    // The HUD is drawn in world units, then the whole world is scaled to fit the
    // screen — so on a squeezed portrait/mobile view (small this.scale) the text
    // renders tiny. Enlarge it inversely to the scale so it stays a readable
    // physical size (k=1 on desktop, ~2.2 on a rotated phone).
    const k = Math.max(1, 1 / (this.scale || 1));
    const barH = Math.round(30 * k), yb = Math.round(20 * k);
    // On a rotated phone the bar spans the whole safe width, not just the
    // letterboxed world: that pushes the counters to the far end, clear of the
    // host's lock button (content top, ~76% across). Elsewhere it's the world.
    let x0 = 0, x1 = WW, b0 = 0, b1 = WW;
    if (this.rot.classList.contains('rotated')) {
      const s = this.safe || { left: 0, right: 0 };
      x0 = Math.min(0, (s.left - this.ox) / this.scale);
      x1 = Math.max(WW, (this.cw - s.right - this.ox) / this.scale);
      b0 = Math.min(0, -this.ox / this.scale);
      b1 = Math.max(WW, (this.cw - this.ox) / this.scale);
    }
    const WL = b1 - b0;
    const hud = ctx.createLinearGradient(0, 0, 0, barH);
    hud.addColorStop(0, 'rgba(12,9,34,0.86)'); hud.addColorStop(1, 'rgba(12,9,34,0.55)');
    ctx.fillStyle = hud; ctx.fillRect(b0, 0, WL, barH);
    ctx.fillStyle = 'rgba(226,178,90,0.75)'; ctx.fillRect(b0, barH - Math.max(1, Math.round(k * 1.2)), WL, Math.max(1, Math.round(k * 1.2)));

    // left: level number + name (leave room for the DOM menu button)
    const left = x0 + Math.round(52 * k);
    ctx.font = `700 ${Math.round(13 * k)}px "Trebuchet MS", sans-serif`; ctx.textAlign = 'left';
    ctx.fillStyle = '#e2b25a';
    const lvStr = `${world.level + 1}/${TOTAL_LEVELS}`;
    ctx.fillText(lvStr, left, yb);
    const lw = ctx.measureText(lvStr + '  ').width;
    ctx.fillStyle = '#ece6ff';
    ctx.font = `600 ${Math.round(13 * k)}px "Trebuchet MS", sans-serif`;
    ctx.fillText(nameOf(world.name), left + lw, yb);

    // right: coral / turquoise counts
    let fGot = 0, fAll = 0, wGot = 0, wAll = 0;
    for (const g of world.gems) { if (g.kind === 'r') { fAll++; if (g.taken) fGot++; } else { wAll++; if (g.taken) wGot++; } }
    ctx.textAlign = 'right'; ctx.font = `700 ${Math.round(13 * k)}px "Trebuchet MS", sans-serif`;
    let rx = x1 - Math.round(10 * k);
    const wS = `${wGot}/${wAll}`, fS = `${fGot}/${fAll}`;
    ctx.fillStyle = wGot === wAll && wAll ? '#7ffff0' : '#cfe9ff'; ctx.fillText(wS, rx, yb);
    rx -= ctx.measureText(wS).width + Math.round(11 * k);
    this._gemIcon(ctx, rx, yb - Math.round(4.5 * k), false, k * 0.85);
    rx -= Math.round(14 * k);
    ctx.fillStyle = fGot === fAll && fAll ? '#ffc0a8' : '#ffe0d6'; ctx.fillText(fS, rx, yb);
    rx -= ctx.measureText(fS).width + Math.round(11 * k);
    this._gemIcon(ctx, rx, yb - Math.round(4.5 * k), true, k * 0.85);

    // centre: timer against par
    const par = MAPS[world.level] && MAPS[world.level].par;
    const over = par != null && status.mapTime > par;
    const tStr = fmtTime(status.mapTime);
    ctx.textAlign = 'center';
    ctx.font = `700 ${Math.round(16 * k)}px "Trebuchet MS", sans-serif`;
    ctx.fillStyle = over ? '#c9bfe0' : '#ffe08a';
    const mid = (x0 + x1) / 2;
    ctx.fillText(tStr, mid, yb);
    if (par != null) {
      ctx.font = `600 ${Math.round(10.5 * k)}px "Trebuchet MS", sans-serif`;
      ctx.fillStyle = over ? 'rgba(200,190,230,0.5)' : 'rgba(255,224,138,0.7)';
      const tw = ctx.measureText(tStr).width;
      ctx.textAlign = 'left';
      ctx.fillText(`★ ${fmtTime(par)}`, mid + Math.round(28 * k) + tw * 0.1, yb);
    }

    if (status.intro > 0) {
      ctx.globalAlpha = Math.min(1, status.intro / 0.4);
      const bandH = Math.round(96 * k);
      const g = ctx.createLinearGradient(0, WH / 2 - bandH / 2, 0, WH / 2 + bandH / 2);
      g.addColorStop(0, 'rgba(12,9,34,0)'); g.addColorStop(0.25, 'rgba(12,9,34,0.78)'); g.addColorStop(0.75, 'rgba(12,9,34,0.78)'); g.addColorStop(1, 'rgba(12,9,34,0)');
      ctx.fillStyle = g; ctx.fillRect(0, WH / 2 - bandH / 2, WW, bandH);
      ctx.textAlign = 'center';
      ctx.fillStyle = '#e2b25a'; ctx.font = `700 ${Math.round(14 * k)}px "Trebuchet MS", sans-serif`;
      ctx.fillText(t('level', world.level + 1).toUpperCase(), WW / 2, WH / 2 - Math.round(12 * k));
      ctx.fillStyle = '#fff8ec'; ctx.font = `700 ${Math.round(30 * k)}px "Trebuchet MS", sans-serif`;
      ctx.fillText(nameOf(world.name), WW / 2, WH / 2 + Math.round(20 * k));
      ctx.globalAlpha = 1;
    }
  }
}
