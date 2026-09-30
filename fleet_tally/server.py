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
TALLY_LEDGERS = os.path.join(_ROOT, "state", "tally_ledgers.json")   # shipped ledger list (read-only)
DATA_PATH = os.path.join(_HERE, "data.json")     # name mappings / settings (git-ignored)
OUT_DIR = os.path.join(_HERE, "out")
SAMPLES = {"fleet": "fleet_card_template.xlsx", "tds": "tds_receivable_template.xlsx"}

_LAST: dict = {}     # last run's parsed rows, so a mapping change can re-run


def _load_json(path, default):
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return default


def customers() -> list:
    data = _load_json(CUSTOMERS, [])
    return [c for c in data if "auto-source" not in str(c).lower()]


# --- Tally ledger list: shipped + any master.xml uploaded in the Tally apps ---
# An upload in any of the three apps (bank / IOCL / fleet) is seen by all three;
# each file is git-ignored and lives only on this Mac.
LEDGERS_PATH = os.path.join(_HERE, "ledgers.json")
_UPLOADED_LEDGERS = [LEDGERS_PATH] + [
    os.path.join(_ROOT, app, "ledgers.json")
    for app in ("bank_tally", "iocl_tally", "fleet_tally")
    if app != os.path.basename(_HERE)]


def _unescape_xml(s: str) -> str:
    return (s.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", '"')
            .replace("&apos;", "'").replace("&amp;", "&"))


def parse_master_xml(raw: bytes) -> list:
    """Ledger names from a Tally master export (``<LEDGER NAME="...">`` or
    ``<LEDGERNAME>``), UTF-16 or UTF-8, unescaped and de-duplicated."""
    import re
    if raw[:2] in (b"\xff\xfe", b"\xfe\xff"):
        text = raw.decode("utf-16", errors="replace")
    else:
        text = raw.decode("utf-8", errors="replace")
    names = re.findall(r'<LEDGER\b[^>]*\bNAME="([^"]*)"', text)
    names += re.findall(r"<LEDGERNAME>([^<]*)</LEDGERNAME>", text)
    seen, out = set(), []
    for n in names:
        n = _unescape_xml(n).strip()
        if n and n.lower() not in seen:
            seen.add(n.lower())
            out.append(n)
    return out


def save_ledgers(names: list) -> None:
    tmp = LEDGERS_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(names, fh, indent=2, ensure_ascii=False)
    os.replace(tmp, LEDGERS_PATH)


def n_uploaded_ledgers() -> int:
    return len({n.lower() for p in _UPLOADED_LEDGERS for n in _read_list(p)})


def _read_list(path) -> list:
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return []
    return [str(n) for n in data if n] if isinstance(data, list) else []


def tally_ledgers() -> list:
    """Every known Tally ledger: uploaded master.xml lists first, then the shipped
    state/tally_ledgers.json, de-duplicated ignoring case."""
    seen, out = set(), []
    for path in _UPLOADED_LEDGERS + [TALLY_LEDGERS]:
        for n in _read_list(path):
            if n.strip().lower() not in seen:
                seen.add(n.strip().lower())
                out.append(n)
    return out



def load_data() -> dict:
    d = _load_json(DATA_PATH, {})
    return d if isinstance(d, dict) else {}


def save_data(d: dict) -> None:
    tmp = DATA_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(d, fh, indent=2, ensure_ascii=False)
    os.replace(tmp, DATA_PATH)


def company(d: dict | None = None) -> str:
    d = load_data() if d is None else d
    return (d.get("company") or "").strip() or G.DEFAULT_COMPANY


class MappingError(ValueError):
    def __init__(self, msg, **extra):
        super().__init__(msg)
        self.extra = extra


def _known(ledger: str):
    by_low = {str(n).strip().lower(): n for n in tally_ledgers() + customers()}
    return by_low.get(ledger.strip().lower())


def mapping_op(body: dict) -> None:
    """Apply one change from the Mappings tab (raises MappingError)."""
    d = load_data()
    op = body.get("op") or ""
    allow_unknown = bool(body.get("allow_unknown"))

    def checked(ledger):
        ledger = (ledger or "").strip()
        if not ledger:
            raise MappingError("choose a Tally ledger")
        exact = _known(ledger)
        if exact:
            return exact
        if not allow_unknown:
            raise MappingError(f"'{ledger}' is not in the Tally ledger / customer "
                               "list — check the spelling", unknown_ledger=True)
        return ledger

    if op == "set_alias":
        key = R.alias_key(body.get("name") or "")
        if len(key.replace(" ", "")) < 3:
            raise MappingError("the sheet name is too short — use at least 3 letters")
        ledger = checked(body.get("ledger"))
        old = R.alias_key(body.get("old_key") or "")
        aliases = d.setdefault("aliases", {})
        if old and old != key:
            aliases.pop(old, None)
        aliases[key] = ledger
    elif op == "delete_alias":
        d.setdefault("aliases", {}).pop(body.get("key") or "", None)
    elif op == "posting":
        kind = body.get("kind")
        if kind not in G.KINDS:
            raise MappingError("unknown journal kind")
        posting = d.setdefault("posting", {})
        ledger = (body.get("ledger") or "").strip()
        if not ledger or ledger == G.KINDS[kind]["ledger"]:
            posting.pop(kind, None)
        else:
            posting[kind] = checked(ledger)
    elif op == "company":
        name = " ".join((body.get("company") or "").split())
        if not name:
            raise MappingError("type the Tally company name exactly as Tally shows it")
        if name == G.DEFAULT_COMPANY:
            d.pop("company", None)
        else:
            d["company"] = name
    else:
        raise MappingError("unknown operation")
    save_data(d)


def mappings_view() -> dict:
    d = load_data()
    known_low = {str(n).strip().lower() for n in tally_ledgers() + customers()}
    aliases = [{"key": k, "ledger": v, "in_tally": v.strip().lower() in known_low}
               for k, v in sorted(d.get("aliases", {}).items())]
    posting = {k: {"default": v["ledger"], "ledger": d.get("posting", {}).get(k, "")}
               for k, v in G.KINDS.items()}
    unknown = sorted({e["customer"] for e in _LAST.get("entries", [])
                      if e.get("status") == "unknown-customer"}, key=str.lower)
    return {"aliases": aliases, "posting": posting, "company": company(d),
            "default_company": G.DEFAULT_COMPANY, "unknown": unknown,
            "loaded": bool(_LAST),
            "suggestions": sorted(set(customers()) | set(tally_ledgers()), key=str.lower)}


def run_and_write(fleet_rows, tds_rows) -> dict:
    d = load_data()
    vouchers, entries, summary = R.process(
        fleet_rows, tds_rows, customers() + tally_ledgers(), aliases=d.get("aliases", {}),
        posting=d.get("posting", {}))
    os.makedirs(OUT_DIR, exist_ok=True)
    with open(os.path.join(OUT_DIR, "fleet_import.xml"), "w", encoding="utf-8") as fh:
        fh.write(G.build_envelope(vouchers, company(d)))
    _LAST.update({"fleet": fleet_rows, "tds": tds_rows, "entries": entries})
    return {"summary": summary, "entries": entries,
            "suggestions": sorted(set(customers()) | set(tally_ledgers()), key=str.lower)}


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
        if route == "/api/mappings":
            return self._json(mappings_view())
        if route == "/api/ledgers":
            return self._json({"n_ledgers": n_uploaded_ledgers()})
        if route.startswith("/download/sample/"):
            name = SAMPLES.get(route.rsplit("/", 1)[-1])
            if name:
                try:
                    with open(os.path.join(_HERE, "samples", name), "rb") as fh:
                        return self._send(
                            200, fh.read(),
                            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                            {"Content-Disposition": f'attachment; filename="{name}"'})
                except OSError:
                    pass
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
        route = urlparse(self.path).path
        if route == "/api/mappings":
            try:
                mapping_op(self._body())
            except MappingError as exc:
                return self._json({"error": str(exc), **exc.extra}, 400)
            res = mappings_view()
            if _LAST:
                res["run"] = run_and_write(_LAST["fleet"], _LAST["tds"])
                res["unknown"] = mappings_view()["unknown"]
            return self._json(res)
        if route == "/api/ledgers":
            body = self._body()
            f = body.get("file") or {}
            try:
                names = parse_master_xml(base64.b64decode((f.get("b64") or "").split(",")[-1]))
            except Exception as exc:
                return self._json({"error": f"could not read master.xml: {exc}"}, 400)
            if not names:
                return self._json({"error": "no <LEDGER> entries found — is this a "
                                   "Tally master export?"}, 400)
            save_ledgers(names)
            res = {"n_ledgers": len(names), "n_total": n_uploaded_ledgers()}
            if _LAST:                      # re-check names against the fresh list
                res["run"] = run_and_write(_LAST["fleet"], _LAST["tds"])
            return self._json(res)
        if route != "/api/run":
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
        res = run_and_write(fleet_rows, tds_rows)
        res["problems"] = problems
        return self._json(res)


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
