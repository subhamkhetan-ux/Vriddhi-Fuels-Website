from agent.serial import serial_to_dmy, to_serial


def test_known_serials():
    # 01/01/2020 is Excel serial 43831 (well-known reference value).
    assert to_serial("01/01/2020") == (43831, True)


def test_pre_1900_rejected_like_the_reference():
    # The ported matcher (and the JS it came from) require year >= 1900.
    assert to_serial("30/12/1899") == (None, False)


def test_two_digit_year_maps_to_2000s():
    s2, ok2 = to_serial("15/06/24")
    s4, ok4 = to_serial("15/06/2024")
    assert ok2 and ok4 and s2 == s4


def test_impossible_dates_rejected():
    assert to_serial("31/02/2024") == (None, False)
    assert to_serial("00/01/2024") == (None, False)
    assert to_serial("32/01/2024") == (None, False)
    assert to_serial("15/13/2024") == (None, False)


def test_malformed_input_rejected():
    assert to_serial("2024-06-15") == (None, False)
    assert to_serial("not a date") == (None, False)
    assert to_serial("15/06") == (None, False)


def test_round_trip():
    for d in ("01/01/2020", "15/06/2024", "29/02/2024"):
        s, ok = to_serial(d)
        assert ok
        # serial_to_dmy uses a 2-digit year; compare day/month and last-2 of year
        dd, mm, yy = d.split("/")
        assert serial_to_dmy(s) == f"{dd}/{mm}/{yy[-2:]}"
