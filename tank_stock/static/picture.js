// The decant app's decanting picture on this page — the truck, its chambers
// emptying, the pipe, the tanks filling — drawn here on the phone by the decant
// app's own code (decant/js/scene.js, served at decant-js/), from the running
// decantation's "scene" (auto.py). app.js draws it once this has loaded.
// Its spoken instructions too (decant/js/voice.js): English or Hindi, each said once.
import { decantScene, runScenes, updateScene } from './decant-js/scene.js';
import { sayOnce, setVoice, setVoiceLang, voiceAvailable, voiceLang, voiceOn } from './decant-js/voice.js';

window.tsScene = { decantScene, updateScene };
window.tsVoice = { sayOnce, setVoice, setVoiceLang, voiceAvailable, voiceLang, voiceOn };
runScenes();                                  // (moves every picture on the page by the clock; idle without one)
window.dispatchEvent(new Event('tsscene'));
