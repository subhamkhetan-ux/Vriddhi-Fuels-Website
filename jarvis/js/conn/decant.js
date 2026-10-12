// Decant (/decant/): tank stock, stock from an automation screenshot, trucks
// waiting, the variation report. Uses the decant app's own store (the same
// phone copy + cloud sync, so a reading saved here shows in the app at once),
// its own screenshot reader (ocr.js) and its own rules (core.js).

import {
  DEFAULT_SETTINGS, chamberLayout, fillLimit, invoiceStatus, litresAtDip, productName, readingFrom, round2, settingsWith,
} from '../../../decant/js/core.js';
import { DIP_CHART } from '../../../decant/js/dipchart.js';
import { entriesFrom, filterEntries, periodRange, summarize } from '../../../decant/js/report.js';

const fmtL = (l) => `${Math.round(Number(l) || 0).toLocaleString('en-IN')} L`;
const ageMin = (iso) => (iso ? Math.round((Date.now() - Date.parse(iso)) / 60000) : null);

// ---- the data: the decant app's store, or a made-up one for the demo -------------
let live = null;
async function data(ctx) {
  if (ctx.demo) return demoStore();
  if (!live) {
    live = (async () => {
      const store = await import('../../../decant/js/store.js');
      await store.initStore();
      return {
        get state() { return store.state; },
        save: (id, r) => store.saveTankReading(id, r),
        cloud: () => store.state.cloud,
        keepShot: async (file, readings) => (await import('../../../decant/js/shots.js')).keepShot(file, readings),
      };
    })();
  }
  return live;
}

let demo = null;
function demoStore() {
  if (demo) return demo;
  const now = Date.now();
  const at = (min) => new Date(now - min * 60000).toISOString();
  const tank = (id, volume, min) => readingFrom(DEFAULT_SETTINGS.tanks.find((t) => t.id === id), { volume, readingAt: at(min) }, 'photo', DIP_CHART);
  const state = {
    cloud: 'demo',
    settings: settingsWith(null),
    chart: DIP_CHART,
    tankState: { T1: tank('T1', 8240, 95), T2: tank('T2', 11630, 40), T3: tank('T3', 4975, 40), T4: tank('T4', 15210, 300) },
    invoices: [
      { invoice_no: '4012345678', invoice_date: '12/10/2026', invoice_time: '06:40', tt_no: 'OD23U8210',
        lines: [{ product: 'HSD', column_key: 'HSD', qty_kl: 14 }, { product: 'MS', column_key: 'MS', qty_kl: 8 }], chambers: [] },
    ],
    sessions: [],
  };
  demo = { state, save: async (id, r) => { state.tankState[id] = r; return true; }, cloud: () => 'demo', keepShot: async () => {} };
  return demo;
}

const tanksOf = (st) => st.settings.tanks;
const tankNo = (st, id) => tanksOf(st).find((t) => t.id === id)?.no;

function stockRows(st) {
  return tanksOf(st).map((t) => {
    const r = st.tankState[t.id];
    const age = ageMin(r?.readingAt);
    return {
      tank: t.no, product: productName(t.product), stock_litres: r ? Math.round(r.volume) : null,
      room_litres: r ? Math.max(0, Math.round(fillLimit(t) - r.volume)) : null, fill_up_to: fillLimit(t),
      dip_cm: r?.dip ?? null, read_at: r?.readingAt || null, minutes_old: age,
      stale: age == null || age > st.settings.staleMinutes, source: r?.source || null,
    };
  });
}

// ---- tools ---------------------------------------------------------------------
async function stock(input, ctx) {
  const d = await data(ctx);
  const rows = stockRows(d.state);
  return {
    summary: { tanks: rows, stale_after_minutes: d.state.settings.staleMinutes, sync: d.cloud() },
    say: rows.map((r) => `Tank ${r.tank} ${r.product}: ${r.stock_litres == null ? 'no reading' : `${fmtL(r.stock_litres)} (room ${fmtL(r.room_litres)}${r.stale ? ', old reading' : ''})`}`).join('. ') + '.',
    app: 'decant',
  };
}

async function fromPhoto(input, ctx) {
  const att = ctx.attachments.get(input.attachment_id) || [...ctx.attachments.values()].at(-1);
  if (!att) return { summary: { error: 'No picture attached. Ask the owner to attach the automation screenshot (📎).' }, say: 'Attach the automation screenshot first (📎).' };
  const d = await data(ctx);
  const st = d.state;
  ctx.progress('Reading the screenshot (Decant\'s reader)…');
  const { readAutomationPhoto } = await import('../../../decant/js/ocr.js');
  const taken = att.file.lastModified > 0 && att.file.lastModified <= Date.now() ? att.file.lastModified : Date.now();
  const parsed = await readAutomationPhoto(att.file, {
    tanks: tanksOf(st), chart: st.chart, dateOrder: st.settings.dateOrder, now: taken,
    onProgress: (f, label) => ctx.progress(`${label || 'Reading'} ${Math.round(f * 100)}%`),
  });
  const found = parsed.tanks.filter((t) => t.tankId && Number.isFinite(t.reading?.volume));
  const skipped = parsed.tanks.filter((t) => !t.tankId).map((t) => (t.no ? `Tank ${t.no} (not one of the app's tanks)` : 'a tank card with no number'));
  if (!found.length) {
    return {
      summary: { read: false, warnings: parsed.warnings, skipped, hint: 'Nothing readable. If the picture is a tank screen, read the stock off it yourself and offer decant_set_stock for each tank.' },
      say: 'I couldn\'t read any tank stock from that picture. You can tell me the stock instead, e.g. "tank 2 stock 11,630".',
    };
  }
  const readings = {};
  for (const t of found) {
    const tank = tanksOf(st).find((x) => x.id === t.tankId);
    readings[t.tankId] = readingFrom(tank, t.reading, 'photo', st.chart, { confidence: t.confidence, checks: t.checks, via: 'jarvis' });
  }
  const rows = Object.entries(readings).map(([id, r]) => {
    const t = found.find((x) => x.tankId === id);
    return { tank: tankNo(st, id), product: productName(tanksOf(st).find((x) => x.id === id).product), stock: r.volume, dip: r.dip, time: r.timeRead ? r.readingAt : null, confidence: t.confidence };
  }).sort((a, b) => a.tank - b.tank);
  const ok = await ctx.confirm({
    title: 'Update the Decant app\'s tank stock?',
    rows: rows.map((r) => [`Tank ${r.tank} · ${r.product}`, fmtL(r.stock), r.dip != null ? `${r.dip} cm` : '', r.time ? new Date(r.time).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : 'time not read', r.confidence === 'low' ? '⚠ check' : '']),
    notes: [...parsed.warnings, ...skipped.map((s) => `Skipped ${s}.`)],
    ok: 'Save to Decant',
  });
  if (!ok) return { summary: { saved: false, declined_by_owner: true, read: rows }, say: 'Not saved.' };
  for (const [id, r] of Object.entries(readings)) await d.save(id, r);
  d.keepShot(att.file, readings).catch(() => {});
  return {
    summary: { saved: true, tanks: rows, warnings: parsed.warnings, skipped, sync: d.cloud() },
    say: `Saved to Decant: ${rows.map((r) => `Tank ${r.tank} ${fmtL(r.stock)}`).join(', ')}.`,
    app: 'decant',
  };
}

async function setStock(input, ctx) {
  const d = await data(ctx);
  const st = d.state;
  const tank = tanksOf(st).find((t) => t.no === Number(input.tank_no));
  if (!tank) return { summary: { error: `No tank ${input.tank_no}. Tanks: ${tanksOf(st).map((t) => `${t.no} (${productName(t.product)})`).join(', ')}` } };
  let r;
  if (Number.isFinite(Number(input.dip_cm)) && input.dip_cm !== undefined && input.dip_cm !== null) {
    const l = litresAtDip(st.chart, Number(input.dip_cm));
    if (!Number.isFinite(l)) return { summary: { error: 'That dip is outside the dip chart.' } };
    r = readingFrom(tank, { volume: l, dip: Number(input.dip_cm), capacity: tank.capacity }, 'dip', st.chart, { via: 'jarvis' });
  } else {
    const l = Number(input.litres);
    if (!(l >= 0) || l > tank.capacity * 1.15) return { summary: { error: 'Give the stock in litres (or a dip in cm).' } };
    r = readingFrom(tank, { volume: l, capacity: tank.capacity }, 'litres', st.chart, { via: 'jarvis' });
  }
  const ok = await ctx.confirm({
    title: 'Update the Decant app\'s tank stock?',
    rows: [[`Tank ${tank.no} · ${productName(tank.product)}`, fmtL(r.volume), r.dip != null ? `${r.dip} cm` : '', 'now', '']],
    ok: 'Save to Decant',
  });
  if (!ok) return { summary: { saved: false, declined_by_owner: true }, say: 'Not saved.' };
  await d.save(tank.id, r);
  return { summary: { saved: true, tank: tank.no, stock: round2(r.volume), dip_cm: r.dip }, say: `Tank ${tank.no} set to ${fmtL(r.volume)}.`, app: 'decant' };
}

async function trucks(input, ctx) {
  const d = await data(ctx);
  const st = d.state;
  const list = st.invoices.filter((inv) => !inv.dismissed).map((inv) => ({ inv, status: invoiceStatus(inv, st.sessions, chamberLayout(inv, null)) }))
    .filter((x) => x.status !== 'done' && x.status !== 'dismissed')
    .map(({ inv, status }) => ({
      tt: inv.tt_no, invoice: inv.invoice_no, date: inv.invoice_date, time: inv.invoice_time, status: { new: 'waiting', partial: 'part decanted', active: 'decanting now' }[status] || status,
      products: (inv.lines || []).map((l) => `${productName(l.column_key || l.product)} ${Number(l.qty_kl) || 0} KL`),
    }));
  return {
    summary: { trucks: list },
    say: list.length ? list.map((t) => `${t.tt} (${t.products.join(' + ')}) — ${t.status}`).join('. ') + '.' : 'No truck is waiting to be decanted.',
    app: 'decant',
  };
}

async function report(input, ctx) {
  const d = await data(ctx);
  const key = { today: 'today', this_week: 'week', this_month: 'month', last_month: 'lastmonth', this_fy: 'fy' }[input.period] || 'month';
  const [from, to] = periodRange(key, ctx.today);
  const entries = filterEntries(entriesFrom(d.state.sessions, d.state.settings), { from, to });
  const s = summarize(entries);
  return {
    summary: {
      period: input.period || 'this_month', from, to, tanks_decanted: s.count, trucks: s.trips, litres: Math.round(s.litres),
      net_variation_litres: s.variation, variation_pct: s.pct, short_litres: s.short, excess_litres: s.excess, flagged: s.flagged,
      worst: s.worst ? { tt: s.worst.tt, tank: s.worst.tankNo, variation: s.worst.variation, pct: s.worst.pct, day: s.worst.day } : null,
      note: 'Negative variation = the tank got less than the chambers held (short). This phone keeps this month and last.',
    },
    say: s.count ? `${s.trips} trucks, ${fmtL(s.litres)} decanted, net variation ${Math.round(s.variation)} L (${s.pct}%), ${s.flagged} flagged.` : 'No decantation in that period.',
    app: 'decant',
  };
}

export const tools = [
  {
    name: 'decant_tank_stock',
    app: 'decant',
    label: () => 'Tank stock',
    description: 'The underground tanks right now, from the Decant app: each tank\'s product, stock (litres), room left up to its fill limit, dip, and how old the reading is (stale = older than the app\'s limit).',
    input_schema: { type: 'object', properties: {} },
    run: stock,
  },
  {
    name: 'decant_update_stock_from_photo',
    app: 'decant',
    label: () => 'Stock from screenshot',
    description: 'Read an IndianOil automation screenshot / photo of the tank screen the owner attached and save each tank\'s stock in the Decant app — with the Decant app\'s own reader, exactly as its 📷 button does. The owner is shown the readings and must confirm before anything is saved. '
      + 'Use this whenever the owner sends a tank / stock / automation screenshot. Compare the result with what you see in the picture and point out any tank that looks misread.',
    input_schema: { type: 'object', properties: { attachment_id: { type: 'string', description: 'The id of the attached picture, e.g. "att1".' } }, required: ['attachment_id'] },
    run: fromPhoto,
  },
  {
    name: 'decant_set_stock',
    app: 'decant',
    label: (i) => `Set tank ${i.tank_no} stock`,
    description: 'Save one tank\'s stock in the Decant app from a figure the owner gives — litres, or a dip in cm (converted with the dip chart). The owner confirms before it is saved.',
    input_schema: {
      type: 'object',
      properties: { tank_no: { type: 'integer' }, litres: { type: 'number' }, dip_cm: { type: 'number' } },
      required: ['tank_no'],
    },
    run: setStock,
  },
  {
    name: 'decant_trucks',
    app: 'decant',
    label: () => 'Trucks to decant',
    description: 'Tank trucks (TTs) whose IndianOil invoice has arrived but which are not fully decanted yet, with their products and quantities.',
    input_schema: { type: 'object', properties: {} },
    run: trucks,
  },
  {
    name: 'decant_report',
    app: 'decant',
    label: (i) => `Decant report · ${(i.period || 'this month').replace(/_/g, ' ')}`,
    description: 'The decanting variation report: litres decanted, net variation (short/excess) and flagged decantations for a period.',
    input_schema: { type: 'object', properties: { period: { type: 'string', enum: ['today', 'this_week', 'this_month', 'last_month', 'this_fy'] } } },
    run: report,
  },
];
