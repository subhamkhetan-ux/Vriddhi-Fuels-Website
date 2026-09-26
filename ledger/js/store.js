// Where the app's data lives. Both stores answer the same calls:
//   supabaseStore(client) — the real one: calls the ledger_* functions in
//                           supabase/ledger-schema.sql
//   memoryStore(seed)     — the demo: made-up data kept in this browser tab,
//                           nothing is saved. It follows the same rules as
//                           the SQL functions (tests/ledger_web/store.test.mjs).

import { fyOf, normKey } from './util.js';
import { billOrder, poKey } from './po.js';

export function supabaseStore(client) {
  const rpc = async (fn, args = {}) => {
    const { data, error } = await client.rpc(fn, args);
    if (error) throw new Error(error.message || String(error));
    return data;
  };
  return {
    kind: 'supabase',
    whoami: () => rpc('ledger_whoami'),
    summary: () => rpc('ledger_summary'),
    existingBills: (keys) => rpc('ledger_existing_bills', { p_keys: keys }),
    importDaybook: (fileName, rows) => rpc('ledger_import_daybook', { p_file_name: fileName, p_rows: rows }),
    importMaster: (fileName, payload) => rpc('ledger_import_master', { p_file_name: fileName, p_payload: payload }),
    customers: () => rpc('ledger_customers_list'),
    updateCustomer: (id, patch) => rpc('ledger_customer_update', { p_id: id, p_patch: patch }),
    poData: (code = null) => rpc('ledger_po_data', { p_code: code }),
    savePo: (po) => rpc('ledger_po_save', { p_po: po }),
    deletePo: (id) => rpc('ledger_po_delete', { p_id: id }),
    movePo: (id, dir) => rpc('ledger_po_move', { p_id: id, p_dir: dir }),
    updateBill: (id, patch) => rpc('ledger_bill_update', { p_id: id, p_patch: patch }),
    salesDay: (date = null) => rpc('ledger_sales_day', { p_date: date }),
    imports: (limit = 20) => rpc('ledger_imports_list', { p_limit: limit }),
    salesRange: (from, to) => rpc('ledger_sales_range', { p_from: from, p_to: to }),
    tankerList: () => rpc('ledger_tanker_list'),
    setting: (key) => rpc('ledger_setting_get', { p_key: key }),
    setSetting: (key, value) => rpc('ledger_setting_set', { p_key: key, p_value: value }),
    statementData: (from, to) => rpc('ledger_statement_data', { p_from: from, p_to: to }),
    saveOpening: (month) => rpc('ledger_opening_save', { p_month: month }),
  };
}

// ---------------------------------------------------------------------------
const clone = (x) => JSON.parse(JSON.stringify(x));
const trim = (s) => String(s ?? '').replace(/[\t\n\v\f\r  ]+/g, ' ').trim();
const now = () => new Date().toISOString();

export function memoryStore(seed = {}, { email = 'demo@example.com' } = {}) {
  const db = {
    customers: [], groups: [], sales: [], payments: [], pos: [], opening: [], imports: [], tanker: [], settings: {},
  };
  const ids = { customers: 0, sales: 0, payments: 0, pos: 0, imports: 0 };
  const nextId = (t) => { ids[t] += 1; return ids[t]; };

  const customerByKey = (k) => db.customers.find((c) => c.customer_key === k);
  const addCustomer = (name, fields = {}) => {
    const n = trim(name);
    const k = normKey(n);
    if (!k) return null;
    let c = customerByKey(k);
    if (c) return { c, inserted: false };
    c = {
      id: nextId('customers'), name: n, customer_key: k, ledger: null, no_ledger: false, bulk_group: null,
      gstin: '', archived: false, created_at: now(), ...fields,
    };
    db.customers.push(c);
    return { c, inserted: true };
  };
  const saleKey = (s) => `${s.product}|${s.fy}|${s.bill_no}`;
  const logImport = (kind, fileName) => {
    const row = { id: nextId('imports'), kind, file_name: fileName || '', counts: {}, by_email: email, created_at: now() };
    db.imports.push(row);
    return row;
  };
  const fail = (msg) => { throw new Error(msg); };

  // same rule as ledger_balance_before() in SQL
  const balanceBefore = (key, date, skipMonth = false) => {
    const monthStart = `${date.slice(0, 7)}-01`;
    const base = db.opening.filter((o) => o.customer_key === key && (skipMonth ? o.month < monthStart : o.month <= date))
      .sort((a, b) => b.month.localeCompare(a.month))[0];
    const from = base ? base.month : '1900-01-01';
    const sum = (list, field, dateField) => list.filter((x) => x.customer_key === key && x[dateField] >= from && x[dateField] < date)
      .reduce((a, x) => a + (Number(x[field]) || 0), 0);
    return Math.round(((base ? Number(base.amount) : 0) + sum(db.sales, 'amount', 'sale_date') - sum(db.payments, 'amount', 'pay_date')) * 100) / 100;
  };

  const api = {
    kind: 'memory',
    async whoami() {
      return { user_id: 'demo', email, member: true };
    },

    async summary() {
      const sales = {};
      for (const s of db.sales) {
        const x = sales[s.product] || (sales[s.product] = { bills: 0, last: null });
        x.bills += 1;
        if (!x.last || s.sale_date > x.last) x.last = s.sale_date;
      }
      const last = (kind) => clone([...db.imports].reverse().find((i) => !kind || i.kind === kind) || null);
      return {
        sales,
        last_sale_date: db.sales.reduce((m, s) => (!m || s.sale_date > m ? s.sale_date : m), null),
        payments: db.payments.length,
        customers: db.customers.filter((c) => !c.archived).length,
        needs_ledger: db.customers.filter((c) => !c.archived && !c.ledger && !c.bulk_group && !c.no_ledger).length,
        groups: db.groups.length,
        pos: db.pos.length,
        last_import: last(null),
        last_master_import: last('master_ledger'),
      };
    },

    async existingBills(keys) {
      const have = new Set(db.sales.map(saleKey));
      const out = new Set();
      for (const k of keys || []) {
        const key = `${k.product}|${fyOf(k.sale_date)}|${trim(k.bill_no)}`;
        if (have.has(key)) out.add(key);
      }
      return [...out];
    },

    async importDaybook(fileName, rows) {
      const imp = logImport('daybook', fileName);
      const valid = (rows || []).filter((r) => ['HSD', 'MS', 'XG'].includes(r.product) && r.sale_date
        && trim(r.bill_no) && trim(r.customer));
      const newCustomers = [];
      for (const r of valid) {
        const res = addCustomer(r.customer);
        if (res && res.inserted) newCustomers.push(res.c.name);
      }
      const have = new Set(db.sales.map(saleKey));
      const base = {};
      for (const s of db.sales) base[s.product] = Math.max(base[s.product] || 0, s.seq);
      const position = new Map((rows || []).map((r, i) => [r, i + 1]));   // 1-based place in the file
      const inserted = {};
      for (const r of valid) {
        const key = `${r.product}|${fyOf(r.sale_date)}|${trim(r.bill_no)}`;
        if (have.has(key)) continue;
        have.add(key);
        db.sales.push({
          id: nextId('sales'), product: r.product, fy: fyOf(r.sale_date), bill_no: trim(r.bill_no),
          sale_date: r.sale_date, vehicle: trim(r.vehicle), qty: r.qty ?? null, rate: r.rate ?? null,
          amount: r.amount ?? null, customer: trim(r.customer), customer_key: normKey(r.customer), item: '',
          seq: (base[r.product] || 0) + position.get(r), unit: '', po_mode: 'auto', po_fixed: '',
          po_user_set: false, tds: null, shortage: null, remarks: '', source: 'daybook', import_id: imp.id,
        });
        inserted[r.product] = (inserted[r.product] || 0) + 1;
      }
      const total = Object.values(inserted).reduce((a, b) => a + b, 0);
      imp.counts = { rows: valid.length, inserted, duplicates: valid.length - total, new_customers: newCustomers.sort() };
      return { ...clone(imp.counts), import_id: imp.id };
    },

    async importMaster(fileName, p) {
      const imp = logImport('master_ledger', fileName);
      // 1) bulk ledgers follow Excel
      const seenGroups = new Set();
      let groups = 0;
      for (const g of p.groups || []) {
        const code = trim(g.code);
        if (!code || seenGroups.has(code) || !['po', 'po_units', 'group'].includes(g.kind)) continue;
        seenGroups.add(code);
        const row = {
          code, title: g.title || '', kind: g.kind, units: g.units || [], period_from: g.period_from || null,
          opening: g.opening ?? null, opening_by_unit: g.opening_by_unit || {},
        };
        const i = db.groups.findIndex((x) => x.code === code);
        if (i >= 0) db.groups[i] = row; else db.groups.push(row);
        groups += 1;
      }
      // 2) customers: named ones + everyone on the HSD / MS / XG sheets; new
      //    ones added, known ones only get blanks filled
      const named = new Map();
      const note = (name, f, pri) => {
        const k = normKey(name);
        if (!k) return;
        const cur = named.get(k) || { name: trim(name), pri };
        if (pri < cur.pri) { cur.name = trim(name); cur.pri = pri; }
        for (const field of ['ledger', 'gstin', 'bulk_group', 'title', 'bill_address']) {
          const v = trim(f[field]);
          if (v && (!cur[field] || v > cur[field])) cur[field] = v;
        }
        named.set(k, cur);
      };
      (p.customers || []).forEach((c) => note(c.name, c, 0));
      (p.sales || []).filter((s) => ['HSD', 'MS', 'XG'].includes(s.product)).forEach((s) => note(s.customer, {}, 1));
      let customersNew = 0;
      for (const [, c] of named) {
        const res = addCustomer(c.name, {
          ledger: c.ledger || null, gstin: c.gstin || '', bulk_group: c.bulk_group || null,
          title: c.title || '', bill_address: c.bill_address || '',
        });
        if (res.inserted) { customersNew += 1; continue; }
        const cur = res.c;
        if (c.title) cur.title = c.title;
        if (c.bill_address) cur.bill_address = c.bill_address;
        if (!cur.ledger && c.ledger) cur.ledger = c.ledger;
        if (!cur.gstin && c.gstin) cur.gstin = c.gstin;
        if (!cur.bulk_group && c.bulk_group) cur.bulk_group = c.bulk_group;
      }
      // 3) sales: Excel's figures win; Unit / PO only fill blanks
      const firstOf = new Map();
      for (const s of p.sales || []) {
        if (!s.sale_date || !trim(s.bill_no) || !trim(s.customer) || !['HSD', 'MS', 'XG', 'OTHER'].includes(s.product)) continue;
        const k = `${s.product}|${fyOf(s.sale_date)}|${trim(s.bill_no)}`;
        const cur = firstOf.get(k);
        if (!cur || (s.seq || 0) < (cur.seq || 0)) firstOf.set(k, s);
      }
      let salesNew = 0;
      let salesUpd = 0;
      for (const [k, s] of firstOf) {
        const cur = db.sales.find((x) => saleKey(x) === k);
        const figures = {
          sale_date: s.sale_date, vehicle: trim(s.vehicle), qty: s.qty ?? null, rate: s.rate ?? null,
          amount: s.amount ?? null, customer: trim(s.customer), customer_key: normKey(s.customer),
          item: s.item || '', seq: s.seq || 0,
        };
        const mode = s.po_mode === 'fixed' ? 'fixed' : 'auto';
        if (!cur) {
          db.sales.push({
            id: nextId('sales'), product: s.product, fy: fyOf(s.sale_date), bill_no: trim(s.bill_no), ...figures,
            unit: poKey(s.unit), po_mode: mode, po_fixed: trim(s.po_fixed), po_user_set: false,
            tds: s.tds ?? null, shortage: s.shortage ?? null, remarks: s.remarks || '', source: 'master_ledger',
            import_id: imp.id,
          });
          salesNew += 1;
        } else {
          Object.assign(cur, figures);
          if (!cur.unit) cur.unit = poKey(s.unit);
          if (!cur.po_user_set && cur.po_mode !== 'fixed') { cur.po_mode = mode; cur.po_fixed = trim(s.po_fixed); }
          if (s.tds != null) cur.tds = s.tds;
          if (s.shortage != null) cur.shortage = s.shortage;
          if (s.remarks) cur.remarks = s.remarks;
          salesUpd += 1;
        }
      }
      // 4) payments from Master Paid are replaced
      db.payments = db.payments.filter((x) => x.source !== 'master_ledger');
      let pays = 0;
      for (const x of p.payments || []) {
        if (!x.pay_date || x.amount == null || !trim(x.customer)) continue;
        db.payments.push({
          id: nextId('payments'), pay_date: x.pay_date, customer: trim(x.customer), customer_key: normKey(x.customer),
          amount: x.amount, mode: trim(x.mode), source: 'master_ledger', seq: x.seq || 0, tds: x.tds ?? null,
          shortage: x.shortage ?? null, remarks: x.remarks || '', import_id: imp.id,
        });
        pays += 1;
      }
      // 5) PO lists: only POs the app doesn't have, at the end of their list
      const fresh = new Map();
      for (const x of p.pos || []) {
        const po = trim(x.po_no);
        if (!po || !db.groups.some((g) => g.code === x.group_code)) continue;
        const unit = poKey(x.unit);
        const k = `${x.group_code}|${unit}|${poKey(po)}`;
        if (db.pos.some((q) => `${q.group_code}|${q.unit}|${poKey(q.po_no)}` === k)) continue;
        const cur = fresh.get(k);
        if (!cur || (x.seq || 0) < cur.seq) fresh.set(k, { group_code: x.group_code, unit, po_no: po, allotted: x.allotted || 0, seq: x.seq || 0 });
      }
      const byList = new Map();
      for (const x of fresh.values()) {
        const lk = `${x.group_code}|${x.unit}`;
        if (!byList.has(lk)) byList.set(lk, []);
        byList.get(lk).push(x);
      }
      let posNew = 0;
      for (const list of byList.values()) {
        list.sort((a, b) => a.seq - b.seq);
        const max = Math.max(0, ...db.pos.filter((q) => q.group_code === list[0].group_code && q.unit === list[0].unit).map((q) => q.seq));
        list.forEach((x, i) => {
          db.pos.push({ id: nextId('pos'), ...x, seq: max + i + 1, note: '', source: 'master_ledger', created_at: now() });
          posNew += 1;
        });
      }
      // 6) opening balances follow Excel
      let opening = 0;
      const seenOpen = new Set();
      for (const o of p.opening || []) {
        const k = normKey(o.customer);
        if (!k || !o.month || o.amount == null || seenOpen.has(`${k}|${o.month}`)) continue;
        seenOpen.add(`${k}|${o.month}`);
        const i = db.opening.findIndex((x) => x.customer_key === k && x.month === o.month);
        const row = { customer_key: k, month: o.month, customer: trim(o.customer), amount: o.amount, source: 'master_ledger' };
        if (i >= 0) db.opening[i] = row; else db.opening.push(row);
        opening += 1;
      }
      // 7) Tanker Master follows Excel; 8) settings
      let tanker = 0;
      if ((p.tanker || []).length) {
        const seen = new Set();
        db.tanker = [];
        p.tanker.forEach((t, i) => {
          const company = trim(t.company);
          if (!company || seen.has(company)) return;
          seen.add(company);
          db.tanker.push({
            company, hsd_rate: t.hsd_rate ?? null, address: t.address || [], payment: t.payment || [],
            po_label: t.po_label || '', po_no: t.po_no || '', price_tier: t.price_tier || '', seq: i + 1,
          });
        });
        tanker = db.tanker.length;
      }
      Object.assign(db.settings, clone(p.settings || {}));
      imp.counts = {
        groups, customers_new: customersNew, sales_new: salesNew, sales_updated: salesUpd, payments: pays,
        pos_new: posNew, opening, tanker,
      };
      return { ...clone(imp.counts), import_id: imp.id };
    },

    async customers() {
      return clone(db.customers.map((c) => {
        const mine = db.sales.filter((s) => s.customer_key === c.customer_key).map((s) => s.sale_date).sort();
        return {
          id: c.id, name: c.name, key: c.customer_key, ledger: c.ledger, no_ledger: c.no_ledger,
          bulk_group: c.bulk_group, gstin: c.gstin, archived: c.archived, created_at: c.created_at,
          title: c.title || '', bill_address: c.bill_address || '',
          first_sale: mine[0] || null, last_sale: mine[mine.length - 1] || null, bills: mine.length,
        };
      }).sort((a, b) => a.name.localeCompare(b.name)));
    },

    async updateCustomer(id, patch) {
      const c = db.customers.find((x) => x.id === id) || fail('Customer not found.');
      if ('ledger' in patch) {
        const v = trim(patch.ledger) || null;
        const other = v && db.customers.find((x) => x.id !== id && x.ledger && x.ledger.toLowerCase() === v.toLowerCase());
        if (other) fail(`The ledger name "${v}" is already used by ${other.name}.`);
        c.ledger = v;
      }
      if ('no_ledger' in patch) c.no_ledger = Boolean(patch.no_ledger);
      if ('archived' in patch) c.archived = Boolean(patch.archived);
      if ('gstin' in patch) c.gstin = trim(patch.gstin);
      return clone(c);
    },

    async poData(code = null) {
      const groups = db.groups.filter((g) => !code || g.code === code).sort((a, b) => a.code.localeCompare(b.code));
      const members = db.customers.filter((c) => c.bulk_group && (!code || c.bulk_group === code))
        .map((c) => ({ id: c.id, name: c.name, key: c.customer_key, group: c.bulk_group, archived: c.archived }))
        .sort((a, b) => a.name.localeCompare(b.name));
      const pos = db.pos.filter((q) => !code || q.group_code === code)
        .sort((a, b) => a.group_code.localeCompare(b.group_code) || a.unit.localeCompare(b.unit) || a.seq - b.seq || a.id - b.id);
      const bills = [];
      for (const s of db.sales) {
        if (!['HSD', 'MS', 'XG'].includes(s.product)) continue;
        const c = customerByKey(s.customer_key);
        const g = c && c.bulk_group && db.groups.find((x) => x.code === c.bulk_group);
        if (!g || !['po', 'po_units'].includes(g.kind) || (code && g.code !== code)) continue;
        if (g.period_from && s.sale_date < g.period_from) continue;
        bills.push({
          id: s.id, group: g.code, product: s.product, date: s.sale_date, bill_no: s.bill_no, vehicle: s.vehicle, qty: s.qty,
          amount: s.amount, customer: s.customer, unit: s.unit, po_mode: s.po_mode, po_fixed: s.po_fixed,
          po_user_set: s.po_user_set, seq: s.seq,
        });
      }
      bills.sort((a, b) => a.group.localeCompare(b.group) || billOrder(a, b));
      return clone({ groups, members, pos, bills });
    },

    async savePo(po) {
      const no = trim(po.po_no);
      const allotted = po.allotted === '' || po.allotted == null ? 0 : Number(po.allotted);
      if (!no) fail('Enter the PO number.');
      if (!(allotted >= 0)) fail('Allotted litres can\'t be negative.');
      if (po.id) {
        const cur = db.pos.find((q) => q.id === po.id) || fail('PO not found.');
        if (db.pos.some((q) => q.id !== cur.id && q.group_code === cur.group_code && q.unit === cur.unit && poKey(q.po_no) === poKey(no))) {
          fail(`PO ${no} is already in this list.`);
        }
        Object.assign(cur, { po_no: no, allotted, note: po.note ?? cur.note });
        return clone(cur);
      }
      const group = trim(po.group_code);
      if (!db.groups.some((g) => g.code === group)) fail(`Unknown bulk ledger "${group}".`);
      const unit = poKey(po.unit);
      if (db.pos.some((q) => q.group_code === group && q.unit === unit && poKey(q.po_no) === poKey(no))) {
        fail(`PO ${no} is already in this list.`);
      }
      const max = Math.max(0, ...db.pos.filter((q) => q.group_code === group && q.unit === unit).map((q) => q.seq));
      const row = {
        id: nextId('pos'), group_code: group, unit, po_no: no, allotted, seq: max + 1, note: po.note || '',
        source: 'app', created_at: now(),
      };
      db.pos.push(row);
      return clone(row);
    },

    async deletePo(id) {
      const i = db.pos.findIndex((q) => q.id === id);
      if (i < 0) fail('PO not found.');
      db.pos.splice(i, 1);
    },

    async movePo(id, dir) {
      const a = db.pos.find((q) => q.id === id) || fail('PO not found.');
      const list = db.pos.filter((q) => q.group_code === a.group_code && q.unit === a.unit)
        .sort((x, y) => x.seq - y.seq || x.id - y.id);
      list.forEach((q, i) => { q.seq = i + 1; });
      const j = list.indexOf(a) + (dir < 0 ? -1 : 1);
      if (j < 0 || j >= list.length) return;
      const b = list[j];
      [a.seq, b.seq] = [b.seq, a.seq];
    },

    async updateBill(id, patch) {
      const s = db.sales.find((x) => x.id === id) || fail('Bill not found.');
      if ('po_mode' in patch && !['auto', 'fixed'].includes(patch.po_mode)) fail('The PO choice must be auto or fixed.');
      if ('unit' in patch) s.unit = poKey(patch.unit);
      if ('po_mode' in patch) s.po_mode = patch.po_mode;
      if ('po_fixed' in patch) s.po_fixed = trim(patch.po_fixed);
      else if (patch.po_mode === 'auto') s.po_fixed = '';
      if ('po_mode' in patch || 'po_fixed' in patch) s.po_user_set = true;
      if ('remarks' in patch) s.remarks = patch.remarks || '';
      return clone({ id: s.id, unit: s.unit, po_mode: s.po_mode, po_fixed: s.po_fixed, po_user_set: s.po_user_set, remarks: s.remarks });
    },

    async salesDay(date = null) {
      const dates = [...new Set(db.sales.map((s) => s.sale_date))].sort().reverse();
      const d = date || dates[0] || null;
      const order = { HSD: 0, MS: 1, OTHER: 2, XG: 3 };
      const bills = db.sales.filter((s) => s.sale_date === d)
        .sort((a, b) => order[a.product] - order[b.product] || a.seq - b.seq || a.id - b.id)
        .map((s) => ({
          id: s.id, product: s.product, bill_no: s.bill_no, vehicle: s.vehicle, qty: s.qty, rate: s.rate,
          amount: s.amount, customer: s.customer, item: s.item, source: s.source,
        }));
      return clone({ date: d, dates: dates.slice(0, 120), bills });
    },

    async salesRange(from, to) {
      if (!from || !to || to < from) fail('Pick a From date on or before the To date.');
      const order = { HSD: 0, MS: 1, OTHER: 2, XG: 3 };
      return clone(db.sales.filter((s) => s.sale_date >= from && s.sale_date <= to)
        .sort((a, b) => order[a.product] - order[b.product] || a.seq - b.seq || a.id - b.id)
        .map((s) => ({
          id: s.id, product: s.product, bill_no: s.bill_no, sale_date: s.sale_date, vehicle: s.vehicle, qty: s.qty,
          rate: s.rate, amount: s.amount, customer: s.customer, item: s.item, seq: s.seq, unit: s.unit,
        })));
    },

    async tankerList() {
      return clone(db.tanker);
    },

    async setting(key) {
      return clone(db.settings[key] ?? null);
    },

    async setSetting(key, value) {
      if (!['slip_stamp', 'statement_stamp'].includes(key)) fail(`Unknown setting ${key}.`);
      if (value == null) delete db.settings[key]; else db.settings[key] = clone(value);
    },

    async statementData(from, to) {
      if (!from || !to || to < from) fail('Pick a From date on or before the To date.');
      const ledgerCustomers = db.customers.filter((c) => c.ledger && !c.bulk_group && !c.archived)
        .sort((a, b) => a.name.localeCompare(b.name));
      const order = { HSD: 0, MS: 1, OTHER: 2, XG: 3 };
      return clone({
        customers: ledgerCustomers.map((c) => ({
          id: c.id, name: c.name, key: c.customer_key, ledger: c.ledger, title: c.title || '',
          bill_address: c.bill_address || '', gstin: c.gstin, opening: balanceBefore(c.customer_key, from),
        })),
        sales: db.sales.filter((x) => x.sale_date >= from && x.sale_date <= to)
          .sort((a, b) => order[a.product] - order[b.product] || a.seq - b.seq || a.id - b.id)
          .map((x) => ({
            id: x.id, product: x.product, bill_no: x.bill_no, sale_date: x.sale_date, vehicle: x.vehicle, qty: x.qty,
            rate: x.rate, amount: x.amount, customer: x.customer, key: x.customer_key, item: x.item, seq: x.seq,
          })),
        payments: db.payments.filter((x) => x.pay_date >= from && x.pay_date <= to)
          .sort((a, b) => a.pay_date.localeCompare(b.pay_date) || a.seq - b.seq || a.id - b.id)
          .map((x) => ({ pay_date: x.pay_date, key: x.customer_key, amount: x.amount })),
      });
    },

    async saveOpening(month) {
      const m = `${month.slice(0, 7)}-01`;
      let n = 0;
      for (const c of db.customers.filter((x) => x.ledger && !x.bulk_group && !x.archived)) {
        const amount = balanceBefore(c.customer_key, m, true);
        const i = db.opening.findIndex((o) => o.customer_key === c.customer_key && o.month === m);
        const row = { customer_key: c.customer_key, month: m, customer: c.name, amount, source: 'app' };
        if (i >= 0) db.opening[i] = row; else db.opening.push(row);
        n += 1;
      }
      return { month: m, customers: n };
    },

    async imports(limit = 20) {
      return clone([...db.imports].reverse().slice(0, Math.max(1, Math.min(limit || 20, 200))));
    },
  };

  if (seed.master) api.importMaster(seed.master.fileName || 'Demo Master Ledger.xlsm', seed.master.payload);
  for (const d of seed.daybooks || []) api.importDaybook(d.fileName, d.rows);
  for (const d of seed.edits || []) d(api, db);
  return api;
}
