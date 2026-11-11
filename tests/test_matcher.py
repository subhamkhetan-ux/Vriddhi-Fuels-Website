from agent.matcher import alias_key, match_name
from agent.normalize import clean_remitter, norm

CUSTOMERS = [
    "A.K.V. Logistics",
    "M/s Smc Power Generation Ltd.",
    "Maa Samlai Enterprises",
    "Sudarshan Minerals And Logistics",
    "Sudarshan Traders",
    "Reliance Petro Marketing",
]


def test_exact_normalized_match_punctuation_insensitive():
    # dots/slashes stripped for comparison
    r = match_name("akv logistics", CUSTOMERS)
    assert r.status == "matched" and r.canonical == "A.K.V. Logistics"


def test_shorthand_akv_resolves_but_reviews():
    # The ported matcher resolves the shorthand to the right canonical name;
    # a 3-char token is below the confidence gate, so in the bank pipeline it
    # queues as review (with the one candidate pre-filled), never auto-entered.
    r = match_name("akv", CUSTOMERS)
    assert r.canonical == "A.K.V. Logistics"
    assert r.candidates == ["A.K.V. Logistics"]
    assert r.status == "review"


def test_shorthand_smc_resolves_but_reviews():
    r = match_name("smc", CUSTOMERS)
    assert r.canonical == "M/s Smc Power Generation Ltd."
    assert r.status == "review"


def test_maa_samlai_matches():
    r = match_name("maa samlai", CUSTOMERS)
    assert r.status == "matched" and r.canonical == "Maa Samlai Enterprises"


def test_ambiguous_is_review_never_guessed():
    r = match_name("sudarshan", CUSTOMERS)
    assert r.status == "review"
    assert r.tier == "ambiguous"
    assert set(r.candidates) == {
        "Sudarshan Minerals And Logistics",
        "Sudarshan Traders",
    }
    assert r.canonical is None


def test_no_match_offers_closest_but_reviews():
    r = match_name("zzz nonexistent corp", CUSTOMERS)
    assert r.status == "review"
    assert r.tier == "nomatch"
    assert r.canonical is None


def test_short_substring_not_confident():
    # "hp" would substring-hit but is too short to be confident on its own
    r = match_name("re", CUSTOMERS)
    assert r.status == "review"


def test_bank_noise_stripped_then_matched():
    raw = "M/S SUDARSHAN MINERALS AND LOG NEFT AXBK0001122334"
    assert "SUDARSHAN MINERALS AND LOG" in clean_remitter(raw)
    r = match_name(raw, CUSTOMERS)
    # cleaned to "SUDARSHAN MINERALS AND LOG" -> unique substring of the full name
    assert r.status == "matched"
    assert r.canonical == "Sudarshan Minerals And Logistics"


def test_alias_checked_first_and_wins():
    aliases = {alias_key("RANDOM REMITTER XYZ"): "Reliance Petro Marketing"}
    r = match_name("RANDOM REMITTER XYZ", CUSTOMERS, aliases=aliases)
    assert r.status == "matched"
    assert r.tier == "alias"
    assert r.canonical == "Reliance Petro Marketing"


def test_alias_snaps_to_current_canonical_spelling():
    # alias stored against an old spelling still resolves to the live name
    aliases = {alias_key("foo remitter"): "reliance petro marketing"}
    r = match_name("foo remitter", CUSTOMERS, aliases=aliases)
    assert r.canonical == "Reliance Petro Marketing"


REAL = [
    "Orissa Metaliks Private Limited",
    "M/s Jai Balaji Oxygen Private Limited",
    "Keshav Minerals",
    "Dbl-Siarmal Coal Mines Private Limited",
    "Pine Labs Nodal Account",
]


def test_abbrev_pvt_ltd_matches_private_limited():
    r = match_name("ORISSA METALIKS PVT LIMITED", REAL)
    assert r.status == "matched"
    assert r.canonical == "Orissa Metaliks Private Limited"


def test_fuller_legal_name_with_suffix_matches():
    r = match_name("ORISSA METALIKS PRIVATE LIMITED JHARSUGUDA UNIT", REAL)
    assert r.status == "matched"
    assert r.canonical == "Orissa Metaliks Private Limited"


def test_abbrev_and_prefix_jai_balaji():
    r = match_name("JAI BALAJI OXYGEN PVT LTD", REAL)
    assert r.status == "matched"
    assert r.canonical == "M/s Jai Balaji Oxygen Private Limited"


def test_truncated_dbl_siarmal_matches():
    r = match_name("DBL SIARMAL COAL MINES PRIVATE LIM", REAL)
    assert r.status == "matched"
    assert r.canonical == "Dbl-Siarmal Coal Mines Private Limited"


def test_pine_labs_does_not_false_match_nodal_account():
    # different entity from "Pine Labs Nodal Account" -> stays review, not matched
    r = match_name("PINE LABS PRIVATE LIMITED", REAL)
    assert r.status == "review"
    assert r.canonical is None


def test_alias_key_is_noise_insensitive():
    a = alias_key("M/S SUDARSHAN MINERALS UTR 123456789012")
    b = alias_key("Sudarshan Minerals")
    assert a == b == norm("sudarshan minerals")


def test_token_subset_interleaved_words_matches():
    # Every significant word of the customer appears in the remitter, but out of
    # order and interleaved with extra words — not a contiguous substring.
    r = match_name("SUDARSHAN GLOBAL MINERALS AND LOGISTICS HUB", CUSTOMERS)
    assert r.status == "matched"
    assert r.canonical == "Sudarshan Minerals And Logistics"


def test_token_subset_needs_two_significant_words():
    # A single generic-stripped word must NOT auto-match (too weak).
    r = match_name("RELIANCE FRESH RETAIL OUTLET", ["Reliance Petro Marketing"])
    assert r.status == "review"


# ---- smarter matching, from the alerts that needed a person (Aug–Nov 2026) ----
import json
import os
import random

import pytest

from agent.matcher import IGNORE_ALIAS, _canon, match_name as _mn

REAL2 = ["Dbl-Siarmal Coal Mines Private Limited", "Bhaskar Earthmover Private Limited",
        "Maa Karni Earthmover Private Limited", "Simar Infrastructure LTD", "Simar JSW",
        "Sunil Kumar Khetan Transaction", "Sunil Kumar Khetan-Debtors", "SHRI LAL KHETAN",
        "Natwar Lal Khetan", "Krishav Logistic", "A.K.V. Logistics", "Babylon Logistics Private Limited",
        "Ln Logistics Private Limited", "DG VRIDDHI FUELS", "VRIDDHI FUELS CAR", "VRIDDHI FUELS TANKER",
        "Ekdant Logistic", "Manoj Store"]


@pytest.mark.parametrize("raw,want,tier", [
    ("DBLSCMPL", "Dbl-Siarmal Coal Mines Private Limited", "acronym"),          # an acronym
    ("DBL SIARMAL COALMINES P L", "Dbl-Siarmal Coal Mines Private Limited", "exact"),  # joined + "P L"
    ("BHSKAR EARTHMOVER", "Bhaskar Earthmover Private Limited", "fuzzy"),       # a typo
    ("SIMAR INFRASTRUCTURES LTD", "Simar Infrastructure LTD", "exact"),        # a plural
    ("EKDANT LOGISTICS", "Ekdant Logistic", "exact"),
    ("SHRI LAL KHETAN", "SHRI LAL KHETAN", "exact"),                            # "SHRI" is part of the name
    ("VRIDDHI FUELS TANKR", "VRIDDHI FUELS TANKER", "fuzzy"),
])
def test_real_remitters_now_match(raw, want, tier):
    m = _mn(raw, REAL2)
    assert (m.status, m.canonical, m.tier) == ("matched", want, tier)


@pytest.mark.parametrize("raw", [
    "SUNIL KUMAR KHETAN",     # two ledgers of one name -> a person decides
    "SIMAR",                  # two Simar customers
    "BHASKR EARTMOVER",       # two slips and no word exact
    "A  V LOGISTIC",          # not "kriSHAV LOGISTIC" from the middle of a word
    "VRIDDHI FUELS CR",       # not DG VRIDDHI FUELS: "DG" has to be there
    "DBL",                    # too short to be sure
])
def test_never_guessed(raw):
    m = _mn(raw, REAL2)
    assert m.status == "review", (raw, m)


def test_a_dropped_letter_finds_the_customer_not_a_name_inside_it():
    # "BABYLN" (Babylon) must not match "baby-LN LOGISTICS"
    assert _mn("BABYLN LOGISTICS PVT LTD", REAL2).canonical == "Babylon Logistics Private Limited"


def test_two_spellings_of_one_customer_are_one():
    m = _mn("DBLSCMPL", REAL2 + ["DBL SIARMAL COAL MINES PVT LTD"])
    assert m.status == "matched"


def test_an_ignored_payer_is_never_a_customer():
    m = _mn("ODISHA SARKAR", REAL2, {"odisha sarkar": IGNORE_ALIAS})
    assert m.status == "review" and m.canonical != IGNORE_ALIAS


def test_typos_of_every_customer_never_land_on_another():
    """Every customer in state/customers.json, with a letter dropped, two
    swapped or one changed: the right customer or a review row — never a
    different customer."""
    path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "state", "customers.json")
    cust = json.load(open(path, encoding="utf-8"))
    rng = random.Random(7)
    right = wrong = 0
    for c in cust:
        w = _canon(c)
        assert _mn(c, cust).canonical == c, c                       # every name finds itself
        for _ in range(8):
            i = rng.randrange(1, len(w) - 1)
            if " " in w[i - 1:i + 2]:
                continue
            for t in (w[:i] + w[i + 1:], w[:i] + w[i + 1] + w[i] + w[i + 2:], w[:i] + "x" + w[i + 1:]):
                m = _mn(t, cust)
                if m.status == "matched":
                    assert m.canonical == c, (t, m.canonical, c)
                    right += 1
    assert right > 0
