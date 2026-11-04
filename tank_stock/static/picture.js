// The decant app's decanting picture on this page — the truck, its chambers
// emptying, the pipe, the tanks filling — drawn here on the phone by the decant
// app's own code (decant/js/scene.js, served at decant-js/), from the running
// decantation's "scene" (auto.py). app.js draws it once this has loaded.
import { decantScene, runScenes } from './decant-js/scene.js';

window.tsScene = { decantScene };
runScenes();                                  // (moves every picture on the page by the clock; idle without one)
window.dispatchEvent(new Event('tsscene'));
