"""Local web app: iCloud invoice folder -> printable consignment notes.

Run it on the Mac (``python3 -m consign.server``); it opens a browser tab. You
point it at the iCloud Drive folder where you drop IndianOil invoice PDFs, and it
lists a consignment note for each new invoice for our own tank truck — with a
serial number, the parsed fields, and a reporting-date picker — ready to Print or
Save as PDF. Nothing is sent anywhere: no email, no Supabase, no network.

Stdlib only (``http.server``); the PDF read uses pymupdf lazily at scan time.
"""

from __future__ import annotations

import json
import os
import sys
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

# Make the repo root importable so ``from agent import invoice`` works when this
# is launched as ``python3 -m consign.server`` from anywhere.
_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from consign import scanner, serial  # noqa: E402

# The app's data file (config + issued serials + per-note overrides). Kept next
# to the app and git-ignored — it holds the running serial counter, so back it
# up if you reinstall.
DATA_PATH = os.path.join(_HERE, "data.json")

DEFAULTS = {
    "invoices_dir": "",
    "own_tt": "OD23U8210",
    "min_invoice_no": "7010221545",
    "serial": {"next_serial": 47, "issued": {}},
    "reporting": {},   # invoice_no -> dd/mm/yyyy override
    "done": [],        # archived invoice numbers
}


def load_data() -> dict:
    try:
        with open(DATA_PATH, encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        data = {}
    # Fill any missing keys so older/partial files keep working.
    for k, v in DEFAULTS.items():
        data.setdefault(k, json.loads(json.dumps(v)))
    data["serial"].setdefault("next_serial", 47)
    data["serial"].setdefault("issued", {})
    return data


def save_data(data: dict) -> None:
    tmp = DATA_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2, ensure_ascii=False)
    os.replace(tmp, DATA_PATH)


def build_notes(data: dict) -> tuple[list[dict], list[str]]:
    """Scan the folder, assign/lookup serials, and return note rows + warnings.

    Serial assignment persists (a scan may hand out new numbers), so the caller
    should ``save_data`` afterwards.
    """
    notes, warnings = scanner.scan(
        data.get("invoices_dir", ""),
        data.get("own_tt", ""),
        str(data.get("min_invoice_no", "")),
    )
    done = set(data.get("done", []))
    reporting = data.get("reporting", {})
    rows = []
    for n in notes:
        inv = n["invoice_no"]
        num, serial_str = serial.assign(data["serial"], inv)
        rows.append({
            **n,
            "serial_num": num,
            "serial_str": serial_str,
            # Reporting date defaults to the invoice date; user can override it.
            "reporting_date": reporting.get(inv) or n.get("invoice_date") or "",
            "done": inv in done,
        })
    rows.sort(key=lambda r: r["serial_num"])
    return rows, warnings


class Handler(BaseHTTPRequestHandler):
    server_version = "VFConsign/1.0"

    # --- helpers -----------------------------------------------------------
    def _send(self, code: int, body: bytes, ctype: str) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, obj, code: int = 200) -> None:
        self._send(code, json.dumps(obj).encode("utf-8"), "application/json")

    def _read_body(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if not length:
            return {}
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except ValueError:
            return {}

    def _file(self, path: str, ctype: str) -> None:
        try:
            with open(path, "rb") as fh:
                self._send(200, fh.read(), ctype)
        except OSError:
            self._send(404, b"not found", "text/plain")

    def log_message(self, fmt, *args):  # quieter console
        return

    # --- routes ------------------------------------------------------------
    def do_GET(self):
        route = urlparse(self.path).path
        if route in ("/", "/index.html"):
            return self._file(os.path.join(_HERE, "index.html"), "text/html; charset=utf-8")
        if route == "/letterhead.png":
            return self._file(os.path.join(_HERE, "letterhead.png"), "image/png")
        if route == "/api/state":
            data = load_data()
            rows, warnings = build_notes(data)
            save_data(data)  # persist any newly-assigned serials
            return self._json({
                "config": {
                    "invoices_dir": data.get("invoices_dir", ""),
                    "own_tt": data.get("own_tt", ""),
                    "min_invoice_no": data.get("min_invoice_no", ""),
                    "next_serial": data["serial"].get("next_serial", 47),
                },
                "folder_ok": bool(data.get("invoices_dir"))
                             and os.path.isdir(data.get("invoices_dir", "")),
                "notes": rows,
                "warnings": warnings,
            })
        return self._send(404, b"not found", "text/plain")

    def do_POST(self):
        route = urlparse(self.path).path
        body = self._read_body()
        data = load_data()

        if route == "/api/config":
            if "invoices_dir" in body:
                data["invoices_dir"] = str(body["invoices_dir"]).strip()
            if "own_tt" in body:
                data["own_tt"] = str(body["own_tt"]).strip().upper()
            if "min_invoice_no" in body:
                data["min_invoice_no"] = str(body["min_invoice_no"]).strip()
            # Only allow moving the counter when nothing has been issued yet,
            # so an edit can never renumber notes already handed out.
            if "next_serial" in body and not data["serial"]["issued"]:
                try:
                    data["serial"]["next_serial"] = int(body["next_serial"])
                except (TypeError, ValueError):
                    pass
            save_data(data)
            return self._json({"ok": True})

        if route == "/api/reporting":
            inv = str(body.get("invoice_no", ""))
            dmy = str(body.get("reporting_date", "")).strip()
            if inv:
                if dmy:
                    data["reporting"][inv] = dmy
                else:
                    data["reporting"].pop(inv, None)
                save_data(data)
            return self._json({"ok": True})

        if route == "/api/done":
            inv = str(body.get("invoice_no", ""))
            done = set(data.get("done", []))
            if body.get("done"):
                done.add(inv)
            else:
                done.discard(inv)
            data["done"] = sorted(done)
            save_data(data)
            return self._json({"ok": True})

        return self._send(404, b"not found", "text/plain")


def main(argv=None):
    import argparse

    ap = argparse.ArgumentParser(description="Vriddhi Fuels consignment-note app")
    ap.add_argument("--port", type=int, default=8756)
    ap.add_argument("--no-open", action="store_true", help="don't open a browser")
    args = ap.parse_args(argv)

    httpd = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    url = f"http://127.0.0.1:{args.port}/"
    print(f"Consignment-note app running at {url}  (Ctrl-C to stop)")
    if not args.no_open:
        try:
            webbrowser.open(url)
        except Exception:
            pass
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
