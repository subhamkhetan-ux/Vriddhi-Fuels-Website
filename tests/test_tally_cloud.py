"""Tests for the cloud (in-browser) build of the Tally import tools (tally_cloud/).

The adapter is exercised in a subprocess, from the built app.zip only, so a file
missing from the bundle fails here and the real server modules / local data.json
files are never touched.
"""

import json
import os
import subprocess
import sys
import zipfile

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tally_cloud"))
import build as B  # noqa: E402


@pytest.fixture(scope="module")
def site(tmp_path_factory):
    wheels = tmp_path_factory.mktemp("wheels")
    for w in B.WHEELS:
        (wheels / w).write_bytes(b"fake wheel")
    out = tmp_path_factory.mktemp("site") / "tally-tools"
    meta = B.build(str(out), str(wheels))
    code = tmp_path_factory.mktemp("code")
    with zipfile.ZipFile(out / "app.zip") as zf:
        zf.extractall(code)
    return out, meta, code


def _run(code_dir, state_dir, script):
    """Run ``script`` with only the bundle (not the repo) importable."""
    prog = ("import sys; sys.path[:] = [p for p in sys.path if p and "
            f"not p.startswith({ROOT!r})]; sys.path.insert(0, {str(code_dir)!r})\n"
            f"import json, vf_cloud as V\nSTATE = {str(state_dir)!r}\n" + script)
    r = subprocess.run([sys.executable, "-c", prog], capture_output=True, text=True,
                       cwd=str(state_dir), timeout=120)
    assert r.returncode == 0, r.stderr
    return r.stdout


def test_build_layout_and_injection(site):
    out, meta, _ = site
    for f in ("index.html", "cloud.js", "app.zip", "build.json", *(f"wheels/{w}" for w in B.WHEELS)):
        assert (out / f).is_file(), f
    assert json.loads((out / "build.json").read_text())["pyodide"] == B.PYODIDE_VERSION
    for folder, pkg in B.APPS.items():
        html = (out / folder / "index.html").read_text()
        original = open(os.path.join(ROOT, pkg, "index.html"), encoding="utf-8").read()
        tag = f'<script src="../cloud.js?v={meta["build"]}" data-app="{pkg}"'
        assert tag in html
        # Loader runs before the page's own scripts; otherwise the page is unchanged.
        assert html.index(tag) < html.index("</head>") < html.index("<script>")
        assert html.replace(html[html.index("<script src=\"../cloud.js"):html.index("</head>")], "") == original


def test_bundle_serves_all_three_apps(site, tmp_path):
    _, _, code = site
    out = _run(code, tmp_path, """
for a in V.APPS: V.setup(a, state_dir=STATE, out_root=STATE + "/out")
r = V.call("bank_tally", "GET", "/api/aliases"); print(r["code"], len(json.loads(r["body"])["aliases"]))
r = V.call("iocl_tally", "GET", "/api/mappings"); print(r["code"], len(json.loads(r["body"])["ledgers"]))
r = V.call("fleet_tally", "GET", "/download/sample/tds"); print(r["code"], r["headers"]["Content-Disposition"])
r = V.call("bank_tally", "GET", "/download/bank_import.xml?123"); print(r["code"])
r = V.call("fleet_tally", "GET", "/nope"); print(r["code"])
""").split("\n")
    assert out[0].startswith("200 ") and int(out[0].split()[1]) > 0
    assert out[1].startswith("200 ") and int(out[1].split()[1]) > 0
    assert out[2] == '200 attachment; filename="tds_receivable_template.xlsx"'
    assert out[3] == "404" and out[4] == "404"


def test_state_lives_in_state_dir_and_is_shared(site, tmp_path):
    _, _, code = site
    out = _run(code, tmp_path, """
import os
mods = {a: V.setup(a, state_dir=STATE, out_root=STATE + "/out") for a in V.APPS}
# Every local file path the servers use points into the state dir.
for a, m in mods.items():
    for k, v in vars(m).items():
        vals = v if isinstance(v, list) else [v]
        for x in vals:
            if isinstance(x, str) and x.endswith(("data.json", "ledgers.json")) and "state/" not in x.replace(STATE, ""):
                assert x.startswith(STATE), (a, k, x)
xml = '<ENVELOPE><LEDGER NAME="Cloud Only Ledger"></LEDGER></ENVELOPE>'
import base64
b64 = "data:text/xml;base64," + base64.b64encode(xml.encode()).decode()
r = V.call("fleet_tally", "POST", "/api/ledgers", json.dumps({"file": {"name": "m.xml", "b64": b64}}))
assert r["code"] == 200, r
r = V.call("bank_tally", "POST", "/api/settings", json.dumps({"op": "company", "company": "VF (2027-28)"}))
assert r["code"] == 200, r
print(os.path.exists(STATE + "/fleet_tally/ledgers.json"), os.path.exists(STATE + "/bank_tally/data.json"))
print("Cloud Only Ledger" in json.loads(V.call("bank_tally", "GET", "/api/aliases")["body"])["suggestions"])
r = V.call("bank_tally", "POST", "/api/aliases", "not json at all")
print(r["code"])
""").split("\n")
    assert out[0] == "True True"
    assert out[1] == "True"            # master.xml uploaded in Fleet is seen by Bank
    assert out[2] == "400"             # bad body -> the handler's own error, not a crash


def test_backup_restore_roundtrip_and_mac_data_json(site, tmp_path):
    _, _, code = site
    out = _run(code, tmp_path, """
import os
V.setup("bank_tally", state_dir=STATE, out_root=STATE + "/out")
V.call("bank_tally", "POST", "/api/settings", json.dumps({"op": "company", "company": "VF (2027-28)"}))
bundle = V.export_state(STATE)
import shutil; shutil.rmtree(STATE + "/bank_tally")
print(V.import_state(bundle, "bank_tally", STATE))
print(json.load(open(STATE + "/bank_tally/data.json"))["company"])
# A data.json copied from the Mac app restores into the current app.
print(V.import_state(json.dumps({"aliases": {"zorba traders": "Keshav Minerals"}}), "fleet_tally", STATE))
""").split("\n")
    assert out[0] == "['bank_tally/data.json']"
    assert out[1] == "VF (2027-28)"
    assert out[2] == "['fleet_tally/data.json']"


def test_build_refuses_without_wheels(tmp_path):
    with pytest.raises(SystemExit):
        B.build(str(tmp_path / "out"), str(tmp_path))
    assert not (tmp_path / "out").exists()
