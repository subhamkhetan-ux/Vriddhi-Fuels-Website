"""Reaching FuelTrans' Tank Status page: word matching and the click flow."""
import shutil
import struct
import zlib

import pytest

from tank_stock import navigate as nav


def words(*items):
    return [(t, x, y, 40, 10) for t, x, y in items]


def test_phrases_are_found_in_order_even_with_icons_glued_on():
    seen = words(("#Home", 300, 300), ("@Monitoring", 460, 300), ("~", 540, 300), ("Operations", 600, 300))
    assert nav.find(seen, "monitoring") == [(460, 300, 40, 10)]
    assert nav.find(seen, "operations home") == []


def test_tank_status_page_needs_the_title_and_the_tank_figures():
    page = words(("Tank", 910, 324), ("Status", 950, 324), ("Product", 985, 522), ("Volume", 1025, 522))
    assert nav.on_tank_status(page)
    assert not nav.on_tank_status(page[:2])                     # e.g. a menu item only


def png_with_bar(width=200, height=120, bar=(30, 50)):
    """A white PNG with FuelTrans' blue bar across rows bar[0]..bar[1]."""
    rows = b""
    for y in range(height):
        pixel = bytes(nav.BAR_RGB) if bar[0] <= y < bar[1] else b"\xff\xff\xff"
        rows += b"\x00" + pixel * width
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b""))


@pytest.mark.skipif(not shutil.which("convert"), reason="needs ImageMagick")
def test_the_menu_bar_is_found_by_its_colour():
    assert nav.menu_bar(png_with_bar()) == (0, 30, 200, 50)
    assert nav.menu_bar(png_with_bar(bar=(30, 32))) is None    # a thin line is not the bar


def test_off_page_it_clicks_monitoring_then_tank_status(monkeypatch):
    screens = iter(["other", "menu", "tanks"])
    reads = {
        "other": words(("Daily", 700, 500)),
        "bar": words(("#Home", 300, 300), ("@Monitoring", 460, 300)),
        "menu": words(("Nozzle", 465, 325), ("Status", 520, 325), ("Tank", 465, 347), ("Status", 510, 347)),
        "tanks": words(("Tank", 910, 324), ("Status", 950, 324), ("Product", 985, 522), ("Volume", 1025, 522)),
    }
    monkeypatch.setattr(nav, "menu_bar", lambda png: (280, 294, 1628, 316))
    monkeypatch.setattr(nav, "_size", lambda png: (1920, 1080))
    monkeypatch.setattr(nav, "ocr", lambda png, crop=None, scale=1, psm=11, negate=False:
                        reads["bar" if crop and crop[1] < 300 else png])
    clicks = []
    png, note = nav.ensure_tank_status(lambda: next(screens), lambda x, y: clicks.append((x, y)),
                                       pause=lambda s: None)
    assert note == "opened Monitoring → Tank Status" and png == "tanks"
    assert clicks == [(480, 305), (507, 352)]                   # Monitoring, then the Tank Status item


def test_already_on_tank_status_nothing_is_clicked(monkeypatch):
    monkeypatch.setattr(nav, "ocr", lambda *a, **k: words(("Tank", 1, 1), ("Status", 50, 1),
                                                          ("Product", 1, 9), ("Volume", 50, 9)))
    clicks = []
    assert nav.ensure_tank_status(lambda: "tanks", lambda x, y: clicks.append((x, y)))[1] == "already on Tank Status"
    assert clicks == []


@pytest.mark.skipif(not shutil.which("convert"), reason="needs ImageMagick")
def test_a_picture_of_three_tanks_to_save_has_two_to_a_row():
    from tank_stock import cards
    png = png_with_bar(width=400, height=200, bar=(0, 0))
    boxes = {1: (0, 0, 99, 99), 2: (110, 0, 209, 99), 4: (220, 0, 319, 99)}
    w, h = nav._size(cards.picture(png, boxes, [1, 2, 4], grid=True))
    row, one = nav._size(cards.picture(png, boxes, [1, 2])), nav._size(cards.crop(png, boxes[1]))
    assert (w, h) == (row[0], 2 * one[1] + 16)                 # two cards, then one under them
    assert nav._size(cards.picture(png, boxes, [1, 2], grid=True)) == row   # two: one row


def test_a_heading_whose_number_ocr_lost_takes_its_place_in_the_row():
    from tank_stock import cards
    row = words(("Tank", 910, 324), ("Status", 950, 324),                  # the page title
                ("Tank", 301, 350), ("1:", 340, 350), ("Tank", 640, 350), ("2", 680, 350),
                ("Tank", 979, 350), ("3", 1019, 350), ("Tank", 1318, 350), ("(traGreen", 1360, 350),
                ("Tank", 309, 480), ("Status", 350, 480))                  # a card's own label
    assert sorted(cards.headings(row)) == [1, 2, 3, 4]
    assert cards.headings(row)[4][0] == 1318
    # numbers that don't follow the row's order: only the ones read count
    odd = words(("Tank", 301, 350), ("2", 340, 350), ("Tank", 640, 350), ("(traGreen", 680, 350))
    assert sorted(cards.headings(odd)) == [2]
