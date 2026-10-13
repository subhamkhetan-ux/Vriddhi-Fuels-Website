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


def headings(words):
    """{tank number: (x, y, w, h) of the word "Tank"} for "Tank N :" headings."""
    found = {}
    for i, (text, x, y, w, h) in enumerate(words):
        if re.sub(r"[^a-z]", "", text.lower()) != "tank":
            continue
        nxt = words[i + 1][0] if i + 1 < len(words) else ""
        m = re.match(r"(\d)\s*:?$", nxt)
        if m and words[i + 1][2] < y + h:            # same line
            found.setdefault(int(m.group(1)), (x, y, w, h))
    return found


def card_boxes(png: bytes, words) -> dict:
    """{tank number: (left, top, right, bottom)} of each card's border."""
    px = Pixels(png)
    if not px.ok:
        return {}
    boxes = {}
    for no, (hx, hy, hw, hh) in headings(words).items():
        col = hx + hw // 2
        top = next((y for y in range(hy - 1, max(0, hy - 30), -1) if px.border(col, y)), None)
        if top is None:
            continue
        left = right = col
        while left > 0 and any(px.border(left - 1, top + d) for d in (-1, 0, 1, 2)):
            left -= 1
        while right < px.width - 1 and any(px.border(right + 1, top + d) for d in (-1, 0, 1, 2)):
            right += 1
        if right - left < 100:
            continue
        # The bottom border, below the card's last row ("Temperature").
        temps = [y + h for t, x, y, w, h in words
                 if t.lower().startswith("temper") and left <= x <= right and y > top]
        start = max(temps) + 2 if temps else top + int((right - left) * 0.9)
        mid = (left + right) // 2
        bottom = next((y for y in range(start, min(px.height, start + 200)) if px.border(mid, y)), None)
        if bottom is None:
            bottom = min(px.height - 1, start + 12)
        # The run along the top stops where the rounded corners bend down.
        boxes[no] = (max(0, left - 6), top, min(px.width - 1, right + 6), bottom)
    return boxes


def crop(png: bytes, box, scale: int = 2, margin: int = 4) -> bytes:
    left, top, right, bottom = box
    left, top = max(0, left - margin), max(0, top - margin)
    w, h = right - left + 1 + 2 * margin, bottom - top + 1 + 2 * margin
    return _convert(png, ["-crop", f"{w}x{h}+{left}+{top}", "+repage", "-resize", f"{scale * 100}%"])


def picture(png: bytes, boxes: dict, tanks, stack: bool = False) -> bytes:
    """The asked-for tanks' cards zoomed in: side by side, or one under
    another (``stack``, for a phone)."""
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
        # 16 px of white between cards: splice it before each, then trim the first.
        gap = "0x16" if stack else "16x0"
        args = ["convert", *files, "-background", "white", "-splice", gap,
                "-append" if stack else "+append", "-chop", gap, "png:-"]
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


def read_all(png: bytes) -> tuple[dict, dict]:
    """({tank number: card box}, {tank number: figures}) for a Tank Status screenshot."""
    boxes = card_boxes(png, ocr(png))
    return boxes, {no: read_card(png, box) for no, box in boxes.items()}
