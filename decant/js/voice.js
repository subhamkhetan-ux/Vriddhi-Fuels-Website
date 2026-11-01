// Spoken instructions while the tank stock server runs a decantation (the
// decanting screen: wizard.js), on this phone's own voice (speechSynthesis).
// On unless muted here (kept on this phone), in English or Hindi (also kept
// here); each instruction is said once — the first time it shows on this
// phone — never again on a redraw. An instruction is {en, hi} (or a string).

const KEY = 'vriddhi-decant-voice';
const LANG = 'vriddhi-decant-voice-lang';    // 'en' | 'hi'
const LANGS = { en: 'en-IN', hi: 'hi-IN' };
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

export function voiceLang() {
  try { return localStorage.getItem(LANG) === 'hi' ? 'hi' : 'en'; } catch { return 'en'; }
}

function speak(say) {
  const s = synth();
  if (!s || !voiceAvailable()) return;
  const lang = voiceLang();
  const text = typeof say === 'string' ? say : say?.[lang] || say?.en;
  if (!text) return;
  const u = new window.SpeechSynthesisUtterance(text);
  u.lang = LANGS[lang];
  // this phone's own voice for that language, if it has one (a Hindi one reads Devanagari properly)
  const v = (s.getVoices?.() || []).find((x) => (x.lang || '').toLowerCase().replace('_', '-').startsWith(lang));
  if (v) u.voice = v;
  u.rate = 0.95;
  s.speak(u);
}

const ON = { en: 'Voice instructions on.', hi: 'आवाज़ निर्देश चालू।' };

// The 🔊 / 🔇 button. Turning it on says so (a tap is what lets a phone speak at all).
export function setVoice(on) {
  try { localStorage.setItem(KEY, on ? 'on' : 'off'); } catch { /* this visit only */ }
  if (on) speak(ON);
  else synth()?.cancel();
}

// The English / हिंदी button: from now on in that language (it says so, if the voice is on).
export function setVoiceLang(lang) {
  try { localStorage.setItem(LANG, lang === 'hi' ? 'hi' : 'en'); } catch { /* this visit only */ }
  synth()?.cancel();
  if (voiceOn()) speak(ON);
}

// Say `text` ({en, hi}) once for `key` (e.g. "S1|T2|move|3"), if the voice is on.
export function sayOnce(key, text) {
  const done = saidSet();
  if (!key || done.has(key)) return;
  done.add(key);
  try { sessionStorage.setItem(SAID, JSON.stringify(Object.fromEntries([...done].slice(-200).map((k) => [k, 1])))); } catch { /* ignore */ }
  if (voiceOn()) speak(text);
}
