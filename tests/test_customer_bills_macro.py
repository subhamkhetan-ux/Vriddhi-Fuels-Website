"""The Customer bills macro (ledger/macros/CustomerBills.bas), run for real in LibreOffice's VBA mode
on a made-up Master Ledger: a customer's October HSD bills split by vehicle tag (one page per tag,
A-Z; a word in the Vehicle column as its own tag; untagged vehicles listed on Bill Setup), the
SCPL-style page (Bill To from the ledger sheet, Date from/To, Vehicles / Product, the table, the
red TOTAL, the payment details), then the same customer on one page with HSD and MS. The dialogs
and the PDF export are Excel's, so they're left out. Skipped where LibreOffice isn't installed."""

import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time

import pytest

uno = pytest.importorskip("uno")
if not shutil.which("soffice"):
    pytest.skip("LibreOffice isn't installed", allow_module_level=True)

from com.sun.star.beans import PropertyValue  # noqa: E402  (after the skip: needs LibreOffice)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HERE = os.path.join(ROOT, "tests", "fixtures", "customer_bills")
sys.path.insert(0, HERE)
import book  # noqa: E402


def prop(name, value):
    p = PropertyValue()
    p.Name, p.Value = name, value
    return p


@pytest.fixture(scope="module")
def calc():
    """A LibreOffice with the made-up workbook open and the macro (+ harness) run."""
    tmp = tempfile.mkdtemp(prefix="cb-macro-")
    path = os.path.join(tmp, "book.xlsx")
    book.build(path)
    pipe = f"cbmacro{os.getpid()}"
    proc = subprocess.Popen(["soffice", "--headless", "--invisible", "--norestore", "--nolockcheck",
                             f"-env:UserInstallation=file://{tmp}/profile", f"--accept=pipe,name={pipe};urp;"],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    ctx = None
    for _ in range(90):
        try:
            local = uno.getComponentContext()
            resolver = local.ServiceManager.createInstanceWithContext("com.sun.star.bridge.UnoUrlResolver", local)
            ctx = resolver.resolve(f"uno:pipe,name={pipe};urp;StarOffice.ComponentContext")
            break
        except Exception:
            time.sleep(1)
    assert ctx, "LibreOffice didn't start"
    desk = ctx.ServiceManager.createInstanceWithContext("com.sun.star.frame.Desktop", ctx)
    # shown (not hidden): the VBA layer's End(xlUp) needs a view
    doc = desk.loadComponentFromURL(f"file://{path}", "_blank", 0, (prop("Hidden", False), prop("MacroExecutionMode", 4)))
    libs = doc.BasicLibraries
    libs.VBACompatibilityMode = True
    std = libs.getByName("Standard")
    bas = re.sub(r"^Attribute VB_Name.*\n", "", open(os.path.join(ROOT, "ledger/macros/CustomerBills.bas")).read(), flags=re.M)
    std.insertByName("CustomerBills", "Option VBASupport 1\n" + bas + open(os.path.join(HERE, "harness.bas")).read())
    libs.loadLibrary("Standard")
    script = doc.getScriptProvider().getScript("vnd.sun.star.script:Standard.CustomerBills.HarnessRun?language=Basic&location=document")
    run = threading.Thread(target=lambda: script.invoke((), (), ()), daemon=True)
    run.start()
    run.join(180)
    try:
        yield doc
    finally:
        try:
            doc.close(True)
            desk.terminate()
        except Exception:
            pass
        proc.kill()
        shutil.rmtree(tmp, ignore_errors=True)


def h(doc, a):
    return doc.Sheets.getByName("Harness").getCellRangeByName(a).String


def rows(doc, sheet, last):
    ws = doc.Sheets.getByName(sheet)
    out = []
    for r in range(last):
        vals = [ws.getCellByPosition(c, r).String for c in range(1, 7)]
        out.append(" | ".join(v for v in vals if v))
    return [x for x in out if x]


def test_the_macro_runs(calc):
    assert h(calc, "A12") == "done", h(calc, "A12")


def test_collects_splits_and_lists_untagged(calc):
    assert h(calc, "A1") == "2026-10-01|2026-10-31"                       # last whole month
    # 7 tagged bills (JSW 3, 700 Acre 2, Plant Yard 1 … ) on 3 pages; 2 untagged (OD99XX3003, no vehicle)
    assert h(calc, "A2") == "6|3|2"
    assert h(calc, "A3") == "1|0"                                         # OD99XX3003 added once, not twice
    setup = calc.Sheets.getByName("Bill Setup")
    listed = [setup.getCellRangeByName(f"K{r}").String for r in range(4, 10)]
    assert "OD99XX3003" in listed


def test_helpers(calc):
    assert h(calc, "A4") == "Demo Logistics Bill Oct 2026|A B Co Bill 1-10 Nov 2026|X Bill 25 Oct-5 Nov 2026"
    assert h(calc, "A5") == "25,23,100|1,08,369.44|999|12,34,567.50"
    assert h(calc, "A6") == "True|True|True|False|False|False"
    assert h(calc, "A7") == "2026-11-01|2026-11-10"                       # 10 days, as SCPL
    assert h(calc, "A8") == "2026-11-21|2026-11-30"


def test_the_bill_pages(calc):
    text = rows(calc, "Bill1", int(float(h(calc, "A9"))))
    joined = "\n".join(text)
    # a page per tag, A-Z: 700 Acre, JSW, Plant Yard
    assert [t for t in text if t.startswith("Vehicles:")] == ["Vehicles: 700 Acre | Product: HSD", "Vehicles: JSW | Product: HSD", "Vehicles: Plant Yard | Product: HSD"]
    # Bill To from the ledger sheet; Date from / To / to
    assert "Bill To | Date: | 01-10-2026" in text
    assert "Demo Logistics | To" in text
    assert "Sample Depot, Testpur. | 31-10-2026" in text
    assert "GSTIN: 21AAAFD0000L1Z5" in text
    # JSW: by date then bill no.; the same vehicle typed two ways; the TOTAL
    jsw = text[text.index("Vehicles: JSW | Product: HSD"):]
    assert jsw[1] == "Date | Bill No | Vehicle | Quantity | Rate/Ltr | Amount"
    assert jsw[2:5] == ["02/10/26 | 33 | OD99ZZ1001 | 1500 | 100.24 | 1,50,360", "05/10/26 | 63 | od 99 zz-1001 | 1500 | 100.24 | 1,50,360",
                        "06/10/26 | 77 | OD99ZZ1001 | 999 | 100.24 | 1,00,139.76"]
    assert jsw[5] == "TOTAL | 3999.00 | ₹4,00,859.76"
    acre = text[text.index("Vehicles: 700 Acre | Product: HSD"):]
    assert acre[2:4] == ["04/10/26 | 50 | OD99YY2002 | 2000 | 100.24 | 2,00,480", "05/10/26 | 9 | OD99YY2002 | 2000 | 100.24 | 2,00,480"]
    # the payment details and the footer on every page; other customers / months left out
    assert joined.count("Payment Details:") == 3
    assert joined.count("IFSC Code – ICIC0000468") == 3
    assert joined.count("For VRIDDHI FUELS | Signature of Customer") == 3
    assert "X1" not in joined and "101000" not in joined and "OD99XX3003" not in joined


def test_one_page_with_hsd_and_ms(calc):
    assert h(calc, "A10") == "9|2|0"                                      # every bill (8 HSD + 1 MS), a page per product
    text = rows(calc, "Customer Bill", int(float(h(calc, "A11"))))
    assert [t for t in text if t.startswith("Product:")] == ["Product: HSD", "Product: MS"]
    assert not any(t.startswith("Vehicles:") for t in text)
    assert "GSTIN: 21ZZZZZ9999Z1Z9" in text                              # typed on Bill Setup, over the sheet's
    assert "07/10/26 | MS5 | OD99ZZ1001 | 40 | 105.50 | 4,220" in text
