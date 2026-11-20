// ── i18n ─────────────────────────────────────────────────
// Every user-facing string lives here, chosen from the platform language
// (Usion.getLanguage() / config.language) — never hardcode UI text to one
// locale. Values may be a string or a function of runtime args. Keep both
// locales in sync.
const STR = {
  en: {
    appName: 'Dul & Dusal',
    heroF: 'Dul', heroW: 'Dusal',
    ctlLeft: 'left', ctlRight: 'right', ctlSwap: 'switch hero', ctlJump: 'jump', ctlMenu: 'menu',
    reconnecting: 'Reconnecting…',
    defaultName: 'player',
    level: (n) => 'Level ' + n,
    // pause menu
    paused: 'Paused', resume: 'Resume', restart: 'Restart level', levels: 'Levels', close: 'Close',
    // level select
    chooseLevel: 'Choose a level', locked: 'Locked', starsTotal: (a, b) => a + ' / ' + b,
    // level clear
    cleared: 'Level cleared!', allCleared: 'Every level cleared!',
    next: 'Next level', retry: 'Retry', toLevels: 'Levels', playAgain: 'Play again',
    starDone: 'Reach both doors', starGems: (a, b) => 'All gems ' + a + '/' + b, starTime: (t) => 'Under ' + t,
    time: 'Time', gems: 'Gems', falls: 'Falls', newBest: 'New best!',
    // records
    records: 'Records', friends: 'Friends', global: 'Global', loading: 'Loading…',
    noFriends: 'No friends on the board yet — invite one!', recordsError: 'Records unavailable.', tryAgain: 'Try again',
    starsUnit: '★',
    // waiting hall
    hallTitle: 'Waiting hall', hallSub: 'Both press Ready to start',
    ready: 'Ready', notReady: 'Not ready', imReady: "I'm ready", cancelReady: 'Cancel',
    emptySeat: 'Waiting for a friend…', invite: 'Invite a friend', playSolo: 'Play solo', you: 'you',
    partnerLeft: 'Your partner left', partnerLeftSub: 'Wait for them to come back, or keep playing on your own.',
    keepWaiting: 'Wait',
    // toasts
    practice: 'Solo — switch heroes with ⇄. Tap Share above to play with a friend',
    matchStarting: 'Match starting…', partnerJoined: (n) => n + ' joined!',
    youAre: (h) => 'You are ' + h, partnerPicked: 'Your partner changed the level',
    lockedToast: 'Clear the previous level first',
    ms: 'ms',
  },
  mn: {
    appName: 'Дөл ба Дусал',
    heroF: 'Дөл', heroW: 'Дусал',
    ctlLeft: 'зүүн', ctlRight: 'баруун', ctlSwap: 'баатраа солих', ctlJump: 'үсрэх', ctlMenu: 'цэс',
    reconnecting: 'Дахин холбогдож байна…',
    defaultName: 'тоглогч',
    level: (n) => n + '-р түвшин',
    paused: 'Түр зогслоо', resume: 'Үргэлжлүүлэх', restart: 'Дахин эхлэх', levels: 'Түвшингүүд', close: 'Хаах',
    chooseLevel: 'Түвшин сонгох', locked: 'Түгжээтэй', starsTotal: (a, b) => a + ' / ' + b,
    cleared: 'Түвшин давлаа!', allCleared: 'Бүх түвшинг давлаа!',
    next: 'Дараагийн түвшин', retry: 'Дахин', toLevels: 'Түвшингүүд', playAgain: 'Дахин тоглох',
    starDone: 'Хоёр хаалгандаа хүрэх', starGems: (a, b) => 'Бүх эрдэнэ ' + a + '/' + b, starTime: (t) => t + '-с хурдан',
    time: 'Хугацаа', gems: 'Эрдэнэ', falls: 'Унасан', newBest: 'Шинэ амжилт!',
    records: 'Амжилт', friends: 'Найзууд', global: 'Дэлхий', loading: 'Ачаалж байна…',
    noFriends: 'Самбар дээр найз алга — нэгийг урь!', recordsError: 'Амжилтыг ачаалж чадсангүй.', tryAgain: 'Дахин оролдох',
    starsUnit: '★',
    hallTitle: 'Хүлээлгийн танхим', hallSub: 'Хоёулаа «Бэлэн» дарвал эхэлнэ',
    ready: 'Бэлэн', notReady: 'Бэлэн биш', imReady: 'Би бэлэн', cancelReady: 'Цуцлах',
    emptySeat: 'Найзаа хүлээж байна…', invite: 'Найзаа урих', playSolo: 'Ганцаараа тоглох', you: 'та',
    partnerLeft: 'Хамтрагч гарчихлаа', partnerLeftSub: 'Буцаж иртэл хүлээх эсвэл ганцаараа үргэлжлүүлээрэй.',
    keepWaiting: 'Хүлээх',
    practice: 'Ганцаараа — ⇄ товчоор баатраа солино. Найзтайгаа тоглох бол дээрх Share-г дар',
    matchStarting: 'Тоглолт эхэлж байна…', partnerJoined: (n) => n + ' нэгдлээ!',
    youAre: (h) => 'Та бол ' + h, partnerPicked: 'Хамтрагч түвшин сольлоо',
    lockedToast: 'Өмнөх түвшингээ эхлээд давна уу',
    ms: 'мс',
  },
};

export let LANG = 'en';

export function t(key, ...args) {
  let v = STR[LANG] ? STR[LANG][key] : undefined;
  if (v === undefined) v = STR.en[key];
  if (typeof v === 'function') return v(...args);
  return v !== undefined ? v : key;
}

// Level / map names are {mn, en} objects in maps.js.
export function nameOf(n) {
  if (!n) return '';
  if (typeof n === 'string') return n;
  return n[LANG] || n.en || '';
}

// Platform language first (config.language, then Usion.getLanguage()); the
// browser hint is only a fallback before the host has booted.
export function detectLang(cfgLang) {
  let src = cfgLang;
  try { const q = new URLSearchParams(location.search).get('lang'); if (q) src = q; } catch { /* no location */ }
  if (!src) {
    try { src = window.Usion && window.Usion.getLanguage && window.Usion.getLanguage(); } catch { /* no SDK */ }
  }
  if (!src) src = (navigator.languages && navigator.languages[0]) || navigator.language || 'en';
  return String(src).toLowerCase().indexOf('mn') === 0 ? 'mn' : 'en';
}

// Set the active locale and fill every static (index.html) string marked with
// data-t (text) / data-aria (aria-label). Safe to call again once the platform
// language arrives after the first paint.
export function applyLang(lang) {
  LANG = lang === 'mn' ? 'mn' : 'en';
  try { document.documentElement.lang = LANG; } catch { /* detached document */ }
  try { document.title = t('appName'); } catch { /* detached document */ }
  for (const el of document.querySelectorAll('[data-t]')) el.textContent = t(el.dataset.t);
  for (const el of document.querySelectorAll('[data-aria]')) el.setAttribute('aria-label', t(el.dataset.aria));
}
