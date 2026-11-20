// DOM screens: pause menu, level select, level-cleared card (with Friends /
// Global records), waiting hall, partner-left prompt, toasts. Pure view helpers
// — main.js owns the game flow and passes callbacks in.

import { t, nameOf } from './i18n.js';
import { MAPS } from '../shared/maps.js';
import { TOTAL_LEVELS } from '../shared/protocol.js';
import * as progress from './progress.js';
import { play, duck } from './audio.js';

const $ = (id) => document.getElementById(id);
const OVERLAYS = ['menuOverlay', 'levelsOverlay', 'clearOverlay', 'hallOverlay', 'leftOverlay'];

export const fmt = (s) => { s = Math.floor(s || 0); return Math.floor(s / 60) + ':' + (s % 60 < 10 ? '0' : '') + (s % 60); };

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// Wire a button once; the handler is swapped per call through `el._h`.
function on(id, fn) {
  const el = $(id); if (!el) return;
  el._h = fn;
  if (!el._wired) {
    el._wired = true;
    el.addEventListener('click', (e) => { e.preventDefault(); play('click'); if (el._h) el._h(e); });
  }
}

export function anyOpen() { return OVERLAYS.some((id) => !$(id).hidden); }
// Overlays that should freeze a solo run / mute your inputs.
export function blocking() { return anyOpen(); }
function refreshDuck() { duck(anyOpen()); }

export function hide(id) { $(id).hidden = true; refreshDuck(); }
export function hideAll() { for (const id of OVERLAYS) $(id).hidden = true; refreshDuck(); }
function show(id) { $(id).hidden = false; refreshDuck(); }

let toastTimer = 0;
export function toast(text, ms = 2400) {
  const el = $('toast'); if (!el) return;
  el.textContent = text; el.hidden = false;
  el.style.animation = 'none'; void el.offsetWidth; el.style.animation = '';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

// ---------------------------------------------------------------- pause menu --
export function openMenu({ onResume, onRestart, onLevels }) {
  on('mResume', () => { hide('menuOverlay'); onResume && onResume(); });
  on('mRestart', () => { hide('menuOverlay'); onRestart(); });
  on('mLevels', () => { hide('menuOverlay'); onLevels(); });
  show('menuOverlay');
}

// -------------------------------------------------------------- level select --
export function openLevels(current, onPick, onClose) {
  const grid = $('levelGrid');
  grid.innerHTML = '';
  $('starsTotal').textContent = '★ ' + t('starsTotal', progress.totalStars(), progress.maxStars());
  for (let i = 0; i < TOTAL_LEVELS; i++) {
    const L = progress.level(i), unlocked = progress.isUnlocked(i);
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'lv' + (unlocked ? '' : ' locked') + (i === current ? ' cur' : '');
    b.setAttribute('aria-label', unlocked ? `${i + 1}. ${nameOf(MAPS[i].name)}` : t('locked'));
    const stars = [0, 1, 2].map((k) => (k < L.stars ? '<b>★</b>' : '★')).join('');
    b.innerHTML = unlocked
      ? `<span class="n">${i + 1}</span><span class="st">${stars}</span><span class="nm">${esc(nameOf(MAPS[i].name))}</span>`
      : `<span class="n">🔒</span><span class="nm">${i + 1}</span>`;
    b.addEventListener('click', () => {
      play('click');
      if (!unlocked) { toast(t('lockedToast')); return; }
      hide('levelsOverlay'); onPick(i);
    });
    grid.appendChild(b);
  }
  on('levelsClose', () => { hide('levelsOverlay'); onClose && onClose(); });
  show('levelsOverlay');
}

// ------------------------------------------------------------- level cleared --
// res: { level, secs, gemsGot, gemsTotal, deaths, stars, allGems, fast, par, newBest }
export function openClear(res, { onNext, onRetry, onLevels }) {
  const last = res.level >= TOTAL_LEVELS - 1;
  $('clearTitle').textContent = last ? t('allCleared') : t('cleared');
  $('clearName').textContent = `${res.level + 1}. ${nameOf(MAPS[res.level].name)}`;
  const reasons = [
    [true, t('starDone')],
    [res.allGems, t('starGems', res.gemsGot, res.gemsTotal)],
    [res.fast, t('starTime', fmt(res.par))],
  ];
  $('starReasons').innerHTML = reasons.map(([ok, s]) => `<li class="${ok ? 'ok' : ''}">${esc(s)}</li>`).join('');
  $('clearStats').innerHTML =
    `<div>${esc(t('time'))}<b>${fmt(res.secs)}</b>${res.newBest ? `<span class="best">${esc(t('newBest'))}</span>` : ''}</div>` +
    `<div>${esc(t('gems'))}<b>${res.gemsGot}/${res.gemsTotal}</b></div>` +
    `<div>${esc(t('falls'))}<b>${res.deaths}</b></div>`;
  const stars = $('bigStars').children;
  for (let i = 0; i < 3; i++) stars[i].className = 'bs';
  // stars pop in one by one, each with its own chime
  for (let i = 0; i < res.stars; i++) {
    setTimeout(() => { stars[i].className = 'bs on'; play('star', { i }); }, 350 + i * 320);
  }
  $('cNext').textContent = last ? t('playAgain') : t('next');
  on('cNext', () => { hide('clearOverlay'); onNext(); });
  on('cRetry', () => { hide('clearOverlay'); onRetry(); });
  on('cLevels', () => { hide('clearOverlay'); onLevels(); });
  show('clearOverlay');
}

// Records panel (Friends / Global). `boards` is a promise-returning loader map.
export function showRecords(enabled, load) {
  const box = $('records');
  if (!enabled) { box.hidden = true; return; }
  box.hidden = false;
  let tab = 'friends';
  const render = async () => {
    $('tabFriends').classList.toggle('on', tab === 'friends');
    $('tabGlobal').classList.toggle('on', tab === 'global');
    const list = $('recList');
    list.innerHTML = `<div class="rec-msg">${esc(t('loading'))}</div>`;
    const want = tab;
    try {
      const rows = await load(tab);
      if (want !== tab) return;
      list.innerHTML = '';
      if (!rows || !rows.length) {
        list.innerHTML = `<div class="rec-msg">${esc(tab === 'friends' ? t('noFriends') : '—')}</div>`;
        return;
      }
      for (const e of rows) list.appendChild(recordRow(e));
    } catch {
      if (want !== tab) return;
      list.innerHTML = `<div class="rec-msg">${esc(t('recordsError'))}<br><button class="btn" type="button">${esc(t('tryAgain'))}</button></div>`;
      list.querySelector('button').addEventListener('click', render);
    }
  };
  on('tabFriends', () => { tab = 'friends'; render(); });
  on('tabGlobal', () => { tab = 'global'; render(); });
  render();
}

function recordRow(e) {
  const row = document.createElement(e.is_me ? 'div' : 'button');
  row.className = 'rec' + (e.is_me ? ' me' : '');
  const av = e.avatar && /^https?:\/\//.test(e.avatar) ? ` style="background-image:url('${esc(e.avatar)}')"` : '';
  row.innerHTML = `<span class="rk">${esc(e.rank)}</span><span class="av"${av}></span><span class="nm">${esc(e.name || '—')}</span><span class="sc">★ ${esc(e.score)}</span>`;
  if (!e.is_me) {
    row.type = 'button';
    row.setAttribute('aria-label', e.name || '');
    row.addEventListener('click', () => { try { window.Usion.user.openProfile(e.user_id); } catch { /* old SDK */ } });
  }
  return row;
}

// --------------------------------------------------------------- waiting hall --
// state: { players:[{hero,name,avatar,ready}] }, myHero
export function openHall(state, myHero, { onReady, onInvite, onSolo }) {
  const players = (state && state.players) || [];
  for (const seat of [0, 1]) {
    const el = $('seat' + seat);
    const p = players.find((q) => q.hero === seat);
    const heroName = seat === 0 ? t('heroF') : t('heroW');
    el.classList.toggle('empty', !p);
    // no profile photo → show the hero this seat plays
    const heroImg = `assets/${seat === 0 ? 'hero-dul' : 'hero-dusal'}.webp`;
    const av = p && p.avatar ? ` style="background-image:url('${esc(p.avatar)}')"` : ` style="background-image:url('${heroImg}');background-size:70%;background-position:center 60%"`;
    el.innerHTML = p
      ? `<span class="hero">${esc(heroName)}</span><span class="av"${av}></span><span class="nm">${esc(p.name)}${seat === myHero ? ` (${esc(t('you'))})` : ''}</span><span class="rd ${p.ready ? 'on' : ''}">${esc(p.ready ? t('ready') : t('notReady'))}</span>`
      : `<span class="hero">${esc(heroName)}</span><span class="av"${av}></span><span class="nm">${esc(t('emptySeat'))}</span>`;
  }
  const mine = players.find((q) => q.hero === myHero);
  const ready = !!(mine && mine.ready);
  $('hReady').textContent = ready ? t('cancelReady') : t('imReady');
  $('hReady').classList.toggle('btn-primary', !ready);
  on('hReady', () => onReady(!ready));
  const canInvite = !!(window.Usion && window.Usion.game && typeof window.Usion.game.invite === 'function');
  $('hInvite').hidden = !canInvite || players.length >= 2;
  on('hInvite', onInvite);
  on('hSolo', onSolo);
  if ($('hallOverlay').hidden) show('hallOverlay');
}

// ------------------------------------------------------------- partner left --
export function openLeft({ onWait, onSolo }) {
  on('lWait', () => { hide('leftOverlay'); onWait && onWait(); });
  on('lSolo', () => { hide('leftOverlay'); onSolo(); });
  show('leftOverlay');
}
