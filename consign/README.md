# Consignment notes from an iCloud folder — standalone Mac app

Drop your IndianOil tax-invoice PDFs into an iCloud Drive folder and this app
turns each one (for **our own tank truck**) into a numbered, printable
**consignment note** — same letterhead and layout as the `/payments` app, but
completely separate: **no email, no Supabase, no network.** It reads the PDFs
right off your Mac.

```
  iCloud folder ──►  consign/server.py (local, on your Mac)  ──►  browser: review date, Print / Save-as-PDF
   *.pdf invoices     parse · number · render note              (nothing leaves the machine)
```

This is deliberately independent of `/payments`:
- It has **its own serial counter** (`consign/data.json`), so it never clashes
  with the Supabase-numbered notes the payments app makes. Pick which one you use.
- It never reads Gmail and never writes to Supabase.
- It reuses the **verified invoice parser** in [`agent/invoice.py`](../agent/invoice.py),
  so the fields (invoice no, date, TT, product, qty, value) come out identical.

## Run it

```bash
consign/run.sh          # installs pymupdf if needed, starts the app, opens the browser
```

or directly:

```bash
python3 -m consign.server            # http://127.0.0.1:8756
python3 -m consign.server --port 9000 --no-open
```

Leave the terminal window open while you work; press **Ctrl-C** to stop.

## First-time setup (in the browser)

1. The app opens on the **Settings** panel. Paste the **full path** of your
   iCloud invoices folder, e.g.
   `~/Library/Mobile Documents/com~apple~CloudDocs/Vriddhi Invoices`
   (in Finder: right-click a file in that folder → **Get Info** to read the
   path, or drag the folder onto Terminal). Files can stay “in iCloud” — the app
   reads whatever is downloaded on this Mac.
2. Confirm **our tank-truck number** (`OD23U8210`) — only invoices for this TT
   get a note; everything else in the folder is ignored.
3. **Ignore invoices below** an IOCL number (default `7010221545`) — older loads
   were noted manually up to serial 046, so numbering starts at **047**.
4. **Next serial** is editable only until the first note is issued, then it locks
   so numbers can never shift. Set it once to match where you are.
5. **Save & scan.**

## Daily use

- Save the new invoice PDFs into the folder → click **↻ Refresh**.
- Each new invoice appears as a card with its serial and parsed figures.
- Set the **reporting date** (defaults to the invoice date — usually same or next
  day) and click **🖨 Print / Save PDF**. In the print dialog pick a printer or
  **Save as PDF**.
- **Archive** a note once you’ve printed it, to clear it from the list. (Restore
  from the *Archived* section if needed.)

Serials are assigned **once per invoice number** and remembered, so re-scanning
the folder — or the same invoice showing up as two PDFs — never spends a new
number or double-lists a note.

## Files

| Path | What it is |
|---|---|
| `server.py` | The local web server + JSON API (`python3 -m consign.server`) |
| `index.html` | The UI + the note layout (identical boilerplate to `/payments`) |
| `scanner.py` | Folder scan → parsed own-TT notes (reuses `agent/invoice.py`) |
| `serial.py` | Local, idempotent serial assignment |
| `letterhead.png` | The printed letterhead |
| `run.sh` | Launcher (installs pymupdf if missing) |
| `data.json` | Config + serial counter + per-note dates/archive (**git-ignored** — back it up) |

## Notes

- **`data.json` holds your running serial counter** — it’s git-ignored so it
  never lands in the repo, but keep a copy if you move machines.
- Only the invoice’s own fields are read; the **reporting date is yours to set**
  per note (it defaults to the invoice date).
- Requires Python 3.11+ and `pymupdf` (the launcher installs it on first run).
