import assert from 'node:assert/strict';
import { Game } from '../js/game.js';
import { loadLevel } from '../shared/sim.js';
import { CHAR_H } from '../shared/protocol.js';

const net = {
  serverNowMs: () => 0,
  sendInput: () => {},
};

const game = new Game(net);
game.ready = true;
game.myHero = 1;
game.myKey = 'w';
game.remoteKey = 'f';
loadLevel(game.world, 2); // Map 3: horizontal ferry over green goo.

const lift = game.world.lifts[0];
const hero = game.world.heroes.w;
hero.x = lift.px + 12;
hero.y = lift.py - CHAR_H;
hero.grounded = true;
hero.onLift = 0;
lift.dpy = lift.py;

// Large reconciliation offsets reproduce the visible detachment from the
// screenshots. A supported rider must ignore them and stay on the lift surface.
game.errX = -48;
game.errY = 36;
assert.deepEqual(game.myRenderPos(), { x: hero.x, y: lift.py - CHAR_H });

// Prediction may carry the hero just beyond the stale snapshot geometry. The
// explicit onLift flag must still keep the visual attached in that interval.
hero.x = lift.px + lift.w + 4;
assert.deepEqual(game.myRenderPos(), { x: hero.x, y: lift.py - CHAR_H });

// Once no lift supports the hero, normal correction smoothing still applies.
hero.onLift = -1;
hero.x = lift.px + lift.w + 20;
assert.deepEqual(game.myRenderPos(), { x: hero.x - 48, y: hero.y + 36 });

console.log('  ok  moving-platform rider stays visually attached');
