// Jarvis's voice: the best British man's voice the device has, and spoken
// words that read right in that accent.
import assert from 'node:assert/strict';
import test from 'node:test';

let voices = [];
const spoken = [];
globalThis.window = {
  speechSynthesis: {
    getVoices: () => voices,
    addEventListener: (_e, fn) => { globalThis.reload = fn; },
    speak: (u) => spoken.push(u),
    cancel: () => {},
  },
};
globalThis.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
const { britishVoice, speak, speakable, voiceList } = await import('../../jarvis/js/voice.js');
const device = (list) => { voices = list.map(([name, lang]) => ({ name, lang })); globalThis.reload(); };

test('the best British man first, on each kind of device', () => {
  device([['Samantha', 'en-US'], ['Rishi', 'en-IN'], ['Serena', 'en-GB'], ['Daniel', 'en-GB'], ['Daniel (Enhanced)', 'en-GB']]);
  assert.equal(britishVoice().name, 'Daniel (Enhanced)');                    // iPhone with the better Daniel
  device([['Microsoft Sonia Online (Natural) - English (United Kingdom)', 'en-GB'], ['Microsoft Ryan Online (Natural) - English (United Kingdom)', 'en-GB']]);
  assert.match(britishVoice().name, /Ryan/);                                 // Edge
  device([['Google US English', 'en-US'], ['Google UK English Female', 'en-GB'], ['Google UK English Male', 'en-GB']]);
  assert.equal(britishVoice().name, 'Google UK English Male');               // Chrome on a computer
  device([['English United Kingdom', 'en_GB'], ['en-gb-x-gbb-network', 'en-GB']]);
  assert.equal(britishVoice().name, 'en-gb-x-gbb-network');                  // Android
  device([['Kate', 'en-GB'], ['Arthur', 'en-GB']]);
  assert.equal(britishVoice().name, 'Arthur');
  device([['Samantha', 'en-US']]);
  assert.equal(britishVoice(), null);
});

test('speaking: British by default, the picked voice when set, Hindi script in a Hindi voice', () => {
  device([['Daniel', 'en-GB'], ['Rishi', 'en-IN'], ['Lekha', 'hi-IN']]);
  speak('Tank stock is ₹1,23,456');
  assert.equal(spoken.at(-1).voice.name, 'Daniel');
  assert.equal(spoken.at(-1).lang, 'en-GB');
  assert.equal(spoken.at(-1).text, 'Tank stock is 123456 rupees');
  speak('Hello', { voice: 'Rishi' });
  assert.equal(spoken.at(-1).voice.name, 'Rishi');
  speak('Hello', { voice: 'Gone from this phone' });
  assert.equal(spoken.at(-1).voice.name, 'Daniel');
  speak('नमस्ते');
  assert.equal(spoken.at(-1).voice.name, 'Lekha');
  assert.deepEqual(voiceList().map((v) => v.name), ['Daniel', 'Rishi', 'Lekha']);   // British first
  assert.equal(speakable('Balance 12,500 Dr'), 'Balance 12500 due');
});
