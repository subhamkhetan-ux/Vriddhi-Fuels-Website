"""Local web app: fleet-card settlement Excel -> Tally journal XML.

Run on the Mac (``python3 -m fleet_tally.server``); it opens a browser. Drop the
Excel (Date, Customer Name, Amount) in, and it makes one Journal per row
(Dr Fleet Card Posting / Cr Customer), flags any customer name that doesn't match
your Tally customer list, and hands you fleet_import.xml. Nothing leaves the machine.
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

from fleet_tally import generate as G       # noqa: E402
from fleet_tally import parse as P          # noqa: E402
from fleet_tally import run as R            # noqa: E402

CUSTOMERS = os.path.join(_ROOT, "state", "customers.json")
OUT_DIR = os.path.join(_HERE, "out")


def customers() -> list:
    try:
        with open(CUSTOMERS, encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return []
    return [c for c in data if "auto-source" not in str(c).lower()]


class Handler(BaseHTTPRequestHandler):
    server_version = "FleetTally/1.0"

    def _send(self, code, body: bytes, ctype, extra=None):
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

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        try:
            return json.loads(self.rfile.read(n).decode()) if n else {}
        except ValueError:
            return {}

    def log_message(self, *a):
        return

    def do_GET(self):
        route = urlparse(self.path).path
        if route in ("/", "/index.html"):
            try:
                with open(os.path.join(_HERE, "index.html"), "rb") as fh:
                    return self._send(200, fh.read(), "text/html; charset=utf-8")
            except OSError:
                return self._send(404, b"no ui", "text/plain")
        if route == "/download/fleet_import.xml":
            try:
                with open(os.path.join(OUT_DIR, "fleet_import.xml"), "rb") as fh:
                    return self._send(200, fh.read(), "application/xml",
                                      {"Content-Disposition": 'attachment; filename="fleet_import.xml"'})
            except OSError:
                return self._send(404, b"run first", "text/plain")
        return self._send(404, b"not found", "text/plain")

    def _parse_file(self, f):
        """Parse one uploaded file dict -> (rows, detected_kind, name, error)."""
        if not f:
            return [], None, None, None
        name = f.get("name", "file.xlsx")
        try:
            raw = base64.b64decode((f.get("b64") or "").split(",")[-1])
            suffix = ".xlsx" if name.lower().endswith(("x", "m")) else ".xls"
            with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tf:
                tf.write(raw)
                path = tf.name
            grid = P.load_grid(path)
            os.unlink(path)
            rows = P._rows_from_grid(grid)
            kind = P.detect_kind(name, grid)
        except Exception as exc:
            return [], None, name, f"{name}: could not read the sheet ({exc})"
        if not rows:
            return [], kind, name, f"{name}: no rows found — needs Date, Customer Name and Amount columns"
        return rows, kind, name, None

    def do_POST(self):
        if urlparse(self.path).path != "/api/run":
            return self._send(404, b"not found", "text/plain")
        body = self._body()
        # Both sheets are optional and independent; either alone is fine. Each
        # file is routed by what it looks like (title note / filename) when that's
        # clear, so a file dropped in the wrong box still lands correctly.
        problems = []
        buckets = {"fleet": [], "tds": []}
        for zone, key in (("fleet", "fleet_file"), ("tds", "tds_file")):
            rows, detected, name, err = self._parse_file(body.get(key))
            if err:
                problems.append(err)
                continue
            if not rows:
                continue
            kind = detected or zone
            if detected and detected != zone:
                problems.append(f"{name}: looks like a {detected.upper()} sheet — "
                                f"filed it as {detected.upper()} (not {zone.upper()}).")
            buckets[kind].extend(rows)
        fleet_rows, tds_rows = buckets["fleet"], buckets["tds"]
        if not fleet_rows and not tds_rows:
            return self._json({"error": "; ".join(problems) or
                               "drop at least one sheet (Fleet or TDS)"}, 400)
        vouchers, entries, summary = R.process(fleet_rows, tds_rows, customers())
        os.makedirs(OUT_DIR, exist_ok=True)
        with open(os.path.join(OUT_DIR, "fleet_import.xml"), "w", encoding="utf-8") as fh:
            fh.write(G.build_envelope(vouchers))
        return self._json({"summary": summary, "entries": entries, "problems": problems})


def main(argv=None):
    import argparse
    ap = argparse.ArgumentParser(description="Fleet-card Excel -> Tally (web UI)")
    ap.add_argument("--port", type=int, default=8771)
    ap.add_argument("--no-open", action="store_true")
    args = ap.parse_args(argv)
    httpd = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    url = f"http://127.0.0.1:{args.port}/"
    print(f"Fleet -> Tally app running at {url}  (Ctrl-C to stop)")
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
