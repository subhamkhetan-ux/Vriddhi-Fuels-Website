// Spoken instructions while the tank stock server runs a decantation (the
// decanting screen: wizard.js), on this phone's own voice (speechSynthesis).
// On unless muted here (kept on this phone); each instruction is said once
// — the first time it shows on this phone — never again on a redraw.

const KEY = 'vriddhi-decant-voice';
const SAID = 'vriddhi-decant-said';          // instructions said this visit (sessionStorage): {key: 1}
const synth = () => (typeof window !== 'undefined' ? window.speechSynthesis : null);

export const voiceAvailable = () => Boolean(synth()) && typeof window.SpeechSynthesisUtterance === 'function';

export function voiceOn() {
  try { return localStorage.getItem(KEY) !== 'off'; } catch { return true; }
}

let said = null;
function saidSet() {
  if (said) return said;
  try { said = new Set(Object.keys(JSON.parse(sessionStorage.getItem(SAID) || '{}'))); } catch { said = new Set(); }
  return said;
}

function speak(text) {
  const s = synth();
  if (!s || !voiceAvailable()) return;
  const u = new window.SpeechSynthesisUtterance(text);
  u.lang = 'en-IN';
  u.rate = 0.95;
  s.speak(u);
}

// The 🔊 / 🔇 button. Turning it on says so (a tap is what lets a phone speak at all).
export function setVoice(on) {
  try { localStorage.setItem(KEY, on ? 'on' : 'off'); } catch { /* this visit only */ }
  if (on) speak('Voice instructions on.');
  else synth()?.cancel();
}

// Say `text` once for `key` (e.g. "S1|T2|move|3"), if the voice is on.
export function sayOnce(key, text) {
  const done = saidSet();
  if (!key || done.has(key)) return;
  done.add(key);
  try { sessionStorage.setItem(SAID, JSON.stringify(Object.fromEntries([...done].slice(-200).map((k) => [k, 1])))); } catch { /* ignore */ }
  if (voiceOn()) speak(text);
}
