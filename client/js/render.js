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
    const portrait = window.innerHeight > window.innerWidth * 1.05;
    this.rot.classList.toggle('rotated', portrait);
    const w = this.rot.clientWidth, h = this.rot.clientHeight;
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.cw = w; this.chh = h;
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    const padH = Math.min(h * 0.22, 96);
    this.scale = Math.min(w / WW, (h - padH) / WH);
    this.ox = (w - WW * this.scale) / 2;
    this.oy = Math.max(0, (h - padH - WH * this.scale) / 2);
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
    bg.addColorStop(0, '#11141f'); bg.addColorStop(1, '#0a0c13');
    ctx.fillStyle = bg; ctx.fillRect(0, 0, cw, chh);

    ctx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * ox, dpr * oy);
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, WW, WH); ctx.clip();

    const cave = ctx.createLinearGradient(0, 0, 0, WH);
    cave.addColorStop(0, '#1b2030'); cave.addColorStop(0.6, '#171c2a'); cave.addColorStop(1, '#131722');
    ctx.fillStyle = cave; ctx.fillRect(0, 0, WW, WH);
    for (let i = 0; i < 26; i++) {
      const rx = hash2(i, 7) * WW, ry = hash2(i, 13) * WH, rr = 30 + hash2(i, 3) * 80;
      ctx.fillStyle = 'rgba(255,255,255,0.018)';
      ctx.beginPath(); ctx.arc(rx, ry, rr, 0, 7); ctx.fill();
    }

    this._tiles(world);
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
    this._hud(world, status);
    ctx.restore();
  }

  _tiles(world) {
    const ctx = this.ctx;
    for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) {
      const c = world.grid[y][x];
      if (c === '#') {
        const shade = 0.9 + hash2(x, y) * 0.2, px = x * T, py = y * T;
        ctx.fillStyle = `rgb(${(42 * shade) | 0},${(47 * shade) | 0},${(62 * shade) | 0})`;
        ctx.fillRect(px, py, T, T);
        if ((y === 0 ? '#' : world.grid[y - 1][x]) !== '#') { ctx.fillStyle = 'rgba(130,150,190,0.5)'; ctx.fillRect(px, py, T, 3); }
        ctx.fillStyle = 'rgba(0,0,0,0.14)'; ctx.fillRect(px + T - 3, py + 3, 3, T - 3);
      } else if (c === '=') {
        const px = x * T, py = y * T;
        ctx.fillStyle = '#5b4a35'; ctx.fillRect(px, py, T, 8);
        ctx.fillStyle = '#7a6448'; ctx.fillRect(px, py, T, 3);
      }
    }
  }

  _liquids(world) {
    const ctx = this.ctx;
    for (const q of world.liquids) {
      const px = q.x * T, py = q.y * T + T * 0.5;
      const col = q.kind === 'F' ? ['#ff6a2a', '#c93a10'] : q.kind === 'W' ? ['#48a7ff', '#1c62c9'] : ['#7ed941', '#3f9a1e'];
      const g = ctx.createLinearGradient(0, py, 0, py + T * 0.5);
      g.addColorStop(0, col[0]); g.addColorStop(1, col[1]);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(px, py + 4 + Math.sin(this.time * 4 + q.x * 1.7) * 2);
      for (let i = 1; i <= 4; i++) { const wx = px + (T / 4) * i; ctx.lineTo(wx, py + 4 + Math.sin(this.time * 4 + (q.x + i / 4) * 1.7) * 2); }
      ctx.lineTo(px + T, py + T * 0.5); ctx.lineTo(px, py + T * 0.5); ctx.closePath(); ctx.fill();
      ctx.fillStyle = q.kind === 'F' ? 'rgba(255,140,60,0.15)' : q.kind === 'W' ? 'rgba(90,170,255,0.12)' : 'rgba(130,220,70,0.12)';
      ctx.fillRect(px, py - 10, T, 10);
    }
  }

  _gems(world) {
    const ctx = this.ctx;
    for (const g of world.gems) {
      if (g.taken) continue;
      const x = g.x * T + T / 2, y = g.y * T + T / 2 + Math.sin(this.time * 3 + g.x) * 3, r = 7;
      ctx.save(); ctx.translate(x, y); ctx.rotate(Math.sin(this.time * 2 + g.y) * 0.2);
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
      ctx.fillStyle = '#3a4157'; ctx.fillRect(f.px, f.py, f.w, 14);
      ctx.fillStyle = col; ctx.fillRect(f.px, f.py, f.w, 4);
      ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.fillRect(f.px, f.py + 10, f.w, 4);
    }
  }

  _hero(world, h, fire, renderPos, dim) {
    const ctx = this.ctx;
    if (h.dead && h.deadT > 0.35) return;
    const x = renderPos ? renderPos.x : h.x, y = renderPos ? renderPos.y : h.y;
    ctx.save();
    ctx.globalAlpha = h.dead ? Math.max(0, 1 - (h.deadT || 0) * 3) : dim ? 0.55 : 1;
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
    ctx.fillStyle = 'rgba(10,12,20,0.55)'; ctx.fillRect(0, 0, WW, 26);
    ctx.fillStyle = '#e8ecf5'; ctx.font = '600 13px sans-serif'; ctx.textAlign = 'left';
    ctx.fillText(`MAP ${world.level + 1}/${TOTAL_LEVELS} · ${world.name}`, 10, 17);
    const got = world.gems.filter((g) => g.taken).length;
    ctx.textAlign = 'right';
    ctx.fillText(`💎 ${got}   ☠ ${status.deaths}`, WW - 10, 17);

    const best = status.best;
    const tStr = '⏱ ' + fmtTime(status.mapTime);
    const bStr = best != null ? '  best ' + fmtTime(best) : '';
    ctx.textAlign = 'left'; ctx.font = '700 14px sans-serif';
    const tW = ctx.measureText(tStr).width;
    ctx.font = '600 11px sans-serif';
    const bW = best != null ? ctx.measureText(bStr).width : 0;
    const startX = WW / 2 - (tW + bW) / 2;
    ctx.font = '700 14px sans-serif';
    ctx.fillStyle = (best != null && status.mapTime > best) ? '#ff9a8a' : '#ffe08a';
    ctx.fillText(tStr, startX, 17);
    if (best != null) { ctx.font = '600 11px sans-serif'; ctx.fillStyle = 'rgba(255,255,255,0.5)'; ctx.fillText(bStr, startX + tW, 17); }

    if (status.intro > 0) {
      ctx.globalAlpha = Math.min(1, status.intro / 0.4);
      ctx.fillStyle = 'rgba(8,10,16,0.6)'; ctx.fillRect(0, WH / 2 - 44, WW, 88);
      ctx.fillStyle = '#fff'; ctx.font = '700 30px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText(`MAP ${world.level + 1} — ${world.name}`, WW / 2, WH / 2 + 10);
      ctx.globalAlpha = 1;
    }
  }
}
