"""Agent configuration — the one place to edit when things change.

Two Gmail accounts, one bank each, so a profile is selected purely by which
mailbox the email came from (``ACCOUNTS`` below) — no format-sniffing.

===================  EDIT-HERE: bank parser profiles  =======================
The regexes below are anchored on the stable labels each bank uses. They are a
tolerant *starting point* — VERIFY THEM against two or three real alert emails
from each bank and adjust the one relevant line. A parse miss never drops an
alert; it queues a ``review`` row with the raw text (saved to the run artifact),
so tuning is low-risk and iterative.
=============================================================================
"""

from __future__ import annotations

import os

from .parser import ParserProfile

# Read-only Gmail scope — the agent never sends or modifies mail (spec §7).
GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"]

# How far back to look on a cold start (no high-water mark yet), in days.
LOOKBACK_DAYS = int(os.environ.get("AGENT_LOOKBACK_DAYS", "7"))


# ---- Bank 1: HDFC ----------------------------------------------------------
HDFC = ParserProfile(
    bank="HDFC",
    # Narrow the mailbox to genuine credit alerts. Tune the from:/subject: to
    # the exact sender address your HDFC account receives.
    gmail_query='from:(alerts@hdfcbank.net OR alerts@hdfcbank.com) '
                '(subject:credited OR subject:credit OR "has been credited")',
    amount_patterns=[
        r"(?:Rs\.?|INR)\s*([\d,]+(?:\.\d{1,2})?)",
        r"credited (?:with|by)\s*(?:Rs\.?|INR)?\s*([\d,]+(?:\.\d{1,2})?)",
    ],
    date_patterns=[
        r"\bon\s+(\d{1,2}[-/][A-Za-z0-9]{2,4}[-/]\d{2,4})",
        r"value date[:\s]+(\d{1,2}[-/][A-Za-z0-9]{2,4}[-/]\d{2,4})",
        r"(\d{1,2}[-/]\d{1,2}[-/]\d{2,4})",
    ],
    payer_patterns=[
        # "...by M/S SUDARSHAN MINERALS AND LOG" / "from <NAME>"
        r"\b(?:by|from)\s+(M/S[ ][A-Za-z0-9&./ ]+?)(?=\s+(?:Ref|UTR|on|towards|Info|\(|\.|$))",
        r"\b(?:by|from)\s+([A-Z][A-Za-z0-9&./ ]{2,}?)(?=\s+(?:Ref|UTR|on|towards|Info|\(|\.|$))",
        # "Info: NEFT-<ref>-<NAME>"
        r"Info[:\s]+[A-Z]+-[^-]*-\s*([^.\n]+)",
    ],
    rail_pattern=r"\b(NEFT|RTGS|IMPS|UPI)\b",
    default_rail="",
)

# ---- Bank 2: ICICI ---------------------------------------------------------
ICICI = ParserProfile(
    bank="ICICI",
    gmail_query='from:(alerts@icicibank.com OR credit_alert@icicibank.com) '
                '(subject:credited OR "has been credited")',
    amount_patterns=[
        r"credited with\s*(?:Rs\.?|INR)\s*([\d,]+(?:\.\d{1,2})?)",
        r"(?:Rs\.?|INR)\s*([\d,]+(?:\.\d{1,2})?)",
    ],
    date_patterns=[
        r"\bon\s+(\d{1,2}[-/][A-Za-z]{3,4}[-/]\d{2,4})",
        r"\bon\s+(\d{1,2}[-/]\d{1,2}[-/]\d{2,4})",
    ],
    payer_patterns=[
        # "Info: UPI/<rrn>/<purpose>/<NAME>/"
        r"Info[:\s]+UPI/[^/]*/[^/]*/([^/\n]+)",
        r"\bfrom\s+([A-Z][A-Za-z0-9&./ ]{2,}?)(?=\s+(?:Ref|UTR|on|Info|\(|\.|$))",
        r"Info[:\s]+[A-Z]+[/-][^/-]*[/-]\s*([^./\n]+)",
    ],
    rail_pattern=r"\b(NEFT|RTGS|IMPS|UPI)\b",
    default_rail="",
)


# ---- Account -> profile + secret env var mapping ---------------------------
# ``token_env`` names the GitHub secret (a Gmail OAuth refresh-token JSON blob)
# that authenticates that mailbox. See §7 of the build spec.
ACCOUNTS = [
    # Account 1's mailbox receives ICICI alerts; account 2's receives HDFC.
    {"id": "bank1", "profile": ICICI, "token_env": "GMAIL_TOKEN_BANK1"},
    {"id": "bank2", "profile": HDFC, "token_env": "GMAIL_TOKEN_BANK2"},
]

# Telegram failure-alert secrets (reused from the IOCL monitor).
TELEGRAM_TOKEN_ENV = "TELEGRAM_TOKEN"
TELEGRAM_CHAT_ENV = "TELEGRAM_CHAT"
