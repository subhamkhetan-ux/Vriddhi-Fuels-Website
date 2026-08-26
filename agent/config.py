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
    # This mailbox also gets debit alerts and alerts for a second HDFC account
    # (ending 2542). We want ONLY credit alerts for the account ending 1010.
    # Match on the alert's own distinctive wording (robust to the sender
    # address); the accept/reject gate below enforces "credit + account 1010".
    gmail_query='"received a credit in your HDFC Bank account"',
    # Only ours if it's a credit AND names account 1010; drop anything that
    # names the 2542 account or reads as a debit.
    accept_if_all=[
        r"received a credit",
        r"X{0,4}1010\b",
    ],
    reject_if_any=[
        r"X{0,4}2542\b",
        r"\bdebit",
        r"has been debited",
    ],
    amount_patterns=[
        # "Amount received: INR 41,97,180.00"
        r"Amount received:\s*(?:INR|Rs\.?)?\s*([\d,]+(?:\.\d{1,2})?)",
        r"(?:INR|Rs\.?)\s*([\d,]+(?:\.\d{1,2})?)",
    ],
    date_patterns=[
        # "Date: 25-AUG-2026"
        r"Date:\s*(\d{1,2}[-/][A-Za-z]{3}[-/]\d{2,4})",
        r"\bon\s+(\d{1,2}[-/][A-Za-z0-9]{2,4}[-/]\d{2,4})",
    ],
    payer_patterns=[
        # "Reference Details: RTGS Cr-<IFSC>-<REMITTER>-<BENEFICIARY>-<UTR>"
        # capture the remitter (3rd hyphen field): "DBL SIARMAL COAL MINES..."
        r"Reference Details:\s*(?:RTGS|NEFT|IMPS)\s+Cr-[^-]*-([^-]+?)-",
        # generic fallback: "...Cr-<IFSC>-<REMITTER>-"
        r"\bCr-[^-]*-([^-]+?)-",
    ],
    # Column D / remarks is a fixed tag for this account, not the payment rail.
    rail_pattern=None,
    default_rail="1010",   # -> mode "HDFC 1010"
)

# ---- Bank 2: ICICI ---------------------------------------------------------
ICICI = ParserProfile(
    bank="ICICI",
    # Match the alert's own wording (robust to the sender address). Ezy QR
    # auto-credits also match this; the reject gate below drops them.
    gmail_query='"has been credited with"',
    # Credit alerts only. Ignore debit alerts and the daily "Ezy QR" auto-credits
    # (small QR-collection FT credits with no real remitter name).
    accept_if_all=[r"has been credited"],
    reject_if_any=[r"EZY ?QR", r"has been debited", r"\bdebited\b"],
    amount_patterns=[
        # "...has been credited with Rs. 34,79,017.00 on..."
        r"credited with\s*(?:Rs\.?|INR)\s*([\d,]+(?:\.\d{1,2})?)",
        r"(?:Rs\.?|INR)\s*([\d,]+(?:\.\d{1,2})?)",
    ],
    date_patterns=[
        # "on 06-Aug-26"
        r"\bon\s+(\d{1,2}[-/][A-Za-z]{3,4}[-/]\d{2,4})",
        r"\bon\s+(\d{1,2}[-/]\d{1,2}[-/]\d{2,4})",
    ],
    payer_patterns=[
        # "Info: RTGS-<UTR>-<REMITTER>" -> remitter is the last field
        r"Info[:\s]+(?:RTGS|NEFT|IMPS)-[^-]*-([^-.\n]+)",
        # "Info: UPI/<rrn>/<purpose>/<NAME>/"
        r"Info[:\s]+UPI/[^/]*/[^/]*/([^/\n]+)",
        r"\bfrom\s+([A-Z][A-Za-z0-9&./ ]{2,}?)(?=\s+(?:Ref|UTR|on|Info|\(|\.|$))",
    ],
    # Column D / remarks is a fixed tag for this account.
    rail_pattern=None,
    default_rail="BANK LTD",   # -> mode "ICICI BANK LTD"
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
