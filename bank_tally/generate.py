"""Build Tally import XML for bank vouchers by cloning real exported vouchers.

One template per voucher type (Receipt / Payment / Contra), each a genuine
2-ledger voucher exported from the company's Tally. Generating a voucher is
surgical, exactly like the IOCL tool:

* strip identity fields so each imports as a fresh Create and Tally auto-numbers
  it (Receipt/Payment/Contra number automatically);
* set the date;
* swap the two ledger names (bank + counter) via sentinels, so the two-banks
  Contra can't clobber itself;
* replace the amount magnitude, keeping each entry's template sign — which
  reproduces the Dr/Cr convention (Receipt: Bank Dr / party Cr; Payment: party
  Dr / Bank Cr; Contra: dest-Bank Dr / source-Bank Cr).

Both entries carry one magnitude with opposite signs, so every voucher balances.
"""

from __future__ import annotations

import os
import re

TEMPLATE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "templates")

# Each template's own ledger names + amount magnitude (what we substitute out).
TEMPLATES = {
    "Receipt": {"file": "Receipt.xml", "amount": "15111.00",
                "bank": "HDFC BANK C/A - 59217010101010",
                "counter": "Pine Labs (Sales Account)"},
    "Payment": {"file": "Payment.xml", "amount": "3000.00",
                "bank": "ICICI BANK LTD", "counter": "Salary"},
    # Contra template is a C/A -> OD transfer: source (Cr) = C/A, dest (Dr) = OD.
    "Contra":  {"file": "Contra.xml", "amount": "1275000.00",
                "source": "HDFC BANK C/A - 59217010101010",
                "dest": "HDFC BANK OD A/C - 50200110712542"},
}

_STRIP_TAGS = ["GUID", "ALTERID", "MASTERID", "VOUCHERKEY", "VOUCHERRETAINKEY",
               "VOUCHERNUMBER", "UNIQUEREFERENCENUMBER"]
_DATE_TAGS = ["DATE", "VCHSTATUSDATE", "EFFECTIVEDATE", "INSTRUMENTDATE"]


def _read(name: str) -> str:
    with open(os.path.join(TEMPLATE_DIR, name), encoding="utf-8") as fh:
        return fh.read()


def _strip_identity(vch: str) -> str:
    for tag in _STRIP_TAGS:
        vch = re.sub(rf"\s*<{tag}>[^<]*</{tag}>", "", vch)
    vch = re.sub(r'\s+REMOTEID="[^"]*"', "", vch, count=1)
    vch = re.sub(r'\s+VCHKEY="[^"]*"', "", vch, count=1)
    return vch


def _set_dates(vch: str, ymd: str) -> str:
    for tag in _DATE_TAGS:
        vch = re.sub(rf"<{tag}>[^<]*</{tag}>", f"<{tag}>{ymd}</{tag}>", vch)
    return vch


def _set_amount(vch: str, old_mag: str, amount: float) -> str:
    # Replace every occurrence of the magnitude; a leading '-' (Dr side) and the
    # bank-allocation / VATEXP copies all follow automatically.
    return vch.replace(old_mag, f"{amount:.2f}")


def _set_party(vch: str, party: str) -> str:
    """Point the voucher's party hint fields at the counter ledger (some Receipt
    templates carry the bank there; the accounting entries are unaffected)."""
    for tag in ("PARTYLEDGERNAME", "PARTYNAME", "BASICBASEPARTYNAME"):
        vch = re.sub(rf"<{tag}>[^<]*</{tag}>", f"<{tag}>{party}</{tag}>", vch)
    return vch


def _set_narration(vch: str, text: str | None) -> str:
    if not text:
        return vch
    text = re.sub(r"[<>&]", " ", text)[:250]
    tag = f"<NARRATION>{text}</NARRATION>"
    if "<NARRATION>" in vch:
        return re.sub(r"<NARRATION>[^<]*</NARRATION>", tag, vch, count=1)
    return re.sub(r"(<VOUCHERTYPENAME>)", tag + r"\1", vch, count=1)


def _swap(vch: str, replacements: list[tuple[str, str]]) -> str:
    """Two-phase replace via sentinels, so swapping A->B and B->A can't chain."""
    for i, (old, _new) in enumerate(replacements):
        vch = vch.replace(old, f"@@BT{i}@@")
    for i, (_old, new) in enumerate(replacements):
        vch = vch.replace(f"@@BT{i}@@", new)
    return vch


def make_receipt(ymd: str, amount: float, bank_ledger: str, counter_ledger: str,
                 narration: str | None = None) -> str:
    t = TEMPLATES["Receipt"]
    vch = _strip_identity(_read(t["file"]))
    vch = _set_dates(vch, ymd)
    vch = _swap(vch, [(t["bank"], bank_ledger), (t["counter"], counter_ledger)])
    vch = _set_amount(vch, t["amount"], amount)
    vch = _set_party(vch, counter_ledger)   # receipts name the customer as party
    return _set_narration(vch, narration)


def make_payment(ymd: str, amount: float, bank_ledger: str, counter_ledger: str,
                 narration: str | None = None) -> str:
    t = TEMPLATES["Payment"]
    vch = _strip_identity(_read(t["file"]))
    vch = _set_dates(vch, ymd)
    vch = _swap(vch, [(t["bank"], bank_ledger), (t["counter"], counter_ledger)])
    vch = _set_amount(vch, t["amount"], amount)
    # Payments keep the bank as PARTYLEDGERNAME (the template already does, via the
    # bank swap), matching the real export — so no _set_party here.
    return _set_narration(vch, narration)


def make_contra(ymd: str, amount: float, source_bank: str, dest_bank: str,
                narration: str | None = None) -> str:
    """A transfer of ``amount`` OUT of ``source_bank`` (Cr) INTO ``dest_bank`` (Dr)."""
    t = TEMPLATES["Contra"]
    vch = _strip_identity(_read(t["file"]))
    vch = _set_dates(vch, ymd)
    vch = _swap(vch, [(t["source"], source_bank), (t["dest"], dest_bank)])
    vch = _set_amount(vch, t["amount"], amount)
    return _set_narration(vch, narration)


def voucher_balances(vch: str) -> bool:
    amts = [float(x) for x in re.findall(
        r"<ALLLEDGERENTRIES\.LIST>.*?<AMOUNT>(-?[\d.]+)</AMOUNT>", vch, re.S)]
    return bool(amts) and abs(round(sum(amts), 2)) < 0.005


ENVELOPE_HEAD = (
    "<ENVELOPE>\n <HEADER>\n  <TALLYREQUEST>Import Data</TALLYREQUEST>\n"
    " </HEADER>\n <BODY>\n  <IMPORTDATA>\n   <REQUESTDESC>\n"
    "    <REPORTNAME>Vouchers</REPORTNAME>\n    <STATICVARIABLES>\n"
    "     <SVCURRENTCOMPANY>VRIDDHI FUELS (2026-27)</SVCURRENTCOMPANY>\n"
    "    </STATICVARIABLES>\n   </REQUESTDESC>\n   <REQUESTDATA>\n")
ENVELOPE_TAIL = "   </REQUESTDATA>\n  </IMPORTDATA>\n </BODY>\n</ENVELOPE>\n"


def build_envelope(vouchers: list[str]) -> str:
    return ENVELOPE_HEAD + "\n".join(vouchers) + "\n" + ENVELOPE_TAIL
