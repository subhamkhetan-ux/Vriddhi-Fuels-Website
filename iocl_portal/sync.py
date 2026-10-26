"""Insert a verified PAD observation into the existing Payments balance table."""
from __future__ import annotations

from datetime import date, datetime, time
from decimal import Decimal, InvalidOperation
import json
import os
from pathlib import Path
import re
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from .statement import Balance, IST, PortalError, other_deductions

ROOT = Path(__file__).resolve().parents[1]
OPENING_WINDOW = (time(0, 30), time(2))   # IST: a reading in it is the day's opening


class OpeningMissed(PortalError):
    """The opening run came too late for its reading to be the opening."""


def in_opening_window(at: datetime) -> bool:
    return OPENING_WINDOW[0] <= at.astimezone(IST).time() < OPENING_WINDOW[1]


def opening_saved(day: date, *, config=None, transport=None) -> bool:
    """Has this IST day's opening been saved (by an earlier try, or by hand)?"""
    url, key = config or payments_config()
    query = urlencode({"day": "eq." + day.isoformat(), "select": "day", "limit": "1"})
    rows = _records((transport or request)("GET", url, key, "pay_credit_opening?" + query))
    return bool(rows) and rows[0].get("day") == day.isoformat()


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def payments_config() -> tuple[str, str]:
    url, key = os.environ.get("SUPABASE_URL"), os.environ.get("SUPABASE_KEY")
    if bool(url) != bool(key):
        raise PortalError("Set both SUPABASE_URL and SUPABASE_KEY, or leave both empty to use Payments' public configuration.")
    if not url:
        # Same public connection as the app; never request a service-role key.
        config = (ROOT / "payments/config.js").read_text(encoding="utf-8")
        def field(name):
            match = re.search(r"\b" + name + r"\s*:\s*[\"']([^\"']+)", config)
            return match[1] if match else ""
        url, key = field("SUPABASE_URL"), field("SUPABASE_ANON_KEY")
    parsed = urlsplit(url or "")
    if (parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password
            or parsed.query or parsed.fragment or parsed.path not in ("", "/") or not key or "PASTE" in key):
        raise PortalError("The Payments Supabase connection is missing or invalid.")
    return url.rstrip("/"), key


def request(method: str, url: str, key: str, path: str, body=None):
    headers = {"apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json"}
    if method == "POST":
        headers["Prefer"] = "resolution=ignore-duplicates,return=representation"
    data = json.dumps(body).encode() if body is not None else None
    req = Request(f"{url}/rest/v1/{path}", data=data, headers=headers, method=method)
    try:
        with build_opener(NoRedirect).open(req, timeout=30) as response:
            payload = response.read(100_001)
        if len(payload) > 100_000:
            raise PortalError("Payments returned an unexpectedly large response.")
        return json.loads(payload) if payload else None
    except HTTPError as exc:
        raise PortalError(f"Payments rejected the {method} request (HTTP {exc.code}). Check its schema and access settings.") from None
    except (URLError, OSError, ValueError):
        raise PortalError("Payments is unreachable or returned invalid data. The job did not confirm a saved balance.") from None


def _records(value) -> list:
    if not isinstance(value, list) or len(value) > 1 or any(not isinstance(row, dict) for row in value):
        raise PortalError("Payments returned an invalid balance record. Nothing further was saved.")
    return value


def _amount_sign(row: dict) -> tuple[Decimal, str]:
    try:
        amount, sign = Decimal(str(row["amount"])), row["sign"]
        if not amount.is_finite() or amount < 0 or sign not in ("DR", "CR"):
            raise ValueError
        return amount, sign
    except (KeyError, ValueError, TypeError, InvalidOperation):
        raise PortalError("A saved Payments balance is invalid. Check it before syncing.") from None


def _timestamp(raw: str) -> datetime:
    try:
        at = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        if at.tzinfo is None:
            raise ValueError
        return at
    except (ValueError, TypeError, AttributeError):
        raise PortalError("A saved Payments balance has an invalid timestamp.") from None


def latest_balance(balance: Balance, *, config, transport=request):
    """Match the Credit tab: latest snapshot or day-start opening wins."""
    url, key = config
    snapshots = _records(transport("GET", url, key,
        "pay_credit_balances?select=id,amount,sign,at&order=at.desc,created_at.desc&limit=1"))
    query = urlencode({"day": "lte." + balance.to_date.isoformat(),
                       "select": "day,amount,sign", "order": "day.desc", "limit": "1"})
    openings = _records(transport("GET", url, key, "pay_credit_opening?" + query))
    best, at = None, None
    if snapshots:
        best = _amount_sign(snapshots[0])
        at = _timestamp(snapshots[0].get("at"))
    if openings:
        try:
            day = datetime.strptime(openings[0]["day"], "%Y-%m-%d").date()
        except (KeyError, ValueError, TypeError):
            raise PortalError("A saved opening balance has an invalid date.") from None
        opening_at = datetime.combine(day, time(), tzinfo=IST)
        if at is None or opening_at > at:
            best, at = _amount_sign(openings[0]), opening_at
    if at is not None and at > balance.generated_at:
        raise PortalError("Payments already has a newer observation. The older portal balance was not saved.")
    return best


def save_balance(balance: Balance, *, config=None, transport=request) -> str:
    """Save only when the amount or DR/CR sign changes, including first use."""
    url, key = config or payments_config()
    if latest_balance(balance, config=(url, key), transport=transport) == (balance.amount, balance.sign):
        return "unchanged"
    row = balance.row()
    inserted = transport("POST", url, key, "pay_credit_balances?on_conflict=id", [row])
    # A successful HTTP status is not enough: verify this exact observation.
    query = urlencode({"id": "eq." + row["id"], "select": "id,amount,sign,at", "limit": "1"})
    check = transport("GET", url, key, "pay_credit_balances?" + query)
    try:
        valid = (isinstance(check, list) and len(check) == 1 and check[0]["id"] == row["id"]
                 and Decimal(str(check[0]["amount"])) == balance.amount
                 and check[0]["sign"] == balance.sign
                 and datetime.fromisoformat(check[0]["at"].replace("Z", "+00:00")) == balance.generated_at)
    except (KeyError, TypeError, ValueError, InvalidOperation):
        valid = False
    if not valid:
        raise PortalError("Payments did not return the matching balance after the write. Check the app before retrying.")
    return "saved" if inserted else "already_saved"


def _rows(value, limit=200) -> list:
    if not isinstance(value, list) or len(value) > limit or any(not isinstance(row, dict) for row in value):
        raise PortalError("Payments returned an invalid list. No deduction was saved.")
    return value


def save_deductions(balance: Balance, *, config=None, transport=request) -> int:
    """Mark the statement's non-invoice debits (licence fee, interest...) as
    Other Deductions, the reason from Item Text. -> how many were added.

    The Credit tab can't see these itself: it compares balances with invoices,
    and a payment credited the same day hides any smaller deduction. Skips
    debits whose document number is a known invoice, ones already marked, and
    ones already confirmed by hand (same day and amount)."""
    candidates = other_deductions(balance)
    if not candidates:
        return 0
    url, key = config or payments_config()
    docs = sorted({m[1] for d in balance.debits if (m := re.match(r"\s*(\d{6,20})", d.text))})
    if docs:
        query = urlencode({"invoice_no": "in.(" + ",".join(docs) + ")", "select": "invoice_no"})
        known = {str(r.get("invoice_no")) for r in _rows(transport("GET", url, key, "pay_fuel_invoices?" + query))}
        candidates = other_deductions(balance, frozenset(known))
        if not candidates:
            return 0
    since = datetime.combine(balance.from_date, time(), tzinfo=IST).isoformat()
    query = urlencode({"at": "gte." + since, "select": "id,at,amount", "order": "at.asc"})
    existing = _rows(transport("GET", url, key, "pay_other_deductions?" + query))
    ids = {r.get("id") for r in existing}
    manual = []                                  # (IST day, amount) confirmed in the app
    for r in existing:
        if str(r.get("id", "")).startswith("iocl-ded-"):
            continue
        try:
            manual.append((_timestamp(r.get("at")).astimezone(IST).date().isoformat(), Decimal(str(r["amount"]))))
        except (KeyError, InvalidOperation):
            raise PortalError("A saved Other Deduction is invalid. Check it in the Credit tab.") from None
    new = []
    for row in candidates:
        if row["id"] in ids:
            continue
        hand = (row["at"][:10], Decimal(row["amount"]))
        if hand in manual:
            manual.remove(hand)                  # one confirmation covers one debit
            continue
        new.append(row)
    if not new:
        return 0
    transport("POST", url, key, "pay_other_deductions?on_conflict=id", new)
    query = urlencode({"id": "in.(" + ",".join(r["id"] for r in new) + ")", "select": "id,amount"})
    check = {r.get("id"): r.get("amount") for r in _rows(transport("GET", url, key, "pay_other_deductions?" + query))}
    try:
        if any(Decimal(str(check[r["id"]])) != Decimal(r["amount"]) for r in new):
            raise KeyError
    except (KeyError, InvalidOperation):
        raise PortalError("Payments did not return the Other Deductions after the write. Check the Credit tab.") from None
    return len(new)


def save_opening(balance: Balance, *, config=None, transport=request) -> str:
    """Record one opening per IST day, even when the balance has not changed.

    The opening is the statement's own (``Balance.opening``: the balance after
    the last entry before today, proved by its running balance), whenever the
    report is read. Without it, only a reading in 00:30–02:00 IST is the
    opening: a delayed job must not label an intraday balance as the opening.
    Existing openings (including manual corrections) survive reruns.
    """
    observed = balance.generated_at.astimezone(IST)
    if balance.opening is not None:
        amount, sign = abs(balance.opening), "CR" if balance.opening < 0 else "DR"
    elif in_opening_window(observed):
        amount, sign = balance.amount, balance.sign
    else:
        raise OpeningMissed("The opening capture is outside 00:30–02:00 IST and the statement couldn't give it ("
                            + (balance.opening_why or "no reason") + "). No opening was saved; enter it manually "
                            "if it isn't in Payments.")
    url, key = config or payments_config()
    day = observed.date().isoformat()
    query = urlencode({"day": "eq." + day, "select": "day,amount,sign,updated_at", "limit": "1"})
    path = "pay_credit_opening?" + query
    existing = _records(transport("GET", url, key, path))
    if existing:
        if existing[0].get("day") != day:
            raise PortalError("Payments returned an opening for the wrong date.")
        _amount_sign(existing[0])
        return "opening_exists"
    row = {"day": day, "amount": f"{amount:.2f}", "sign": sign, "updated_at": observed.isoformat()}
    inserted = transport("POST", url, key, "pay_credit_opening?on_conflict=day", [row])
    check = _records(transport("GET", url, key, path))
    if not check or check[0].get("day") != day:
        raise PortalError("The day's opening could not be verified in Payments.")
    actual = _amount_sign(check[0])
    # A concurrent manual opening wins an insert-if-absent race; preserve it.
    if not inserted:
        return "opening_exists"
    if actual != (amount, sign) or _timestamp(check[0].get("updated_at")) != observed:
        raise PortalError("Payments returned a different opening after the write. Check the Credit tab.")
    return "opening_saved"
