"""Normalization helpers.

``norm`` is the exact analogue of ``_norm`` in ``pay/index.html``:
case- and punctuation-insensitive folding. This was a real bug fixed once
already (``akv`` -> ``A.K.V. Logistics``, ``smc`` -> ``M/s Smc Power Generation
Ltd.``) — dots and slashes are stripped for comparison. Do not regress it.

``clean_remitter`` is the bank-specific extension from the spec (§5): strip the
noise banks bolt onto a remitter name (``M/S``, honorifics, trailing UTR /
reference tokens) *before* matching, so the messy remitter string has a chance
of resolving to a canonical customer.
"""

from __future__ import annotations

import re

# Non-alphanumerics collapse to single spaces; result is lower-cased + trimmed.
_NON_ALNUM = re.compile(r"[^a-z0-9]+")


def norm(s: str) -> str:
    """Case- and punctuation-insensitive normalization (ported ``_norm``)."""
    return _NON_ALNUM.sub(" ", str(s).lower()).strip()


# Honorifics / entity prefixes a bank prepends but that carry no identity.
_PREFIX_TOKENS = {"m", "s", "ms", "mr", "mrs", "messrs", "sri", "shri", "smt"}

# Trailing reference noise: bank ref/UTR tokens, e.g. "NEFT AXBK0123456789",
# a 12+ digit UTR, or "REF 998877". Long alphanumeric runs that are clearly
# machine references, not names.
_REF_TOKEN = re.compile(
    r"\b(?:utr|ref|rrn|txn|neft|rtgs|imps|upi|chq|cheque)\b[:\s-]*[a-z0-9/-]*",
    re.IGNORECASE,
)
_LONG_DIGITS = re.compile(r"\b\d{9,}\b")
_LONG_ALNUM_CODE = re.compile(r"\b(?=[a-z0-9]*\d)[a-z0-9]{10,}\b", re.IGNORECASE)


def clean_remitter(raw: str) -> str:
    """Strip bank noise from a remitter string before matching.

    Uppercase-agnostic: removes reference/UTR tokens, standalone long numeric or
    alphanumeric codes, leading ``M/S``/honorifics, and collapses whitespace.
    Returns the cleaned human-readable name portion.
    """
    s = str(raw)
    s = _REF_TOKEN.sub(" ", s)
    s = _LONG_DIGITS.sub(" ", s)
    s = _LONG_ALNUM_CODE.sub(" ", s)
    # Drop leading honorific/entity tokens (M/S SUDARSHAN... -> SUDARSHAN...).
    words = [w for w in re.split(r"[\s/]+", s) if w]
    while words and norm(words[0]).replace(" ", "") in _PREFIX_TOKENS:
        words.pop(0)
    return " ".join(words).strip()
