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


def test_alias_key_is_noise_insensitive():
    a = alias_key("M/S SUDARSHAN MINERALS UTR 123456789012")
    b = alias_key("Sudarshan Minerals")
    assert a == b == norm("sudarshan minerals")
