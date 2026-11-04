// An IndianOil tax invoice added from its PDF — the payments app's fallback
// for when the invoice mail never reaches the HDFC mailbox.
//
// The PDF is read in the browser by the decant app's reader (same pdf.js
// parse), then turned into exactly the rows the mail agent would write, under
// the SAME keys, so a mail that turns up later is a no-op:
//   * pay_fuel_invoices  keyed by the SAP entry number (70xxxxxxxx) — the agent
//     inserts with ignore-duplicates (agent/credit.py), so it keeps this row;
//   * pay_consignment_notes  id = sha1(SAP entry number)[:16], the agent's
//     state_store.entry_id(sap_no) — pay_claim_consignment returns the existing
//     note for that id, so no second note and no serial spent;
//   * pay_fuel_prices  per-product after-VAT ₹/KL, newest invoice date wins.
// No DOM here, so it is testable in Node.

export { readInvoicePdf, parseInvoiceLines, linesFromItems } from '../decant/js/invoice.js';

// Mirror agent/config.py CONSIGNMENT: only our own TT gets a note, and only
// from the 047 anchor invoice onward (older ones were noted by hand).
export const OWN_TT = 'OD23U8210';
export const CN_MIN_INVOICE_NO = '7010221545';

// agent/state_store.entry_id(): sha1 hex of the key, first 16 chars.
export async function noteId(sapNo) {
  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(String(sapNo)));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

const dmyToIso = (s) => {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(s || '').trim());
  return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : '';
};
// Whole KL as the note prints it (agent: str(int(round(qty_kl)))).
const kl = (q) => (Number.isFinite(Number(q)) ? String(Math.round(Number(q))) : null);

// Parsed invoice (decant/js/invoice.js shape) -> everything to write.
// Returns { key, fuelRow, prices, note, noteSkip, missing }:
//   fuelRow   the Credit-tab row, or null when the date / total can't be read;
//   note      pay_claim_consignment args (minus p_id, which is async), or null;
//   noteSkip  why no note: 'other-tt' | 'before-anchor' | 'incomplete'.
export function planUpload(inv, { ownTT = OWN_TT, minInvoiceNo = CN_MIN_INVOICE_NO } = {}) {
  const key = inv.invoice_no || null;
  const lines = (inv.lines || []).filter((l) => kl(l.qty_kl) != null);
  const fuelRow = key && inv.invoice_date && inv.amount
    ? { invoice_no: key, invoice_date: inv.invoice_date, tt_no: inv.tt_no || null, amount: inv.amount, gmail_msg_id: null }
    : null;

  const asOf = dmyToIso(inv.invoice_date);
  const prices = [];
  for (const l of lines) {
    const q = Number(kl(l.qty_kl));
    if (key && asOf && l.value && q) prices.push({ col_key: l.column_key, price: Math.round((l.value / q) * 100) / 100, as_of: asOf, invoice_no: key });
  }

  const missing = [];
  if (!key) missing.push('invoice no.');
  if (!inv.invoice_date) missing.push('date');
  if (!inv.tt_no) missing.push('TT no.');
  if (!lines.length) missing.push('product / quantity');
  if (!inv.amount) missing.push('invoice total');

  let note = null;
  let noteSkip = null;
  if (String(inv.tt_no || '').toUpperCase() !== String(ownTT).toUpperCase()) noteSkip = 'other-tt';
  else if (minInvoiceNo && /^\d+$/.test(key || '') && Number(key) < Number(minInvoiceNo)) noteSkip = 'before-anchor';
  else if (missing.length) noteSkip = 'incomplete';
  else {
    const columns = {};
    for (const l of lines) columns[l.column_key] = String(Number(columns[l.column_key] || 0) + Number(kl(l.qty_kl)));
    const first = lines[0];
    note = {
      p_gmail_msg_id: null,
      p_invoice_no: key,
      p_invoice_date: inv.invoice_date,
      p_tt_no: inv.tt_no,
      p_product: first.product,
      p_column_key: first.column_key,
      p_qty: kl(first.qty_kl),
      p_value: inv.amount,
      p_columns: columns,
      p_origin: inv.origin || null,
    };
  }
  return { key, fuelRow, prices, note, noteSkip, missing };
}

// Which of the observed prices should be written, given the stored ones
// ({col_key: {as_of}}): only a strictly newer invoice date replaces a price,
// as agent/supabase_sync.upsert_fuel_prices does.
export function newerPrices(prices, stored = {}) {
  const best = {};
  for (const p of prices) if (!best[p.col_key] || p.as_of > best[p.col_key].as_of) best[p.col_key] = p;
  return Object.values(best)
    .filter((p) => !(stored[p.col_key]?.as_of && stored[p.col_key].as_of >= p.as_of))
    .map((p) => ({ col_key: p.col_key, price_per_kl: p.price, as_of: p.as_of, invoice_no: p.invoice_no }));
}
