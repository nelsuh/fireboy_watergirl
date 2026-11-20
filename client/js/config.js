// Client configuration.
//
// Inside the Usion host (the normal case) the game server URL and the access
// token BOTH come from the backend via the SDK (direct-mode access), so nothing
// here is used. The values below are the STANDALONE/DEV fallback for opening the
// client directly in a browser — they only connect if the server runs with
// DEV_ALLOW_UNSIGNED=1 (never in production).

// The platform's canonical service id (see server/config.js). At runtime the
// client prefers window.Usion.config.serviceId; this is the standalone fallback.
export const SERVICE_ID = 'fireboy-and-watergirl-dcb7ed3a';

// Railway game server, used only for standalone/dev connects. Update at deploy.
export const DEV_SERVER_URL = 'wss://fireboy-watergirl-production-39e3.up.railway.app/ws';

export function devServerUrl() {
  const q = new URLSearchParams(location.search).get('server');
  if (q) return q;
  if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
    return `ws://${location.host}/ws`;   // the local server serves this page too
  }
  return DEV_SERVER_URL;
}

export function devRoomId() {
  return (new URLSearchParams(location.search).get('room') || 'arena')
    .replace(/[^a-z0-9_-]/gi, '').slice(0, 24) || 'arena';
}
