"""The decanting result picture the tank stock server draws when its agent
finishes (tank_stock/resultimg.py): the decant app's figures, word for word,
drawn by the decant app's own code."""

import os
from pathlib import Path

import pytest

from tank_stock import decant, resultimg

NAMES = {"T1": "Tank 1", "T2": "Tank 2", "T3": "Tank 3", "T4": "Tank 4"}


def _reading(volume, at, source="photo", via="server"):
    return {"volume": volume, "readingAt": at, "source": source, "via": via}


def _od23u8210():
    """OD23U8210, 17 Nov 2026: C3-5 into Tank 2 (its stock after typed), C1,2 into Tank 3."""
    return {"id": "S17", "tt_no": "OD23U8210", "invoice_no": "7013140165", "created_at": "2026-11-17T04:06:00Z",
            "data": {"invoice": {"invoice_date": "17/11/2026", "invoice_time": "09:36"}, "operator": "Tank stock agent",
                     "prices": {"HSD": 98.15}, "startedAt": "2026-11-17T05:17:00Z", "decantedAt": "2026-11-17T05:38:00Z",
                     "tanks": [
                         {"tank": "T2", "product": "HSD", "chambers": [3, 4, 5], "litres": 12000,
                          "startedAt": "2026-11-17T05:17:00Z", "doneAt": "2026-11-17T05:38:00Z",
                          "before": _reading(5578.99, "2026-11-17T05:15:36Z"),
                          "after": _reading(17638.0, "2026-11-17T05:43:00Z", source="litres", via=None),
                          "result": {"gain": 12059.01, "variation": 59.01, "pct": 0.49, "tol": 30, "band": "watch", "direction": "excess"}},
                         {"tank": "T3", "product": "HSD", "chambers": [1, 2], "litres": 10000,
                          "startedAt": "2026-11-17T05:17:00Z", "doneAt": "2026-11-17T05:36:00Z",
                          "before": _reading(5114.77, "2026-11-17T05:15:37Z"),
                          "after": _reading(15005.89, "2026-11-17T05:37:41Z"),
                          "result": {"gain": 9891.12, "variation": -108.88, "pct": -1.09, "tol": 25, "band": "high", "direction": "short"}}]}}


def test_the_figures_read_as_the_decant_apps_result():
    m = resultimg.model(_od23u8210(), NAMES, decant.dip_chart(), made_at=1794896580)
    assert m["title"] == "OD23U8210" and m["sub"] == "Invoice 7013140165 · 17/11/2026 09:36"
    assert m["total"] == "22 KL" and m["when"] == "17 Nov 2026 · 10:47–11:08" and m["took"] == "21 min"
    assert m["variation"] == "−49.87 L" and m["direction"] == "short"
    assert m["summary"] == "short overall · −0.23% · ≈ −₹4,895 at invoice price"
    t2, t3 = m["tanks"]
    assert (t2["name"], t2["bandLabel"], t2["variation"]) == ("Tank 2", "▲ Excess", "+59.01 L")
    assert t2["pctLine"] == "+0.49% · OK within ±30 L"
    assert t2["meta"] == "C3–5 · 12 KL · 10:47–11:08" and t2["took"] == "21 min"
    assert t2["rows"][0] == ["Stock before · 10:45 · automation screen (server)", "5,578.99 L", "64.0 cm"]
    assert t2["rows"][1][0] == "Stock after · 11:13 · typed, no proof" and t2["rows"][1][1] == "17,638.00 L"
    assert t2["rows"][-1] == ["Variation", "+59.01 L", "₹5,792", True, "excess"]
    assert (t3["bandLabel"], t3["meta"], t3["took"]) == ("✕ High short", "C1,2 · 10 KL · 10:47–11:06", "19 min")
    assert t3["rows"][-1][2] == "−₹10,687"
    assert m["audit"] == {"ok": False, "text": "⚠ Audit: Tank 2 stock after typed in litres — no solid proof."}
    assert m["footer"] == "By Tank stock agent" and m["made"].startswith("Vriddhi Fuels tank stock agent · ")


def test_the_proof_pictures_go_under_it_tank_by_tank_a_missing_one_blank():
    pics = resultimg.proofs(_od23u8210(), NAMES, lambda tank, which: b"" if (tank, which) == ("T2", "after") else b"\xff\xd8jpg")
    assert [(p["label"], p.get("blank", False)) for p in pics] == [
        ("Tank 2 · Stock before", False), ("Tank 2 · Stock after", True), ("Tank 3 · Stock before", False), ("Tank 3 · Stock after", False)]
    assert pics[0]["sub"] == "Screen time 10:45" and pics[1]["sub"] == "No screenshot of it"


def test_formats():
    assert resultimg.fmt_l(1234567.891, 2) == "12,34,567.89 L" and resultimg.fmt_kl(4500) == "4.5 KL"
    assert resultimg.fmt_signed(0) == "±0 L" and resultimg.fmt_money(-0.4) == "−₹0"   # (as the app: the sign before rounding)
    assert resultimg.fmt_duration("2026-11-17T05:17:00Z", "2026-11-17T06:23:00Z") == "1 h 06 min"
    assert resultimg.fmt_duration("2026-11-17T05:17:00Z", None) == ""
    assert resultimg.compact_nos([5, 1, 2, 3]) == "1–3,5"


CHROMIUM = os.environ.get("RESULTIMG_CHROMIUM") or ("/opt/pw-browsers/chromium" if Path("/opt/pw-browsers/chromium").exists() else "")


@pytest.mark.skipif(not CHROMIUM, reason="no Chromium to draw with")
def test_it_is_drawn_by_the_decant_apps_own_code(monkeypatch):
    pytest.importorskip("playwright")
    monkeypatch.setenv("RESULTIMG_CHROMIUM", CHROMIUM)
    from PIL import Image
    import io
    card = io.BytesIO()
    Image.new("RGB", (500, 640), (240, 240, 240)).save(card, "JPEG")
    pics = resultimg.proofs(_od23u8210(), NAMES, lambda tank, which: b"" if (tank, which) == ("T2", "after") else card.getvalue())
    png = resultimg.render(resultimg.model(_od23u8210(), NAMES, decant.dip_chart()), pics)
    img = Image.open(io.BytesIO(png))
    assert img.format == "PNG" and img.width == 1080 and img.height > 2000      # the figures, then the proof pictures
