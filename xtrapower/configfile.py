"""Forgiving loader for ``config.json``.

The config is hand-edited on every machine, so a stray comment or a curly quote
from TextEdit must not produce a Python traceback. This module:

* accepts ``//`` and ``/* ... */`` comments (the README documents the config as
  ``jsonc`` and shows ``//`` comments, so plain ``json.load`` was wrong),
* accepts a trailing comma before ``}`` or ``]``,
* repairs the “smart quotes” TextEdit substitutes for ``"``,
* and, when it still can't parse, raises :class:`ConfigError` naming the line,
  quoting it, and listing the usual causes — instead of a stack trace.

Comment stripping is string-aware, so a ``"https://..."`` value is untouched,
and newlines are preserved so reported line numbers match the real file.
"""

from __future__ import annotations

import json
from typing import Any

# TextEdit (and Word, and chat apps) silently turn " into these.
_SMART_QUOTES = {
    "“": '"', "”": '"',      # “ ”
    "„": '"', "‟": '"',
    "‘": "'", "’": "'",      # ‘ ’
    "«": '"', "»": '"',      # « »
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


def _explain(path: str, raw: str, exc: json.JSONDecodeError) -> str:
    lines = raw.splitlines()
    lineno = max(1, min(exc.lineno, len(lines) or 1))
    offending = lines[lineno - 1] if lines else ""
    caret = " " * max(0, exc.colno - 1) + "^"
    return (
        f"{path} is not valid JSON.\n\n"
        f"  line {lineno}: {offending}\n"
        f"           {' ' * len(str(lineno))}{caret}\n"
        f"  {exc.msg}\n\n"
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
