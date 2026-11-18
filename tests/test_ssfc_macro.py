"""The Trip Register's SSFC macro (fleet/macros/SSFC_Recon_v9.bas), run for real in LibreOffice's
VBA mode on a made-up workbook: it reads the statement, posts it, and builds the SSFC Check
sheet - whose flags and rupees to claim must then follow corrections to the Trip Register and
HSD Data (the sheet is live: formulas, not fixed text). Skipped where LibreOffice isn't
installed. Made-up vehicles and money only."""

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
HERE = os.path.join(ROOT, "tests", "fixtures", "ssfc_macro")
sys.path.insert(0, HERE)
import book  # noqa: E402


def prop(name, value):
    p = PropertyValue()
    p.Name, p.Value = name, value
    return p


@pytest.fixture(scope="module")
def calc():
    """A LibreOffice with the made-up workbook open and the macro (+ harness) run."""
    tmp = tempfile.mkdtemp(prefix="ssfc-macro-")
    path = os.path.join(tmp, "book.xlsx")
    book.build(path)
    pipe = f"ssfcmacro{os.getpid()}"
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
    cls = open(os.path.join(ROOT, "fleet/macros/SDict.cls")).read()
    std.insertByName("SDict", "Option VBASupport 1\nOption ClassModule\n" + cls[cls.index("Option Explicit"):])
    bas = re.sub(r"^Attribute VB_Name.*\n", "", open(os.path.join(ROOT, "fleet/macros/SSFC_Recon_v9.bas")).read(), flags=re.M)
    std.insertByName("SSFCRecon", "Option VBASupport 1\n" + bas + open(os.path.join(HERE, "harness.bas")).read())
    libs.loadLibrary("Standard")
    script = doc.getScriptProvider().getScript("vnd.sun.star.script:Standard.SSFCRecon.HarnessRun?language=Basic&location=document")
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


def cell(doc, sheet, name):
    return doc.Sheets.getByName(sheet).getCellRangeByName(name)


def check(doc):
    """{trip status row: status}, the rupees to claim, and the sheet's other live columns."""
    doc.calculateAll()
    ws = doc.Sheets.getByName("SSFC Check")
    g = lambda a: ws.getCellRangeByName(a)
    trips = {}
    for r in range(9, 30):
        if not g(f"A{r}").String:
            break
        trips[(g(f"A{r}").String, g(f"L{r}").String)] = (g(f"AB{r}").String, g(f"AA{r}").Value)
    rows = {}
    for r in range(1, 120):
        if g(f"A{r}").String:
            rows[r] = [g(f"{c}{r}").String for c in "ABCDEFGHIJK"]
    return {"claim": g("A5").Value, "trips": trips, "rows": rows}


def test_the_macro_runs_and_builds_the_check_sheet(calc):
    assert cell(calc, "Rates", "H1").String == "done 3 trips, month 2026-09"
    c = check(calc)
    A, B = "XX01AB1001", "XX01AB1002"
    assert c["trips"][(A, "T001")] == ("OK", 0)
    assert c["trips"][(A, "T002")] == ("OK", 0)
    status, claim = c["trips"][(B, "T001")]
    assert (status, claim) == ("UNLOAD SHORTAGE RISK; DIESEL: SSFC MORE", 470)
    texts = [" | ".join(x for x in row if x) for row in c["rows"].values()]
    assert any("T003" in t and "NOT IN THIS STATEMENT" in t for t in texts)              # the trip SSFC didn't pay
    assert any(t.startswith("XX01AB1001 | 2 | 3 |") and "NET DIFFERS" in t for t in texts)
    assert any("URIA AD ABLUE" in t and "NO REFILL OF YOURS FROM SSFC" in t for t in texts)
    assert any("CLEARLUE" in t and "SSFC CHARGED MORE" in t for t in texts)
    # 470 diesel + 2,000 DEF with no refill + 100 DEF price + 3,000 HYDRA with no bill
    assert c["claim"] == 5570
    # posted: cash office in Y, deductions in AD:AK and other labels in AA
    assert cell(calc, "Trip Register", "Y3").Value == 5000
    assert cell(calc, "Trip Register", "AA6").Value == 3000


def test_the_check_sheet_follows_corrections_to_the_register(calc):
    tr = lambda a: cell(calc, "Trip Register", a)
    A, B = "XX01AB1001", "XX01AB1002"
    tr("N3").Value = 1900                                   # a higher rate on 1001's T001
    tr("Q6").Value = 20000                                  # 1002's diesel Q typed wrong
    try:
        c = check(calc)
        assert c["trips"][(A, "T001")] == ("RATE SHORT", 4000)
        assert c["trips"][(B, "T001")][0] == "UNLOAD SHORTAGE RISK; DIESEL: SSFC MORE; CORRECT P/Q"
        assert c["claim"] == 9570
    finally:
        tr("N3").Value = 1800
        tr("Q6").Value = 28670
    c = check(calc)
    assert c["trips"][(A, "T001")] == ("OK", 0) and c["claim"] == 5570


def test_a_fill_on_the_next_trip_is_one_retag_not_a_claim(calc):
    hsd = calc.Sheets.getByName("HSD Data")
    hsd.getCellRangeByName("J4").String = "T001"            # T002's Vriddhi fill tagged to T001
    A = "XX01AB1001"
    try:
        c = check(calc)
        assert c["trips"][(A, "T001")] == ("DIESEL ON NEXT/LAST TRIP - RETAG", 0)
        assert c["trips"][(A, "T002")] == ("DIESEL ON NEXT/LAST TRIP - RETAG", 0)
        assert c["claim"] == 5570
    finally:
        hsd.getCellRangeByName("J4").String = "T002"
    assert check(calc)["trips"][(A, "T001")] == ("OK", 0)
