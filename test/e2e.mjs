// node test/e2e.mjs — drives the real client in headless Chrome over the
// DevTools protocol against the real server (DEV_ALLOW_UNSIGNED=1):
//   • solo: boots straight into play (landscape + rotated portrait), moves,
//     dies in the wrong liquid, clears a level → result card, level select, menu
//   • multiplayer: two tabs in one room → waiting hall → both ready → play →
//     either player picks a level and both follow.
// Silent: Chrome runs with --mute-audio and the page with ?mute=1.
// Screenshots land in $E2E_OUT (default: OS temp/dd-e2e).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.env.E2E_OUT || path.join(os.tmpdir(), 'dd-e2e');
fs.mkdirSync(OUT, { recursive: true });
const CHROME = process.env.CHROME || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find((p) => fs.existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = 8000 + Math.floor(Math.random() * 900);
const DBG = 9300 + Math.floor(Math.random() * 500);

let browserWs = null, browserN = 0;
async function browserCall(method, params) {
  if (!browserWs) {
    const v = await (await fetch(`http://127.0.0.1:${DBG}/json/version`)).json();
    browserWs = new WebSocket(v.webSocketDebuggerUrl);
    await new Promise((res, rej) => { browserWs.onopen = res; browserWs.onerror = rej; });
  }
  const id = ++browserN;
  return new Promise((res, rej) => {
    const h = (ev) => { const m = JSON.parse(ev.data); if (m.id !== id) return; browserWs.removeEventListener('message', h); m.error ? rej(new Error(m.error.message)) : res(m.result); };
    browserWs.addEventListener('message', h);
    browserWs.send(JSON.stringify({ id, method, params }));
  });
}

class Page {
  static async open(label, w = 844, h = 390) {
    // Each page gets its own WINDOW: a background tab in headless Chrome never runs
    // requestAnimationFrame, and both multiplayer clients must keep rendering.
    const { targetId } = await browserCall('Target.createTarget', { url: 'about:blank', newWindow: true });
    const list = await (await fetch(`http://127.0.0.1:${DBG}/json/list`)).json();
    const target = list.find((t) => t.id === targetId);
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const p = new Page(ws, label);
    await p.send('Page.enable');
    await p.send('Runtime.enable');
    await p.send('Network.enable');
    // no host SDK: the page takes its standalone path immediately
    await p.send('Network.setBlockedURLs', { urls: ['*usion-sdk.js'] });
    await p.size(w, h);
    return p;
  }
  constructor(ws, label) {
    this.ws = ws; this.label = label; this.n = 0; this.pending = new Map(); this.errors = [];
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { res, rej } = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) rej(new Error(m.error.message)); else res(m.result);
      } else if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails;
        this.errors.push((d.exception && d.exception.description) || d.text);
      } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
        this.errors.push(m.params.args.map((a) => a.value || a.description).join(' '));
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.n;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => this.pending.set(id, { res, rej }));
  }
  size(w, h) { return this.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: true }); }
  async go(url) { await this.send('Page.navigate', { url }); await sleep(400); }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`[${this.label}] eval failed: ${(r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text}`);
    return r.result.value;
  }
  async waitFor(expr, ms = 8000) {
    const end = Date.now() + ms;
    for (;;) {
      try { if (await this.eval(`!!(${expr})`)) return; } catch { /* mid-navigation */ }
      if (Date.now() > end) throw new Error(`[${this.label}] timed out waiting for: ${expr}`);
      await sleep(100);
    }
  }
  front() { return this.send('Page.bringToFront'); }
  key(type, code) { return this.eval(`window.dispatchEvent(new KeyboardEvent('${type}', { code: '${code}', bubbles: true }))`); }
  async hold(code, ms) { await this.front(); await this.key('keydown', code); await sleep(ms); await this.key('keyup', code); }
  click(sel) { return this.eval(`(() => { const b = document.querySelector(${JSON.stringify(sel)}); if (!b) throw new Error('no ' + ${JSON.stringify(sel)}); b.click(); })()`); }
  visible(id) { return this.eval(`!document.getElementById('${id}').hidden`); }
  async shot(name) {
    await this.front();
    await sleep(500);
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(r.data, 'base64'));
  }
}

// Which overlays overflow their card / the screen at this size?
const FITS = `(() => {
  const bad = [];
  for (const c of document.querySelectorAll('.overlay:not([hidden]) .card')) {
    const r = c.getBoundingClientRect();
    if (r.top < -1 || r.left < -1 || r.bottom > innerHeight + 1 || r.right > innerWidth + 1) bad.push('card off-screen');
    if (c.scrollHeight > c.clientHeight + 2) bad.push('card scrolls ' + c.scrollHeight + '>' + c.clientHeight);
  }
  return bad;
})()`;

async function solo(base) {
  const p = await Page.open('solo');
  await p.go(`${base}/?mute=1&lang=en`);
  await p.front();
  await p.waitFor(`window.__dd && window.__dd.mode === 'solo'`);
  await sleep(2800);   // splash fades
  await p.shot('solo-1-start-landscape');

  // fresh profile starts on level 1 with both heroes alive
  assert.equal(await p.eval(`__dd.solo.world.level`), 0, 'fresh player starts at level 1');
  const x0 = await p.eval(`__dd.solo.world.heroes.f.x`);
  await p.hold('ArrowRight', 500);
  const x1 = await p.eval(`__dd.solo.world.heroes.f.x`);
  assert.ok(x1 > x0 + 40, `Дөл runs right (${x0} → ${x1})`);
  await p.hold('ArrowUp', 120); await sleep(600);

  // swap to Дусал; the idle hero stays put
  await p.key('keydown', 'KeyS'); await p.key('keyup', 'KeyS');
  assert.equal(await p.eval(`__dd.solo.char`), 'w', 'swap to Дусал');
  const fx = await p.eval(`__dd.solo.world.heroes.f.x`);
  await p.hold('ArrowRight', 300);
  assert.equal(await p.eval(`__dd.solo.world.heroes.f.x`), fx, 'idle hero holds still');

  // death: drop Дөл into water → death counted, level resets
  await p.eval(`(() => { const w = __dd.solo.world; const q = w.liquids.find((l) => l.kind === 'W'); const h = w.heroes.f; h.x = q.px + 4; h.y = q.y * 32 - 30; h.vy = 0; })()`);
  await sleep(150);
  await p.shot('solo-2-death');
  await p.waitFor(`__dd.solo.world.deaths === 1`, 3000);

  // clear level 1: put both heroes in front of their doors
  await sleep(1200);
  await p.eval(`(() => { const w = __dd.solo.world; for (const k of ['f','w']) { const d = w.doors[k], h = w.heroes[k]; h.x = d.x * 32 + 6; h.y = (d.y + 1) * 32 - 28; h.vy = 0; } w.gems.forEach((g) => g.taken = true); })()`);
  await p.waitFor(`!document.getElementById('clearOverlay').hidden`, 5000);
  await sleep(1400);   // stars pop in
  assert.deepEqual(await p.eval(FITS), [], 'result card fits 844×390');
  await p.shot('solo-3-cleared');
  const stars = await p.eval(`document.querySelectorAll('#bigStars .bs.on').length`);
  assert.ok(stars >= 2, `all gems → at least 2 stars (got ${stars})`);
  assert.equal(await p.eval(`document.getElementById('records').hidden`), true, 'no records panel without the host');
  const saved = await p.eval(`JSON.parse(localStorage.getItem('duldusal:progress:v1')).levels[0]`);
  assert.ok(saved && saved.done && saved.stars === stars, 'progress saved');

  // next level
  await p.click('#cNext');
  await p.waitFor(`__dd.solo.world.level === 1 && document.getElementById('clearOverlay').hidden`);

  // pause menu + level select
  await p.click('#btnMenu');
  await p.waitFor(`!document.getElementById('menuOverlay').hidden`);
  assert.deepEqual(await p.eval(FITS), [], 'menu fits');
  const t0 = await p.eval(`__dd.solo.world.mapTime`);
  await sleep(500);
  assert.equal(await p.eval(`__dd.solo.world.mapTime`), t0, 'menu pauses solo play');
  await p.shot('solo-4-menu');
  await p.click('#mLevels');
  await p.waitFor(`!document.getElementById('levelsOverlay').hidden`);
  assert.deepEqual(await p.eval(FITS), [], 'level select fits 844×390');
  await p.shot('solo-5-levels');
  const locked = await p.eval(`document.querySelectorAll('.lv.locked').length`);
  const total = await p.eval(`document.querySelectorAll('.lv').length`);
  assert.equal(locked, total - 2, 'levels 1–2 open, the rest locked');
  await p.click('.lv:nth-child(1)');
  await p.waitFor(`__dd.solo.world.level === 0 && document.getElementById('levelsOverlay').hidden`);

  // reload: resume at the first unfinished level
  await p.go(`${base}/?mute=1&lang=en`);
  await p.waitFor(`window.__dd && window.__dd.mode === 'solo'`);
  assert.equal(await p.eval(`__dd.solo.world.level`), 1, 'reload resumes at level 2');

  // portrait phone → rotated stage, Mongolian
  await p.size(390, 844);
  await p.go(`${base}/?mute=1&lang=mn`);
  await p.eval(`localStorage.clear()`);
  await p.waitFor(`window.__dd && window.__dd.mode === 'solo'`);
  await sleep(2800);
  assert.ok(await p.eval(`document.getElementById('rot').classList.contains('rotated')`), 'portrait rotates the stage');
  await p.shot('solo-6-portrait-rotated');
  await p.click('#btnMenu'); await p.click('#mLevels');
  await p.waitFor(`!document.getElementById('levelsOverlay').hidden`);
  assert.deepEqual(await p.eval(FITS), [], 'level select fits rotated 390×844');
  await p.shot('solo-7-portrait-levels');
  assert.deepEqual(p.errors, [], 'no page errors (solo)');
}

async function multiplayer(base) {
  const room = 'e2e' + Date.now().toString(36);
  const a = await Page.open('A'), b = await Page.open('B');
  await a.go(`${base}/?mute=1&dev=1&room=${room}&lang=mn`);
  await a.waitFor(`window.__dd && window.__dd.game && window.__dd.game.ready`);
  await a.waitFor(`!document.getElementById('hallOverlay').hidden`);
  await a.shot('mp-1-hall-alone');
  await b.go(`${base}/?mute=1&dev=1&room=${room}&lang=en`);
  await b.waitFor(`window.__dd && window.__dd.game && window.__dd.game.ready`);
  await a.waitFor(`document.querySelectorAll('#hallOverlay .seat.empty').length === 0`);
  assert.equal(await a.eval(`__dd.game.myHero`) + await b.eval(`__dd.game.myHero`), 1, 'two different seats');
  await a.click('#hReady');
  await a.waitFor(`document.querySelectorAll('#hallOverlay .rd.on').length === 1`);
  assert.deepEqual(await a.eval(FITS), [], 'hall fits');
  await a.shot('mp-2-hall-one-ready');
  await b.click('#hReady');
  await a.waitFor(`document.getElementById('hallOverlay').hidden && !__dd.game.lobby`);
  await b.waitFor(`document.getElementById('hallOverlay').hidden && !__dd.game.lobby`);

  // both move; each sees the other move
  const mk = await a.eval(`__dd.game.myKey`);
  const bx0 = await b.eval(`__dd.game.world.heroes['${mk}'].x`);
  await a.hold('ArrowRight', 600);
  await sleep(400);
  const bx1 = await b.eval(`__dd.game.world.heroes['${mk}'].x`);
  assert.ok(bx1 > bx0 + 30, `B sees A's hero move (${bx0} → ${bx1})`);
  await a.shot('mp-3-playing');

  // B picks level 3 from the menu → both go there
  await b.click('#btnMenu'); await b.click('#mLevels');
  await b.waitFor(`!document.getElementById('levelsOverlay').hidden`);
  // B has no progress, so only level 1 is open; use the goto message the menu sends
  await b.eval(`__dd.net.sendJson({ t: 'goto', level: 2 })`);
  await a.waitFor(`__dd.game.world.level === 2`);
  await b.waitFor(`__dd.game.world.level === 2 && document.getElementById('levelsOverlay').hidden`);

  // B leaves → A is told, and can carry on solo
  await b.send('Page.close').catch(() => {});
  b.ws.close();
  await a.waitFor(`!document.getElementById('leftOverlay').hidden`, 8000);
  await a.shot('mp-4-partner-left');
  await a.click('#lSolo');
  await a.waitFor(`__dd.mode === 'solo' && __dd.solo.world.level === 2`);
  assert.deepEqual(a.errors.filter((e) => !/websocket/i.test(e)), [], 'no page errors (A)');
}

async function main() {
  assert.ok(CHROME, 'Chrome not found (set CHROME=...)');
  const server = spawn(process.execPath, ['server/server.js'], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT), DEV_ALLOW_UNSIGNED: '1', NODE_ENV: 'development' }, stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((r) => server.stdout.once('data', r));
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-chrome-'));
  const chrome = spawn(CHROME, [
    '--headless=new', '--mute-audio', `--remote-debugging-port=${DBG}`, `--user-data-dir=${prof}`,
    '--no-first-run', '--no-default-browser-check', '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', 'about:blank',
  ], { stdio: 'ignore' });
  let ok = false;
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${DBG}/json/version`); break; } catch { await sleep(150); } }
    const base = `http://127.0.0.1:${PORT}`;
    await solo(base); console.log('  ok  solo flow');
    await multiplayer(base); console.log('  ok  multiplayer flow');
    ok = true;
  } finally {
    chrome.kill(); server.kill();
    console.log(`screenshots: ${OUT}`);
  }
  process.exit(ok ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
