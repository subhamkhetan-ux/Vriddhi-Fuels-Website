"""Read CL.BAL.in Comp Code from the PAD table, excluding open deliveries."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from hashlib import sha256
import re

IST = timezone(timedelta(hours=5, minutes=30))


class PortalError(Exception):
    """An actionable, credential-free error that is safe to show in a job log."""


@dataclass(frozen=True)
class Balance:
    customer: str
    amount: Decimal
    sign: str
    generated_at: datetime
    from_date: date
    to_date: date

    def row(self) -> dict:
        at = self.generated_at.astimezone(timezone.utc).isoformat()
        identity = f"{self.customer}|{at}|{self.amount:.2f}|{self.sign}"
        return {
            "id": "iocl-pad-" + sha256(identity.encode()).hexdigest()[:40],
            "at": at,
            # PostgREST accepts numeric strings without binary float rounding.
            "amount": f"{self.amount:.2f}",
            "sign": self.sign,
            "raw": (f"IOCL e-Mitra PAD company balance: Rs. {self.amount:.2f} {self.sign}; "
                    f"account {self.customer}; report {self.generated_at.isoformat()}; "
                    f"period {self.from_date.isoformat()} to {self.to_date.isoformat()}. "
                    "Source: CL.BAL.in Comp Code table row, excluding open deliveries."),
        }


def _date(value: str) -> date:
    for fmt in ("%d-%b-%Y", "%d-%m-%Y", "%d/%m/%Y", "%d.%m.%Y"):
        try:
            return datetime.strptime(value, fmt).date()
        except ValueError:
            pass
    raise PortalError("The PAD statement date format was not recognized. Nothing was saved.")


def parse_statement(text: str, *, table_rows: list[list[str]], customer: str, today: date,
                    now: datetime | None = None) -> Balance:
    """IOCL debit increases signed PAD balance: negative is CR, positive DR.

    Use the Balance column on CL.BAL.in Comp Code, immediately before Open
    Delivery value. The footer includes those deliveries and is never a fallback.
    """
    if not re.fullmatch(r"[0-9]{4,20}", customer):
        raise PortalError("Configure the numeric IOCL_CUSTOMER_CODE for account verification.")
    if not isinstance(text, str) or len(text) > 1_000_000:
        raise PortalError("The PAD statement is missing or too large.")
    text = re.sub(r"[\s\u00a0]+", " ", text).replace("\u2212", "-")
    accounts = re.findall(r"\bCustomer\s*[:\-]+\s*[^()]{1,160}\(\s*(\d{4,20})\s*\)", text, re.I)
    if not accounts or set(accounts) != {customer}:
        raise PortalError("The PAD customer code does not match the configured account. Nothing was saved.")
    date_token = r"\d{1,2}[-/.](?:[A-Za-z]{3}|\d{1,2})[-/.]\d{4}"
    ranges = re.findall(r"\bFrom\s+(" + date_token + r")\s+To\s+(" + date_token + r")\b", text, re.I)
    if len(set(ranges)) != 1:
        raise PortalError("The PAD statement must show one unambiguous From/To period.")
    from_day, to_day = map(_date, ranges[0])
    if to_day != today or from_day != today - timedelta(days=1):
        raise PortalError("The PAD report is not for the requested current date. Nothing was saved.")
    timestamps = re.findall(
        # Live e-Mitra: "Report Generated Date/Time:-Tue Oct 13 2026 2:06:11 pm".
        r"(?:Report\s+)?Generated\s+Date\s*/\s*Time\s*:?[\s\-]*"
        r"((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+[A-Za-z]{3}\s+\d{1,2}\s+\d{4}\s+\d{1,2}:\d{2}:\d{2}\s*(?:AM|PM)?)",
        text, re.I)
    if len(set(timestamps)) != 1:
        raise PortalError("The PAD report generation timestamp is missing or unfamiliar (seen: "
                          + _timestamp_hint(text) + ").")
    generated = None
    for fmt in ("%a %b %d %Y %I:%M:%S %p", "%a %b %d %Y %H:%M:%S"):
        try:
            generated = datetime.strptime(timestamps[0].strip(), fmt).replace(tzinfo=IST)
            break
        except ValueError:
            pass
    if generated is None:
        raise PortalError("The PAD report timestamp could not be parsed (seen: " + _timestamp_hint(text) + ").")
    now = now or datetime.now(IST)
    if now.tzinfo is None:
        raise PortalError("The observation clock must include a time zone.")
    if generated.date() != today or not -120 <= (now - generated).total_seconds() <= 900:
        raise PortalError("The PAD report is stale or its clock differs by too much. Nothing was saved. "
                          f"(report {generated.isoformat()}, agent clock {now.astimezone(IST).isoformat(timespec='seconds')})")
    if not isinstance(table_rows, list) or len(table_rows) > 5000:
        raise PortalError("The PAD table is missing or too large.")
    rows = [[re.sub(r"\s+", " ", str(cell)).strip() for cell in row]
            for row in table_rows if isinstance(row, list) and any(str(c).strip() for c in row)]
    close_label = re.compile(r"^CL\.?\s*BAL\.?\s*in\s+Comp(?:any)?\.?\s+Code\s*:?$", re.I)
    closing_rows = [(i, row) for i, row in enumerate(rows) if any(close_label.fullmatch(cell) for cell in row)]
    if len(closing_rows) != 1:
        raise PortalError("Expected exactly one CL.BAL.in Comp Code row. The final Closing balance is not used. "
                          f"(Found {len(closing_rows)} in {len(rows)} rows; {_table_hint(rows)}.)")
    index, row = closing_rows[0]
    if len(row) < 3 or index + 1 >= len(rows) or not any(
            re.search(r"^Open\s+Delivery\s+value", cell, re.I) for cell in rows[index + 1]):
        raise PortalError("The company balance is not directly above the Open Delivery value row. Verify the table layout. "
                          f"({_table_hint(rows)}; balance row has {len(row)} cells.)")
    headers = [r for r in rows[:index] if r and re.fullmatch(r"Balance(?:\s*\(?\s*Rs\.?\s*\)?)?", r[-1], re.I)]
    if not headers:
        raise PortalError("The last PAD table column could not be verified as Balance (Rs.). "
                          f"({_table_hint(rows)}.)")
    if len(row) != len(headers[-1]) or len(rows[index + 1]) != len(row):
        raise PortalError("The PAD balance cells do not align with the table header. Nothing was saved. "
                          f"(header {len(headers[-1])} cells, balance row {len(row)}, next row {len(rows[index + 1])}; "
                          f"{_table_hint(rows)}.)")
    value = signed_amount(row[-1])
    return Balance(customer, abs(value), "CR" if value < 0 else "DR", generated, from_day, to_day)


_TIME = re.compile(r"\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AP]M)?", re.I)


def _timestamp_hint(text: str) -> str:
    """The report's generation label up to its time, for fixing the format.
    Dates and times only: it stops at the time and masks long numbers."""
    m = re.search(r"generat\w*", text, re.I)
    if not m:
        return "no 'Generated' label; times " + (", ".join(_TIME.findall(text)[:3]) or "none")
    tail = text[m.start(): m.start() + 80]
    t = _TIME.search(tail)
    return re.sub(r"\d{5,}", "#", tail[: t.end()] if t else tail[:40])


def _table_hint(rows: list[list[str]]) -> str:
    """Column headings (cells with no digits) and row widths; never amounts
    or transaction text."""
    header = re.compile(r"\b(debit|credit|balance|date|text|particulars?|amount|description|doc)", re.I)
    headings = [r for r in rows if r and not any(re.search(r"\d", c) for c in r)
                and sum(bool(header.search(c)) for c in r) >= 2][:2]
    widths = sorted({len(r) for r in rows})
    return f"headings {headings}, row widths {widths}"


def signed_amount(raw: str) -> Decimal:
    raw = raw.replace("\u2212", "-").replace("\u00a0", " ").strip()
    match = re.fullmatch(r"(?:Rs\.?|INR|₹)?\s*([+-]?\s*\d[\d,]*(?:\.\d{1,2})?)\s*(DR|CR)?", raw, re.I)
    if not match:
        raise PortalError("The company-code balance cell is not a valid amount.")
    digits, suffix = match[1].replace(" ", ""), (match[2] or "").upper()
    if not re.fullmatch(r"[+-]?(?:\d+|\d{1,3}(?:,\d{3})+|\d{1,2}(?:,\d{2})*,\d{3})(?:\.\d{1,2})?", digits):
        raise PortalError("The company-code balance has ambiguous number grouping.")
    try:
        value = Decimal(digits.replace(",", ""))
    except InvalidOperation:
        raise PortalError("The company-code balance is not a valid amount.") from None
    if not value.is_finite() or abs(value) > Decimal("1000000000000"):
        raise PortalError("The company-code balance amount is outside the accepted range.")
    if suffix == "DR" and value < 0:
        raise PortalError("The company-code balance has contradictory sign information.")
    return -abs(value) if suffix == "CR" else value
