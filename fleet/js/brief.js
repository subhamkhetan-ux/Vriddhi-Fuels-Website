// The daily brief, as of today:
//   ownerBrief()  — what the owner should know: yesterday's and today's work,
//                   who's behind or arriving, loads and the freight they
//                   left behind, money, what needs a look (English)
//   driverBrief() — instructions for the drivers' WhatsApp group, in Hindi:
//                   for each truck where it is, the next stop and the date to
//                   reach it by (the best pace on the route, else the usual),
//                   how its pace and load compare, and a few standing rules
// Built from the same figures as the screens (live.js, load.js, analyse.js).
// Pure functions.

import { addDays, daysBetween, monthOf } from './util.js';
import { loadSummary, loadTarget } from './load.js';
import { totals } from './analyse.js';
import { fleetDiesel } from './tripdiesel.js';

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dm = (iso) => (iso ? `${Number(iso.slice(8, 10))} ${MON[Number(iso.slice(5, 7)) - 1]}` : '');
const short = (v) => String(v || '').slice(-4);
const ind = (n, d = 0) => Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d });
const rs = (n) => `₹${ind(Math.round(n || 0))}`;
const lakh = (n) => (Math.abs(n) >= 1e7 ? `₹${(n / 1e7).toFixed(2)} Cr` : Math.abs(n) >= 100000 ? `₹${(n / 100000).toFixed(2)} L` : rs(n));
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ctx: { status (fleetStatus), live (liveTrips), loads (loadBench), account (ssfcAccount), recon (dieselRecon), drivers (driverCheck), issues (dateIssues), driverNow(veh) }
function dayFacts(data, ctx, day) {
  const loadsOn = data.trips.filter((t) => t.loadDate === day && t.loadWt);
  const unloadsOn = data.trips.filter((t) => t.unloadDate === day);
  const fills = (data.hsd || []).filter((h) => h.date === day);
  const adv = (data.driverPay || []).filter((p) => p.date === day);
  const L = loadSummary(loadsOn, ctx.loads);
  return {
    day, loads: loadsOn, unloads: unloadsOn, L,
    tonnes: loadsOn.reduce((a, t) => a + t.loadWt, 0), freight: loadsOn.reduce((a, t) => a + (t.bhada || 0), 0),
    short: unloadsOn.reduce((a, t) => a + Math.min(0, t.diff || 0), 0),
    litres: fills.reduce((a, h) => a + (h.qty || 0), 0), diesel: fills.reduce((a, h) => a + (h.amount || 0), 0),
    advances: adv.reduce((a, p) => a + p.amount, 0),
  };
}

// ---- for the owner ----------------------------------------------------------------------------
// → { date, sections: [{ title, items: [{ tone: 'good'|'warn'|'bad'|'info', text, href }] }] }
export function ownerBrief(data, ctx, today) {
  const yday = addDays(today, -1);
  const Y = dayFacts(data, ctx, yday);
  const N = dayFacts(data, ctx, today);
  const sections = [];
  const work = [];
  const dayLine = (F, label) => {
    const bits = [];
    if (F.loads.length) bits.push(`${plural(F.loads.length, 'truck')} loaded ${ind(F.tonnes, 1)} T (avg ${ind(F.tonnes / F.loads.length, 2)} T) — ${lakh(F.freight)} freight`);
    if (F.unloads.length) bits.push(`${F.unloads.length} unloaded${F.short < -0.05 ? `, ${ind(-F.short, 2)} T short` : ''}`);
    if (F.litres) bits.push(`diesel ${ind(F.litres)} L (${lakh(F.diesel)})`);
    if (F.advances) bits.push(`advances ${rs(F.advances)}`);
    return bits.length ? `${label}: ${bits.join(' · ')}` : `${label}: nothing entered yet`;
  };
  work.push({ tone: Y.loads.length || Y.unloads.length ? 'info' : 'warn', text: dayLine(Y, `Yesterday (${dm(yday)})`), href: '#/daybook' });
  if (N.loads.length || N.unloads.length || N.litres) work.push({ tone: 'info', text: dayLine(N, 'Today so far'), href: '#/daybook' });
  for (const F of [Y, N]) {
    for (const t of F.loads) {
      const b = ctx.loads.get(t.row);
      if (b && (b.grade === 'low' || b.grade === 'poor')) work.push({ tone: b.grade === 'poor' ? 'bad' : 'warn', text: `${short(t.veh)} loaded ${t.loadWt.toFixed(2)} T on ${dm(t.loadDate)} — ${b.gapNear.toFixed(2)} T below the best then (${b.near.toFixed(2)} T): ${rs(b.lostRs)} freight left behind`, href: `#/trip/${t.row}` });
    }
  }
  sections.push({ title: 'Work', items: work });

  // on the road
  const road = [];
  const onTrip = ctx.status.filter((s) => s.state !== 'idle');
  road.push({ tone: 'info', text: `${onTrip.length} of ${ctx.status.length} on a trip — ${ctx.status.filter((s) => s.state === 'loaded').length} loaded, ${ctx.status.filter((s) => s.state === 'empty').length} going to load, ${ctx.status.filter((s) => s.state === 'idle').length} idle`, href: '#/' });
  const late = ctx.live.filter((x) => x.status === 'late').sort((a, b) => b.pace.typical - a.pace.typical);
  const behind = ctx.live.filter((x) => x.status === 'behind');
  if (late.length) road.push({ tone: 'bad', text: `Late: ${late.map((x) => `${short(x.veh)} (${x.pace.typical} d behind the usual, ${x.phase.short.replace(/^\w/, (c) => c.toLowerCase())})`).join(', ')} — call the driver${late.length > 1 ? 's' : ''}`, href: '#/performance' });
  if (behind.length) road.push({ tone: 'warn', text: `Behind the best pace: ${behind.map((x) => `${short(x.veh)} (+${x.pace.best} d)`).join(', ')}`, href: '#/performance' });
  const arriving = ctx.live.filter((x) => x.t.loadDate && x.etaTypical && x.etaTypical <= addDays(today, 1));
  if (arriving.length) road.push({ tone: 'info', text: `Due to unload by tomorrow: ${arriving.map((x) => `${short(x.veh)} at ${x.t.dest}`).join(', ')}` });
  const idle = ctx.status.filter((s) => s.state === 'idle' && s.days >= 2);
  if (idle.length) road.push({ tone: 'warn', text: `Idle 2+ days: ${idle.map((s) => `${short(s.veh)} (${s.days} d at ${s.last ? s.last.dest : '?'})`).join(', ')}` });
  sections.push({ title: 'On the road', items: road });

  // loads this month
  const m = monthOf(today);
  const mt = data.trips.filter((t) => t.month === m);
  const ML = loadSummary(mt, ctx.loads);
  const loadsOut = [];
  if (ML.trips) {
    loadsOut.push({ tone: ML.avgGap > 1.5 ? 'warn' : 'good', text: `This month ${plural(ML.trips, 'load')}, avg ${ML.avgLoad.toFixed(2)} T — ${ML.avgGap.toFixed(2)} T a trip below the best then: ${ind(ML.lostT, 1)} T, ${lakh(ML.lostRs)} freight missed. Overload is paid for — push for full loads`, href: '#/trips?f=under' });
    const byVeh = [...new Set(mt.map((t) => t.veh))].map((v) => ({ v, ...loadSummary(mt.filter((t) => t.veh === v), ctx.loads) })).filter((x) => x.trips);
    const worst = byVeh.filter((x) => x.avgGap > 1.5).sort((a, b) => b.avgGap - a.avgGap).slice(0, 3);
    if (worst.length) loadsOut.push({ tone: 'warn', text: `Lightest loaders: ${worst.map((x) => `${short(x.v)}${ctx.driverNow(x.v) ? ` (${ctx.driverNow(x.v)})` : ''} −${x.avgGap.toFixed(1)} T`).join(', ')}` });
    const best = byVeh.filter((x) => x.avgGap <= 1).sort((a, b) => a.avgGap - b.avgGap).slice(0, 3);
    if (best.length) loadsOut.push({ tone: 'good', text: `Fullest: ${best.map((x) => `${short(x.v)} ${x.avgGap < 0.05 ? '(full loads)' : `−${x.avgGap.toFixed(1)} T`}`).join(', ')}` });
  }
  if (ML.underRto) loadsOut.push({ tone: 'bad', text: `${plural(ML.underRto, 'load')} this month stayed under the RTO 56 T gross — the overload fee paid for nothing on those` });
  if (loadsOut.length) sections.push({ title: 'Loads', items: loadsOut });

  // money
  const money = [];
  const day = Number(today.slice(8, 10));
  const prevM = monthOf(addDays(`${m}-01`, -1));
  const sameDays = (t, ym) => t.month === ym && t.loadDate && Number(t.loadDate.slice(8, 10)) <= day;
  const now = totals(data.trips.filter((t) => sameDays(t, m)));
  const before = totals(data.trips.filter((t) => sameDays(t, prevM)));
  money.push({ tone: now.bhada >= before.bhada ? 'good' : 'warn', text: `Freight this month ${lakh(now.bhada)} from ${plural(now.trips, 'load')} — ${now.bhada >= before.bhada ? 'ahead of' : 'behind'} last month's ${lakh(before.bhada)} by the same day`, href: '#/' });
  if (ctx.account) {
    const pend = ctx.account.withGst.filter((b) => b.pending > 0.005);
    const oldest = pend[0];
    const last = [...ctx.account.payments].filter((p) => p.date).sort((a, b) => (a.date < b.date ? 1 : -1))[0];
    money.push({ tone: oldest && oldest.age > 90 ? 'bad' : 'warn', text: `SSFC owes ${lakh(ctx.account.total)} (${plural(pend.length, 'invoice')} pending${oldest ? `, oldest ${oldest.no || 'not invoiced'} ${oldest.age} days` : ''})${last ? ` · last payment ${lakh(last.account + last.other)} ${daysBetween(last.date, today)} days ago` : ''}`, href: '#/ssfc' });
  }
  sections.push({ title: 'Money', items: money });

  // diesel against the allotments
  if (ctx.recon && ctx.tripDiesel) {
    const F = fleetDiesel(ctx.recon, ctx.tripDiesel, ctx.dieselPrice || 0);
    const dz = [];
    if (F.owedL > 0.5) dz.push({ tone: 'bad', text: `Extra diesel taken and owed: ${ind(F.owedL)} L across ${plural(F.owed.length, 'truck')}${ctx.dieselPrice ? ` (≈ ${lakh(F.owedRs)})` : ''} — to come off their next trips. Most: ${F.owed.slice(0, 3).map((v) => `${short(v.veh)} ${ind(-v.balance)} L`).join(', ')}`, href: '#/diesel' });
    else dz.push({ tone: 'good', text: 'No truck owes diesel — every one is within its allotments', href: '#/diesel' });
    if (F.overNow.length) dz.push({ tone: 'bad', text: `Over this trip's allotment now: ${F.overNow.sort((a, b) => b.extra - a.extra).map((z) => `${short(z.t.veh)} +${ind(z.extra)} L`).join(', ')}`, href: '#/diesel' });
    const stop = F.live.filter((z) => z.allotted != null && z.toTake > 0.5 && z.mayTake < 0.5);
    if (stop.length) dz.push({ tone: 'warn', text: `Should take no more diesel this trip (what's owed eats the rest): ${stop.map((z) => short(z.t.veh)).join(', ')}` });
    if (ctx.missingFills && ctx.missingFills.size) {
      const M = [...ctx.missingFills.entries()].map(([row, m]) => ({ m, z: ctx.tripDiesel.get(row) })).filter((x) => x.z);
      dz.push({ tone: 'warn', text: `Diesel fill may be missing on ${plural(M.length, 'trip')}: ${M.slice(0, 4).map(({ m, z }) => `${short(z.t.veh)} ${z.t.trip}${m.short != null ? ` (~${ind(m.short)} L)` : ' (refill not entered)'}`).join(', ')}${M.length > 4 ? '…' : ''} — check HSD Data / ask for the slips`, href: '#/trips?f=fill' });
    }
    dz.push({ tone: 'info', text: `Still to fill on the road: ${ind(F.mayTake)} L (${ind(F.toTake)} L left of the allotments, less what's owed)`, href: '#/diesel' });
    sections.push({ title: 'Diesel', items: dz });
  }

  const look = [];
  if (ctx.issues && ctx.issues.length) look.push({ tone: 'warn', text: `${plural(ctx.issues.length, 'trip')} with dates to check in Excel`, href: '#/trips?f=check' });
  if (look.length) sections.push({ title: 'To check', items: look });
  return { date: today, sections };
}

// ---- for the drivers' group (Hindi) ---------------------------------------------------------------
const HMON = ['जनवरी', 'फ़रवरी', 'मार्च', 'अप्रैल', 'मई', 'जून', 'जुलाई', 'अगस्त', 'सितंबर', 'अक्टूबर', 'नवंबर', 'दिसंबर'];
const HDAY = ['रविवार', 'सोमवार', 'मंगलवार', 'बुधवार', 'गुरुवार', 'शुक्रवार', 'शनिवार'];
export const hDate = (iso) => `${Number(iso.slice(8, 10))} ${HMON[Number(iso.slice(5, 7)) - 1]}`;
export const hLongDate = (iso) => `${HDAY[new Date(`${iso}T00:00:00Z`).getUTCDay()]}, ${hDate(iso)} ${iso.slice(0, 4)}`;
const hRel = (iso, today) => {
  const n = daysBetween(today, iso);
  return n <= 0 ? 'आज ही' : n === 1 ? 'कल तक' : `${n} दिन में`;
};
const hT = (n) => `${Number(n).toFixed(2)} टन`;

// a trip's diesel, in Hindi (tripdiesel.js)
const hL = (n) => `${ind(Math.abs(n), Math.abs(n) % 1 && Math.abs(n) < 100 ? 1 : 0)} लीटर`;
function hDiesel(z) {
  if (!z || z.allotted == null) return { diesel: '', dieselTone: 'info' };
  const owedBefore = z.carryIn < -0.5 ? -z.carryIn : 0;
  if (z.extra > 0.5) return { diesel: `⚠ डीज़ल: इस ट्रिप का ${hL(z.allotted)} तय था, ${hL(z.taken)} लिया — ${hL(z.extra)} ज़्यादा। कुल ${hL(Math.max(0, -z.after))} अगली ट्रिप में कटेगा`, dieselTone: 'bad' };
  if (z.mayTake < 0.5) {
    return z.after < -0.5
      ? { diesel: `⚠ डीज़ल: ${hL(z.allotted)} में से ${hL(z.taken)} लिया — अब और डीज़ल न लें। पिछली ट्रिपों का ${hL(-z.after)} ज़्यादा लिया हुआ अगली ट्रिप में कटेगा`, dieselTone: 'warn' }
      : { diesel: `✓ डीज़ल: इस ट्रिप का पूरा ${hL(z.allotted)} लिया — अब और न लें`, dieselTone: 'good' };
  }
  return {
    diesel: `डीज़ल: ${hL(z.allotted)}${z.est ? ' (अनुमान)' : ''} में से ${hL(z.taken)} लिया — अब ${hL(z.mayTake)} और ले सकते हैं${owedBefore ? ` (पिछला ${hL(owedBefore)} काटकर)` : ''}`,
    dieselTone: owedBefore ? 'warn' : 'good',
  };
}
function idleDiesel(v) {
  if (!v || v.balance > -0.5) return { diesel: '', dieselTone: 'info' };
  return { diesel: `⚠ पिछली ट्रिपों का ${hL(-v.balance)} डीज़ल ज़्यादा लिया हुआ है — अगली ट्रिप के डीज़ल में से कटेगा`, dieselTone: 'warn' };
}

// → { date, rules: [..], yesterday, shout, rows: [{ veh, driver, state, now, next, by, byRel, urgent, pace, paceTone, load, loadTone }] }
export function driverBrief(data, ctx, today) {
  const rows = [];
  for (const s of ctx.status) {
    const lt = ctx.live.find((x) => x.veh === s.veh);
    const driver = ctx.driverNow(s.veh);
    if (!lt) {
      const t = s.last;
      rows.push({
        veh: s.veh, driver, state: 'idle',
        now: t ? `${t.dest} पर खाली खड़ी${s.days != null ? ` — ${s.days} दिन से` : ''}` : 'खाली खड़ी',
        next: 'अगली ट्रिप के लिए तैयार रहें — ऑफिस के निर्देश पर तुरंत निकलें', by: null, pace: '', paceTone: 'info', load: '', loadTone: 'info',
        ...idleDiesel(ctx.recon && ctx.recon.vehicles.find((v) => v.veh === s.veh)),
      });
      continue;
    }
    const t = lt.t;
    const out = lt.steps.find((x) => x.key === 'out')?.place || 'पंप';
    const back = lt.steps.find((x) => x.key === 'back')?.place || 'पंप';
    const waiting = lt.stage === 'out' && /waiting/i.test(lt.phase.title);
    const now = {
      start: `निकल चुकी है — डीज़ल के लिए ${out} की ओर`,
      out: waiting ? `${t.port} पर — लोडिंग का इंतज़ार` : `${out} पर डीज़ल भरा — ${t.port} की ओर`,
      load: `${t.port} पर लोड हुई — वापसी, डीज़ल ${back} पर`,
      back: `${back} पर डीज़ल भरा — ${t.dest} की ओर`,
      unload: `${t.dest} पर अनलोड हुई`,
    }[lt.stage];
    const nextStep = lt.steps.find((x) => !x.done);
    let next = '';
    let by = null;
    if (nextStep) {
      next = { out: `${nextStep.place} पर डीज़ल भरवाना`, load: `${t.port} पर लोडिंग`, back: `${nextStep.place} पर डीज़ल भरवाना`, unload: `${t.dest} पर अनलोडिंग` }[nextStep.key] || '';
      by = [nextStep.best, nextStep.typical].find((d) => d && d >= today) || today;
    }
    const p = lt.pace;
    let pace = 'नई ट्रिप — समय पर चलें';
    let paceTone = 'info';
    if (p.best != null) {
      if (lt.status === 'late') { pace = `✗ सामान्य से ${p.typical} दिन देर — तुरंत ऑफिस से बात करें`; paceTone = 'bad'; }
      else if (lt.status === 'behind') { pace = `⚠ सबसे अच्छी रफ़्तार से ${p.best} दिन पीछे — रफ़्तार बढ़ाएँ`; paceTone = 'warn'; }
      else { pace = p.best < 0 ? `✓ सबसे अच्छी रफ़्तार से भी ${-p.best} दिन आगे — शाबाश!` : '✓ सबसे अच्छी रफ़्तार पर — शाबाश!'; paceTone = 'good'; }
    }
    let load = '';
    let loadTone = 'info';
    const b = t.loadWt ? ctx.loads.get(t.row) : null;
    if (b) {
      if (b.grade === 'top') { load = `✓ पूरा लोड ${hT(t.loadWt)} — शाबाश!`; loadTone = 'good'; }
      else if (b.grade === 'ok') { load = `लोड ${hT(t.loadWt)} — सबसे अच्छे लोड (${hT(b.near)}) से ${hT(b.gapNear)} कम`; loadTone = 'info'; }
      else { load = `⚠ कम लोड: ${hT(t.loadWt)} — सबसे अच्छे (${hT(b.near)}) से ${hT(b.gapNear)} कम। अगली बार पूरा भरवाएँ`; loadTone = b.grade === 'poor' ? 'bad' : 'warn'; }
    } else {
      const tg = loadTarget(data, t, today);
      if (tg) { load = `लोडिंग में कम से कम ${hT(tg.load)} भरवाएँ — ओवरलोड का RTO भरा हुआ है`; loadTone = 'warn'; }
    }
    let { diesel, dieselTone } = hDiesel(ctx.tripDiesel && ctx.tripDiesel.get(t.row));
    if (ctx.missingFills && ctx.missingFills.get(t.row)?.kind === 'refill') { diesel = `⚠ रिफ़िल की एंट्री नहीं मिली — डीज़ल भरवाया है तो पर्ची और लीटर तुरंत ऑफिस को भेजें। ${diesel}`; dieselTone = 'warn'; }
    rows.push({ veh: s.veh, driver, state: s.state, now, next, by, byRel: by ? hRel(by, today) : '', urgent: by === today, pace, paceTone, load, loadTone, diesel, dieselTone, day: lt.el });
  }
  const order = { bad: 0, warn: 1, info: 2, good: 3 };
  rows.sort((a, b) => (a.state === 'idle') - (b.state === 'idle') || order[a.paceTone] - order[b.paceTone] || String(a.veh).localeCompare(String(b.veh)));

  // yesterday, for the group
  const yday = addDays(today, -1);
  const loadsY = data.trips.filter((t) => t.loadDate === yday && t.loadWt);
  const unloadsY = data.trips.filter((t) => t.unloadDate === yday);
  const parts = [];
  const gadi = (n) => `${n} ${n === 1 ? 'गाड़ी' : 'गाड़ियाँ'}`;
  const hui = (n) => (n === 1 ? 'हुई' : 'हुईं');
  if (loadsY.length) parts.push(`${gadi(loadsY.length)} लोड ${hui(loadsY.length)} — औसत ${hT(loadsY.reduce((a, t) => a + t.loadWt, 0) / loadsY.length)}`);
  if (unloadsY.length) parts.push(`${gadi(unloadsY.length)} अनलोड ${hui(unloadsY.length)}`);
  const lowY = loadsY.map((t) => [t, ctx.loads.get(t.row)]).filter(([, x]) => x && (x.grade === 'low' || x.grade === 'poor'));
  const yesterday = `कल (${hDate(yday)}): ${parts.length ? parts.join(', ') : 'कोई लोडिंग / अनलोडिंग नहीं'}।${lowY.length ? ` कम लोड: ${lowY.map(([t, x]) => `${short(t.veh)} (−${x.gapNear.toFixed(1)} टन)`).join(', ')}।` : ''}`;
  const stars = rows.filter((r) => r.paceTone === 'good' && (r.loadTone === 'good' || !r.load || r.loadTone === 'info') && r.state !== 'idle').map((r) => `${short(r.veh)}${r.driver ? ` (${r.driver})` : ''}`);
  return {
    date: today,
    rules: [
      'ओवरलोड का RTO पहले से भरा हुआ है — हर ट्रिप में पूरा माल भरवाएँ। कम लोड = कंपनी का नुकसान।',
      'नीचे दी गई तारीख तक अगला पड़ाव पूरा करें। देर हो तो तुरंत ऑफिस को फ़ोन करें।',
      'तय डीज़ल से ज़्यादा न लें — ज़्यादा लिया डीज़ल अगली ट्रिप के डीज़ल में से कटेगा।',
    ],
    yesterday,
    shout: stars.length ? `शाबाश: ${stars.join(', ')} — सबसे अच्छी रफ़्तार पर` : '',
    rows,
  };
}
