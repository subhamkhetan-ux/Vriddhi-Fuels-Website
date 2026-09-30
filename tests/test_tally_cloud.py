"""Tests for the in-browser Tally import tools (tally-tools/).

The browser loads exactly the files listed in tally-tools/files.json from the
GitHub Pages site (which never publishes files starting with "_"), creates
empty package __init__.py files, and runs vf_cloud. These tests do the same in a
subprocess, from a copy of only those files, so a file missing from the list
fails here — and the real server modules / local data.json are never touched.
"""

import json
import os
import shutil
import subprocess
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TOOLS = os.path.join(ROOT, "tally-tools")
sys.path.insert(0, TOOLS)
import build as B  # noqa: E402


@pytest.fixture(scope="module")
def code(tmp_path_factory):
    """What cloud.js assembles in the browser's file system."""
    d = tmp_path_factory.mktemp("code")
    meta = json.load(open(os.path.join(TOOLS, "files.json"), encoding="utf-8"))
    for rel in meta["files"]:
        assert not os.path.basename(rel).startswith("_"), rel     # Pages won't serve it
        os.makedirs(d / os.path.dirname(rel), exist_ok=True)
        shutil.copy(os.path.join(ROOT, rel), d / rel)
    shutil.copy(os.path.join(TOOLS, "vf_cloud.py"), d / "vf_cloud.py")
    for pkg in meta["packages"]:
        os.makedirs(d / pkg, exist_ok=True)
        (d / pkg / "__init__.py").write_text("")
    return d


def _run(code_dir, state_dir, script):
    """Run ``script`` with only the browser's files (not the repo) importable."""
    prog = ("import sys; sys.path[:] = [p for p in sys.path if p and "
            f"not p.startswith({ROOT!r})]; sys.path.insert(0, {str(code_dir)!r})\n"
            f"import json, vf_cloud as V\nSTATE = {str(state_dir)!r}\n" + script)
    r = subprocess.run([sys.executable, "-c", prog], capture_output=True, text=True,
                       cwd=str(state_dir), timeout=120)
    assert r.returncode == 0, r.stderr
    return r.stdout


def test_manifest_and_folder_are_up_to_date():
    # Fails when a module/template is added without `build.py manifest`.
    assert B.check() == []


def test_loader_pages_point_at_the_apps():
    for folder, pkg in B.APPS.items():
        html = open(os.path.join(TOOLS, folder, "index.html"), encoding="utf-8").read()
        assert f'<script src="../cloud.js" data-app="{pkg}" data-page="../../{pkg}/index.html">' in html
        assert os.path.isfile(os.path.join(ROOT, pkg, "index.html"))
        assert f"{pkg}/index.html" in B.app_files()
    landing = open(os.path.join(TOOLS, "index.html"), encoding="utf-8").read()
    for folder in B.APPS:
        assert f'href="{folder}/"' in landing


def test_bundle_serves_all_three_apps(code, tmp_path):
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


def test_state_lives_in_state_dir_and_is_shared(code, tmp_path):
    out = _run(code, tmp_path, """
import os, base64
mods = {a: V.setup(a, state_dir=STATE, out_root=STATE + "/out") for a in V.APPS}
# Every local file path the servers write points into the state dir.
for a, m in mods.items():
    for k, v in vars(m).items():
        for x in (v if isinstance(v, list) else [v]):
            if isinstance(x, str) and x.endswith(("data.json", "ledgers.json")) and "state/" not in x.replace(STATE, ""):
                assert x.startswith(STATE), (a, k, x)
xml = '<ENVELOPE><LEDGER NAME="Cloud Only Ledger"></LEDGER></ENVELOPE>'
b64 = "data:text/xml;base64," + base64.b64encode(xml.encode()).decode()
r = V.call("fleet_tally", "POST", "/api/ledgers", json.dumps({"file": {"name": "m.xml", "b64": b64}}))
assert r["code"] == 200, r
r = V.call("bank_tally", "POST", "/api/settings", json.dumps({"op": "company", "company": "VF (2027-28)"}))
assert r["code"] == 200, r
print(os.path.exists(STATE + "/fleet_tally/ledgers.json"), os.path.exists(STATE + "/bank_tally/data.json"))
print("Cloud Only Ledger" in json.loads(V.call("bank_tally", "GET", "/api/aliases")["body"])["suggestions"])
print(V.call("bank_tally", "POST", "/api/aliases", "not json at all")["code"])
""").split("\n")
    assert out[0] == "True True"
    assert out[1] == "True"            # master.xml uploaded in Fleet is seen by Bank
    assert out[2] == "400"             # bad body -> the handler's own error, not a crash


def test_backup_restore_roundtrip_and_mac_data_json(code, tmp_path):
    out = _run(code, tmp_path, """
import shutil
V.setup("bank_tally", state_dir=STATE, out_root=STATE + "/out")
V.call("bank_tally", "POST", "/api/settings", json.dumps({"op": "company", "company": "VF (2027-28)"}))
bundle = V.export_state(STATE)
shutil.rmtree(STATE + "/bank_tally")
print(V.import_state(bundle, "bank_tally", STATE))
print(json.load(open(STATE + "/bank_tally/data.json"))["company"])
print(V.import_state(json.dumps({"aliases": {"zorba traders": "Keshav Minerals"}}), "fleet_tally", STATE))
""").split("\n")
    assert out[0] == "['bank_tally/data.json']"
    assert out[1] == "VF (2027-28)"
    assert out[2] == "['fleet_tally/data.json']"


def test_site_copy_for_actions_deploy(tmp_path):
    B.copy_site(str(tmp_path))
    for rel in ["tally-tools/index.html", "tally-tools/cloud.js", "tally-tools/files.json",
                "tally-tools/bank/index.html", "tally-tools/wheels/" + B.WHEELS[0],
                "bank_tally/server.py", "iocl_tally/templates/K1.xml", "state/customers.json"]:
        assert (tmp_path / rel).is_file(), rel
    assert not list(tmp_path.rglob("__pycache__"))
