"""Classify a bank row into a Tally voucher type + counter ledger.

Each statement line becomes a Receipt (money in), a Payment (money out), or a
Contra (a transfer between the firm's own accounts). The counter ledger is then:

* Contra  -> the other own account (detected from an own account number in the
  narration).
* Receipt -> the remitter, resolved to a customer ledger by the proven payments
  matcher (with learned aliases); unresolved names go to review.
* Payment -> a small keyword rule table (IOCL, EMI, salary, tax, card, …); the
  rest go to review.

The narration is the only signal and its shape is bank-specific; the parsing
here targets the HDFC layout (NEFT/RTGS/IMPS/UPI, IB FUNDS TRANSFER, A2AOWN),
and is easy to extend per bank.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

# Voucher types.
RECEIPT, PAYMENT, CONTRA = "Receipt", "Payment", "Contra"

# The firm's own bank accounts -> their Tally ledger. A transfer naming one of
# these (other than the statement's own account) is a Contra to it.
OWN_ACCOUNTS = {
    "50200110712542": "HDFC BANK OD A/C - 50200110712542",
    "59217010101010": "HDFC BANK C/A - 59217010101010",
    "046805004716": "ICICI BANK LTD",
}

# Payment narration keyword -> counter ledger (extend as needed).
PAYMENT_RULES = [
    # IOCL payments are handled by the skip rule above (owned by the PAD tool).
    (r"\bCBDT\b|TAX PAYMENT|INCOME TAX", "TDS PAID 194Q 2026-27"),
    (r"\bSALARY\b", "Salary"),
    (r"INTEREST DEBITED|INTEREST CHARGED", "Interest Paid"),
    (r"TOYOTA", "INNOVA EMI"),
    (r"CREDIT CARD|CC PAYMENT|CARD 7311", "HDFC Corporate Credit Card 7311"),
    (r"ELECTRICITY|TPSODL|TPCODL|WESCO", "Electricity Charges Payble"),
]
# Receipt narration keyword -> counter ledger (non-customer credits). Only
# ledgers that exist in the company's masters; anything else goes to review.
RECEIPT_RULES = [
    (r"PINE LABS", "Pine Labs Nodal Account"),
    (r"\bEZY ?PAY\b|EZYPAY|EAZYPAY|EZY QR|FT-EZY", "EzyPay UPI ICICI"),
]
_OWN_NAME = re.compile(r"VRID?DHI\s*FUELS?", re.I)   # our own name (beneficiary)
_SELF = re.compile(r"VRID?DHI", re.I)                # any "Vriddhi…" = us (self-transfer)

# Source-bank IFSC prefix -> our ledger, for a self-transfer where only the name
# (not the account number) appears in the narration. HDFC is ambiguous between
# our two HDFC accounts, so those are resolved by pairing across statements.
_IFSC_TO_OWN = {"ICIC": "ICICI BANK LTD"}

# Staff — any bank payment to one of these posts to the single Salary ledger.
# Bank narrations truncate the name (e.g. "NarendraPr" for Narendra Kumar
# Pradhan), so we match on first+last name as a prefix. Edit this list as staff
# change.
STAFF_NAMES = [
    "NARENDRA KUMAR PRADHAN", "BIKRAM SAHU", "CHIKUN DEHURY", "CHANDAN SAHU",
    "BIKASH BEHERA", "PRABINA SETHI", "JITU MAHAKUL", "GOKULA BHOKTA",
    "LALINDRA SETH", "NIRANJAN NAIK", "BABUNI SETHY", "LALIT KUMBHAR",
    "BHARATI RAY", "KUNA MAHAKUL",
]
SALARY_LEDGER = "Salary"


def _staff_key(full: str) -> str:
    words = re.findall(r"[A-Za-z]+", full.upper())
    if not words:
        return ""
    return words[0] + (words[-1] if len(words) > 1 else "")   # first+last, no spaces


_STAFF_KEYS = [k for k in (_staff_key(s) for s in STAFF_NAMES) if k]


def is_staff(name: str) -> bool:
    """True if a parsed payee is one of the staff (prefix match, since the bank
    truncates the name)."""
    key = re.sub(r"[^A-Z]", "", name.upper())
    if len(key) < 6:
        return False
    return any(sk.startswith(key) or key.startswith(sk) for sk in _STAFF_KEYS)


@dataclass
class Classification:
    vtype: str
    counter_ledger: str | None      # None => needs review
    counterparty_raw: str           # what we parsed from the narration
    tier: str                       # how we decided (own/rule/alias/exact/…)
    candidates: list[str]           # for a review dropdown
    skip: bool = False              # already recorded elsewhere (IOCL PAD) — don't post
    skip_reason: str = ""


def _own_account_in(narration: str, exclude: str | None) -> str | None:
    for acct, ledger in OWN_ACCOUNTS.items():
        if acct == exclude:
            continue
        if acct in narration:
            return ledger
    return None


_BANK_TAG = re.compile(r"^[A-Z]{4}(\d{5,}|0[A-Z0-9]{6})?$")   # UTIB / ICIC0SF0002
_MASKED = re.compile(r"X{4,}")


def _stop_field(f: str) -> bool:
    """True if a hyphen field marks the end of the remitter name (a bank tag,
    an IFSC, a masked account, a long reference number, or our own name)."""
    if _OWN_NAME.search(f):
        return True
    if _BANK_TAG.match(f):
        return True
    if _MASKED.search(f.upper()):
        return True
    if re.fullmatch(r"\d{6,}", f):
        return True
    return False


def extract_remitter(narration: str) -> str:
    """Pull the remitter/counterparty name out of a narration.

    Handles the HDFC ``-``-separated forms (``NEFT CR-<IFSC>-<NAME>-…``,
    ``IMPS-<ref>-<NAME>-<bank>-…``, ``UPI-<NAME>-…``) and the ICICI ``/``-separated
    forms (``INF/NEFT/<UTR>/<IFSC>/<NAME>``, ``MMT/IMPS/<ref>/<x>/<NAME>/<IFSC>``).
    """
    n = narration.strip()
    up = n.upper()
    # Card bill payment (masked card number) — not a party name.
    if re.search(r"BILLPAY|CC PAYMENT|CARD", up) and _MASKED.search(up):
        return "Card bill payment"
    # ICICI CMS collections: "CMS/ <ref>/<NAME>" — the payer name is the last field.
    if up.startswith("CMS"):
        parts = [p.strip() for p in n.split("/") if p.strip()]
        if len(parts) >= 3:
            return parts[-1]
    # HDFC "A2AINT01 - <bank> - <ref> -  - <acct> - <NAME>" and DOM*/other spaced
    # formats use " - " separators with the payee NAME in the last field.
    if " - " in n:
        tail = [p.strip() for p in n.split(" - ") if p.strip()]
        if tail:
            return tail[-1]
    # TPT third-party transfers (plain dashes): "<acct>-TPT-<ref>-<NAME>".
    if "-TPT-" in up:
        tail = [p.strip() for p in n.split("-") if p.strip()]
        if tail:
            return tail[-1]
    # ICICI slash forms: the payee name is the last field that isn't an IFSC or
    # a pure reference number.
    if "/" in n and re.match(r"(INF|MMT|UPI|IMPS|NEFT|RTGS|ACH|BIL)/", up):
        parts = [p.strip() for p in n.split("/") if p.strip()]
        for f in reversed(parts):
            if _stop_field(f) or re.fullmatch(r"[A-Z]{3,5}\d*", f):
                continue
            return f
        return parts[-1] if parts else n

    parts = [p.strip() for p in re.split(r"\s*-\s*", n) if p.strip()]
    if not parts:
        return n
    typ = parts[0].upper()
    if typ.startswith("UPI"):
        return parts[1] if len(parts) > 1 else n
    if len(parts) < 3:
        return n
    out = []
    for k in range(2, len(parts)):
        if _stop_field(parts[k]):
            break
        out.append(parts[k])
    return " ".join(out).strip() or parts[2]


def classify(row, customers, aliases=None):
    """Classify a :class:`bank_tally.statement.BankRow`. ``self_account`` is the
    statement's own account number (so a self-reference isn't read as a transfer)."""
    from agent.matcher import match_name

    aliases = aliases or {}
    narr = row.narration or ""
    up = narr.upper()

    # 0. Payments to IOCL are already posted by the IOCL PAD tool (its "Customer
    #    ECollection" journals). Skip them so the two tools never double-count —
    #    verified: every bank->IOCL payment matches a PAD ECollection by date+amount.
    if not row.is_credit and re.search(r"INDIAN OIL", up):
        return Classification(
            PAYMENT, "M/s Indian Oil Corporation Limited", "Indian Oil Corporation",
            "iocl-pad", [], skip=True,
            skip_reason="already posted by the IOCL PAD tool (Customer ECollection)")

    # 1. Contra — a transfer between the firm's own accounts, or a cash deposit
    #    into the bank (cash only flows in: Bank Dr / Cash Cr).
    if re.search(r"CASH DEP(OSIT)?|BY CASH|CASH DEP BY|CDM ", up):
        return Classification(CONTRA, "Cash", "Cash", "cash-deposit", ["Cash"])
    own = _own_account_in(narr, exclude=None)
    if own is not None:
        return Classification(CONTRA, own, own, "own-account", [own])

    # 1b. Self-transfer — a NEFT/RTGS between our own accounts shows only our own
    #     name (no account number). It's a Contra; the exact other account is
    #     resolved by pairing across statements (HDFC OD vs C/A is ambiguous from
    #     one statement). An ICICI IFSC pins it down.
    party = extract_remitter(narr)
    if _SELF.search(party):
        m = re.search(r"\b(ICIC|HDFC|SBIN|UTIB|KKBK|PUNB)[0A-Z0-9]{6,}", up)
        led = _IFSC_TO_OWN.get(m.group(1)) if m else None
        return Classification(CONTRA, led, "Self transfer (own accounts)",
                              "self-transfer", [])

    # 1c. A resolved alias (learned in the app / from the review sheet) wins for
    #     either direction — this is where the user's confirmed mappings live.
    from agent.matcher import alias_key
    led = aliases.get(alias_key(party))
    if led:
        return Classification(RECEIPT if row.is_credit else PAYMENT, led, party,
                              "alias", [led])

    # 2. Payment rules (money out, known payees).
    if not row.is_credit:
        for pat, ledger in PAYMENT_RULES:
            if re.search(pat, up):
                return Classification(PAYMENT, ledger, ledger, "rule", [ledger])

    # 3. Receipt (money in).
    if row.is_credit:
        for pat, ledger in RECEIPT_RULES:
            if re.search(pat, up):
                return Classification(RECEIPT, ledger, ledger, "rule", [ledger])
        remitter = extract_remitter(narr)
        res = match_name(remitter, customers, aliases)
        if res.status == "matched":
            return Classification(RECEIPT, res.canonical, remitter, res.tier,
                                  res.candidates)
        return Classification(RECEIPT, None, remitter, res.tier, res.candidates)

    # 4. Money out — a staff payment posts to Salary; otherwise review.
    payee = extract_remitter(narr)
    if is_staff(payee):
        return Classification(PAYMENT, SALARY_LEDGER, payee, "staff", [SALARY_LEDGER])
    return Classification(PAYMENT, None, payee, "nomatch", [])
