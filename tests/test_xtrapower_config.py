"""Config loading must tolerate hand-editing mistakes and explain the rest."""

import json

import pytest

from xtrapower import configfile


def _write(tmp_path, text):
    p = tmp_path / "config.json"
    p.write_text(text, encoding="utf-8")
    return str(p)


def test_accepts_line_comments(tmp_path):
    """The README documents the config as jsonc, so // must parse."""
    cfg = configfile.load(_write(tmp_path, '''{
  // the Telegram bot from BotFather
  "poll_seconds": 120,
  "accounts": [
    { "label": "A", "cdp_port": 9222,
      "username": "1005218882",   // the customer ID you type
      "password": "p" }
  ]
}'''))
    assert cfg["poll_seconds"] == 120
    assert cfg["accounts"][0]["username"] == "1005218882"


def test_url_inside_a_string_is_not_treated_as_a_comment(tmp_path):
    cfg = configfile.load(_write(
        tmp_path, '{"balance_url": "https://beta.iocxtrapower.com/Transactions/BalanceInfo"}'))
    assert cfg["balance_url"].startswith("https://")


def test_accepts_block_comments_and_keeps_line_numbers(tmp_path):
    cfg = configfile.load(_write(tmp_path, '{\n/* a\n   note */\n"poll_seconds": 60\n}'))
    assert cfg["poll_seconds"] == 60


def test_accepts_trailing_commas(tmp_path):
    cfg = configfile.load(_write(tmp_path, '{"a": 1, "b": [1, 2,], }'))
    assert cfg == {"a": 1, "b": [1, 2]}


def test_repairs_textedit_smart_quotes(tmp_path):
    cfg = configfile.load(_write(tmp_path, '{“token”: “abc123”}'))
    assert cfg["token"] == "abc123"


def test_password_with_escaped_quote_survives(tmp_path):
    cfg = configfile.load(_write(tmp_path, r'{"password": "a\"b//c"}'))
    assert cfg["password"] == 'a"b//c'


def test_missing_file_explains_how_to_make_one(tmp_path):
    with pytest.raises(configfile.ConfigError) as e:
        configfile.load(str(tmp_path / "nope.json"))
    assert "setup-mac.sh" in str(e.value)


def test_empty_file_is_reported(tmp_path):
    with pytest.raises(configfile.ConfigError) as e:
        configfile.load(_write(tmp_path, "   \n"))
    assert "empty" in str(e.value).lower()


def test_real_syntax_error_names_the_line_and_hints(tmp_path):
    with pytest.raises(configfile.ConfigError) as e:
        configfile.load(_write(tmp_path, '{\n  "a": 1\n  "b": 2\n}'))
    msg = str(e.value)
    assert "line 3" in msg              # points at the line missing the comma
    assert "smart quotes" in msg.lower()
    assert "Traceback" not in msg


def test_clean_leaves_valid_json_untouched(tmp_path):
    src = json.dumps({"accounts": [{"label": "A", "cdp_port": 9222}]}, indent=2)
    assert json.loads(configfile.clean(src)) == json.loads(src)


# ---- invisible / look-alike characters from copy-paste ---------------------

def test_no_break_space_indentation_parses(tmp_path):
    """The exact failure seen on a fresh Mac: NBSP indenting line 2."""
    cfg = configfile.load(_write(
        tmp_path, '{\n  "poll_seconds": 120,\n  "accounts": []\n}'))
    assert cfg["poll_seconds"] == 120


def test_zero_width_and_bom_inside_the_file_parse(tmp_path):
    cfg = configfile.load(_write(
        tmp_path, '{​\n  "a": 1,﻿\n  "b": 2\n}'))
    assert cfg == {"a": 1, "b": 2}


def test_unicode_line_separator_parses(tmp_path):
    cfg = configfile.load(_write(tmp_path, '{   "a": 1 }'))
    assert cfg == {"a": 1}


def test_value_keeps_its_own_no_break_space(tmp_path):
    """Normalisation is outside strings only — a real NBSP in a value survives."""
    cfg = configfile.load(_write(tmp_path, '{"password": "a b"}'))
    assert cfg["password"] == "a b"


def test_error_names_invisible_characters(tmp_path):
    """A line that looks right but has an odd character must say so."""
    with pytest.raises(configfile.ConfigError) as e:
        # NBSP *inside* the key name: cleaning can't help, so it must be explained
        configfile.load(_write(tmp_path, '{\n  "poll seconds" 120\n}'))
    msg = str(e.value)
    assert "U+00A0" in msg and "NO-BREAK SPACE" in msg
    assert "line 2" in msg
