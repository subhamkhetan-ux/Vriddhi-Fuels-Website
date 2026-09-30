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
LEDGERS_PATH = os.path.join(_HERE, "ledgers.json")     # ledgers from an uploaded master.xml (git-ignored)
COMMITTED_LEDGERS = os.path.join(_ROOT, "state", "tally_ledgers.json")   # shipped Tally ledger list
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
    """Effective aliases: the shipped table (state/bank_aliases.json), overlaid
    with this Mac's own (data.json "aliases"), minus any shipped alias the user
    deleted in the Mappings tab (data.json "aliases_removed")."""
    a = dict(_load_json(COMMITTED_ALIASES, {}))
    d = _load_json(DATA_PATH, {})
    a.update(d.get("aliases", {}))
    for k in d.get("aliases_removed", []):
        a.pop(k, None)
    return a


def _save_data(d: dict) -> None:
    tmp = DATA_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(d, fh, indent=2, ensure_ascii=False)
    os.replace(tmp, DATA_PATH)


def save_alias(parsed_name: str, ledger: str) -> None:
    _set_alias_key(alias_key(parsed_name), ledger)


def _set_alias_key(key: str, ledger: str) -> None:
    d = _load_json(DATA_PATH, {})
    d.setdefault("aliases", {})[key] = ledger
    # Re-adding a name the user had deleted brings it back.
    if key in d.get("aliases_removed", []):
        d["aliases_removed"] = [k for k in d["aliases_removed"] if k != key]
    _save_data(d)


# --- Mappings tab: view / add / edit / delete aliases ------------------------
#
# Edits only ever touch this Mac's git-ignored data.json. The shipped table
# (state/bank_aliases.json) is never rewritten: editing a shipped alias stores a
# local override, deleting one stores a tombstone ("aliases_removed"), and
# Restore removes both so the shipped value applies again.

def delete_alias(key: str) -> None:
    d = _load_json(DATA_PATH, {})
    d.get("aliases", {}).pop(key, None)
    if key in _load_json(COMMITTED_ALIASES, {}):
        cur = set(d.get("aliases_removed", []))
        cur.add(key)
        d["aliases_removed"] = sorted(cur)
    _save_data(d)


def restore_alias(key: str) -> None:
    """Undo local edits/deletion of a shipped alias (back to the shipped value)."""
    d = _load_json(DATA_PATH, {})
    d.get("aliases", {}).pop(key, None)
    d["aliases_removed"] = [k for k in d.get("aliases_removed", []) if k != key]
    _save_data(d)


def _known_ledger(ledger: str):
    """The exact Tally spelling of ``ledger`` if it is a known ledger (from the
    Tally ledger list, customers, or an existing alias), matched ignoring case."""
    known = list(load_ledgers()) + list(customers()) + list(load_aliases().values())
    by_low = {str(n).strip().lower(): n for n in known if n}
    return by_low.get(ledger.strip().lower())


class AliasError(ValueError):
    def __init__(self, msg, **extra):
        super().__init__(msg)
        self.extra = extra


def set_alias(name: str, ledger: str, key: str = "", old_key: str = "",
              allow_unknown: bool = False) -> str:
    """Add or change one alias; returns its key. ``name`` is a name as it
    appears in the bank narration (normalised to the alias key the classifier
    uses); ``key`` may be given instead to edit an existing entry."""
    from bank_tally import classify as C
    ledger = (ledger or "").strip()
    key = alias_key(name) if (name or "").strip() else (key or "").strip()
    if not key or len(key.replace(" ", "")) < 3:
        raise AliasError("the bank name is too short — use at least 3 letters "
                         "so it can't match unrelated narrations")
    if not ledger:
        raise AliasError("choose a Tally ledger")
    if ledger in R.BANK_LEDGERS or ledger.lower() in {b.lower() for b in R.BANK_LEDGERS}:
        raise AliasError("a name can't be mapped to one of our own bank accounts / "
                         "Cash — that would post unrelated payments as transfers. "
                         "Resolve such lines one by one in the Statements tab.")
    if key in C.FORCE_REVIEW or C._force_review(name or ""):
        raise AliasError(f"'{key}' always goes to review (its ledger changes per "
                         "transaction), so an alias for it would be ignored")
    exact = _known_ledger(ledger)
    if exact:
        ledger = exact
    elif not allow_unknown:
        raise AliasError(f"'{ledger}' is not in the Tally ledger list — check the "
                         "spelling, or upload a fresh master.xml",
                         unknown_ledger=True)
    old_key = (old_key or "").strip()
    if old_key and old_key != key:
        delete_alias(old_key)
    _set_alias_key(key, ledger)
    return key


def _seen_names() -> dict:
    """alias key -> how the loaded statements' lines under that name were
    classified (only names the alias table can steer: receipts/payments)."""
    from bank_tally import classify as C
    if not _STATEMENTS:
        return {}
    cust, aliases = customers(), load_aliases()
    out: dict = {}
    for _acct, rows in _STATEMENTS:
        for row in rows:
            cl = C.classify(row, cust, aliases)
            if cl.skip or cl.vtype == C.CONTRA or cl.tier in (
                    "self-transfer", "own-account", "cash-deposit"):
                continue
            name = cl.counterparty_raw or ""
            k = alias_key(name)
            if not k:
                continue
            e = out.setdefault(k, {"key": k, "name": name, "count": 0, "amount": 0.0,
                                   "credits": 0, "debits": 0, "ledger": None, "how": ""})
            e["count"] += 1
            e["amount"] += row.amount
            e["credits" if row.is_credit else "debits"] += 1
            if cl.counter_ledger and not e["ledger"]:
                e["ledger"], e["how"] = cl.counter_ledger, cl.tier
            elif not cl.counter_ledger and not e["how"]:
                e["how"] = cl.tier
    return out


def aliases_view() -> dict:
    """Everything the Mappings tab shows."""
    from bank_tally import classify as C
    shipped = _load_json(COMMITTED_ALIASES, {})
    d = _load_json(DATA_PATH, {})
    local = d.get("aliases", {})
    removed = set(d.get("aliases_removed", []))
    effective = load_aliases()
    tally_low = {str(n).strip().lower() for n in load_ledgers()} | \
                {str(n).strip().lower() for n in customers()}
    seen = _seen_names()
    rows = []
    for k, led in sorted(effective.items()):
        if k in local and k in shipped:
            src = "edited" if local[k] != shipped[k] else "shipped"
        else:
            src = "added" if k in local else "shipped"
        s = seen.get(k, {})
        rows.append({"key": k, "ledger": led, "source": src,
                     "shipped_ledger": shipped.get(k) if src == "edited" else None,
                     "in_tally": led.strip().lower() in tally_low,
                     "bank_ledger": led in R.BANK_LEDGERS,
                     "forced_review": k in C.FORCE_REVIEW,
                     "seen": s.get("count", 0)})
    deleted = [{"key": k, "ledger": shipped[k]} for k in sorted(removed) if k in shipped]
    names = sorted(seen.values(), key=lambda e: (e["ledger"] is not None, -e["count"], e["key"]))
    for e in names:
        e["amount"] = f"{e['amount']:.2f}"
        e["has_alias"] = e["key"] in effective
    rules = {
        "payment": [{"pattern": p, "ledger": l} for p, l in C.PAYMENT_RULES],
        "receipt": [{"pattern": p, "ledger": l} for p, l in C.RECEIPT_RULES],
        "staff": list(C.STAFF_NAMES), "salary_ledger": C.SALARY_LEDGER,
        "force_review": sorted(C.FORCE_REVIEW),
        "own_accounts": [{"account": a, "ledger": l} for a, l in C.OWN_ACCOUNTS.items()],
    }
    return {"aliases": rows, "deleted": deleted, "names": names, "rules": rules,
            "loaded": bool(_STATEMENTS), "suggestions": ledger_suggestions(),
            "n_ledgers": len(load_ledgers())}


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


def load_ledgers() -> list:
    """Every Tally ledger name: the shipped list (state/tally_ledgers.json) plus
    any the user re-uploaded locally (a fresher master.xml wins/extends it)."""
    committed = _load_json(COMMITTED_LEDGERS, [])
    local = _load_json(LEDGERS_PATH, [])
    seen, out = set(), []
    for n in (local if isinstance(local, list) else []) + \
             (committed if isinstance(committed, list) else []):
        k = str(n).strip().lower()
        if n and k not in seen:
            seen.add(k)
            out.append(n)
    return out


def _unescape(s: str) -> str:
    return (s.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")
            .replace("&quot;", '"').replace("&apos;", "'"))


def parse_master_xml(raw: bytes) -> list:
    """Pull the ledger names out of a Tally master export. Ledgers appear as
    ``<LEDGER NAME="...">`` (a Masters export) or ``<LEDGERNAME>...</LEDGERNAME>``;
    take both, unescape XML entities, drop blanks and de-dupe."""
    import re
    if raw[:2] in (b"\xff\xfe", b"\xfe\xff"):     # Tally usually exports UTF-16 with a BOM
        text = raw.decode("utf-16", errors="replace")
    else:
        text = raw.decode("utf-8", errors="replace")
    names = re.findall(r'<LEDGER\b[^>]*\bNAME="([^"]*)"', text)
    names += re.findall(r"<LEDGERNAME>([^<]*)</LEDGERNAME>", text)
    seen, out = set(), []
    for n in names:
        n = _unescape(n).strip()
        if n and n.lower() not in seen:
            seen.add(n.lower())
            out.append(n)
    return out


def save_ledgers(names: list) -> None:
    tmp = LEDGERS_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(names, fh, indent=2, ensure_ascii=False)
    os.replace(tmp, LEDGERS_PATH)


def ledger_suggestions() -> list:
    """Names to offer in the resolve dropdown: our own bank accounts + Cash (so a
    contra / unpaired transfer can be pointed at the other account), every ledger
    from the uploaded Tally master.xml, the customers, and every ledger already
    used in an alias."""
    from bank_tally import classify as C
    s = set(C.OWN_ACCOUNTS.values()) | {"Cash"}
    s |= set(load_ledgers()) | set(customers()) | set(load_aliases().values())
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
            "suggestions": ledger_suggestions(), "n_ledgers": len(load_ledgers())}


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
        if route == "/api/ledgers":
            return self._json({"n_ledgers": len(load_ledgers())})
        if route == "/api/aliases":
            return self._json(aliases_view())
        if route == "/download/aliases.json":
            body = json.dumps(dict(sorted(load_aliases().items())), indent=2,
                              ensure_ascii=False).encode("utf-8")
            return self._send(200, body, "application/json",
                              {"Content-Disposition": 'attachment; filename="bank_aliases.json"'})
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
        if route == "/api/ledgers":
            f = body.get("file") or {}
            try:
                raw = base64.b64decode((f.get("b64") or "").split(",")[-1])
                names = parse_master_xml(raw)
            except Exception as exc:
                return self._json({"error": f"could not read master.xml: {exc}"}, 400)
            if not names:
                return self._json({"error": "no <LEDGER> entries found — is this a "
                                   "Tally master export?"}, 400)
            save_ledgers(names)
            return self._json({"n_ledgers": len(names),
                               "suggestions": ledger_suggestions()})
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
                # a payee (force-review like ODISHA SARKAR, self-transfers), and
                # NEVER alias a name to one of our own bank ledgers — that maps a
                # payee to a bank and posts unrelated payments as phantom transfers
                # (this is per-transaction only; the resolution above handles it).
                if (name and tier not in ("force-review", "self-transfer")
                        and ledger not in R.BANK_LEDGERS):
                    save_alias(name, ledger)
            return self._json(_process_and_write())
        if route == "/api/drop":
            key = (body.get("key") or "").strip()
            if key:
                toggle_dropped(key, bool(body.get("drop", True)))
            return self._json(_process_and_write())
        if route == "/api/rerun":
            return self._json(_process_and_write())
        if route == "/api/aliases":
            return self._alias_op(body)
        return self._send(404, b"not found", "text/plain")

    def _alias_op(self, body):
        op = body.get("op") or "set"
        key = (body.get("key") or "").strip()
        try:
            if op == "set":
                key = set_alias(body.get("name") or "", body.get("ledger") or "",
                                key=key, old_key=body.get("old_key") or "",
                                allow_unknown=bool(body.get("allow_unknown")))
            elif op == "delete" and key:
                delete_alias(key)
            elif op == "restore" and key:
                restore_alias(key)
            else:
                return self._json({"error": "unknown alias operation"}, 400)
        except AliasError as exc:
            return self._json({"error": str(exc), **exc.extra}, 400)
        res = aliases_view()
        res["key"] = key
        # Statements already loaded? Re-run them so the Statements tab (review,
        # entries, bank_import.xml) reflects the change straight away.
        if _STATEMENTS:
            res["run"] = _process_and_write()
        return self._json(res)

    def _run(self, body):
        global _STATEMENTS
        files = body.get("files") or []
        stmts, problems = [], []
        for f in files:
            name = f.get("name", "file")
            path = None
            try:
                raw = base64.b64decode((f.get("b64") or "").split(",")[-1])
                suffix = ".xlsx" if name.lower().endswith("x") else ".xls"
                with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tf:
                    tf.write(raw)
                    path = tf.name
                ledger = S.detect_account(path)
                rows, summ = S.parse_excel(path)
                if not ledger:
                    problems.append(f"{name}: could not detect the account number")
                    continue
                if not rows:
                    problems.append(f"{name}: no transactions found ({summ.get('error','')})")
                    continue
                stmts.append((ledger, rows))
            except ModuleNotFoundError as exc:
                # HDFC statements are legacy .xls and need xlrd; a fresh Mac may not
                # have it. Say exactly how to fix it rather than a bare traceback.
                mod = exc.name or "a required package"
                problems.append(
                    f"{name}: cannot read this file — the Python package '{mod}' is "
                    f"not installed on this Mac. Stop the app, run "
                    f"'python3 -m pip install --user {mod}' in Terminal, then restart it.")
            except Exception as exc:
                problems.append(f"{name}: {exc}")
            finally:
                if path and os.path.exists(path):
                    os.unlink(path)
        if not stmts:
            return self._json({"error": " | ".join(problems) or "no usable statements",
                               "problems": problems}, 400)
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
