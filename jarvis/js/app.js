// Jarvis — the screens: chat, voice, pictures, confirmations, settings.
// The work is done by the tools (tools.js → conn/*), chosen by the built-in
// brain (engine.js — no AI service, the default) or, if the owner switches it
// on, by Claude (brain.js). Jarvis never depends on the AI: when it is off or
// unreachable, the built-in brain answers.

import { Brain, makeClient, toolLabel } from './brain.js';
import { newMemory, remember, understand } from './engine.js';
import { HELP } from './quick.js';
import { APPS } from './conn/more.js';
import { buildLexicon, noteNames } from './lexicon.js';
import { PROJECTS, configured, session, signIn, signOut } from './session.js';
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
const DEFAULTS = { brain: 'builtin', key: '', effort: 'medium', speak: true, handsFree: false, lang: 'en-IN' };
function loadSettings() {
  let s;
  try { s = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') }; } catch { s = { ...DEFAULTS }; }
  if (!['builtin', 'cloud', 'key'].includes(s.brain)) s.brain = 'builtin';
  return s;
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
  memory: newMemory(),        // the built-in brain's thread of the conversation
  choices: null,              // "which one?" offered last time
  lexicon: {},                // the owner's names (lexicon.js)
};

let lexAt = 0;
async function refreshLexicon(force = false) {
  if (!force && Date.now() - lexAt < 10 * 60000) return;
  lexAt = Date.now();
  try { state.lexicon = await buildLexicon({ demo: DEMO, today: localToday() }); } catch { /* names come later */ }
}

// what a file is for: a picture (tank screen), an invoice PDF, a DayBook Excel
const kindOf = (f) => (f.type.startsWith('image/') ? 'image' : /pdf/.test(f.type) || /\.pdf$/i.test(f.name) ? 'pdf'
  : /sheet|excel/.test(f.type) || /\.xls[xm]?$/i.test(f.name) ? 'excel' : null);

// ---- the brain ------------------------------------------------------------------------
const brainUrl = () => (window.JARVIS_CONFIG?.BRAIN_URL || `${(window.LEDGER_CONFIG?.SUPABASE_URL || '').replace(/\/$/, '')}/functions/v1/jarvis-brain`);

// Claude only when the owner switched it on and it can work: 'key' | 'cloud';
// otherwise null = the built-in brain (the default)
function brainMode() {
  if (settings.brain === 'key' && settings.key) return 'key';
  if (settings.brain === 'cloud' && state.ledger && !DEMO && !state.cloudMissing) return 'cloud';
  return null;
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
        <button class="round" id="attach" title="Attach a tank-screen picture, an invoice PDF or a DayBook Excel" aria-label="Attach a file">${ICON.clip}</button>
        <textarea id="input" rows="1" placeholder="Ask Jarvis…" aria-label="Message"></textarea>
        <button class="round send" id="send" title="Send" aria-label="Send" hidden>${ICON.send}</button>
        <button class="round mic" id="mic" title="Speak" aria-label="Speak">${ICON.mic}</button>
      </div>
      <div class="hint" id="hint"></div>
      <input type="file" id="file" accept="image/*,.pdf,.xlsx,.xls,.xlsm" multiple hidden>
    </footer>`;
  $('#open-settings').onclick = () => openSettings();
  $('#new-chat').onclick = () => { brain.reset(); state.memory = newMemory(); state.choices = null; stopSpeaking(); welcome(); };
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
    const files = [...(e.clipboardData?.files || [])].filter(kindOf);
    if (files.length) { e.preventDefault(); addFiles(files); }
  });
  root.addEventListener('dragover', (e) => e.preventDefault());
  root.addEventListener('drop', (e) => {
    e.preventDefault();
    addFiles([...(e.dataTransfer?.files || [])].filter(kindOf));
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
  pills.push(`<span class="pill ${mode ? 'ok' : 'wait'}" title="${esc(state.brainNote)}">${mode ? 'Claude AI' : 'Built-in brain'}</span>`);
  if (state.mac) pills.push(`<span class="pill ${state.mac.online ? 'ok' : 'off'}">Mac ${state.mac.online ? 'online' : 'offline'}</span>`);
  el.innerHTML = pills.join('');
}

// ---- welcome ------------------------------------------------------------------------
const STARTERS = [
  'Good morning', 'Outstanding list', 'Which customers owe more than 5 lakh?', 'Compare diesel sales this month vs last month',
  'Top 5 customers by litres this FY', 'Tank stock', 'Can I order 12 KL diesel?', 'XtraPower status', 'Pending indents', 'POs running low',
];
function welcome() {
  const h = new Date().getHours();
  const greet = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
  const chat = $('#chat');
  chat.innerHTML = `<section class="hello">
      <div class="orb" aria-hidden="true"></div>
      <h1>${greet}. I'm <b>Jarvis</b>.</h1>
      <p>Ask anything about any app, or tell me what to do — by typing or tapping the mic. 📎 a tank-screen picture, an invoice PDF or the DayBook Excel and I'll put it in the right app.</p>
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
    const kind = kindOf(file);
    if (!kind) { toast(`${file.name}: attach a picture, a PDF or an Excel file.`); continue; }
    const id = `att${++state.attSeq}`;
    state.attachments.set(id, { file, kind, name: file.name || `${id}.jpg`, url: kind === 'image' ? URL.createObjectURL(file) : '' });
    state.pending.push(id);
  }
  renderPending();
}
const fileThumb = (a, cls = '') => (a.kind === 'image' ? `<img src="${a.url}" alt="attached picture"${cls}>`
  : `<span class="file-chip">${a.kind === 'pdf' ? '📄' : '📊'} ${esc(a.name)}</span>`);
function renderPending() {
  const el = $('#pending');
  el.innerHTML = state.pending.map((id) => `<div class="att">${fileThumb(state.attachments.get(id))}<button data-rm="${id}" aria-label="Remove">✕</button></div>`).join('');
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
  m.innerHTML = `<div class="bubble">${ids.length ? `<div class="thumbs">${ids.map((id) => fileThumb(state.attachments.get(id))).join('')}</div>` : ''}${esc(text)}</div>`;
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
  const blocks = esc(text).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/(^|\s)_(.+?)_(?=\s|$)/g, '$1<em class="muted">$2</em>').replace(/\[(.+?)\]\((https?:[^)\s]+|\.\.?\/[^)\s]*)\)/g, '<a href="$2">$1</a>').split(/\n{2,}/);
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
  if (result.summary?.accounts?.length && tool.startsWith('xtrapower')) noteNames('accounts', result.summary.accounts.map((a) => a.label));
  if (result.summary?.scripts?.length) noteNames('scripts', result.summary.scripts);
  if (result.table?.rows?.length) {
    const t = result.table;
    const box = document.createElement('div');
    box.className = 'tbl';
    box.innerHTML = `<table><thead><tr>${t.columns.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>
      <tbody>${t.rows.slice(0, 100).map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>
      ${t.rows.length > 100 ? `<div class="muted">…and ${t.rows.length - 100} more</div>` : ''}`;
    bub.extras.append(box);
  }
  if (result.choices?.length) {
    state.choices = result.choices;               // "the second one" / a name works next time too
    const box = document.createElement('div');
    box.className = 'chips';
    box.style.cssText = 'justify-content:flex-start;margin-top:8px';
    box.innerHTML = result.choices.map((c, i) => `<button class="chip" data-choice="${i}">${esc(c.label)}</button>`).join('');
    box.querySelectorAll('[data-choice]').forEach((b) => { b.onclick = () => submit(result.choices[Number(b.dataset.choice)].label); });
    bub.extras.append(box);
  }
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
    reply = brainMode() ? await askBrain(text, ids, bub) : await askBuiltin(text, ids, bub);
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
  for (const id of ids) if (state.attachments.get(id).kind === 'image') content.push(await imageBlock(state.attachments.get(id).file));
  const tag = ids.length ? `[Attached: ${ids.map((id) => `${id} (${state.attachments.get(id).kind}: ${state.attachments.get(id).name})`).join(', ')}]\n` : '';
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
    // Claude unavailable (no credit, offline, not set up…): the built-in brain answers
    if (brainMode() === 'cloud' && (err.status === 404 || /ANTHROPIC_API_KEY/.test(err.message))) state.cloudMissing = true;
    state.brainNote = err.message;
    renderPills();
    bub.steps.innerHTML = '';
    bub.extras.innerHTML = '';
    const r = await askBuiltin(text, ids, bub);
    return `${r}\n\n_(Claude isn't available — ${err.message} The built-in brain answered.)_`;
  }
}

function helpChips(bub, phrases = null) {
  const items = phrases ? phrases.map((p) => [p, '']) : HELP;
  const box = document.createElement('div');
  box.className = 'chips';
  box.style.cssText = 'justify-content:flex-start;margin-top:6px';
  box.innerHTML = items.map(([s, what]) => (s.startsWith('📎')
    ? `<span class="chip" title="${esc(what)}">${esc(s)}</span>`
    : `<button class="chip" data-say="${esc(s.split(' / ')[0])}" title="${esc(what)}">${esc(s)}</button>`)).join('');
  box.querySelectorAll('[data-say]').forEach((b) => { b.onclick = () => submit(b.dataset.say); });
  bub.extras.append(box);
}

// the built-in brain: understand → run the tools → answer from their results
async function askBuiltin(text, ids, bub) {
  await refreshLexicon();
  const u = understand(text, {
    attachments: ids.map((id) => ({ id, kind: state.attachments.get(id).kind })),
    memory: state.memory, choices: state.choices, lexicon: state.lexicon, today: localToday(),
  });
  state.choices = null;
  if (u.ask) {                                       // a detail is missing: ask, and remember what for
    state.memory = { ...state.memory, pending: u.pending };
    return u.ask;
  }
  state.memory = { ...state.memory, pending: null };
  if (u.help) { helpChips(bub); return 'Here\'s what I can do. Tap one, or just say it — in English or Hinglish.'; }
  if (!u.calls) {
    if (u.suggest?.length) { helpChips(bub, u.suggest); return 'Did you mean one of these?'; }
    helpChips(bub);
    return 'I didn\'t understand that. Here\'s what I can do — tap one or say it.';
  }
  const said = [];
  for (let k = 0; k < u.calls.length; k++) {
    const call = u.calls[k];
    const key = `b${k}`;
    stepLine(bub, key, toolLabel(call.tool, call.input), 'running');
    const out = await runTool(call.tool, call.input, ctxFor(bub));
    stepLine(bub, key, toolLabel(call.tool, call.input), out.ok ? 'done' : 'failed', out.ok ? '' : out.error);
    if (u.guess && (!out.ok || out.result?.summary?.found === false)) {    // the bare words weren't a customer
      bub.steps.innerHTML = '';
      helpChips(bub, u.suggest?.length ? u.suggest : null);
      return u.suggest?.length ? 'Did you mean one of these?' : 'I didn\'t understand that. Here\'s what I can do — tap one or say it.';
    }
    if (!out.ok) {
      showNeedsLogin(bub, out);
      if (u.calls.length === 1) throw new Error(out.error);
      said.push(`${toolLabel(call.tool, call.input)}: ${out.error}`);
      continue;
    }
    state.memory = remember(state.memory, call, out.result);
    showResultExtras(bub, out.result, call.tool);
    said.push(out.result.say || 'Done.');
  }
  return (u.corrected ? `_(I read that as “${u.corrected}”.)_\n\n` : '') + said.join('\n\n');
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
  const others = [];
  for (const [name, p] of Object.entries(PROJECTS)) {
    if (name === 'ledger' || p.anon) continue;
    const ses = configured(name) ? await session(name).catch(() => null) : null;
    others.push({ name, p, ses });
  }
  const ICONS = { fleet: '🚛', loading: '🛢️', indents: '🧾', tally: '📑' };
  sheet.innerHTML = `<div class="panel" role="dialog" aria-label="Settings">
    <div style="display:flex;justify-content:space-between;align-items:center"><h2>Settings</h2><button class="icon-btn" data-close aria-label="Close">✕</button></div>

    <h3 id="logins">Logins</h3>
    <p class="muted" style="font-size:13px;margin:0 0 6px">The same logins as each app — signed in there on this phone means signed in here too.</p>
    <div class="login" data-login="ledger">
      <div class="head"><div><b>📒 Ledger</b> — your Jarvis login <span class="muted">(also the Mac link)</span></div>
        ${state.ledger ? '<button class="btn small" data-out="ledger">Sign out</button>' : ''}</div>
      ${state.ledger ? `<div class="ok-text">Signed in as ${esc(state.ledger.user?.email)}</div>`
    : `<div class="field"><input type="email" placeholder="Email" autocomplete="username" data-email></div>
         <div class="field"><input type="password" placeholder="Password" autocomplete="current-password" data-pass></div>
         <button class="btn cta" data-in="ledger">Sign in</button> <span class="muted" data-msg></span>`}
    </div>
    ${others.map(({ name, p, ses }) => `<div class="login" data-login="${name}">
      <div class="head"><div><b>${ICONS[name] || '•'} ${esc(p.label)}</b> <span class="muted">(${p.user === 'username' ? `${esc(p.label)}-app username` : 'email'})</span></div>${ses ? `<button class="btn small" data-out="${name}">Sign out</button>` : ''}</div>
      ${ses ? `<div class="ok-text">Signed in as ${esc(String(ses.user?.email || '').replace('@vriddhi.local', ''))}</div>`
    : configured(name) ? `<div class="field"><input placeholder="${p.user === 'username' ? 'Username' : 'Email'}" data-email></div>
         <div class="field"><input type="password" placeholder="Password" data-pass></div>
         <button class="btn" data-in="${name}">Sign in</button> <span class="muted" data-msg></span>` : `<div class="muted">The ${esc(p.label)} app isn't connected to its database.</div>`}
    </div>`).join('')}

    <h3>Brain</h3>
    ${[
    ['builtin', 'Built-in (recommended)', 'Works on its own — no AI service, no subscription, no cost, nothing sent outside your apps. Understands everyday phrases in English or Hinglish, follow-ups ("his statement", "and yesterday?"), several requests at once, and spelling slips.'],
    ['cloud', 'Claude AI — cloud key (optional)', 'For free-form questions. Uses an Anthropic API key (pay-per-use, separate from any Claude plan) kept in the ledger project\'s jarvis-brain function (jarvis/README.md). If it is ever unavailable, the built-in brain answers.'],
    ['key', 'Claude AI — key on this device (optional)', 'Same, with an Anthropic API key kept only in this browser. Falls back to the built-in brain if it fails.'],
  ].map(([v, t, d]) => `<label class="opt"><input type="radio" name="brain" value="${v}" ${settings.brain === v ? 'checked' : ''}><div><b>${t}</b><span>${d}</span></div></label>`).join('')}
    <div class="field">Anthropic API key (only for "key on this device")<input type="password" data-key placeholder="sk-ant-…" value="${esc(settings.key)}" autocomplete="off"></div>
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
        await signIn(b.dataset.in, email, pass);
        refreshLexicon(true);
        sheet.remove();
        await refreshStatus();
        openSettings('logins');
        if (b.dataset.in === 'ledger') welcome();
      } catch (err) { msg.textContent = err.message; msg.className = 'bad-text'; }
    };
  });
  sheet.querySelectorAll('[data-out]').forEach((b) => {
    b.onclick = async () => {
      await signOut(b.dataset.out);
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
  refreshLexicon(true);
  const q = new URLSearchParams(location.search).get('q');   // e.g. a home-screen shortcut: ?q=tank stock
  if (q) submit(q);
});
setInterval(() => { if (!state.busy) refreshStatus(); }, 60000);
