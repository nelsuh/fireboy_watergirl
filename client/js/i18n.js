// ── i18n ─────────────────────────────────────────────────
// Every user-facing string lives here, chosen from the platform language
// (Usion.getLanguage() / config.language) — never hardcode UI text to one
// locale. Values may be a string or a function of runtime args. Keep both
// locales in sync.
const STR = {
  en: {
    appName: 'Fire & Water',
    ctlLeft: 'left', ctlRight: 'right', ctlSwap: 'switch hero', ctlJump: 'jump',
    waitingForPartner: 'Waiting for your partner…',
    reconnecting: 'Reconnecting…',
    youDidIt: 'You did it!',
    playAgain: 'Play again',
    playingAs: (name) => 'Playing as ' + name,
    guest: 'Guest',
    defaultName: 'player',
    allMapsCleared: (n) => 'All ' + n + ' maps cleared!',
    fallsLabel: 'falls',
    newBest: '★ new best!',
    bestWas: (time) => '(best ' + time + ')',
    ms: 'ms',
  },
  mn: {
    appName: 'Гал ба Ус',
    ctlLeft: 'зүүн', ctlRight: 'баруун', ctlSwap: 'баатраа солих', ctlJump: 'үсрэх',
    waitingForPartner: 'Хамтрагчаа хүлээж байна…',
    reconnecting: 'Дахин холбогдож байна…',
    youDidIt: 'Та чадлаа!',
    playAgain: 'Дахин тоглох',
    playingAs: (name) => name + ' нэрээр тоглож байна',
    guest: 'Зочин',
    defaultName: 'тоглогч',
    allMapsCleared: (n) => 'Бүх ' + n + ' газрын зураг дууслаа!',
    fallsLabel: 'унасан',
    newBest: '★ шинэ дээд амжилт!',
    bestWas: (time) => '(дээд ' + time + ')',
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

// Platform language first (config.language, then Usion.getLanguage()); the
// browser hint is only a fallback before the host has booted.
export function detectLang(cfgLang) {
  let src = cfgLang;
  if (!src) {
    try { src = window.Usion && window.Usion.getLanguage && window.Usion.getLanguage(); } catch { /* no SDK */ }
  }
  if (!src) src = (navigator.languages && navigator.languages[0]) || navigator.language || 'en';
  return String(src).toLowerCase().indexOf('mn') === 0 ? 'mn' : 'en';
}

// Set the active locale and fill every static (index.html) string. Safe to call
// again once the platform language arrives after the first paint.
export function applyLang(lang) {
  LANG = lang === 'mn' ? 'mn' : 'en';
  try { document.documentElement.lang = LANG; } catch { /* detached document */ }
  try { document.title = t('appName'); } catch { /* detached document */ }
  const byId = (id, key) => { const el = document.getElementById(id); if (el) el.textContent = t(key); };
  const ariaId = (id, key) => { const el = document.getElementById(id); if (el) el.setAttribute('aria-label', t(key)); };
  ariaId('btnLeft', 'ctlLeft');
  ariaId('btnRight', 'ctlRight');
  ariaId('btnSwap', 'ctlSwap');
  ariaId('btnJump', 'ctlJump');
  byId('waitingText', 'waitingForPartner');
  byId('pauseText', 'reconnecting');
  byId('againBtn', 'playAgain');
  // Only reset the end title while the victory card is still hidden — once it is
  // showing it carries the "all maps cleared" line instead.
  const end = document.getElementById('endOverlay');
  if (end && end.hidden) byId('endTitle', 'youDidIt');
}
