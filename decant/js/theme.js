// Light or dark look. "Auto" (the default) follows the phone's own setting and
// switches with it live — e.g. when the phone goes dark at sunset. The choice
// is this phone's own (localStorage), not a shared setting. The first paint's
// look is set by the little script in index.html's <head>, so there's no flash.

const KEY = 'vriddhi-decant-theme';
export const THEMES = ['auto', 'light', 'dark'];
const media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;
const listeners = new Set();
let held = 'auto';                    // when the phone's storage is blocked: this visit only

export function themeChoice() {
  try {
    const v = localStorage.getItem(KEY);
    return THEMES.includes(v) ? v : 'auto';
  } catch { return held; }
}

const systemLook = () => (media?.matches ? 'light' : 'dark');   // no answer: the app's own dark look
export const lookOf = (choice) => (choice === 'auto' ? systemLook() : choice);
export const currentLook = () => lookOf(themeChoice());

function apply() {
  const look = currentLook();
  document.documentElement.dataset.theme = look;
  for (const fn of listeners) fn(look, themeChoice());
}

export function setTheme(choice) {
  if (!THEMES.includes(choice)) choice = 'auto';
  held = choice;
  try {
    if (choice === 'auto') localStorage.removeItem(KEY); else localStorage.setItem(KEY, choice);
  } catch { /* storage blocked: held for this visit */ }
  apply();
}

// The header button: every tap visibly changes the look. From Auto it goes to
// the other look, then to the one the phone is in, then back to Auto.
export function nextTheme() {
  const choice = themeChoice();
  const sys = systemLook();
  const other = sys === 'dark' ? 'light' : 'dark';
  const next = choice === 'auto' ? other : choice === other ? sys : 'auto';
  setTheme(next);
  return next;
}

export function themeLabel(choice = themeChoice()) {
  return choice === 'auto' ? `Auto — follows the phone (${systemLook()} now)` : choice === 'light' ? 'Light' : 'Dark';
}

// Drawn, not font symbols (◐ ☀ ☾ differ from phone to phone, or are missing).
const ICONS = {
  auto: '<circle cx="8" cy="8" r="5.6" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M8 2.4a5.6 5.6 0 0 0 0 11.2z" fill="currentColor"/>',
  light: '<circle cx="8" cy="8" r="2.9" fill="currentColor"/><path d="M8 1.2v1.9M8 12.9v1.9M1.2 8h1.9M12.9 8h1.9M3.2 3.2l1.35 1.35M11.45 11.45l1.35 1.35M3.2 12.8l1.35-1.35M11.45 4.55l1.35-1.35" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
  dark: '<path d="M13.4 10.1A5.9 5.9 0 0 1 5.9 2.6a5.9 5.9 0 1 0 7.5 7.5z" fill="currentColor"/>',
};
export const themeIcon = (choice = themeChoice()) => `<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" style="display:block">${ICONS[choice]}</svg>`;

export function onTheme(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function initTheme() {
  apply();
  const onSystem = () => { if (themeChoice() === 'auto') apply(); };
  if (media?.addEventListener) media.addEventListener('change', onSystem);
  else media?.addListener?.(onSystem);
  // another tab of the app changed it
  window.addEventListener('storage', (e) => { if (e.key === KEY || e.key === null) apply(); });
}
