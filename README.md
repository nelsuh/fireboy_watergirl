# Дөл ба Дусал (Dul & Dusal)

An original two-player co-op elemental platformer for Usion. **Дөл**, a fire
spirit in a pointed fur hat, and **Дусал**, a water spirit with a turquoise
ornament, cross an old underground steppe temple together: each walks safely
through its own element and is destroyed by the other's; violet poison takes
both. Plates, levers, gates and lifts need teamwork; coral (Дөл) and turquoise
(Дусал) gems and a par time give up to three stars per level.

- **Solo** (Explore / GameTok, `mode: 'single'`): starts instantly at the first
  unfinished level. One player drives both heroes and switches with ⇄ (Tab / S /
  Shift on a keyboard). The host's Share button promotes it to a live match.
- **Multiplayer** (chat invite): waiting hall with READY toggles, invite and a
  play-solo escape → level → result card → next level / retry / level select
  (either player may choose).
- **Progress** (stars, best times) lives in `Usion.storage` with a localStorage
  cache; the leaderboard value is **total stars** (desc, best kept).
- **Art**: `client/assets/*.webp` (sources + prompts in `art/`). Everything else,
  including all sound and the pentatonic music, is generated in code.
- **Keys**: ← → / A D move, ↑ / W / Space jump, Esc / P menu.

## Commands

| | |
|---|---|
| `npm start` | serve client + realtime server on `PORT` (8080) |
| `npm test` | unit test + headless two-player protocol smoke test |
| `npm run e2e` | headless Chrome: solo + two-window multiplayer flows, screenshots |
| `npm run solve` | prove every level is beatable (solo) and every gem reachable |

Local two-player: `DEV_ALLOW_UNSIGNED=1 npm start`, then open
`http://localhost:8080/?dev=1&room=x` in two windows.

## Hosting

Runs on the Usion game host (Amazon, Singapore) as `dul-dusal`
(`usion.game.json`, `Dockerfile`), at `https://dul-dusal.games.usions.com`.
The server needs `SERVICE_ID=fireboy-and-watergirl-dcb7ed3a` (the platform's
hashed id — the access-token audience) and nothing secret: tokens are verified
against the public JWKS. The old Railway copy is the fallback.

## Architecture — the zero-lag template (from `tank`)

```
client/  → static ES modules (served by the Railway server, or Vercel)
server/  → Railway (Node 20+, ws)
client/shared/ → deterministic sim + binary protocol, imported by BOTH sides
```

| Technique | Where | What it does |
|---|---|---|
| Authoritative server, fixed 60 Hz tick | `server/server.js` | One truth for both heroes + the whole world; cheating-resistant; stable physics |
| Client-side prediction | `client/js/game.js` | YOUR hero responds in **0 ms** — inputs applied locally the same frame |
| Server reconciliation | `client/js/game.js` `_reconcile` | Snapshots ack input seq; predicted hero is reset + unacked inputs replayed. Residual error (≈0, shared sim) decays visually, never snaps |
| Shared deterministic sim | `client/shared/sim.js` | Client & server run byte-identical platformer physics → predictions land exactly on the server result |
| Partner interpolation | `client/js/game.js` `_sampleRemote` | The partner renders ~66 ms in the past between two real snapshots → smooth despite jitter |
| Authoritative world | snapshot `leversOn`/`gates`/`lifts`/`gemsTaken`/`level`/`deaths` | Levers, gates, lifts, gems, level progression and deaths are decided server-side and streamed; no peer desync possible |
| Binary hot path | `client/shared/protocol.js` | 4-byte inputs, ~40-byte snapshots, quantized positions. JSON only for rare events (welcome/join/level/victory) |

### Protocol

- **C→S** `INPUT` (binary, 4 B): seq + button bits (left/right/jump) — sent every tick (60/s)
- **C→S** `PING` / **S→C** `PONG` (binary): RTT + server-clock estimate
- **S→C** `SNAPSHOT` (binary): tick, per-client input ack, your hero id, level/phase/deaths/timer, levers/gates/lifts/gems, both heroes (pos/vel/flags)
- **JSON events**: `hello`, `welcome`, `join`, `leave`, `level`, `victory`, `restart`, `error`

Seats are fixed and stable: hero 0 = Дөл (first to join), hero 1 = Дусал.
A reconnecting user (same platform identity) reclaims their seat.

### Server-side validation

Movement is *simulated* from inputs, never accepted as positions. Input button
bits are the only client-supplied gameplay data. Malformed/oversized frames are
dropped, idle sockets kicked, rooms/seats capped. Every connection presents a
platform-minted RS256 access token (`?token=`) validated against the platform
JWKS (`server/auth.js`); the token binds the socket to a user + room, so a client
can pick neither.

## Run locally

```bash
npm install
# server (dev-token bypass so a browser can connect without the platform):
DEV_ALLOW_UNSIGNED=1 npm start           # http+ws on :8080, also serves client/
# open two tabs to co-op locally:
#   http://localhost:8080/?dev=1&room=test   (tab 1 → Дөл)
#   http://localhost:8080/?dev=1&room=test   (tab 2 → Дусал)
npm test                                  # headless 2-player protocol smoke test
```

`?dev=1` forces a direct WS connect with a `dev:<user>:<room>` token (only
accepted when the server runs with `DEV_ALLOW_UNSIGNED=1`, never in production).

## Deploy

The Railway server serves the static client too (one host for both the iframe and
the WebSocket), so a single deploy ships everything:

The live Railway host is **`fireboy-watergirl-production-39e3.up.railway.app`**
(serves both the iframe and `/ws`). Whenever that hostname changes, the service
registry's `ws_url` MUST be re-registered — a stale `ws_url` still mints valid
tokens, so every client just loops on "Reconnecting…" with no visible error.

```bash
railway up --detach        # railway.json sets start command + /healthz
# NODE_ENV=production is set on the service; DEV_ALLOW_UNSIGNED must stay UNSET.

# register / update in the Usion service registry (from the monorepo backend):
cd backend && python -m scripts.seed_fireboy_watergirl
```

After the first deploy, update `RAILWAY_URL` in
`backend/scripts/seed_fireboy_watergirl.py` and `DEV_SERVER_URL` in
`client/js/config.js` to the real Railway domain, then re-run the seed.

## Legacy

The previous platform-relay build (`index.html`, `script.js`, `maps.js`,
`style.css` at the repo root) is kept for reference. The direct-mode game lives in
`client/` + `server/` and is the one that ships.
