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


def solve_text_captcha(png: bytes, *, length: int = 6) -> str:
    """Require two OCR layouts to agree. Never cycle guesses against the site."""
    if not 4 <= length <= 10:
        raise PortalError("IOCL_CAPTCHA_LENGTH must be between 4 and 10.")
    binary = shutil.which("tesseract")
    if not binary:
        raise PortalError("Install Tesseract OCR to read the portal's text CAPTCHA.")
    if len(png) > 2_000_000:
        raise PortalError("The CAPTCHA image is unexpectedly large.")
    candidates = []
    for mode in (7, 8, 13):
        try:
            result = subprocess.run(
                [binary, "stdin", "stdout", "--psm", str(mode),
                 "-c", "tessedit_char_whitelist=ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", "tsv"],
                input=png, capture_output=True, timeout=15, check=False)
        except (subprocess.TimeoutExpired, OSError):
            raise PortalError("Local CAPTCHA recognition did not complete.") from None
        if result.returncode == 0:
            answer = ocr_candidate(result.stdout.decode("utf-8", "replace"), length)
            if answer:
                candidates.append(answer)
    counts = Counter(candidates)
    if not counts or counts.most_common(1)[0][1] < 2:
        raise PortalError("CAPTCHA needs a person: local OCR could not read it confidently. No login was submitted.")
    return counts.most_common(1)[0][0]
