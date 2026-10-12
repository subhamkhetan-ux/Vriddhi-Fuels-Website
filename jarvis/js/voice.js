// Voice: speak to Jarvis (the browser's speech recognition — Chrome on
// Android / desktop, Safari on iPhone) and hear the answers in a calm British
// man's voice, the best one the device has (or the one picked in ⚙ Settings).

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

// Jarvis's voice: a calm British man, best first. Natural (neural) voices
// sound far better than the old robotic ones, so they come first.
const BRITISH = [
  /Microsoft Ryan Online \(Natural\)/i,          // Edge (Windows / Mac / Android)
  /Microsoft Thomas Online \(Natural\)/i,
  /^Daniel \((Premium|Enhanced)\)/i,              // iPhone / Mac, once downloaded
  /^Arthur \((Premium|Enhanced)\)/i,
  /^Daniel\b/i,                                    // iPhone / Mac
  /^Arthur\b/i,
  /Google UK English Male/i,                       // Chrome on a computer
  /en-gb-x-(rjs|gbb|gbd)/i,                        // Android's British men
  /\b(Oliver|George|Malcolm|Thomas|Ryan|Alfie|Elliot|Noah|Ethan)\b/i,
];
const isBritish = (v) => /^en[-_]GB/i.test(v.lang);

export function britishVoice() {
  for (const re of BRITISH) {
    const v = voices.find((x) => isBritish(x) && re.test(x.name));
    if (v) return v;
  }
  return voices.find((x) => isBritish(x) && !/female|woman|serena|kate|stephanie|martha|sonia|libby|maisie|hazel|susan|fiona/i.test(x.name))
    || voices.find(isBritish) || null;
}

// the voices a person could pick in Settings (English and Hindi ones)
export const voiceList = () => voices.filter((v) => /^(en|hi)[-_]/i.test(v.lang))
  .map((v) => ({ name: v.name, lang: v.lang.replace('_', '-') }))
  .sort((a, b) => Number(b.lang === 'en-GB') - Number(a.lang === 'en-GB') || a.lang.localeCompare(b.lang) || a.name.localeCompare(b.name));

export function onVoices(fn) {
  if (canSpeak) window.speechSynthesis.addEventListener?.('voiceschanged', fn);
}

function pickVoice(text, name) {
  if (/[\u0900-\u097F]/.test(text)) {                // Hindi script needs a Hindi voice
    return voices.find((v) => /^hi[-_]/i.test(v.lang)) || null;
  }
  return (name && voices.find((v) => v.name === name)) || britishVoice();
}

// plain words for speaking: no markdown, ₹ read as rupees, L as litres
export function speakable(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[*_#>`|]/g, ' ')
    .replace(/\[(.*?)\]\(.*?\)/g, '$1')
    .replace(/₹\s?([\d,]+(?:\.\d+)?)/g, '$1 rupees')
    .replace(/(\d),(?=\d)/g, '$1')                    // 1,23,456 -> 123456 (said right in any accent)
    .replace(/−/g, 'minus ')
    .replace(/(\d)\s?L\b/g, '$1 litres')
    .replace(/\bKL\b/g, 'kilolitres')
    .replace(/\bDr\b/g, 'due').replace(/\bCr\b/g, 'advance')
    .replace(/\s+/g, ' ')
    .trim();
}

// voice: a voice's name from Settings ('' = Jarvis's British voice)
export function speak(text, { voice = '', onEnd = () => {} } = {}) {
  if (!canSpeak) { onEnd(); return; }
  stopSpeaking();
  const words = speakable(text).slice(0, 600);
  const u = new SpeechSynthesisUtterance(words);
  const v = pickVoice(words, voice);
  if (v) { u.voice = v; u.lang = v.lang; } else u.lang = 'en-GB';
  u.rate = 1;
  u.pitch = /Natural|Premium|Enhanced/i.test(v?.name || '') ? 1 : 0.94;   // a touch deeper, unhurried
  u.onend = onEnd;
  u.onerror = onEnd;
  window.speechSynthesis.speak(u);
}

export function stopSpeaking() {
  if (canSpeak) window.speechSynthesis.cancel();
}
