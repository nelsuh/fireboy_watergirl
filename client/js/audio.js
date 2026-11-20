// Procedural audio: every sound effect and the music are synthesized with
// WebAudio at runtime — no files to load, nothing to license. Sound follows the
// phone's own volume / silent switch (Usion rule: games draw no mute button).
//
// The music is a slow loop in the anhemitonic pentatonic scale of Mongolian folk
// music: a bowed two-string drone (fifth, gentle vibrato), a plucked zither-like
// melody, and a soft galloping hand-drum. It is generated from a fixed seed, so
// every session hears the same tune.

let ctx = null, master = null, sfxBus = null, musicBus = null;
let unlocked = false, musicOn = false, musicTimer = 0, nextBarAt = 0, bar = 0;
let noiseBuf = null;

// Automated tests must be silent: `?mute=1` or window.__DD_MUTE silences everything.
function testMuted() { try { return !!window.__DD_MUTE || /[?&]mute=1/.test(location.search); } catch { return false; } }

function ensure() {
  if (ctx) return ctx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  ctx = new AC();
  master = ctx.createGain(); master.gain.value = testMuted() ? 0 : 0.9; master.connect(ctx.destination);
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -14; comp.ratio.value = 4; comp.connect(master);
  sfxBus = ctx.createGain(); sfxBus.gain.value = 0.55; sfxBus.connect(comp);
  musicBus = ctx.createGain(); musicBus.gain.value = 0.0; musicBus.connect(comp);
  noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 1.5, ctx.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return ctx;
}

// Browsers start audio only from a user gesture: the first touch/key unlocks it.
export function bindUnlock() {
  const go = () => {
    if (!ensure()) return;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    if (!unlocked) { unlocked = true; if (musicOn) startMusicLoop(); }
  };
  for (const ev of ['pointerdown', 'keydown', 'touchend']) window.addEventListener(ev, go, { capture: true, passive: true });
  // A backgrounded WebView keeps the context running on some phones — pause it.
  document.addEventListener('visibilitychange', () => {
    if (!ctx) return;
    if (document.hidden) ctx.suspend().catch(() => {});
    else if (unlocked) ctx.resume().catch(() => {});
  });
}

const now = () => ctx.currentTime;

function env(g, t0, a, peak, d, end = 0.0001) {
  g.gain.cancelScheduledValues(t0);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(peak, t0 + a);
  g.gain.exponentialRampToValueAtTime(end, t0 + a + d);
}

function tone(type, f0, f1, t0, dur, peak, bus = sfxBus, attack = 0.005) {
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(f0, t0);
  if (f1 && f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t0 + dur);
  env(g, t0, attack, peak, dur);
  o.connect(g); g.connect(bus);
  o.start(t0); o.stop(t0 + attack + dur + 0.05);
  return o;
}

function noise(t0, dur, peak, filterType, f0, f1, q = 1, bus = sfxBus) {
  const s = ctx.createBufferSource(); s.buffer = noiseBuf;
  const f = ctx.createBiquadFilter(); f.type = filterType; f.Q.value = q;
  f.frequency.setValueAtTime(f0, t0);
  if (f1) f.frequency.exponentialRampToValueAtTime(f1, t0 + dur);
  const g = ctx.createGain(); env(g, t0, 0.004, peak, dur);
  s.connect(f); f.connect(g); g.connect(bus);
  s.start(t0, Math.random() * 0.5); s.stop(t0 + dur + 0.05);
}

// Rate-limit identical sounds (a pile of gems or a jittery plate must not stack).
const lastAt = {};
function gate(key, gap) {
  const t = performance.now();
  if (lastAt[key] && t - lastAt[key] < gap) return false;
  lastAt[key] = t; return true;
}

// ---------------------------------------------------------------- effects --
export function play(name, opt = {}) {
  if (!unlocked || !ctx || ctx.state !== 'running') return;
  const t0 = now();
  const fire = opt.hero === 'f';
  switch (name) {
    case 'jump':
      if (!gate('jump' + opt.hero, 60)) return;
      if (fire) { noise(t0, 0.16, 0.22, 'bandpass', 900, 2600, 1.2); tone('triangle', 330, 520, t0, 0.12, 0.12); }
      else { tone('sine', 420, 760, t0, 0.13, 0.2); tone('sine', 640, 980, t0 + 0.03, 0.08, 0.08); }
      break;
    case 'land':
      if (!gate('land' + opt.hero, 90)) return;
      noise(t0, 0.07, 0.16 * (opt.k || 1), 'lowpass', 500, 120, 0.7);
      tone('sine', 140, 70, t0, 0.07, 0.12 * (opt.k || 1));
      break;
    case 'gem': {
      if (!gate('gem', 45)) return;
      const base = fire ? 659.25 : 783.99;          // E5 / G5 (pentatonic)
      tone('triangle', base, base, t0, 0.18, 0.2);
      tone('triangle', base * 1.5, base * 1.5, t0 + 0.07, 0.28, 0.16);
      tone('sine', base * 3, base * 3, t0 + 0.07, 0.2, 0.05);
      break;
    }
    case 'lever':
      tone('square', 180, 120, t0, 0.06, 0.08);
      noise(t0, 0.05, 0.2, 'bandpass', 1800, 900, 2);
      tone('triangle', opt.on ? 520 : 390, opt.on ? 780 : 260, t0 + 0.05, 0.12, 0.1);
      break;
    case 'plate':
      if (!gate('plate', 80)) return;
      tone('square', opt.on ? 240 : 200, opt.on ? 160 : 260, t0, 0.05, 0.07);
      noise(t0, 0.04, 0.12, 'highpass', 2500, 0, 1);
      break;
    case 'gate':
      if (!gate('gate', 400)) return;
      noise(t0, 0.55, 0.16, 'lowpass', 260, 90, 4);
      tone('sawtooth', 55, 48, t0, 0.5, 0.05, sfxBus, 0.05);
      break;
    case 'lift':
      if (!gate('lift', 500)) return;
      tone('sine', 98, 110, t0, 0.35, 0.08, sfxBus, 0.04);
      break;
    case 'death':
      if (opt.by === 'G') { tone('sine', 220, 60, t0, 0.5, 0.25); noise(t0, 0.4, 0.15, 'lowpass', 600, 100, 6); }
      else if (fire) { noise(t0, 0.7, 0.3, 'highpass', 3000, 1200, 0.8); tone('sine', 300, 90, t0, 0.3, 0.12); } // fire in water: steam hiss
      else { noise(t0, 0.5, 0.28, 'bandpass', 4000, 1500, 0.6); tone('triangle', 500, 120, t0, 0.35, 0.12); }   // water in fire: sizzle
      break;
    case 'door':
      tone('sine', fire ? 523.25 : 587.33, 0, t0, 0.35, 0.12);
      tone('sine', fire ? 784 : 880, 0, t0 + 0.08, 0.4, 0.08);
      break;
    case 'clear': {
      const seq = [523.25, 587.33, 659.25, 783.99, 880, 1046.5];
      seq.forEach((f, i) => { tone('triangle', f, f, t0 + i * 0.09, 0.35, 0.16); tone('sine', f * 2, f * 2, t0 + i * 0.09, 0.2, 0.04); });
      tone('sine', 261.63, 261.63, t0, 1.2, 0.12, sfxBus, 0.03);
      break;
    }
    case 'star': {
      const f = [783.99, 987.77, 1174.66][opt.i || 0];
      tone('triangle', f, f, t0, 0.3, 0.2); tone('sine', f * 2, f * 2, t0 + 0.02, 0.25, 0.06);
      break;
    }
    case 'click':
      tone('triangle', 660, 520, t0, 0.05, 0.08);
      break;
    case 'join':
      tone('triangle', 440, 440, t0, 0.15, 0.12); tone('triangle', 660, 660, t0 + 0.1, 0.25, 0.12);
      break;
  }
}

// ------------------------------------------------------------------ music --
// D major pentatonic (D E F# A B) — the "anhemitonic" scale of the steppe.
const SCALE = [146.83, 164.81, 185.0, 220.0, 246.94];
const BEAT = 0.42;                      // seconds per beat (~143 bpm gallop at 3/beat)
const BAR = BEAT * 4;
function note(deg) { const o = Math.floor(deg / 5), i = ((deg % 5) + 5) % 5; return SCALE[i] * Math.pow(2, o); }

// Fixed-seed PRNG → the same melody every session.
function mulberry(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const PHRASES = (() => {
  const r = mulberry(1206);
  const out = [];
  for (let p = 0; p < 4; p++) {
    const notes = []; let d = 7 + Math.floor(r() * 3);
    for (let i = 0; i < 8; i++) {
      d += Math.round((r() - 0.5) * 3);
      d = Math.max(5, Math.min(12, d));
      notes.push(r() < 0.18 ? null : d);
    }
    notes[7] = p % 2 ? 5 : 7;            // phrases resolve home
    out.push(notes);
  }
  return out;
})();
const ROOTS = [0, 0, 3, 4];             // drone root per 4-bar line (D D A B)

function pluck(f, t0, peak) {
  const o = ctx.createOscillator(), o2 = ctx.createOscillator(), g = ctx.createGain(), lp = ctx.createBiquadFilter();
  o.type = 'triangle'; o2.type = 'sawtooth';
  o.frequency.value = f; o2.frequency.value = f * 2.002;
  lp.type = 'lowpass'; lp.frequency.setValueAtTime(f * 8, t0); lp.frequency.exponentialRampToValueAtTime(f * 1.5, t0 + 0.6);
  const g2 = ctx.createGain(); g2.gain.value = 0.18;
  env(g, t0, 0.004, peak, 0.9);
  o.connect(g); o2.connect(g2); g2.connect(g); g.connect(lp); lp.connect(musicBus);
  o.start(t0); o2.start(t0); o.stop(t0 + 1); o2.stop(t0 + 1);
}

function drone(f, t0, dur) {
  for (const [mult, peak] of [[1, 0.07], [1.5, 0.035], [0.5, 0.05]]) {
    const o = ctx.createOscillator(), g = ctx.createGain(), lp = ctx.createBiquadFilter(), lfo = ctx.createOscillator(), lg = ctx.createGain();
    o.type = 'sawtooth'; o.frequency.value = f * mult;
    lfo.frequency.value = 4.6; lg.gain.value = f * mult * 0.006; lfo.connect(lg); lg.connect(o.frequency);
    lp.type = 'lowpass'; lp.frequency.value = 700; lp.Q.value = 0.5;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + 0.6);
    g.gain.setValueAtTime(peak, t0 + dur - 0.5);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur + 0.2);
    o.connect(lp); lp.connect(g); g.connect(musicBus);
    o.start(t0); lfo.start(t0); o.stop(t0 + dur + 0.3); lfo.stop(t0 + dur + 0.3);
  }
}

function drum(t0, peak) {
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = 'sine'; o.frequency.setValueAtTime(120, t0); o.frequency.exponentialRampToValueAtTime(55, t0 + 0.12);
  env(g, t0, 0.003, peak, 0.14);
  o.connect(g); g.connect(musicBus); o.start(t0); o.stop(t0 + 0.2);
  noise(t0, 0.03, peak * 0.4, 'bandpass', 1800, 0, 1.5, musicBus);
}

function scheduleBar(t0) {
  const line = Math.floor(bar / 4) % 4, inLine = bar % 4;
  if (inLine === 0) drone(SCALE[ROOTS[line]] / 2, t0, BAR * 4);
  const phrase = PHRASES[(Math.floor(bar / 2)) % PHRASES.length];
  const half = (bar % 2) * 4;
  for (let i = 0; i < 4; i++) {
    const d = phrase[half + i];
    if (d != null) pluck(note(d), t0 + i * BEAT, 0.09);
    if (i % 2 === 1 && d != null && (bar % 4) > 1) pluck(note(d + 2), t0 + i * BEAT + BEAT / 2, 0.04);
  }
  // galloping hand drum: da-da-DUM on each beat, quiet in the first line
  const k = line === 0 ? 0.5 : 1;
  for (let i = 0; i < 4; i++) {
    const b = t0 + i * BEAT;
    drum(b, 0.05 * k); drum(b + BEAT / 3, 0.035 * k); drum(b + (BEAT * 2) / 3, 0.07 * k);
  }
  bar++;
}

function startMusicLoop() {
  if (!ctx || musicTimer) return;
  musicBus.gain.cancelScheduledValues(now());
  musicBus.gain.setTargetAtTime(0.5, now(), 1.2);
  nextBarAt = Math.max(nextBarAt, now() + 0.1);
  const pump = () => {
    // schedule ~1.5 s ahead; setInterval keeps running even when rAF is throttled
    while (nextBarAt < now() + 1.5) { scheduleBar(nextBarAt); nextBarAt += BAR; }
  };
  pump();
  musicTimer = setInterval(pump, 300);
}

export function music(on) {
  musicOn = on;
  if (!ctx || !unlocked) return;
  if (on) startMusicLoop();
  else if (musicTimer) {
    clearInterval(musicTimer); musicTimer = 0;
    musicBus.gain.setTargetAtTime(0.0001, now(), 0.3);
  }
}

// Soften the music under menus / result cards.
export function duck(on) {
  if (!ctx || !musicBus || !musicTimer) return;
  musicBus.gain.setTargetAtTime(on ? 0.18 : 0.5, now(), 0.25);
}
