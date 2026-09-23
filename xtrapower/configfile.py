"""Forgiving loader for ``config.json``.

The config is hand-edited on every machine, so a stray comment or a curly quote
from TextEdit must not produce a Python traceback. This module:

* accepts ``//`` and ``/* ... */`` comments (the README documents the config as
  ``jsonc`` and shows ``//`` comments, so plain ``json.load`` was wrong),
* accepts a trailing comma before ``}`` or ``]``,
* repairs the “smart quotes” TextEdit substitutes for ``"``, and the
  invisible look-alike whitespace (no-break space, zero-width space) that
  copy-paste introduces,
* and, when it still can't parse, raises :class:`ConfigError` naming the line,
  quoting it, and listing the usual causes — instead of a stack trace.

Comment stripping is string-aware, so a ``"https://..."`` value is untouched,
and newlines are preserved so reported line numbers match the real file.
"""

from __future__ import annotations

import json
import unicodedata
from typing import Any

# TextEdit (and Word, and chat apps) silently turn " into these.
_SMART_QUOTES = {
    "“": '"', "”": '"',      # “ ”
    "„": '"', "‟": '"',
    "‘": "'", "’": "'",      # ‘ ’
    "«": '"', "»": '"',      # « »
    "‚": '"', "‛": '"',      # low-9 / reversed-9 quotes
    "＂": '"', "″": '"',      # fullwidth quote, double prime
    "ʺ": '"', "′": "'", "ʹ": "'",
}

# Characters that LOOK like a space or newline but are not valid JSON
# whitespace. JSON allows only space, tab, CR and LF, so one of these - a
# no-break space pasted from a web page or a chat message is the usual culprit -
# stops the parse dead with a baffling "Expecting property name" on a line that
# looks perfect. Normalised outside strings only, so a value that genuinely
# contains one keeps it.
_SPACE_LOOKALIKES = {
    " ": " ",                                     # NO-BREAK SPACE
    " ": " ", " ": " ", " ": " ", " ": " ",
    " ": " ", " ": " ", " ": " ", " ": " ",
    " ": " ", " ": " ", " ": " ", "　": " ",
    "​": "", "‌": "", "‍": "", "﻿": "",   # zero-width / BOM
    " ": "\n", " ": "\n",                    # line / paragraph separators
}


class ConfigError(Exception):
    """Raised with a human-readable explanation of a bad config file."""


def _fix_smart_quotes(text: str) -> str:
    for bad, good in _SMART_QUOTES.items():
        text = text.replace(bad, good)
    return text


def _strip_comments(text: str) -> str:
    """Remove // and /* */ comments, leaving strings and line numbers intact."""
    out: list[str] = []
    i, n = 0, len(text)
    in_str = False
    quote = ""
    while i < n:
        c = text[i]
        if in_str:
            out.append(c)
            if c == "\\" and i + 1 < n:       # keep escape pairs together
                out.append(text[i + 1])
                i += 2
                continue
            if c == quote:
                in_str = False
            i += 1
            continue
        if c in '"\'':
            in_str, quote = True, c
            out.append(c)
            i += 1
            continue
        if c in _SPACE_LOOKALIKES:
            out.append(_SPACE_LOOKALIKES[c])
            i += 1
            continue
        if c == "/" and i + 1 < n and text[i + 1] == "/":
            while i < n and text[i] != "\n":   # stop before the newline
                i += 1
            continue
        if c == "/" and i + 1 < n and text[i + 1] == "*":
            i += 2
            while i + 1 < n and not (text[i] == "*" and text[i + 1] == "/"):
                if text[i] == "\n":            # preserve line numbering
                    out.append("\n")
                i += 1
            i += 2
            continue
        out.append(c)
        i += 1
    return "".join(out)


def _strip_trailing_commas(text: str) -> str:
    """Drop a comma that is followed only by whitespace and then } or ]."""
    out: list[str] = []
    i, n = 0, len(text)
    in_str = False
    quote = ""
    while i < n:
        c = text[i]
        if in_str:
            out.append(c)
            if c == "\\" and i + 1 < n:
                out.append(text[i + 1])
                i += 2
                continue
            if c == quote:
                in_str = False
            i += 1
            continue
        if c in '"\'':
            in_str, quote = True, c
            out.append(c)
            i += 1
            continue
        if c == ",":
            j = i + 1
            while j < n and text[j].isspace():
                j += 1
            if j < n and text[j] in "}]":
                i += 1                         # skip the comma itself
                continue
        out.append(c)
        i += 1
    return "".join(out)


def clean(text: str) -> str:
    """Apply every tolerated-syntax repair, in order."""
    return _strip_trailing_commas(_strip_comments(_fix_smart_quotes(text)))


def _odd_characters(line: str) -> list[str]:
    """Describe any non-ASCII character on a line, so invisibles become visible."""
    found = []
    for col, ch in enumerate(line, start=1):
        if ord(ch) < 128:
            continue
        name = unicodedata.name(ch, "unnamed character")
        found.append(f"column {col}: U+{ord(ch):04X} {name}")
    return found


def _explain(path: str, raw: str, exc: json.JSONDecodeError) -> str:
    lines = raw.splitlines()
    lineno = max(1, min(exc.lineno, len(lines) or 1))
    offending = lines[lineno - 1] if lines else ""
    odd = _odd_characters(offending)
    # Build the label once and measure it, so the caret lands under the exact
    # column json reported. (Guessing the width drew it two columns off, which
    # pointed at the wrong character and sent a real diagnosis down the garden
    # path.) Tabs are shown as single spaces so the column count still holds.
    shown = offending.replace("\t", " ")
    prefix = f"  line {lineno}: "
    caret_line = " " * (len(prefix) + max(0, exc.colno - 1)) + "^"
    odd_note = ""
    if odd:
        odd_note = (
            "\nThis line contains characters that are not plain ASCII — usually the\n"
            "cause when the line looks correct:\n"
            + "".join(f"  - {d}\n" for d in odd)
        )
    return (
        f"{path} is not valid JSON.\n\n"
        f"{prefix}{shown}\n"
        f"{caret_line}\n"
        f"  {exc.msg}\n"
        f"{odd_note}\n"
        "Common causes:\n"
        '  - Curly "smart quotes" from TextEdit - retype them as straight " quotes\n'
        "  - A missing comma between two entries, or one comma too many\n"
        "  - An unclosed { } or [ ]\n"
        "  - A password containing a \" or \\ - escape it as \\\" or \\\\\n\n"
        "(// comments and a trailing comma are fine - those are handled for you.)\n"
        f"Tip: copy {path.replace('config.json', 'config.example.json')} and re-edit "
        "if you'd rather start clean."
    )


def load(path: str) -> dict[str, Any]:
    """Read and parse a config file, tolerantly.

    Raises :class:`ConfigError` with a readable message if it still can't parse.
    """
    try:
        with open(path, encoding="utf-8-sig") as f:   # -sig drops a BOM
            raw = f.read()
    except FileNotFoundError:
        raise ConfigError(
            f"{path} not found.\n"
            "Run ./xtrapower/setup-mac.sh to create it, or copy "
            "xtrapower/config.example.json to xtrapower/config.json."
        ) from None
    if not raw.strip():
        raise ConfigError(f"{path} is empty. Copy xtrapower/config.example.json over it.")
    try:
        return json.loads(clean(raw))
    except json.JSONDecodeError as exc:
        raise ConfigError(_explain(path, raw, exc)) from None
