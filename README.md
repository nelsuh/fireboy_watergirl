# FIRE & WATER

Two-player co-op platformer for Usion: one plays **Fireboy**, the other
**Watergirl**, and they reach both exit doors together across 5 maps (levers,
pressure plates, gates, moving lifts, colour-matched gems, deadly pools). Ships
as a **Usion direct-mode game** — identity, rooms, and invites come from the
platform; both clients talk binary WebSocket straight to this authoritative
server (zero relay hop). This replaces the old platform-relay build, whose
peer-to-peer handshake was the source of the "friend can't join" / desync bugs.

- **Play**: launch from the Usion app (a game invite in chat, or Explore). Tap
  PLAY, then move with ◀ ▶ and jump with ▲. A solo Explore launch drops you into
  a local practice arena until a friend joins (host **Share** button) — then it
  promotes into a live match.
- **Fallbacks**: desktop → arrow keys / WASD + space to jump.

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

Seats are fixed and stable: hero 0 = Fireboy (first to join), hero 1 = Watergirl.
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
#   http://localhost:8080/?dev=1&room=test   (tab 1 → Fireboy)
#   http://localhost:8080/?dev=1&room=test   (tab 2 → Watergirl)
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
