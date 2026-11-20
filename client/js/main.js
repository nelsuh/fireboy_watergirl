// Boot + game loop for «Дөл ба Дусал». Runs inside the Usion host (identity +
// rooms + direct-mode access from the SDK) and standalone (dev token). Fixed
// tick (60 Hz) drives input + prediction; rendering runs every animation frame.
//
// Two modes share one renderer, FX director and set of screens:
//   • SOLO (Explore / GameTok, `mode: 'single'`): the shared sim runs locally,
//     one person drives both heroes and switches with ⇄. Starts instantly at the
//     first unfinished level — zero taps.
//   • MULTIPLAYER (a chat invite, or a solo run promoted by the host's Share
//     button): authoritative server, waiting hall → level → result card → next.

import { SERVICE_ID, devServerUrl, devRoomId } from './config.js';
import { DT, TOTAL_LEVELS, PH_RESET } from '../shared/protocol.js';
import { Net } from './net.js';
import { Input } from './input.js';
import { Game } from './game.js';
import { Renderer } from './render.js';
import { Fx } from './fx.js';
import { makeWorld, stepServer, loadLevel } from '../shared/sim.js';
import { t, detectLang, applyLang } from './i18n.js';
import * as progress from './progress.js';
import * as ui from './ui.js';
import { bindUnlock, music, play } from './audio.js';

const $ = (id) => document.getElementById(id);
const rot = $('rot');
const canvas = $('board');
const renderer = new Renderer(rot, canvas);
const fx = new Fx(renderer);
const input = new Input();
const NO_INPUT = { left: false, right: false, jump: false };

const me = { userId: null, userName: '', avatar: '', embedded: false, roomId: null };
let mode = null;            // 'solo' | 'net'
let started = false;

progress.loadLocal();
bindUnlock();
music(true);

// Suppress the iOS double-tap / long-press selection magnifier (the "loupe") and
// pinch/double-tap zoom. CSS (user-select/touch-callout/touch-action:none) covers
// most of it, but Safari still fires the loupe on a fast double-tap unless the
// gesture is preventDefault-ed at the touch layer. Buttons use pointerdown, which
// fires before these, so gameplay taps are unaffected.
document.addEventListener('gesturestart', (e) => e.preventDefault(), { passive: false });
document.addEventListener('dblclick', (e) => e.preventDefault(), { passive: false });
document.addEventListener('contextmenu', (e) => e.preventDefault());
let _lastTapT = 0;
document.addEventListener('touchend', (e) => {
  const now = performance.now();
  if (now - _lastTapT < 350 && !(e.target && e.target.closest && e.target.closest('button'))) e.preventDefault();
  _lastTapT = now;
}, { passive: false });
document.addEventListener('touchmove', (e) => { if (e.touches && e.touches.length > 1) e.preventDefault(); }, { passive: false });

// ---------------------------------------------------------------- Usion boot --
function boot() {
  applyLang(detectLang());   // best-effort locale before the host is known
  const U = window.Usion;
  if (U && typeof U.init === 'function') {
    let done = false;
    const ready = (config) => {
      if (done) return; done = true;
      applyLang(detectLang(config && config.language)); // platform locale
      try {
        me.userId = (U.user && U.user.getId && U.user.getId()) || (config && config.userId) || null;
        me.userName = (U.user && U.user.getName && U.user.getName()) || (config && config.userName) || '';
        me.avatar = (U.user && U.user.getAvatar && U.user.getAvatar()) || (config && config.userAvatar) || '';
        me.embedded = (U._isEmbedded != null) ? !!U._isEmbedded : true;
        me.roomId = (U.config && U.config.roomId) || (config && config.roomId) || null;
        if (U.game && U.game.onRoomAssigned) {
          U.game.onRoomAssigned((info) => onRoomAssigned((info && info.roomId) || (U.config && U.config.roomId)));
        }
      } catch { /* fall through */ }
      progress.loadRemote();
      onReady();
    };
    U.init(ready);
    // Guard: never hang on a silent host. A plain browser tab (top-level, not the
    // Usion mobile WebView) has no host at all, so don't make it wait.
    const hosted = window.self !== window.top || !!window.ReactNativeWebView;
    setTimeout(() => ready(null), hosted ? 3000 : 250);
  } else {
    me.embedded = false;
    onReady();
  }
}

function onReady() {
  if (started) return;
  started = true;
  $('btnMenu').addEventListener('click', (e) => { e.preventDefault(); play('click'); openPauseMenu(); });
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Escape' || e.code === 'KeyP') {
      e.preventDefault();
      if (ui.anyOpen()) { if (!$('menuOverlay').hidden) ui.hide('menuOverlay'); }
      else openPauseMenu();
    }
  });
  connectAndPlay();
}

// Am I a real (invited) multiplayer session? Derive from the launch MODE, never
// from the presence of a roomId — GameTok forces mode:'single' but still hands us
// an auto `standalone_` room for SDK plumbing (see extra/gametok.md).
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

function connectAndPlay() {
  // Standalone/dev override: ?dev=1 forces a direct WS connect with a dev token
  // (server must run with DEV_ALLOW_UNSIGNED=1). Handy for local two-tab testing.
  if (/[?&]dev=1/.test(location.search)) { startNet(() => Promise.resolve(devUrl())); return; }
  if (me.embedded && launchedMultiplayer() && me.roomId) startNet(() => platformUrl(me.roomId));
  else {
    startSolo(progress.nextLevel());
    if (me.embedded && !me.roomId) ui.toast(t('practice'), 4200);
  }
}

async function platformUrl(roomId) {
  // Use the AUTHORITATIVE service id from the host (config.serviceId): the
  // platform assigns a hashed slug, and the server's SERVICE_ID must equal it or
  // the minted token's audience is rejected 4002.
  const svc = (window.Usion && window.Usion.config && window.Usion.config.serviceId) || SERVICE_ID;
  const access = await window.Usion.game._fetchDirectAccess({ roomId, serviceId: svc, protocolVersion: '2' });
  if (!access || !access.ws_url || !access.access_token) {
    console.error('[DD] bad direct-access payload — is the service registered connection_mode:"direct"?', access);
    throw new Error('bad access payload');
  }
  const sep = access.ws_url.indexOf('?') === -1 ? '?' : '&';
  return `${access.ws_url}${sep}token=${encodeURIComponent(access.access_token)}`;
}

function devUrl() {
  const room = devRoomId();
  const uid = String(me.userId || `guest-${Math.floor(Math.random() * 9999)}`).replace(/[^\w-]/g, '-');
  const base = devServerUrl();
  const sep = base.indexOf('?') === -1 ? '?' : '&';
  return `${base}${sep}token=${encodeURIComponent(`dev:${uid}:${room}`)}`;
}

function onRoomAssigned(roomId) {
  if (!roomId || mode === 'net') return;
  me.roomId = roomId;
  ui.hideAll();
  ui.toast(t('matchStarting'), 1600);
  startNet(() => platformUrl(roomId));
}

// ================================================================ main loop ==
let last = performance.now(), acc = 0, introT = 0, shownLevel = -1;

// Before the host answers, draw the level the player will most likely start on
// (still, no sim) so the first frames are the game, not a blank screen.
const bootWorld = makeWorld(progress.nextLevel());

function loop(now) {
  requestAnimationFrame(loop);
  let dt = (now - last) / 1000; last = now;
  if (dt > 0.25) { dt = 0; acc = 0; }
  if (mode === 'solo') soloFrame(dt);
  else if (mode === 'net') netFrame(dt);
  else drawWorld(bootWorld, dt, { myKey: 'f', remoteKey: 'w', myRenderPos: null, deaths: 0, mapTime: 0, partnerHere: true, solo: false });
}
requestAnimationFrame(loop);

function drawWorld(world, dt, status) {
  if (world.level !== shownLevel) { shownLevel = world.level; introT = 1.6; }
  introT = Math.max(0, introT - dt);
  status.intro = introT;
  renderer.draw(world, dt, status);
}

// One place that decides what the pause menu's buttons do in each mode.
function openPauseMenu() {
  if (ui.anyOpen()) return;
  ui.openMenu({
    onResume: () => {},
    onRestart: () => gotoLevel(currentLevel()),
    onLevels: () => openLevelSelect(),
  });
}
function openLevelSelect() {
  ui.openLevels(currentLevel(), (i) => gotoLevel(i), () => {});
}
function currentLevel() {
  if (mode === 'solo' && solo.world) return solo.world.level;
  if (mode === 'net' && net.game) return net.game.level;
  return 0;
}
function gotoLevel(i) {
  i = Math.max(0, Math.min(TOTAL_LEVELS - 1, i));
  if (mode === 'solo') soloGoto(i);
  else if (mode === 'net' && net.conn) net.conn.sendJson({ t: 'goto', level: i });
}

// ---- result card, progress and records (both modes) ----
function levelCleared(level, secs, deaths, world) {
  let got = 0, total = 0;
  for (const g of world.gems) { total++; if (g.taken) got++; }
  const res = progress.record(level, secs, got, total);
  fx.celebrate();
  submitStars();
  setTimeout(() => {
    ui.openClear({ level, secs, gemsGot: got, gemsTotal: total, deaths, ...res }, {
      onNext: () => gotoLevel(level >= TOTAL_LEVELS - 1 ? 0 : level + 1),
      onRetry: () => gotoLevel(level),
      onLevels: () => openLevelSelect(),
    });
    ui.showRecords(leaderboardAvailable(), loadBoard);
  }, 900);
}

function leaderboardAvailable() {
  const L = window.Usion && window.Usion.leaderboard;
  return !!(me.embedded && L && typeof L.top === 'function');
}
let submitP = Promise.resolve();
function submitStars() {
  if (!leaderboardAvailable()) return;
  const stars = progress.totalStars();
  submitP = Promise.resolve()
    .then(() => window.Usion.leaderboard.submit(stars, { levels: progress.highestUnlocked() + 1 }))
    .catch((e) => console.warn('[DD] leaderboard submit failed', e));
}
async function loadBoard(tab) {
  await submitP;                     // boards must include the score just earned
  const L = window.Usion.leaderboard;
  const rows = tab === 'friends' ? await L.friends({ limit: 20 }) : await L.top({ limit: 10 });
  return Array.isArray(rows) ? rows : (rows && (rows.entries || rows.items)) || [];
}

// ================================================================ solo mode ==
// No server: run the shared sim locally. One human drives BOTH heroes, switching
// the controlled one with ⇄ (the idle hero holds still — it can still stand on a
// plate). Promoted into a real 2-seat match by the host's Share button.
const solo = { world: null, char: 'f', swapBound: false, clearedAt: 0 };

function startSolo(level) {
  if (mode === 'net') stopNet();
  mode = 'solo';
  solo.char = 'f';
  solo.world = makeWorld(level);
  solo.world.ended = false;
  bindSwap();
  const swap = $('btnSwap'); swap.hidden = false; swap.dataset.hero = 'f';
  $('status').textContent = '';
  shownLevel = -1;
  window.__dd = { mode: 'solo', solo, renderer, gotoLevel };   // test/debug handle
}

function soloGoto(i) {
  ui.hideAll();
  loadLevel(solo.world, i);
  solo.world.ended = false;
  solo.world.deaths = 0;
  solo.char = 'f'; $('btnSwap').dataset.hero = 'f';
  shownLevel = -1;
}

function swapHero() {
  if (mode !== 'solo' || ui.blocking()) return;
  solo.char = solo.char === 'f' ? 'w' : 'f';
  $('btnSwap').dataset.hero = solo.char;
  play('click');
}
function bindSwap() {
  if (solo.swapBound) return;
  solo.swapBound = true;
  $('btnSwap').addEventListener('pointerdown', (e) => { e.preventDefault(); swapHero(); });
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Tab' || e.code === 'KeyS' || e.code === 'ShiftLeft' || e.code === 'ShiftRight') { e.preventDefault(); swapHero(); }
  });
}

function soloFrame(dt) {
  const world = solo.world;
  const paused = ui.blocking();
  if (!paused && !world.ended) {
    acc += dt; if (acc > DT * 6) acc = DT;
    const drive = input.snapshot();
    const inputs = solo.char === 'f' ? { f: drive, w: NO_INPUT } : { f: NO_INPUT, w: drive };
    while (acc >= DT) {
      acc -= DT;
      const { completed } = stepServer(world, inputs, DT);
      if (completed) {
        world.ended = true;
        levelCleared(world.level, Math.round(world.mapTime * 100) / 100, world.deaths, world);
        break;
      }
    }
  } else acc = 0;
  fx.update(world, {});
  drawWorld(world, dt, {
    myKey: solo.char, remoteKey: solo.char === 'f' ? 'w' : 'f', myRenderPos: null,
    deaths: world.deaths, mapTime: world.mapTime, partnerHere: true, solo: true,
  });
}

// ========================================================= multiplayer mode ==
const net = { conn: null, game: null, pingTimer: 0, hallDismissed: false };

function startNet(resolveUrl) {
  if (mode === 'net') return;
  mode = 'net';
  $('btnSwap').hidden = true;
  ui.hideAll();
  const game = net.game = new Game(null);
  net.hallDismissed = false;
  net.conn = new Net(resolveUrl, {
    name: me.userName || t('defaultName'),
    hello: () => ({ avatar: me.avatar || '', next: progress.nextLevel() }),
    onSnapshot: (s) => game.onSnapshot(s),
    onEvent: (m) => game.onEvent(m),
    onStatus: (s) => {
      const st = $('status');
      if (st) st.innerHTML = s === 'connected' ? '<span id="pingv"></span>' : `<span class="bad">${t('reconnecting')}</span>`;
      $('pauseOverlay').hidden = (s === 'connected');
    },
  });
  game.net = net.conn;
  window.__dd = { game, net: net.conn, input, renderer };
  clearInterval(net.pingTimer);
  net.pingTimer = setInterval(() => { const el = $('pingv'); if (el && net.conn) el.textContent = `${net.conn.rtt} ${t('ms')}`; }, 500);
}

function stopNet() {
  if (net.conn) net.conn.close();
  clearInterval(net.pingTimer);
  net.conn = null; net.game = null;
  $('pauseOverlay').hidden = true;
  $('status').textContent = '';
  if (mode === 'net') mode = null;
}

// leave the room and keep playing alone from the same level
function goSolo() {
  const lv = net.game ? net.game.level : progress.nextLevel();
  ui.hideAll();
  stopNet();
  startSolo(lv);
}

function netFrame(dt) {
  const game = net.game, conn = net.conn;
  acc += dt; if (acc > DT * 6) acc = DT;
  const inp = ui.blocking() && $('hallOverlay').hidden ? NO_INPUT : input.snapshot();
  while (acc >= DT) { acc -= DT; if (conn.connected) game.tick(game.lobby ? NO_INPUT : inp); }
  game.frame();
  handleNetEvents();
  const pos = {}; pos[game.myKey] = game.myRenderPos();
  fx.update(game.world, pos);
  const partnerHere = game.names.size >= 2;
  drawWorld(game.world, dt, {
    myKey: game.myKey, remoteKey: game.remoteKey, myRenderPos: game.myRenderPos(),
    deaths: game.deaths, mapTime: game.mapTime, partnerHere, solo: false,
  });
}

function refreshHall() {
  const game = net.game;
  if (!game || !game.ready) return;
  if (!game.lobby) { if (!$('hallOverlay').hidden) ui.hide('hallOverlay'); return; }
  ui.openHall(game.lobbyState || { players: [] }, game.myHero, {
    onReady: (on) => net.conn && net.conn.sendJson({ t: 'ready', on }),
    onInvite: () => { try { window.Usion.game.invite(); } catch { /* old SDK */ } },
    onSolo: goSolo,
  });
}

function handleNetEvents() {
  const game = net.game;
  for (const e of game.drainEvents()) {
    if (e.type === 'lobby') {
      refreshHall();
    } else if (e.type === 'goto') {
      ui.hideAll();
      shownLevel = -1;
    } else if (e.type === 'cleared') {
      levelCleared(e.level, e.secs, e.deaths, game.world);
    } else if (e.type === 'join') {
      if (e.hero !== game.myHero) {
        play('join');
        ui.toast(t('partnerJoined', e.name || t('defaultName')));
        ui.hide('leftOverlay');
      } else {
        ui.toast(t('youAre', game.myKey === 'f' ? t('heroF') : t('heroW')), 2200);
      }
    } else if (e.type === 'leave') {
      if (!game.lobby && !game.ended) ui.openLeft({ onWait: () => {}, onSolo: goSolo });
    } else if (e.type === 'error') {
      ui.toast(e.reason || 'error');
    }
  }
  // the welcome itself (no lobby message yet) also opens the hall
  if (game.ready && game.lobby && $('hallOverlay').hidden && !ui.anyOpen()) refreshHall();
}

boot();
