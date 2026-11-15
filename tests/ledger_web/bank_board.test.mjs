// The bank details poster by the dispensers.
import assert from 'node:assert/strict';
import test from 'node:test';

import { BANK_DEFAULT, bankBoardSvg, bankProblems, cleanBank, groupDigits } from '../../ledger/js/bank-board.js';

test('cleanBank tidies what is typed', () => {
  const d = cleanBank({ name: '  Vriddhi   Fuels ', account: '0468 0500-4716', ifsc: ' icic0000468 ', bank: 'ICICI', branch: ' Main ', note: '' });
  assert.equal(d.name, 'Vriddhi Fuels');
  assert.equal(d.account, '046805004716');
  assert.equal(d.ifsc, 'ICIC0000468');
  assert.equal(d.branch, 'Main');
  assert.equal(d.type, '');
});

test('bankProblems checks the account number, IFSC and bank', () => {
  assert.deepEqual(bankProblems(cleanBank(BANK_DEFAULT)), []);
  assert.equal(bankProblems(cleanBank({ ...BANK_DEFAULT, account: '' })).length, 1);
  assert.match(bankProblems(cleanBank({ ...BANK_DEFAULT, account: '04680A' }))[0], /digits/);
  assert.match(bankProblems(cleanBank({ ...BANK_DEFAULT, ifsc: 'ICIC000468' }))[0], /11 characters/);
  assert.match(bankProblems(cleanBank({ ...BANK_DEFAULT, bank: ' ' }))[0], /bank name/);
});

test('groupDigits splits the account number in fours', () => {
  assert.equal(groupDigits('046805004716'), '0468 0500 4716');
  assert.equal(groupDigits('12345678901'), '1234 5678 901');
});

test('bankBoardSvg draws every detail on an A4-shaped page', () => {
  const svg = bankBoardSvg({ ...BANK_DEFAULT, branch: 'A & B Road' });
  assert.match(svg, /viewBox="0 0 1240 1754"/);
  for (const t of ['VRIDDHI FUELS', '0468 0500 4716', 'ICIC0000468', 'ICICI BANK Ltd', 'A &amp; B Road', 'CURRENT ACCOUNT', 'show the payment message']) assert.ok(svg.includes(t), t);
  // a changed account is what's drawn
  const other = bankBoardSvg({ ...BANK_DEFAULT, account: '111122223333', ifsc: 'SBIN0001234', bank: 'State Bank of India', note: '' });
  assert.ok(other.includes('1111 2222 3333') && other.includes('SBIN0001234') && !other.includes('0468'));
  assert.ok(!other.includes('show the payment message'));
});

test('a long branch wraps instead of running off the page', () => {
  const svg = bankBoardSvg({ ...BANK_DEFAULT, branch: 'Jharsuguda Main Branch, Kalimandir Road, Near Old Bus Stand, Jharsuguda, Odisha 768201, India' });
  assert.ok(svg.includes('>Jharsuguda Main Branch,'));
  assert.ok(!svg.includes('>Jharsuguda Main Branch, Kalimandir Road, Near Old Bus Stand, Jharsuguda, Odisha 768201, India<'));
});
