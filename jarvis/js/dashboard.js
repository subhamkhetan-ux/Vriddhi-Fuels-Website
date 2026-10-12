// The home screen's dashboard: a short card for every part of the business,
// each filled by its app's own operation (the same figures Jarvis answers
// with). Cards fill in as each app answers; tapping one asks Jarvis for the
// detail. The last figures are kept on the device, so the dashboard shows at
// once and then refreshes.

import { addDays } from './nlu.js';
import { runTool } from './tools.js';

const KEY = 'jarvis-dashboard';
const FRESH_MS = 2 * 60 * 1000;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const n0 = (v) => Math.round(Number(v) || 0).toLocaleString('en-IN');
// ₹1.53 Cr, ₹84.7 lakh, ₹6,342
export function rupees(v) {
  const x = Number(v) || 0;
  const a = Math.abs(x);
  if (a >= 1e7) return `₹${(x / 1e7).toFixed(2)} Cr`;
  if (a >= 1e5) return `₹${(x / 1e5).toFixed(a >= 1e6 ? 1 : 2)} lakh`;
  return `₹${n0(x)}`;
}
export const litres = (v) => (Math.abs(v) >= 100000 ? `${(v / 1000).toFixed(0)} KL` : `${n0(v)} L`);
const short = (name) => String(name || '').replace(/\s+(Pvt\.?\s+)?(Ltd|Limited|Private Limited)\.?$/i, '');
const bar = (part, whole, cls = '') => `<span class="gauge ${cls}"><i style="width:${Math.max(0, Math.min(100, whole ? (part / whole) * 100 : 0)).toFixed(0)}%"></i></span>`;
const ago = (iso) => {
  const m = Math.round((Date.now() - new Date(iso)) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};

// each card: which operation, what to ask on tap, and how to draw its answer
const CARDS = [
  {
    key: 'yday', app: 'Ledger', icon: '🧾', title: 'Sales yesterday', ask: 'Sales yesterday',
    tool: 'ledger_sales', input: (t) => ({ from: addDays(t, -1), to: addDays(t, -1), period_label: 'Yesterday' }),
    draw: (s) => ({
      big: rupees(s.sales), sub: `${litres(s.litres)} · earned ${rupees(s.earnings)}`,
      rows: (s.products || []).filter((p) => p.litres).slice(0, 3).map((p) => [p.product, litres(p.litres)]),
    }),
  },
  {
    key: 'month', app: 'Ledger', icon: '📈', title: 'This month', ask: 'Sales this month',
    tool: 'ledger_sales', input: (t) => ({ from: `${t.slice(0, 7)}-01`, to: t, period_label: 'This month' }),
    draw: (s) => ({
      big: rupees(s.sales), sub: `${litres(s.litres)} · ₹${(s.earning_per_litre || 0).toFixed(2)}/L`,
      rows: [['Earnings', rupees(s.earnings)], ['Collections', rupees(s.collections)]],
    }),
  },
  {
    key: 'owed', app: 'Ledger', icon: '💰', title: 'Outstanding', ask: 'Outstanding list',
    tool: 'ledger_outstanding', input: () => ({ picture: false }),
    draw: (s) => ({
      big: rupees(s.total_outstanding), sub: `${s.customers_owing} customers owe`,
      rows: (s.top || []).slice(0, 3).map((c) => [short(c.name), rupees(c.balance)]),
    }),
  },
  {
    key: 'pay', app: 'Payments', icon: '🏦', title: 'Payments today', ask: 'Payments today',
    tool: 'payments_recent', input: () => ({ days: 1 }),
    draw: (s) => ({
      big: rupees(s.total), sub: `${s.count} payment${s.count === 1 ? '' : 's'}`,
      rows: (s.payments || []).slice(0, 3).map((p) => [short(p.customer), rupees(p.amount)]),
    }),
  },
  {
    key: 'tanks', app: 'Decant', icon: '🛢️', title: 'Tank stock', ask: 'Tank stock', wide: true,
    tool: 'decant_tank_stock', input: () => ({}),
    draw: (s) => {
      const tanks = s.tanks || [];
      const old = tanks.some((t) => t.stale);
      return {
        big: litres(tanks.reduce((a, t) => a + (t.stock_litres || 0), 0)),
        sub: tanks.length ? `in ${tanks.length} tanks${old ? ` · ⚠ read ${ago(tanks.reduce((a, t) => (t.read_at < a ? t.read_at : a), tanks[0].read_at))}` : ''}` : 'No readings yet',
        html: tanks.map((t) => `<div class="meter"><span>${t.tank} · ${esc(String(t.product).replace(/\s*\(.*\)/, ''))}</span>${bar(t.stock_litres, t.fill_up_to, t.stock_litres / t.fill_up_to < 0.25 ? 'low' : '')}<b>${litres(t.stock_litres)}</b></div>`).join(''),
        warn: old,
      };
    },
  },
  {
    key: 'trucks', app: 'Decant', icon: '🚚', title: 'Trucks to decant', ask: 'Trucks to decant',
    tool: 'decant_trucks', input: () => ({}),
    draw: (s) => ({
      big: String((s.trucks || []).length), sub: (s.trucks || []).length ? 'waiting at the pump' : 'None waiting',
      rows: (s.trucks || []).slice(0, 3).map((t) => [t.tt, (t.products || []).map((p) => p.replace(/^.*?\((\w+)\)/, '$1')).join(' + ')]),   // HSD 14 KL + MS 8 KL
      warn: (s.trucks || []).length > 0,
    }),
  },
  {
    key: 'review', app: 'Payments', icon: '🔎', title: 'Credits to review', ask: 'Payments that need review',
    tool: 'payments_review', input: () => ({}),
    draw: (s) => ({
      big: String(s.count || 0), sub: s.count ? `${rupees(s.total)} not matched to a customer` : 'All matched',
      rows: (s.credits || []).slice(0, 2).map((c) => [String(c.payer || '').slice(0, 22), rupees(c.amount)]),
      warn: s.count > 0,
    }),
  },
  {
    key: 'indents', app: 'Indents', icon: '📝', title: 'Indents', ask: 'Pending indents',
    tool: 'indents_list', input: () => ({}),
    draw: (s) => ({
      big: String(s.pending || 0), sub: `pending${s.awaiting_customer ? ` · ${s.awaiting_customer} awaiting the customer` : ''}`,
      rows: (s.indents || []).filter((i) => i.status === 'Pending').slice(0, 3).map((i) => [short(i.customer), `${i.product} ${i.order}`]),
      warn: s.pending > 0,
    }),
  },
  {
    key: 'pos', app: 'Ledger', icon: '📄', title: 'POs running low', ask: 'POs running low',
    tool: 'ledger_pos', input: () => ({ low: true }),
    draw: (s) => {
      const low = s.running_low || [];
      return {
        big: String(low.length + (s.no_po_left || []).length), sub: low.length ? 'POs nearly used up' : 'All POs have room',
        rows: low.slice(0, 3).map((p) => [`${short(p.customer)} ${p.po}`, `${litres(p.left)} left`]),
        warn: low.length > 0,
      };
    },
  },
  {
    key: 'fleet', app: 'Fleet', icon: '🚛', title: 'Fleet', ask: 'Fleet status',
    tool: 'fleet_status', input: () => ({}),
    draw: (s) => {
      const v = s.vehicles || [];
      const road = v.filter((x) => x.state === 'loaded' || x.state === 'empty').length;
      const m = s.this_month || {};
      return {
        big: `${road}/${v.length}`, sub: `on the road · ${v.filter((x) => x.state === 'loaded').length} loaded`,
        rows: [['Trips this month', String(m.trips ?? 0)], ['Freight', rupees(m.freight)]],
      };
    },
  },
  {
    key: 'tankers', app: 'Loading', icon: '⛽', title: 'Delivery tankers', ask: 'Tanker status',
    tool: 'loading_tankers', input: () => ({}),
    draw: (s) => ({
      big: litres((s.tankers || []).reduce((a, t) => a + (t.filled || 0), 0)), sub: 'loaded in all tankers',
      html: (s.tankers || []).map((t) => `<div class="meter"><span>${esc(t.tanker.slice(-4))}</span>${bar(t.filled, t.capacity)}<b>${t.full ? 'Full' : litres(t.filled)}</b></div>`).join(''),
    }),
  },
  {
    key: 'prices', app: 'Indents', icon: '🏷️', title: "Today's prices", ask: "Today's prices",
    tool: 'prices', input: () => ({}),
    draw: (s) => ({ rows: (s.prices || []).map((p) => [p.product, `₹${Number(p.price).toFixed(2)}`]) }),
  },
  {
    key: 'books', app: 'Ledger', icon: '📚', title: 'Ledger', ask: 'Is the ledger updated',
    tool: 'ledger_status', input: () => ({}),
    draw: (s, today) => {
      const behind = s.sales_until && s.sales_until < addDays(today, -1);
      return {
        big: s.sales_until ? s.sales_until.split('-').reverse().slice(0, 2).join('/') : '—', sub: 'sales entered up to',
        rows: [['Customers', String(s.customers ?? '—')], ...(s.need_ledger_name ? [['Need a ledger name', String(s.need_ledger_name)]] : [])],
        warn: behind || s.need_ledger_name > 0,
      };
    },
  },
];

let mem = null;             // { at, today, cards: { key: { ok, summary?, error?, login? } } }
let loading = null;
function load() {
  if (mem) return mem;
  try { mem = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { mem = null; }
  return mem;
}
function keep() {
  try { localStorage.setItem(KEY, JSON.stringify(mem)); } catch { /* private window */ }
}

function cardHtml(c, r, today, isOff) {
  if (isOff(c.tool)) return '';
  const head = `<div class="dash-head"><span>${c.icon} ${esc(c.title)}</span><em>${esc(c.app)}</em></div>`;
  if (!r) return `<button class="dash-card${c.wide ? ' wide' : ''} wait" data-ask="${esc(c.ask)}">${head}<div class="dash-big shimmer">&nbsp;</div><div class="dash-sub shimmer">&nbsp;</div></button>`;
  if (!r.ok) {
    return r.login
      ? `<button class="dash-card${c.wide ? ' wide' : ''} off" data-login="${esc(r.login)}">${head}<div class="dash-sub">Sign in to ${esc(c.app)} to see this</div></button>`
      : `<button class="dash-card${c.wide ? ' wide' : ''} off" data-ask="${esc(c.ask)}">${head}<div class="dash-sub">Couldn't load — ${esc(String(r.error).slice(0, 80))}</div></button>`;
  }
  let d;
  try { d = c.draw(r.summary || {}, today); } catch { d = { sub: 'No data' }; }
  return `<button class="dash-card${c.wide ? ' wide' : ''}${d.warn ? ' warn' : ''}" data-ask="${esc(c.ask)}">${head}
    ${d.big !== undefined ? `<div class="dash-big">${esc(d.big)}</div>` : ''}
    ${d.sub ? `<div class="dash-sub">${esc(d.sub)}</div>` : ''}
    ${d.rows?.length ? `<div class="dash-rows">${d.rows.map(([a, b]) => `<div><span>${esc(a)}</span><b>${esc(b)}</b></div>`).join('')}</div>` : ''}
    ${d.html || ''}</button>`;
}

// the dashboard on screen now (the welcome screen is redrawn now and then)
let view = null;
function draw() {
  const el = view?.el;
  if (!el?.isConnected) return;
  const { ctx, isOff, onAsk, onLogin } = view;
  const m = load();
  const cards = m && m.today === ctx.today ? m.cards : {};
  el.innerHTML = `<div class="dash-top"><span>${loading ? 'Checking every app…' : m?.at ? `Updated ${ago(m.at)}` : ''}</span><button class="dash-refresh${loading ? ' spin' : ''}" data-refresh>↻ Refresh</button></div>
    <div class="dash">${CARDS.map((c) => cardHtml(c, cards[c.key], ctx.today, isOff)).join('')}</div>`;
  el.querySelectorAll('[data-ask]').forEach((b) => { b.onclick = () => onAsk(b.dataset.ask); });
  el.querySelectorAll('[data-login]').forEach((b) => { b.onclick = () => onLogin(b.dataset.login); });
  el.querySelector('[data-refresh]').onclick = () => refresh();
}

// fetch every card again; old figures stay up until the new ones arrive
function refresh() {
  if (loading || !view) return;
  const { ctx, isOff } = view;
  const m = load();
  mem = { at: m?.at || null, today: ctx.today, cards: m && m.today === ctx.today ? { ...m.cards } : {} };
  const quiet = { ...ctx, progress: () => {}, confirm: async () => false };
  loading = Promise.all(CARDS.filter((c) => !isOff(c.tool)).map(async (c) => {
    const out = await runTool(c.tool, c.input(ctx.today), quiet).catch((e) => ({ ok: false, error: e.message }));
    mem.cards[c.key] = out.ok ? { ok: true, summary: out.result?.summary || {} } : { ok: false, error: out.error, login: out.needsLogin };
    draw();
  })).then(() => {
    mem.at = new Date().toISOString();
    keep();
  }).finally(() => { loading = null; draw(); });
  draw();
}

// draw the dashboard into el and refresh it when its figures are old.
// onAsk(text) runs a card's question; onLogin(app) opens the sign-in.
export function dashboard(el, { ctx, isOff = () => false, onAsk, onLogin, force = false }) {
  view = { el, ctx, isOff, onAsk, onLogin };
  draw();
  const m = load();
  if (force || !m?.at || m.today !== ctx.today || Date.now() - new Date(m.at) > FRESH_MS) refresh();
}

export const DASH_CARDS = CARDS;
