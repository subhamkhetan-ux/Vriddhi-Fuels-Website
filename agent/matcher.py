"""Name matcher — ported from the proven ``matchName`` in ``pay/index.html``.

Tiers preserved exactly:
  exact  ->  unique substring / word-prefix  ->  ambiguous (list candidates)
         ->  no match (closest by word overlap)

Ambiguous or unmatched names are NEVER auto-guessed.

Smarter tiers (from the real alerts that needed a person, Aug–Nov 2026), each
accepted only when exactly ONE customer fits:
  - spaces ignored and "P L"/"PL" = Private Limited, plurals folded:
    "DBL SIARMAL COALMINES P L", "SIMAR INFRASTRUCTURES";
  - acronym from the start of each word: "DBLSCMPL";
  - one typing slip per word, with another word exact: "BHSKAR EARTHMOVER";
  - substrings only from a word start (never "kriSHAV LOGISTIC" for "AV
    LOGISTIC"), short words like "DG" required, and a name that starts with
    an honorific ("SHRI LAL KHETAN") still matches itself.

Extensions for bank remitter strings (spec §5):
  - A learned alias table maps a raw remitter -> canonical customer and is
    checked FIRST. A once-confirmed remitter auto-passes forever.
  - Bank noise is stripped (:func:`agent.normalize.clean_remitter`) before the
    ported matcher runs.
  - Confidence gate: only an exact match, or a unique substring on a
    sufficiently long token, counts as ``matched``. Everything else -> ``review``.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from .normalize import clean_remitter, norm

# A unique substring hit only counts as confident if the compact query token is
# at least this long. Shorter shorthand (e.g. "hp") stays a review row.
MIN_CONFIDENT_SUBSTR = 4

# An alias pointing here means "always ignore credits from this payer" — set
# in the /payments app ("ignore payer"); the agent drops such credits. Never a
# customer: match_name skips it.
IGNORE_ALIAS = "__ignore__"

# A whole canonical name may match as a substring INSIDE a longer remitter (banks
# often write the fuller legal name, e.g. "... PRIVATE LIMITED JHARSUGUDA UNIT").
# Only trust that when the canonical compact name is at least this long and is
# multi-word, so a short generic name can't spuriously match inside a long string.
MIN_REVERSE_SUBSTR = 8

# Company-suffix abbreviations folded to one spelling on BOTH sides before
# comparison, so "PVT LTD" matches "Private Limited". Applied per whole token.
_ABBR = {
    "pvt": "private",
    "ltd": "limited",
    "co": "company",
    "corp": "corporation",
    "corpn": "corporation",
}


# Generic company words that carry no identity on their own — ignored when
# checking whether a customer's significant tokens are all present in a remitter.
_GENERIC = {
    "private", "limited", "company", "corporation", "pvt", "ltd", "co", "corp",
    "and", "the", "of", "unit", "india", "enterprises", "enterprise", "trading",
    "traders", "industries", "services", "service", "m/s", "ms", "mrs", "mr",
}


def _singular(w: str) -> str:
    """Fold a plain plural so "LOGISTICS" = "Logistic", "INFRASTRUCTURES" =
    "Infrastructure" (applied to both sides, so it only has to be consistent)."""
    return w[:-1] if len(w) > 4 and w.endswith("s") and not w.endswith("ss") else w


def _canon(s: str) -> str:
    """Normalize + fold common company-suffix abbreviations ("PVT LTD", and the
    banks' "P L" / "PL" for Private Limited) and plurals."""
    toks = [_ABBR.get(t, t) for t in norm(s).split()]
    out: list[str] = []
    i = 0
    while i < len(toks):
        if toks[i] in ("p", "private") and i + 1 < len(toks) and toks[i + 1] in ("l", "limited"):
            out += ["private", "limited"]
            i += 2
            continue
        if toks[i] == "pl" and i == len(toks) - 1 and out:
            out += ["private", "limited"]
            i += 1
            continue
        out.append(_singular(toks[i]))
        i += 1
    return " ".join(out)


def _edits(a: str, b: str, cap: int) -> int:
    """Typing distance (insert / delete / change / swap two neighbours), giving
    up past ``cap``."""
    if abs(len(a) - len(b)) > cap:
        return cap + 1
    prev2: list[int] | None = None
    prev = list(range(len(b) + 1))
    for i in range(1, len(a) + 1):
        cur = [i] + [0] * len(b)
        for j in range(1, len(b) + 1):
            cost = a[i - 1] != b[j - 1]
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
            if prev2 is not None and i > 1 and j > 1 and a[i - 1] == b[j - 2] and a[i - 2] == b[j - 1]:
                cur[j] = min(cur[j], prev2[j - 2] + 1)
        if min(cur) > cap:
            return cap + 1
        prev2, prev = prev, cur
    return prev[-1]


def _acronym(q: str, name_tokens: list[str]) -> bool:
    """``q`` (one word, no spaces) is built from the start of each word of the
    name, in order: "DBLSCMPL" = DBL·S·C·M·P·L for "Dbl Siarmal Coal Mines
    Private Limited". Trailing generic words (private, limited…) may be left off."""
    toks = list(name_tokens)
    while toks and toks[-1] in _GENERIC and len(toks) > 2:
        if _acronym_full(q, toks):
            return True
        toks = toks[:-1]
    return _acronym_full(q, toks)


def _acronym_full(q: str, toks: list[str]) -> bool:
    if len(toks) < 3:
        return False                     # 2-word "acronyms" are too easy to hit
    def go(i: int, t: int) -> bool:
        if t == len(toks):
            return i == len(q)
        w = toks[t]
        for k in range(min(len(w), len(q) - i), 0, -1):
            if q[i:i + k] == w[:k] and go(i + k, t + 1):
                return True
        return False
    return go(0, 0)


def _fuzzy(q: str, nn: str) -> bool:
    """A typo'd name: every distinctive word of the customer's name is in the
    remitter, at most one slip per word (two in a long word), at least one word
    exactly — and the remitter has no distinctive word the name lacks.
    "BHSKAR EARTHMOVER" = "Bhaskar Earthmover Private Limited"."""
    def sig(s: str) -> list[str]:
        return [w for w in s.split() if w not in _GENERIC and len(w) >= 2]
    ns, qs = sig(nn), sig(q)
    if len(ns) < 2 or len(qs) != len(ns) or sum(map(len, ns)) < 8:
        return False
    # short words (DG, JSW) carry the identity: they must be there exactly
    if any(len(w) <= 3 and w not in qs for w in ns):
        return False
    used: set[int] = set()
    exact = 0
    for w in ns:
        cap = 1 if len(w) <= 8 else 2
        best = None
        for j, v in enumerate(qs):
            if j in used:
                continue
            d = _edits(w, v, cap)
            if d <= cap and (best is None or d < best[1]):
                best = (j, d)
        if best is None:
            return False
        used.add(best[0])
        exact += best[1] == 0
    return exact >= 1


@dataclass
class MatchResult:
    status: str                      # "matched" | "review"
    tier: str                        # alias|exact|substring|acronym|fuzzy|ambiguous|nomatch
    canonical: str | None = None     # set when status == "matched"
    candidates: list[str] = field(default_factory=list)


def _core_match(raw: str, customers: list[str]) -> tuple[str, str | None, list[str]]:
    """The ported ``matchName``, extended with abbreviation folding and
    reverse containment.

    Returns ``(tier, exact_or_none, candidate_list)`` where tier is one of
    ``exact``, ``substring``, ``ambiguous``, ``nomatch``.
    """
    # One entry per customer: spellings that differ only in case, punctuation or
    # "Pvt Ltd" vs "Private Limited" (the Tally roster and the file) are the same.
    normed, _seen = [], set()
    for c in customers:
        cc = _canon(c)
        if cc not in _seen:
            _seen.add(cc)
            normed.append((c, cc))
    q = _canon(raw)
    qc = q.replace(" ", "")

    # Tier 1: exact (abbreviation-folded) equality — also with the spaces
    # ignored, for the banks' joined words ("COALMINES" = "Coal Mines").
    for n, nn in normed:
        if nn == q:
            return "exact", n, [n]
    if len(qc) >= 6:
        same = [n for n, nn in normed if nn.replace(" ", "") == qc]
        if len(same) == 1:
            return "exact", same[0], same

    # Tier 2: substring / word-prefix, in EITHER direction:
    #   - query inside a name  -> shorthand ("akv" in "akv logistics")
    #   - name inside a query  -> bank wrote the fuller legal name
    qstarts, _p = set(), 0
    for _w in q.split(" "):
        qstarts.add(_p)
        _p += len(_w)

    def hit(nn: str) -> bool:
        if not qc:
            return False
        nnc = nn.replace(" ", "")
        # the query inside the name — starting where one of the name's words
        # starts: "akvlogistic" in "a k v logistic", but not "avlogistic"
        # in the middle of "kriSHAV LOGISTIC"
        starts, pos = set(), 0
        for w in nn.split(" "):
            starts.add(pos)
            pos += len(w)
        i = nnc.find(qc)
        while i != -1:
            if i in starts:
                return True
            i = nnc.find(qc, i + 1)
        if len(nnc) >= MIN_REVERSE_SUBSTR and " " in nn:
            # the whole name inside a longer remitter — also from a word start
            # ("LN LOGISTICS…" yes; "BABY-LN LOGISTIC…" no)
            j = qc.find(nnc)
            while j != -1:
                if j in qstarts:
                    return True
                j = qc.find(nnc, j + 1)
        return any(w.startswith(qc) for w in nn.split(" "))

    subs = [n for n, nn in normed if hit(nn)]
    if len(subs) == 1:
        return "substring", subs[0], subs
    if len(subs) > 1:
        return "ambiguous", None, subs

    # Tier 2b: token-subset — every SIGNIFICANT word of a customer name appears
    # somewhere in the remitter, even out of order or interleaved with extra
    # words ("SRI KESHAV MINERALS TRADING" -> "Keshav Minerals"). Generic company
    # words are ignored so they can't carry a match on their own. Only trust it
    # when the significant tokens are substantial (>=2 words, >=8 chars total),
    # so a lone short word can't spuriously match.
    qtokens = {w for w in q.split(" ") if w}

    def sig_tokens(nn: str) -> set:
        # two-letter words count ("DG" VRIDDHI FUELS is not VRIDDHI FUELS TANKER)
        return {w for w in nn.split(" ") if w not in _GENERIC and len(w) >= 2}

    tsubs = []
    for n, nn in normed:
        st = sig_tokens(nn)
        if st and st <= qtokens and len(st) >= 2 and sum(len(w) for w in st) >= 8:
            tsubs.append(n)
    if len(tsubs) == 1:
        return "substring", tsubs[0], tsubs
    if len(tsubs) > 1:
        return "ambiguous", None, tsubs

    # Tier 2c: an acronym the bank made of the name ("DBLSCMPL"). One word of at
    # least 5 letters, built from the start of each word of exactly one name.
    if " " not in q and len(qc) >= 5 and qc.isalpha():
        acr = [n for n, nn in normed if _acronym(qc, nn.split())]
        if len(acr) == 1:
            return "acronym", acr[0], acr
        if len(acr) > 1:
            return "ambiguous", None, acr

    # Tier 2d: a typo ("BHSKAR EARTHMOVER"). Exactly one customer, else review.
    fz = [n for n, nn in normed if _fuzzy(q, nn)]
    if len(fz) == 1:
        return "fuzzy", fz[0], fz
    if len(fz) > 1:
        return "ambiguous", None, fz

    # Tier 3: no substring — offer closest by word overlap (never auto-picked).
    words = {w for w in q.split(" ") if w}
    scored: list[tuple[int, str]] = []
    for n, nn in normed:
        nw = {w for w in nn.split(" ") if w}
        ov = len(words & nw)
        if ov:
            scored.append((ov, n))
    scored.sort(key=lambda t: (-t[0], t[1]))
    return "nomatch", None, [n for _, n in scored[:6]]


def match_name(
    raw_payer: str,
    customers: list[str],
    aliases: dict[str, str] | None = None,
) -> MatchResult:
    """Resolve a raw remitter string to a canonical customer.

    ``aliases`` maps a normalized raw-payer key -> canonical name and is checked
    first (see :func:`alias_key`).
    """
    aliases = aliases or {}
    canon_set = {norm(c): c for c in customers}

    # Learned alias — checked FIRST, auto-passes forever.
    ak = alias_key(raw_payer)
    if ak in aliases and aliases[ak] != IGNORE_ALIAS:
        target = aliases[ak]
        # Snap the stored alias back to the current canonical spelling if present.
        canonical = canon_set.get(norm(target), target)
        return MatchResult("matched", "alias", canonical=canonical, candidates=[canonical])

    cleaned = clean_remitter(raw_payer) or raw_payer
    tier, exact, candidates = _core_match(cleaned, customers)
    if tier != "exact" and cleaned != raw_payer:
        # the cleaning took off a word that is part of the name ("SHRI LAL KHETAN")
        t2, e2, c2 = _core_match(raw_payer, customers)
        if t2 == "exact":
            tier, exact, candidates = t2, e2, c2

    if tier == "exact":
        return MatchResult("matched", "exact", canonical=exact, candidates=candidates)

    if tier in ("acronym", "fuzzy"):
        return MatchResult("matched", tier, canonical=exact, candidates=candidates)

    if tier == "substring":
        qc = norm(cleaned).replace(" ", "")
        confident = len(qc) >= MIN_CONFIDENT_SUBSTR
        # The single resolved name is exposed either way (so a review row can
        # pre-fill the one candidate); only the status reflects confidence.
        return MatchResult(
            "matched" if confident else "review",
            "substring",
            canonical=exact,
            candidates=candidates,
        )

    # ambiguous / nomatch -> always review, never auto-guessed.
    return MatchResult("review", tier, candidates=candidates)


def alias_key(raw_payer: str) -> str:
    """Stable key for the alias table: normalized, noise-stripped remitter.

    Falls back to the plain normalized string when cleaning empties it, so an
    all-noise remitter can still be resolved once and remembered.
    """
    return norm(clean_remitter(raw_payer)) or norm(raw_payer)
