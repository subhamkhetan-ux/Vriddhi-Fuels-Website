// The price letter: wording, rupees in words, a period's prices (made-up prices).
import assert from 'node:assert/strict';
import test from 'node:test';

import { letterSvg, letterText, priceRanges, rupeeWords } from '../../ledger/js/price-letter.js';

test('rupees in words, as the letter writes them', () => {
  assert.equal(rupeeWords(100.74), 'Rupees One Hundred and Paise Seventy-Four Only');
  assert.equal(rupeeWords(94.3), 'Rupees Ninety-Four and Paise Thirty Only');
  assert.equal(rupeeWords(100), 'Rupees One Hundred Only');
  assert.equal(rupeeWords(1234567.05), 'Rupees Twelve Lakh Thirty-Four Thousand Five Hundred Sixty-Seven and Paise Five Only');
});

test('a day, a period at one price, a period whose price changed', () => {
  const plain = (t) => t.parts.map((p) => (p.b ? `*${p.t}*` : p.t)).join('');
  const day = letterText({ product: 'HSD', from: '2026-11-07', to: '2026-11-07', ranges: priceRanges([{ date: '2026-11-07', price: 100.74 }]) });
  assert.match(plain(day), /\(\*RSP\*\) of High Speed Diesel \(\*HSD\*\) at our retail outlet, M\/s Vriddhi Fuels, .* on \*07\/11\/2026\* was \*₹ 100\.74 \(Rupees One Hundred and Paise Seventy-Four Only\) per Litre\.\*$/);
  assert.equal(day.table, null);
  const days = ['2026-11-01', '2026-11-02', '2026-11-03'].map((date) => ({ date, price: 100.74 }));
  const one = letterText({ product: 'HSD', from: '2026-11-01', to: '2026-11-03', ranges: priceRanges(days) });
  assert.match(plain(one), /during the period from \*01\/11\/2026\* to \*03\/11\/2026\* was \*₹ 100\.74/);
  const changed = priceRanges([{ date: '2026-10-30', price: 100.5 }, { date: '2026-10-31', price: '100.50' }, { date: '2026-11-01', price: 100.74 }]);
  assert.deepEqual(changed, [{ from: '2026-10-30', to: '2026-10-31', price: 100.5 }, { from: '2026-11-01', to: '2026-11-01', price: 100.74 }]);
  const two = letterText({ product: 'MS', from: '2026-10-30', to: '2026-11-01', ranges: changed });
  assert.match(plain(two), /of Motor Spirit \(\*MS\*\).* was as under:$/);
  assert.deepEqual(two.table.map((r) => [r.period, r.price]), [['30/10/2026 to 31/10/2026', '₹ 100.50'], ['01/11/2026', '₹ 100.74']]);
  assert.deepEqual(priceRanges([{ date: '2026-11-01', price: null }, { date: '2026-11-02', price: '' }]), [{ from: '2026-11-01', to: '2026-11-02', price: null }]);
  // the page: letterhead, title, the sentence (bold parts), the table, the signature block
  const svg = letterSvg(two, { images: { letterhead: 'lh.png', stamp: 'st.png' }, measure: (t, st) => String(t).length * st.s * (st.b ? 0.55 : 0.5) });
  assert.ok(svg.startsWith('<svg') && svg.includes('TO WHOMSOEVER IT MAY CONCERN') && svg.includes('Authorised Signatory'));
  assert.ok(svg.includes('<tspan font-weight="bold">MS</tspan>') && svg.includes('30/10/2026 to 31/10/2026') && svg.includes('href="st.png"'));
  assert.ok(!svg.includes('<script'));
});
