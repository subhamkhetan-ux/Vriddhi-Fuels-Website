"""Housekeeping for the in-browser Tally import tools (this ``tally-tools/`` folder).

The tools are served straight from the repo by GitHub Pages ("Deploy from a
branch": the whole ``main`` branch is the site), at ``…/tally-tools/``:

  tally-tools/index.html          landing page
  tally-tools/{bank,iocl,fleet}/  tiny loaders — each fetches the app's own
                                  ``<app>/index.html`` and adds ``cloud.js``
  tally-tools/cloud.js            starts Python in the browser (Pyodide), loads
                                  the apps' code listed in ``files.json`` from the
                                  site, and answers the page's /api + /download
  tally-tools/vf_cloud.py         runs the apps' real request handlers
  tally-tools/wheels/             openpyxl + et_xmlfile (Pyodide lacks them)

Because the apps' code is read from the live branch, the cloud version is
always the current code — nothing to rebuild. Two chores remain:

    python3 tally-tools/build.py manifest   # rewrite files.json after adding a module
    python3 tally-tools/build.py check      # fail if files.json is out of date (tests run it)
    python3 tally-tools/build.py site OUT   # copy tools + app files into OUT (Actions deploy)

Statements, PADs and invoices are read in the browser and never uploaded.
"""

from __future__ import annotations

import glob
import json
import os
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
MANIFEST = os.path.join(HERE, "files.json")

PYODIDE_VERSION = "0.28.3"        # ships xlrd + pymupdf; openpyxl is in wheels/
WHEELS = ["openpyxl-3.1.5-py2.py3-none-any.whl", "et_xmlfile-2.0.0-py3-none-any.whl"]
APPS = {"bank": "bank_tally", "iocl": "iocl_tally", "fleet": "fleet_tally"}
# Python packages the servers import; their __init__.py is created empty in the
# browser (GitHub Pages' Jekyll build does not publish files starting with "_").
PACKAGES = ["agent", "bank_tally", "iocl_tally", "fleet_tally"]

_PATTERNS = [
    "bank_tally/*.py", "bank_tally/templates/*.xml", "bank_tally/index.html",
    "iocl_tally/*.py", "iocl_tally/templates/*.xml", "iocl_tally/index.html",
    "fleet_tally/*.py", "fleet_tally/templates/*.xml", "fleet_tally/samples/*.xlsx",
    "fleet_tally/index.html",
    "agent/matcher.py", "agent/normalize.py",
    "state/bank_aliases.json", "state/customers.json", "state/tally_ledgers.json",
]


def app_files() -> list:
    """Repo-relative files the tools load (everything the three servers read)."""
    out = []
    for pat in _PATTERNS:
        for p in sorted(glob.glob(os.path.join(ROOT, pat))):
            rel = os.path.relpath(p, ROOT).replace(os.sep, "/")
            if not os.path.basename(rel).startswith("_"):
                out.append(rel)
    return out


def manifest() -> dict:
    return {"pyodide": PYODIDE_VERSION, "wheels": WHEELS, "packages": PACKAGES,
            "apps": APPS, "files": app_files()}


def check() -> list:
    """Problems with the committed manifest / folder (empty list = all good)."""
    problems = []
    try:
        with open(MANIFEST, encoding="utf-8") as fh:
            current = json.load(fh)
    except (OSError, ValueError):
        current = None
    if current != manifest():
        problems.append("tally-tools/files.json is out of date — run "
                        "`python3 tally-tools/build.py manifest`")
    for w in WHEELS:
        if not os.path.isfile(os.path.join(HERE, "wheels", w)):
            problems.append(f"missing tally-tools/wheels/{w}")
    for folder in APPS:
        if not os.path.isfile(os.path.join(HERE, folder, "index.html")):
            problems.append(f"missing tally-tools/{folder}/index.html")
    return problems


def copy_site(out_dir: str) -> None:
    """Lay the tools out in ``out_dir`` exactly as the branch site has them
    (tally-tools/ next to the app folders), for an Actions-built Pages site."""
    for rel in app_files():
        dst = os.path.join(out_dir, rel)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copy(os.path.join(ROOT, rel), dst)
    shutil.copytree(HERE, os.path.join(out_dir, "tally-tools"), dirs_exist_ok=True,
                    ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))


def main(argv=None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    cmd = args[0] if args else ""
    if cmd == "manifest":
        with open(MANIFEST, "w", encoding="utf-8") as fh:
            json.dump(manifest(), fh, indent=1)
            fh.write("\n")
        print(f"wrote {MANIFEST} ({len(app_files())} files)")
        return 0
    if cmd == "check":
        problems = check()
        for p in problems:
            print(p)
        return 1 if problems else 0
    if cmd == "site" and len(args) == 2:
        problems = check()
        if problems:
            print("\n".join(problems))
            return 1
        copy_site(args[1])
        print(f"copied tally-tools + {len(app_files())} app files -> {args[1]}")
        return 0
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main())
