"""Bank credit-alert parser engine.

The *patterns* live in :mod:`agent.config` (one clearly-marked config block per
bank, so a format change is a one-line edit — spec §4). This module is the
tolerant engine that runs a profile's patterns against an email:

- amount  -> plain float (currency symbols and separators stripped)
- date    -> Excel serial via :func:`agent.serial.to_serial`
- payer   -> the remitter string as the bank wrote it (messy; fed to the matcher)
- bank    -> constant per profile
- mode    -> "<BANK> <RAIL>", e.g. "HDFC NEFT" (column D)

Bank HTML is brittle, so profiles are anchored on the stable text labels banks
use ("credited", "by", "from", "INR"/"Rs."). A parse failure never drops the
alert — the caller queues a ``review`` row carrying the raw text.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from .serial import to_serial

_MONTHS = {
    "jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6,
    "jul": 7, "aug": 8, "sep": 9, "sept": 9, "oct": 10, "nov": 11, "dec": 12,
}


@dataclass
class ParserProfile:
    """One bank's parsing config. Patterns are tried in order; first hit wins.

    Each regex should expose the value in group 1 (or a named group where noted).
    """

    bank: str                                   # column-D prefix + `bank` field
    gmail_query: str                            # Gmail search selecting its alerts
    amount_patterns: list[str]
    date_patterns: list[str]
    payer_patterns: list[str]
    rail_pattern: str | None = None             # extracts NEFT/RTGS/IMPS/UPI...
    default_rail: str = ""                      # used when rail_pattern misses
    flags: int = field(default=re.IGNORECASE)


@dataclass
class ParseResult:
    ok: bool
    bank: str
    date_str: str | None = None
    date_serial: int | None = None
    amount: float | None = None
    raw_payer: str | None = None
    mode: str = ""
    error: str | None = None
    raw_text: str | None = None


def _first_group(patterns: list[str], text: str, flags: int) -> str | None:
    for pat in patterns:
        m = re.search(pat, text, flags)
        if m:
            return (m.group(1) if m.groups() else m.group(0)).strip()
    return None


def parse_amount(raw: str) -> float | None:
    """'Rs. 1,25,000.00' / 'INR 5000' -> 125000.0 / 5000.0."""
    if raw is None:
        return None
    s = re.sub(r"[^\d.]", "", str(raw))
    if s.count(".") > 1:  # stray dots from grouping; keep the last as decimal
        head, _, tail = s.rpartition(".")
        s = head.replace(".", "") + "." + tail
    try:
        return float(s)
    except ValueError:
        return None


def normalize_date(raw: str) -> str | None:
    """Coerce a bank date to ``dd/mm/yyyy``. Handles ``15-06-2025``,
    ``15/06/25``, ``15-Jun-2025``, ``15 Jun 2025``."""
    if not raw:
        return None
    s = raw.strip()
    # numeric dd[-/.]mm[-/.]yy(yy)
    m = re.match(r"(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})", s)
    if m:
        d, mo, y = m.groups()
        return f"{int(d):02d}/{int(mo):02d}/{y}"
    # dd[- ]Mon[- ]yyyy
    m = re.match(r"(\d{1,2})[-/ ]([A-Za-z]{3,4})[-/ ](\d{2,4})", s)
    if m:
        d, mon, y = m.groups()
        mo = _MONTHS.get(mon[:3].lower())
        if mo:
            return f"{int(d):02d}/{mo:02d}/{y}"
    return None


def parse(profile: ParserProfile, subject: str, body: str) -> ParseResult:
    """Parse one alert. Never raises on bad content — returns ``ok=False`` with
    the raw text so the caller can queue a debuggable ``review`` row."""
    text = f"{subject or ''}\n{body or ''}"

    amount = parse_amount(_first_group(profile.amount_patterns, text, profile.flags))
    date_str = normalize_date(_first_group(profile.date_patterns, text, profile.flags) or "")
    payer = _first_group(profile.payer_patterns, text, profile.flags)

    serial = None
    if date_str:
        serial, ok = to_serial(date_str)
        if not ok:
            serial = None

    rail = profile.default_rail
    if profile.rail_pattern:
        m = re.search(profile.rail_pattern, text, profile.flags)
        if m:
            rail = (m.group(1) if m.groups() else m.group(0)).upper()
    mode = f"{profile.bank} {rail}".strip()

    missing = []
    if amount is None:
        missing.append("amount")
    if serial is None:
        missing.append("date")
    if not payer:
        missing.append("payer")

    if missing:
        return ParseResult(
            ok=False,
            bank=profile.bank,
            date_str=date_str,
            date_serial=serial,
            amount=amount,
            raw_payer=payer,
            mode=mode,
            error=f"could not extract: {', '.join(missing)}",
            raw_text=text[:4000],
        )

    return ParseResult(
        ok=True,
        bank=profile.bank,
        date_str=date_str,
        date_serial=serial,
        amount=amount,
        raw_payer=payer,
        mode=mode,
    )
