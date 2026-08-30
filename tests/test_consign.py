"""Tests for the standalone consignment-note app (consign/).

Covers the local serial counter (idempotent per invoice number) and the folder
scanner's decision logic (own-TT filter, min-invoice anchor, dedup, incomplete
warning). PDF reading is faked, so these run without pymupdf or real files.
"""

from consign import scanner, serial
from tests.test_invoice import INVOICE_TEXT  # a structure-faithful IOCL invoice


# ---- serial assignment -----------------------------------------------------

def test_serial_format():
    assert serial.format_serial(47) == "VF/CN2627/047"
    assert serial.format_serial(3) == "VF/CN2627/003"
    assert serial.format_serial(1234) == "VF/CN2627/1234"


def test_assign_starts_at_next_and_increments():
    state = {"next_serial": 47, "issued": {}}
    assert serial.assign(state, "7010221545") == (47, "VF/CN2627/047")
    assert serial.assign(state, "7010221600") == (48, "VF/CN2627/048")
    assert state["next_serial"] == 49


def test_assign_is_idempotent_per_invoice():
    state = {"next_serial": 47, "issued": {}}
    first = serial.assign(state, "7010221545")
    serial.assign(state, "7010221600")           # spend one more
    again = serial.assign(state, "7010221545")   # same invoice -> same serial
    assert first == again == (47, "VF/CN2627/047")
    assert state["next_serial"] == 49            # not spent again


# ---- folder scan -----------------------------------------------------------

def _reader(mapping):
    return lambda path: mapping[path]


def _scan_files(files, own_tt, min_no, mapping):
    """Drive scanner.scan with an explicit file list (bypass the real listdir)."""
    import consign.scanner as sc
    orig = sc.list_pdfs
    sc.list_pdfs = lambda folder: files
    try:
        return sc.scan("/inv", own_tt, min_no, pdf_reader=_reader(mapping))
    finally:
        sc.list_pdfs = orig


def test_scan_claims_own_tt():
    notes, warns = _scan_files(
        ["/inv/a.pdf"], "OD23U8210", "", {"/inv/a.pdf": INVOICE_TEXT})
    assert warns == []
    assert len(notes) == 1
    assert notes[0]["invoice_no"] == "7010195291"
    assert notes[0]["tt_no"] == "OD23U8210"
    assert notes[0]["qty"] == "22"
    assert notes[0]["value"] == 2159219
    assert notes[0]["pdf_name"] == "a.pdf"


def test_scan_ignores_other_tt():
    other = INVOICE_TEXT.replace("OD23U8210", "OD23X9999")
    notes, warns = _scan_files(
        ["/inv/o.pdf"], "OD23U8210", "", {"/inv/o.pdf": other})
    assert notes == []
    assert warns == []


def test_scan_skips_below_min_invoice():
    notes, warns = _scan_files(
        ["/inv/a.pdf"], "OD23U8210", "7010221545", {"/inv/a.pdf": INVOICE_TEXT})
    assert notes == []      # 7010195291 < anchor -> quietly ignored
    assert warns == []


def test_scan_dedups_same_invoice_across_pdfs():
    notes, warns = _scan_files(
        ["/inv/a.pdf", "/inv/b.pdf"], "OD23U8210", "",
        {"/inv/a.pdf": INVOICE_TEXT, "/inv/b.pdf": INVOICE_TEXT})
    assert len(notes) == 1


def test_scan_warns_on_incomplete_own_tt():
    broken = "OD23U8210\nT.T.No.\nnothing else useful\n"
    notes, warns = _scan_files(
        ["/inv/x.pdf"], "OD23U8210", "", {"/inv/x.pdf": broken})
    assert notes == []
    assert len(warns) == 1 and "incompletely" in warns[0]


def test_scan_warns_on_unreadable_pdf():
    def boom(path):
        raise RuntimeError("not a pdf")
    import consign.scanner as sc
    orig = sc.list_pdfs
    sc.list_pdfs = lambda folder: ["/inv/bad.pdf"]
    try:
        notes, warns = sc.scan("/inv", "OD23U8210", "", pdf_reader=boom)
    finally:
        sc.list_pdfs = orig
    assert notes == []
    assert len(warns) == 1 and "could not read" in warns[0]


def test_scan_empty_folder():
    notes, warns = scanner.scan("/does/not/exist", "OD23U8210", "")
    assert notes == [] and warns == []
