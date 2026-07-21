// Boot + game loop. Runs inside the Usion host (identity + rooms + direct-mode
// access from the SDK) and standalone (dev token). Fixed-tick (60 Hz) drives
// input + prediction; rendering runs every animation frame with interpolation.

import { SERVICE_ID, devServerUrl, devRoomId } from './config.js';
import { DT, TOTAL_LEVELS } from '../shared/protocol.js';
import { Net } from './net.js';
import { Input } from './input.js';
import { Game } from './game.js';
import { Renderer } from './render.js';
import { makeWorld, stepServer, loadLevel } from '../shared/sim.js';

const $ = (id) => document.getElementById(id);
const rot = $('rot');
const canvas = $('board');
const renderer = new Renderer(rot, canvas);
const input = new Input();

const me = { userId: null, userName: '', embedded: false, roomId: null };
let net = null, game = null, netStarted = false, started = false;

// ── TEMP connection debug panel (top-right) — REMOVE once the bug is fixed ──
// Rolling on-screen log of the connection handshake so it can be read on a phone
// where the console isn't visible. Lives outside #rot so orientation/rotation
// never hides it. Search "TEMP connection debug" to rip all of this out.
const dbg = (() => {
  let el = null, lines = [];
  const mount = () => {
    if (el || !document.body) return;
    el = document.createElement('div');
    el.id = 'connDbg';
    el.style.cssText = 'position:fixed;top:4px;right:4px;z-index:2147483647;max-width:66vw;'
      + 'font:10px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace;color:#8fffce;'
      + 'background:rgba(0,0,0,.78);padding:5px 7px;border-radius:6px;pointer-events:none;'
      + 'white-space:pre-wrap;word-break:break-all;max-height:74vh;overflow:hidden';
    document.body.appendChild(el);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
  return (msg) => {
    try {
      mount();
      const d = new Date();
      const t = `${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
      lines.push(`${t} ${msg}`);
      if (lines.length > 18) lines = lines.slice(-18);
      if (el) el.textContent = lines.join('\n');
    } catch { /* never let debug break the game */ }
    try { console.log('[FW]', msg); } catch { /* ignore */ }
  };
})();

let bestTimes = {};
try { bestTimes = JSON.parse(localStorage.getItem('fw:best') || '{}') || {}; } catch { bestTimes = {}; }
const saveBest = () => { try { localStorage.setItem('fw:best', JSON.stringify(bestTimes)); } catch { /* ignore */ } };

// ---------------------------------------------------------------- Usion boot --
function boot() {
  const U = window.Usion;
  if (U && typeof U.init === 'function') {
    let done = false;
    const ready = (config) => {
      if (done) return; done = true;
      try {
        me.userId = (U.user && U.user.getId && U.user.getId()) || (config && config.userId) || null;
        me.userName = (U.user && U.user.getName && U.user.getName()) || (config && config.userName) || '';
        me.embedded = (U._isEmbedded != null) ? !!U._isEmbedded : true;
        me.roomId = (U.config && U.config.roomId) || (config && config.roomId) || null;
        if (U.game && U.game.onRoomAssigned) {
          U.game.onRoomAssigned((info) => onRoomAssigned((info && info.roomId) || (U.config && U.config.roomId)));
        }
      } catch { /* fall through */ }
      onReady();
    };
    U.init(ready);
    setTimeout(() => ready(null), 3000);   // guard: never hang on a silent host
  } else {
    me.embedded = false;
    onReady();
  }
}

function onReady() {
  const who = $('whoami');
  if (who) who.textContent = me.userName ? `Playing as ${me.userName}` : (me.embedded ? '' : 'Guest');
  // "Play again" on the victory card still needs wiring.
  $('againBtn')?.addEventListener('click', () => {
    $('endOverlay').hidden = true;
    if (net) net.sendJson({ t: 'restart' });
  });
  // TEMP debug: what identity/mode did the host hand us?
  const cfg = (window.Usion && window.Usion.config) || {};
  dbg(`init embedded=${me.embedded} mode=${cfg.connectionMode || '?'}`);
  dbg(`room=${me.roomId || '(none)'}`);
  dbg(`svc cfg=${cfg.serviceId || '?'} const=${SERVICE_ID}`);
  dbg(`players=${(cfg.playerIds || []).length} tok=${cfg.authToken ? 'y' : 'n'}`);
  // Start card removed — jump straight into the game as soon as identity is ready.
  if (started) return;
  started = true;
  const start = $('start'); if (start) start.style.display = 'none';
  connectAndPlay();
}

let toastTimer = 0;
function toast(text, ms = 2400) {
  const el = $('toast'); if (!el) return;
  el.textContent = text; el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

// ------------------------------------------------------------- mode selection --
function connectAndPlay() {
  // Standalone/dev override: ?dev=1 forces a direct WS connect with a dev token
  // (server must run with DEV_ALLOW_UNSIGNED=1). Handy for local two-tab testing.
  if (/[?&]dev=1/.test(location.search)) { dbg('branch: dev=1'); startNet(() => Promise.resolve(devUrl())); return; }
  if (me.embedded && me.roomId) {
    dbg('branch: platform direct');
    startNet(() => platformUrl(me.roomId));
  } else if (me.embedded && !me.roomId) {
    dbg('branch: solo practice (no room)');
    startSoloPractice();
    toast('Practice mode — tap Share above to play with a friend', 3600);
  } else {
    dbg('branch: standalone dev');
    startNet(() => Promise.resolve(devUrl()));
  }
}

async function platformUrl(roomId) {
  // Direct-mode access requires the service to be registered with
  // realtime.connection_mode === 'direct' (see scripts/register_direct.mjs). If
  // it isn't, _fetchDirectAccess yields no usable token and every (re)connect
  // fails — surface WHY in the console instead of looping on a silent spinner.
  // The 400 on _fetchDirectAccess points at a bad request param, most likely a
  // serviceId that doesn't match the room's real service. Try the authoritative
  // config.serviceId first, then let the SDK default it, then the hardcoded
  // constant — logging which shape the backend accepts. (TEMP diagnostic.)
  const cfgSvc = (window.Usion && window.Usion.config && window.Usion.config.serviceId) || null;
  const attempts = [
    { roomId, serviceId: cfgSvc || SERVICE_ID, protocolVersion: '2' },
    { roomId, protocolVersion: '2' },   // omit serviceId → SDK defaults from config
    { roomId, serviceId: SERVICE_ID, protocolVersion: '2' },
  ];
  let access = null, lastErr = null;
  for (const a of attempts) {
    try {
      dbg(`fetchAccess svc=${a.serviceId || '(default)'} room=${roomId}`);
      const r = await window.Usion.game._fetchDirectAccess(a);
      if (r && r.ws_url && r.access_token) { access = r; break; }
      dbg(`incomplete ws=${!!(r && r.ws_url)} tok=${!!(r && r.access_token)}`);
    } catch (e) {
      lastErr = e;
      dbg(`fetchAccess ERR: ${e && e.message || e}`);
    }
  }
  if (!access) throw lastErr || new Error('bad access payload');
  dbg(`access OK host=${(() => { try { return new URL(access.ws_url).host; } catch { return '?'; } })()} tok=${access.access_token.length}b`);
  const sep = access.ws_url.indexOf('?') === -1 ? '?' : '&';
  return `${access.ws_url}${sep}token=${encodeURIComponent(access.access_token)}`;
}

function devUrl() {
  const room = devRoomId();
  const uid = String(me.userId || `guest-${Math.floor(Math.random() * 9999)}`).replace(/[^\w-]/g, '-');
  const token = `dev:${uid}:${room}`;
  const base = devServerUrl();
  const sep = base.indexOf('?') === -1 ? '?' : '&';
  return `${base}${sep}token=${encodeURIComponent(token)}`;
}

function onRoomAssigned(roomId) {
  if (!roomId || netStarted) return;
  me.roomId = roomId;
  stopSoloPractice();
  $('start').style.display = 'none';
  toast('Match starting…', 1600);
  startNet(() => platformUrl(roomId));
}

// -------------------------------------------------------- multiplayer session --
let introT = 0, prevLevel = -1;

function startNet(resolveUrl) {
  if (netStarted) return;
  netStarted = true;
  stopSoloPractice();

  game = new Game(null);
  net = new Net(resolveUrl, {
    name: me.userName || 'player',
    onDebug: dbg,   // TEMP connection debug
    onSnapshot: (s) => game.onSnapshot(s),
    onEvent: (m) => game.onEvent(m),
    onStatus: (s) => {
      const st = $('status');
      if (st) st.innerHTML = s === 'connected' ? '<span id="pingv"></span>' : `<span class="bad">${s}…</span>`;
      const po = $('pauseOverlay');
      if (po) po.hidden = (s === 'connected');
    },
  });
  game.net = net;
  window.__fw = { game, net, input, renderer };

  let last = performance.now(), acc = 0;
  function loop(now) {
    requestAnimationFrame(loop);
    let dt = (now - last) / 1000; last = now;
    if (dt > 0.25) { dt = 0; acc = 0; }

    acc += dt;
    if (acc > DT * 6) acc = DT;
    while (acc >= DT) { acc -= DT; if (net.connected) game.tick(input.snapshot()); }

    game.frame();
    handleEvents();
    updateOverlays();

    if (game.level !== prevLevel) { prevLevel = game.level; introT = 1.4; }
    introT = Math.max(0, introT - dt);

    renderer.draw(game.world, dt, {
      myKey: game.myKey, remoteKey: game.remoteKey,
      myRenderPos: game.myRenderPos(),
      deaths: game.deaths, mapTime: game.mapTime,
      best: bestTimes[game.level], partnerHere: game.names.size >= 2 || game.remotes.length > 0,
      intro: introT,
    });
  }
  requestAnimationFrame(loop);

  setInterval(() => { const el = $('pingv'); if (el && net) el.textContent = `${net.rtt} ms`; }, 500);
}

function handleEvents() {
  for (const e of game.drainEvents()) {
    if (e.type === 'level') {
      const finished = e.to - 1;
      const prev = bestTimes[finished];
      const isBest = prev == null || e.secs < prev;
      if (isBest) { bestTimes[finished] = e.secs; saveBest(); }
      toast(`Map ${finished + 1} cleared — ${fmt(e.secs)}${isBest ? '  ★ new best!' : ''}`);
    } else if (e.type === 'victory') {
      showVictory(e.total, e.per);
    } else if (e.type === 'join') {
      if (e.hero !== game.myHero) toast(`Partner joined! You are ${game.myKey === 'f' ? 'Fireboy 🔥' : 'Watergirl 💧'}`);
    } else if (e.type === 'leave') {
      toast('Partner left — waiting for them to rejoin…');
    } else if (e.type === 'restart') {
      $('endOverlay').hidden = true;
    } else if (e.type === 'error') {
      toast(e.reason || 'error');
    }
  }
}

function updateOverlays() {
  const waiting = $('waitingOverlay');
  if (!waiting) return;
  const partnerHere = game.names.size >= 2 || game.remotes.length > 0;
  const show = game.ready && !partnerHere && !game.ended && net.connected;
  waiting.hidden = !show;
}

function showVictory(total, per) {
  const per2 = (per && per.length) ? per : [];
  const prevTotal = bestTimes.total;
  const isBestTotal = prevTotal == null || total < prevTotal;
  if (isBestTotal) { bestTimes.total = total; saveBest(); }
  per2.forEach((secs, i) => { if (secs != null && (bestTimes[i] == null || secs < bestTimes[i])) bestTimes[i] = secs; });
  saveBest();
  $('endEmoji').textContent = '🏆';
  $('endTitle').textContent = 'All 5 maps cleared!';
  const perMap = per2.map((s, i) => `${i + 1}: ${fmt(s || 0)}`).join('   ');
  $('endStats').innerHTML =
    `☠ ${game.deaths} falls · ⏱ <b>${fmt(total)}</b>` +
    (isBestTotal ? ' <span style="color:#ffd76e">★ new best!</span>' : (prevTotal != null ? ` <span style="opacity:.6">(best ${fmt(prevTotal)})</span>` : '')) +
    `<br><span style="opacity:.72;font-size:13px">${perMap}</span>`;
  $('endOverlay').hidden = false;
}

const fmt = (s) => { s = Math.floor(s || 0); return Math.floor(s / 60) + ':' + (s % 60 < 10 ? '0' : '') + (s % 60); };

// ------------------------------------------------------------- solo practice --
// No server: run the shared sim locally, human drives Fireboy, Watergirl idles.
// A taste of movement until the host's Share promotes into a real match.
let soloActive = false, soloRAF = 0;
function startSoloPractice() {
  if (soloActive || netStarted) return;
  soloActive = true;
  $('start').style.display = 'none';
  const world = makeWorld(0);
  let last = performance.now(), acc = 0, intro = 1.4, pl = 0;
  function frame(now) {
    if (!soloActive) return;
    soloRAF = requestAnimationFrame(frame);
    let dt = (now - last) / 1000; last = now;
    if (dt > 0.25) { dt = 0; acc = 0; }
    acc += dt; if (acc > DT * 6) acc = DT;
    while (acc >= DT) { acc -= DT; stepServer(world, { f: input.snapshot(), w: {} }, DT); }
    if (world.level !== pl) { pl = world.level; intro = 1.4; }
    intro = Math.max(0, intro - dt);
    renderer.draw(world, dt, {
      myKey: 'f', remoteKey: 'w', myRenderPos: null,
      deaths: world.deaths, mapTime: world.mapTime, best: bestTimes[world.level],
      partnerHere: false, intro,
    });
  }
  soloRAF = requestAnimationFrame(frame);
}
function stopSoloPractice() { soloActive = false; if (soloRAF) cancelAnimationFrame(soloRAF); soloRAF = 0; }

boot();
