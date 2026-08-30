"""Scan an iCloud folder of invoice PDFs into consignment-note candidates.

Reuses the verified extractor in ``agent/invoice.py`` (pure text logic) so the
field parsing is identical to the /payments pipeline. PDF-to-text is isolated
behind an injectable reader so the scan logic is unit-testable without pymupdf
or real files.
"""

from __future__ import annotations

import os
from dataclasses import asdict

from agent import invoice as invoice_mod


def pdf_to_text(path: str) -> str:
    """Extract text from a PDF file (lazy pymupdf import — only needed at runtime)."""
    import pymupdf  # lazy: keeps pure-logic tests import-free

    doc = pymupdf.open(path)
    try:
        return "".join(page.get_text() for page in doc)
    finally:
        doc.close()


def list_pdfs(folder: str) -> list[str]:
    """Return the full paths of PDF files directly in ``folder`` (sorted, stable).

    Skips the macOS ``.DS_Store``/hidden files and iCloud placeholder names.
    """
    if not folder or not os.path.isdir(folder):
        return []
    out = []
    for name in sorted(os.listdir(folder)):
        if name.startswith("."):
            continue
        if name.lower().endswith(".pdf"):
            out.append(os.path.join(folder, name))
    return out


def _below_min(invoice_no: str | None, min_invoice_no: str) -> bool:
    """True if ``invoice_no`` is a numeric doc number below the anchor."""
    if not (min_invoice_no and invoice_no and str(invoice_no).isdigit()):
        return False
    return int(invoice_no) < int(min_invoice_no)


def scan(folder: str, own_tt: str, min_invoice_no: str = "",
         pdf_reader=pdf_to_text) -> tuple[list[dict], list[str]]:
    """Parse every PDF in ``folder`` into own-TT consignment-note candidates.

    Returns ``(notes, warnings)``:
      - ``notes``  one dict per usable invoice (deduped by invoice number),
        carrying the extracted fields plus the source ``pdf_path``/``pdf_name``.
        Serials are NOT assigned here — the server does that so it can persist.
      - ``warnings``  human-readable strings for files that looked like our
        invoice but parsed incompletely (worth surfacing, never silently
        dropped). Files for other trucks / below the anchor are ignored quietly.
    """
    own = (own_tt or "").upper()
    notes: list[dict] = []
    warnings: list[str] = []
    seen_invoice_nos: set[str] = set()

    for path in list_pdfs(folder):
        name = os.path.basename(path)
        try:
            text = pdf_reader(path)
        except Exception as exc:  # unreadable / not a real PDF
            warnings.append(f"{name}: could not read PDF ({exc})")
            continue

        f = invoice_mod.extract_fields(text)

        # Only our own tank truck; everything else is quietly ignored.
        if not f.tt_no or f.tt_no.upper() != own:
            continue
        # Below the numbering anchor -> older load, already noted manually.
        if _below_min(f.invoice_no, min_invoice_no):
            continue
        # A partial parse on our own truck is worth flagging, not dropping.
        if not invoice_mod.is_complete(f):
            warnings.append(
                f"{name}: invoice {f.invoice_no or '?'} for our TT parsed "
                f"incompletely (date={f.invoice_date} product={f.product} "
                f"qty={f.qty} value={f.value}) — check the PDF")
            continue
        if f.invoice_no in seen_invoice_nos:
            continue  # same invoice as an earlier PDF in the folder
        seen_invoice_nos.add(f.invoice_no)

        note = asdict(f)
        note["pdf_path"] = path
        note["pdf_name"] = name
        notes.append(note)

    # Oldest invoice first, so serials get assigned in invoice-number order.
    notes.sort(key=lambda n: (n["invoice_no"].isdigit(), n["invoice_no"]))
    return notes, warnings
