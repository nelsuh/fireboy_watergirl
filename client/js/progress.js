// Saved progress: per-level best stars / time. Durable through Usion.storage
// (database-backed, follows the player across devices) with localStorage as the
// offline cache and the standalone fallback. Also owns the leaderboard number:
// TOTAL STARS earned (higher is better, best kept by the platform).

import { TOTAL_LEVELS } from '../shared/protocol.js';
import { MAPS } from '../shared/maps.js';

const KEY = 'duldusal:progress:v1';

// levels[i] = { stars: 0..3, best: seconds|null, gems: bool, done: bool }
let data = { levels: [] };

function blank() { return { levels: [] }; }
function sane(d) {
  if (!d || typeof d !== 'object' || !Array.isArray(d.levels)) return blank();
  return { levels: d.levels.slice(0, 64).map((l) => (l && typeof l === 'object') ? {
    stars: Math.max(0, Math.min(3, l.stars | 0)),
    best: Number.isFinite(l.best) ? l.best : null,
    gems: !!l.gems, done: !!l.done,
  } : null) };
}

// Merge two progress records, keeping the best of each level (a phone that was
// offline must never wipe stars earned elsewhere).
function merge(a, b) {
  const out = blank();
  const n = Math.max(a.levels.length, b.levels.length);
  for (let i = 0; i < n; i++) {
    const x = a.levels[i], y = b.levels[i];
    if (!x && !y) { out.levels[i] = null; continue; }
    if (!x || !y) { out.levels[i] = { ...(x || y) }; continue; }
    const bests = [x.best, y.best].filter((v) => v != null);
    out.levels[i] = {
      stars: Math.max(x.stars, y.stars),
      best: bests.length ? Math.min(...bests) : null,
      gems: x.gems || y.gems, done: x.done || y.done,
    };
  }
  return out;
}

function saveLocal() { try { localStorage.setItem(KEY, JSON.stringify(data)); } catch { /* private mode */ } }
function saveRemote() {
  try {
    const S = window.Usion && window.Usion.storage;
    if (S && typeof S.set === 'function') Promise.resolve(S.set(KEY, data)).catch(() => {});
  } catch { /* no SDK */ }
}

export function loadLocal() {
  try { data = sane(JSON.parse(localStorage.getItem(KEY) || 'null')); } catch { data = blank(); }
}

// Call after Usion.init: pull the durable copy and merge it in.
export async function loadRemote() {
  try {
    const S = window.Usion && window.Usion.storage;
    if (!S || typeof S.get !== 'function') return;
    const remote = await Promise.race([S.get(KEY), new Promise((r) => setTimeout(() => r(null), 2500))]);
    if (remote) { data = merge(data, sane(typeof remote === 'string' ? JSON.parse(remote) : remote)); saveLocal(); }
  } catch { /* keep local */ }
}

export function level(i) { return data.levels[i] || { stars: 0, best: null, gems: false, done: false }; }
export function isUnlocked(i) { return i === 0 || level(i - 1).done || level(i).done; }
export function totalStars() { return data.levels.reduce((a, l) => a + (l ? l.stars : 0), 0); }
export function maxStars() { return TOTAL_LEVELS * 3; }

// First level not finished yet (resume point); the last level once all are done.
export function nextLevel() {
  for (let i = 0; i < TOTAL_LEVELS; i++) if (!level(i).done) return i;
  return TOTAL_LEVELS - 1;
}
export function highestUnlocked() {
  let h = 0;
  for (let i = 0; i < TOTAL_LEVELS; i++) if (isUnlocked(i)) h = i;
  return h;
}

// Stars for a finished run: 1 for reaching the doors, +1 all gems, +1 par time.
export function rate(i, secs, gemsGot, gemsTotal) {
  const par = (MAPS[i] && MAPS[i].par) || 60;
  const allGems = gemsTotal === 0 || gemsGot >= gemsTotal;
  const fast = secs <= par;
  return { stars: 1 + (allGems ? 1 : 0) + (fast ? 1 : 0), allGems, fast, par };
}

// Record a cleared level. Returns { stars, allGems, fast, par, newBest, prev }.
export function record(i, secs, gemsGot, gemsTotal) {
  const r = rate(i, secs, gemsGot, gemsTotal);
  const prev = level(i);
  const newBest = prev.best == null || secs < prev.best;
  data.levels[i] = {
    stars: Math.max(prev.stars, r.stars),
    best: newBest ? secs : prev.best,
    gems: prev.gems || r.allGems,
    done: true,
  };
  saveLocal(); saveRemote();
  return { ...r, newBest, prev };
}
