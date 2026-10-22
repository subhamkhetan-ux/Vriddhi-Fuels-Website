/* Open POs from the Ledger app, for the tanker bill's P.O. No.
 *
 * The Ledger keeps each PO customer's PO list (litres allotted, in order) and
 * its bills, and gives every diesel bill the FIRST PO with enough litres left
 * (ledger/js/po.js — the *_Bulk sheets' rule). This runs that same rule here,
 * over the Ledger's bills plus any of the customer's vouchers in this app the
 * Ledger has not imported yet, so the bill shows the PO the Ledger will show.
 *
 * The Ledger has its own Supabase project and members list: this app signs in
 * there with the same login when it can, or once through "Connect the Ledger"
 * on the bill screen. Without it, the Tanker Billing sheet's P.O. No. is used.
 */
(function (global) {
  'use strict';
  const PRODUCT = {hsd: 'HSD', ms: 'MS', xg: 'XG'};
  const FRESH_MS = 120000;
  let client = null, clientPending = null, data = null, loadedAt = 0, loading = null, rule = null;

  function config() {
    const c = global.VRIDDHI_TALLY_CONFIG || {};
    return c.LEDGER_SUPABASE_URL && c.LEDGER_SUPABASE_ANON_KEY ? c : null;
  }
  function getClient() {
    if (client) return Promise.resolve(client);
    const c = config();
    if (!c) return Promise.reject(new Error('The Ledger connection is not configured.'));
    if (!clientPending) {
      const factory = global.__VF_TEST_LEDGER_FACTORY ? Promise.resolve(global.__VF_TEST_LEDGER_FACTORY)
        : import('https://esm.sh/@supabase/supabase-js@2').then(m => m.createClient);
      clientPending = factory.then(create => {
        // Its own stored session, separate from this app's Tally login.
        client = create(c.LEDGER_SUPABASE_URL, c.LEDGER_SUPABASE_ANON_KEY,
          {auth: {storageKey: 'vf-tally-ledger-auth', persistSession: true, autoRefreshToken: true}});
        return client;
      }).catch(e => { clientPending = null; throw e; });
    }
    return clientPending;
  }
  function allocationRule() {
    if (!rule) rule = import('../ledger/js/po.js').catch(e => { rule = null; throw e; });
    return rule;
  }

  async function signedIn() {
    if (!config()) return false;
    const c = await getClient();
    const res = await c.auth.getSession();
    return !!(res.data && res.data.session);
  }
  async function signIn(email, password) {
    const c = await getClient();
    const res = await c.auth.signInWithPassword({email, password});
    if (res.error) throw new Error('The Ledger did not accept this login.');
    try { await load(true); }
    catch (e) { await c.auth.signOut(); throw e; }
  }
  async function signOut() {
    data = null; loadedAt = 0;
    if (client) await client.auth.signOut();
  }
  // ledger_po_data(): groups, members, POs and bills — cached for two minutes.
  function load(force) {
    if (!force && data && Date.now() - loadedAt < FRESH_MS) return Promise.resolve(data);
    if (!force && loading) return loading;
    loading = getClient().then(c => c.rpc('ledger_po_data')).then(res => {
      if (res.error) {
        throw new Error(res.error.code === '42501' ? 'This login is not on the Ledger members list.'
          : 'The Ledger could not be read: ' + (res.error.message || 'unknown error'));
      }
      data = res.data; loadedAt = Date.now();
      return data;
    }).finally(() => { loading = null; });
    return loading;
  }

  const norm = s => (global.VFBilling ? global.VFBilling.normName(s) : String(s || '').trim().toLowerCase());
  function memberFor(members, name) {
    const target = norm(name);
    if (!target) return null;
    const live = members.filter(m => m.group && !m.archived);
    const exact = live.filter(m => norm(m.name) === target);
    if (exact.length) return exact[0];
    const near = live.filter(m => { const n = norm(m.name); return n && (n.startsWith(target) || target.startsWith(n)); });
    return near.length === 1 ? near[0] : null;
  }
  // "SMC Power Generation LTD, UNIT II" -> "UNIT 2", when the group has that unit list.
  const ROMAN = {i: 1, ii: 2, iii: 3, iv: 4, v: 5};
  function unitFromName(name, units) {
    const m = String(name || '').match(/\bunit\s*[-–:#.]?\s*(\d+|iv|v|i{1,3})\b/i);
    if (!m) return '';
    const n = /^\d+$/.test(m[1]) ? Number(m[1]) : ROMAN[m[1].toLowerCase()];
    const want = 'UNIT ' + n;
    return (units || []).find(u => String(u).trim().toUpperCase().replace(/\s+/g, ' ') === want) ? want : '';
  }
  const numPart = s => { const m = String(s || '').match(/(\d+)\s*$/); return m ? Number(m[1]) : 0; };
  const billKey = (product, no) => product + '|' + String(no || '').trim().toUpperCase();

  // o: {party, altName, seriesKey, number, dateISO, qty, vouchers: [{party, seriesKey, number, dateISO, qty}]}
  // -> {status: 'signed-out' | 'not-configured' | 'no-group' | 'ok', po, how, left, open: [{po_no, unit, balance}], group, unit}
  async function forVoucher(o) {
    if (!config()) return {status: 'not-configured'};
    if (!await signedIn()) return {status: 'signed-out'};
    const [d, po] = await Promise.all([load(false), allocationRule()]);
    const member = memberFor(d.members || [], o.party) || (o.altName ? memberFor(d.members || [], o.altName) : null);
    const group = member && (d.groups || []).find(g => g.code === member.group);
    if (!group || !['po', 'po_units'].includes(group.kind)) return {status: 'no-group'};
    const names = new Set((d.members || []).filter(m => m.group === group.code).map(m => norm(m.name)));
    if (o.party) names.add(norm(o.party));
    const ledgerBills = (d.bills || []).filter(b => b.group === group.code);
    const present = new Set(ledgerBills.map(b => billKey(b.product, b.bill_no)));
    const product = PRODUCT[o.seriesKey] || 'HSD';
    // Unit-wise PO lists: a voucher's unit comes from its customer name (UNIT II), else
    // from that customer's latest Ledger bill with a unit.
    const unitOf = names => {
      if (group.kind !== 'po_units') return '';
      for (const n of names) { const u = unitFromName(n, group.units); if (u) return u; }
      const keys = names.map(norm).filter(Boolean);
      const last = ledgerBills.filter(b => b.unit && keys.includes(norm(b.customer)))
        .sort((a, b) => String(b.date).localeCompare(String(a.date)))[0];
      return last ? po.poKey(last.unit) : '';
    };
    const targetKey = billKey(product, o.number);
    // This app's vouchers for the customer that the Ledger has not imported yet use
    // up PO litres too; they follow the Ledger's own bills of the same day.
    const extra = [];
    const seen = new Set(present);
    // The bill's own litres and date come first: they may differ from the saved voucher.
    [{party: o.party, seriesKey: o.seriesKey, number: o.number, dateISO: o.dateISO, qty: o.qty}].concat(o.vouchers || [])
      .forEach(v => {
        const p = PRODUCT[v.seriesKey];
        const key = billKey(p, v.number);
        const own = key === targetKey;
        if (!p || !v.number || seen.has(key) || (!own && !names.has(norm(v.party)))) return;
        seen.add(key);
        extra.push({product: p, date: v.dateISO, bill_no: String(v.number).trim(), qty: Number(v.qty) || 0,
          unit: unitOf(own ? [v.party, o.altName] : [v.party]), po_mode: 'auto', po_fixed: '', seq: 1e12 + numPart(v.number), id: 1e12 + extra.length});
      });
    const bills = ledgerBills.map(b => Object.assign({}, b, {date: b.sale_date || b.date})).concat(extra).sort(po.billOrder);
    const result = po.allocate({kind: group.kind, units: group.units || [], bills,
      pos: (d.pos || []).filter(p => p.group_code === group.code)});
    const at = bills.findIndex(b => billKey(b.product, b.bill_no) === targetKey);
    const mine = result.bills[at] || {po: '', how: 'no-po'};
    const unit = group.kind === 'po_units' ? po.poKey(bills[at] && bills[at].unit) : '';
    const open = [];
    result.registers.forEach(r => r.pos.forEach(p => { if (p.balance > 0) open.push({po_no: p.po_no, unit: r.unit, balance: p.balance}); }));
    const reg = result.registers.flatMap(r => r.pos.map(p => Object.assign({unit: r.unit}, p)))
      .find(p => po.poKey(p.po_no) === po.poKey(mine.po) && (!unit || p.unit === unit));
    return {status: 'ok', po: mine.po, how: mine.how, left: reg ? reg.balance : null, open,
      group: group.title || group.code, unit};
  }

  global.VFLedgerPO = {configured: () => !!config(), signedIn, signIn, signOut, forVoucher, refresh: () => load(true)};
})(window);
