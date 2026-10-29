// TV mode: the app on a TV (the Android TV app opens it with ?tv=1; ?tv=0
// turns it off again). Bigger type for across a room, the remote's arrow
// keys move a highlight between the things to tap (OK taps it), and the
// buttons that need the phone's camera or files are hidden (index.html's
// html.tv styles). A phone never sees any of it.

const KEY = 'vriddhi-decant-tv';
const NATIVE = 'button, a[href], input, select, textarea, summary';
const FOCUSABLE = `${NATIVE}, [tabindex]:not([tabindex="-1"])`;
const DIRS = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };

export function initTv() {
  const asked = new URLSearchParams(location.search).get('tv');
  let on = asked === '1';
  try {
    if (asked === '1') localStorage.setItem(KEY, '1');
    else if (asked === '0') localStorage.removeItem(KEY);
    else on = localStorage.getItem(KEY) === '1';
  } catch { /* private mode: this visit only */ }
  if (!on) return false;
  document.documentElement.classList.add('tv');
  document.addEventListener('keydown', onKey, true);
  // one slim bar: the tabs go into the header
  const header = document.querySelector('header'), tabs = document.getElementById('tabbar');
  if (header && tabs) header.insertBefore(tabs, header.children[1] || null);
  fit();
  addEventListener('resize', fit);
  // what the app draws later (each render) can be reached too
  let pending = 0;
  new MutationObserver(() => {
    clearTimeout(pending);
    pending = setTimeout(reachable, 250);
  }).observe(document.body, { childList: true, subtree: true });
  reachable();
  return true;
}

// Laid out for 960 x 540 (a 1080p or 4K Google TV shows apps at 960 x 540, x2):
// any other screen shows the same, scaled to fill it.
function fit() {
  document.body.style.zoom = String(Math.max(0.5, Math.min(4, innerWidth / 960)));
}

// Whatever the app makes tappable (it shows a hand cursor) and isn't a
// button or a link gets a place in the remote's order.
function reachable() {
  for (const el of document.body.querySelectorAll('*')) {
    if (el.matches(FOCUSABLE) || el.closest('[hidden]') || el.parentElement?.closest('[data-tvtap]')) continue;
    if (getComputedStyle(el).cursor === 'pointer') {
      el.tabIndex = 0;
      el.dataset.tvtap = '';
    }
  }
}

const shown = (el) => {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && !el.closest('[hidden]') && getComputedStyle(el).visibility !== 'hidden'
    && !el.disabled;
};

function onKey(e) {
  const cur = document.activeElement;
  if (e.key === 'Enter' && cur && cur.matches('[data-tvtap]')) {
    e.preventDefault();
    cur.click();                                  // (a button or a link taps itself)
    return;
  }
  const dir = DIRS[e.key];
  if (!dir) return;
  // typing in a field: left / right move along the text
  if (cur && /^(INPUT|TEXTAREA)$/.test(cur.tagName) && dir[0] !== 0) return;
  // an open sheet keeps the highlight inside it
  const scope = [...document.querySelectorAll('.sheet')].find((s) => !s.hidden) || document;
  const all = [...scope.querySelectorAll(FOCUSABLE)].filter(shown);
  if (!all.length) return;
  if (!cur || cur === document.body || !all.includes(cur)) {
    e.preventDefault();
    all[0].focus();
    return;
  }
  const a = cur.getBoundingClientRect();
  const ax = a.left + a.width / 2, ay = a.top + a.height / 2;
  let best = null, bestScore = Infinity;
  for (const el of all) {
    if (el === cur) continue;
    const b = el.getBoundingClientRect();
    const dx = b.left + b.width / 2 - ax, dy = b.top + b.height / 2 - ay;
    const along = dx * dir[0] + dy * dir[1];      // how far that way
    if (along <= 1) continue;
    const across = Math.abs(dir[0] ? dy : dx);    // how far off the line
    const score = along + across * 2.5;
    if (score < bestScore) { bestScore = score; best = el; }
  }
  if (!best) return;                              // nothing that way: the page scrolls
  e.preventDefault();
  best.focus();
  best.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}
