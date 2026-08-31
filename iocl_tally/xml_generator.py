"""Build Tally import XML by cloning REAL exported vouchers and substituting.

The templates in ``templates/`` are genuine ``TALLYMESSAGE``/``VOUCHER`` blocks
exported from the company's own Tally (one per posting category). They already
carry every GST / address / party field Tally expects, and — crucially — the
correct ledger order, signs (``ISDEEMEDPOSITIVE``) and which side the IOCL party
is on for that category. So generating a voucher is deliberately *surgical*:

* strip the identity fields (GUID / REMOTEID / VCHKEY / ALTERID / MASTERID /
  VOUCHERKEY / VOUCHERRETAINKEY / VOUCHERNUMBER) so each row imports as a fresh
  **Create** and Tally assigns its own auto number (handoff decisions §3, §4);
* set the three date fields to the PAD line's date;
* replace only the two ledger AMOUNT / VATEXPAMOUNT magnitudes, keeping the
  template's sign — which reproduces the category's Dr/Cr convention exactly
  (handoff §5);
* record the PAD/SAP document number in ``<REFERENCE>`` for traceability.

Because both ledger amounts come from one magnitude with opposite signs, every
generated voucher balances Dr = Cr = 0 by construction.
"""

from __future__ import annotations

import os
import re

TEMPLATE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "templates")

# PAD category -> template file (journals). Purchases are handled separately
# because they need the invoice PDF for the base / per-product VAT / round-off.
JOURNAL_TEMPLATES = {
    "TDS": "TDS.xml",
    "FLEET": "FLEET.xml",
    "COLLECTION": "COLLECTION_OD.xml",       # default; routed per line (see below)
    "K1": "K1.xml",
    "LICENSE": "LICENSE.xml",
    "DEALERMARGIN": "DEALERMARGIN.xml",
    "NFR": "NFR.xml",
    "INTEREST": "INTEREST.xml",
}

# A Customer ECollection lands in one of several bank ledgers. The PAD Item Text
# names the receiving bank account (IFSC_account, e.g. HDFC0000240_5020011 0712542
# or ICIC0000011_04680500 4716), so route by a distinctive fragment of it.
# (marker found in the line's item text, template file, ledger shown in review)
COLLECTION_ROUTES = [
    ("5921701", "COLLECTION_CA.xml", "HDFC BANK C/A - 59217010101010"),
    ("04680500", "COLLECTION_ICICI.xml", "ICICI BANK LTD"),
]
COLLECTION_DEFAULT = ("COLLECTION_OD.xml", "HDFC BANK OD A/C - 50200110712542")


def collection_route(item_text: str) -> tuple[str, str]:
    """Return (template_file, ledger_name) for an ECollection, by the bank
    account named in its item text. Defaults to the HDFC OD account."""
    t = item_text or ""
    for marker, tpl, ledger in COLLECTION_ROUTES:
        if marker in t:
            return tpl, ledger
    return COLLECTION_DEFAULT

# Identity element tags stripped so nothing existing is overwritten on import.
_STRIP_TAGS = ["GUID", "ALTERID", "MASTERID", "VOUCHERKEY", "VOUCHERRETAINKEY",
               "VOUCHERNUMBER"]
_DATE_TAGS = ["DATE", "VCHSTATUSDATE", "EFFECTIVEDATE", "INSTRUMENTDATE"]


def _read_template(name: str) -> str:
    with open(os.path.join(TEMPLATE_DIR, name), encoding="utf-8") as fh:
        return fh.read()


def _strip_identity(vch: str) -> str:
    # Remove identity element lines.
    for tag in _STRIP_TAGS:
        vch = re.sub(rf"\s*<{tag}>[^<]*</{tag}>", "", vch)
    # Remove REMOTEID / VCHKEY attributes from the <VOUCHER ...> open tag.
    vch = re.sub(r'\s+REMOTEID="[^"]*"', "", vch, count=1)
    vch = re.sub(r'\s+VCHKEY="[^"]*"', "", vch, count=1)
    return vch


def _set_dates(vch: str, yyyymmdd: str) -> str:
    for tag in _DATE_TAGS:
        vch = re.sub(rf"<{tag}>[^<]*</{tag}>", f"<{tag}>{yyyymmdd}</{tag}>", vch)
    return vch


def _signed(template_value: str, amount: float) -> str:
    """New magnitude with the template value's sign preserved."""
    neg = template_value.strip().startswith("-")
    return f"{'-' if neg else ''}{abs(amount):.2f}"


def _set_ledger_amounts(vch: str, amount: float) -> str:
    """Replace AMOUNT + VATEXPAMOUNT in each ALLLEDGERENTRIES block with the
    line amount, keeping each entry's original sign."""
    def fix_block(m: re.Match) -> str:
        blk = m.group(0)
        blk = re.sub(r"<AMOUNT>([^<]*)</AMOUNT>",
                     lambda a: f"<AMOUNT>{_signed(a.group(1), amount)}</AMOUNT>", blk)
        blk = re.sub(r"<VATEXPAMOUNT>([^<]*)</VATEXPAMOUNT>",
                     lambda a: f"<VATEXPAMOUNT>{_signed(a.group(1), amount)}</VATEXPAMOUNT>",
                     blk)
        return blk
    return re.sub(r"<ALLLEDGERENTRIES\.LIST>.*?</ALLLEDGERENTRIES\.LIST>",
                  fix_block, vch, flags=re.S)


def _set_reference(vch: str, reference: str | None) -> str:
    if not reference:
        return vch
    ref = f"<REFERENCE>{reference}</REFERENCE>"
    if "<REFERENCE>" in vch:
        return re.sub(r"<REFERENCE>[^<]*</REFERENCE>", ref, vch, count=1)
    # Insert just before VOUCHERTYPENAME (always present).
    return re.sub(r"(<VOUCHERTYPENAME>)", ref + r"\1", vch, count=1)


def _set_narration(vch: str, text: str | None) -> str:
    """Set the voucher Narration (Tally's remarks field)."""
    if not text:
        return vch
    text = text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    tag = f"<NARRATION>{text}</NARRATION>"
    if "<NARRATION>" in vch:
        return re.sub(r"<NARRATION>[^<]*</NARRATION>", tag, vch, count=1)
    return re.sub(r"(<VOUCHERTYPENAME>)", tag + r"\1", vch, count=1)


def make_journal(category: str, date_yyyymmdd: str, amount: float,
                 reference: str | None = None, collection_item_text: str = "") -> str:
    """Return one ``TALLYMESSAGE`` block for a journal-category PAD line.

    For a COLLECTION the receiving bank ledger is chosen from the line's item
    text (HDFC OD / HDFC C/A / ICICI); other categories use their one template."""
    if category == "COLLECTION":
        tpl_name = collection_route(collection_item_text)[0]
    else:
        tpl_name = JOURNAL_TEMPLATES[category]
    vch = _read_template(tpl_name)
    vch = _strip_identity(vch)
    vch = _set_dates(vch, date_yyyymmdd)
    vch = _set_ledger_amounts(vch, amount)
    vch = _set_reference(vch, reference)
    return vch


# ---- purchases (from the invoice PDF) --------------------------------------
# Each purchase template is a real exported voucher; we know its per-product
# base / VAT / qty / rate, party total and R/off, so a new invoice is generated
# by replacing those exact value strings. Amounts appear a few times each
# (inventory + accounting allocation + assessable), and the substitution swaps
# every occurrence, so the clone stays internally consistent.
PURCHASE_TEMPLATE_1 = {
    "file": "PURCHASE_1prod.xml",
    "party": "2159219.00", "roff": "0.09",
    "products": [
        {"stock": "High Speed Diesel", "base": "-1741305.72",
         "vat": "-417913.37", "qty": "22000.000", "rate": "79.15"},
    ],
}
PURCHASE_TEMPLATE_2 = {
    "file": "PURCHASE_2prod.xml",
    "party": "2189848.00", "roff": "0.18",
    "products": [
        {"stock": "High Speed Diesel", "base": "-1385129.56",
         "vat": "-332431.09", "qty": "17500.000", "rate": "79.15"},
        {"stock": "Motor Spirit", "base": "-368974.63",
         "vat": "-103312.90", "qty": "4500.000", "rate": "81.99"},
    ],
}
_PURCHASE_DATE_TAGS = ["DATE", "VCHSTATUSDATE", "EFFECTIVEDATE", "REFERENCEDATE"]

# Purchase vouchers carry a manual TT number (TT063, TT064, …).
TT_PREFIX = "TT"


def format_tt(n: int) -> str:
    return f"{TT_PREFIX}{int(n):03d}"


def assign_tt(state: dict, doc_number: str) -> str:
    """Idempotent TT number for a purchase, keyed by its document number.

    Same invoice always maps to the same TT number (so a re-run / re-import never
    renumbers it); a new invoice takes the next number. ``state`` is mutated::

        {"next_tt": 131, "issued": {"7010099224": 131, ...}}
    """
    doc = str(doc_number)
    issued = state.setdefault("issued", {})
    if doc in issued:
        return format_tt(issued[doc])
    n = int(state.get("next_tt", 1))
    issued[doc] = n
    state["next_tt"] = n + 1
    return format_tt(n)


def _fmt_neg(v: float) -> str:
    return f"-{abs(v):.2f}"


def choose_purchase_template(products) -> dict | None:
    """Pick the matching purchase template for an invoice's product set, or None
    if unsupported (only HSD-single and HSD+MS-two are exported skeletons)."""
    stocks = {p.stock_item for p in products}
    if len(products) == 1 and stocks == {"High Speed Diesel"}:
        return PURCHASE_TEMPLATE_1
    if len(products) == 2 and stocks == {"High Speed Diesel", "Motor Spirit"}:
        return PURCHASE_TEMPLATE_2
    return None


def _set_voucher_number(vch: str, number: str) -> str:
    """Insert an explicit ``<VOUCHERNUMBER>`` (purchases use a manual TT number,
    so Tally won't auto-assign one — without this it stamps them all '1')."""
    tag = f"<VOUCHERNUMBER>{number}</VOUCHERNUMBER>"
    if "<VOUCHERNUMBER>" in vch:
        return re.sub(r"<VOUCHERNUMBER>[^<]*</VOUCHERNUMBER>", tag, vch, count=1)
    return re.sub(r"(<VOUCHERTYPENAME>)", tag + r"\1", vch, count=1)


def make_purchase(invoice, date_yyyymmdd: str, reference: str | None = None,
                  voucher_number: str | None = None):
    """Return a purchase ``TALLYMESSAGE`` block for an invoice, or ``None`` if the
    invoice's product mix has no matching template (caller skips + flags it).

    ``voucher_number`` (e.g. ``TT131``) is emitted because the Purchase voucher
    type numbers manually; omit it and Tally stamps every purchase '1'."""
    tpl = choose_purchase_template(invoice.products)
    if tpl is None:
        return None
    vch = _read_template(tpl["file"])
    vch = _strip_identity(vch)
    if voucher_number:
        vch = _set_voucher_number(vch, voucher_number)
        vch = _set_narration(vch, voucher_number)   # TT no. in the remarks
    for tag in _PURCHASE_DATE_TAGS:
        vch = re.sub(rf"<{tag}>[^<]*</{tag}>", f"<{tag}>{date_yyyymmdd}</{tag}>", vch)
    vch = _set_reference(vch, reference)

    # Per-product value substitution, matched by stock item.
    inv_by_stock = {p.stock_item: p for p in invoice.products}
    for tp in tpl["products"]:
        p = inv_by_stock[tp["stock"]]
        vch = vch.replace(tp["base"], _fmt_neg(p.base_value))
        vch = vch.replace(tp["vat"], _fmt_neg(p.vat_amount))
        vch = vch.replace(tp["qty"], f"{p.qty_ltr:.3f}")
        rate = round(p.base_value / p.qty_ltr, 2) if p.qty_ltr else 0.0
        vch = vch.replace(f"{tp['rate']}/LTR", f"{rate:.2f}/LTR")

    # Party total (the invoice grand total, credited to IOCL).
    vch = vch.replace(f"<AMOUNT>{tpl['party']}</AMOUNT>",
                      f"<AMOUNT>{invoice.total:.2f}</AMOUNT>")
    # R/off = -(ZRND) so the voucher balances; keep it in the R/off entry only.
    roff = round(-invoice.zrnd, 2)
    vch = _set_roff(vch, tpl["roff"], f"{roff:.2f}")
    return vch


def _set_roff(vch: str, old: str, new: str) -> str:
    """Replace AMOUNT + VATEXPAMOUNT inside the R/off ledger entry only."""
    def fix(m: re.Match) -> str:
        blk = m.group(0)
        blk = blk.replace(f"<AMOUNT>{old}</AMOUNT>", f"<AMOUNT>{new}</AMOUNT>")
        blk = blk.replace(f"<VATEXPAMOUNT>{old}</VATEXPAMOUNT>",
                          f"<VATEXPAMOUNT>{new}</VATEXPAMOUNT>")
        return blk
    return re.sub(r"<LEDGERENTRIES\.LIST>(?:(?!</LEDGERENTRIES\.LIST>).)*?"
                  r"<LEDGERNAME>R/off</LEDGERNAME>.*?</LEDGERENTRIES\.LIST>",
                  fix, vch, flags=re.S)


def voucher_balances(vch: str) -> bool:
    """True if the voucher's ledger AMOUNTs sum to zero (Dr = Cr)."""
    amts = [float(x) for x in re.findall(
        r"<ALLLEDGERENTRIES\.LIST>.*?<AMOUNT>(-?[\d.]+)</AMOUNT>", vch, re.S)]
    return abs(round(sum(amts), 2)) < 0.005


def purchase_balances(vch: str) -> bool:
    """True if a purchase voucher balances: the inventory entry amounts (base +
    VAT) plus the ledger entries (party + R/off) sum to zero."""
    inv = [float(re.search(r"<AMOUNT>(-?[\d.]+)</AMOUNT>", m.group(0)).group(1))
           for m in re.finditer(
               r"<ALLINVENTORYENTRIES\.LIST>.*?</ALLINVENTORYENTRIES\.LIST>", vch, re.S)]
    led = [float(x) for x in re.findall(
        r"<LEDGERENTRIES\.LIST>.*?<AMOUNT>(-?[\d.]+)</AMOUNT>", vch, re.S)]
    return abs(round(sum(inv) + sum(led), 2)) < 0.005


ENVELOPE_HEAD = (
    "<ENVELOPE>\n <HEADER>\n  <TALLYREQUEST>Import Data</TALLYREQUEST>\n"
    " </HEADER>\n <BODY>\n  <IMPORTDATA>\n   <REQUESTDESC>\n"
    "    <REPORTNAME>Vouchers</REPORTNAME>\n    <STATICVARIABLES>\n"
    "     <SVCURRENTCOMPANY>VRIDDHI FUELS (2026-27)</SVCURRENTCOMPANY>\n"
    "    </STATICVARIABLES>\n   </REQUESTDESC>\n   <REQUESTDATA>\n"
)
ENVELOPE_TAIL = "   </REQUESTDATA>\n  </IMPORTDATA>\n </BODY>\n</ENVELOPE>\n"


def build_envelope(vouchers: list[str]) -> str:
    """Wrap voucher TALLYMESSAGE blocks in a Tally 'Import Data' envelope."""
    return ENVELOPE_HEAD + "\n".join(vouchers) + "\n" + ENVELOPE_TAIL
