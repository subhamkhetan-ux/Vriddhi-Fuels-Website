"""Read the base / per-product VAT / round-off off an IOCL fuel TAX INVOICE.

A fuel Product Supply Invoice line on the PAD can't be split into base + VAT by
formula (freight is baked in; a flat VAT % is off by thousands on petrol), so the
purchase voucher is built from the invoice itself. This parser is text-only and
dependency-free (the PDF read lives in ``pad_parser``/``run``) so it is unit
testable against a fixture.

Each product block on the invoice has stable anchors::

    <code>   <DESCRIPTION>
    ...
                 BASIC DESTINATION PRICE
    <qty> KL <rate> KL <base value>
    JIN6   A/R Vat Payable
    <vat %> % <vat amount>
    Total for material
    <product total>

and the document ends with::

    ZRND  Rounding Difference
    <zrnd>
    Total
    <grand total>
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

# Product description -> (stock item, VAT ledger) — handoff §6.
MATERIAL_MAP = {
    "HSD": ("High Speed Diesel", "HSD VAT"),
    "EBMS": ("Motor Spirit", "MS VAT"),
    "MS": ("Motor Spirit", "MS VAT"),
}
PURCHASE_LEDGER = "PURCHASE HSD MS & XG"


@dataclass
class Product:
    material_code: str
    description: str
    stock_item: str
    vat_ledger: str
    qty_kl: float
    base_value: float
    vat_pct: float
    vat_amount: float

    @property
    def qty_ltr(self) -> float:
        return round(self.qty_kl * 1000, 3)


@dataclass
class Invoice:
    invoice_no: str | None
    date: str | None
    tt_no: str | None
    products: list[Product] = field(default_factory=list)
    zrnd: float = 0.0
    total: float | None = None
    densities: list[str] = field(default_factory=list)   # Density@15 value(s)

    @property
    def density(self) -> str:
        """Density@15 value(s), joined for the remarks."""
        return ", ".join(self.densities)

    @property
    def base_total(self) -> float:
        return round(sum(p.base_value for p in self.products), 2)

    @property
    def vat_total(self) -> float:
        return round(sum(p.vat_amount for p in self.products), 2)

    def is_complete(self) -> bool:
        return bool(self.invoice_no and self.products and self.total is not None)


def _map_material(desc: str) -> tuple[str, str]:
    u = desc.upper()
    if "EBMS" in u or re.search(r"\bMS\b", u) or "MOTOR SPIRIT" in u or "PETROL" in u:
        return MATERIAL_MAP["EBMS"]
    return MATERIAL_MAP["HSD"]      # default: diesel


def parse_invoice(text: str) -> Invoice:
    lines = [ln.strip() for ln in text.splitlines()]
    joined = "\n".join(lines)

    inv_m = re.search(r"\b(70\d{8})\b", joined)
    date_m = re.search(r"\b(\d{1,2}-[A-Za-z]{3}-\d{2,4})\b", joined)
    tt_m = re.search(r"\b([A-Z]{2}\d{2}[A-Z]{1,2}\d{3,4})\b", joined)

    products: list[Product] = []
    # A product block starts at a material line: "<code>   <DESCRIPTION>".
    for i, ln in enumerate(lines):
        mm = re.match(r"^(\d{4,6})\s+([A-Z][^\n]*?)\s*$", ln)
        if not mm:
            continue
        desc = mm.group(2).strip()
        if not re.search(r"HSD|MS|EBMS|LSHF|PETROL|DIESEL|XTRA", desc.upper()):
            continue
        block = "\n".join(lines[i:i + 40])
        # base: BASIC DESTINATION PRICE -> qty KL rate KL base
        bm = re.search(
            r"BASIC DESTINATION PRICE\s*\n([\d.]+)\s*\nKL\s*\n([\d.]+)\s*\nKL\s*\n([\d.]+)",
            block)
        vm = re.search(r"A/R Vat Payable\s*\n([\d.]+)\s*\n%\s*\n([\d.]+)", block)
        if not (bm and vm):
            continue
        stock, vat_led = _map_material(desc)
        products.append(Product(
            material_code=mm.group(1), description=desc,
            stock_item=stock, vat_ledger=vat_led,
            qty_kl=float(bm.group(1)), base_value=float(bm.group(3)),
            vat_pct=float(vm.group(1)), vat_amount=float(vm.group(2)),
        ))

    # Density@15 value(s) — one per tank/product ("... Density@15: 829.400").
    densities = re.findall(r"Density@?15\s*[:\s]\s*([0-9]{3}\.[0-9]{1,3})", joined)

    zrnd_m = re.search(r"Rounding Difference\s*\n(-?[\d.]+)", joined)
    # Grand total: the number after the LAST bare "Total" (after the ZRND line).
    total = None
    for m in re.finditer(r"(?:^|\n)Total\s*\n(\d+\.\d{2})", joined):
        total = float(m.group(1))

    return Invoice(
        invoice_no=inv_m.group(1) if inv_m else None,
        date=date_m.group(1) if date_m else None,
        tt_no=tt_m.group(1) if tt_m else None,
        products=products,
        zrnd=float(zrnd_m.group(1)) if zrnd_m else 0.0,
        total=total,
        densities=densities,
    )
