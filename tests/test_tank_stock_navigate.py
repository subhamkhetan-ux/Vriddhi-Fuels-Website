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


TANKS_PAGE = words(("Tank", 910, 324), ("Status", 950, 324), ("Product", 985, 522), ("Volume", 1025, 522))


def test_a_sleeping_screen_is_woken_first(monkeypatch):
    screens = iter(["dark", "tanks"])
    monkeypatch.setattr(nav, "menu_bar", lambda png: None)
    monkeypatch.setattr(nav, "_size", lambda png: (1920, 1080))
    monkeypatch.setattr(nav, "ocr", lambda png, *a, **k: TANKS_PAGE if png == "tanks" else [])
    woke, clicks = [], []
    png, note = nav.ensure_tank_status(lambda: next(screens), lambda x, y: clicks.append((x, y)),
                                       pause=lambda s: None, wake=lambda: woke.append(1))
    assert png == "tanks" and note == "on Tank Status (woke the screen)" and woke == [1] and clicks == []


def test_fueltrans_behind_another_window_is_brought_up_from_the_taskbar(monkeypatch):
    screens = iter(["desktop", "desktop", "tanks"])
    reads = {"desktop": words(("Files", 40, 1050), ("FuelTrans", 300, 1052), ("Chromium", 360, 1052)), "tanks": TANKS_PAGE}
    monkeypatch.setattr(nav, "menu_bar", lambda png: None)
    monkeypatch.setattr(nav, "_size", lambda png: (1920, 1080))
    monkeypatch.setattr(nav, "ocr", lambda png, *a, **k: reads[png])
    clicks = []
    png, note = nav.ensure_tank_status(lambda: next(screens), lambda x, y: clicks.append((x, y)),
                                       pause=lambda s: None, wake=lambda: None)
    assert png == "tanks" and clicks == [(320, 1057)]
    assert note == "on Tank Status (woke the screen, then brought FuelTrans to the front)"


def test_when_nothing_helps_it_says_what_it_tried(monkeypatch):
    monkeypatch.setattr(nav, "menu_bar", lambda png: None)
    monkeypatch.setattr(nav, "_size", lambda png: (1920, 1080))
    monkeypatch.setattr(nav, "ocr", lambda png, *a, **k: words(("Locked", 900, 500)))
    png, note = nav.ensure_tank_status(lambda: "lock", lambda x, y: None, pause=lambda s: None, wake=lambda: None)
    assert note == "not on Tank Status, and FuelTrans' menu bar is not visible (woke the screen)"


def test_tank_status_is_recognised_by_its_card_headings_when_the_grey_labels_dont_read():
    # The live screen at the server's scale: the title and the bold headings
    # read, the light-grey "Product Volume" labels don't.
    page = words(("Tank", 897, 326), ("Status", 950, 326), ("Tank", 108, 378), ("1", 150, 378), (":", 160, 378),
                 ("Motor", 175, 378), ("Tank", 565, 378), ("2", 607, 378), (":", 617, 378), ("High", 630, 378),
                 ("ONLINE", 250, 567))
    assert nav.tank_headings(page) == 2 and nav.on_tank_status(page)
    assert not nav.on_tank_status(words(("Tank", 897, 326), ("Status", 950, 326)))      # a menu item alone
    assert not nav.on_tank_status(page[2:])                                               # cards, no title


def test_a_menu_that_didnt_show_tank_status_is_closed_and_a_fresh_screen_taken(monkeypatch):
    screens = iter(["other", "menu", "after"])
    reads = {"other": words(("Daily", 700, 500)), "bar": words(("#Home", 300, 300), ("@Monitoring", 460, 300)),
             "menu": words(("Nozzle", 465, 325), ("Status", 520, 325)), "after": words(("Daily", 700, 500))}
    monkeypatch.setattr(nav, "menu_bar", lambda png: (280, 294, 1628, 316))
    monkeypatch.setattr(nav, "_size", lambda png: (1920, 1080))
    monkeypatch.setattr(nav, "ocr", lambda png, crop=None, scale=1, psm=11, negate=False:
                        reads["bar" if crop and crop[1] < 300 else png])
    clicks = []
    png, note = nav.ensure_tank_status(lambda: next(screens), lambda x, y: clicks.append((x, y)), pause=lambda s: None)
    assert png == "after" and note == "opened Monitoring, but 'Tank Status' was not in its menu"
    assert len(clicks) == 2                                        # opened it, closed it again


def test_headings_as_ocr_reads_them_on_the_server_still_count():
    # 1920x1080 over AnyDesk: the colon glued on ("1:") or misread ("2 sel").
    page = words(("Tank", 897, 326), ("Status", 950, 326), ("Tank", 565, 378), ("2", 607, 378), ("sel", 617, 378),
                 ("Tank", 1430, 378), ("4", 1472, 378), ("(traGreen", 1490, 378),
                 ("Tank", 108, 378), ("1:", 150, 378), ("Motor", 175, 378))
    assert nav.tank_headings(page) >= 3 and nav.on_tank_status(page)


def png_with_card(width=500, height=300, box=(100, 60, 400, 260)):
    """A white PNG with one card's light grey border."""
    left, top, right, bottom = box
    rows = b""
    for y in range(height):
        line = b""
        for x in range(width):
            edge = (y in (top, bottom) and left <= x <= right) or (x in (left, right) and top <= y <= bottom)
            line += b"\xdf\xdf\xdf" if edge else b"\xff\xff\xff"
        rows += b"\x00" + line
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b""))


@pytest.mark.skipif(not shutil.which("convert"), reason="needs ImageMagick")
def test_tank_cards_on_screen_are_enough_even_when_the_title_doesnt_read(monkeypatch):
    png = png_with_card()
    heading = words(("Tank", 140, 70), ("3:", 182, 70), ("High", 200, 70))
    assert nav.cards_on(png, heading) == 1 and nav.on_tank_status(heading, png)
    assert not nav.on_tank_status(heading)                         # (the words alone: no title)
    monkeypatch.setattr(nav, "ocr", lambda *a, **k: heading)
    clicks = []
    got, note = nav.ensure_tank_status(lambda: png, lambda x, y: clicks.append((x, y)), pause=lambda s: None)
    assert note == "already on Tank Status" and got == png and clicks == []


def test_an_open_menu_is_closed_with_escape(monkeypatch):
    screens = iter(["first", "menu", "after"])
    reads = {"first": words(("Daily", 700, 500)), "bar": words(("#Home", 300, 300), ("@Monitoring", 460, 300)),
             "menu": words(("Nozzle", 465, 325), ("Status", 520, 325)), "after": words(("Daily", 700, 500))}
    monkeypatch.setattr(nav, "menu_bar", lambda png: (280, 294, 1628, 316))
    monkeypatch.setattr(nav, "_size", lambda png: (1920, 1080))
    monkeypatch.setattr(nav, "ocr", lambda png, crop=None, scale=1, psm=11, negate=False:
                        reads["bar" if crop and crop[1] < 300 else png])
    clicks, escapes = [], []
    png, note = nav.ensure_tank_status(lambda: next(screens), lambda x, y: clicks.append((x, y)),
                                       pause=lambda s: None, escape=lambda: escapes.append(1))
    assert escapes == [1] and len(clicks) == 1                     # opened the menu; Escape closed it
    assert png == "after" and note == "opened Monitoring, but 'Tank Status' was not in its menu"
