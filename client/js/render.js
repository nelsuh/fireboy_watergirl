// Canvas renderer for Fire & Water. Draws the shared `world` (tiles, doors,
// gates, lifts, plates, levers, liquids, gems, both heroes) plus a HUD, with
// landscape rotation + letterbox scaling. Pure view: it reads world state and a
// small status object; it never mutates gameplay.

import { T, COLS, ROWS, WW, WH, CHAR_W, CHAR_H, TOTAL_LEVELS } from '../shared/protocol.js';

const CH_COLORS = { 1: '#ffd34d', 2: '#b98bff', 3: '#59e0d8', 4: '#ff7ab8' };
const hash2 = (x, y) => { let h = (x * 374761393 + y * 668265263) | 0; h = (h ^ (h >> 13)) * 1274126177; return ((h ^ (h >> 16)) >>> 0) / 4294967296; };
const fmtTime = (s) => { s = Math.floor(s); if (!isFinite(s) || s < 0) s = 0; const m = Math.floor(s / 60); return m + ':' + (s % 60 < 10 ? '0' : '') + (s % 60); };

export class Renderer {
  constructor(rot, canvas) {
    this.rot = rot;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.time = 0;
    this.particles = [];
    this._prevTaken = [];
    this.dpr = 1; this.scale = 1; this.ox = 0; this.oy = 0; this.cw = 0; this.chh = 0;
    this.resize();
    window.addEventListener('resize', () => setTimeout(() => this.resize(), 50));
  }

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
    const padH = Math.min(h * 0.22, 96);
    const aw = w - s.left - s.right, ah = h - s.top - padH;
    this.scale = Math.min(aw / WW, ah / WH);
    this.ox = s.left + (aw - WW * this.scale) / 2;
    this.oy = s.top + Math.max(0, (ah - WH * this.scale) / 2);
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

  spawnBurst(x, y, col, n) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, s = 60 + Math.random() * 160;
      this.particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 60, life: 0, max: 0.5 + Math.random() * 0.4, col, r: 2 + Math.random() * 3 });
    }
  }

  // world: shared world; status: { myKey, remoteKey, myRenderPos, deaths, mapTime,
  //   best, partnerHere, intro }
  draw(world, dt, status) {
    this.time += dt;
    // gem-collect bursts: detect newly-taken gems
    for (let i = 0; i < world.gems.length; i++) {
      const g = world.gems[i];
      if (g.taken && !this._prevTaken[i]) this.spawnBurst(g.x * T + T / 2, g.y * T + T / 2, g.kind === 'r' ? '#ff8a5a' : '#6db9ff', 10);
      this._prevTaken[i] = g.taken;
    }
    // step particles
    for (const p of this.particles) { p.life += dt; p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 500 * dt; }
    this.particles = this.particles.filter((p) => p.life < p.max);

    const { ctx, dpr, scale, ox, oy, cw, chh } = this;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const bg = ctx.createLinearGradient(0, 0, 0, chh);
    bg.addColorStop(0, '#101a29'); bg.addColorStop(0.58, '#0b121d'); bg.addColorStop(1, '#070b12');
    ctx.fillStyle = bg; ctx.fillRect(0, 0, cw, chh);

    ctx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * ox, dpr * oy);
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, WW, WH); ctx.clip();

    // Static layer (cave gradient + noise + tiles) is pixel-identical every frame
    // for a given level — render it to an offscreen canvas once and blit it,
    // instead of re-running a 720-cell tile loop + gradients + 26 arcs on every
    // frame. That per-frame rebuild was the mobile lag.
    const key = world.level + ':' + world.name;
    if (this._staticKey !== key) this._buildStatic(world);
    ctx.drawImage(this._static, 0, 0, WW, WH);

    this._doors(world);
    this._gates(world);
    this._lifts(world);
    this._plates(world);
    this._levers(world);
    this._liquids(world);
    this._gems(world);
    // partner first, then own hero on top
    this._hero(world, world.heroes[status.remoteKey], status.remoteKey === 'f', null, !status.partnerHere);
    this._hero(world, world.heroes[status.myKey], status.myKey === 'f', status.myRenderPos, false);
    this._particles();
    ctx.restore();
    this._hud(world, status);
  }

  // Build the static level layer (cave + noise + tiles) into an offscreen canvas
  // in world pixels (WW×WH). Rebuilt only when the level changes.
  _buildStatic(world) {
    if (!this._static) {
      this._static = document.createElement('canvas');
      this._static.width = WW; this._static.height = WH;
      this._staticCtx = this._static.getContext('2d');
    }
    const ctx = this._staticCtx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, WW, WH);

    const cave = ctx.createLinearGradient(0, 0, 0, WH);
    cave.addColorStop(0, '#202c3d'); cave.addColorStop(0.58, '#182332'); cave.addColorStop(1, '#111925');
    ctx.fillStyle = cave; ctx.fillRect(0, 0, WW, WH);

    // Quiet carved arches make the cave read as an old elemental temple without
    // competing with the route or adding per-frame rendering work.
    ctx.strokeStyle = 'rgba(145,174,211,0.035)';
    ctx.lineWidth = 9;
    for (let i = 0; i < 5; i++) {
      const ax = 74 + i * 146;
      ctx.beginPath();
      ctx.moveTo(ax - 54, WH);
      ctx.lineTo(ax - 54, 126);
      ctx.arc(ax, 126, 54, Math.PI, 0);
      ctx.lineTo(ax + 54, WH);
      ctx.stroke();
    }

    for (let i = 0; i < 22; i++) {
      const rx = hash2(i, 7) * WW, ry = hash2(i, 13) * WH, rr = 30 + hash2(i, 3) * 80;
      ctx.fillStyle = 'rgba(201,221,244,0.014)';
      ctx.beginPath(); ctx.arc(rx, ry, rr, 0, 7); ctx.fill();
    }

    for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) {
      const c = world.grid[y][x];
      if (c === '#') {
        const shade = 0.9 + hash2(x, y) * 0.2, px = x * T, py = y * T;
        ctx.fillStyle = `rgb(${(39 * shade) | 0},${(48 * shade) | 0},${(63 * shade) | 0})`;
        ctx.fillRect(px, py, T, T);
        if ((y === 0 ? '#' : world.grid[y - 1][x]) !== '#') { ctx.fillStyle = 'rgba(139,167,202,0.46)'; ctx.fillRect(px, py, T, 3); }
        ctx.fillStyle = 'rgba(3,8,14,0.17)'; ctx.fillRect(px + T - 3, py + 3, 3, T - 3);
        ctx.fillStyle = 'rgba(218,232,248,0.025)'; ctx.fillRect(px + 2, py + 3, 1, T - 6);
      } else if (c === '=') {
        const px = x * T, py = y * T;
        ctx.fillStyle = '#554938'; ctx.fillRect(px, py, T, 8);
        ctx.fillStyle = '#887052'; ctx.fillRect(px, py, T, 3);
      }
    }
    this._staticKey = world.level + ':' + world.name;
  }

  _liquids(world) {
    const ctx = this.ctx;
    for (const q of world.liquids) {
      const px = q.px, pw = q.pw, py = q.y * T + T * 0.5;
      const col = q.kind === 'F' ? ['#ff6a2a', '#c93a10'] : q.kind === 'W' ? ['#48a7ff', '#1c62c9'] : ['#7ed941', '#3f9a1e'];
      const g = ctx.createLinearGradient(0, py, 0, py + T * 0.5);
      g.addColorStop(0, col[0]); g.addColorStop(1, col[1]);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(px, py + 4 + Math.sin(this.time * 4 + q.x * 1.7) * 2);
      for (let i = 1; i <= 4; i++) { const wx = px + (pw / 4) * i; ctx.lineTo(wx, py + 4 + Math.sin(this.time * 4 + (q.x + i / 4) * 1.7) * 2); }
      ctx.lineTo(px + pw, py + T * 0.5); ctx.lineTo(px, py + T * 0.5); ctx.closePath(); ctx.fill();
      ctx.strokeStyle = q.kind === 'F' ? 'rgba(255,191,105,0.72)' : q.kind === 'W' ? 'rgba(156,218,255,0.7)' : 'rgba(191,242,133,0.62)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(px, py + 4 + Math.sin(this.time * 4 + q.x * 1.7) * 2);
      for (let i = 1; i <= 4; i++) { const wx = px + (pw / 4) * i; ctx.lineTo(wx, py + 4 + Math.sin(this.time * 4 + (q.x + i / 4) * 1.7) * 2); }
      ctx.stroke();
      ctx.fillStyle = q.kind === 'F' ? 'rgba(255,140,60,0.15)' : q.kind === 'W' ? 'rgba(90,170,255,0.12)' : 'rgba(130,220,70,0.12)';
      ctx.fillRect(px, py - 10, pw, 10);
    }
  }

  _gems(world) {
    const ctx = this.ctx;
    for (const g of world.gems) {
      if (g.taken) continue;
      const x = g.x * T + T / 2, y = g.y * T + T / 2 + Math.sin(this.time * 3 + g.x) * 3, r = 7;
      ctx.save(); ctx.translate(x, y); ctx.rotate(Math.sin(this.time * 2 + g.y) * 0.2);
      ctx.fillStyle = g.kind === 'r' ? 'rgba(255,105,64,0.14)' : 'rgba(75,165,255,0.14)';
      ctx.beginPath(); ctx.arc(0, 0, 11, 0, 7); ctx.fill();
      ctx.fillStyle = g.kind === 'r' ? '#ff5f3c' : '#3e9bff';
      ctx.beginPath(); ctx.moveTo(0, -r); ctx.lineTo(r * 0.8, 0); ctx.lineTo(0, r); ctx.lineTo(-r * 0.8, 0); ctx.closePath(); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.65)';
      ctx.beginPath(); ctx.moveTo(0, -r + 2); ctx.lineTo(3, -1); ctx.lineTo(-2, 0); ctx.closePath(); ctx.fill();
      ctx.restore();
    }
  }

  _doors(world) {
    const ctx = this.ctx;
    for (const k of ['f', 'w']) {
      const d = world.doors[k]; if (!d) continue;
      const px = d.x * T, py = (d.y - 1) * T, fire = k === 'f';
      ctx.fillStyle = '#3a4157';
      ctx.beginPath(); ctx.moveTo(px - 3, py + 2 * T); ctx.lineTo(px - 3, py + 10);
      ctx.arc(px + T / 2, py + 10, T / 2 + 3, Math.PI, 0); ctx.lineTo(px + T + 3, py + 2 * T); ctx.closePath(); ctx.fill();
      const glow = fire ? '#ff8a4a' : '#4da3ff';
      const g = ctx.createLinearGradient(0, py, 0, py + 2 * T);
      g.addColorStop(0, glow); g.addColorStop(1, fire ? '#8a2f0e' : '#123c7a');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.moveTo(px + 2, py + 2 * T); ctx.lineTo(px + 2, py + 12);
      ctx.arc(px + T / 2, py + 12, T / 2 - 2, Math.PI, 0); ctx.lineTo(px + T - 2, py + 2 * T); ctx.closePath(); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.85)'; ctx.font = '13px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText(fire ? '🔥' : '💧', px + T / 2, py + T + 6);
    }
  }

  _plates(world) {
    const ctx = this.ctx;
    for (const p of world.plates) {
      const px = p.x * T, py = p.y * T, col = CH_COLORS[p.ch] || '#fff';
      // cosmetic press: any hero standing on it
      let pressed = false;
      for (const k of ['f', 'w']) { const h = world.heroes[k]; if (!h.dead && h.x < px + T - 4 && h.x + CHAR_W > px + 4 && h.y + CHAR_H > py + T - 12 && h.y + CHAR_H < py + T + 6) pressed = true; }
      const off = pressed ? 5 : 0;
      ctx.fillStyle = '#20242f'; ctx.fillRect(px + 2, py + T - 6, T - 4, 6);
      ctx.fillStyle = col; ctx.fillRect(px + 6, py + T - 12 + off, T - 12, 7 - off);
    }
  }

  _levers(world) {
    const ctx = this.ctx;
    for (const v of world.levers) {
      const cx = v.x * T + T / 2, cy = v.y * T + T - 6, on = !!world.leverOn[v.ch], col = CH_COLORS[v.ch] || '#fff';
      ctx.fillStyle = '#2a2f3e'; ctx.beginPath(); ctx.arc(cx, cy, 6, 0, 7); ctx.fill();
      ctx.strokeStyle = col; ctx.lineWidth = 4; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + (on ? 12 : -12), cy - 16); ctx.stroke();
      ctx.fillStyle = col; ctx.beginPath(); ctx.arc(cx + (on ? 12 : -12), cy - 16, 4.5, 0, 7); ctx.fill();
    }
  }

  _gates(world) {
    const ctx = this.ctx;
    for (const g of world.gates) {
      const hpx = (1 - g.open) * g.h * T; if (hpx < 2) continue;
      const px = g.x * T, py = g.y * T, col = CH_COLORS[g.ch] || '#fff';
      ctx.fillStyle = '#242938'; ctx.fillRect(px + 4, py, T - 8, hpx);
      ctx.fillStyle = col; for (let yy = 6; yy < hpx - 4; yy += 14) ctx.fillRect(px + 8, py + yy, T - 16, 4);
      ctx.fillStyle = 'rgba(255,255,255,0.25)'; ctx.fillRect(px + 4, py + hpx - 4, T - 8, 4);
    }
  }

  _lifts(world) {
    const ctx = this.ctx;
    for (const f of world.lifts) {
      const col = CH_COLORS[f.ch] || '#fff';
      // dpx/dpy = the ~present draw position (game.frame advances a moving ferry to
      // match the predicted rider); falls back to px/py in solo / before first frame.
      const px = f.dpx != null ? f.dpx : f.px, py = f.dpy != null ? f.dpy : f.py;
      ctx.fillStyle = '#3a4157'; ctx.fillRect(px, py, f.w, 14);
      ctx.fillStyle = col; ctx.fillRect(px, py, f.w, 4);
      ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.fillRect(px, py + 10, f.w, 4);
    }
  }

  _hero(world, h, fire, renderPos, dim) {
    const ctx = this.ctx;
    if (h.dead && h.deadT > 0.35) return;
    const x = renderPos ? renderPos.x : h.x, y = renderPos ? renderPos.y : h.y;
    ctx.save();
    ctx.globalAlpha = h.dead ? Math.max(0, 1 - (h.deadT || 0) * 3) : dim ? 0.55 : 1;
    ctx.fillStyle = 'rgba(2,6,12,0.28)';
    ctx.beginPath(); ctx.ellipse(x + CHAR_W / 2, y + CHAR_H + 1, CHAR_W * 0.45, 3.5, 0, 0, 7); ctx.fill();
    const grad = ctx.createLinearGradient(x, y, x, y + CHAR_H);
    if (fire) { grad.addColorStop(0, '#ffb35c'); grad.addColorStop(1, '#ff5a2a'); }
    else { grad.addColorStop(0, '#8fd0ff'); grad.addColorStop(1, '#2f7fe0'); }
    ctx.fillStyle = grad;
    ctx.beginPath();
    const r = 8;
    ctx.moveTo(x + r, y + 6);
    ctx.arcTo(x + CHAR_W, y + 6, x + CHAR_W, y + CHAR_H, r);
    ctx.arcTo(x + CHAR_W, y + CHAR_H, x, y + CHAR_H, 6);
    ctx.arcTo(x, y + CHAR_H, x, y + 6, 6);
    ctx.arcTo(x, y + 6, x + CHAR_W, y + 6, r);
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = fire ? 'rgba(255,211,139,0.68)' : 'rgba(190,229,255,0.68)';
    ctx.lineWidth = 1.2; ctx.stroke();
    const cx = x + CHAR_W / 2;
    if (fire) {
      const fl = Math.sin(this.time * 12 + x) * 2;
      ctx.fillStyle = '#ffdf5c';
      ctx.beginPath(); ctx.moveTo(cx - 8, y + 8);
      ctx.quadraticCurveTo(cx - 6, y - 4 + fl, cx - 1, y + 2);
      ctx.quadraticCurveTo(cx + 1, y - 8 - fl, cx + 5, y + 3);
      ctx.quadraticCurveTo(cx + 9, y - 2 + fl, cx + 8, y + 8); ctx.closePath(); ctx.fill();
    } else {
      ctx.fillStyle = '#bfe4ff';
      ctx.beginPath(); ctx.moveTo(cx, y - 7);
      ctx.quadraticCurveTo(cx + 8, y + 4, cx, y + 9);
      ctx.quadraticCurveTo(cx - 8, y + 4, cx, y - 7); ctx.closePath(); ctx.fill();
    }
    const ey = y + 13, eo = (h.face || 1) * 2;
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(cx - 4 + eo, ey, 3.4, 0, 7); ctx.arc(cx + 4 + eo, ey, 3.4, 0, 7); ctx.fill();
    ctx.fillStyle = '#1a1e2a';
    ctx.beginPath(); ctx.arc(cx - 4 + eo + (h.face || 1), ey, 1.6, 0, 7); ctx.arc(cx + 4 + eo + (h.face || 1), ey, 1.6, 0, 7); ctx.fill();
    ctx.restore();
  }

  _particles() {
    const ctx = this.ctx;
    for (const p of this.particles) { ctx.globalAlpha = 1 - p.life / p.max; ctx.fillStyle = p.col; ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 7); ctx.fill(); }
    ctx.globalAlpha = 1;
  }

  _hud(world, status) {
    const ctx = this.ctx;
    // The HUD is drawn in world units, then the whole world is scaled to fit the
    // screen — so on a squeezed portrait/mobile view (small this.scale) the text
    // renders tiny. Enlarge it inversely to the scale so it stays a readable
    // physical size (k=1 on desktop, ~2.2 on a rotated phone).
    const k = Math.max(1, 1 / (this.scale || 1));
    const barH = Math.round(27 * k), yb = Math.round(18 * k);
    // On a rotated phone the bar spans the whole safe width, not just the
    // letterboxed world: that pushes the counters to the far end, clear of the
    // host's lock button (content top, ~76% across). Elsewhere it's the world.
    // The bar itself bleeds to the screen edges; its text stays inside the insets.
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
    hud.addColorStop(0, 'rgba(8,13,22,0.82)'); hud.addColorStop(1, 'rgba(8,13,22,0.56)');
    ctx.fillStyle = hud; ctx.fillRect(b0, 0, WL, barH);
    const split = ctx.createLinearGradient(b0, 0, b1, 0);
    split.addColorStop(0, 'rgba(255,105,61,0.72)'); split.addColorStop(0.47, 'rgba(255,177,95,0.32)'); split.addColorStop(0.53, 'rgba(105,193,255,0.32)'); split.addColorStop(1, 'rgba(74,166,236,0.72)');
    ctx.fillStyle = split; ctx.fillRect(b0, barH - Math.max(1, Math.round(k)), WL, Math.max(1, Math.round(k)));
    ctx.fillStyle = '#e8eff8'; ctx.font = `700 ${Math.round(13 * k)}px "Trebuchet MS", sans-serif`; ctx.textAlign = 'left';
    ctx.fillText(`MAP ${world.level + 1}/${TOTAL_LEVELS} · ${world.name}`, x0 + 10, yb);
    const got = world.gems.filter((g) => g.taken).length;
    ctx.textAlign = 'right';
    ctx.fillText(`💎 ${got}   ☠ ${status.deaths}`, x1 - 10, yb);

    const best = status.best;
    const tStr = '⏱ ' + fmtTime(status.mapTime);
    const bStr = best != null ? '  best ' + fmtTime(best) : '';
    const bigF = `700 ${Math.round(15 * k)}px "Trebuchet MS", sans-serif`;
    const smF = `600 ${Math.round(12 * k)}px "Trebuchet MS", sans-serif`;
    ctx.textAlign = 'left'; ctx.font = bigF;
    const tW = ctx.measureText(tStr).width;
    ctx.font = smF;
    const bW = best != null ? ctx.measureText(bStr).width : 0;
    const startX = (x0 + x1) / 2 - (tW + bW) / 2;
    ctx.font = bigF;
    ctx.fillStyle = (best != null && status.mapTime > best) ? '#ff9a8a' : '#ffe08a';
    ctx.fillText(tStr, startX, yb);
    if (best != null) { ctx.font = smF; ctx.fillStyle = 'rgba(255,255,255,0.5)'; ctx.fillText(bStr, startX + tW, yb); }

    if (status.intro > 0) {
      ctx.globalAlpha = Math.min(1, status.intro / 0.4);
      const bandH = Math.round(88 * k);
      ctx.fillStyle = 'rgba(7,12,20,0.66)'; ctx.fillRect(0, WH / 2 - bandH / 2, WW, bandH);
      ctx.fillStyle = '#f4f7fc'; ctx.font = `700 ${Math.round(28 * k)}px "Trebuchet MS", sans-serif`; ctx.textAlign = 'center';
      ctx.fillText(`MAP ${world.level + 1} — ${world.name}`, WW / 2, WH / 2 + Math.round(10 * k));
      ctx.globalAlpha = 1;
    }
  }
}
