// Tanker Loading — invoice tagging: which ledger bills a trip was billed in,
// suggestions, and the per-trip / per-tanker / per-customer checks.
// The model is cut from loading/index.html as shipped.
// Run: node --test tests/loading_web/*.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const HTML = fs.readFileSync(new URL('../../loading/index.html', import.meta.url), 'utf8');
const START = HTML.indexOf('/* ===================== INVOICE TAGGING MODEL');
const END = HTML.indexOf('/* ===================== END INVOICE TAGGING MODEL');
if (START < 0 || END < START) throw new Error('invoice model markers not found in loading/index.html');
const INV = new Function(HTML.slice(START, END) + '\nreturn INV;')();

// All names, plates and numbers are made up.
const A = 'OD23A3710', B = 'OR15R1110', C = 'OR15R5510';
const H = 3600e3, T0 = Date.UTC(2026, 9, 2, 4);              // 2 Oct 2026, 9:30 AM IST
let n = 0;
const trip = (plate, day, total, dest, extra = {}) => ({ id: 't' + (++n), plate, ts: T0 + (Date.parse(day) - Date.UTC(2026, 9, 2)) + (extra.h || 0) * H, day, total, dest, ...extra });
const bill = (no, date, qty, customer, vehicle, product = 'HSD') => ({
  key: INV.billKey(product, date, no), product, fy: INV.fyOf(date), bill_no: String(no), date, vehicle, qty, amount: qty * 99.5,
  customer, ckey: INV.normName(customer) });
const tagOf = (b, t, extra = {}) => ({ ...b, trip_id: t.id, plate: t.plate, mode: 'manual', ...extra });
const ctx = (o = {}) => INV.context({ plates: [A, B, C], tol: 10, over: 80, from: '2026-10-01', until: '2026-10-09',
  billsFrom: '2026-09-28', billsTo: '2026-10-12', links: [], bulk: [], ...o });
const keys = (bs) => bs.map((b) => b.bill_no);

test('ledger keys and names', () => {
  assert.equal(INV.fyOf('2026-04-01'), '2026-27');
  assert.equal(INV.fyOf('2027-03-31'), '2026-27');
  assert.equal(INV.billKey('HSD', '2026-10-02', ' 1234 '), 'HSD|2026-27|1234');
  assert.equal(INV.normName('  Shyam   Metaliks & Energy '), 'shyam metaliks & energy');
  assert.ok(INV.nameSim('Shyam Metalics', 'SHYAM METALIKS AND ENERGY LIMITED') >= 0.99, 'one letter apart, Ltd ignored');
  assert.ok(INV.nameSim('Aryan Ispat & Power Private Ltd.', 'Aryan Ispat and Power Pvt Ltd') >= 0.99);
  assert.equal(INV.nameSim('Orissa Metaliks', 'Demo Roadlines'), 0);
  const c = ctx();
  assert.equal(INV.billPlate({ vehicle: 'od-23-a-3710' }, c), A, 'dashes and case do not matter');
  assert.equal(INV.billPlate({ vehicle: 'OD 23 A 3710 (tanker)' }, c), A);
  assert.equal(INV.billPlate({ vehicle: '' }, c), '');
  assert.equal(INV.billPlate({ vehicle: 'OR09X4455' }, c), null, "a customer's own truck");
});

test('a 12 KL tanker billed in 3 × 4 KL is suggested as one sure set', () => {
  const t = trip(A, '2026-10-02', 12000, 'Shyam Metalics');
  const bills = [bill(101, '2026-10-02', 4000, 'Shyam Metaliks and Energy Ltd', 'OD23A3710'),
    bill(102, '2026-10-02', 4000, 'Shyam Metaliks and Energy Ltd', 'OD23A3710'),
    bill(103, '2026-10-02', 4000, 'Shyam Metaliks and Energy Ltd', 'OD-23-A-3710'),
    bill(104, '2026-10-02', 4000, 'Shyam Metaliks and Energy Ltd', 'OR15R1110'),     // the other tanker's
    bill(105, '2026-10-02', 300, 'Shyam Metaliks and Energy Ltd', 'OR09X4455')];     // their own truck
  const s = INV.suggest([t], bills, [], ctx())[t.id];
  assert.deepEqual(keys(s.bills), ['101', '102', '103']);
  assert.equal(s.sum, 12000);
  assert.ok(s.sure && s.exact);
});

test('a linked customer and the vehicle win over a bill of the right size elsewhere', () => {
  const t = trip(A, '2026-10-02', 11955, 'DBL - Siarmal');
  const links = [{ ckey: 'demo buildcon ltd', dest: 'DBL - Siarmal', customer: 'Demo Buildcon Ltd' }];
  const bills = [bill(201, '2026-10-02', 11955, 'Other Power Ltd', ''),              // right size, wrong customer, no vehicle
    bill(202, '2026-10-03', 11950, 'Demo Buildcon Ltd', 'OD23A3710')];                // next day, 5 L off, ours
  const s = INV.suggest([t], bills, [], ctx({ links }))[t.id];
  assert.deepEqual(keys(s.bills), ['202']);
  assert.ok(s.sure, 'vehicle matches, customer linked, 5 L under the trip is within the 10 L allowed');
  assert.ok(!s.exact);
});

test('two trips of one tanker on two days each get their own day\'s bills', () => {
  const t1 = trip(B, '2026-10-02', 12000, 'Orissa Metaliks'), t2 = trip(B, '2026-10-03', 12000, 'Orissa Metaliks');
  const bills = [301, 302, 303].map((k) => bill(k, '2026-10-02', 4000, 'Orissa Metaliks Pvt Ltd', B))
    .concat([304, 305, 306].map((k) => bill(k, '2026-10-03', 4000, 'Orissa Metaliks Pvt Ltd', B)));
  const s = INV.suggest([t2, t1], bills, [], ctx());
  assert.deepEqual(keys(s[t1.id].bills), ['301', '302', '303']);
  assert.deepEqual(keys(s[t2.id].bills), ['304', '305', '306']);
});

test('a part-tagged trip is offered only what is still missing', () => {
  const t = trip(A, '2026-10-02', 12000, 'Shyam Metalics');
  const b = [401, 402, 403].map((k) => bill(k, '2026-10-02', 4000, 'Shyam Metaliks and Energy Ltd', A));
  const tags = [tagOf(b[0], t), tagOf(b[1], t)];
  const s = INV.suggest([t], b, tags, ctx())[t.id];
  assert.deepEqual(keys(s.bills), ['403']);
  const r = INV.reconcile([t], b, tags, ctx(), { from: '2026-10-01', to: '2026-10-31' });
  assert.equal(r.rows[0].status, 'under');
  assert.equal(r.rows[0].diff, -4000);
  assert.equal(r.alerts[0].kind, 'under');
});

test('trip statuses: ok within tolerance, over, not invoiced, waiting for the DayBook, before the start', () => {
  const ok = trip(A, '2026-10-02', 12000, 'Shyam Metalics'), over = trip(B, '2026-10-02', 8000, 'Orissa Metaliks');
  const none = trip(C, '2026-10-03', 9000, 'Shyam Metalics'), wait = trip(C, '2026-10-09', 9000, 'Shyam Metalics');
  const old = trip(A, '2026-09-29', 9000, 'Shyam Metalics');
  const b1 = bill(501, '2026-10-02', 11990, 'Shyam Metaliks and Energy Ltd', A), b2 = bill(502, '2026-10-02', 8600, 'Orissa Metaliks Pvt Ltd', B);
  const tags = [tagOf(b1, ok), tagOf(b2, over)];
  const r = INV.reconcile([ok, over, none, wait, old], [b1, b2], tags, ctx(), { from: '2026-09-01', to: '2026-10-31' });
  const st = Object.fromEntries(r.rows.map((x) => [x.trip.id, x.status]));
  assert.deepEqual([st[ok.id], st[over.id], st[none.id], st[wait.id], st[old.id]], ['ok', 'over', 'none', 'await', 'before']);
  assert.deepEqual(r.alerts.map((a) => a.kind), ['over', 'none']);
  // without the ledger there is no telling: an untagged trip is simply not invoiced
  const r2 = INV.reconcile([wait], [], [], ctx({ until: null }), { from: '2026-10-01', to: '2026-10-31' });
  assert.equal(r2.rows[0].status, 'none');
});

test('a bill in a tanker\'s name on no trip: extra sale when no trip has room, else waiting to be tagged', () => {
  const t = trip(A, '2026-10-02', 12000, 'Shyam Metalics');
  const b = [601, 602, 603].map((k) => bill(k, '2026-10-02', 4000, 'Shyam Metaliks and Energy Ltd', A));
  const extra = bill(604, '2026-10-02', 4000, 'Demo Traders', A);                       // a 4th 4 KL bill on a 12 KL trip
  const other = bill(605, '2026-10-04', 3000, 'Demo Traders', 'OR15R5510');            // C has no trip at all
  const truck = bill(606, '2026-10-02', 200, 'Shyam Metaliks and Energy Ltd', 'OR09X4455');   // not ours: left alone
  const tags = b.map((x) => tagOf(x, t));
  const r = INV.reconcile([t], b.concat([extra, other, truck]), tags, ctx(), { from: '2026-10-01', to: '2026-10-31' });
  assert.equal(r.rows[0].status, 'ok');
  assert.deepEqual(r.loose.map((x) => [x.bill.bill_no, x.kind]), [['604', 'extra'], ['605', 'extra']]);
  assert.deepEqual(r.alerts.map((a) => [a.kind, a.plate]), [['extra', A], ['extra', C]]);
  assert.equal(r.perTanker[A].named, 16000, 'litres billed in its name');
  assert.equal(r.perTanker[A].sent, 12000);
  assert.equal(r.perTanker[A].extra, 1);
  // before tagging, the same bill can still go on the trip → not an extra sale yet
  const r2 = INV.reconcile([t], b, [], ctx(), { from: '2026-10-01', to: '2026-10-31' });
  assert.deepEqual(r2.loose.map((x) => x.kind), ['untagged', 'untagged', 'untagged']);
  assert.equal(r2.rows[0].status, 'none');
});

test('bills before the start date and petrol bills are not in the check', () => {
  const r = INV.reconcile([], [bill(701, '2026-09-30', 4000, 'X Ltd', A), bill(702, '2026-10-02', 40, 'X Ltd', A, 'MS')], [], ctx(),
    { from: '2026-09-01', to: '2026-10-31' });
  assert.equal(r.loose.length, 0);
});

test('tag problems: another tanker\'s bill, a customer billed for someone else, a bill changed or deleted in the ledger', () => {
  const links = [{ ckey: 'orissa metaliks pvt ltd', dest: 'Orissa Metaliks', customer: 'Orissa Metaliks Pvt Ltd' }];
  const t = trip(A, '2026-10-02', 12000, 'Shyam Metalics');
  const bB = bill(801, '2026-10-02', 4000, 'Shyam Metaliks and Energy Ltd', B);
  const bO = bill(802, '2026-10-02', 4000, 'Orissa Metaliks Pvt Ltd', A);
  const bC = bill(803, '2026-10-02', 2000, 'Shyam Metaliks and Energy Ltd', A);
  const bG = bill(804, '2026-10-02', 2000, 'Shyam Metaliks and Energy Ltd', A);
  const tags = [tagOf(bB, t), tagOf(bO, t), tagOf(bC, t), tagOf(bG, t)];
  const now = [bB, bO, { ...bC, qty: 1500 }];                                           // 803 cut to 1,500 L, 804 deleted
  const r = INV.reconcile([t], now, tags, ctx({ links }), { from: '2026-10-01', to: '2026-10-31' });
  assert.deepEqual(r.rows[0].issues.map((i) => i.kind), ['veh', 'cust', 'changed', 'gone']);
  assert.match(r.rows[0].issues[2].text, /2000 → 1500 L/);
});

test('per customer: SMC units share one ledger name, group companies add up, a wrong-customer tag shows on both', () => {
  const links = [
    { ckey: 'demo smc ltd', dest: 'SMC Unit 1', customer: 'Demo SMC Ltd' },
    { ckey: 'demo smc ltd', dest: 'SMC Unit 2', customer: 'Demo SMC Ltd' },
    { ckey: 'agrim demo (jv)', dest: 'Lakhanpur Group Companies', customer: 'Agrim Demo (Jv)' },
    { ckey: 'babylon demo pvt ltd', dest: 'Lakhanpur Group Companies', customer: 'Babylon Demo PVT LTD' },
    { ckey: 'orissa metaliks pvt ltd', dest: 'Orissa Metaliks', customer: 'Orissa Metaliks Pvt Ltd' },
    { ckey: 'shyam metaliks and energy ltd', dest: 'Shyam Metalics', customer: 'Shyam Metaliks and Energy Ltd' }];
  const u1 = trip(A, '2026-10-02', 12000, 'SMC Unit 1'), u2 = trip(B, '2026-10-02', 12000, 'SMC Unit 2');
  const lk = trip(C, '2026-10-03', 12000, 'Lakhanpur Group Companies'), sh = trip(A, '2026-10-04', 12000, 'Shyam Metalics');
  const bU1 = bill(901, '2026-10-02', 12000, 'Demo SMC Ltd', A), bU2 = bill(902, '2026-10-02', 11000, 'Demo SMC Ltd', B);
  const bL1 = bill(903, '2026-10-03', 8000, 'Agrim Demo (Jv)', C), bL2 = bill(904, '2026-10-03', 4000, 'Babylon Demo PVT LTD', C);
  const bS = bill(905, '2026-10-04', 12000, 'Orissa Metaliks Pvt Ltd', A);               // Shyam's trip billed to Orissa
  const tags = [tagOf(bU1, u1), tagOf(bU2, u2), tagOf(bL1, lk), tagOf(bL2, lk), tagOf(bS, sh)];
  const r = INV.reconcile([u1, u2, lk, sh], [bU1, bU2, bL1, bL2, bS], tags, ctx({ links }), { from: '2026-10-01', to: '2026-10-31' });
  const by = Object.fromEntries(r.perCust.map((a) => [a.dests.concat(a.custs).sort().join(' + '), [a.delivered, a.invoiced, a.status]]));
  assert.deepEqual(by['Demo SMC Ltd + SMC Unit 1 + SMC Unit 2'], [24000, 23000, 'under']);
  assert.deepEqual(by['Agrim Demo (Jv) + Babylon Demo PVT LTD + Lakhanpur Group Companies'], [12000, 12000, 'ok']);
  assert.deepEqual(by['Shyam Metalics + Shyam Metaliks and Energy Ltd'], [12000, 0, 'under']);
  assert.deepEqual(by['Orissa Metaliks + Orissa Metaliks Pvt Ltd'], [0, 12000, 'over']);
  assert.ok(r.rows.find((x) => x.trip.id === sh.id).issues.some((i) => i.kind === 'cust'));
});

test('per customer: bills not on a trip count as invoiced, trips waiting for the DayBook are not "under"', () => {
  const links = [{ ckey: 'shyam metaliks and energy ltd', dest: 'Shyam Metalics', customer: 'Shyam Metaliks and Energy Ltd' }];
  const t1 = trip(A, '2026-10-02', 12000, 'Shyam Metalics'), t2 = trip(B, '2026-10-09', 12000, 'Shyam Metalics');
  const b1 = bill(1001, '2026-10-02', 12000, 'Shyam Metaliks and Energy Ltd', A);
  const loose = bill(1002, '2026-10-03', 5000, 'Shyam Metaliks and Energy Ltd', '');     // no vehicle, linked customer
  const r = INV.reconcile([t1, t2], [b1, loose], [tagOf(b1, t1)], ctx({ links }), { from: '2026-10-01', to: '2026-10-31' });
  const a = r.perCust.find((x) => x.dests.includes('Shyam Metalics'));
  assert.deepEqual([a.delivered, a.invoiced, a.extraL, a.waiting], [24000, 17000, 5000, 12000]);
  assert.equal(a.status, 'await');
  assert.deepEqual(r.loose.map((x) => x.kind), ['loose']);
});

test('the period: a trip on the 30th billed on the 1st counts once, in the trip\'s month', () => {
  const t = trip(A, '2026-10-31', 12000, 'Shyam Metalics');
  const b = bill(1101, '2026-11-01', 12000, 'Shyam Metaliks and Energy Ltd', A);
  const c = ctx({ until: '2026-11-03', billsTo: '2026-11-05' });
  const oct = INV.reconcile([t], [b], [tagOf(b, t)], c, { from: '2026-10-01', to: '2026-10-31' });
  assert.equal(oct.perTanker[A].tagged, 12000);
  assert.equal(oct.alerts.length, 0);
  const nov = INV.reconcile([t], [b], [tagOf(b, t)], c, { from: '2026-11-01', to: '2026-11-30' });
  assert.equal(nov.alerts.length, 0, 'the November bill is on an October trip — not an extra sale');
  assert.equal(nov.perTanker[A].trips, 0);
});

test('candidates for the manual picker: best first, the wide list adds other vehicles and dates', () => {
  const t = trip(A, '2026-10-02', 12000, 'Shyam Metalics');
  const bills = [bill(1201, '2026-10-02', 4000, 'Shyam Metaliks and Energy Ltd', ''),
    bill(1202, '2026-10-02', 4000, 'Shyam Metaliks and Energy Ltd', A),
    bill(1203, '2026-10-02', 4000, 'Someone', 'OR15R1110'),
    bill(1204, '2026-10-08', 4000, 'Shyam Metaliks and Energy Ltd', A)];
  assert.deepEqual(INV.candidates(t, bills, [], ctx()).map((x) => x.bill.bill_no), ['1202', '1201']);
  assert.deepEqual(INV.candidates(t, bills, [], ctx(), true).map((x) => x.bill.bill_no), ['1202', '1201', '1203', '1204']);
  assert.deepEqual(INV.candidates(t, bills, [tagOf(bills[1], t)], ctx()).map((x) => x.bill.bill_no), ['1201'], 'tagged bills drop out');
});

test('the litres sent are a little less than the bill: up to 80 L more on the bill still matches', () => {
  const links = [{ ckey: 'demo buildcon ltd', dest: 'DBL - Siarmal', customer: 'Demo Buildcon Ltd' }];
  const t = trip(A, '2026-10-02', 11955, 'DBL - Siarmal');
  const b75 = bill(1301, '2026-10-02', 12030, 'Demo Buildcon Ltd', A);            // 75 L more: the usual
  const s = INV.suggest([t], [b75], [], ctx({ links }))[t.id];
  assert.deepEqual(keys(s.bills), ['1301']);
  assert.ok(s.sure, 'sure enough to tag by itself');
  const ok = INV.reconcile([t], [b75], [tagOf(b75, t)], ctx({ links }), { from: '2026-10-01', to: '2026-10-31' });
  assert.equal(ok.rows[0].status, 'ok');
  assert.equal(ok.rows[0].diff, 75);
  assert.equal(ok.perCust[0].status, 'ok');
  // 95 L more is past the buffer: not offered, and over-invoiced once tagged
  const b95 = bill(1302, '2026-10-02', 12050, 'Demo Buildcon Ltd', A);
  assert.equal(INV.suggest([t], [b95], [], ctx({ links }))[t.id], undefined);
  const over = INV.reconcile([t], [b95], [tagOf(b95, t)], ctx({ links }), { from: '2026-10-01', to: '2026-10-31' });
  assert.equal(over.rows[0].status, 'over');
  assert.equal(over.perCust[0].status, 'over');
  // a bill LESS than what was sent gets only the small allowance (10 L)
  const b15 = bill(1303, '2026-10-02', 11940, 'Demo Buildcon Ltd', A);
  const under = INV.reconcile([t], [b15], [tagOf(b15, t)], ctx({ links }), { from: '2026-10-01', to: '2026-10-31' });
  assert.equal(under.rows[0].status, 'under');
  // 3 × 4,000 L + a few litres on the last bill for a 11,955 L trip
  const parts = [bill(1304, '2026-10-02', 4000, 'Demo Buildcon Ltd', A), bill(1305, '2026-10-02', 4000, 'Demo Buildcon Ltd', A),
    bill(1306, '2026-10-02', 4020, 'Demo Buildcon Ltd', A)];
  const s3 = INV.suggest([t], parts, [], ctx({ links }))[t.id];
  assert.deepEqual(keys(s3.bills), ['1304', '1305', '1306']);
  assert.equal(s3.sum, 12020);
});

test('a bill in a tanker\'s name that is just the buffer over a full trip is not an extra sale', () => {
  const t = trip(B, '2026-10-02', 11955, 'Orissa Metaliks');
  const b = bill(1401, '2026-10-02', 12000, 'Orissa Metaliks Pvt Ltd', B);
  const r = INV.reconcile([t], [b], [], ctx(), { from: '2026-10-01', to: '2026-10-31' });
  assert.deepEqual(r.loose.map((x) => x.kind), ['untagged'], 'it can still go on the trip');
  assert.deepEqual(keys(r.rows[0].sug.bills), ['1401']);
});

test('an untagged sale says whether its bills are already in the ledger', () => {
  const t = trip(A, '2026-10-02', 12000, 'Shyam Metalics'), u = trip(B, '2026-10-02', 9000, 'Orissa Metaliks');
  const b = bill(1501, '2026-10-02', 12040, 'Shyam Metaliks and Energy Ltd', A);
  const r = INV.reconcile([t, u], [b], [], ctx(), { from: '2026-10-01', to: '2026-10-31' });
  const a = Object.fromEntries(r.alerts.filter((x) => x.kind === 'none').map((x) => [x.plate, x]));
  assert.equal(a[A].title, 'Sale not tagged yet — bills found');
  assert.match(a[A].text, /bills 1501 = 12040 L/);
  assert.equal(a[B].title, 'Sale not invoiced');
});

test('per customer: each account lists its trips, its bills on no trip, its ledger names and its sure suggestions', () => {
  const links = [{ ckey: 'shyam metaliks and energy ltd', dest: 'Shyam Metalics', customer: 'Shyam Metaliks and Energy Ltd' }];
  const t1 = trip(A, '2026-10-02', 12000, 'Shyam Metalics'), t2 = trip(B, '2026-10-03', 12000, 'Shyam Metalics');
  const b1 = [1601, 1602, 1603].map((k) => bill(k, '2026-10-02', 4000, 'Shyam Metaliks and Energy Ltd', A));
  const stray = bill(1604, '2026-10-05', 3000, 'Unknown Buyer Pvt Ltd', C);              // C has no trip: on no trip, not linked
  const r = INV.reconcile([t1, t2], b1.concat([stray]), [], ctx({ links }), { from: '2026-10-01', to: '2026-10-31' });
  const shyam = r.perCust.find((a) => a.dests.includes('Shyam Metalics'));
  assert.deepEqual(shyam.tripIds.sort(), [t1.id, t2.id].sort());
  assert.deepEqual(shyam.sure, [t1.id], 'only the trip whose bills are sure');
  assert.deepEqual(shyam.loose.map((x) => x.bill.bill_no), ['1601', '1602', '1603']);
  assert.deepEqual(Object.keys(shyam.ckeys), ['shyam metaliks and energy ltd']);
  const other = r.perCust.find((a) => !a.dests.length);
  assert.deepEqual(other.custs, ['Unknown Buyer Pvt Ltd']);
  assert.deepEqual(other.ckeys, { 'unknown buyer pvt ltd': 'Unknown Buyer Pvt Ltd' });
  assert.equal(other.status, 'over');
});

test('retail bills (cash, UPI, fleet card) are never offered for a tanker, unless typed with our tanker\'s number', () => {
  const t = trip(B, '2026-10-07', 11946, 'SMC Unit 1');
  const bulk = ['Demo SMC Ltd'];
  const bills = [bill(3766, '2026-10-07', 792.14, 'Sudarshan Minerals & Logistics', ''), bill(3769, '2026-10-07', 59.37, 'EzyPay UPI ICICI', ''),
    bill(3780, '2026-10-08', 104.23, 'Fleet Card Posting', ''), bill(3790, '2026-10-07', 11980, 'Demo SMC Ltd', ''),
    bill(3791, '2026-10-07', 4000, 'Cash Sale', B)];                                  // retail name, our tanker's number: still shown
  const c = ctx({ bulk });
  assert.deepEqual(INV.candidates(t, bills, [], c).map((x) => x.bill.bill_no), ['3791', '3790']);
  const wide = INV.candidates(t, bills, [], c, true);
  assert.deepEqual(wide.slice(-3).map((x) => [x.bill.bill_no, x.retail]), [['3766', true], ['3769', true], ['3780', true]], 'Show all lists them last, marked retail');
  assert.deepEqual(keys(INV.suggest([t], bills, [], c)[t.id].bills), ['3790']);
  // a linked ledger name counts as bulk even if the ledger has no bulk group for it
  const c2 = ctx({ bulk, links: [{ ckey: 'sudarshan minerals & logistics', dest: 'SMC Unit 1', customer: 'Sudarshan Minerals & Logistics' }] });
  assert.ok(INV.candidates(t, bills, [], c2).some((x) => x.bill.bill_no === '3766'));
  // without the ledger's customer list nothing is filtered (better too much than missing a bill)
  assert.equal(INV.candidates(t, bills, [], ctx()).length, 5);
});

test('bills of OD15AF5510 are left out everywhere — they are accounted for elsewhere', () => {
  const D = 'OR15R9360';
  const t = trip(D, '2026-10-07', 17932, 'Shyam Metalics');
  const c = ctx({ plates: [A, B, C, D], skip: ['OD15AF5510'], bulk: ['Aryan Ispat & Power Private Ltd.'] });
  const od15 = bill(3740, '2026-10-07', 3000, 'Aryan Ispat & Power Private Ltd.', 'OD15AF5510');
  assert.equal(INV.candidates(t, [od15], [], c).length, 0);
  assert.equal(INV.candidates(t, [od15], [], c, true).length, 0, 'not even under Show all');
  assert.equal(INV.isPool(od15, c), false, 'never an extra sale or a bill on no trip');
  const r = INV.reconcile([t], [od15], [], c, { from: '2026-10-01', to: '2026-10-31' });
  assert.equal(r.loose.length, 0);
  assert.equal(r.rows[0].sug, null);
});

test('a bill to a name like a "Sold to" customer counts as bulk even if the ledger has not marked it', () => {
  const D = 'OR15R9360';
  const t = trip(D, '2026-10-07', 17932, 'Shyam Metalics');
  const c = ctx({ plates: [A, B, C, D], bulk: ['Some Other Bulk Ltd'], dests: ['Shyam Metalics', 'SMC Unit 1'] });
  const b = bill(3741, '2026-10-07', 17990, 'Shyam Metaliks and Energy Limited', '');
  assert.ok(INV.isBulk(b, c));
  assert.deepEqual(keys(INV.suggest([t], [b], [], c)[t.id].bills), ['3741']);
  assert.ok(!INV.isBulk(bill(3742, '2026-10-07', 50, 'EzyPay UPI ICICI', ''), c));
});

test('why a bill is not offered for a trip, for a bill found by its number', () => {
  const D = 'OR15R9360';
  const t = trip(D, '2026-10-07', 17932, 'Shyam Metalics'), u = trip(B, '2026-10-07', 12000, 'Orissa Metaliks');
  const c = ctx({ plates: [A, B, C, D], bulk: ['Shyam Metaliks and Energy Ltd'] });
  const S = 'Shyam Metaliks and Energy Ltd';
  assert.equal(INV.whyNot(t, bill(1, '2026-10-07', 17932, S, 'OR15R1110'), [], c), 'in the name of OR15R1110, not OR15R9360');
  assert.equal(INV.whyNot(t, bill(2, '2026-10-12', 17932, S, ''), [], c), 'dated 5 days after the trip');
  assert.equal(INV.whyNot(t, bill(3, '2026-10-07', 20, 'Walk-in', ''), [], c), 'retail customer');
  assert.equal(INV.whyNot(t, bill(4, '2026-10-07', 20, S, '', 'MS'), [], c), 'petrol bill');
  const b5 = bill(5, '2026-10-07', 17932, S, '');
  assert.equal(INV.whyNot(t, b5, [tagOf(b5, u)], c), 'already on another trip');
  assert.equal(INV.whyNot(t, b5, [], c), '', 'offered');
});

test('a bill of the 1st can go on a tanker sold on the 30th, before the check starts', () => {
  const sep30 = trip(A, '2026-09-30', 12000, 'Shyam Metalics'), oct1 = trip(A, '2026-10-01', 12000, 'Shyam Metalics', { h: 10 });
  const S = 'Shyam Metalics and Energy Ltd';
  const b1 = bill(3538, '2026-10-01', 12000, S, A), b2 = bill(3539, '2026-10-01', 12000, S, A);
  const c = ctx({ from: '2026-10-01' });
  const r = INV.reconcile([sep30, oct1], [b1, b2], [], c, { from: '2026-10-01', to: '2026-10-31' });
  const row = Object.fromEntries(r.rows.map((x) => [x.trip.id, x]));
  assert.equal(row[sep30.id].status, 'before', 'still not flagged');
  assert.ok(row[sep30.id].sug && row[oct1.id].sug, 'both trips get a suggestion');
  assert.deepEqual(r.loose.map((x) => x.kind), ['untagged', 'untagged'], 'neither bill is an extra sale');
  // only one bill: the October trip is matched first, the 30th's bill is then extra no more once tagged
  const one = INV.reconcile([sep30, oct1], [b1], [], c, { from: '2026-10-01', to: '2026-10-31' });
  assert.deepEqual(keys(Object.fromEntries(one.rows.map((x) => [x.trip.id, x]))[oct1.id].sug.bills), ['3538']);
  const tagged = INV.reconcile([sep30, oct1], [b1, b2], [tagOf(b1, sep30)], c, { from: '2026-10-01', to: '2026-10-31' });
  assert.deepEqual(tagged.loose.map((x) => [x.bill.bill_no, x.kind]), [['3539', 'untagged']]);
  assert.equal(tagged.alerts.filter((a) => a.kind === 'extra').length, 0);
});

test('bills to our own tanker ledger (own tank refills) are dropped', () => {
  const t = trip(B, '2026-10-03', 12000, 'Orissa Metaliks');
  const c = ctx({ ignore: ['VRIDDHI FUELS TANKER'] });
  const own = [bill(3584, '2026-10-03', 349.74, 'VRIDDHI FUELS TANKER', B), bill(3786, '2026-10-08', 270, 'Vriddhi Fuels  Tanker', A)];
  assert.ok(own.every((b) => INV.skipped(b, c)));
  const r = INV.reconcile([t], own, [], c, { from: '2026-10-01', to: '2026-10-31' });
  assert.equal(r.loose.length, 0, 'not an extra sale');
  assert.equal(r.perTanker[B].named, 0, 'not billed in its name either');
  assert.equal(r.perCust.length, 1, 'no "not linked" card for it');
  assert.equal(INV.candidates(t, own, [], c, true).length, 0);
});

test('moving a wrongly tagged bill: the trips it fits, best first, without the one it is on', () => {
  const D = 'OR15R9360', S = 'Shyam Metalics and Energy Ltd';
  const oct2 = trip(D, '2026-10-02', 17932, 'Shyam Metalics'), oct7 = trip(D, '2026-10-07', 17932, 'Shyam Metalics', { h: 2 });
  const other = trip(B, '2026-10-02', 12000, 'Orissa Metaliks');
  const b3576 = bill(3576, '2026-10-02', 18000, S, D);
  const c = ctx({ plates: [A, B, C, D], links: [{ ckey: INV.normName(S), dest: 'Shyam Metalics', customer: S }] });
  // tagged by mistake to the 07/10 trip (5 days after the bill)
  const r = INV.reconcile([oct2, oct7, other], [b3576], [tagOf(b3576, oct7)], c, { from: '2026-10-01', to: '2026-10-31' });
  const list = INV.tripsFor(b3576, r.rows, c);
  assert.equal(list[0].trip.id, oct2.id, 'the 02/10 trip of the same tanker comes first');
  assert.ok(list[0].fits && list[0].v === 'match' && list[0].c === 'linked');
  assert.ok(!list.some((x) => x.trip.id === oct7.id), 'not the trip it is on');
  assert.ok(!list.some((x) => x.trip.id === other.id), "not another tanker's trip");
  // a bill on no trip: same list, and a full trip is listed after the ones with room
  const r2 = INV.reconcile([oct2, oct7], [b3576, bill(3577, '2026-10-02', 17950, S, D)], [tagOf(bill(3577, '2026-10-02', 17950, S, D), oct2)], c,
    { from: '2026-10-01', to: '2026-10-31' });
  const l2 = INV.tripsFor(b3576, r2.rows, c);
  assert.deepEqual(l2.map((x) => [x.trip.id, x.fits]), [[oct7.id, true], [oct2.id, false]]);
  assert.ok(l2[0].far, '5 days away: listed as a fallback of the same tanker');
});

test('a bill dated days away from its trip is flagged — it is probably on the wrong trip', () => {
  const D = 'OR15R9360', S = 'Shyam Metalics and Energy Ltd';
  const oct7 = trip(D, '2026-10-07', 17932, 'Shyam Metalics');
  const b = bill(3576, '2026-10-02', 18000, S, D);
  const r = INV.reconcile([oct7], [b], [tagOf(b, oct7)], ctx({ plates: [A, B, C, D] }), { from: '2026-10-01', to: '2026-10-31' });
  assert.equal(r.rows[0].status, 'ok', 'the litres add up…');
  assert.deepEqual(r.rows[0].issues.map((i) => i.kind), ['date'], '…but the date does not');
  assert.match(r.rows[0].issues[0].text, /02\/10\/2026 — 5 days before this trip/);
  assert.equal(r.alerts[0].kind, 'date');
  // the day after (or 3 days after) is normal
  const ok = bill(3577, '2026-10-10', 17950, S, D);
  assert.equal(INV.reconcile([oct7], [ok], [tagOf(ok, oct7)], ctx({ plates: [A, B, C, D] }), { from: '2026-10-01', to: '2026-10-31' }).rows[0].issues.length, 0);
});

test('a trip marked as checked by hand is no longer flagged, anywhere', () => {
  const links = [{ ckey: 'shyam metalics and energy ltd', dest: 'Shyam Metalics', customer: 'Shyam Metalics and Energy Ltd' }];
  const t1 = trip('OR15R9360', '2026-10-07', 17932, 'Shyam Metalics'), t2 = trip(A, '2026-10-07', 11955, 'Shyam Metalics', { h: 1 });
  const b = bill(3800, '2026-10-07', 17990, 'Shyam Metalics and Energy Ltd', 'OR15R9360');
  const base = { plates: [A, B, C, 'OR15R9360'], links };
  const before = INV.reconcile([t1, t2], [b], [], ctx(base), { from: '2026-10-01', to: '2026-10-31' });
  assert.equal(before.alerts.filter((a) => a.kind === 'none').length, 2);
  const c = ctx({ ...base, checked: [{ trip_id: t2.id, note: 'Settled outside the ledger', by: 'boss' }] });
  const r = INV.reconcile([t1, t2], [b], [], c, { from: '2026-10-01', to: '2026-10-31' });
  const row = Object.fromEntries(r.rows.map((x) => [x.trip.id, x]));
  assert.equal(row[t2.id].status, 'checked');
  assert.equal(row[t2.id].checked.note, 'Settled outside the ledger');
  assert.equal(row[t2.id].sug, null, 'no suggestion for it');
  assert.deepEqual(r.alerts.filter((a) => a.row).map((a) => a.row.trip.id), [t1.id], 'only the other trip is still to fix');
  assert.equal(r.perTanker[A].checked, 1);
  assert.equal(r.perTanker[A].bad, 0);
  assert.equal(r.perTanker[A].diff, 0, 'not counted as short');
  const acc = r.perCust.find((a) => a.dests.includes('Shyam Metalics'));
  assert.deepEqual([acc.delivered, acc.handL], [29887, 11955], 'sent is every trip; the checked one is settled by hand');
  assert.equal(acc.diff, -17932, 'only the unchecked trip is short');
  // a trip whose bills already add up stays "ok" even if marked
  const ok = INV.reconcile([t1], [b], [tagOf(b, t1)], ctx({ ...base, checked: [{ trip_id: t1.id, note: 'x' }] }), { from: '2026-10-01', to: '2026-10-31' });
  assert.equal(ok.rows[0].status, 'ok');
});

test('short supply (billed up to 80 L more than sent) is kept apart from over-invoicing', () => {
  const S = 'Shyam Metalics and Energy Ltd';
  const links = [{ ckey: INV.normName(S), dest: 'Shyam Metalics', customer: S }];
  const ts = [trip(A, '2026-10-02', 11950, 'Shyam Metalics'), trip(B, '2026-10-03', 11940, 'Shyam Metalics'), trip(C, '2026-10-04', 11930, 'Shyam Metalics')];
  const bs = [bill(1701, '2026-10-02', 12000, S, A), bill(1702, '2026-10-03', 12000, S, B), bill(1703, '2026-10-04', 12000, S, C)];
  const tags = bs.map((b, i) => tagOf(b, ts[i]));
  const c = ctx({ links });
  const r = INV.reconcile(ts, bs, tags, c, { from: '2026-10-01', to: '2026-10-31' });
  assert.deepEqual(r.rows.map((x) => [x.status, x.short]), [['ok', 50], ['ok', 60], ['ok', 70]]);
  const a = r.perCust[0];
  assert.deepEqual([a.short, a.diff, a.status], [180, 0, 'ok'], 'all of it is short supply — nothing over-invoiced');
  assert.equal(r.perTanker[A].short, 50);
  assert.equal(r.perTanker[A].diff, 0);
  assert.equal(r.alerts.length, 0);

  // + a 12,000 L bill on no trip that a 4th (untagged) trip can take: "to tag", not over-invoiced
  const t4 = trip(A, '2026-10-05', 11960, 'Shyam Metalics'), b4 = bill(1704, '2026-10-05', 12000, S, A);
  const r2 = INV.reconcile(ts.concat([t4]), bs.concat([b4]), tags, c, { from: '2026-10-01', to: '2026-10-31' });
  const a2 = r2.perCust[0];
  assert.equal(a2.status, 'totag');
  assert.deepEqual([a2.toTag, a2.extraHard, a2.short], [12000, 0, 180]);

  // the same bill when no trip of that tanker can take it: over-invoiced
  const r3 = INV.reconcile(ts, bs.concat([b4]), tags, c, { from: '2026-10-01', to: '2026-10-31' });
  assert.equal(r3.perCust[0].status, 'over');
  assert.equal(r3.perCust[0].diff, 12000);

  // a trip billed more than 80 L over is over-invoiced — short supply covers only the buffer
  const big = bill(1705, '2026-10-02', 12100, S, A);
  const r4 = INV.reconcile([ts[0]], [big], [tagOf(big, ts[0])], c, { from: '2026-10-01', to: '2026-10-31' });
  assert.deepEqual([r4.rows[0].status, r4.rows[0].short, r4.perCust[0].status, r4.perCust[0].diff], ['over', 0, 'over', 150]);
});

test('a bill on no trip that only a trip checked by hand could take is covered by it — not "to tag"', () => {
  const S = 'Shyam Metalics and Energy Ltd';
  const links = [{ ckey: INV.normName(S), dest: 'Shyam Metalics', customer: S }];
  const t1 = trip(A, '2026-10-07', 11955, 'Shyam Metalics'), t2 = trip(B, '2026-10-08', 11940, 'Shyam Metalics');
  const b1 = bill(1801, '2026-10-07', 12000, S, A), b2 = bill(1802, '2026-10-08', 12000, S, B);
  const c = ctx({ links, checked: [{ trip_id: t1.id, note: 'manually done' }] });
  const r = INV.reconcile([t1, t2], [b1, b2], [tagOf(b2, t2)], c, { from: '2026-10-01', to: '2026-10-31' });
  assert.deepEqual(r.loose.map((x) => [x.bill.bill_no, x.kind]), [['1801', 'covered']]);
  assert.equal(r.alerts.length, 0, 'no alert for it');
  const a = r.perCust[0];
  assert.deepEqual([a.status, a.toTag, a.coveredL, a.handL, a.short, a.diff], ['ok', 0, 12000, 11955, 60, 0]);
  // a bill with no vehicle to the customer, only a checked trip has room: covered too
  const nb = bill(1803, '2026-10-07', 12000, S, '');
  const r2 = INV.reconcile([t1, t2], [nb, b2], [tagOf(b2, t2)], c, { from: '2026-10-01', to: '2026-10-31' });
  assert.deepEqual(r2.loose.map((x) => x.kind), ['covered']);
  // once the trip is no longer checked, the bill is to tag again
  const r3 = INV.reconcile([t1, t2], [b1, b2], [tagOf(b2, t2)], ctx({ links }), { from: '2026-10-01', to: '2026-10-31' });
  assert.deepEqual(r3.loose.map((x) => x.kind), ['untagged']);
});

test('a trip of another customer cannot take a bill: the checked trip of its own customer covers it', () => {
  const S = 'Shyam Metalics and Energy Ltd', O = 'Orissa Metaliks Pvt Ltd';
  const links = [{ ckey: INV.normName(S), dest: 'Shyam Metalics', customer: S }, { ckey: INV.normName(O), dest: 'Orissa Metaliks', customer: O }];
  const mine = trip(A, '2026-10-07', 11955, 'Shyam Metalics'), theirs = trip(A, '2026-10-08', 11955, 'Orissa Metaliks');
  const b = bill(1901, '2026-10-07', 12000, S, A);
  const c = ctx({ links, checked: [{ trip_id: mine.id, note: 'manually done' }] });
  const r = INV.reconcile([mine, theirs], [b], [], c, { from: '2026-10-01', to: '2026-10-31' });
  assert.deepEqual(r.loose.map((x) => x.kind), ['covered'], "the Orissa trip of the same tanker doesn't count");
  assert.equal(r.perCust.find((a) => a.dests.includes('Shyam Metalics')).status, 'ok');
  // the "to tag" list names the trip it would go on
  const r2 = INV.reconcile([mine, theirs], [b], [], ctx({ links }), { from: '2026-10-01', to: '2026-10-31' });
  assert.deepEqual(r2.loose[0].trips.map((t) => t.id), [mine.id]);
});

test('a bill raised before its tanker is sent waits for the trip; a bill marked as checked by hand is settled', () => {
  const P = 'M/s Smc Power Generation Ltd.', S = 'Shyam Metalics and Energy Ltd';
  const links = [{ ckey: INV.normName(P), dest: 'SMC Unit 1', customer: P }, { ckey: INV.normName(S), dest: 'Shyam Metalics', customer: S }];
  const b1 = bill(3813, '2026-10-09', 2000, P, 'OR15R5510'), b2 = bill(3814, '2026-10-09', 10000, P, 'OR15R5510');
  const old = bill(3538, '2026-10-01', 12000, S, A);
  const base = { plates: [A, B, 'OR15R5510'], links, until: '2026-10-09' };
  // today 10/10: no trip yet — billed before loading, not an extra sale
  const r = INV.reconcile([], [b1, b2, old], [], ctx({ ...base, today: '2026-10-10' }), { from: '2026-10-01', to: '2026-10-31' });
  assert.deepEqual(r.loose.map((x) => [x.bill.bill_no, x.kind]), [['3538', 'extra'], ['3813', 'pending'], ['3814', 'pending']]);
  assert.deepEqual(r.alerts.map((a) => [a.lvl, a.kind]), [['high', 'extra'], ['watch', 'pending'], ['watch', 'pending']]);
  assert.equal(r.perCust.find((a) => a.custs.includes(P) || a.dests.includes('SMC Unit 1')).status, 'pending');
  // a day later, still no trip: now it is an extra sale
  const r2 = INV.reconcile([], [b1, b2], [], ctx({ ...base, today: '2026-10-11' }), { from: '2026-10-01', to: '2026-10-31' });
  assert.deepEqual(r2.loose.map((x) => x.kind), ['extra', 'extra']);
  // the tanker is sent today: the two bills are suggested for it (12,000 on 11,946 = 54 L short supply)
  const t = trip('OR15R5510', '2026-10-10', 11946, 'SMC Unit 1');
  const r3 = INV.reconcile([t], [b1, b2], [], ctx({ ...base, today: '2026-10-10' }), { from: '2026-10-01', to: '2026-10-31' });
  assert.deepEqual(keys(r3.rows[0].sug.bills), ['3813', '3814']);
  // #3538 marked as checked by hand: settled, no alert, the customer is not over-invoiced
  const r4 = INV.reconcile([], [old], [], ctx({ ...base, today: '2026-10-10', billChecked: [{ bill_key: old.key, note: 'Settled manually' }] }),
    { from: '2026-10-01', to: '2026-10-31' });
  assert.deepEqual(r4.loose.map((x) => x.kind), ['settled']);
  assert.equal(r4.alerts.length, 0);
  const a = r4.perCust.find((x) => x.custs.includes(S) || x.dests.includes('Shyam Metalics'));
  assert.deepEqual([a.status, a.settledL, a.diff], ['ok', 12000, 0]);
});

test('SMC: the Unit on the ledger bill says which Sold-to unit it is for', () => {
  const P = 'M/s Smc Power Generation Ltd.';
  const links = [{ ckey: INV.normName(P), dest: 'SMC Unit 1', customer: P }, { ckey: INV.normName(P), dest: 'SMC Unit 2', customer: P }];
  const c = ctx({ links, plates: [A, B, 'OR15R5510'] });
  const u1 = { ...bill(3813, '2026-10-09', 2000, P, 'OR15R5510'), unit: 'UNIT 1' }, u2 = { ...bill(3814, '2026-10-09', 10000, P, 'OR15R5510'), unit: 'UNIT 2' };
  const none = bill(3815, '2026-10-09', 12000, P, 'OR15R5510');
  assert.equal(INV.unitNo('UNIT 1'), '1'); assert.equal(INV.unitNo('SMC Unit-2'), '2'); assert.equal(INV.unitNo('Shyam Metalics'), '');
  assert.deepEqual(INV.billDests(u1, c), ['SMC Unit 1']);
  assert.deepEqual(INV.billDests(u2, c), ['SMC Unit 2']);
  assert.deepEqual(INV.billDests(none, c).sort(), ['SMC Unit 1', 'SMC Unit 2'], 'no unit on the bill yet: either');
  // a tanker can be split between the units: both bills still go on the one trip
  const t1 = trip('OR15R5510', '2026-10-10', 11946, 'SMC Unit 1');
  assert.equal(INV.custFit(t1, u2, c), 'linked');
  assert.deepEqual(keys(INV.suggest([t1], [u1, u2], [], c)[t1.id].bills), ['3813', '3814']);
});
