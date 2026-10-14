"""Make sure the automation PC shows FuelTrans' Tank Status page.

Usually the PC is already on it. When it isn't, do what a person would:
click "Monitoring" in the blue menu bar, then "Tank Status" in its menu.
The job sees the remote screen only as pixels, so the words are found with
Tesseract (installed on the server for the IOCL CAPTCHA) and clicked with
xdotool; AnyDesk passes the clicks on to the PC.

The menu's white-on-blue text is too small for Tesseract on the whole
screen, so the bar is found by its colour first and read enlarged.
"""
from __future__ import annotations

import re
import shutil
import subprocess
import time

BAR_RGB = (0, 169, 246)          # FuelTrans' menu bar
MENU_ITEM = "tank status"


def _size(png: bytes) -> tuple[int, int]:
    return int.from_bytes(png[16:20], "big"), int.from_bytes(png[20:24], "big")


def _rgb(png: bytes) -> bytes:
    try:
        return subprocess.run(["convert", "png:-", "-depth", "8", "rgb:-"], input=png,
                              capture_output=True, timeout=30).stdout
    except (OSError, subprocess.TimeoutExpired):
        return b""


def _bar_pixel(r: int, g: int, b: int) -> bool:
    return abs(r - BAR_RGB[0]) < 45 and abs(g - BAR_RGB[1]) < 30 and abs(b - BAR_RGB[2]) < 45


def menu_bar(png: bytes) -> tuple[int, int, int, int] | None:
    """(left, top, right, bottom) of the blue menu bar, or None."""
    width, height = _size(png)
    raw = _rgb(png)
    if len(raw) < width * height * 3:
        return None
    rows = []
    for y in range(height):
        row = raw[y * width * 3:(y + 1) * width * 3]
        xs = [x for x in range(0, width, 4) if _bar_pixel(*row[x * 3:x * 3 + 3])]
        rows.append((min(xs), max(xs)) if len(xs) * 4 >= width * 0.3 else None)
    # The longest run of bar rows between 8 and 60 pixels tall.
    best, start = None, None
    for y, hit in enumerate(rows + [None]):
        if hit and start is None:
            start = y
        elif not hit and start is not None:
            if 8 <= y - start <= 60 and (best is None or y - start > best[1] - best[0]):
                best = (start, y)
            start = None
    if not best:
        return None
    lefts, rights = zip(*(rows[y] for y in range(*best)))
    return min(lefts), best[0], max(rights) + 4, best[1]


def ocr(png: bytes, crop=None, scale: int = 1, psm: int = 11, negate: bool = False):
    """Words as (text, x, y, w, h) in screen pixels."""
    if not shutil.which("tesseract"):
        return []
    args = ["convert", "png:-"]
    if crop:
        x, y, w, h = crop
        args += ["-crop", f"{w}x{h}+{x}+{y}", "+repage"]
    if scale != 1:
        args += ["-resize", f"{scale * 100}%"]
    if negate:
        args += ["-colorspace", "Gray", "-negate"]
    try:
        img = subprocess.run(args + ["png:-"], input=png, capture_output=True, timeout=30).stdout
        tsv = subprocess.run(["tesseract", "stdin", "stdout", "--psm", str(psm), "tsv"], input=img,
                             capture_output=True, timeout=60,
                             env={"OMP_THREAD_LIMIT": "1", "PATH": "/usr/bin:/bin"}).stdout
    except (OSError, subprocess.TimeoutExpired):
        return []
    ox, oy = (crop[0], crop[1]) if crop else (0, 0)
    words = []
    for line in tsv.decode(errors="replace").splitlines()[1:]:
        cols = line.split("\t")
        if len(cols) >= 12 and cols[11].strip():
            left, top, w, h = (int(c) for c in cols[6:10])
            words.append((cols[11].strip(), ox + left // scale, oy + top // scale,
                          max(1, w // scale), max(1, h // scale)))
    return words


def _norm(text: str) -> str:
    return re.sub(r"[^a-z0-9]", "", text.lower())


def find(words, phrase: str):
    """Boxes (x, y, w, h) where the phrase's words appear in a row, in order."""
    want = [_norm(p) for p in phrase.split()]
    seen = [(_norm(t), x, y, w, h) for t, x, y, w, h in words]
    seen = [s for s in seen if s[0]]
    hits = []
    for i in range(len(seen) - len(want) + 1):
        run = seen[i:i + len(want)]
        # OCR glues icons onto words ("@Monitoring"): match the word's end.
        if all(got.endswith(w) if j == 0 else got.startswith(w)
               for j, ((got, *_), w) in enumerate(zip(run, want))):
            x0, y0 = run[0][1], min(r[2] for r in run)
            x1 = max(r[1] + r[3] for r in run)
            y1 = max(r[2] + r[4] for r in run)
            hits.append((x0, y0, x1 - x0, y1 - y0))
    return hits


def tank_headings(words) -> int:
    """How many "Tank N : ..." card headings are on screen. They are dark and
    bold, so OCR reads them where it misses the light-grey labels."""
    texts = [_norm(t) for t, *_ in words]
    seen = set()
    for i, t in enumerate(texts):
        if t == "tank" and i + 1 < len(texts) and re.fullmatch(r"[1-9]", texts[i + 1] or ""):
            if i + 2 < len(texts) and words[i + 2][0].strip().startswith(":"):
                seen.add(texts[i + 1])
        elif re.fullmatch(r"tank[1-9]", t) and i + 1 < len(texts) and words[i + 1][0].strip().startswith(":"):
            seen.add(t[-1])
    return len(seen)


def on_tank_status(words) -> bool:
    """The Tank Status page: its title, and the tank cards (their figure labels,
    or, as OCR often misses those light-grey labels on a scaled screen, at
    least two of their "Tank N :" headings)."""
    if not find(words, "tank status"):
        return False
    return bool(find(words, "product volume")) or tank_headings(words) >= 2


def _center(box) -> tuple[int, int]:
    x, y, w, h = box
    return x + w // 2, y + h // 2


def taskbar_button(words, height: int):
    """The FuelTrans button in the PC's taskbar (the bottom of the screen), or None."""
    hits = []
    for i, (text, x, y, w, h) in enumerate(words):
        t, nxt = _norm(text), _norm(words[i + 1][0]) if i + 1 < len(words) else ""
        if "fueltrans" in t or (t.endswith("fuel") and nxt.startswith("trans")):
            hits.append((x, y, w, h))
    low = [b for b in hits if b[1] > height * 0.85]
    return (low or hits or [None])[0]


def _bring_up(png, shoot, click, wake, pause):
    """FuelTrans' menu bar isn't on screen: wake the PC's screen (a
    screensaver, a dimmed or locked display), then bring FuelTrans to the
    front from the taskbar. -> (png, what was done)."""
    done = []
    if wake:
        wake()                                   # the mouse moved and Shift: harmless
        pause(2)
        png = shoot()
        done.append("woke the screen")
        if on_tank_status(ocr(png)) or menu_bar(png):
            return png, done
    button = taskbar_button(ocr(png), _size(png)[1])
    if button:
        click(*_center(button))
        pause(3)
        png = shoot()
        done.append("brought FuelTrans to the front")
    return png, done


def ensure_tank_status(shoot, click, pause=time.sleep, wake=None) -> tuple[bytes, str]:
    """(screenshot, what happened). ``shoot()`` returns a PNG of the screen,
    ``click(x, y)`` clicks there, ``wake()`` wakes the PC's screen."""
    png = shoot()
    if on_tank_status(ocr(png)):
        return png, "already on Tank Status"
    bar = menu_bar(png)
    if not bar:
        png, done = _bring_up(png, shoot, click, wake, pause)
        how = f" ({', then '.join(done)})" if done else ""
        if on_tank_status(ocr(png)):
            return png, f"on Tank Status{how}"
        bar = menu_bar(png)
        if not bar:
            return png, f"not on Tank Status, and FuelTrans' menu bar is not visible{how}"
    left, top, right, bottom = bar
    crop = (left, max(0, top - 3), right - left, bottom - top + 6)
    mon = find(ocr(png, crop, scale=4, psm=6), "monitoring")
    if not mon:
        return png, "not on Tank Status, and 'Monitoring' was not found in the menu bar"
    mx, _ = _center(mon[0])
    click(*_center(mon[0]))
    pause(2)
    menu_png = shoot()
    width, height = _size(menu_png)
    area = (max(0, mx - 200), bottom, min(600, width - max(0, mx - 200)), min(450, height - bottom))
    items = []
    for negate in (False, True):                 # a highlighted item is light-on-dark
        items = find(ocr(menu_png, area, scale=3, psm=11, negate=negate), MENU_ITEM)
        if items:
            break
    if not items:
        click(*_center(mon[0]))                  # close the menu again
        pause(1)
        png = shoot()                            # (a screen with the menu open would hide cards)
        if on_tank_status(ocr(png)):
            return png, "on Tank Status"
        return png, "opened Monitoring, but 'Tank Status' was not in its menu"
    click(*_center(min(items, key=lambda b: b[1])))
    pause(8)                                     # let the page load
    png = shoot()
    if on_tank_status(ocr(png)):
        return png, "opened Monitoring → Tank Status"
    return png, "clicked Monitoring → Tank Status, but the tank cards did not appear"
