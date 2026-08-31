"""Pure, browser-free helpers for the XtraPower CCMS monitor.

Everything here is deterministic and unit-tested. The Playwright glue in
``browser.py`` scrapes the page into plain Python (a table's header texts and
row-cell texts, or the raw page text) and hands it to these functions, so the
tricky logic — finding the CCMS column, normalising rupee strings, deciding
whether a value actually changed — is testable without a real browser.
"""

from __future__ import annotations

import re
from typing import Optional

# ``₹1,00,000.00`` / ``Rs. 39.31`` / ``100000`` → a comparable float.
_AMOUNT_RE = re.compile(r"-?\d[\d,]*(?:\.\d+)?")


def normalize_amount(text: Optional[str]) -> Optional[float]:
    """Parse a rupee string into a float, or ``None`` if there's no number.

    Handles ``₹``/``Rs.`` prefixes, Indian and Western digit grouping
    (``1,00,000`` and ``100,000`` both parse to 100000.0), and stray
    whitespace. Commas are grouping separators only, so they're stripped.
    """
    if text is None:
        return None
    m = _AMOUNT_RE.search(text)
    if not m:
        return None
    try:
        return float(m.group(0).replace(",", ""))
    except ValueError:
        return None


def _norm_header(text: str) -> str:
    return re.sub(r"[^a-z0-9]", "", text.lower())


def find_ccms(headers: list[str], rows: list[list[str]]) -> Optional[str]:
    """Return the raw CCMS cell text from a results table, or ``None``.

    ``headers`` are the column titles; ``rows`` are the data rows (each a list
    of cell strings aligned to ``headers``). The CCMS column is matched
    loosely (case/spacing/punctuation-insensitive) so minor header wording
    changes on the portal don't break the read. The first data row whose CCMS
    cell holds a number wins.
    """
    col = None
    for i, h in enumerate(headers):
        if "ccms" in _norm_header(h):
            col = i
            break
    if col is None:
        return None
    for row in rows:
        if col < len(row):
            cell = (row[col] or "").strip()
            if normalize_amount(cell) is not None:
                return cell
    return None


def ccms_changed(old: Optional[str], new: Optional[str]) -> bool:
    """True when the CCMS value meaningfully changed.

    Compared numerically so cosmetic reformatting (``₹100000`` vs
    ``₹1,00,000.00``) doesn't fire a false alert. A first-ever reading
    (``old is None``) is a baseline, not a change.
    """
    if new is None:
        return False
    if old is None:
        return False
    a, b = normalize_amount(old), normalize_amount(new)
    if a is None or b is None:
        return old.strip() != new.strip()
    return a != b


def change_direction(old: Optional[str], new: Optional[str]) -> str:
    """``"credited"`` / ``"debited"`` / ``"changed"`` for the alert wording."""
    a, b = normalize_amount(old), normalize_amount(new)
    if a is None or b is None:
        return "changed"
    if b > a:
        return "credited"
    if b < a:
        return "debited"
    return "changed"


# Text that, when present on the portal page, means the session is gone and a
# manual re-login is needed. Matched case-insensitively against page text/URL.
_LOGGED_OUT_MARKERS = (
    "session expired",
    "session has expired",
    "session timeout",
    "your session has timed out",
    "please login again",
    "please log in again",
    "sign in to continue",
    "invalid session",
    "logged out",
)

# The F5 BIG-IP WAF rejection page (see project report §4).
_WAF_MARKERS = (
    "the requested url was rejected",
    "please consult with your administrator",
    "support id is",
)


def detect_logout(page_text: str, url: str) -> bool:
    """True when the page looks like a login / expired-session screen."""
    blob = f"{page_text}\n{url}".lower()
    if any(m in blob for m in _LOGGED_OUT_MARKERS):
        return True
    # A bare login URL with a username/password prompt also counts.
    if "login" in url.lower() and ("password" in blob or "customer id" in blob):
        return True
    return False


def detect_waf_block(page_text: str) -> bool:
    """True when the F5 firewall rejected the request (IP-based block)."""
    blob = page_text.lower()
    return sum(m in blob for m in _WAF_MARKERS) >= 2
