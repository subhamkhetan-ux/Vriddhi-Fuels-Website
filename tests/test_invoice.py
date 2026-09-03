"""Tests for consignment-note field extraction from IOCL invoice text.

The fixture mirrors the real IndianOil tax-invoice text layout (as produced by
pymupdf), including the decoys that tripped an earlier version: a bare "Total"
followed by the item count "10", and the "Total for material" pre-rounding
figure before the final rounded grand total.
"""

from agent import invoice

# Structure-faithful slice of a real IOCL tax invoice (pymupdf line order).
INVOICE_TEXT = """\
Doc.Name
& number
TAX INVOICE
Form No
Del Mode
Cont Code
AC4  31A
7010195291
SAP Entry no.
Road
Delivered
13262466
VRIDDHI FUELS
MALIMUNDA
751001
PAYER - 338821 VRIDDHI FUELS
OD23U8210
T.T.No.
26-Aug-26
Date
09:39
Item  Material Code / Material Description
Quantity Unit
Total
10
50703   HSD-BSVI [PDRP]
22.000
KL
2710 19 44*
             BASIC DESTINATION PRICE
22.000
KL
79150.260
KL
1741305.72
JIN6   A/R Vat Payable
24.000
%
417913.37
Total for material
2159219.09
ZRND  Rounding Difference
-0.09
Total
2159219.00
This Document is Digitally Signed
"""


# A real IOCL invoice can carry two products for the same TT on one load — here
# an MS line (5 KL) and an HSD line (17 KL). The bug this guards against: only
# the first product was kept, so the note dropped the second (HSD 17).
MULTI_INVOICE_TEXT = """\
TAX INVOICE
7010493378
OD23U8210
T.T.No.
03-Sep-26
Date
Item  Material Code / Material Description
Quantity Unit
Total
10
50701   MS-BSVI [PDRP]
5.000
KL
2710 12 49*
             BASIC DESTINATION PRICE
5.000
KL
90000.000
KL
450000.00
50703   HSD-BSVI [PDRP]
17.000
KL
2710 19 44*
             BASIC DESTINATION PRICE
17.000
KL
79150.260
KL
1345554.42
JIN6   A/R Vat Payable
24.000
%
397696.58
Total for material
2193251.09
ZRND  Rounding Difference
-0.09
Total
2193251.00
This Document is Digitally Signed
"""


def _fields():
    return invoice.extract_fields(INVOICE_TEXT)


def test_invoice_number():
    assert _fields().invoice_no == "7010195291"


def test_invoice_date_normalized():
    assert _fields().invoice_date == "26/08/2026"


def test_tt_number():
    assert _fields().tt_no == "OD23U8210"


def test_product_and_quantity():
    f = _fields()
    assert f.product == "HSD-BSVI [PDRP]"
    assert f.qty == "22"


def test_product_maps_to_hsd_column():
    assert _fields().column_key == invoice.COLUMN_HSD


def test_value_is_grand_total_not_item_count():
    # The decoy "Total\n10" (item count) must not win; the grand total does.
    assert _fields().value == 2159219


def test_is_complete():
    assert invoice.is_complete(_fields()) is True


def test_partial_is_incomplete():
    f = invoice.extract_fields("nothing useful here")
    assert invoice.is_complete(f) is False
    assert f.invoice_no is None


def test_product_column_mapping():
    assert invoice.product_column("HSD-BSVI [PDRP]") == invoice.COLUMN_HSD
    assert invoice.product_column("XtraGreen HSD") == invoice.COLUMN_XTRAGREEN
    assert invoice.product_column("MS-BSVI") == invoice.COLUMN_MS_EBMS
    assert invoice.product_column("EBMS Premium") == invoice.COLUMN_MS_EBMS
    assert invoice.product_column("LSHFHSD bulk") == invoice.COLUMN_LSHF


def test_date_normalization_variants():
    assert invoice._norm_date("26-Aug-26") == "26/08/2026"
    assert invoice._norm_date("01-Jan-2026") == "01/01/2026"
    assert invoice._norm_date("not a date") is None


# ---- multi-product invoices (MS + HSD on one load) -------------------------

def _multi():
    return invoice.extract_fields(MULTI_INVOICE_TEXT)


def test_multi_captures_both_product_lines():
    f = _multi()
    assert len(f.lines) == 2
    assert [(l.column_key, l.qty) for l in f.lines] == [
        (invoice.COLUMN_MS_EBMS, "5"),
        (invoice.COLUMN_HSD, "17"),
    ]


def test_multi_columns_map_has_both_quantities():
    # This is what the note fills in — both columns, not just the first.
    assert _multi().columns == {invoice.COLUMN_MS_EBMS: "5", invoice.COLUMN_HSD: "17"}


def test_multi_first_product_mirrors_fields_for_backcompat():
    f = _multi()
    assert f.product == "MS-BSVI [PDRP]"
    assert f.column_key == invoice.COLUMN_MS_EBMS
    assert f.qty == "5"


def test_multi_value_is_grand_total():
    assert _multi().value == 2193251


def test_multi_is_complete():
    assert invoice.is_complete(_multi()) is True


def test_single_product_columns_has_one_entry():
    # The existing single-product invoice still yields a one-column map.
    assert _fields().columns == {invoice.COLUMN_HSD: "22"}
    assert len(_fields().lines) == 1
