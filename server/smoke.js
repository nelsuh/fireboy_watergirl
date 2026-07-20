// Headless protocol smoke test: boots the server, runs a scripted 2-player co-op
// session over the real binary/JSON protocol, and asserts: join (two fixed
// seats), both heroes in snapshots, input acks, movement, a hazard death
// (server-authoritative), malformed-frame resilience, and leave + seat-reclaim
// on reconnect. Run: npm test

import { spawn } from 'node:child_process';
import WebSocket from 'ws';
import {
  MSG, DT, BTN_LEFT, BTN_RIGHT, BTN_JUMP, HF_DEAD,
  encodeInput, decodeSnapshot,
} from '../client/shared/protocol.js';

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
      ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', name: this.name })));
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
    srv.stdout.on('data', (d) => { if (String(d).includes('FIRE & WATER server')) resolve(); });
    srv.on('exit', () => reject(new Error('server died')));
    setTimeout(() => reject(new Error('server start timeout')), 5000);
  });

  try {
    // ---- join ----
    const A = new Bot('alice');
    const B = new Bot('bob');
    await A.connect();
    check(A.hero === 0, `A is Fireboy / hero 0 (got ${A.hero})`);
    await B.connect();
    check(B.hero === 1, `B is Watergirl / hero 1 (got ${B.hero})`);
    await sleep(200);
    check(A.ev('join').some((e) => e.hero === 1), 'A received join event for B');

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

    // ---- movement + acks (short hop right, before the water pool at x≈224) ----
    const ax0 = A.me().x;
    await A.drive(Math.round(0.5 / DT), BTN_RIGHT);
    await sleep(120);
    const ax1 = A.me().x;
    check(ax1 - ax0 > 50, `Fireboy moved right ${Math.round(ax1 - ax0)}px (>50)`);
    const ackGap = (A.seq - A.snap.lastAckSeq + 65536) % 65536;
    check(ackGap <= 3, `input ack tracks seq (gap ${ackGap})`);

    // ---- jump leaves the ground ----
    const ay0 = A.me().y;
    await A.drive(6, BTN_JUMP);
    let minY = A.me().y;
    for (let i = 0; i < 20; i++) { await A.drive(1, 0); minY = Math.min(minY, A.me().y); }
    check(minY < ay0 - 30, `Fireboy jumped (rose ${Math.round(ay0 - minY)}px)`);

    // ---- hazard death is server-authoritative: run Fireboy into the water pool ----
    const deaths0 = A.snap.deaths;
    await A.drive(Math.round(2.2 / DT), BTN_RIGHT);
    await sleep(150);
    check(A.snap.deaths > deaths0, `Fireboy drowned in water → deaths ${A.snap.deaths} (>${deaths0})`);

    // ---- leave + seat reclaim on reconnect ----
    A.close();
    await sleep(300);
    check(B.ev('leave').some((e) => e.hero === 0), 'B received leave event for hero 0');
    const A2 = new Bot('alice');            // same identity → reclaims seat 0
    await A2.connect();
    check(A2.hero === 0, `reconnecting alice reclaimed Fireboy seat (got ${A2.hero})`);
    A2.close();
    B.close();
  } finally {
    srv.kill();
  }

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
