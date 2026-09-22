"""Tests for the standalone consignment-note app (consign/).

Covers the local serial counter (idempotent per invoice number) and the folder
scanner's decision logic (own-TT filter, min-invoice anchor, dedup, incomplete
warning). PDF reading is faked, so these run without pymupdf or real files.
"""

from consign import scanner, serial
from tests.test_invoice import INVOICE_TEXT  # a structure-faithful IOCL invoice


# ---- serial assignment -----------------------------------------------------

def test_serial_format():
    assert serial.format_serial(47, "15/09/2026") == "VF/CN2627/047"
    assert serial.format_serial(3, "15/09/2026") == "VF/CN2627/003"
    assert serial.format_serial(1234, "15/09/2026") == "VF/CN2627/1234"


def test_fy_code_rolls_over_by_financial_year():
    assert serial.fy_code("31/03/2027") == "2627"   # Jan–Mar -> previous FY
    assert serial.fy_code("01/04/2027") == "2728"   # new FY starts 1 Apr
    assert serial.fy_code("10/12/2028") == "2829"


def test_assign_starts_at_next_and_increments():
    state = {"next_serial": 47, "issued": {}}
    assert serial.assign(state, "7010221545", "15/09/2026") == (47, "VF/CN2627/047")
    assert serial.assign(state, "7010221600", "15/09/2026") == (48, "VF/CN2627/048")
    assert state["lifetime_next"] == 49
    assert state["fy_next"]["2627"] == 49


def test_assign_is_idempotent_per_invoice():
    state = {"next_serial": 47, "issued": {}}
    first = serial.assign(state, "7010221545", "15/09/2026")
    serial.assign(state, "7010221600", "15/09/2026")           # spend one more
    again = serial.assign(state, "7010221545", "15/09/2026")   # same invoice -> same serial
    assert first == again == (47, "VF/CN2627/047")
    assert state["lifetime_next"] == 49            # not spent again


def test_printed_serial_restarts_each_fy_lifetime_continues():
    state = {"next_serial": 50, "issued": {}}
    # FY 2026-27 note keeps the running number
    assert serial.assign(state, "A", "15/09/2026") == (50, "VF/CN2627/050")
    # First FY 2027-28 note: printed serial restarts at 001, lifetime continues
    assert serial.assign(state, "B", "05/04/2027") == (1, "VF/CN2728/001")
    assert serial.assign(state, "C", "06/04/2027") == (2, "VF/CN2728/002")
    assert serial.lifetime_of(state, "A") == 50
    assert serial.lifetime_of(state, "B") == 51
    assert serial.lifetime_of(state, "C") == 52
    assert state["lifetime_next"] == 53
    assert state["fy_next"]["2627"] == 51
    assert state["fy_next"]["2728"] == 3
    # idempotent across the rollover
    assert serial.assign(state, "B", "05/04/2027") == (1, "VF/CN2728/001")


def test_assign_migrates_legacy_issued_rows():
    # Old on-disk state: issued maps invoice -> plain int, single next_serial.
    state = {"next_serial": 49, "issued": {"OLD": 47}}
    assert serial.assign(state, "OLD", "15/09/2026") == (47, "VF/CN2627/047")
    assert serial.lifetime_of(state, "OLD") == 47
    assert serial.assign(state, "NEW", "15/09/2026") == (49, "VF/CN2627/049")


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
