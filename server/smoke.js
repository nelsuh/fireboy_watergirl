// Headless protocol smoke test: boots the server, runs a scripted 2-player co-op
// session over the real binary/JSON protocol, and asserts: join (two fixed
// seats), both heroes in snapshots, input acks, movement, a hazard death
// (server-authoritative), malformed-frame resilience, and leave + seat-reclaim
// on reconnect. Run: npm test

import { spawn } from 'node:child_process';
import WebSocket from 'ws';
import {
  MSG, DT, BTN_LEFT, BTN_RIGHT, BTN_JUMP, HF_DEAD,
  PH_LOBBY, T, CHAR_H, encodeInput, decodeSnapshot,
} from '../client/shared/protocol.js';
import { makeWorld } from '../client/shared/sim.js';

const PORT = 8124;
const URL = `ws://127.0.0.1:${PORT}`;
let failures = 0;

function check(cond, label) {
  if (cond) console.log(`  ok  ${label}`);
  else { console.error(`FAIL  ${label}`); failures++; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Bot {
  constructor(name) {
    this.name = name;
    this.hero = -1;
    this.seq = 0;
    this.snap = null;
    this.events = [];
    this.ws = null;
  }
  connect(room = 'smoke') {
    return new Promise((resolve, reject) => {
      const userId = this.name.replace(/[^\w-]/g, '-');
      const token = `dev:${userId}:${room}`;
      const ws = new WebSocket(`${URL}/ws?token=${encodeURIComponent(token)}`);
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      const to = setTimeout(() => reject(new Error('connect timeout')), 4000);
      ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', name: this.name, next: this.next || 0 })));
      ws.on('message', (data, isBinary) => {
        if (!isBinary) {
          const msg = JSON.parse(data.toString());
          this.events.push(msg);
          if (msg.t === 'welcome') { this.hero = msg.hero; clearTimeout(to); resolve(); }
          return;
        }
        const buf = Buffer.from(data);
        const v = new DataView(buf.buffer, buf.byteOffset, buf.length);
        if (v.getUint8(0) === MSG.SNAPSHOT) this.snap = decodeSnapshot(v);
      });
      ws.on('error', reject);
    });
  }
  me() { return this.snap ? this.snap.heroes[this.snap.yourHero] : null; }
  ev(type) { return this.events.filter((e) => e.t === type); }
  send(buttons) { this.seq = (this.seq + 1) & 0xffff; this.ws.send(encodeInput(this.seq, buttons)); }
  async drive(ticks, buttons) {
    for (let i = 0; i < ticks; i++) { this.send(buttons); await sleep(1000 * DT); }
  }
  close() { this.ws.close(); }
}

async function main() {
  console.log('starting server…');
  const srv = spawn('node', ['server/server.js'], {
    env: { ...process.env, PORT: String(PORT), NODE_ENV: 'development', DEV_ALLOW_UNSIGNED: '1' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve, reject) => {
    srv.stdout.on('data', (d) => { if (String(d).includes('server on')) resolve(); });
    srv.on('exit', () => reject(new Error('server died')));
    setTimeout(() => reject(new Error('server start timeout')), 5000);
  });

  try {
    // ---- join ----
    const A = new Bot('alice');
    const B = new Bot('bob');
    await A.connect();
    check(A.hero === 0, `A is Дөл / hero 0 (got ${A.hero})`);
    await B.connect();
    check(B.hero === 1, `B is Дусал / hero 1 (got ${B.hero})`);
    await sleep(200);
    check(A.ev('join').some((e) => e.hero === 1), 'A received join event for B');

    // ---- waiting hall: frozen until both are ready ----
    check(!!(A.snap.phase & PH_LOBBY), 'room starts in the waiting hall');
    const lx = A.me().x;
    await A.drive(20, BTN_RIGHT);
    await sleep(100);
    check(Math.abs(A.me().x - lx) < 0.5, 'nobody moves in the waiting hall');
    A.ws.send(JSON.stringify({ t: 'ready', on: true }));
    await sleep(150);
    check(!!(A.snap.phase & PH_LOBBY), 'one ready player does not start the match');
    check(A.ev('lobby').some((e) => e.players.some((p) => p.hero === 0 && p.ready)), 'lobby broadcast shows A ready');
    B.ws.send(JSON.stringify({ t: 'ready', on: true }));
    await sleep(250);
    check(!(A.snap.phase & PH_LOBBY), 'both ready → match starts');
    check(A.ev('goto').some((e) => e.level === 0), 'start goes to the first unfinished level (0)');

    const a0 = A.me(), b0 = B.me();
    check(!!a0 && !!b0, `both heroes in snapshots (A@${Math.round(a0?.x)},${Math.round(a0?.y)} B@${Math.round(b0?.x)},${Math.round(b0?.y)})`);
    check(!(a0.flags & HF_DEAD) && !(b0.flags & HF_DEAD), 'both heroes spawn alive');
    check(A.snap.heroes.length === 2, 'snapshot carries both heroes');

    // ---- malformed frames must not kill the server ----
    A.ws.send('null');
    A.ws.send('{"t":123}');
    A.ws.send(Buffer.from([1, 2]));
    A.ws.send(Buffer.from([99, 0, 0, 0]));
    await sleep(200);
    const tickBefore = A.snap?.tick ?? 0;
    await sleep(300);
    check((A.snap?.tick ?? 0) > tickBefore, 'server still ticking after malformed frames');

    // ---- movement + acks (a short walk right) ----
    const ax0 = A.me().x;
    await A.drive(Math.round(0.3 / DT), BTN_RIGHT);
    await A.drive(3, 0);              // release, or the server keeps holding RIGHT
    await sleep(120);
    const ax1 = A.me().x;
    check(ax1 - ax0 > 30, `hero 0 moved right ${Math.round(ax1 - ax0)}px (>30)`);
    const ackGap = (A.seq - A.snap.lastAckSeq + 65536) % 65536;
    check(ackGap <= 3, `input ack tracks seq (gap ${ackGap})`);

    // ---- jump leaves the ground ----
    const ay0 = A.me().y;
    await A.drive(6, BTN_JUMP);
    let minY = A.me().y;
    for (let i = 0; i < 20; i++) { await A.drive(1, 0); minY = Math.min(minY, A.me().y); }
    check(minY < ay0 - 30, `Дөл jumped (rose ${Math.round(ay0 - minY)}px)`);

    // ---- hazard death is server-authoritative: walk a hero right into the first
    // pool on its floor that kills it (found from level 1's own layout) ----
    const w0 = makeWorld(0);
    const victim = ['f', 'w'].find((k) => {
      const sp = w0.spawns[k];
      const q = w0.liquids.filter((l) => l.y === sp.y && l.px > sp.x * T).sort((a, b) => a.px - b.px)[0];
      return q && (q.kind === 'G' || (q.kind === 'W') === (k === 'f'));
    });
    if (victim) {
      const bot = victim === 'f' ? A : B;
      const deaths0 = bot.snap.deaths;
      for (let i = 0; i < 40 && bot.snap.deaths === deaths0; i++) await bot.drive(6, BTN_RIGHT);
      await sleep(150);
      check(bot.snap.deaths > deaths0, `hero ${victim} died in the wrong pool → deaths ${bot.snap.deaths}`);
    } else console.log('  --  level 1 has no walk-right hazard; death check skipped');

    // ---- either player can pick a level; both follow ----
    B.ws.send(JSON.stringify({ t: 'goto', level: 2 }));
    await sleep(250);
    check(A.snap.level === 2 && B.snap.level === 2, `goto from B moves both to level 3 (A=${A.snap.level})`);
    B.ws.send(JSON.stringify({ t: 'goto', level: 999 }));
    await sleep(150);
    check(A.snap.level === 2, 'out-of-range goto is ignored');

    // ---- leave + seat reclaim on reconnect ----
    A.close();
    await sleep(300);
    check(B.ev('leave').some((e) => e.hero === 0), 'B received leave event for hero 0');
    const A2 = new Bot('alice');            // same identity → reclaims seat 0
    await A2.connect();
    check(A2.hero === 0, `reconnecting alice reclaimed Дөл seat (got ${A2.hero})`);
    A2.close();
    B.close();
  } finally {
    srv.kill();
  }

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
