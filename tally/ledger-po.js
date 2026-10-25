/* Open POs and the Tanker Master from the Ledger app, for the tanker bill.
 *
 * The Ledger keeps each PO customer's PO list (litres allotted, in order) and
 * its bills, and gives every diesel bill the FIRST PO with enough litres left
 * (ledger/js/po.js — the *_Bulk sheets' rule). This runs that same rule here,
 * over the Ledger's bills plus any of the customer's vouchers in this app the
 * Ledger has not imported yet, so the bill shows the PO the Ledger will show.
 *
 * The Tanker Master (the Master Ledger's "Tanker Master" sheet, uploaded to the
 * Ledger app) gives each tanker-bill customer's address, payment lines and
 * P.O. label / number.
 *
 * The Ledger has its own Supabase project and members list. With the
 * tally-ledger edge function set up (tally/README.md), its ledger login is
 * kept on the server and every signed-in Tally user reads the Ledger with
 * their Tally login alone: nothing to sign in to here. Without it, this app
 * signs in there with the same login when it can, or once through "Connect
 * the Ledger" on the bill screen.
 */
(function (global) {
  'use strict';
  const PRODUCT = {hsd: 'HSD', ms: 'MS', xg: 'XG'};
  const FRESH_MS = 120000;
  let client = null, clientPending = null, data = null, loadedAt = 0, loading = null, rule = null;
  let tallyToken = null, server = null;   // the Tally login's token; whether the server's ledger login answers (a promise)

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

  // The ledger login kept on the server (tally-ledger edge function), asked
  // with this device's Tally login.
  async function serverCall(fn, args) {
    const c = global.VRIDDHI_TALLY_CONFIG || {};
    const token = tallyToken ? await tallyToken() : '';
    if (!token || !/^https:\/\//.test(c.SUPABASE_URL || '')) throw Object.assign(new Error('No Tally login'), {noLogin: true});
    const r = await fetch(String(c.SUPABASE_URL).replace(/\/+$/, '') + '/functions/v1/tally-ledger', {
      method: 'POST',
      headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + token, apikey: c.SUPABASE_ANON_KEY},
      body: JSON.stringify({fn, args: args || {}}),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) throw Object.assign(new Error(j.error || 'Error ' + r.status), {code: j.code || ''});
    return j.data;
  }
  // -> true when it is set up (then no ledger sign-in is needed here). Not
  // signed in to Tally yet (the app is still starting): asked again next time.
  function viaServer() {
    if (!server) {
      server = serverCall('ledger_whoami').then(w => !!(w && w.member), e => {
        if (e && e.noLogin) server = null;
        return false;
      });
    }
    return server;
  }
  function useTallyLogin(fn) { tallyToken = fn; server = null; }
  // A ledger read: through the server's login if it answers, else this device's.
  function ledgerRpc(fn) {
    return viaServer().then(yes => yes
      ? serverCall(fn).then(d => ({data: d}), e => ({error: {code: e.code, message: e.message}}))
      : getClient().then(c => c.rpc(fn)));
  }

  async function signedIn() {
    if (!config()) return false;
    if (await viaServer()) return true;
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
    data = null; loadedAt = 0; server = null;
    if (global.VFBilling) global.VFBilling.forget();
    if (client) await client.auth.signOut();
  }
  const readError = res => new Error(res.error.code === '42501' ? 'This login is not on the Ledger members list.'
    : 'The Ledger could not be read: ' + (res.error.message || 'unknown error'));
  // ledger_po_data(): groups, members, POs and bills — cached for two minutes.
  function load(force) {
    if (!force && data && Date.now() - loadedAt < FRESH_MS) return Promise.resolve(data);
    if (!force && loading) return loading;
    loading = ledgerRpc('ledger_po_data').then(res => {
      if (res.error) throw readError(res);
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

  // The Ledger's bulk customers: everyone billed through a *_Bulk ledger (a bulk group).
  // -> {status: 'not-configured' | 'signed-out' | 'ok', find(party, altName) -> {name, group, title, kind} | null}
  async function bulk() {
    if (!config()) return {status: 'not-configured'};
    if (!await signedIn()) return {status: 'signed-out'};
    const d = await load(false);
    return {status: 'ok', find(party, altName) {
      const m = memberFor(d.members || [], party) || (altName ? memberFor(d.members || [], altName) : null);
      if (!m) return null;
      const g = (d.groups || []).find(x => x.code === m.group);
      return {name: m.name, group: m.group, title: (g && g.title) || m.group, kind: g ? g.kind : ''};
    }};
  }

  // ledger_tanker_list(): the Tanker Master rows of the last Master Ledger upload.
  // -> {status: 'not-configured' | 'signed-out' | 'ok', customers: [{company, address[3],
  //    payment[5], po_label, po_no}], updatedAt} (the bill's rate is always the voucher's)
  async function tankerMaster() {
    if (!config()) return {status: 'not-configured'};
    if (!await signedIn()) return {status: 'signed-out'};
    const res = await ledgerRpc('ledger_tanker_list');
    if (res.error) throw readError(res);
    const customers = (res.data || []).map(t => ({company: String(t.company || ''),
      address: [0, 1, 2].map(i => String((t.address || [])[i] || '')),
      payment: [0, 1, 2, 3, 4].map(i => String((t.payment || [])[i] || '')),
      po_label: t.po_label || '', po_no: t.po_no || ''})).filter(t => t.company);
    const updatedAt = (res.data || []).map(t => t.updated_at).filter(Boolean).sort().pop() || null;
    return {status: 'ok', customers, updatedAt};
  }

  global.VFLedgerPO = {configured: () => !!config(), signedIn, signIn, signOut, forVoucher, bulk, tankerMaster,
    refresh: () => load(true), useTallyLogin, shared: () => viaServer()};
})(window);
