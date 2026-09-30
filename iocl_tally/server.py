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
from iocl_tally import xml_generator as G  # noqa: E402

DATA_PATH = os.path.join(_HERE, "data.json")
OUT_DIR = os.path.join(_HERE, "out")
TALLY_LEDGERS = os.path.join(_ROOT, "state", "tally_ledgers.json")   # shipped ledger list (read-only)

# next_tt seeds the manual purchase (TT) voucher-number counter — set it to the
# number AFTER your last TT purchase in Tally so new ones continue the sequence.
# next_tt seeds the manual purchase (TT) voucher-number counter — the number the
# next purchase gets. You set it per run in the generate screen.
DEFAULTS = {"invoices_dir": "", "next_tt": 96}


def load_data() -> dict:
    try:
        with open(DATA_PATH, encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        data = {}
    for k, v in DEFAULTS.items():
        data.setdefault(k, v)
    return data


def save_data(data: dict) -> None:
    tmp = DATA_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2, ensure_ascii=False)
    os.replace(tmp, DATA_PATH)


# --- Mappings tab: ledger renames, extra collection accounts, company ---------
#
# All stored in this Mac's data.json (git-ignored); the shipped templates are
# never edited. Applied to the generator before every run.

_LAST_COLLECTIONS: list = []     # last run's ECollection lines, to help pick a marker
_LAST_INPUT: dict = {}           # last PAD run (text, folder, TT start) — re-run after a rule change
IOCL_PARTY = "M/s Indian Oil Corporation Limited"


class MappingError(ValueError):
    def __init__(self, msg, **extra):
        super().__init__(msg)
        self.extra = extra


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



def _known(ledger: str):
    by_low = {n.strip().lower(): n for n in tally_ledgers()}
    by_low.update({n.strip().lower(): n for n in G.template_ledgers()})
    return by_low.get(ledger.strip().lower())


def apply_config(data: dict | None = None) -> None:
    data = load_data() if data is None else data
    G.LEDGER_RENAMES.clear()
    G.LEDGER_RENAMES.update({k: v for k, v in data.get("ledger_renames", {}).items() if v})
    G.EXTRA_COLLECTION_ROUTES[:] = [(r["marker"], r["ledger"])
                                    for r in data.get("collection_routes", [])
                                    if r.get("marker") and r.get("ledger")]
    G.CUSTOM_RULES[:] = [(r["phrase"], r["ledger"]) for r in data.get("line_rules", [])
                         if r.get("phrase") and r.get("ledger")]


def company(data: dict | None = None) -> str:
    data = load_data() if data is None else data
    return (data.get("company") or "").strip() or G.DEFAULT_COMPANY


def mapping_op(body: dict) -> None:
    """Apply one change from the Mappings tab (raises MappingError)."""
    import re
    data = load_data()
    op = body.get("op") or ""
    allow_unknown = bool(body.get("allow_unknown"))
    if op == "rename":
        name = body.get("name") or ""
        if name not in G.template_ledgers():
            raise MappingError("that ledger isn't used by any template")
        new = (body.get("new") or "").strip()
        renames = data.setdefault("ledger_renames", {})
        if not new or new == name:
            renames.pop(name, None)
        else:
            exact = _known(new)
            if exact:
                new = exact
            elif not allow_unknown:
                raise MappingError(f"'{new}' is not in the Tally ledger list — check "
                                   "the spelling", unknown_ledger=True)
            renames[name] = new
    elif op == "add_route":
        marker = re.sub(r"\s+", "", body.get("marker") or "")
        ledger = (body.get("ledger") or "").strip()
        if len(marker) < 5:
            raise MappingError("the account marker must be at least 5 characters "
                               "(a run of the account number as the PAD shows it)")
        for m, _tpl, led in G.COLLECTION_ROUTES:
            if m in marker or marker in m:
                raise MappingError(f"'{marker}' overlaps the built-in route for {led}")
        routes = data.setdefault("collection_routes", [])
        if any(r.get("marker") == marker for r in routes):
            raise MappingError(f"a route for '{marker}' already exists")
        if not ledger:
            raise MappingError("type the bank's Tally ledger name")
        exact = _known(ledger)
        if exact:
            ledger = exact
        elif not allow_unknown:
            raise MappingError(f"'{ledger}' is not in the Tally ledger list — check "
                               "the spelling", unknown_ledger=True)
        routes.append({"marker": marker, "ledger": ledger})
    elif op == "add_rule":
        # Map a PAD line type the tool doesn't know (shown as UNKNOWN) to a ledger.
        phrase = G.rule_text(body.get("phrase") or "")
        ledger = (body.get("ledger") or "").strip()
        if len(phrase.replace(" ", "")) < 4:
            raise MappingError("the words to match must have at least 4 letters "
                               "(numbers are ignored, so dates/refs never break it)")
        if not ledger:
            raise MappingError("choose the Tally ledger for these lines")
        if ledger.lower() == IOCL_PARTY.lower():
            raise MappingError("IOCL is already the other side of every PAD voucher — "
                               "choose the ledger these lines belong to")
        exact = _known(ledger)
        if exact:
            ledger = exact
        elif not allow_unknown:
            raise MappingError(f"'{ledger}' is not in the Tally ledger list — check "
                               "the spelling", unknown_ledger=True)
        rules = [r for r in data.get("line_rules", []) if r.get("phrase") != phrase]
        rules.append({"phrase": phrase, "ledger": ledger})
        data["line_rules"] = rules
    elif op == "remove_rule":
        phrase = body.get("phrase") or ""
        data["line_rules"] = [r for r in data.get("line_rules", [])
                              if r.get("phrase") != phrase]
    elif op == "remove_route":
        marker = body.get("marker") or ""
        data["collection_routes"] = [r for r in data.get("collection_routes", [])
                                     if r.get("marker") != marker]
    elif op == "company":
        name = " ".join((body.get("company") or "").split())
        if not name:
            raise MappingError("type the Tally company name exactly as Tally shows it")
        if name == G.DEFAULT_COMPANY:
            data.pop("company", None)
        else:
            data["company"] = name
    else:
        raise MappingError("unknown operation")
    save_data(data)
    apply_config(data)


def mappings_view() -> dict:
    from iocl_tally import pad_parser as P
    data = load_data()
    apply_config(data)
    known_low = {n.strip().lower() for n in tally_ledgers()}
    ledgers = []
    for name, used in sorted(G.template_ledgers().items(), key=lambda kv: kv[0].lower()):
        now = G.renamed(name)
        ledgers.append({"name": name, "templates": used,
                        "renamed_to": now if now != name else "",
                        "in_tally": not known_low or now.strip().lower() in known_low})
    routes = [{"marker": m, "ledger": led, "builtin": True, "template": tpl[:-4]}
              for m, tpl, led in G.COLLECTION_ROUTES]
    routes.append({"marker": "(anything else)", "ledger": G.COLLECTION_DEFAULT[1],
                   "builtin": True, "template": G.COLLECTION_DEFAULT[0][:-4]})
    routes += [{"marker": m, "ledger": led, "builtin": False, "template": "COLLECTION_OD"}
               for m, led in G.EXTRA_COLLECTION_ROUTES]
    cats = [{"category": c, "ledger": G.renamed(R.COUNTER_LEDGER.get(c, "")),
             "template": G.JOURNAL_TEMPLATES.get(c, "PURCHASE_1prod / _2prod").replace(".xml", "")}
            for c in (P.CAT_TDS, P.CAT_FLEET, P.CAT_COLLECTION, P.CAT_K1, P.CAT_LICENSE,
                      P.CAT_DEALERMARGIN, P.CAT_NFR, P.CAT_INTEREST, P.CAT_PURCHASE)]
    rules = [{"phrase": p, "ledger": led} for p, led in G.CUSTOM_RULES]
    return {"ledgers": ledgers, "routes": routes, "categories": cats, "rules": rules,
            "company": company(data), "default_company": G.DEFAULT_COMPANY,
            "collections": _LAST_COLLECTIONS,
            "suggestions": sorted(set(tally_ledgers()) | set(G.template_ledgers()),
                                  key=str.lower)}


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
                               "next_tt": d.get("next_tt", 96)})
        if route == "/api/mappings":
            return self._json(mappings_view())
        if route == "/api/ledgers":
            return self._json({"n_ledgers": n_uploaded_ledgers()})
        if route == "/download/import.xml":
            return self._file(os.path.join(OUT_DIR, "IOCL_import.xml"),
                              "application/xml", "IOCL_import.xml")
        if route == "/download/purchases.xml":
            return self._file(os.path.join(OUT_DIR, "IOCL_purchases.xml"),
                              "application/xml", "IOCL_purchases.xml")
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
                    data["next_tt"] = int(body["next_tt"])
                except (TypeError, ValueError):
                    pass
            save_data(data)
            return self._json({"ok": True, "invoices_dir": folder,
                               "folder_ok": bool(folder) and os.path.isdir(folder),
                               "next_tt": data.get("next_tt", 96)})
        if route == "/api/run":
            return self._run(body, data)
        if route == "/api/ledgers":
            f = body.get("file") or {}
            try:
                names = parse_master_xml(base64.b64decode((f.get("b64") or "").split(",")[-1]))
            except Exception as exc:
                return self._json({"error": f"could not read master.xml: {exc}"}, 400)
            if not names:
                return self._json({"error": "no <LEDGER> entries found — is this a "
                                   "Tally master export?"}, 400)
            save_ledgers(names)
            return self._json({"n_ledgers": len(names), "n_total": n_uploaded_ledgers()})
        if route == "/api/mappings":
            try:
                mapping_op(body)
            except MappingError as exc:
                return self._json({"error": str(exc), **exc.extra}, 400)
            res = mappings_view()
            if _LAST_INPUT:                # regenerate so the PAD tab reflects it
                try:
                    res["run"] = generate(**_LAST_INPUT)
                except Exception as exc:
                    res["run_error"] = f"re-run failed: {exc}"
            return self._json(res)
        return self._send(404, b"not found", "text/plain")

    def _run(self, body, data):
        pad_b64 = body.get("pad_b64")
        if not pad_b64:
            return self._json({"error": "no PAD file provided"}, 400)
        invoices_dir = str(body.get("invoices_dir") or data.get("invoices_dir") or "").strip()
        if "invoices_dir" in body:
            data["invoices_dir"] = invoices_dir
        # Starting purchase (TT) number for this run — taken from the generate
        # screen, so you control it each time. Numbering is fresh from here in
        # PAD (date) order, so the same start + same invoices always reproduces
        # the same TT numbers.
        try:
            start_tt = int(body.get("next_tt", data.get("next_tt", 96)))
        except (TypeError, ValueError):
            start_tt = data.get("next_tt", 96)
        data["next_tt"] = start_tt
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
            _LAST_INPUT.clear()
            _LAST_INPUT.update(text=text, invoices_dir=invoices_dir, start_tt=start_tt)
            return self._json(generate(**_LAST_INPUT))
        except Exception as exc:
            return self._json({"error": f"run failed: {exc}"}, 500)


def generate(text: str, invoices_dir: str, start_tt: int) -> dict:
    """Process PAD text with the current mappings and write the outputs; the
    result is what the PAD tab renders."""
    data = load_data()
    apply_config(data)
    tt_state = {"next_tt": start_tt, "issued": {}}
    records, vouchers, review, summary = R.process(text, invoices_dir, tt_state=tt_state)
    R.write_outputs(OUT_DIR, vouchers, review, company(data))
    _LAST_COLLECTIONS[:] = [
        {"date": r.date.strftime("%d-%m-%Y") if r.date else "",
         "item_text": r.item_text, "amount": f"{r.amount:.2f}",
         "ledger": G.renamed(G.collection_route(r.item_text)[1])}
        for r in records if r.category == "COLLECTION"]
    missing = [{"doc_number": r["doc_number"], "date": r["date"],
                "amount": r["debit"]} for r in review
               if r["category"] == "PURCHASE" and r["status"] == "SKIPPED"]
    n_purch = summary["counts"].get("PURCHASE", 0)
    return {
        "summary": {k: summary[k] for k in (
            "opening", "n_postable", "reconciles", "first_break",
            "n_vouchers", "counts", "skipped_purchases",
            "stated_closing", "open_delivery_addon")},
        "review": review,
        "missing": missing,
        "invoices_dir": invoices_dir,
        "tt_from": start_tt if n_purch else None,
        "tt_to": start_tt + n_purch - 1 if n_purch else None,
        "next_tt": tt_state.get("next_tt", start_tt),
        "suggestions": sorted(set(tally_ledgers()) | set(G.template_ledgers()), key=str.lower),
    }


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
