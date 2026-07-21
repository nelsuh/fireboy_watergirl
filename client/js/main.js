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

// Am I a real (invited) multiplayer session? Derive from the launch MODE, never
// from the presence of a roomId — GameTok forces mode:'single' but still hands us
// an auto `standalone_` room for SDK plumbing (see extra/gametok.md). Treating
// that room as multiplayer was routing GameTok into the networked one-hero path
// (no swap button). Only a genuine chat game-invite is multiplayer.
function launchedMultiplayer() {
  try {
    const U = window.Usion;
    let lp = {};
    if (U && typeof U.getLaunchParams === 'function') lp = U.getLaunchParams() || {};
    if (lp.mode === 'single') return false;
    if (lp.mode === 'multiplayer') return true;
    if (U && U.game && typeof U.game.isMultiplayer === 'function') return !!U.game.isMultiplayer();
    return false;   // unknown → solo (safe: swap-enabled both-hero practice)
  } catch { return false; }
}

// ------------------------------------------------------------- mode selection --
function connectAndPlay() {
  // Standalone/dev override: ?dev=1 forces a direct WS connect with a dev token
  // (server must run with DEV_ALLOW_UNSIGNED=1). Handy for local two-tab testing.
  if (/[?&]dev=1/.test(location.search)) { startNet(() => Promise.resolve(devUrl())); return; }
  if (me.embedded && launchedMultiplayer() && me.roomId) {
    // Genuine chat game-invite: host-authoritative 2-seat networked match.
    startNet(() => platformUrl(me.roomId));
  } else if (me.embedded) {
    // GameTok / Explore solo: local both-hero co-op with the ⇄ swap button.
    // (Explore can still promote to a live room via the host Share button.)
    startSoloPractice();
    if (!me.roomId) toast('Practice mode — tap Share above to play with a friend', 3600);
  } else {
    startNet(() => Promise.resolve(devUrl()));
  }
}

async function platformUrl(roomId) {
  // Use the AUTHORITATIVE service id from the host (config.serviceId) — the
  // platform assigns an auto-generated hashed slug (e.g. fireboy-and-watergirl-
  // dcb7ed3a), NOT the clean SERVICE_ID constant, and a mismatched serviceId
  // makes _fetchDirectAccess 400. The server's SERVICE_ID must equal this too
  // (see server/config.js) or the minted token's audience is rejected 4002.
  const svc = (window.Usion && window.Usion.config && window.Usion.config.serviceId) || SERVICE_ID;
  const access = await window.Usion.game._fetchDirectAccess({ roomId, serviceId: svc, protocolVersion: '2' });
  if (!access || !access.ws_url || !access.access_token) {
    console.error('[FW] bad direct-access payload — is the service registered connection_mode:"direct"?', access);
    throw new Error('bad access payload');
  }
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
// No server: run the shared sim locally. One human drives BOTH heroes, switching
// the controlled one with the ⇄ button (the idle hero holds still — it can still
// stand on plates). This makes a solo/GameTok session actually completable.
// Promoted into a real 2-seat match by the host's Share button.
let soloActive = false, soloRAF = 0, soloChar = 'f', swapBound = false;
function bindSwap() {
  if (swapBound) return;
  const el = $('btnSwap'); if (!el) return;
  swapBound = true;
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (!soloActive) return;
    soloChar = soloChar === 'f' ? 'w' : 'f';
  });
  window.addEventListener('keydown', (e) => {
    if (!soloActive) return;
    if (e.key === 'Tab' || e.key === 's') { e.preventDefault(); soloChar = soloChar === 'f' ? 'w' : 'f'; }
  });
}
function startSoloPractice() {
  if (soloActive || netStarted) return;
  soloActive = true;
  soloChar = 'f';
  $('start').style.display = 'none';
  bindSwap();
  const swap = $('btnSwap'); if (swap) swap.hidden = false;
  const world = makeWorld(0);
  let last = performance.now(), acc = 0, intro = 1.4, pl = 0;
  function frame(now) {
    if (!soloActive) return;
    soloRAF = requestAnimationFrame(frame);
    let dt = (now - last) / 1000; last = now;
    if (dt > 0.25) { dt = 0; acc = 0; }
    acc += dt; if (acc > DT * 6) acc = DT;
    const drive = input.snapshot();
    const inputs = soloChar === 'f' ? { f: drive, w: {} } : { f: {}, w: drive };
    while (acc >= DT) { acc -= DT; stepServer(world, inputs, DT); }
    if (world.level !== pl) { pl = world.level; intro = 1.4; }
    intro = Math.max(0, intro - dt);
    renderer.draw(world, dt, {
      myKey: soloChar, remoteKey: soloChar === 'f' ? 'w' : 'f', myRenderPos: null,
      deaths: world.deaths, mapTime: world.mapTime, best: bestTimes[world.level],
      partnerHere: false, intro,
    });
  }
  soloRAF = requestAnimationFrame(frame);
}
function stopSoloPractice() {
  soloActive = false;
  if (soloRAF) cancelAnimationFrame(soloRAF); soloRAF = 0;
  const swap = $('btnSwap'); if (swap) swap.hidden = true;
}

boot();
