#!/usr/bin/env node
// The month's register PDFs into Google Drive — run by GitHub
// (.github/workflows/register-pdfs.yml) on the 1st to 7th of every month.
//
// Signs in to the Ledger app as a member, reads the Register (the E-DSR,
// Stock Register and DIP Chart months the app keeps), and once last month's
// figures are all in (its closing readings, or the next month has come in —
// or from the 5th on, whatever there is), draws its pages exactly as the app
// does (ledger/paper.css, register-view.js) and saves two PDFs:
//     DSR <Month YYYY>.pdf             HSD, MS, XtraGreen — a page each
//     Stock Register <Month YYYY>.pdf  the same, Stock Register pages
// into <DRIVE_FOLDER>/FY <yyyy-yy>/ in Google Drive (made when missing).
// A month whose two PDFs are already there is left alone (FORCE=1 makes them
// again, as new versions of the same files).
//
// Environment:
//   LEDGER_EMAIL, LEDGER_PASSWORD  a Ledger member's login (GitHub secrets)
//   GDRIVE_TOKEN                   the JSON from ledger/tools/mint_drive_token.py
//   DRIVE_FOLDER                   default "Vriddhi Fuels/Registers"
//   MONTH                          YYYY-MM (default: last month); FORCE=1
//   OUT_DIR                        write the PDFs here instead of Drive (trying it)
//   DEMO=1                         the app's made-up demo month instead of the Ledger
//
// Needs Playwright with Chromium (npm i playwright; npx playwright install chromium).

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { accessToken, drive } from './drive.mjs';
import { fitPaperToPage } from '../js/paper-fit.js';
import { monthComplete, monthLabel, monthPagesHtml } from '../js/register-view.js';

const here = dirname(fileURLToPath(import.meta.url));
const ledgerDir = join(here, '..');

// today in India (the runner's clock is UTC)
export const todayIST = (now = Date.now()) => new Date(now + 5.5 * 3600e3).toISOString().slice(0, 10);
export function lastMonth(today) {
  const d = new Date(`${today.slice(0, 7)}-01T00:00:00Z`);
  d.setUTCDate(0);
  return d.toISOString().slice(0, 7);
}
// '2026-11' -> 'FY 2026-27'; '2027-02' -> 'FY 2026-27'
export function fyFolder(month) {
  const y = +month.slice(0, 4);
  const start = +month.slice(5, 7) >= 4 ? y : y - 1;
  return `FY ${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}
export const pdfNames = (month) => ({ dsr: `DSR ${monthLabel(month)}.pdf`, stock: `Stock Register ${monthLabel(month)}.pdf` });

// what to do this run: {month, go, why}
export function plan(all, today, { month = null, force = false } = {}) {
  const m = month || lastMonth(today);
  const has = Object.keys(all || {}).some((k) => k === `dsr:${m}` || k === `stock:${m}`);
  if (!has) return { month: m, go: false, why: `the app has nothing for ${monthLabel(m)}` };
  if (month || force) return { month: m, go: true, why: 'asked for' };
  if (monthComplete(all, m)) return { month: m, go: true, why: 'its figures are all in' };
  if (+today.slice(8, 10) >= 5) return { month: m, go: true, why: 'the 5th has come — saving what there is' };
  return { month: m, go: false, why: `waiting for ${monthLabel(m)}'s closing readings (the E-DSR's last row)` };
}

// the pages as one printable document: each page fitted to A4 landscape
export function documentHtml(css, pages) {
  return `<!doctype html><html><head><meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Kalam:wght@700&family=Noto+Sans+Devanagari:wght@600&family=Roboto:wght@500;700&display=swap">
<style>${css}
@page { size: A4 landscape; margin: 8mm; }
html, body { margin: 0; background: #fff; }
.sheet { break-after: page; page-break-after: always; }
.sheet:last-child { break-after: auto; page-break-after: auto; }
.paper { box-shadow: none; padding: 0; background: #fff; margin: 0; }
.reg-flag { display: none; }
</style></head><body>${pages.map((p) => `<div class="sheet">${p}</div>`).join('')}</body></html>`;
}

async function ledgerData(env) {
  const cfg = readFileSync(join(ledgerDir, 'config.js'), 'utf8');
  const url = (cfg.match(/SUPABASE_URL:\s*"([^"]+)"/) || [])[1];
  const key = (cfg.match(/SUPABASE_ANON_KEY:\s*"([^"]+)"/) || [])[1];
  if (!url || !key) throw new Error('ledger/config.js has no SUPABASE_URL / SUPABASE_ANON_KEY.');
  if (!env.LEDGER_EMAIL || !env.LEDGER_PASSWORD) throw new Error('Set the LEDGER_EMAIL and LEDGER_PASSWORD secrets (a Ledger member\'s login).');
  const login = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: env.LEDGER_EMAIL, password: env.LEDGER_PASSWORD }),
  });
  const s = await login.json().catch(() => ({}));
  if (!login.ok || !s.access_token) throw new Error(`The Ledger didn't accept the login for ${env.LEDGER_EMAIL}: ${JSON.stringify(s).slice(0, 200)}`);
  const res = await fetch(`${url}/rest/v1/rpc/ledger_register_get`, {
    method: 'POST', headers: { apikey: key, Authorization: `Bearer ${s.access_token}`, 'Content-Type': 'application/json' }, body: '{}',
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`Reading the Register failed (${res.status}): ${JSON.stringify(data).slice(0, 200)}`);
  return data || {};
}

async function demoData() {
  const { demoRegister } = await import('../js/register-demo.js');
  const { memoryStore } = await import('../js/store.js');
  const now = new Date(Date.now() - 20 * 86400e3);           // a month with readings to show
  return memoryStore({ register: demoRegister(now) }).register();
}

// the pages -> PDF bytes (Chromium prints them; each page fitted to A4 landscape)
export async function renderPdf(pages, chromium) {
  const css = readFileSync(join(ledgerDir, 'paper.css'), 'utf8');
  const browser = await chromium.launch();
  try {
    // laid out as printed (A4 landscape less the margins: 1062 × 733 CSS px)
    const page = await browser.newPage({ viewport: { width: 1062, height: 733 } });
    await page.emulateMedia({ media: 'print' });
    await page.setContent(documentHtml(css, pages), { waitUntil: 'networkidle' });
    await page.evaluate(() => document.fonts.ready);
    // each page fills the sheet: as wide as it, rows as tall as it takes
    await page.evaluate(`(() => {
      const fit = ${fitPaperToPage.toString()};
      for (const p of document.querySelectorAll('.paper')) {
        const z = fit(p, 1052, 724);
        p.style.zoom = String(z);
        p.style.setProperty('--bw', Math.max(1, 0.9 / z).toFixed(2) + 'px');
        // the wider lines took a little room: shrink just enough to stay on the sheet
        const r = p.getBoundingClientRect();
        if (r.width > 1052 || r.height > 724) p.style.zoom = String(z * Math.min(1052 / r.width, 724 / r.height));
      }
    })()`);
    return await page.pdf({ format: 'A4', landscape: true, printBackground: true, margin: { top: '8mm', bottom: '8mm', left: '8mm', right: '8mm' } });
  } finally {
    await browser.close();
  }
}

export async function main(env = process.env) {
  const today = todayIST();
  const all = env.DEMO === '1' ? await demoData() : await ledgerData(env);
  const p = plan(all, today, { month: env.MONTH || null, force: env.FORCE === '1' });
  console.log(`${monthLabel(p.month)}: ${p.go ? 'saving its PDFs' : 'nothing to do'} — ${p.why}.`);
  if (!p.go) return;
  const names = pdfNames(p.month);
  let dr = null;
  let folderId = null;
  let existing = {};
  if (!env.OUT_DIR) {
    if (!env.GDRIVE_TOKEN) throw new Error('Set the GDRIVE_TOKEN secret (ledger/tools/mint_drive_token.py prints it).');
    dr = drive(await accessToken(env.GDRIVE_TOKEN));
    const path = `${(env.DRIVE_FOLDER || 'Vriddhi Fuels/Registers').replace(/\/+$/, '')}/${fyFolder(p.month)}`;
    folderId = await dr.folder(path);
    existing = await dr.files(folderId);
    console.log(`Google Drive folder: My Drive/${path}`);
  }
  const require = createRequire(import.meta.url);
  const { chromium } = require('playwright');
  for (const kind of ['dsr', 'stock']) {
    const name = names[kind];
    if (existing[name] && env.FORCE !== '1') { console.log(`  same  ${name} — already there`); continue; }
    const pdf = await renderPdf(monthPagesHtml(all, p.month, kind), chromium);
    if (env.OUT_DIR) {
      mkdirSync(env.OUT_DIR, { recursive: true });
      writeFileSync(join(env.OUT_DIR, name), pdf);
      console.log(`  wrote ${join(env.OUT_DIR, name)} (${Math.round(pdf.length / 1024)} KB)`);
    } else {
      await dr.upload(folderId, name, pdf, existing[name] || null);
      console.log(`  ${existing[name] ? 'new version of' : 'saved'} ${name} (${Math.round(pdf.length / 1024)} KB)`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(`ERROR: ${err.message}`); process.exit(1); });
}
