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
81994.360
KL
409971.80
JIN6   A/R Vat Payable
28.000
%
114792.10
Total for material
524763.90
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
322933.06
Total for material
1668487.48
ZRND  Rounding Difference
-0.38
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


def test_multi_per_product_values_and_prices():
    f = _multi()
    ms, hsd = f.lines[0], f.lines[1]
    assert ms.value == 524764 and hsd.value == 1668487          # "Total for material" each
    assert ms.price_per_kl == round(524764 / 5, 2)              # after-VAT ₹/KL
    assert hsd.price_per_kl == round(1668487 / 17, 2)
    # sanity: MS pricier per KL than HSD here
    assert ms.price_per_kl > hsd.price_per_kl


def test_multi_is_complete():
    assert invoice.is_complete(_multi()) is True


def test_single_product_columns_has_one_entry():
    # The existing single-product invoice still yields a one-column map.
    assert _fields().columns == {invoice.COLUMN_HSD: "22"}
    assert len(_fields().lines) == 1


# ---- Place of Origin (loading terminal) ------------------------------

def test_origin_defaults_to_jharsuguda():
    # The plain sample names no terminal -> the usual Jharsuguda address.
    assert _fields().origin == invoice.DEFAULT_ORIGIN
    assert "Jharsuguda" in _fields().origin


def test_origin_detects_paradeep_terminal():
    txt = INVOICE_TEXT.replace("MALIMUNDA", "PARADEEP TERMINAL")
    assert invoice.extract_fields(txt).origin == "Paradeep Terminal, Paradeep, Odisha"


def test_parse_origin_unknown_falls_back_to_default():
    assert invoice.parse_origin("some invoice with no known terminal") == invoice.DEFAULT_ORIGIN
    assert invoice.parse_origin("") == invoice.DEFAULT_ORIGIN


# ---- /decant: chamber table, compartments, densities, time, seals ----------
# Structure-faithful slice of a real two-product IOCL invoice (pymupdf line
# order): MS in chamber 1 and HSD in chambers 2-5 of a 5-chamber truck, with the
# chamber table ("PL - cm / DIP - Cm QTY - kl") at the foot.
CHAMBER_INVOICE_TEXT = """\
Doc.Name
& number
TAX INVOICE
AC4  31A
7011294526
SAP Entry no.
Road
Delivered
Jharsuguda Terminal
Den@15
 
829.30
PAYER - 338821 VRIDDHI FUELS
OD23U8210
T.T.No.
14:15
Rem.Date/Time
Time
26-Sep-26
Date
14:15
Seal/Lock no: 439 & 440:KEY:BLR T2 439 & BLR T2 440
DUTY PAID
Item  Material Code / Material Description
Quantity Unit
Rate Unit
HSN code
Total
10
16733   EBMS [PDRP]
5.000
KL
2710 12 41.
             BASIC DESTINATION PRICE
5.000
KL
81994.360
KL
409971.80
JIN6   A/R Vat Payable
28.000
%
114792.10
Tank no: SUP1 Comp No(s) 1, Density@15: 748.200
Total for material
524763.90
Sample no: EBMS/IOC/G/T007/2609
20
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
322933.06
Tank no: T002 Comp No(s) 2,3,4,5, Density@15: 829.300
Total for material
1668487.48
Sample no: HSD/JSG/G/T002/2609
ZRND  Rounding Difference
-0.38
Total
2193251.00
PL - cm
DIP - Cm QTY - kl
184.9
140.0
5.00
185.2
145.3
5.00
186.9
144.9
4.00
184.6
149.0
4.00
184.8
136.6
4.00
Captain ID and Name:   ;  
Assistant ID and Name: ;
This Document is Digitally Signed
Date: Sat, Sep 26, 2026 14:15:47 IST
"""


def _chamber_inv():
    return invoice.extract_fields(CHAMBER_INVOICE_TEXT)


def test_chamber_table_parsed_in_order():
    ch = _chamber_inv().chambers
    assert [(c.no, c.pl_cm, c.dip_cm, c.qty_kl) for c in ch] == [
        (1, 184.9, 140.0, 5.0), (2, 185.2, 145.3, 5.0), (3, 186.9, 144.9, 4.0),
        (4, 184.6, 149.0, 4.0), (5, 184.8, 136.6, 4.0)]
    assert sum(c.qty_kl for c in ch) == 22.0


def test_product_compartments_density_and_terminal_tank():
    ms, hsd = _chamber_inv().lines
    assert (ms.compartments, ms.density15, ms.terminal_tank, ms.qty_kl) == ([1], 748.2, "SUP1", 5.0)
    assert (hsd.compartments, hsd.density15, hsd.terminal_tank, hsd.qty_kl) == ([2, 3, 4, 5], 829.3, "T002", 17.0)


def test_invoice_time_density_and_seals():
    f = _chamber_inv()
    assert f.invoice_time == "14:15"            # not the 14:15:47 signature stamp
    assert f.density15 == 829.3
    assert f.seals == "439 & 440:KEY:BLR T2 439 & BLR T2 440"


def test_single_product_invoice_has_no_compartments_but_keeps_chambers():
    # The plain HSD invoice has no "Comp No(s)" (it fills every chamber).
    txt = CHAMBER_INVOICE_TEXT.replace("Comp No(s) 2,3,4,5, ", "")
    hsd = invoice.extract_fields(txt).lines[1]
    assert hsd.compartments == []
    assert len(invoice.extract_fields(txt).chambers) == 5


def test_old_fixture_without_chamber_table_parses_as_before():
    f = _fields()
    assert f.chambers == []
    assert f.invoice_time == "09:39"
    assert f.lines[0].compartments == [] and f.lines[0].qty_kl == 22.0


def test_chamber_table_on_one_line_per_row():
    # pdf renderers sometimes keep a row on one line: "184.9 140.0 5.00"
    lines = ["PL - cm", "DIP - Cm QTY - kl", "184.9 140.0 5.00", "185.2 145.3 5.00", "Captain"]
    assert [c.qty_kl for c in invoice.parse_chambers(lines)] == [5.0, 5.0]


def test_chamber_table_incomplete_row_is_rejected():
    lines = ["DIP - Cm QTY - kl", "184.9", "140.0", "5.00", "185.2", "Captain"]
    assert invoice.parse_chambers(lines) == []
    assert invoice.parse_chambers(["no table here"]) == []


def test_xtragreen_product_line_is_detected():
    txt = INVOICE_TEXT.replace("50703   HSD-BSVI [PDRP]", "50720   XTRAGREEN BS-VI")
    f = invoice.extract_fields(txt)
    assert f.product == "XTRAGREEN BS-VI"
    assert f.column_key == invoice.COLUMN_XTRAGREEN
