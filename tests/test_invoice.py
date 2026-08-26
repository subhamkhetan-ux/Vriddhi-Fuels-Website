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
