// Дөл ба Дусал — authoritative realtime server (direct mode).
// Fixed 60 Hz co-op simulation: two seats, hero 0 = Дөл, hero 1 = Дусал.
// Each client sends binary INPUT (seq + button bits) for ITS OWN hero; the server
// steps BOTH heroes and the whole world (levers/plates/gates/lifts/gems/doors)
// with the shared deterministic sim, acks the last processed seq per client in
// each binary SNAPSHOT, and emits infrequent events (level/victory/restart) as JSON.

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, normalize, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import {
  MSG, DT, TICK_RATE, TOTAL_LEVELS, MAX_PLAYERS_PER_ROOM,
  BTN_LEFT, BTN_RIGHT, BTN_JUMP, PH_RUNNING, PH_RESET, PH_ENDED, PH_LOBBY,
  HF_GROUND, HF_FACE_R, HF_DEAD, HF_DOOR,
  decodeInput, encodeSnapshot, encodePong,
} from '../client/shared/protocol.js';
import {
  makeWorld, loadLevel, resetLevel, stepServer, heroFlags, gemsBitmask, leversBitmask,
} from '../client/shared/sim.js';
import { validateAccessToken } from './auth.js';
import { PORT, JWKS_URL, SERVICE_ID, ALLOWED_ORIGINS } from './config.js';

const MAX_CONNS = 128;
const MAX_ROOMS = 64;
const INPUT_QUEUE_CAP = 6;      // jitter buffer; beyond this the oldest input is dropped
const IDLE_TIMEOUT_MS = 20000;  // kick silent connections (clients ping every 2 s)
const HELLO_TIMEOUT_MS = 5000;

const HERO_KEYS = ['f', 'w'];   // seat index -> hero key
const HF = { HF_GROUND, HF_FACE_R, HF_DEAD, HF_DOOR };

// ---------- rooms ----------
const rooms = new Map();

class Room {
  constructor(id) {
    this.id = id;
    this.players = new Map();   // heroSeat(0|1) -> Player
    this.seats = new Map();     // userId -> heroSeat (stable across reconnects)
    this.world = makeWorld(0);
    this.phase = 'lobby';       // 'lobby' (waiting hall) | 'play'
    this.ready = new Map();     // seat -> bool (waiting hall READY toggles)
  }
  lobbyState() {
    return {
      t: 'lobby', phase: this.phase, level: this.world.level,
      players: [...this.players.values()].map((p) => ({
        hero: p.seat, name: p.name, avatar: p.avatar, ready: !!this.ready.get(p.seat),
      })),
    };
  }
  // Load a level fresh for both players (start, next, retry, level select).
  goto(level) {
    loadLevel(this.world, level);
    this.world.ended = false;
    this.world.deaths = 0;
    this.broadcastJson({ t: 'goto', level: this.world.level });
  }
  freeSeat() {
    for (let i = 0; i < MAX_PLAYERS_PER_ROOM; i++) if (!this.players.has(i)) return i;
    return -1;
  }
  broadcastJson(obj) {
    const s = JSON.stringify(obj);
    for (const p of this.players.values()) if (p.ws.readyState === 1) p.ws.send(s);
  }
}

function getRoom(id) {
  let room = rooms.get(id);
  if (!room) {
    if (rooms.size >= MAX_ROOMS) return null;
    room = new Room(id);
    rooms.set(id, room);
  }
  return room;
}

function buttonsToInput(buttons) {
  return { left: !!(buttons & BTN_LEFT), right: !!(buttons & BTN_RIGHT), jump: !!(buttons & BTN_JUMP) };
}

// ---------- per-tick simulation ----------
let tick = 0;

function stepRoom(room) {
  const world = room.world;

  // 1. resolve each seat's input for THIS tick (exactly one per hero per world
  // tick — drain one queued input, else hold the last button state).
  const inputs = { f: { left: false, right: false, jump: false }, w: { left: false, right: false, jump: false } };
  const lobby = room.phase !== 'play';
  for (const [seat, p] of room.players) {
    if (lobby) {
      // Waiting hall: ack and discard — buttons held here must not carry into
      // the first frames of the level once the match starts.
      if (p.inputQueue.length) p.lastAckSeq = p.inputQueue[p.inputQueue.length - 1].seq;
      p.inputQueue.length = 0;
      p.lastButtons = 0;
      continue;
    }
    if (p.inputQueue.length) {
      const inp = p.inputQueue.shift();
      p.lastAckSeq = inp.seq;
      p.lastButtons = inp.buttons;
    }
    inputs[HERO_KEYS[seat]] = buttonsToInput(p.lastButtons);
  }

  // 2. authoritative world step (frozen in the waiting hall)
  const { completed } = lobby ? { completed: false } : stepServer(world, inputs, DT);

  // 3. level completion → freeze and let the players choose what's next
  if (completed && !world.ended) {
    world.ended = true;
    room.broadcastJson({
      t: 'cleared', level: world.level, secs: Math.round(world.mapTime * 100) / 100,
      deaths: world.deaths, gems: gemsBitmask(world),
    });
  }

  // 4. snapshot (binary, per-client ack + own-hero id)
  let phase = 0;
  if (lobby) phase |= PH_LOBBY;
  if (!world.ended) phase |= PH_RUNNING;
  if (world.resetPending) phase |= PH_RESET;
  if (world.ended) phase |= PH_ENDED;
  const heroes = HERO_KEYS.map((k) => {
    const h = world.heroes[k];
    return { x: h.x, y: h.y, vx: h.vx, vy: h.vy, flags: heroFlags(h, HF) };
  });
  const base = {
    tick, level: world.level, phase,
    deaths: world.deaths, mapTimeCs: Math.round(world.mapTime * 100),
    leversOn: leversBitmask(world), gemsTaken: gemsBitmask(world),
    gates: world.gates.map((g) => g.open),
    lifts: world.lifts.map((f) => ({ px: f.px, py: f.py })),
    heroes,
  };
  for (const [seat, p] of room.players) {
    if (p.ws.readyState !== 1) continue;
    if (p.ws.bufferedAmount > 64 * 1024) continue;  // don't pile onto a choked socket
    p.ws.send(encodeSnapshot({ ...base, lastAckSeq: p.lastAckSeq, yourHero: seat }));
  }
}

// drift-corrected global tick loop
const TICK_MS = 1000 / TICK_RATE;
let nextTickAt = Date.now() + TICK_MS;
function loop() {
  const now = Date.now();
  let steps = 0;
  while (now >= nextTickAt && steps < 5) {
    tick++;
    for (const room of rooms.values()) if (room.players.size > 0) stepRoom(room);
    nextTickAt += TICK_MS;
    steps++;
  }
  if (steps === 5 && now >= nextTickAt) nextTickAt = now + TICK_MS;
  setTimeout(loop, Math.max(0, nextTickAt - Date.now()));
}
loop();

// ---------- networking ----------
const CLIENT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'client');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
};

const server = http.createServer(async (req, res) => {
  if (req.url === '/healthz' || req.url === '/health') { res.writeHead(200); res.end('ok'); return; }
  const path = normalize((req.url || '/').split('?')[0]).replace(/^(\.\.[/\\])+/, '');
  const file = join(CLIENT_DIR, path === '/' || path === '\\' ? 'index.html' : path);
  if (!file.startsWith(CLIENT_DIR)) { res.writeHead(403); res.end(); return; }
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': MIME[extname(file)] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  }
});

const wss = new WebSocketServer({ server, perMessageDeflate: false, maxPayload: 2048 });

wss.on('connection', (ws, req) => {
  if (wss.clients.size > MAX_CONNS) { ws.close(1013, 'server full'); return; }
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.length && origin && !ALLOWED_ORIGINS.includes(origin)) { ws.close(4003, 'origin not allowed'); return; }
  req.socket.setNoDelay(true);

  let player = null;
  let room = null;
  let auth = null;
  let lastMsgAt = Date.now();
  const preAuthBuffer = [];

  let token = '';
  try { token = new URL(req.url, 'http://localhost').searchParams.get('token') || ''; } catch { /* keep '' */ }

  ws.on('message', (data, isBinary) => {
    if (!auth) {
      if (preAuthBuffer.length < 4) preAuthBuffer.push([data, isBinary]);
      return;
    }
    try { handleMessage(data, isBinary); } catch { /* a bad frame must never take the server down */ }
  });

  validateAccessToken(token, { jwksUrl: JWKS_URL, serviceId: SERVICE_ID })
    .then((claims) => {
      if (ws.readyState !== 1) return;
      auth = claims;
      const buffered = preAuthBuffer.splice(0);
      for (const [d, b] of buffered) { try { handleMessage(d, b); } catch { /* ignore */ } }
    })
    .catch(() => { try { ws.close(4002, 'invalid token'); } catch { /* already closed */ } });

  const helloTimer = setTimeout(() => { if (!player) ws.close(4000, 'hello timeout'); }, HELLO_TIMEOUT_MS);

  function handleMessage(data, isBinary) {
    lastMsgAt = Date.now();

    if (!isBinary) {
      let msg;
      try { msg = JSON.parse(data.toString().slice(0, 1500)); } catch { return; }
      if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return;

      if (msg.t === 'hello' && !player) {
        const roomId = auth.room_id;
        const name = String(msg.name || auth.name || 'player').replace(/[<>&"']/g, '').trim().slice(0, 16) || 'player';
        const avatar = /^https:\/\/[^\s"'<>]{4,300}$/.test(String(msg.avatar || '')) ? String(msg.avatar) : '';
        const next = Math.max(0, Math.min(TOTAL_LEVELS - 1, Number(msg.next) | 0));
        const r = getRoom(roomId);
        if (!r) { ws.send(JSON.stringify({ t: 'error', reason: 'server full' })); ws.close(1013); return; }

        // A reconnecting user (new socket, same identity) reclaims their seat and
        // retires the old socket, so they can never occupy both seats.
        for (const [seat, existing] of [...r.players]) {
          if (existing.userId === auth.sub) {
            r.players.delete(seat);
            try { existing.ws.close(4008, 'replaced by newer session'); } catch { /* gone */ }
          }
        }
        let seat = r.seats.has(auth.sub) ? r.seats.get(auth.sub) : r.freeSeat();
        if (seat < 0 || r.players.has(seat)) seat = r.freeSeat();
        if (seat < 0) { ws.send(JSON.stringify({ t: 'error', reason: 'room full' })); ws.close(4001); return; }
        r.seats.set(auth.sub, seat);

        clearTimeout(helloTimer);
        room = r;
        player = { seat, userId: auth.sub, name, avatar, next, ws, inputQueue: [], lastAckSeq: 0, lastButtons: 0 };
        room.players.set(seat, player);

        // A player coming back mid-level (reconnect) resumes the level: restart
        // the map so both start together again.
        if (room.phase === 'play' && room.players.size === 2 && !room.world.ended) resetLevel(room.world);

        ws.send(JSON.stringify({
          t: 'welcome', hero: seat, room: roomId, tick, tickRate: TICK_RATE, level: room.world.level,
          phase: room.phase, ended: room.world.ended,
          players: [...room.players.values()].map((p) => ({ hero: p.seat, name: p.name, avatar: p.avatar })),
        }));
        room.broadcastJson({ t: 'join', hero: seat, name, avatar });
        room.broadcastJson(room.lobbyState());
        return;
      }
      if (!player || !room) return;

      if (msg.t === 'ready' && room.phase === 'lobby') {
        room.ready.set(player.seat, !!msg.on);
        const both = room.players.size === MAX_PLAYERS_PER_ROOM
          && [...room.players.keys()].every((s) => room.ready.get(s));
        if (both) {
          // Co-op: start at the first level neither player has finished yet.
          const start = Math.min(...[...room.players.values()].map((p) => p.next));
          room.phase = 'play';
          room.goto(start);
        }
        room.broadcastJson(room.lobbyState());
        return;
      }

      // Next level, retry, or a pick from the level list — either player may
      // choose, any time during play (co-op: nobody to cheat against).
      if (msg.t === 'goto' && room.phase === 'play') {
        const lv = Number(msg.level);
        if (Number.isInteger(lv) && lv >= 0 && lv < TOTAL_LEVELS) room.goto(lv);
      }
      return;
    }

    // binary hot path
    if (!player) return;
    const buf = data;
    if (buf.length < 1) return;
    const v = new DataView(buf.buffer, buf.byteOffset, buf.length);
    const type = v.getUint8(0);
    if (type === MSG.INPUT && buf.length >= 4) {
      const inp = decodeInput(v);
      if (player.inputQueue.length >= INPUT_QUEUE_CAP) player.inputQueue.shift();
      player.inputQueue.push(inp);
    } else if (type === MSG.PING && buf.length >= 9) {
      ws.send(encodePong(v.getFloat64(1, true), Date.now()));
    }
  }

  ws.on('close', () => {
    clearTimeout(helloTimer);
    if (player && room) {
      // Only release the seat if THIS socket still owns it (a newer reconnect may
      // have already taken over the seat under the same identity).
      if (room.players.get(player.seat) === player) {
        room.players.delete(player.seat);
        room.ready.set(player.seat, false);
        room.broadcastJson({ t: 'leave', hero: player.seat });
        room.broadcastJson(room.lobbyState());
      }
      if (room.players.size === 0) rooms.delete(room.id);
    }
  });
  ws.on('error', () => {});

  const idleTimer = setInterval(() => {
    if (Date.now() - lastMsgAt > IDLE_TIMEOUT_MS) { ws.terminate(); clearInterval(idleTimer); }
  }, 5000);
  ws.on('close', () => clearInterval(idleTimer));
});

server.listen(PORT, () => {
  console.log(`Дөл ба Дусал server on :${PORT} — tick ${TICK_RATE} Hz, ${TOTAL_LEVELS} maps`);
});
