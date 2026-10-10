// Rebuild the tanker invoice check from a "Download check data (for support)"
// file (Trips per tanker), with the model exactly as shipped in loading/index.html.
// Shows each customer's status, the bills on no trip and the alerts, and
// whether they match what the phone showed.
// Run: node tests/loading_web/replay.mjs Vriddhi_Invoice_Check_<from>_to_<to>.json
import fs from 'node:fs';

const HTML = fs.readFileSync(new URL('../../loading/index.html', import.meta.url), 'utf8');
const START = HTML.indexOf('/* ===================== INVOICE TAGGING MODEL');
const END = HTML.indexOf('/* ===================== END INVOICE TAGGING MODEL');
const INV = new Function(HTML.slice(START, END) + '\nreturn INV;')();

const file = process.argv[2];
// --settle <bill no> "<reason>": see the result as if that bill on no trip were marked as checked by hand
const settle = process.argv.indexOf('--settle') > 0 ? [process.argv[process.argv.indexOf('--settle') + 1], process.argv[process.argv.indexOf('--settle') + 2] || 'settled'] : null;
if (!file) { console.error('usage: node tests/loading_web/replay.mjs <check data .json>'); process.exit(2); }
const d = JSON.parse(fs.readFileSync(file, 'utf8'));
if (settle) {
  const b = d.bills.find((x) => x.bill_no === settle[0]);
  if (b) (d.bills_checked_by_hand = d.bills_checked_by_hand || []).push({ bill_key: b.key, bill_no: b.bill_no, note: settle[1] });
}
const trips = d.trips.map((t) => ({ id: t.id, plate: t.vehicle, ts: Date.parse(t.time), day: t.day, total: t.litres, dest: t.sold_to }));
const ctx = INV.context({
  plates: d.tankers.filter((p) => !d.left_out_vehicles.includes(p)), skip: d.left_out_vehicles, ignore: d.own_customers,
  dests: d.sold_to_customers.map((x) => x.name), tol: d.settings.bill_may_be_less_l, over: d.settings.bill_may_be_more_l,
  from: d.settings.check_from, until: d.ledger.connected ? d.ledger.bills_up_to : null, links: d.links,
  checked: d.checked_by_hand, billChecked: d.bills_checked_by_hand || [], bulk: d.bulk_customers,
  // the business day it was saved on (older files: the IST date it was exported)
  today: d.today || new Date(Date.parse(d.exported_at) + 5.5 * 3600e3 - 7.5 * 3600e3).toISOString().slice(0, 10),
  billsFrom: d.ledger.bills_loaded_from, billsTo: d.ledger.bills_loaded_to });
const rec = INV.reconcile(trips, d.bills, d.tags, ctx, d.period);
const tripOf = Object.fromEntries(trips.map((t) => [t.id, t]));
const name = (t) => t ? `${t.plate} ${t.day} → ${t.dest || '(no customer)'} ${t.total} L` : '?';

console.log(`${d.what} · ${d.app_build} · ${d.period.from}..${d.period.to} · checks from ${d.settings.check_from}`);
console.log('\nPer customer (replayed  /  on the phone):');
rec.perCust.forEach((a, i) => {
  const p = d.result.per_customer[i] || {};
  console.log(`  ${(a.dests.join(' + ') || a.custs.join(' + ')).padEnd(34)} ${a.status.padEnd(7)} / ${p.status || '-'}`
    + `  sent ${a.delivered}  tagged ${a.tagged}  to tag ${a.toTag}  extra ${a.extraHard}  covered ${a.coveredL}  by hand ${a.handL}  short ${a.short}  over/under ${a.diff}`);
});
console.log('\nBills on no trip:');
rec.loose.forEach((x) => console.log(`  #${x.bill.bill_no} ${x.bill.date} ${x.bill.vehicle || '(no vehicle)'} ${x.bill.qty} L ${x.bill.customer} — ${x.kind}`
  + (x.trips.length ? ' — could go on: ' + x.trips.map(name).join(' | ') : '')));
console.log('\nAlerts:');
rec.alerts.forEach((a) => console.log(`  [${a.lvl}] ${a.title} — ${a.text}`));
const same = JSON.stringify(rec.perCust.map((a) => a.status)) === JSON.stringify(d.result.per_customer.map((a) => a.status));
console.log('\n' + (same ? 'Same result as the phone ✓' : 'Differs from the phone — the file was saved by another app build' + (settle ? ', or a bill was settled here with --settle' : '')));
console.log('Trips checked by hand:', d.checked_by_hand.map((c) => name(tripOf[c.trip_id]) + ` “${c.note}”`).join(' | ') || 'none');
