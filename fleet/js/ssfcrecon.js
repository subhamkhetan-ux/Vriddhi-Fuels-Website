// SSFC's monthly statement checked against the firm's own books — so nothing
// SSFC takes or keeps goes unnoticed. ssfcstmt.js reads the statement; this
// compares it with the Trip Register (trips, freight, diesel, cash office, the
// deduction columns, SSFC Net), HSD Data (every diesel fill), Urea DEF (every
// DEF / AdBlue refill bought from SSFC), the Rates sheet and the Ledger, and
// with SSFC's other months' statements (a bill charged twice).
//
// Every finding: { level: 'bad' | 'warn' | 'info', area, veh, amount, text }
//   bad  — SSFC took more (or paid less) than the books say: `amount` is the ₹
//          in SSFC's favour, to claim back or have explained
//   warn — doesn't add up, or needs a paper behind it; `amount` when known
//   info — worth knowing (in the firm's favour, carried over, a fixed date)
// Pure functions.

import { KINDS } from './ssfcstmt.js';

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const sum = (xs, f) => r2(xs.reduce((a, x) => a + (Number(f(x)) || 0), 0));
const short = (v) => String(v || '').slice(-4);
const ind = (n, d = 0) => Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d });
const rs = (n) => `₹${ind(Math.round(n))}`;
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dm = (iso) => (iso ? `${Number(iso.slice(8, 10))} ${MON[Number(iso.slice(5, 7)) - 1]}` : '—');
const monthName = (m) => (m ? `${MON[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}` : '');
const days = (a, b) => Math.round((Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10)) - Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10))) / 86400000);
const addMonths = (m, k) => { const t = Number(m.slice(0, 4)) * 12 + Number(m.slice(5, 7)) - 1 + k; return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`; };
// DEF bought from SSFC, as the Urea DEF sheet names it
export const FROM_SSFC = /S\.?\s*S\.?\s*FREIGHT|\bSSFC\b|SS\s*FREIGHT/i;
// the money columns the statement's deductions go to (the Trip Register's names)
const REG = { fastag: 'fastag', maint: 'maint', tyre: 'tyre', lessOver: 'lessOver', rtoEntry: 'rtoEntry', rtoChallan: 'rtoChallan', shortage: 'shortage', docExp: 'docExp' };
// how SSFC groups the bills under its deduction lines (learnt from its statements): driver
// fooding goes under "over / unload", document papers under maintenance
const GROUP = { maint: 'maint', docExp: 'maint', other: 'maint', gps: 'maint', lessOver: 'over', fooding: 'over', tyre: 'tyre', rtoChallan: 'rto', ld: 'ld' };
const GROUP_NAME = { maint: 'maintenance (incl. DEF)', over: 'over / unload (incl. driver fooding)', tyre: 'tyre', rto: 'RTO challan', ld: 'late delivery (LD)' };

// the statement's own arithmetic: each row's total, each fill, each vehicle's subtotal and net
export function statementMath(stmt) {
  const out = [];
  for (const v of stmt.vehicles) {
    for (const t of v.trips) {
      for (const p of t.pumps) {
        if (p.qty && p.rate && p.amount && Math.abs(p.qty * p.rate - p.amount) > 1) {
          const d = r2(p.amount - p.qty * p.rate);
          out.push({ level: d > 0 ? 'bad' : 'info', area: 'math', veh: v.veh, amount: d > 0 ? d : 0, text: `${short(v.veh)} · trip loaded ${dm(t.loadDate)}: ${ind(p.qty)} L × ₹${p.rate} = ${rs(p.qty * p.rate)}, but SSFC wrote ${rs(p.amount)} for the diesel` });
        }
      }
      if (t.total != null) {
        const calc = r2(t.freight - t.ssfcDiesel - t.cashOffice);
        const d = r2(calc - t.total);
        if (Math.abs(d) > 1) out.push({ level: d > 0 ? 'bad' : 'info', area: 'math', veh: v.veh, amount: d > 0 ? d : 0, text: `${short(v.veh)} · trip loaded ${dm(t.loadDate)} (${t.loadWt} T): freight ${rs(t.freight)} − diesel ${rs(t.ssfcDiesel)} − cash office ${rs(t.cashOffice)} = ${rs(calc)}, but SSFC's total is ${rs(t.total)}` });
      }
      if (t.unloadWt != null && t.short != null && Math.abs(r2(t.unloadWt - t.loadWt) - t.short) > 0.01) {
        out.push({ level: 'warn', area: 'math', veh: v.veh, text: `${short(v.veh)} · trip loaded ${dm(t.loadDate)}: unloaded ${t.unloadWt} − loaded ${t.loadWt} = ${r2(t.unloadWt - t.loadWt)} T, but SSFC wrote ${t.short} T short / excess` });
      }
    }
    const rowSum = sum(v.trips, (t) => t.total);
    if (v.subtotal != null && Math.abs(rowSum - v.subtotal) > 1) {
      const d = r2(rowSum - v.subtotal);
      out.push({ level: d > 0 ? 'bad' : 'info', area: 'math', veh: v.veh, amount: d > 0 ? d : 0, text: `${short(v.veh)}: its trips' totals add up to ${rs(rowSum)}, but SSFC's subtotal is ${rs(v.subtotal)}` });
    }
    if (v.net != null) {
      const base = v.subtotal != null ? v.subtotal : rowSum;
      const calc = r2(base - sum(v.deductions, (x) => x.amount));
      const d = r2(calc - v.net);
      if (Math.abs(d) > 1) out.push({ level: d > 0 ? 'bad' : 'info', area: 'math', veh: v.veh, amount: d > 0 ? d : 0, text: `${short(v.veh)}: ${rs(base)} − deductions ${rs(sum(v.deductions, (x) => x.amount))} = ${rs(calc)}, but SSFC's NET AMOUNT is ${rs(v.net)}` });
    }
  }
  return out;
}

// the register's trip a statement trip is: the same vehicle and loading weight (to 10 kg), else the
// nearest loading date within 3 days and 1 T
function matchTrips(stmt, trips) {
  const used = new Set();
  const pairs = [];
  const mine = (veh) => trips.filter((t) => t.veh === veh && t.loadWt);
  for (const v of stmt.vehicles) {
    for (const s of v.trips) {
      const cands = mine(v.veh).filter((t) => !used.has(t.row));
      const gap = (x) => (x.loadDate && s.loadDate ? Math.abs(days(x.loadDate, s.loadDate)) : 99);
      const sameWt = (x) => Math.abs(x.loadWt - s.loadWt) < 0.011;
      // the same weight within a week; else the nearest date within 3 days (a weight typed differently);
      // else the same weight, any date
      let t = cands.filter((x) => sameWt(x) && gap(x) <= 7).sort((a, b) => gap(a) - gap(b))[0];
      let how = 'weight';
      if (!t) { t = cands.filter((x) => gap(x) <= 3 && Math.abs(x.loadWt - s.loadWt) <= 1).sort((a, b) => gap(a) - gap(b) || Math.abs(a.loadWt - s.loadWt) - Math.abs(b.loadWt - s.loadWt))[0]; how = 'date'; }
      if (!t) { t = cands.filter(sameWt).sort((a, b) => (a.month === stmt.month ? 0 : 1) - (b.month === stmt.month ? 0 : 1) || gap(a) - gap(b))[0]; how = 'weight'; }
      if (t) used.add(t.row);
      pairs.push({ veh: v.veh, s, t: t || null, how: t ? how : null });
    }
  }
  return pairs;
}

// opts: { others: [statements of other months], tyreExpected: Map(veh → ₹ the tyre rule gives for the month) }
export function reconcile(stmt, data, opts = {}) {
  const others = (opts.others || []).filter((o) => o && o.month !== stmt.month);
  const issues = [...statementMath(stmt)];
  const add = (x) => issues.push(x);
  const month = stmt.month;
  const trips = data.trips || [];
  const pairs = matchTrips(stmt, trips);
  const vehs = [...new Set([...stmt.vehicles.map((v) => v.veh)])];
  // the month HSD Data starts logging SSFC's pump fills (before it, the register's figures were typed from the statements)
  const hsdFrom = (data.hsd || []).filter((h) => /ssfc/i.test(h.source || '') && h.trip).map((h) => h.date.slice(0, 7)).sort()[0] || null;
  const rateOf = (t) => (data.rates || []).find((r) => String(r.port).toLowerCase() === String(t.port || '').toLowerCase() && String(r.dest).toLowerCase() === String(t.dest || '').toLowerCase());

  // ---- trips: in the statement, in the register, paid right ----
  const rateGaps = new Map();
  const vehRateGap = new Map();       // each vehicle's freight at your rate − SSFC's
  const netNote = new Map();          // the register-net finding of each vehicle (the Ledger's is folded into it)
  const fixedDates = [];
  for (const p of pairs) {
    const { s, t } = p;
    if (!t) {
      add({ level: 'warn', area: 'trip', veh: p.veh, text: `${short(p.veh)} · SSFC paid a trip loaded ${dm(s.loadDate)} (${s.loadWt} T${s.lr ? `, LR ${s.lr}` : ''}) that isn't in your Trip Register — enter it, or ask SSFC whose trip it is` });
      continue;
    }
    if (s.loadDateFix || s.unloadDateFix) fixedDates.push(`${short(p.veh)} ${dm(s.loadDate)}`);
    const ourRate = t.rate || (rateOf(t) || {}).rate || null;
    if (ourRate && s.rate && Math.abs(ourRate - s.rate) > 0.5) {
      const k = `${t.port}|${t.dest}|${s.rate}|${ourRate}`;
      const g = rateGaps.get(k) || { port: t.port, dest: t.dest, theirs: s.rate, ours: ourRate, trips: [], tonnes: 0 };
      g.trips.push(`${short(p.veh)} ${t.trip}`); g.tonnes = r2(g.tonnes + s.loadWt);
      rateGaps.set(k, g);
      vehRateGap.set(p.veh, r2((vehRateGap.get(p.veh) || 0) + (ourRate - s.rate) * s.loadWt));
    } else if (t.bhada && Math.abs(t.bhada - s.freight) > 1 && Math.abs(t.loadWt - s.loadWt) < 0.011) {
      const d = r2(t.bhada - s.freight);
      add({ level: d > 50 ? 'bad' : 'info', area: 'trip', veh: p.veh, amount: d > 0 ? d : 0, text: `${short(p.veh)} ${t.trip}: your Trip Bhada is ${rs(t.bhada)}, SSFC's freight ${s.loadWt} T × ₹${ind(s.rate)} = ${rs(s.freight)}` });
    }
    if (Math.abs(t.loadWt - s.loadWt) > 0.011) {
      const d = r2((t.loadWt - s.loadWt) * (s.rate || t.rate || 0));
      add({ level: d > 0 ? 'bad' : 'info', area: 'trip', veh: p.veh, amount: d > 0 ? d : 0, text: `${short(p.veh)} ${t.trip} (loaded ${dm(t.loadDate)}): SSFC paid on ${s.loadWt} T, your register has ${t.loadWt} T loaded${d > 0 ? ` — ${rs(d)} less freight` : ''}` });
    }
    if (t.unloadWt != null && s.unloadWt != null && Math.abs(t.unloadWt - s.unloadWt) > 0.011) {
      add({ level: s.unloadWt < t.unloadWt ? 'warn' : 'info', area: 'trip', veh: p.veh, text: `${short(p.veh)} ${t.trip}: SSFC has ${s.unloadWt} T unloaded, your register ${t.unloadWt} T${s.unloadWt < t.unloadWt ? ' — a shortage SSFC could charge you' : ''}` });
    }
  }
  if (fixedDates.length) add({ level: 'info', area: 'trip', veh: null, text: `${fixedDates.length} of SSFC's dates were saved with day and month swapped (or the wrong year) — read the right way round: ${fixedDates.slice(0, 6).join(', ')}${fixedDates.length > 6 ? '…' : ''}` });
  // a freight rate SSFC paid that isn't yours: one line per route and rate
  for (const g of rateGaps.values()) {
    const d = r2((g.ours - g.theirs) * g.tonnes);
    const other = (data.rates || []).find((r) => Math.abs(r.rate - g.theirs) < 0.5 && !(String(r.port).toLowerCase() === String(g.port).toLowerCase() && String(r.dest).toLowerCase() === String(g.dest).toLowerCase()));
    add({ level: d > 0 ? 'bad' : 'info', area: 'rate', veh: null, amount: d > 0 ? d : 0, text: `${g.port || '?'} → ${g.dest || '?'}: SSFC paid ₹${ind(g.theirs)}/T, your rate (Trip Register / Rates sheet) is ₹${ind(g.ours)}/T — on ${g.trips.length} trip${g.trips.length === 1 ? '' : 's'} (${g.trips.slice(0, 4).join(', ')}${g.trips.length > 4 ? '…' : ''}), ${ind(g.tonnes, 2)} T: ${d > 0 ? `${rs(d)} less than your rate` : `${rs(-d)} more`}.${other ? ` ₹${ind(g.theirs)} is your ${other.port} → ${other.dest} rate — is the route right in the register, or did SSFC pay the wrong route?` : d > 0 ? ' Ask SSFC for the rate letter, or claim the difference.' : ''}`, trips: g.trips });
  }
  // the register's trips this month SSFC didn't pay — unless another statement did
  const paidElsewhere = (t) => others.find((o) => o.vehicles.some((v) => v.veh === t.veh && v.trips.some((x) => Math.abs(x.loadWt - t.loadWt) < 0.011)));
  const matched = new Set(pairs.filter((p) => p.t).map((p) => p.t.row));
  for (const t of trips.filter((x) => x.month === month && x.loadWt && vehs.includes(x.veh) && !matched.has(x.row))) {
    const o = paidElsewhere(t);
    if (o) { add({ level: 'info', area: 'trip', veh: t.veh, text: `${short(t.veh)} ${t.trip} (loaded ${dm(t.loadDate)}) is paid in SSFC's ${monthName(o.month)} statement, not this one` }); continue; }
    const later = addMonths(month, 1);
    const haveLater = others.some((o) => o.month === later);
    add({ level: haveLater ? 'bad' : 'warn', area: 'trip', veh: t.veh, amount: haveLater ? t.bhada || 0 : 0, text: `${short(t.veh)} ${t.trip} (loaded ${dm(t.loadDate)}, ${t.loadWt} T, freight ${rs(t.bhada)}) isn't in this statement${haveLater ? ` or ${monthName(later)}'s — SSFC hasn't paid for it` : ` — check it's in ${monthName(later)}'s`}` });
  }
  for (const v of stmt.vehicles) if (!trips.some((t) => t.veh === v.veh)) add({ level: 'warn', area: 'trip', veh: v.veh, text: `${v.veh} is in SSFC's statement but has no trip in your Trip Register` });

  // ---- each vehicle: the statement against the register, the bills, DEF, diesel ----
  const vehicles = [];
  const dieselTrips = [];
  for (const v of stmt.vehicles) {
    const vp = pairs.filter((p) => p.veh === v.veh);
    const regTrips = trips.filter((t) => t.veh === v.veh && t.month === month);
    const ded = {};
    for (const d of v.deductions) ded[d.kind] = r2((ded[d.kind] || 0) + d.amount);
    const reg = {};
    for (const k of [...Object.values(REG), 'ssfcMisc']) reg[k] = sum(regTrips, (t) => t[k]);
    const bills = stmt.expenses.filter((e) => e.veh === v.veh);
    const ld = stmt.ld.filter((x) => x.veh === v.veh);
    // diesel: SSFC's litres and ₹ against your HSD Data fills from SSFC's pumps on the same trips —
    // or, for months before HSD Data logged SSFC's fills, against the register's SSFC Diesel columns
    const regOf = vp.filter((p) => p.t).map((p) => p.t);
    const hsd = (data.hsd || []).filter((h) => h.veh === v.veh && /ssfc/i.test(h.source || '') && regOf.some((t) => t.trip && String(h.trip || '').toLowerCase() === t.trip.toLowerCase()));
    const useHsd = hsdFrom && month >= hsdFrom && hsd.length > 0;
    const sL = sum(v.trips, (t) => t.ssfcLitres);
    const hL = useHsd ? sum(hsd, (h) => h.qty) : sum(regOf, (t) => t.ssfcLtr);
    const hRs = useHsd ? sum(hsd, (h) => h.amount) : sum(regOf, (t) => t.ssfcAmt);
    const row = {
      veh: v.veh, trips: v.trips.length, regTrips: regTrips.length, freight: sum(v.trips, (t) => t.freight), regBhada: sum(regTrips, (t) => t.bhada),
      diesel: sum(v.trips, (t) => t.ssfcDiesel), litres: sL, hsdLitres: hL, hsdAmount: hRs, regDiesel: sum(regTrips, (t) => t.ssfcAmt),
      cashOffice: sum(v.trips, (t) => t.cashOffice), regCash: sum(regTrips, (t) => t.drvSsfc),
      ded, reg, dedTotal: sum(v.deductions, (x) => x.amount), net: v.net, regNet: sum(regTrips, (t) => t.ssfcNet), bills: bills.length,
    };
    vehicles.push(row);
    // diesel, trip by trip (the trips are paired by vehicle and loading weight)
    const dts = dieselByTrip(v, vp, data, useHsd, add);
    dieselTrips.push(...dts);
    row.oursDiesel = sum(dts, (x) => x.refRs);          // yours on the same trips (HSD Data, else P / Q), in ₹
    // the deduction lines against the register's columns (what you've entered for the month)
    const misc = r2(Object.entries(ded).filter(([k]) => KINDS[k] && KINDS[k].col === 'AA').reduce((a, [, x]) => a + x, 0));
    const heads = Object.entries(REG).map(([k, col]) => ({ name: KINDS[k].name, a: ded[k] || 0, b: reg[col] || 0 }))
      .concat([{ name: 'SSFC Misc (union, GPS, fooding, LD, new labels)', a: misc, b: reg.ssfcMisc || 0 }])
      .filter((h) => Math.abs(h.a - h.b) > 1);
    if (heads.length && regTrips.length) {
      const sa = heads.reduce((x, h) => x + h.a, 0); const sb = heads.reduce((x, h) => x + h.b, 0);
      if (Math.abs(sa - sb) <= 1) {
        // the same money, entered under other columns (an older macro, or by hand): nothing lost
        add({ level: 'info', area: 'register', veh: v.veh, amount: 0, text: `${short(v.veh)}: the deductions add up the same, but sit under other columns in your register — ${heads.map((h) => `${h.name} SSFC ${rs(h.a)} / yours ${rs(h.b)}`).join('; ')}` });
      } else {
        for (const h of heads) add({ level: 'warn', area: 'register', veh: v.veh, amount: r2(Math.abs(h.a - h.b)), text: `${short(v.veh)} · ${h.name}: SSFC deducted ${rs(h.a)}, your Trip Register has ${rs(h.b)} for ${monthName(month)} — post the statement (the macro or the app) or correct it` });
      }
    }
    if (v.net != null && regTrips.length && Math.abs(v.net - row.regNet) > 100) {
      // the rate difference already flagged explains it?
      const byRate = vehRateGap.get(v.veh) || 0;
      const explained = byRate && Math.abs(row.regNet - v.net - byRate) <= 100;
      const x = { level: explained ? 'info' : 'warn', area: 'register', veh: v.veh, amount: explained ? 0 : r2(Math.abs(v.net - row.regNet)), regNet: row.regNet,
        text: `${short(v.veh)}: SSFC's NET AMOUNT is ${rs(v.net)}, your SSFC Net for ${monthName(month)} adds up to ${rs(row.regNet)}${explained ? ` — the rate difference above (${rs(byRate)})` : ''}` };
      add(x);
      netNote.set(v.veh, x);
    }
    // things SSFC deducts that need a paper behind them
    if ((ded.emi || 0) > 0) add({ level: 'bad', area: 'deduction', veh: v.veh, amount: ded.emi, text: `${short(v.veh)}: SSFC deducted an instalment (EMI) of ${rs(ded.emi)} — you pay your EMIs to the bank yourself` });
    for (const d of v.deductions.filter((x) => ['other', 'gps', 'penalty', 'union'].includes(x.kind) && x.amount > 0)) {
      add({ level: 'warn', area: 'deduction', veh: v.veh, amount: d.amount, text: `${short(v.veh)}: SSFC deducted “${d.label}” ${rs(d.amount)} — ${d.kind === 'other' ? 'a line not in its usual list; ' : ''}ask for the bill / proof` });
    }
    // the bills behind the deductions, group by group
    const groups = {};
    for (const d of v.deductions) { const g = GROUP[d.kind]; if (g) (groups[g] || (groups[g] = { stmt: 0, bills: 0 })).stmt += d.amount; }
    for (const b of bills) { const g = GROUP[b.kind]; if (g) (groups[g] || (groups[g] = { stmt: 0, bills: 0 })).bills += b.amount; }
    for (const x of ld) (groups.ld || (groups.ld = { stmt: 0, bills: 0 })).bills += x.amount;
    const itemised = stmt.expenses.length || stmt.ld.length;
    for (const [g, x] of Object.entries(groups)) {
      if (g === 'ld' && !stmt.ld.length) { if (x.stmt > 0) add({ level: 'warn', area: 'bill', veh: v.veh, amount: x.stmt, text: `${short(v.veh)}: late-delivery (LD) penalty ${rs(x.stmt)} with no LD sheet to show how it's worked out — ask for it` }); continue; }
      if (!itemised || (g !== 'ld' && !stmt.expenses.length)) continue;
      const d = r2(x.stmt - x.bills);
      if (d > 1) add({ level: 'bad', area: 'bill', veh: v.veh, amount: d, text: `${short(v.veh)} · ${GROUP_NAME[g]}: SSFC deducted ${rs(x.stmt)}, its bills add up to ${rs(x.bills)} — ${rs(d)} with no bill behind it` });
      else if (d < -1) add({ level: 'info', area: 'bill', veh: v.veh, text: `${short(v.veh)} · ${GROUP_NAME[g]}: bills of ${rs(x.bills)}, SSFC deducted only ${rs(x.stmt)} (${rs(-d)} less)` });
    }
    // the tyre rule (₹ a tyre a km), when the app knows the vehicle's km
    if (opts.tyreExpected && opts.tyreExpected.has(v.veh) && ded.tyre) {
      const e = opts.tyreExpected.get(v.veh);
      const d = r2(ded.tyre - e);
      if (e && d > e * 0.1) add({ level: 'warn', area: 'deduction', veh: v.veh, amount: d, text: `${short(v.veh)}: tyre ${rs(ded.tyre)} — the tyre rule gives ${rs(e)} for the km it ran (${rs(d)} more)` });
    }
  }
  // RTO entry is a fixed monthly fee: one vehicle charged more than the others is a flag
  const entries = vehicles.map((x) => x.ded.rtoEntry || 0).filter((x) => x > 0);
  // what most vehicles pay (the most common amount; a tie goes to the lower)
  const counts = new Map();
  for (const x of entries) counts.set(x, (counts.get(x) || 0) + 1);
  const usual = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0];
  for (const x of vehicles) {
    if (usual && (x.ded.rtoEntry || 0) > usual + 1) {
      // one or two charged more is a flag; as many on the higher amount as the lower is a question
      const same = counts.get(x.ded.rtoEntry) || 0;
      const many = same >= entries.length * 0.4;
      add({ level: many ? 'warn' : 'bad', area: 'deduction', veh: x.veh, amount: r2(x.ded.rtoEntry - usual), text: many
        ? `${short(x.veh)}: RTO entry ${rs(x.ded.rtoEntry)} — ${same} vehicles were charged that, the others ${rs(usual)}: ask SSFC why`
        : `${short(x.veh)}: RTO entry ${rs(x.ded.rtoEntry)} — the other vehicles pay ${rs(usual)}` });
    }
    if ((x.ded.rtoEntry || 0) > 0 && !x.trips) add({ level: 'warn', area: 'deduction', veh: x.veh, amount: x.ded.rtoEntry, text: `${short(x.veh)}: RTO entry ${rs(x.ded.rtoEntry)} in a month it ran no trip` });
  }

  // ---- the bills: twice in this statement, already in another, outside the month, shared ----
  const key = (e) => `${e.veh}|${e.date}|${Math.round(e.amount)}|${e.desc.toUpperCase().replace(/\W+/g, '')}`;
  const seen = new Map();
  const tripsOf = (veh) => (stmt.vehicles.find((v) => v.veh === veh) || { trips: [] }).trips.length;
  const rtoCount = new Map();
  for (const e of stmt.expenses) {
    const k = key(e);
    if (e.kind === 'rtoChallan') {
      const n = (rtoCount.get(k) || 0) + 1;
      rtoCount.set(k, n);
      if (n === tripsOf(e.veh) * 2 + 1) add({ level: 'warn', area: 'bill', veh: e.veh, amount: e.amount, text: `${short(e.veh)}: “${e.desc}” ${rs(e.amount)} is charged ${n} times — more than twice for each of its ${tripsOf(e.veh)} trip${tripsOf(e.veh) === 1 ? '' : 's'}` });
    } else if (seen.has(k) && !e.def) add({ level: 'warn', area: 'bill', veh: e.veh, amount: e.amount, text: `${short(e.veh)}: “${e.desc}” ${rs(e.amount)} on ${dm(e.date)} is in the bills twice (rows ${seen.get(k).row} and ${e.row})` });
    else seen.set(k, e);
    const billNo = String(e.bill || '').trim();
    if (billNo && billNo !== '0') {
      const dup = stmt.expenses.find((x) => x !== e && x.bill === e.bill && x.veh === e.veh && Math.round(x.amount) === Math.round(e.amount) && x.row < e.row);
      if (dup) add({ level: 'bad', area: 'bill', veh: e.veh, amount: e.amount, text: `${short(e.veh)}: bill no. ${billNo} (“${e.desc}”, ${rs(e.amount)}) is charged twice in this statement` });
      for (const o of others) {
        const again = o.expenses.find((x) => x.bill === e.bill && x.veh === e.veh && Math.round(x.amount) === Math.round(e.amount) && (x.date === e.date || !x.date || !e.date));
        if (again) add({ level: 'bad', area: 'bill', veh: e.veh, amount: e.amount, text: `${short(e.veh)}: bill no. ${billNo} (“${e.desc}”, ${rs(e.amount)}, ${dm(e.date)}) was already charged in SSFC's ${monthName(o.month)} statement` });
      }
    }
    if (e.date && e.date.slice(0, 7) !== month && !e.def) add({ level: 'info', area: 'bill', veh: e.veh, text: `${short(e.veh)}: “${e.desc}” ${rs(e.amount)} is dated ${dm(e.date)} ${e.date.slice(0, 4)} — from another month, carried into this statement` });
    if (e.others.length) add({ level: 'warn', area: 'bill', veh: e.veh, amount: e.amount, text: `${short(e.veh)}: one bill “${e.desc}” (${rs(e.amount)}) names ${e.others.map(short).join(', ')} too, but is charged to ${short(e.veh)} alone — check it isn't charged to them as well` });
  }

  // ---- DEF / AdBlue: every refill SSFC charged against the Urea DEF sheet, refill by refill ----
  const def = defCheck(stmt, data, others);
  issues.push(...def.issues);

  // ---- LD (late delivery): SSFC's days against the register's dates ----
  for (const x of stmt.ld.filter((l) => l.amount > 0)) {
    const near = (y) => (x.inv && y.loadDate ? Math.abs(days(y.loadDate, x.inv)) : 99);
    const t = trips.filter((y) => y.veh === x.veh && near(y) <= 7 && (!x.wt || Math.abs(y.loadWt - x.wt) < 0.6)).sort((a, b) => near(a) - near(b))[0] || null;
    const ours = t && t.loadDate && t.unloadDate ? days(t.loadDate, t.unloadDate) : null;
    const perDay = x.days ? r2(x.amount / x.days) : null;
    if (ours != null && x.days != null && ours < x.days) add({ level: 'bad', area: 'ld', veh: x.veh, amount: r2(perDay * (x.days - ours)), text: `${short(x.veh)} ${t.trip}: LD ${rs(x.amount)} for ${x.days} days — your register has it loaded ${dm(t.loadDate)} and unloaded ${dm(t.unloadDate)}, ${ours} days` });
    else add({ level: 'info', area: 'ld', veh: x.veh, amount: 0, text: `${short(x.veh)}${t ? ` ${t.trip}` : ''}: late-delivery (LD) penalty ${rs(x.amount)} — ${x.days} days${x.wt ? ` × ${x.wt} T` : ''}${ours != null ? ` (your dates: ${ours} days)` : ''}` });
  }

  // ---- the Ledger: the net you've booked for the month ----
  const ledger = (data.ssfc && data.ssfc.rows) || [];
  for (const v of stmt.vehicles) {
    const l = ledger.filter((x) => x.month === month && x.veh === v.veh);
    if (!l.length || v.net == null) continue;
    const booked = sum(l, (x) => x.net);
    const reg = netNote.get(v.veh);
    if (reg && Math.abs(reg.regNet - booked) <= 1) { reg.text += ' (your Ledger has the same)'; continue; }
    if (Math.abs(booked - v.net) > 1) add({ level: 'warn', area: 'ledger', veh: v.veh, amount: r2(Math.abs(booked - v.net)), text: `${short(v.veh)}: your Ledger has ${rs(booked)} as SSFC's net for ${monthName(month)}; the statement says ${rs(v.net)}` });
  }

  const order = { bad: 0, warn: 1, info: 2 };
  issues.sort((a, b) => order[a.level] - order[b.level] || (b.amount || 0) - (a.amount || 0));
  const totals = {
    freight: sum(vehicles, (x) => x.freight), diesel: sum(vehicles, (x) => x.diesel), cashOffice: sum(vehicles, (x) => x.cashOffice),
    deductions: sum(vehicles, (x) => x.dedTotal), net: sum(vehicles, (x) => x.net), trips: sum(vehicles, (x) => x.trips),
    atStake: sum(issues.filter((x) => x.level === 'bad'), (x) => x.amount), bad: issues.filter((x) => x.level === 'bad').length, warn: issues.filter((x) => x.level === 'warn').length,
  };
  return { month, stmt, pairs, vehicles, def, issues, totals, dieselTrips };
}

// Diesel, trip by trip (the trips are paired by vehicle and loading weight): what SSFC charged on
// each trip against
//   - HSD Data: the fills from SSFC (its pumps, and what it lists in its Vriddhi column) tagged to
//     that trip, from the month HSD Data logs them; else
//   - the Trip Register's SSFC Diesel Ltr / Amount (P / Q), which the SSFC Net is worked out from.
// Compared in ₹: SSFC's "CASH" under a pump is diesel bought for cash — its litres aren't on the
// statement. A fill on one trip in SSFC's statement and on the next (or the one before) in yours
// shows as one line — the fill to retag — not two differences.
function dieselByTrip(v, vp, data, useHsd, add) {
  const out = [];
  const lc = (x) => String(x || '').toLowerCase();
  for (const p of vp.filter((x) => x.t)) {
    const { s, t } = p;
    const pumps = s.pumps || [];
    const fills = (data.hsd || []).filter((h) => h.veh === v.veh && /ssfc/i.test(h.source || '') && t.trip && lc(h.trip) === lc(t.trip));
    const row = {
      veh: v.veh, trip: t.trip, row: t.row, loadDate: s.loadDate, loadWt: s.loadWt, lr: s.lr || '',
      ssfcL: s.ssfcLitres, ssfcRs: s.ssfcDiesel, cash: r2(pumps.reduce((a, x) => a + (x.cash || 0), 0)),
      freeL: r2(pumps.filter((x) => !(x.amount > 0)).reduce((a, x) => a + (x.qty || 0), 0)),       // listed at ₹0
      regL: r2(t.ssfcLtr || 0), regRs: r2(t.ssfcAmt || 0),
      hsdL: r2(fills.reduce((a, h) => a + (h.qty || 0), 0)), hsdRs: r2(fills.reduce((a, h) => a + (h.amount || 0), 0)), hsdN: fills.length, useHsd,
      status: 'ok',
    };
    row.ref = useHsd ? 'HSD Data' : 'Trip Register';
    row.refL = useHsd ? row.hsdL : row.regL;
    row.refRs = useHsd ? row.hsdRs : row.regRs;
    row.dRs = r2(row.ssfcRs - row.refRs);
    row.dL = r2(row.ssfcL - row.refL);
    // the register's P / Q against SSFC's figures (what the SSFC Net uses)
    row.regDRs = r2(row.ssfcRs - row.regRs);
    out.push(row);
  }
  out.sort((a, b) => String(a.loadDate).localeCompare(String(b.loadDate)));
  // rounding: each fill is ₹ to the paisa on one side, whole rupees on the other
  const tol = (x) => (x.dRs > 0 ? Math.max(50, Math.abs(x.ssfcRs) * 0.001) : Math.max(100, Math.abs(x.ssfcRs) * 0.002));
  const off = (x) => Math.abs(x.dRs) > tol(x);
  const litres = (x, which) => (which === 'ssfc'
    ? `${ind(x.ssfcL)} L${x.cash ? ` + ${rs(x.cash)} cash diesel` : ''} (${rs(x.ssfcRs)})`
    : `${ind(x.refL)} L (${rs(x.refRs)})`);
  // a fill on the wrong trip: one trip over, the next under, by the same ₹
  for (let i = 0; i + 1 < out.length; i++) {
    const a = out[i]; const b = out[i + 1];
    if (a.status !== 'ok' || b.status !== 'ok' || !off(a) || !off(b) || Math.abs(a.dRs + b.dRs) > Math.max(tol(a), tol(b))) continue;
    const [inSsfc, inYours] = a.dRs > 0 ? [a, b] : [b, a];
    a.status = 'moved'; b.status = 'moved';
    const L = Math.abs(inYours.dL) > 1 && !a.cash && !b.cash ? `${ind(Math.abs(inYours.dL))} L of diesel (${rs(Math.abs(a.dRs))})` : `diesel worth ${rs(Math.abs(a.dRs))}`;
    add({ level: 'warn', area: 'diesel', veh: v.veh, amount: 0, trips: [a.trip, b.trip],
      text: `${short(v.veh)}: ${L} is on ${inSsfc.trip} in SSFC's statement but on ${inYours.trip} in your ${a.ref} — retag the fill to ${inSsfc.trip}; the two trips together agree` });
  }
  for (const x of out) {
    if (x.status !== 'ok') continue;
    const head = `${short(x.veh)} ${x.trip} (loaded ${dm(x.loadDate)}, ${x.loadWt} T): SSFC charged ${litres(x, 'ssfc')}; your ${x.useHsd ? 'HSD Data has' : 'Trip Register (SSFC Diesel) has'} ${litres(x, 'ref')}${x.useHsd ? ` from SSFC tagged to it` : ''}`;
    if (off(x)) {
      x.status = x.dRs > 0 ? 'more' : 'less';
      const dL = Math.abs(x.dL) > 1 && !x.cash ? ` (${ind(Math.abs(x.dL))} L)` : '';
      add({ level: x.dRs > 0 ? 'bad' : 'warn', area: 'diesel', veh: x.veh, amount: x.dRs > 0 ? x.dRs : 0, trips: [x.trip],
        text: `${head} — ${x.dRs > 0 ? `${rs(x.dRs)}${dL} more charged than you have` : `${rs(-x.dRs)}${dL} more in yours than SSFC charged: a fill entered twice or on the wrong trip, or SSFC will charge it later`}` });
    } else if (!x.useHsd && Math.abs(x.dL) > 1 && Math.abs(x.dL + x.freeL) > 1 && !x.cash) {
      // the same ₹, other litres: the register's litres typed differently — nothing in SSFC's favour
      x.status = 'litres';
      add({ level: 'info', area: 'diesel', veh: x.veh, amount: 0, trips: [x.trip], text: `${head} — the same ₹, ${ind(Math.abs(x.dL))} L ${x.dL > 0 ? 'less' : 'more'} in yours: correct the litres (P)` });
    }
    // HSD Data agrees with SSFC, but the register's P / Q doesn't: correct the register
    if (x.useHsd && x.status === 'ok' && Math.abs(x.regDRs) > tol(x)) {
      x.status = 'register';
      add({ level: 'warn', area: 'register', veh: x.veh, amount: Math.abs(x.regDRs), trips: [x.trip],
        text: `${short(x.veh)} ${x.trip} (row ${x.row}): your SSFC Diesel is ${ind(x.regL)} L / ${rs(x.regRs)}; SSFC charged ${litres(x, 'ssfc')} and your HSD Data agrees — correct P / Q on this trip` });
    }
  }
  return out;
}

// DEF refills: SSFC's DEF bills (in any statement loaded) and the Urea DEF sheet's refills bought from
// SSFC, paired by vehicle and date (±3 days); then for this statement: bills with no refill of yours
// (charged for DEF you have no record of), refills of yours SSFC hasn't charged, and price differences
export function defCheck(stmt, data, others = []) {
  const issues = [];
  const all = [stmt, ...others].flatMap((s) => s.expenses.filter((e) => e.def && e.amount > 0).map((e) => ({ ...e, month: s.month, mine: s === stmt })));
  const ours = (data.urea || []).filter((u) => FROM_SSFC.test(u.from || '')).map((u) => ({ ...u, used: false }));
  const pair = (e) => {
    const c = ours.filter((u) => !u.used && u.veh === e.veh && e.date && Math.abs(days(u.date, e.date)) <= 3).sort((a, b) => Math.abs(days(a.date, e.date)) - Math.abs(days(b.date, e.date)) || Math.abs(a.amount - e.amount) - Math.abs(b.amount - e.amount))[0];
    if (c) c.used = true;
    return c || null;
  };
  // the bills in date order, so each takes the nearest refill
  const bills = all.sort((a, b) => String(a.date).localeCompare(String(b.date))).map((e) => ({ e, u: pair(e) }));
  const mine = bills.filter((b) => b.e.mine);
  const byVeh = new Map();
  for (const { e, u } of mine) {
    const v = byVeh.get(e.veh) || { veh: e.veh, ssfcN: 0, ssfcRs: 0, oursN: 0, oursRs: 0, oursL: 0, unmatched: 0, unmatchedRs: 0, priceDiff: 0 };
    v.ssfcN += 1; v.ssfcRs = r2(v.ssfcRs + e.amount);
    if (u) {
      v.oursN += 1; v.oursRs = r2(v.oursRs + (u.amount || 0)); v.oursL = r2(v.oursL + (u.qty || 0));
      const d = r2(e.amount - (u.amount || 0));
      if (Math.abs(d) > 1) {
        v.priceDiff = r2(v.priceDiff + d);
      }
    } else {
      v.unmatched += 1; v.unmatchedRs = r2(v.unmatchedRs + e.amount);
      // the refill on another vehicle the same day?
      // your sheet has a refill that day bought elsewhere, or one on another vehicle not charged to it?
      const elsewhere = (data.urea || []).find((x) => x.veh === e.veh && !FROM_SSFC.test(x.from || '') && e.date && Math.abs(days(x.date, e.date)) <= 1);
      const other = ours.find((x) => !x.used && x.veh !== e.veh && e.date && x.date === e.date && Math.abs(x.amount - e.amount) <= 1 && !all.some((b) => b.veh === x.veh && b.date && Math.abs(days(b.date, x.date)) <= 3));
      issues.push({ level: 'bad', area: 'def', veh: e.veh, amount: e.amount, text: `${short(e.veh)}: SSFC charged DEF “${e.desc}” ${rs(e.amount)} on ${dm(e.date)} — no DEF refill from SSFC in your Urea DEF sheet within 3 days of it${elsewhere ? ` (your sheet has ${elsewhere.qty} L on ${dm(elsewhere.date)} bought from ${elsewhere.from || 'someone else'} — charged by SSFC too?)` : other ? ` (your sheet has one from SSFC on ${short(other.veh)} that day that SSFC hasn't charged — the wrong vehicle?)` : ''}` });
    }
    byVeh.set(e.veh, v);
  }
  for (const v of byVeh.values()) {
    if (Math.abs(v.priceDiff) > 1) issues.push({ level: v.priceDiff > 0 ? 'bad' : 'info', area: 'def', veh: v.veh, amount: v.priceDiff > 0 ? v.priceDiff : 0, text: `${short(v.veh)}: for the DEF refills that pair up, SSFC charged ${rs(v.priceDiff > 0 ? v.priceDiff : -v.priceDiff)} ${v.priceDiff > 0 ? 'more' : 'less'} than your Urea DEF sheet's amounts` });
  }
  // your refills from SSFC in this statement's month (and the month before) that no statement has charged
  const from = addMonths(stmt.month, -1);
  const months = new Set([stmt, ...others].map((s) => s.month));
  for (const u of ours.filter((x) => !x.used && x.date && x.date.slice(0, 7) >= from && x.date.slice(0, 7) <= stmt.month)) {
    const nextLoaded = months.has(addMonths(u.date.slice(0, 7), 1));
    issues.push({ level: 'info', area: 'def', veh: u.veh, amount: 0, text: `${short(u.veh)}: your DEF refill from SSFC on ${dm(u.date)} (${u.qty} L, ${rs(u.amount)}) isn't in SSFC's bills${nextLoaded ? '' : ' yet — it may come next month'}` });
  }
  const shared = mine.filter((b) => b.e.others && b.e.others.length);
  return { issues, vehicles: [...byVeh.values()].sort((a, b) => a.veh.localeCompare(b.veh)), shared: shared.length, bills: mine.length, paired: mine.filter((b) => b.u).length };
}

// ---- settled: a month, or one finding, you've dealt with --------------------------------------
// A finding is known by what it says (so if the books or the statement change, it shows again).
export function findingKey(x) {
  const s = `${x.level}|${x.area}|${x.veh || ''}|${x.text}`;
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}
// mark: { settled: { at, by } | null, cleared: { [findingKey]: { at, by } } } — kept with the statement
export function settledView(rep, mark = {}) {
  const cleared = mark.cleared || {};
  const month = !!mark.settled;
  const open = [];
  const settled = [];
  for (const x of rep.issues) (month || cleared[findingKey(x)] ? settled : open).push(x);
  const bad = open.filter((x) => x.level === 'bad');
  return {
    open, settled, monthSettled: month, settledOn: mark.settled || null,
    atStake: r2(bad.reduce((a, x) => a + (x.amount || 0), 0)), bad: bad.length, warn: open.filter((x) => x.level === 'warn').length,
  };
}
