// Voice: speak to Jarvis (the browser's speech recognition — Chrome on
// Android / desktop, Safari on iPhone) and hear the answers (speech
// synthesis, an Indian English voice when the phone has one).

const Rec = window.SpeechRecognition || window.webkitSpeechRecognition;
export const canListen = Boolean(Rec);
export const canSpeak = 'speechSynthesis' in window;

// listen once: onPartial(text) while speaking, resolves the final text ('' if nothing)
export function listen({ lang = 'en-IN', onPartial = () => {} } = {}) {
  if (!Rec) return Promise.reject(new Error('Voice input isn\'t supported in this browser (try Chrome or Safari).'));
  stopSpeaking();
  const rec = new Rec();
  rec.lang = lang;
  rec.interimResults = true;
  rec.continuous = false;
  rec.maxAlternatives = 1;
  let final = '';
  const p = new Promise((resolve, reject) => {
    rec.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) final += r[0].transcript;
        else interim += r[0].transcript;
      }
      onPartial((final + interim).trim());
    };
    rec.onerror = (e) => {
      if (e.error === 'no-speech' || e.error === 'aborted') resolve('');
      else reject(new Error(e.error === 'not-allowed' ? 'Microphone access was refused — allow it for this site.' : `Voice input failed (${e.error}).`));
    };
    rec.onend = () => resolve(final.trim());
  });
  rec.start();
  p.stop = () => rec.stop();
  return p;
}

let voices = [];
if (canSpeak) {
  const load = () => { voices = window.speechSynthesis.getVoices(); };
  load();
  window.speechSynthesis.addEventListener?.('voiceschanged', load);
}

function pickVoice(lang) {
  const base = lang.split('-')[0];
  return voices.find((v) => v.lang === lang && /female|google|siri|veena|lekha/i.test(v.name))
    || voices.find((v) => v.lang === lang)
    || voices.find((v) => v.lang.startsWith(`${base}-`))
    || null;
}

// plain words for speaking: no markdown, ₹ read as rupees, L as litres
export function speakable(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[*_#>`|]/g, ' ')
    .replace(/\[(.*?)\]\(.*?\)/g, '$1')
    .replace(/₹\s?([\d,]+(?:\.\d+)?)/g, '$1 rupees')
    .replace(/−/g, 'minus ')
    .replace(/(\d)\s?L\b/g, '$1 litres')
    .replace(/\bKL\b/g, 'kilolitres')
    .replace(/\bDr\b/g, 'due').replace(/\bCr\b/g, 'advance')
    .replace(/\s+/g, ' ')
    .trim();
}

export function speak(text, { lang = 'en-IN', onEnd = () => {} } = {}) {
  if (!canSpeak) { onEnd(); return; }
  stopSpeaking();
  const u = new SpeechSynthesisUtterance(speakable(text).slice(0, 600));
  u.lang = lang;
  const v = pickVoice(lang);
  if (v) u.voice = v;
  u.rate = 1.03;
  u.onend = onEnd;
  u.onerror = onEnd;
  window.speechSynthesis.speak(u);
}

export function stopSpeaking() {
  if (canSpeak) window.speechSynthesis.cancel();
}
