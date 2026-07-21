// Register / verify the Fire & Water service as a DIRECT-MODE game on the Usion
// platform. This is the step that was still pending — without it the platform
// won't mint a valid direct-mode access token, so `Usion.game._fetchDirectAccess`
// returns nothing usable and every client loops on "Reconnecting…" (0/2).
//
// USAGE
//   # 1) mint a personal API token in the app: Service Creator → Agent API
//   #    Access → Create API token  (raw "usion_sk_…" is shown once)
//   # 2) DIAGNOSE — read the current registration (no writes):
//   USION_API_TOKEN=usion_sk_xxx node scripts/register_direct.mjs
//   # 3) FIX — upsert connection_mode:direct + ws_url + max_players:2:
//   USION_API_TOKEN=usion_sk_xxx APPLY=1 node scripts/register_direct.mjs
//
// Override the API host / Railway URL via env if they differ:
//   USION_API_URL   (default https://mobile.mongolai.mn — same host the server
//                    verifies JWKS against, see server/config.js)
//   WS_URL          (default wss://fireboywatergirl-production.up.railway.app/ws)
//   IFRAME_URL      (default https://fireboywatergirl-production.up.railway.app/)
//
// Field names below follow references/publishing.md "Path C". If your backend's
// registry schema differs, the GET step prints the live doc so you can see the
// exact shape and adjust — trust that over these defaults.

const API_URL   = (process.env.USION_API_URL || 'https://mobile.mongolai.mn').replace(/\/$/, '');
const TOKEN     = process.env.USION_API_TOKEN || '';
const APPLY     = process.env.APPLY === '1';
const SERVICE_ID = process.env.SERVICE_ID || 'fireboy-watergirl';
const WS_URL    = process.env.WS_URL     || 'wss://fireboywatergirl-production.up.railway.app/ws';
const IFRAME_URL = process.env.IFRAME_URL || 'https://fireboywatergirl-production.up.railway.app/';

if (!TOKEN) {
  console.error('Missing USION_API_TOKEN. Mint one in Service Creator → Agent API Access.');
  process.exit(1);
}

const H = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };

const REALTIME_DIRECT = {
  connection_mode: 'direct',
  connection_transport: 'websocket',
  ws_url: WS_URL,
};

async function j(res) {
  const text = await res.text();
  try { return { ok: res.ok, status: res.status, body: JSON.parse(text) }; }
  catch { return { ok: res.ok, status: res.status, body: text }; }
}

function findFireboy(list) {
  const arr = Array.isArray(list) ? list : (list && (list.services || list.data)) || [];
  return arr.find((s) =>
    s && (
      s.service_id === SERVICE_ID || s.id === SERVICE_ID || s.slug === SERVICE_ID ||
      /fireboy|fire\s*&?\s*water/i.test(String(s.name || '')) ||
      String(s.iframe_url || '').includes('fireboywatergirl')
    ));
}

async function main() {
  console.log(`API_URL      = ${API_URL}`);
  console.log(`SERVICE_ID   = ${SERVICE_ID}`);
  console.log(`ws_url       = ${WS_URL}`);
  console.log(`iframe_url   = ${IFRAME_URL}`);
  console.log(`mode         = ${APPLY ? 'APPLY (will write)' : 'DIAGNOSE (read-only)'}`);
  console.log('─'.repeat(60));

  // 1) Read current registrations.
  const listRes = await j(await fetch(`${API_URL}/registry/services/my`, { headers: H }));
  if (!listRes.ok) {
    console.error(`GET /registry/services/my → ${listRes.status}`, listRes.body);
    process.exit(1);
  }
  const existing = findFireboy(listRes.body);

  if (existing) {
    console.log('FOUND existing service:');
    console.log('  id/service_id :', existing.id || existing.service_id);
    console.log('  name          :', existing.name);
    console.log('  iframe_url    :', existing.iframe_url);
    console.log('  max_players   :', existing.max_players);
    console.log('  realtime      :', JSON.stringify(existing.realtime));
    console.log('  is_published  :', existing.is_published);
    const cm = existing.realtime && existing.realtime.connection_mode;
    if (cm !== 'direct') {
      console.log(`\n⚠  connection_mode is "${cm}" — MUST be "direct" for this game. This is the bug.`);
    } else if ((existing.realtime.ws_url || '') !== WS_URL) {
      console.log(`\n⚠  ws_url is "${existing.realtime.ws_url}" — expected "${WS_URL}".`);
    } else if (Number(existing.max_players) !== 2) {
      console.log(`\n⚠  max_players is ${existing.max_players} — expected 2.`);
    } else {
      console.log('\n✓ Registration already looks correct for direct-mode 2-player.');
    }
  } else {
    console.log('NO existing Fire & Water service found under this token.');
  }

  if (!APPLY) {
    console.log('\nRe-run with APPLY=1 to write the direct-mode registration.');
    return;
  }

  // 2) Upsert.
  const id = existing && (existing.id || existing.service_id);
  if (id) {
    const upd = { realtime: REALTIME_DIRECT, max_players: 2, iframe_url: IFRAME_URL };
    const res = await j(await fetch(`${API_URL}/registry/services/my/${encodeURIComponent(id)}`, {
      method: 'PUT', headers: H, body: JSON.stringify(upd),
    }));
    console.log(`PUT update → ${res.status}`, JSON.stringify(res.body).slice(0, 400));
  } else {
    const body = {
      name: 'Fireboy and Watergirl',
      description: 'Co-op platformer — reach both doors together.',
      service_type: 'game',
      iframe_url: IFRAME_URL,
      cost: 0,
      tags: ['game', 'multiplayer'],
      is_published: true,
      realtime: REALTIME_DIRECT,
      max_players: 2,
    };
    const res = await j(await fetch(`${API_URL}/registry/services/register`, {
      method: 'POST', headers: H, body: JSON.stringify(body),
    }));
    console.log(`POST register → ${res.status}`, JSON.stringify(res.body).slice(0, 400));
  }
  console.log('\nDone. Re-run without APPLY to confirm connection_mode=direct.');
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
