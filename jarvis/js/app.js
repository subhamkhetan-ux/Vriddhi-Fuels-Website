// Jarvis — the screens: chat, voice, pictures, confirmations, settings.
// The work is done by the tools (tools.js → conn/*), chosen by the brain
// (brain.js, Claude) or, without it, by quick commands (quick.js).

import { Brain, makeClient, toolLabel } from './brain.js';
import { HELP, parse } from './quick.js';
import { APPS } from './conn/more.js';
import { configured, session, signIn, signOut } from './session.js';
import { runTool } from './tools.js';
import { canListen, canSpeak, listen, speak, stopSpeaking } from './voice.js';

const DEMO = new URLSearchParams(location.search).has('demo');
const root = document.getElementById('app');
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = (sel, el = document) => el.querySelector(sel);

function localToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ---- settings (this device only) ---------------------------------------------------
const SETTINGS_KEY = 'jarvis-settings';
const DEFAULTS = { brain: 'auto', key: '', effort: 'medium', speak: true, handsFree: false, lang: 'en-IN' };
function loadSettings() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') }; } catch { return { ...DEFAULTS }; }
}
const settings = loadSettings();
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* private window: this visit only */ }
}

const state = {
  attachments: new Map(),     // id -> {file, name, url}
  pending: [],                // attachment ids waiting to be sent
  attSeq: 0,
  busy: false,
  ledger: null,               // ledger session
  mac: null,                  // {online, seen_at}
  brainNote: '',
};

// ---- the brain ------------------------------------------------------------------------
const brainUrl = () => (window.JARVIS_CONFIG?.BRAIN_URL || `${(window.LEDGER_CONFIG?.SUPABASE_URL || '').replace(/\/$/, '')}/functions/v1/jarvis-brain`);

// which brain answers now: 'key' | 'cloud' | null (quick commands)
function brainMode() {
  if (settings.brain === 'quick') return null;
  if (settings.brain === 'key') return settings.key ? 'key' : null;
  if (settings.brain === 'cloud') return state.ledger && !DEMO ? 'cloud' : null;
  if (settings.key) return 'key';
  return state.ledger && !DEMO && !state.cloudMissing ? 'cloud' : null;
}

const brain = new Brain({
  effort: settings.effort,
  getClient: async () => {
    const mode = brainMode();
    if (mode === 'key') return makeClient({ key: settings.key });
    const s = await session('ledger');
    if (!s) throw new Error('Sign in (⚙ Settings) to use the cloud brain.');
    return makeClient({ cloud: { url: brainUrl(), token: s.access_token, anonKey: window.LEDGER_CONFIG.SUPABASE_ANON_KEY } });
  },
});

// ---- layout --------------------------------------------------------------------------
const ICON = {
  gear: '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
  clip: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>',
  mic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M19 10v1a7 7 0 0 1-14 0v-1M12 18v4M8 22h8"/></svg>',
  send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>',
  share: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M7 8l5-5 5 5M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"/></svg>',
  down: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v12M7 11l5 5 5-5M5 20h14"/></svg>',
  plus: '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
};

function shell() {
  root.innerHTML = `
    ${DEMO ? '<div class="demo-flag">DEMO — made-up data, nothing real is changed · <a href="./" style="color:#241400">leave the demo</a></div>' : ''}
    <header class="top">
      <div class="brand"><div class="orb" aria-hidden="true"></div><div>Jarvis<small>Vriddhi Fuels</small></div></div>
      <div class="spacer"></div>
      <div class="pills" id="pills"></div>
      <button class="icon-btn" id="new-chat" title="New chat" aria-label="New chat">${ICON.plus}</button>
      <button class="icon-btn" id="open-settings" title="Settings" aria-label="Settings">${ICON.gear}</button>
    </header>
    <main id="chat" aria-live="polite"></main>
    <footer class="composer">
      <div class="pending" id="pending"></div>
      <div class="box">
        <button class="round" id="attach" title="Attach a picture (e.g. the tank screen)" aria-label="Attach a picture">${ICON.clip}</button>
        <textarea id="input" rows="1" placeholder="Ask Jarvis…" aria-label="Message"></textarea>
        <button class="round send" id="send" title="Send" aria-label="Send" hidden>${ICON.send}</button>
        <button class="round mic" id="mic" title="Speak" aria-label="Speak">${ICON.mic}</button>
      </div>
      <div class="hint" id="hint"></div>
      <input type="file" id="file" accept="image/*" multiple hidden>
    </footer>`;
  $('#open-settings').onclick = () => openSettings();
  $('#new-chat').onclick = () => { brain.reset(); stopSpeaking(); welcome(); };
  $('#attach').onclick = () => $('#file').click();
  $('#file').onchange = (e) => { addFiles([...e.target.files]); e.target.value = ''; };
  const input = $('#input');
  const sync = () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(140, input.scrollHeight)}px`;
    const has = input.value.trim() || state.pending.length;
    $('#send').hidden = !has;
    $('#mic').hidden = Boolean(has) && !state.listening;
  };
  input.addEventListener('input', sync);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
  });
  $('#send').onclick = () => submit();
  $('#mic').onclick = () => toggleListen();
  state.syncComposer = sync;
  sync();
  // paste / drop a screenshot
  input.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
    if (files.length) { e.preventDefault(); addFiles(files); }
  });
  root.addEventListener('dragover', (e) => e.preventDefault());
  root.addEventListener('drop', (e) => {
    e.preventDefault();
    addFiles([...(e.dataTransfer?.files || [])].filter((f) => f.type.startsWith('image/')));
  });
}

function hint(text) { const h = $('#hint'); if (h) h.textContent = text || ''; }
function toast(text) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = text;
  document.body.append(t);
  setTimeout(() => t.remove(), 3000);
}

function renderPills() {
  const el = $('#pills');
  if (!el) return;
  const mode = brainMode();
  const pills = [];
  pills.push(DEMO ? '<span class="pill wait">Demo</span>' : state.ledger ? `<span class="pill ok">${esc(state.ledger.user?.email || 'Signed in')}</span>` : '<span class="pill off">Not signed in</span>');
  pills.push(`<span class="pill ${mode ? 'ok' : 'wait'}" title="${esc(state.brainNote)}">${mode ? 'AI brain' : 'Quick commands'}</span>`);
  if (state.mac) pills.push(`<span class="pill ${state.mac.online ? 'ok' : 'off'}">Mac ${state.mac.online ? 'online' : 'offline'}</span>`);
  el.innerHTML = pills.join('');
}

// ---- welcome ------------------------------------------------------------------------
const STARTERS = [
  'Outstanding list', 'Tank stock', 'XtraPower status', 'Sales yesterday', 'Trucks to decant', 'Fleet status', 'Payments',
];
function welcome() {
  const h = new Date().getHours();
  const greet = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
  const chat = $('#chat');
  chat.innerHTML = `<section class="hello">
      <div class="orb" aria-hidden="true"></div>
      <h1>${greet}. I'm <b>Jarvis</b>.</h1>
      <p>Ask about any app — by typing or tapping the mic. Send a screenshot of the tank screen and I'll update Decant.</p>
      <div class="chips">${STARTERS.map((s) => `<button class="chip" data-say="${esc(s)}">${esc(s)}</button>`).join('')}</div>
      ${!DEMO && !state.ledger ? `<div class="row" style="justify-content:center;margin-top:14px"><button class="btn cta" data-signin>Sign in (your Ledger login)</button><a class="btn" href="?demo">Try the demo</a></div>` : ''}
      <p class="section-title">All apps</p>
      <div class="apps">${APPS.map((a) => `<a class="app-tile" href="${a.href}"><b>${a.icon} ${esc(a.name)}</b><span>${esc(a.what)}</span></a>`).join('')}</div>
    </section>`;
  chat.querySelectorAll('[data-say]').forEach((b) => { b.onclick = () => submit(b.dataset.say); });
  chat.querySelector('[data-signin]')?.addEventListener('click', () => openSettings('logins'));
}

// ---- attachments -------------------------------------------------------------------
function addFiles(files) {
  for (const file of files) {
    if (!file.type.startsWith('image/')) continue;
    const id = `att${++state.attSeq}`;
    state.attachments.set(id, { file, name: file.name || `${id}.jpg`, url: URL.createObjectURL(file) });
    state.pending.push(id);
  }
  renderPending();
}
function renderPending() {
  const el = $('#pending');
  el.innerHTML = state.pending.map((id) => `<div class="att"><img src="${state.attachments.get(id).url}" alt=""><button data-rm="${id}" aria-label="Remove">✕</button></div>`).join('');
  el.querySelectorAll('[data-rm]').forEach((b) => { b.onclick = () => { state.pending = state.pending.filter((x) => x !== b.dataset.rm); renderPending(); }; });
  state.syncComposer?.();
}

// a picture for Claude: JPEG, longest side ≤ 1568 px
async function imageBlock(file) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 1568 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * scale);
  c.height = Math.round(bmp.height * scale);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  const data = c.toDataURL('image/jpeg', 0.85).split(',')[1];
  return { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } };
}

// ---- messages -----------------------------------------------------------------------
function scrollDown() { const c = $('#chat'); c.scrollTop = c.scrollHeight; }

function userBubble(text, ids) {
  $('.hello')?.remove();
  const m = document.createElement('div');
  m.className = 'msg me';
  m.innerHTML = `<div class="bubble">${ids.length ? `<div class="thumbs">${ids.map((id) => `<img src="${state.attachments.get(id).url}" alt="attached picture">`).join('')}</div>` : ''}${esc(text)}</div>`;
  $('#chat').append(m);
  scrollDown();
}

function jarvisBubble() {
  const m = document.createElement('div');
  m.className = 'msg jarvis';
  m.innerHTML = '<div class="bubble"><div class="steps"></div><div class="text"><span class="muted">Thinking…</span></div><div class="extras"></div></div>';
  $('#chat').append(m);
  scrollDown();
  const b = m.querySelector('.bubble');
  return {
    el: b,
    steps: b.querySelector('.steps'),
    text: b.querySelector('.text'),
    extras: b.querySelector('.extras'),
    progressEl: null,
  };
}

// a little markdown: **bold**, lists, paragraphs, links
function md(text) {
  const blocks = esc(text).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\[(.+?)\]\((https?:[^)\s]+|\.\.?\/[^)\s]*)\)/g, '<a href="$2">$1</a>').split(/\n{2,}/);
  return blocks.map((b) => {
    const lines = b.split('\n');
    if (lines.every((l) => /^\s*([-•*]|\d+\.)\s+/.test(l))) return `<ul>${lines.map((l) => `<li>${l.replace(/^\s*([-•*]|\d+\.)\s+/, '')}</li>`).join('')}</ul>`;
    return `<p>${lines.join('<br>')}</p>`;
  }).join('');
}

function stepLine(bub, key, label, status, detail = '') {
  let el = bub.steps.querySelector(`[data-k="${key}"]`);
  if (!el) {
    el = document.createElement('div');
    el.dataset.k = key;
    bub.steps.append(el);
  }
  el.className = `step ${status}`;
  el.innerHTML = `${esc(label)}${detail ? ` <em>· ${esc(detail)}</em>` : ''}`;
  scrollDown();
}

async function shareFiles(files, title) {
  try {
    if (navigator.canShare && navigator.canShare({ files })) { await navigator.share({ files, title }); return; }
  } catch (e) {
    if (e?.name === 'AbortError') return;
  }
  for (const f of files) download(f);
}
function download(file) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = file.name;
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}

function showResultExtras(bub, result, tool) {
  if (!result) return;
  if (result.images?.length) {
    const box = document.createElement('div');
    box.className = 'pics';
    for (const img of result.images) {
      const url = URL.createObjectURL(img.file);
      const pic = document.createElement('div');
      pic.className = 'pic';
      pic.innerHTML = `<img src="${url}" alt="${esc(img.title)}"><div class="bar"><span>${esc(img.title)}</span>
        <button class="btn small" data-share>${ICON.share}Share</button><button class="btn small" data-down aria-label="Download">${ICON.down}</button></div>`;
      pic.querySelector('img').onclick = () => viewImage(url);
      pic.querySelector('[data-share]').onclick = () => shareFiles([img.file], img.title);
      pic.querySelector('[data-down]').onclick = () => download(img.file);
      box.append(pic);
    }
    bub.extras.append(box);
    if (result.images.length > 1) {
      const row = document.createElement('div');
      row.className = 'row';
      row.innerHTML = `<button class="btn">${ICON.share} Share all ${result.images.length}</button>`;
      row.firstChild.onclick = () => shareFiles(result.images.map((i) => i.file), toolLabel(tool, {}));
      bub.extras.append(row);
    }
  }
  if (result.links?.length) {
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = result.links.map((l) => `<a class="btn cta" href="${esc(l.href)}">${esc(l.label)}</a>`).join('');
    bub.extras.append(row);
  }
  scrollDown();
}

function showNeedsLogin(bub, out) {
  if (!out?.needsLogin) return;
  const row = document.createElement('div');
  row.className = 'row';
  row.innerHTML = '<button class="btn cta">Sign in</button>';
  row.firstChild.onclick = () => openSettings('logins');
  bub.extras.append(row);
}

function viewImage(url) {
  const v = document.createElement('div');
  v.className = 'viewer';
  v.innerHTML = `<img src="${url}" alt="">`;
  v.onclick = () => v.remove();
  document.body.append(v);
}

// the owner confirms a write in the chat: {title, rows: [[cells]], notes, ok}
function confirmIn(bub) {
  return (card) => new Promise((resolve) => {
    const box = document.createElement('div');
    box.className = 'confirm';
    box.innerHTML = `<b>${esc(card.title)}</b>
      ${card.rows?.length ? `<table>${card.rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</table>` : ''}
      ${(card.notes || []).filter(Boolean).map((n) => `<div class="note">⚠ ${esc(n)}</div>`).join('')}
      <div class="row"><button class="btn cta" data-yes>${esc(card.ok || 'Yes')}</button><button class="btn" data-no>Cancel</button></div>`;
    const done = (yes) => {
      box.classList.add('done');
      box.querySelectorAll('button').forEach((b) => { b.disabled = true; });
      box.querySelector('.row').insertAdjacentHTML('beforeend', `<span class="muted">${yes ? '✓ Confirmed' : 'Cancelled'}</span>`);
      resolve(yes);
    };
    box.querySelector('[data-yes]').onclick = () => done(true);
    box.querySelector('[data-no]').onclick = () => done(false);
    bub.extras.append(box);
    scrollDown();
    if (settings.speak) speak(`${card.title} Please confirm on the screen.`, { lang: settings.lang });
  });
}

function ctxFor(bub) {
  return {
    demo: DEMO,
    today: localToday(),
    attachments: state.attachments,
    confirm: confirmIn(bub),
    progress: (text) => { bub.text.innerHTML = `<span class="muted">${esc(text)}</span>`; scrollDown(); },
  };
}

// ---- sending ------------------------------------------------------------------------
async function submit(preset) {
  if (state.busy) return;
  const input = $('#input');
  const text = (preset ?? input.value).trim();
  const ids = preset ? [] : [...state.pending];
  if (!text && !ids.length) return;
  input.value = '';
  state.pending = [];
  renderPending();                                  // also resets the send / mic buttons
  userBubble(text, ids);
  state.busy = true;
  document.body.classList.add('thinking');
  const bub = jarvisBubble();
  let reply = '';
  try {
    reply = brainMode() ? await askBrain(text, ids, bub) : await askQuick(text, ids, bub);
  } catch (err) {
    reply = '';
    bub.text.innerHTML = `<p class="err">${esc(err.message || err)}</p>`;
    if (err.needsLogin) showNeedsLogin(bub, err);
  } finally {
    state.busy = false;
    document.body.classList.remove('thinking');
  }
  if (reply) {
    bub.text.innerHTML = md(reply);
    if (settings.speak) speak(reply, { lang: settings.lang, onEnd: () => { if (settings.handsFree && canListen) toggleListen(true); } });
    else if (settings.handsFree && canListen) toggleListen(true);
  } else if (bub.text.textContent === 'Thinking…') bub.text.innerHTML = '<span class="muted">Done.</span>';
  scrollDown();
}

async function askBrain(text, ids, bub) {
  const content = [];
  for (const id of ids) content.push(await imageBlock(state.attachments.get(id).file));
  const tag = ids.length ? `[Attached: ${ids.map((id) => `${id} (${state.attachments.get(id).name})`).join(', ')}]\n` : '';
  content.push({ type: 'text', text: `${tag}${text || (ids.length ? '(picture only)' : '')}` });
  let n = 0;
  const keys = new Map();
  try {
    return await brain.turn(content, ctxFor(bub), {
      text: (t) => { bub.text.innerHTML = md(t); },
      step: (name, input, status, out) => {
        const sig = `${name}:${JSON.stringify(input)}`;
        if (!keys.has(sig)) keys.set(sig, `s${++n}`);
        stepLine(bub, keys.get(sig), toolLabel(name, input), status, status === 'failed' ? out?.error : '');
        if (status === 'done') showResultExtras(bub, out.result, name);
        if (status === 'failed') showNeedsLogin(bub, out);
      },
    });
  } catch (err) {
    // the cloud brain isn't deployed: say so once and carry on with quick commands
    if (brainMode() === 'cloud' && (err.status === 404 || /ANTHROPIC_API_KEY/.test(err.message))) {
      state.cloudMissing = true;
      state.brainNote = err.message;
      renderPills();
      bub.steps.innerHTML = '';
      const r = await askQuick(text, ids, bub);
      return `${r}\n\n(${err.message} Using quick commands meanwhile.)`;
    }
    throw err;
  }
}

async function askQuick(text, ids, bub) {
  const q = parse(text, { attachments: ids });
  if (q?.help || !q) {
    bub.extras.innerHTML = `<div class="chips" style="justify-content:flex-start;margin-top:6px">${HELP.map(([s, what]) => (s.startsWith('📎')
      ? `<span class="chip" title="${esc(what)}">${esc(s)}</span>`
      : `<button class="chip" data-say="${esc(s.split(' / ')[0])}" title="${esc(what)}">${esc(s)}</button>`)).join('')}</div>`;
    bub.extras.querySelectorAll('[data-say]').forEach((b) => { b.onclick = () => submit(b.dataset.say); });
    return q?.help ? 'Here\'s what I can do. Tap one, or say it.'
      : 'I didn\'t catch that as a quick command. Try one of these — or set up the AI brain (⚙ Settings) and ask anything.';
  }
  stepLine(bub, 's1', toolLabel(q.tool, q.input), 'running');
  const out = await runTool(q.tool, q.input, ctxFor(bub));
  stepLine(bub, 's1', toolLabel(q.tool, q.input), out.ok ? 'done' : 'failed');
  if (!out.ok) {
    showNeedsLogin(bub, out);
    const e = new Error(out.error);
    throw e;
  }
  showResultExtras(bub, out.result, q.tool);
  return out.result.say || 'Done.';
}

// ---- voice --------------------------------------------------------------------------
async function toggleListen(auto = false) {
  if (state.listening) { state.listenP?.stop(); return; }
  if (!canListen) { toast('Voice input isn\'t supported in this browser — try Chrome or Safari.'); return; }
  stopSpeaking();
  state.listening = true;
  document.body.classList.add('listening');
  hint(auto ? 'Listening… (hands-free)' : 'Listening… tap the mic to stop');
  const input = $('#input');
  try {
    state.listenP = listen({ lang: settings.lang, onPartial: (t) => { input.value = t; state.syncComposer(); } });
    const said = await state.listenP;
    state.listening = false;
    document.body.classList.remove('listening');
    hint('');
    if (said) { input.value = said; submit(); } else state.syncComposer();
  } catch (err) {
    state.listening = false;
    document.body.classList.remove('listening');
    hint('');
    toast(err.message);
  }
}

// ---- settings -------------------------------------------------------------------------
async function openSettings(focus = '') {
  const sheet = document.createElement('div');
  sheet.className = 'sheet';
  const close = () => { sheet.remove(); refreshStatus(); };
  sheet.onclick = (e) => { if (e.target === sheet) close(); };
  const fleetS = configured('fleet') ? await session('fleet').catch(() => null) : null;
  let loadingUser = '';
  try { loadingUser = (await import('../../decant/js/tankers.js')).tankers.user; } catch { /* not loaded */ }
  sheet.innerHTML = `<div class="panel" role="dialog" aria-label="Settings">
    <div style="display:flex;justify-content:space-between;align-items:center"><h2>Settings</h2><button class="icon-btn" data-close aria-label="Close">✕</button></div>

    <h3 id="logins">Logins</h3>
    <div class="login" data-login="ledger">
      <div class="head"><div><b>📒 Ledger</b> — your Jarvis login <span class="muted">(also the Mac link and the cloud brain)</span></div>
        ${state.ledger ? '<button class="btn small" data-out="ledger">Sign out</button>' : ''}</div>
      ${state.ledger ? `<div class="ok-text">Signed in as ${esc(state.ledger.user?.email)}</div>`
    : `<div class="field"><input type="email" placeholder="Email" autocomplete="username" data-email></div>
         <div class="field"><input type="password" placeholder="Password" autocomplete="current-password" data-pass></div>
         <button class="btn cta" data-in="ledger">Sign in</button> <span class="muted" data-msg></span>`}
    </div>
    <div class="login" data-login="fleet">
      <div class="head"><div><b>🚛 Fleet</b></div>${fleetS ? '<button class="btn small" data-out="fleet">Sign out</button>' : ''}</div>
      ${fleetS ? `<div class="ok-text">Signed in as ${esc(fleetS.user?.email)}</div>`
    : configured('fleet') ? `<div class="field"><input type="email" placeholder="Email" data-email></div>
         <div class="field"><input type="password" placeholder="Password" data-pass></div>
         <button class="btn" data-in="fleet">Sign in</button> <span class="muted" data-msg></span>` : '<div class="muted">The Fleet app isn\'t connected to its database.</div>'}
    </div>
    <div class="login" data-login="loading">
      <div class="head"><div><b>🛢️ Loading</b> <span class="muted">(Loading-app username)</span></div>${loadingUser ? '<button class="btn small" data-out="loading">Sign out</button>' : ''}</div>
      ${loadingUser ? `<div class="ok-text">Signed in as ${esc(loadingUser)}</div>`
    : `<div class="field"><input placeholder="Username" data-email></div>
         <div class="field"><input type="password" placeholder="Password" data-pass></div>
         <button class="btn" data-in="loading">Sign in</button> <span class="muted" data-msg></span>`}
    </div>

    <h3>Brain</h3>
    ${[
    ['auto', 'Automatic', 'Your own key if set, else the cloud brain when signed in, else quick commands.'],
    ['cloud', 'Cloud brain', 'Claude through the jarvis-brain function in the ledger project — the API key stays in Supabase. Needs one-time setup (jarvis/README.md).'],
    ['key', 'My API key on this device', 'Paste an Anthropic API key; it is kept only in this browser.'],
    ['quick', 'Quick commands only', 'No AI: fixed phrases like "outstanding of SMC", "tank stock", "start monitoring Ember". Free and instant.'],
  ].map(([v, t, d]) => `<label class="opt"><input type="radio" name="brain" value="${v}" ${settings.brain === v ? 'checked' : ''}><div><b>${t}</b><span>${d}</span></div></label>`).join('')}
    <div class="field">Anthropic API key (only for "My API key")<input type="password" data-key placeholder="sk-ant-…" value="${esc(settings.key)}" autocomplete="off"></div>
    <div class="field">How hard to think<select data-effort>${[['low', 'Fast'], ['medium', 'Balanced (default)'], ['high', 'Thorough']].map(([v, t]) => `<option value="${v}" ${settings.effort === v ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
    ${state.brainNote ? `<div class="warn-text" style="font-size:13px">${esc(state.brainNote)}</div>` : ''}

    <h3>Voice</h3>
    <label class="opt"><input type="checkbox" data-speak ${settings.speak ? 'checked' : ''} ${canSpeak ? '' : 'disabled'}><div><b>Speak the answers</b><span>${canSpeak ? 'Jarvis reads each reply aloud.' : 'Not supported in this browser.'}</span></div></label>
    <label class="opt"><input type="checkbox" data-hands ${settings.handsFree ? 'checked' : ''} ${canListen ? '' : 'disabled'}><div><b>Hands-free</b><span>After answering, Jarvis listens again — talk back without touching the phone.</span></div></label>
    <div class="field">Language<select data-lang>${[['en-IN', 'English (India)'], ['hi-IN', 'हिन्दी / Hinglish'], ['en-US', 'English (US)']].map(([v, t]) => `<option value="${v}" ${settings.lang === v ? 'selected' : ''}>${t}</option>`).join('')}</select></div>

    <h3>Mac</h3>
    <div class="muted" style="font-size:13px">${state.mac ? (state.mac.online ? '<span class="ok-text">● The Mac bridge is online.</span>' : `<span class="bad-text">● Offline</span> — last seen ${esc(new Date(state.mac.seen_at).toLocaleString('en-IN'))}. On the Mac: <code>./jarvis/bridge/bridge-mac.sh start</code>`) : 'Sign in to see the Mac. Setup: jarvis/README.md → "The Mac bridge".'}</div>
    <div class="row" style="margin-top:18px"><button class="btn cta" data-close>Done</button></div>
  </div>`;
  document.body.append(sheet);
  sheet.querySelectorAll('[data-close]').forEach((b) => { b.onclick = close; });
  if (focus) sheet.querySelector(`#${focus}`)?.scrollIntoView();

  sheet.querySelectorAll('[data-in]').forEach((b) => {
    b.onclick = async () => {
      const box = b.closest('.login');
      const msg = box.querySelector('[data-msg]');
      msg.textContent = 'Signing in…';
      try {
        const email = box.querySelector('[data-email]').value;
        const pass = box.querySelector('[data-pass]').value;
        if (b.dataset.in === 'loading') await (await import('../../decant/js/tankers.js')).tankersSignIn(email, pass);
        else await signIn(b.dataset.in, email, pass);
        sheet.remove();
        await refreshStatus();
        openSettings('logins');
        if (b.dataset.in === 'ledger') welcome();
      } catch (err) { msg.textContent = err.message; msg.className = 'bad-text'; }
    };
  });
  sheet.querySelectorAll('[data-out]').forEach((b) => {
    b.onclick = async () => {
      if (b.dataset.out === 'loading') await (await import('../../decant/js/tankers.js')).tankersSignOut();
      else await signOut(b.dataset.out);
      sheet.remove();
      await refreshStatus();
      openSettings('logins');
    };
  });
  sheet.querySelectorAll('input[name=brain]').forEach((r) => { r.onchange = () => { settings.brain = r.value; state.cloudMissing = false; state.brainNote = ''; saveSettings(); renderPills(); }; });
  sheet.querySelector('[data-key]').onchange = (e) => { settings.key = e.target.value.trim(); saveSettings(); renderPills(); };
  sheet.querySelector('[data-effort]').onchange = (e) => { settings.effort = e.target.value; brain.effort = settings.effort; saveSettings(); };
  sheet.querySelector('[data-speak]').onchange = (e) => { settings.speak = e.target.checked; if (!settings.speak) stopSpeaking(); saveSettings(); };
  sheet.querySelector('[data-hands]').onchange = (e) => { settings.handsFree = e.target.checked; saveSettings(); };
  sheet.querySelector('[data-lang]').onchange = (e) => { settings.lang = e.target.value; saveSettings(); };
}

// ---- status ---------------------------------------------------------------------------
async function refreshStatus() {
  if (!DEMO) {
    state.ledger = configured('ledger') ? await session('ledger').catch(() => null) : null;
    if (state.ledger) {
      try {
        const c = await (await import('./session.js')).client('ledger');
        const { data, error } = await c.rpc('jarvis_bridges_list');
        state.mac = error ? null : (data || []).find((b) => b.name === 'mac') || { online: false, seen_at: null, never: true };
        if (state.mac?.never) state.mac = null;
      } catch { state.mac = null; }
    } else state.mac = null;
  } else state.mac = { online: true };
  renderPills();
}

// ---- start ----------------------------------------------------------------------------
shell();
welcome();
refreshStatus().then(() => {
  if ($('.hello')) welcome();                     // now with the right sign-in buttons
  const q = new URLSearchParams(location.search).get('q');   // e.g. a home-screen shortcut: ?q=tank stock
  if (q) submit(q);
});
setInterval(() => { if (!state.busy) refreshStatus(); }, 60000);
