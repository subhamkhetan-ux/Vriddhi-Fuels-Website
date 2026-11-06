// The spreadsheet engine that works out the Tanker Billing workbook's formulas.
import assert from 'node:assert/strict';
import test from 'node:test';

import { basicFormat, isErr, isoToSerial, makeCalc, parseFormula } from '../../ledger/js/formula.js';

const book = (cells, extra = {}) => ({ sheets: { S: { cells }, ...(extra.sheets || {}) }, names: extra.names || {}, tables: extra.tables || {} });
const v = (model, a, opts) => makeCalc(model, opts).value('S', a);
const f = (formula, cells = {}, extra) => v(book({ ...cells, Z99: { f: formula } }, extra), 'Z99');

test('operators and precedence, as Excel', () => {
  assert.equal(f('1+2*3'), 7);
  assert.equal(f('2^3^2'), 64);                    // left to right
  assert.equal(f('-2^2'), 4);                      // negation first
  assert.equal(f('"a"&0.1+0.2'), 'a0.3');          // & after +
  assert.equal(f('10%*50'), 5);
  assert.equal(f('"abc"="ABC"'), true);            // text ignores case
  assert.equal(f('A1=0', {}), true);               // a blank is 0 …
  assert.equal(f('A1=""', {}), true);              // … and ""
  assert.equal(f('1<"a"'), true);                  // numbers before text
  assert.equal(f('0.7399999999999949&""'), '0.739999999999995'); // 15 significant digits, as Excel
  assert.equal(f('1/0').code, '#DIV/0!');
  assert.equal(f('"x"+1').code, '#VALUE!');
});

test('references, ranges, other sheets, names, tables', () => {
  const extra = {
    sheets: { 'Other Sheet': { cells: { A1: { v: 5 }, B1: { v: 7 } } } },
    names: { RATE: "'Other Sheet'!$B$1", Companies: 'T[Company]' },
    tables: { T: { sheet: 'S', r0: 0, c0: 0, r1: 3, c1: 2, cols: ['Company', 'Tier', 'HSD'], header: true, totals: false } },
  };
  const cells = {
    A1: { v: 'Company' }, B1: { v: 'Tier' }, C1: { v: 'HSD' },
    A2: { v: 'Alpha' }, B2: { v: 'Bulk' }, C2: { f: 'XLOOKUP(T[[#This Row],[Tier]],D2:D3,E2:E3,"")' },
    A3: { v: 'Beta' }, B3: { v: 'Retail' }, C3: { f: 'XLOOKUP([@Tier],D2:D3,E2:E3,"")' },
    A4: { v: 'Gamma' }, B4: { v: 'None' }, C4: { f: 'XLOOKUP(T[[#This Row],[Tier]],D2:D3,E2:E3,"")' },
    D2: { v: 'Bulk' }, E2: { f: 'E3-0.5' }, D3: { v: 'Retail' }, E3: { v: 91 },
  };
  const m = book(cells, extra);
  const c = makeCalc(m);
  assert.equal(c.value('S', 'C2'), 90.5);
  assert.equal(c.value('S', 'C3'), 91);
  assert.equal(c.value('S', 'C4'), '');                                   // if_not_found "" is given
  assert.equal(f("'Other Sheet'!A1+RATE", cells, extra), 12);
  assert.equal(f('XLOOKUP("beta",T[Company],T[HSD])', cells, extra), 91);
  assert.equal(f('COUNTA(Companies)', cells, extra), 3);
  assert.equal(f('SUM(T[HSD])', cells, extra), 181.5);                     // the third is "" (not found)
  assert.equal(f('XLOOKUP("Zeta",T[Company],T[HSD])', cells, extra).code, '#N/A');
  assert.equal(f('IFERROR(XLOOKUP("Zeta",T[Company],T[HSD]),0)', cells, extra), 0);
  assert.equal(f('INDEX(T[Company],2)', cells, extra), 'Beta');
  assert.equal(f('MATCH("Gamma",T[Company],0)', cells, extra), 3);
  assert.equal(f('VLOOKUP("Retail",D2:E3,2,FALSE)', cells, extra), 91);
  assert.equal(f('ROWS(FILTER(T[Company],T[HSD]>90))', cells, extra), 3);  // "" > 90: text is bigger than any number, as in Excel
  // what the form types in wins over the cell, and what depends on it follows
  assert.equal(makeCalc(m, { overrides: { 'S!E3': 100 } }).value('S', 'C2'), 99.5);
  assert.equal(f('Nope+1', cells, extra).code, '#NAME?');
});

test('functions the workbook uses', () => {
  assert.equal(f('LET(_xlpm.x,TRIM("  a   b "),IF(_xlpm.x="","",_xlpm.x))'), 'a b');
  assert.equal(f('INDEX({"One","Two","Three"},2)'), 'Two');
  assert.equal(f('TEXTBEFORE("Account No. – 0468","–")'), 'Account No. ');
  assert.equal(f('TRIM(TEXTAFTER("Account No. – 0468","–"))'), '0468');
  assert.equal(f('IFERROR(TRIM(TEXTBEFORE("Payment Details:","–")),"no")'), 'no');
  assert.equal(f('ISNUMBER(SEARCH("xtrapower","Payment Details for XtraPower Account:"))'), true);
  assert.equal(f('SUBSTITUTE("within {N} days","{N}",30)'), 'within 30 days');
  assert.equal(f('AND(ISNUMBER(SEARCH("{N}","x {N}")),N("")<=0)'), true);
  assert.equal(f('OR("a"="b","")'), false);
  assert.equal(f('TRUNC(12000*99.74,0)'), 1196880);
  assert.equal(f('ROUND(2.675,2)'), 2.68);
  assert.equal(f('ROUND(-1.5,0)'), -2);
  assert.equal(f('MOD(INT(14925000/100000),100)'), 49);
  const nov3 = isoToSerial('2026-11-03');
  assert.equal(f(`IF(DAY(${nov3})<=15,DATE(YEAR(${nov3}),MONTH(${nov3}),15),EOMONTH(${nov3},0))`), isoToSerial('2026-11-15'));
  assert.equal(f(`EOMONTH(${isoToSerial('2028-02-20')},0)`), isoToSerial('2028-02-29'));
  assert.equal(v(book({ A1: { f: 'TODAY()' } }), 'A1', { today: nov3 }), nov3);
  assert.equal(f('TEXT(0.7399999999999949,"0.00")'), '0.74');
  assert.equal(f('TEXT(0.1,"0%")'), '10%');
  assert.equal(f('TEXT(53730,"#,##0")'), '53,730');
  assert.equal(f('TEXTJOIN(", ",TRUE,"a","","b")'), 'a, b');
  assert.equal(f('IF(FALSE,1)'), false);
  assert.ok(isErr(f('NA()')));
  // the Proforma's amount in words, written as the sheet writes it
  const words = 'LET(_xlpm.n,ROUND(A1,0),_xlpm.o,{"One","Two","Three","Four","Five","Six","Seven","Eight","Nine","Ten","Eleven","Twelve","Thirteen","Fourteen","Fifteen","Sixteen","Seventeen","Eighteen","Nineteen"},_xlpm.t,{"Twenty","Thirty","Forty","Fifty","Sixty","Seventy","Eighty","Ninety"},_xlpm.cr,INT(_xlpm.n/10000000),_xlpm.lk,MOD(INT(_xlpm.n/100000),100),_xlpm.th,MOD(INT(_xlpm.n/1000),100),_xlpm.hd,MOD(INT(_xlpm.n/100),10),_xlpm.rs,MOD(_xlpm.n,100),IF(_xlpm.n=0,"Rupees Zero Only",TRIM("Rupees "&IF(_xlpm.cr>0,IF(_xlpm.cr=0,"",IF(_xlpm.cr<20,INDEX(_xlpm.o,_xlpm.cr),TRIM(INDEX(_xlpm.t,INT(_xlpm.cr/10)-1)&" "&IF(MOD(_xlpm.cr,10)=0,"",INDEX(_xlpm.o,MOD(_xlpm.cr,10))))))&" Crore ","")&IF(_xlpm.lk>0,IF(_xlpm.lk=0,"",IF(_xlpm.lk<20,INDEX(_xlpm.o,_xlpm.lk),TRIM(INDEX(_xlpm.t,INT(_xlpm.lk/10)-1)&" "&IF(MOD(_xlpm.lk,10)=0,"",INDEX(_xlpm.o,MOD(_xlpm.lk,10))))))&" Lakh ","")&IF(_xlpm.th>0,IF(_xlpm.th=0,"",IF(_xlpm.th<20,INDEX(_xlpm.o,_xlpm.th),TRIM(INDEX(_xlpm.t,INT(_xlpm.th/10)-1)&" "&IF(MOD(_xlpm.th,10)=0,"",INDEX(_xlpm.o,MOD(_xlpm.th,10))))))&" Thousand ","")&IF(_xlpm.hd>0,INDEX(_xlpm.o,_xlpm.hd)&" Hundred ","")&IF(_xlpm.rs>0,IF(_xlpm.rs=0,"",IF(_xlpm.rs<20,INDEX(_xlpm.o,_xlpm.rs),TRIM(INDEX(_xlpm.t,INT(_xlpm.rs/10)-1)&" "&IF(MOD(_xlpm.rs,10)=0,"",INDEX(_xlpm.o,MOD(_xlpm.rs,10))))))&" ","")&"Only")))';
  assert.equal(f(words, { A1: { v: 14925000 } }), 'Rupees One Crore Forty Nine Lakh Twenty Five Thousand Only');
  assert.equal(f(words, { A1: { v: 1196880 } }), 'Rupees Eleven Lakh Ninety Six Thousand Eight Hundred Eighty Only');
});

test('formulas the app can\'t read are reported, not guessed', () => {
  const c = makeCalc(book({ A1: { f: 'LAMBDA(x,x)(1)' }, A2: { f: 'MADEUPFN(1)' } }));
  assert.ok(isErr(c.value('S', 'A2')));
  assert.ok([...c.unknown].some((u) => /MADEUPFN/.test(u)));
  assert.throws(() => parseFormula('1+'), /ends too early/);
  assert.equal(basicFormat('0.00', 2), '2.00');
  assert.equal(basicFormat('dd/mm/yyyy', isoToSerial('2026-11-06')), '06/11/2026');
});
