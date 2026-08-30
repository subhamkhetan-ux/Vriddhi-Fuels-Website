"""Local web app: IOCL PAD statement -> Tally import XML (a UI over ``run.py``).

Run it on the Mac (``python3 -m iocl_tally.server``); it opens a browser tab.
You drop in the month's PAD PDF, point it at the folder of IOCL invoice PDFs
(the same iCloud folder the ``consign/`` app reads), and it shows the
reconciliation summary + a per-line review, then hands you the import XML to load
into Tally. Nothing leaves the machine.

Stdlib only (``http.server``); pymupdf is used lazily to read the PDFs.
"""

from __future__ import annotations

import base64
import json
import os
import sys
import tempfile
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from iocl_tally import run as R  # noqa: E402

DATA_PATH = os.path.join(_HERE, "data.json")
OUT_DIR = os.path.join(_HERE, "out")

# next_tt seeds the manual purchase (TT) voucher-number counter — set it to the
# number AFTER your last TT purchase in Tally so new ones continue the sequence.
DEFAULTS = {"invoices_dir": "", "tt": {"next_tt": 131, "issued": {}}}


def load_data() -> dict:
    try:
        with open(DATA_PATH, encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        data = {}
    for k, v in DEFAULTS.items():
        data.setdefault(k, json.loads(json.dumps(v)))
    data["tt"].setdefault("next_tt", 131)
    data["tt"].setdefault("issued", {})
    return data


def save_data(data: dict) -> None:
    tmp = DATA_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2, ensure_ascii=False)
    os.replace(tmp, DATA_PATH)


class Handler(BaseHTTPRequestHandler):
    server_version = "IOCLTally/1.0"

    def _send(self, code, body: bytes, ctype: str, extra=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _json(self, obj, code=200):
        self._send(code, json.dumps(obj).encode(), "application/json")

    def _file(self, path, ctype, download_name=None):
        try:
            with open(path, "rb") as fh:
                extra = ({"Content-Disposition": f'attachment; filename="{download_name}"'}
                         if download_name else None)
                self._send(200, fh.read(), ctype, extra)
        except OSError:
            self._send(404, b"not found", "text/plain")

    def _body(self) -> dict:
        n = int(self.headers.get("Content-Length") or 0)
        if not n:
            return {}
        try:
            return json.loads(self.rfile.read(n).decode())
        except ValueError:
            return {}

    def log_message(self, *a):
        return

    def do_GET(self):
        route = urlparse(self.path).path
        if route in ("/", "/index.html"):
            return self._file(os.path.join(_HERE, "index.html"), "text/html; charset=utf-8")
        if route == "/api/config":
            d = load_data()
            folder = R.normalize_dir(d.get("invoices_dir", ""))
            return self._json({"invoices_dir": folder,
                               "folder_ok": bool(folder) and os.path.isdir(folder),
                               "next_tt": d["tt"].get("next_tt", 131)})
        if route == "/download/import.xml":
            return self._file(os.path.join(OUT_DIR, "IOCL_import.xml"),
                              "application/xml", "IOCL_import.xml")
        if route == "/download/review.csv":
            return self._file(os.path.join(OUT_DIR, "IOCL_review.csv"),
                              "text/csv", "IOCL_review.csv")
        return self._send(404, b"not found", "text/plain")

    def do_POST(self):
        route = urlparse(self.path).path
        body = self._body()
        data = load_data()
        if route == "/api/config":
            folder = data.get("invoices_dir", "")
            if "invoices_dir" in body:
                folder = R.normalize_dir(str(body["invoices_dir"]))
                data["invoices_dir"] = folder
            if "next_tt" in body:
                try:
                    data["tt"]["next_tt"] = int(body["next_tt"])
                except (TypeError, ValueError):
                    pass
            save_data(data)
            return self._json({"ok": True, "invoices_dir": folder,
                               "folder_ok": bool(folder) and os.path.isdir(folder),
                               "next_tt": data["tt"].get("next_tt", 131)})
        if route == "/api/run":
            return self._run(body, data)
        return self._send(404, b"not found", "text/plain")

    def _run(self, body, data):
        pad_b64 = body.get("pad_b64")
        if not pad_b64:
            return self._json({"error": "no PAD file provided"}, 400)
        invoices_dir = str(body.get("invoices_dir") or data.get("invoices_dir") or "").strip()
        if "invoices_dir" in body:
            data["invoices_dir"] = invoices_dir
            save_data(data)
        try:
            pad_bytes = base64.b64decode(pad_b64.split(",")[-1])
        except Exception as exc:
            return self._json({"error": f"bad PAD upload: {exc}"}, 400)
        try:
            with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tf:
                tf.write(pad_bytes)
                pad_path = tf.name
            text = R.P.extract_text(pad_path)
            os.unlink(pad_path)
            tt_state = data["tt"]
            records, vouchers, review, summary = R.process(
                text, invoices_dir, tt_state=tt_state)
            R.write_outputs(OUT_DIR, vouchers, review)
            save_data(data)   # persist the advanced TT counter + issued map
        except Exception as exc:
            return self._json({"error": f"run failed: {exc}"}, 500)

        missing = [{"doc_number": r["doc_number"], "date": r["date"],
                    "amount": r["debit"]} for r in review
                   if r["category"] == "PURCHASE" and r["status"] == "SKIPPED"]
        return self._json({
            "summary": {k: summary[k] for k in (
                "opening", "n_postable", "reconciles", "first_break",
                "n_vouchers", "counts", "skipped_purchases",
                "stated_closing", "open_delivery_addon")},
            "review": review,
            "missing": missing,
            "invoices_dir": invoices_dir,
        })


def main(argv=None):
    import argparse
    ap = argparse.ArgumentParser(description="IOCL PAD -> Tally (web UI)")
    ap.add_argument("--port", type=int, default=8760)
    ap.add_argument("--no-open", action="store_true")
    args = ap.parse_args(argv)
    httpd = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    url = f"http://127.0.0.1:{args.port}/"
    print(f"IOCL PAD -> Tally app running at {url}  (Ctrl-C to stop)")
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
