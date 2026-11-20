// FX director: watches the world change frame to frame and turns each change
// into juice — particles and screen shake in the renderer, sound in audio.js.
// It only READS state, so it works the same for the networked game (predicted
// own hero, interpolated partner, authoritative world from snapshots) and for
// local solo play.

import { T, CHAR_W, CHAR_H } from '../shared/protocol.js';
import { play } from './audio.js';

export class Fx {
  constructor(renderer) {
    this.r = renderer;
    this.level = -1;
    this.prev = null;
  }

  _snap(world, pos) {
    const heroes = {};
    for (const k of ['f', 'w']) {
      const h = world.heroes[k], p = pos[k] || h;
      heroes[k] = { x: p.x, y: p.y, vy: h.vy || 0, g: !!h.grounded, dead: !!h.dead, door: !!h.atDoor };
    }
    const plates = world.plates.map((p) => {
      const px = p.x * T, py = p.y * T;
      return ['f', 'w'].some((k) => { const h = world.heroes[k]; return !h.dead && h.x < px + T - 4 && h.x + CHAR_W > px + 4 && h.y + CHAR_H > py + T - 12 && h.y + CHAR_H < py + T + 6; });
    });
    return {
      heroes, plates,
      gems: world.gems.map((g) => g.taken),
      levers: { ...world.leverOn },
      gates: world.gates.map((g) => g.open),
      lifts: world.lifts.map((f) => [f.px, f.py]),
    };
  }

  // pos: { f:{x,y}, w:{x,y} } render positions (prediction-smoothed for own hero)
  update(world, pos) {
    const cur = this._snap(world, pos);
    if (world.level !== this.level || !this.prev || this.prev.gems.length !== cur.gems.length) {
      this.level = world.level; this.prev = cur; return;
    }
    const p = this.prev, r = this.r;

    // gems
    for (let i = 0; i < cur.gems.length; i++) {
      if (cur.gems[i] && !p.gems[i]) {
        const g = world.gems[i], fire = g.kind === 'r';
        r.burst(fire ? 'coral' : 'turq', g.x * T + T / 2, g.y * T + T / 2, 16);
        play('gem', { hero: fire ? 'f' : 'w' });
      }
    }
    // levers
    for (const ch of new Set([...Object.keys(cur.levers), ...Object.keys(p.levers)])) {
      if (!!cur.levers[ch] !== !!p.levers[ch]) {
        play('lever', { on: !!cur.levers[ch] });
        for (const v of world.levers) if (String(v.ch) === String(ch)) r.burst('spark', v.x * T + T / 2, v.y * T + T - 20, 6);
      }
    }
    // plates
    for (let i = 0; i < cur.plates.length; i++) if (cur.plates[i] !== p.plates[i]) play('plate', { on: cur.plates[i] });
    // gates starting to move
    for (let i = 0; i < cur.gates.length; i++) {
      const was = (p.gates[i] ?? cur.gates[i]), moving = Math.abs(cur.gates[i] - was) > 0.001;
      const prevMoving = this._gm && this._gm[i];
      if (moving && !prevMoving) play('gate');
      (this._gm = this._gm || [])[i] = moving;
    }
    // lifts starting to move
    for (let i = 0; i < cur.lifts.length; i++) {
      const a = p.lifts[i], b = cur.lifts[i];
      const moving = a && (Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) > 0.05);
      const prevMoving = this._lm && this._lm[i];
      if (moving && !prevMoving) play('lift');
      (this._lm = this._lm || [])[i] = moving;
    }
    // heroes: jump, land, death, door
    for (const k of ['f', 'w']) {
      const a = p.heroes[k], b = cur.heroes[k];
      const cx = b.x + CHAR_W / 2, feet = b.y + CHAR_H;
      if (b.dead && !a.dead) {
        const by = this._killedBy(world, k, a);
        if (k === 'f') r.burst(by === 'G' ? 'goo' : 'steam', cx, feet - 12, by === 'G' ? 18 : 22);
        else r.burst(by === 'G' ? 'goo' : 'sizzle', cx, feet - 12, 22);
        if (by !== 'G') r.burst('steam', cx, feet - 10, 8);
        r.shake(7, 0.4);
        r.flashScreen(k === 'f' ? '#ffb070' : '#9fe8ff', 0.18);
        play('death', { hero: k, by });
        continue;
      }
      if (b.dead) continue;
      if (a.dead && !b.dead) continue;                       // respawn frame
      if (a.g && !b.g && b.y < a.y - 0.5) { play('jump', { hero: k }); r.squash(k, -0.25); }
      if (!a.g && b.g) {
        const impact = Math.min(1.4, Math.max(0.3, (a.vy || 400) / 600));
        play('land', { hero: k, k: impact });
        r.squash(k, 0.35 * impact);
        r.burst('dust', cx, feet, impact > 0.8 ? 6 : 3);
      }
      if (b.door && !a.door) { play('door', { hero: k }); const d = world.doors[k]; if (d) r.burst(k === 'f' ? 'coral' : 'turq', d.x * T + T / 2, (d.y - 1) * T, 10); }
    }
    this.prev = cur;
  }

  _killedBy(world, k, last) {
    const x = last.x, feet = last.y + CHAR_H;
    for (const q of world.liquids) {
      const top = q.y * T + T * 0.5;
      if (x + CHAR_W > q.px && x < q.px + q.pw && feet > top - 8 && feet < q.y * T + T + 8) return q.kind;
    }
    return 'G';
  }

  celebrate() {
    this.r.burst('confetti', 0, 0, 90);
    this.r.flashScreen('#fff6dc', 0.25);
    play('clear');
  }
}
