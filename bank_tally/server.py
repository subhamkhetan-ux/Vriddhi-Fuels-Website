"""Local web app: bank statements -> Tally import XML, with in-app review.

Run on the Mac (``python3 -m bank_tally.server``); it opens a browser. Drop the
month's statements (any of the three accounts, .xls/.xlsx), and it classifies
every line, pairs inter-account transfers, skips IOCL payments, and lists
whatever still needs a ledger. You resolve those in the page (each choice is
remembered as an alias), then download the import XML. Nothing leaves the machine.
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

from bank_tally import generate as G          # noqa: E402
from bank_tally import run as R               # noqa: E402
from bank_tally import statement as S         # noqa: E402
from agent.matcher import alias_key           # noqa: E402

DATA_PATH = os.path.join(_HERE, "data.json")           # local aliases (git-ignored)
COMMITTED_ALIASES = os.path.join(_ROOT, "state", "bank_aliases.json")
CUSTOMERS = os.path.join(_ROOT, "state", "customers.json")
OUT_DIR = os.path.join(_HERE, "out")

_STATEMENTS: list = []      # last-uploaded (ledger, rows), so resolve can re-run


def _load_json(path, default):
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return default


def load_aliases() -> dict:
    a = dict(_load_json(COMMITTED_ALIASES, {}))
    a.update(_load_json(DATA_PATH, {}).get("aliases", {}))
    return a


def _save_data(d: dict) -> None:
    tmp = DATA_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(d, fh, indent=2, ensure_ascii=False)
    os.replace(tmp, DATA_PATH)


def save_alias(parsed_name: str, ledger: str) -> None:
    d = _load_json(DATA_PATH, {})
    d.setdefault("aliases", {})[alias_key(parsed_name)] = ledger
    _save_data(d)


def load_dropped() -> set:
    """Keys of generated entries the user has dropped from the export (they'll
    enter those by hand). Persisted locally so drops survive a re-run."""
    return set(_load_json(DATA_PATH, {}).get("dropped", []))


def toggle_dropped(key: str, drop: bool) -> None:
    d = _load_json(DATA_PATH, {})
    cur = set(d.get("dropped", []))
    cur.discard(key)
    if drop:
        cur.add(key)
    d["dropped"] = sorted(cur)
    _save_data(d)


def load_resolved() -> dict:
    """Per-transaction ledger the user picked in review (entry key -> ledger).
    Used for rows that ignore aliases (force-review, unpaired transfers)."""
    return dict(_load_json(DATA_PATH, {}).get("resolved", {}))


def save_resolved(key: str, ledger: str) -> None:
    d = _load_json(DATA_PATH, {})
    d.setdefault("resolved", {})[key] = ledger
    _save_data(d)


def customers() -> list:
    return [c for c in _load_json(CUSTOMERS, []) if "auto-source" not in str(c).lower()]


def ledger_suggestions() -> list:
    """Names to offer in the resolve dropdown: customers + every ledger already
    used in an alias."""
    s = set(customers()) | set(load_aliases().values())
    return sorted(s)


_LAST: dict = {}      # last run's summary+review, for the audit CSV


def _process_and_write():
    global _LAST
    vouchers, review, summary = R.process(
        _STATEMENTS, customers(), load_aliases(),
        dropped=load_dropped(), resolved=load_resolved())
    os.makedirs(OUT_DIR, exist_ok=True)
    with open(os.path.join(OUT_DIR, "bank_import.xml"), "w", encoding="utf-8") as fh:
        fh.write(G.build_envelope(vouchers))
    _LAST = {"summary": summary, "review": review}
    return {"summary": summary, "review": review,
            "suggestions": ledger_suggestions()}


def _audit_csv() -> bytes:
    """Every statement line -> its disposition (voucher+ledger, review, drop, or
    IOCL skip), so you can tick off exactly what should be in Tally."""
    import csv
    import io
    summary = _LAST.get("summary", {})
    review = _LAST.get("review", [])
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["Account", "Date", "Voucher No", "Direction", "Amount",
                "Disposition", "Ledger", "Narration"])
    rows = []
    for e in summary.get("entries", []):
        disp = "DROPPED (by hand)" if e.get("dropped") else e["type"]
        rows.append([e["account"], e["date"], e.get("voucher_no", ""),
                     e["direction"], e["amount"], disp,
                     e.get("counter_ledger", ""), e["narration"]])
    for r in review:
        if r.get("dropped"):
            continue
        rows.append([r["account"], r["date"], "", r["direction"], r["amount"],
                     "REVIEW (needs a ledger)", "", r["narration"]])
    for sk in summary.get("skipped", []):
        rows.append([sk["account"], sk["date"], "", sk["direction"], sk["amount"],
                     "IOCL-SKIP (posted by PAD tool)", "", sk["narration"]])
    rows.sort(key=lambda r: (r[1][6:10], r[1][3:5], r[1][0:2]))   # by yyyy,mm,dd
    for r in rows:
        w.writerow(r)
    return buf.getvalue().encode("utf-8-sig")     # BOM so Excel opens it cleanly


class Handler(BaseHTTPRequestHandler):
    server_version = "BankTally/1.0"

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
        if route == "/download/bank_import.xml":
            try:
                with open(os.path.join(OUT_DIR, "bank_import.xml"), "rb") as fh:
                    return self._send(200, fh.read(), "application/xml",
                                      {"Content-Disposition": 'attachment; filename="bank_import.xml"'})
            except OSError:
                return self._send(404, b"run first", "text/plain")
        if route == "/download/audit.csv":
            if not _LAST:
                return self._send(404, b"run first", "text/plain")
            return self._send(200, _audit_csv(), "text/csv",
                              {"Content-Disposition": 'attachment; filename="bank_audit.csv"'})
        return self._send(404, b"not found", "text/plain")

    def do_POST(self):
        route = urlparse(self.path).path
        body = self._body()
        if route == "/api/run":
            return self._run(body)
        if route == "/api/resolve":
            name = body.get("parsed_name")
            ledger = (body.get("ledger") or "").strip()
            key = (body.get("key") or "").strip()
            tier = body.get("tier") or ""
            if ledger:
                # Always resolve THIS transaction, so the row leaves review and
                # enters the export — this is what makes force-review / unpaired
                # transfers resolvable.
                if key:
                    save_resolved(key, ledger)
                # Also learn an alias for a real payee name, so future statements
                # auto-match. Skip it for rows that vary per transaction or aren't
                # a payee (force-review like ODISHA SARKAR, self-transfers).
                if name and tier not in ("force-review", "self-transfer"):
                    save_alias(name, ledger)
            return self._json(_process_and_write())
        if route == "/api/drop":
            key = (body.get("key") or "").strip()
            if key:
                toggle_dropped(key, bool(body.get("drop", True)))
            return self._json(_process_and_write())
        if route == "/api/rerun":
            return self._json(_process_and_write())
        return self._send(404, b"not found", "text/plain")

    def _run(self, body):
        global _STATEMENTS
        files = body.get("files") or []
        stmts, problems = [], []
        for f in files:
            name = f.get("name", "file")
            try:
                raw = base64.b64decode((f.get("b64") or "").split(",")[-1])
                suffix = ".xlsx" if name.lower().endswith("x") else ".xls"
                with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tf:
                    tf.write(raw)
                    path = tf.name
                ledger = S.detect_account(path)
                rows, summ = S.parse_excel(path)
                os.unlink(path)
                if not ledger:
                    problems.append(f"{name}: could not detect the account number")
                    continue
                if not rows:
                    problems.append(f"{name}: no transactions found ({summ.get('error','')})")
                    continue
                stmts.append((ledger, rows))
            except Exception as exc:
                problems.append(f"{name}: {exc}")
        if not stmts:
            return self._json({"error": "no usable statements", "problems": problems}, 400)
        _STATEMENTS = stmts
        res = _process_and_write()
        res["accounts"] = [led for led, _ in stmts]
        res["problems"] = problems
        return self._json(res)


def main(argv=None):
    import argparse
    ap = argparse.ArgumentParser(description="Bank statements -> Tally (web UI)")
    ap.add_argument("--port", type=int, default=8770)
    ap.add_argument("--no-open", action="store_true")
    args = ap.parse_args(argv)
    httpd = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    url = f"http://127.0.0.1:{args.port}/"
    print(f"Bank -> Tally app running at {url}  (Ctrl-C to stop)")
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
