"""The tank cards on FuelTrans' Tank Status page: where they are, a zoomed
picture of the ones asked for, and the figures on each.

Each card is a white box with a light grey border:

    Tank 3 : High Speed Diesel
    (tank picture)
    Last Updated @ 10/13/2026 18:01:54
    Tank Status
    Tank Capacity   20,000.00 ltr
    Product Volume  19,552.05 ltr
    Product Height   1,780.37 mm
    Water Volume         0.00 ltr
    Ullage Space       447.95 ltr
    Density            894.30 kg/m^3
    Density (tc)       906.00 kg/m^3
    Temperature         32.40

Cards are found from their "Tank N" headings (OCR) and traced along their
border. Each card is read twice, enlarged: as it is, which gives the
figures cleanly but drops the light grey labels, and thresholded, which
gives the labels and the "Last Updated" time.
"""
from __future__ import annotations

import hashlib
import os
import re
import subprocess
import tempfile

from .navigate import _rgb, _size, ocr

FIELDS = ("capacity", "volume", "height", "water", "ullage", "density", "densityTc", "temp")
LABELS = (                      # (pattern on the label, field); order matters
    (r"capa", "capacity"), (r"heig", "height"), (r"wat", "water"), (r"ull|space", "ullage"),
    (r"temp", "temp"), (r"dens.*\(?tc", "densityTc"), (r"dens", "density"), (r"prod|volu", "volume"),
)
PRODUCTS = ((r"motor\s*spir", "MS"), (r"high\s*spe|speed\s*die", "HSD"), (r"xtra\s*gr", "XG"))
NUMBER = re.compile(r"\d{1,3}(?:,\d{3})*\.\d{1,3}|\d+\.\d{1,3}")
TIME = re.compile(r"(\d{1,2})/(\d{1,2})/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?")


class Pixels:
    def __init__(self, png: bytes):
        self.width, self.height = _size(png)
        self.raw = _rgb(png)
        self.ok = len(self.raw) >= self.width * self.height * 3 > 0

    def at(self, x: int, y: int):
        if not (0 <= x < self.width and 0 <= y < self.height):
            return (255, 255, 255)
        i = (y * self.width + x) * 3
        return tuple(self.raw[i:i + 3])

    def border(self, x: int, y: int) -> bool:
        """The cards' light grey border (rgb ~223)."""
        r, g, b = self.at(x, y)
        return max(r, g, b) - min(r, g, b) <= 10 and 195 <= (r + g + b) / 3 <= 240


PRODUCT_WORD = re.compile(r"motor|spirit|high|speed|diesel|xtra|tra|green", re.I)


def headings(words):
    """{tank number: (x, y, w, h) of the word "Tank"} for the "Tank N : Product"
    headings. OCR sometimes loses the number ("Tank (traGreen"); the cards
    stand in one row in tank order, so such a heading takes its place in the
    row, when the numbers that were read agree with that order."""
    found = []
    for i, (text, x, y, w, h) in enumerate(words):
        if re.sub(r"[^a-z]", "", text.lower()) != "tank" or i + 1 >= len(words):
            continue
        nxt, ny = words[i + 1][0], words[i + 1][2]
        if ny >= y + h:                                  # not on the same line
            continue
        m = re.match(r"(\d)\s*[:;.]?$", nxt)
        if m or PRODUCT_WORD.search(nxt):
            found.append((x, y, w, h, int(m.group(1)) if m else None))
    if not found:
        return {}
    # the headings' row (the cards' own "Tank Status" labels sit lower)
    row_y = sorted(y for _, y, _, _, _ in found)[0]
    row = sorted((f for f in found if abs(f[1] - row_y) <= 12), key=lambda f: f[0])
    in_order = all(num == i + 1 for i, (*_, num) in enumerate(row) if num is not None)
    out = {}
    for i, (x, y, w, h, num) in enumerate(row):
        no = num if num is not None else (i + 1 if in_order else None)
        if no is not None:
            out.setdefault(no, (x, y, w, h))
    return out


GAP = 6            # pixels of a border line that may be missing (compression, a cursor)
CARD_HEIGHT = 1.05  # a card is about this much taller than it is wide


def _run(px: Pixels, y: int, x: int) -> tuple[int, int]:
    """(left, right) of the border line through (x, y), across small gaps."""
    def on(x):
        return any(px.border(x, y + d) for d in (-1, 0, 1))
    left = right = x
    while left > 0 and any(on(left - k) for k in range(1, GAP + 1)):
        left -= next(k for k in range(1, GAP + 1) if on(left - k))
    while right < px.width - 1 and any(on(right + k) for k in range(1, GAP + 1)):
        right += next(k for k in range(1, GAP + 1) if on(right + k))
    return left, right


def _top(px: Pixels, hx: int, hy: int, hw: int):
    """(left, top, right) of the card's top border above a heading: the
    longest line in the 30 rows above it, or None."""
    best = None
    for y in range(hy - 1, max(0, hy - 30), -1):
        col = next((c for c in range(hx, hx + hw) if px.border(c, y)), None)
        if col is None:
            continue
        left, right = _run(px, y, col)
        if best is None or right - left > best[2] - best[0]:
            best = (left, y, right)
    return best if best and best[2] - best[0] >= 100 else None


def _share(px: Pixels, y: int, left: int, right: int) -> float:
    """How much of a row, inside the card's sides, is border line."""
    xs = range(left + (right - left) // 10, right - (right - left) // 10, 2)
    return sum(any(px.border(x, y + d) for d in (-1, 0, 1)) for x in xs) / max(1, len(xs))


def _bottom(px: Pixels, words, left: int, top: int, right: int):
    """The card's bottom border, below its last row ("Temperature"), or None."""
    temps = [y + h for t, x, y, w, h in words if t.lower().startswith("temper") and left <= x <= right and y > top]
    start = max(temps) + 2 if temps else top + int((right - left) * 0.9)
    for y in range(start, min(px.height - 1, start + (right - left) // 2)):
        if _share(px, y, left, right) >= 0.5:
            return y
    return None


def _snap(px: Pixels, top: int, left: int, width: int):
    """The left end of a card's top line near ``left``, or None if no card's
    top line is there."""
    if left < -width * 0.1 or left + width > px.width * 1.1:
        return None
    for d in (0, -1, 1, -2, 2, -3, 3):
        mid = min(px.width - 1, max(0, left + width // 2))
        if not px.border(mid, top + d) and not any(px.border(mid + k, top + d) for k in range(-GAP, GAP + 1)):
            continue
        col = next(mid + k for k in sorted(range(-GAP, GAP + 1), key=abs) if px.border(mid + k, top + d))
        l, r = _run(px, top + d, col)
        if r - l >= width * 0.9 and abs(l - left) <= width * 0.12:
            return l
    return None


def _median(values):
    values = sorted(values)
    return values[len(values) // 2]


def card_boxes(png: bytes, words) -> dict:
    """{tank number: (left, top, right, bottom)} of each card's border.

    The cards stand in one row, all the same size and evenly spaced. Each
    card's border is traced from its heading; a border that didn't trace
    (a gap in the grey line, a heading OCR missed) takes the others' size and
    place in the row."""
    px = Pixels(png)
    heads = headings(words)
    if not px.ok or not heads:
        return {}
    nums = sorted(heads)
    steps = [(heads[b][0] - heads[a][0]) / (b - a) for a, b in zip(nums, nums[1:])]
    pitch = _median(steps) if steps else None
    if pitch is not None and pitch < 100:
        pitch = None
    tops = {no: _top(px, hx, hy, hw) for no, (hx, hy, hw, hh) in heads.items()}
    fits = {no: t for no, t in tops.items()
            if t and (pitch is None or 0.7 * pitch <= t[2] - t[0] <= pitch)}
    if fits:
        ref = max(fits, key=lambda no: fits[no][2] - fits[no][0])
        width = fits[ref][2] - fits[ref][0]
        dx, dy = fits[ref][0] - heads[ref][0], fits[ref][1] - heads[ref][1]
    elif pitch:
        ref, width, dx, dy = nums[0], int(pitch * 0.94), -int(pitch * 0.04), -int(pitch * 0.03)
    else:
        return {}
    if pitch is None:
        pitch = width / 0.94            # (one heading read: the cards' spacing from its width)
    # Cards whose heading OCR missed: a card's width along from its
    # neighbour, if its top border is there (each found card is the next
    # one's neighbour, so the spacing's error doesn't add up).
    hy0, hw0, hh0 = heads[ref][1:]
    top = hy0 + dy
    for way in (-1, 1):
        no, hx = ref + way, heads[ref][0]
        while 1 <= no <= 9:
            if no in heads:
                hx = heads[no][0]
            else:
                hx = int(hx + way * pitch)
                left = _snap(px, top, hx + dx, width)
                if left is None:
                    break
                hx = left - dx
                heads[no] = (hx, hy0, hw0, hh0)
            no += way
    # A trace cut short, or on another line, takes the row's size and place
    # (the cards' tops are one line).
    row_top = _median([t[1] for t in fits.values()]) if fits else None
    found = {}
    for no, (hx, hy, hw, hh) in heads.items():
        t = fits.get(no)
        top = row_top if row_top is not None else hy + dy
        if t and t[2] - t[0] >= width * 0.97 and abs(t[1] - top) <= 3:
            found[no] = t
        else:
            left = _snap(px, top, hx + dx, width)
            left = hx + dx if left is None else left
            left = min(max(0, left), px.width - 1 - width)
            found[no] = (left, top, left + width)
    bottoms = {no: _bottom(px, words, *found[no]) for no in found}
    seen = [b - found[no][1] for no, b in bottoms.items() if b is not None]
    height = _median(seen) if seen else int(width * CARD_HEIGHT)
    boxes = {}
    for no, (left, top, right) in found.items():
        bottom = bottoms[no]
        if bottom is None or abs(bottom - top - height) > width * 0.05:
            bottom = min(px.height - 1, top + height)
        # The line along the top stops where the rounded corners bend down.
        boxes[no] = (max(0, left - 4), top, min(px.width - 1, right + 4), bottom)
    return boxes


def crop(png: bytes, box, scale: int = 2, margin: int = 1) -> bytes:
    left, top, right, bottom = box
    left, top = max(0, left - margin), max(0, top - margin)
    w, h = right - left + 1 + 2 * margin, bottom - top + 1 + 2 * margin
    return _convert(png, ["-crop", f"{w}x{h}+{left}+{top}", "+repage", "-resize", f"{scale * 100}%"])


def picture(png: bytes, boxes: dict, tanks, stack: bool = False, grid: bool = False) -> bytes:
    """The asked-for tanks' cards zoomed in: side by side, one under another
    (``stack``, for a phone screen) or two to a row (``grid``, for a picture
    to save or send)."""
    parts = [crop(png, boxes[n]) for n in sorted(tanks) if n in boxes]
    parts = [p for p in parts if p]
    if not parts:
        return b""
    if len(parts) == 1:
        return parts[0]
    with tempfile.TemporaryDirectory() as tmp:
        files = []
        for i, p in enumerate(parts):
            files.append(os.path.join(tmp, f"{i}.png"))
            with open(files[-1], "wb") as f:
                f.write(p)
        if grid and len(files) > 2:
            rows = [_join(files[i:i + 2], across=True) for i in range(0, len(files), 2)]
            return _join(rows, across=False, data=True)
        return _join(files, across=not stack)


def _join(items, across: bool, data: bool = False) -> bytes:
    """Pictures (paths, or PNG bytes with ``data``) joined with 16 px of white."""
    with tempfile.TemporaryDirectory() as tmp:
        files = items
        if data:
            files = []
            for i, p in enumerate(items):
                files.append(os.path.join(tmp, f"r{i}.png"))
                with open(files[-1], "wb") as f:
                    f.write(p)
        # 16 px of white between pictures: splice it before each, then trim the first.
        gap = "16x0" if across else "0x16"
        args = ["convert", *files, "-background", "white", "-splice", gap,
                "+append" if across else "-append", "-chop", gap, "png:-"]
        try:
            return subprocess.run(args, capture_output=True, timeout=60).stdout
        except (OSError, subprocess.TimeoutExpired):
            return b""


def to_jpeg(png: bytes, quality: int = 85) -> bytes:
    """A smaller file for the decant app's proof pictures."""
    try:
        out = subprocess.run(["convert", "png:-", "-quality", str(quality), "jpg:-"], input=png,
                             capture_output=True, timeout=60).stdout
    except (OSError, subprocess.TimeoutExpired):
        return b""
    return out if out.startswith(b"\xff\xd8") else b""


def _convert(png: bytes, ops) -> bytes:
    try:
        out = subprocess.run(["convert", "png:-", *ops, "png:-"], input=png,
                             capture_output=True, timeout=60).stdout
    except (OSError, subprocess.TimeoutExpired):
        return b""
    return out if out.startswith(b"\x89PNG") else b""


def _num(text: str):
    m = NUMBER.search(text)
    return float(m.group(0).replace(",", "")) if m else None


def parse_values(text: str) -> dict:
    """The plain pass: the eight figures in card order, told apart by unit."""
    nums = []
    for line in text.splitlines():
        if TIME.search(line):
            continue
        v = _num(line)
        if v is not None:
            nums.append(v)
    return dict(zip(FIELDS, nums)) if len(nums) == len(FIELDS) else {}


def parse_labelled(text: str) -> dict:
    """The thresholded pass: label -> figure, plus heading, product and time."""
    out = {}
    for line in text.splitlines():
        low = line.lower()
        m = re.search(r"tank\s*(\d)\s*:\s*(.*)", low)
        if m and "no" not in out:
            out["no"] = int(m.group(1))
            for pat, key in PRODUCTS:
                if re.search(pat, m.group(2)):
                    out["product"] = key
            continue
        t = TIME.search(line)
        if t and "updated" in low:
            out["time"] = t.groups()
            continue
        v = _num(line)
        if v is None:
            continue
        label = NUMBER.split(low)[0]
        for pat, key in LABELS:
            if re.search(pat, label) and key not in out:
                out[key] = v
                break
    return out


def read_card(png: bytes, box) -> dict:
    """Figures on one card: {no, product, time, capacity, volume, ...,
    disagree: [fields the two passes read differently]}."""
    left, top, right, bottom = box
    region = (left, top, right - left + 1, bottom - top + 1)
    a = parse_values(ocr_text(png, region))
    b = parse_labelled(ocr_text(png, region, threshold=True))
    card = {k: b[k] for k in ("no", "product", "time") if k in b}
    disagree = []
    for f in FIELDS:
        va, vb = a.get(f), b.get(f)
        if va is not None and vb is not None and abs(va - vb) > 0.005:
            disagree.append(f)
        card[f] = va if va is not None else vb
    card["disagree"] = disagree
    return card


def ocr_text(png: bytes, region, threshold: bool = False) -> str:
    x, y, w, h = region
    ops = ["-crop", f"{w}x{h}+{x}+{y}", "+repage", "-resize", "300%"]
    if threshold:
        ops += ["-colorspace", "Gray", "-threshold", "85%"]
    img = _convert(png, ops)
    if not img:
        return ""
    try:
        return subprocess.run(["tesseract", "stdin", "stdout", "--psm", "6"], input=img,
                              capture_output=True, timeout=60,
                              env={"OMP_THREAD_LIMIT": "1", "PATH": "/usr/bin:/bin"}).stdout.decode(errors="replace")
    except (OSError, subprocess.TimeoutExpired):
        return ""


# Where the parts of a card are, as a share of its height.
FIGURES_FROM = 0.36    # the "Last Updated" line ...
FIGURES_TO = 0.80      # ... to "Ullage Space": what a live read reads
STEADY_FROM = 0.50     # "Tank Capacity" to "Ullage Space": the rows the volume is in


def read_figures(png: bytes, box) -> dict:
    """A live read: one thresholded pass from the Last Updated time down to
    the ullage (volume, height and ullage, for the decant app's sum and
    dip-chart checks of the volume; density and temperature aren't read)."""
    left, top, right, bottom = box
    y0 = top + int((bottom - top) * FIGURES_FROM)
    y1 = top + int((bottom - top) * FIGURES_TO)
    card = parse_labelled(ocr_text(png, (left, y0, right - left + 1, y1 - y0 + 1), threshold=True))
    card["disagree"] = []
    return card


def fingerprint(px: Pixels, box) -> str:
    """Changes when the rows the volume is in change on screen (not when the
    "Last Updated" clock ticks or the temperature moves), so an unchanged
    card needn't be read again."""
    left, top, right, bottom = box
    h = hashlib.sha1()
    for y in range(top + int((bottom - top) * STEADY_FROM), top + int((bottom - top) * FIGURES_TO)):
        i = (y * px.width + left) * 3
        h.update(px.raw[i:i + (right - left) * 3])
    return h.hexdigest()


def read_all(png: bytes) -> tuple[dict, dict]:
    """({tank number: card box}, {tank number: figures}) for a Tank Status screenshot."""
    boxes = card_boxes(png, ocr(png))
    return boxes, {no: read_card(png, box) for no, box in boxes.items()}
