"""Static checks on ledger/tdl/VriddhiFuelSlip.tdl (no Tally here).

- the slip voucher types are the DayBook's sales types (ledger/js/daybook.js)
- the Vehicle No UDF is the one the /tally/ app exports (UDF:EIVEHNO, 120)
- every VF definition the file uses is defined, and none twice
"""
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TDL = os.path.join(ROOT, "ledger", "tdl", "VriddhiFuelSlip.tdl")


def _read(*parts):
    with open(os.path.join(ROOT, *parts), encoding="utf-8") as f:
        return f.read()


def _code():
    # drop ;; comments
    return "\n".join(line.split(";;", 1)[0] for line in _read(TDL).splitlines())


def test_slip_types_are_the_daybook_sales_types():
    code = _code()
    types = re.findall(r'VFSlipType\d\s*:\s*"([^"]*)"', code)
    daybook = _read("ledger", "js", "daybook.js")
    m = re.search(r"VOUCHER_TYPES = \{([^}]*)\}", daybook)
    expected = re.findall(r"'([^']+)'\s*:", m.group(1))
    assert types == expected


def test_vehicle_udf_matches_the_tally_app():
    code = _code()
    m = re.search(r"^\s*(\w+)\s*:\s*String\s*:\s*(\d+)\s*$", code, re.M)
    assert m, "no String UDF defined"
    name, index = m.group(1), m.group(2)
    tally = _read("tally", "index.html")
    exp = re.search(r'<UDF:EIVEHNO\.LIST DESC="`(\w+)`"[^>]*INDEX="(\d+)"', tally)
    assert (name, index) == (exp.group(1), exp.group(2))
    assert re.search(r"Storage\s*:\s*" + name + r"\b", code)


def test_every_vf_definition_used_is_defined_once():
    code = _code()
    heads = re.findall(r"^\[(!?)(Form|Part|Line|Field|Style|Color|Collection)\s*:\s*([^\]]+)\]", code, re.M)
    defined = {}
    for _, kind, name in heads:
        key = (kind, name.strip())
        assert key not in defined, f"{kind} {name} defined twice"
        defined[key] = True

    def need(kind, names):
        for n in (x.strip() for x in names.split(",")):
            if n.startswith("VF "):
                assert (kind, n) in defined, f"{kind}: {n} is used but not defined"

    for attr, kind in [("Parts?", "Part"), ("Lines?", "Line"), ("(?:Right )?Fields?", "Field")]:
        for m in re.finditer(r"^\s*(?:Add\s*:\s*)?" + attr + r"\s*:\s*(?:At Beginning\s*:\s*)?(.+)$", code, re.M):
            need(kind, m.group(1))
    for m in re.finditer(r"^\s*Repeat\s*:\s*([^:]+):\s*(.+)$", code, re.M):
        need("Line", m.group(1))
        need("Collection", m.group(2))
    for m in re.finditer(r"^\s*Style\s*:\s*(.+)$", code, re.M):
        need("Style", m.group(1))
    for m in re.finditer(r"^\s*(?:Color|Background|Print FG|Print BG)\s*:\s*(.+)$", code, re.M):
        need("Color", m.group(1))
    for m in re.finditer(r"^\s*Use\s*:\s*(.+)$", code, re.M):
        need("Field", m.group(1))
    m = re.search(r"Add\s*:\s*Option\s*:\s*([^:]+):", code)
    need("Form", m.group(1))

    formulas = set(re.findall(r"^\s{4}(VF\w+)\s*:", code, re.M))
    for used in set(re.findall(r"@@(\w+)", code)):
        assert used in formulas, f"formula @@{used} is not defined"


def test_brackets_balance_per_line():
    for i, line in enumerate(_code().splitlines(), 1):
        assert line.count("(") == line.count(")"), f"line {i}: ( ) don't balance"
        assert line.count('"') % 2 == 0, f"line {i}: unclosed quote"
