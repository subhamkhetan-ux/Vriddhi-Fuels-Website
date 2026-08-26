"""Name matcher — ported from the proven ``matchName`` in ``pay/index.html``.

Tiers preserved exactly:
  exact  ->  unique substring / word-prefix  ->  ambiguous (list candidates)
         ->  no match (closest by word overlap)

Ambiguous or unmatched names are NEVER auto-guessed.

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


def _canon(s: str) -> str:
    """Normalize + fold common company-suffix abbreviations."""
    return " ".join(_ABBR.get(t, t) for t in norm(s).split())


@dataclass
class MatchResult:
    status: str                      # "matched" | "review"
    tier: str                        # alias|exact|substring|ambiguous|nomatch
    canonical: str | None = None     # set when status == "matched"
    candidates: list[str] = field(default_factory=list)


def _core_match(raw: str, customers: list[str]) -> tuple[str, str | None, list[str]]:
    """The ported ``matchName``, extended with abbreviation folding and
    reverse containment.

    Returns ``(tier, exact_or_none, candidate_list)`` where tier is one of
    ``exact``, ``substring``, ``ambiguous``, ``nomatch``.
    """
    normed = [(c, _canon(c)) for c in customers]
    q = _canon(raw)
    qc = q.replace(" ", "")

    # Tier 1: exact (abbreviation-folded) equality.
    for n, nn in normed:
        if nn == q:
            return "exact", n, [n]

    # Tier 2: substring / word-prefix, in EITHER direction:
    #   - query inside a name  -> shorthand ("akv" in "akv logistics")
    #   - name inside a query  -> bank wrote the fuller legal name
    def hit(nn: str) -> bool:
        if not qc:
            return False
        nnc = nn.replace(" ", "")
        if qc in nnc:
            return True
        if len(nnc) >= MIN_REVERSE_SUBSTR and " " in nn and nnc in qc:
            return True
        return any(w.startswith(qc) for w in nn.split(" "))

    subs = [n for n, nn in normed if hit(nn)]
    if len(subs) == 1:
        return "substring", subs[0], subs
    if len(subs) > 1:
        return "ambiguous", None, subs

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
    if ak in aliases:
        target = aliases[ak]
        # Snap the stored alias back to the current canonical spelling if present.
        canonical = canon_set.get(norm(target), target)
        return MatchResult("matched", "alias", canonical=canonical, candidates=[canonical])

    cleaned = clean_remitter(raw_payer) or raw_payer
    tier, exact, candidates = _core_match(cleaned, customers)

    if tier == "exact":
        return MatchResult("matched", "exact", canonical=exact, candidates=candidates)

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
