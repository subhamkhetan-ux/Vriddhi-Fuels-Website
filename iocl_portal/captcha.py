"""Local OCR for a text CAPTCHA; a failed/uncertain read stops the job."""
from __future__ import annotations

from collections import Counter
import csv
import io
import re
import shutil
import subprocess

from .statement import PortalError


def ocr_candidate(tsv: str, length: int = 6) -> str | None:
    words = []
    try:
        for row in csv.DictReader(io.StringIO(tsv), delimiter="\t"):
            text = (row.get("text") or "").strip()
            if not text:
                continue
            if float(row.get("conf", "-1")) < 35 or not re.fullmatch(r"[A-Z0-9]+", text):
                return None
            words.append(text)
    except (TypeError, ValueError, csv.Error):
        return None
    answer = "".join(words)
    return answer if re.fullmatch(r"[A-Z0-9]{" + str(length) + r"}", answer) else None


OCR_MODES = (7, 8, 13)


def ocr_reads(png: bytes, *, length: int = 6) -> list[dict]:
    """One Tesseract read per page-segmentation mode: the raw TSV and the
    accepted answer (or None). Also used by ``--captcha-sample`` diagnostics."""
    if not 4 <= length <= 10:
        raise PortalError("IOCL_CAPTCHA_LENGTH must be between 4 and 10.")
    binary = shutil.which("tesseract")
    if not binary:
        raise PortalError("Install Tesseract OCR to read the portal's text CAPTCHA.")
    if len(png) > 2_000_000:
        raise PortalError("The CAPTCHA image is unexpectedly large.")
    reads = []
    for mode in OCR_MODES:
        try:
            result = subprocess.run(
                [binary, "stdin", "stdout", "--psm", str(mode),
                 "-c", "tessedit_char_whitelist=ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", "tsv"],
                input=png, capture_output=True, timeout=15, check=False)
        except (subprocess.TimeoutExpired, OSError):
            raise PortalError("Local CAPTCHA recognition did not complete.") from None
        tsv = result.stdout.decode("utf-8", "replace") if result.returncode == 0 else ""
        reads.append({"psm": mode, "tsv": tsv,
                      "answer": ocr_candidate(tsv, length) if tsv else None})
    return reads


# e-Mitra's CAPTCHA (sampled live, 150x40): six slanted blue capitals crossed
# by thin lines. Each variant enlarges it, keeps the ink, erases strokes
# thinner than ``line_width`` (the lines) and un-slants the letters:
# (scale, ink threshold, line_width, shear).
CLEAN_VARIANTS = (
    (4, 200, 7, -0.15),
    (4, 230, 9, -0.25),
    (5, 215, 9, -0.15),
    (5, 230, 11, -0.25),
    (5, 215, 9, 0.0),
)
CLEAN_MODES = (7, 8)
LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
# An answer is used only with this many matching reads and at least twice the
# votes of the runner-up; anything less stops before the login is submitted.
MIN_VOTES = 4


def clean_captcha(png: bytes, scale: int, threshold: int, line_width: int, shear: float) -> bytes:
    try:
        from PIL import Image, ImageFilter, ImageOps
    except ImportError:
        raise PortalError("Install Pillow (iocl_portal/requirements.txt) to read the CAPTCHA.") from None
    try:
        image = Image.open(io.BytesIO(png))
        image.load()
    except Exception:
        raise PortalError("The CAPTCHA image could not be decoded.") from None
    if image.mode in ("RGBA", "LA", "P"):
        image = image.convert("RGBA")
        backdrop = Image.new("RGBA", image.size, "white")
        image = Image.alpha_composite(backdrop, image)
    gray = image.convert("L")
    w, h = gray.width * scale, gray.height * scale
    gray = gray.resize((w, h), Image.BICUBIC)
    ink = gray.point(lambda v: 255 if v < threshold else 0)
    if line_width:
        ink = ink.filter(ImageFilter.MinFilter(line_width)).filter(ImageFilter.MaxFilter(line_width))
    if shear:
        ink = ink.transform((w + int(h * abs(shear)), h), Image.AFFINE,
                            (1, shear, -h * shear if shear < 0 else 0, 0, 1, 0), Image.BILINEAR)
    out = ImageOps.expand(ImageOps.invert(ink), border=20, fill=255)
    buf = io.BytesIO()
    out.save(buf, "PNG")
    return buf.getvalue()


def captcha_votes(png: bytes, *, length: int = 6, charset: str = LETTERS) -> list[str]:
    """Every well-formed read across the cleaning variants and layouts."""
    if not 4 <= length <= 10:
        raise PortalError("IOCL_CAPTCHA_LENGTH must be between 4 and 10.")
    binary = shutil.which("tesseract")
    if not binary:
        raise PortalError("Install Tesseract OCR to read the portal's text CAPTCHA.")
    if len(png) > 2_000_000:
        raise PortalError("The CAPTCHA image is unexpectedly large.")
    pattern = re.compile("[" + re.escape(charset) + "]{" + str(length) + "}")
    votes = []
    for variant in CLEAN_VARIANTS:
        cleaned = clean_captcha(png, *variant)
        for mode in CLEAN_MODES:
            try:
                result = subprocess.run(
                    [binary, "stdin", "stdout", "--psm", str(mode),
                     "-c", "tessedit_char_whitelist=" + charset],
                    input=cleaned, capture_output=True, timeout=15, check=False)
            except (subprocess.TimeoutExpired, OSError):
                raise PortalError("Local CAPTCHA recognition did not complete.") from None
            text = re.sub(r"\s+", "", result.stdout.decode("utf-8", "replace")) if result.returncode == 0 else ""
            if pattern.fullmatch(text):
                votes.append(text)
    return votes


def pick_answer(votes: list[str], *, min_votes: int = MIN_VOTES) -> str | None:
    ranked = Counter(votes).most_common()
    if not ranked:
        return None
    best, count = ranked[0]
    runner_up = ranked[1][1] if len(ranked) > 1 else 0
    return best if count >= min_votes and count >= 2 * runner_up else None


def solve_text_captcha(png: bytes, *, length: int = 6) -> str:
    """Use an answer only when the cleaned reads clearly agree. Never cycle
    guesses against the site: an unclear CAPTCHA stops before the login."""
    answer = pick_answer(captcha_votes(png, length=length))
    if not answer:
        raise PortalError("CAPTCHA needs a person: local OCR could not read it confidently. No login was submitted.")
    return answer
