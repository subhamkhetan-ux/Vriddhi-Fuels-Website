"""Assemble the cloud (in-browser) build of the Bank / IOCL / Fleet -> Tally tools.

    python3 tally_cloud/build.py OUT_DIR [--wheels DIR]

Produces a static folder (published by .github/workflows/pages.yml under
``tally-tools/``) that runs the *same* apps entirely in the browser:

  OUT_DIR/index.html          landing page (links to the three tools)
  OUT_DIR/cloud.js            boots Python (Pyodide) and routes the page's
                              /api + /download calls into the real server code
  OUT_DIR/app.zip             the apps' Python code, templates and shipped data
  OUT_DIR/build.json          build id, Pyodide version, vendored wheels
  OUT_DIR/wheels/*.whl        openpyxl + et_xmlfile (pure Python; from --wheels)
  OUT_DIR/{bank,iocl,fleet}/index.html
                              each app's own index.html, unchanged except for
                              one injected <script src="../cloud.js">

Statements, PADs and invoices are read in the browser and never uploaded
anywhere; nothing here needs a server or a database.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import shutil
import sys
import tempfile
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

PYODIDE_VERSION = "0.28.3"        # ships xlrd + pymupdf; openpyxl is vendored
WHEELS = ("openpyxl-3.1.5-py2.py3-none-any.whl", "et_xmlfile-2.0.0-py3-none-any.whl")

# url folder -> python package
APPS = {"bank": "bank_tally", "iocl": "iocl_tally", "fleet": "fleet_tally"}

# Everything the three servers import or read, relative to the repo root.
_PACKAGE_FILES = {
    "bank_tally": ["*.py", "templates/*.xml"],
    "iocl_tally": ["*.py", "templates/*.xml"],
    "fleet_tally": ["*.py", "templates/*.xml", "samples/*.xlsx"],
}
_EXTRA_FILES = ["agent/__init__.py", "agent/matcher.py", "agent/normalize.py",
                "state/bank_aliases.json", "state/customers.json",
                "state/tally_ledgers.json"]


def _app_files() -> list:
    import glob
    out = []
    for pkg, pats in _PACKAGE_FILES.items():
        for pat in pats:
            out += sorted(os.path.relpath(p, ROOT)
                          for p in glob.glob(os.path.join(ROOT, pkg, pat)))
    return out + _EXTRA_FILES


def build_zip() -> bytes:
    """The apps' code + data as a deterministic zip (stable build id)."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        entries = [(rel, os.path.join(ROOT, rel)) for rel in _app_files()]
        entries.append(("vf_cloud.py", os.path.join(HERE, "vf_cloud.py")))
        for arc, src in entries:
            with open(src, "rb") as fh:
                info = zipfile.ZipInfo(arc.replace(os.sep, "/"), (2026, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                zf.writestr(info, fh.read())
    return buf.getvalue()


def inject(html: str, app_pkg: str, build_id: str) -> str:
    """Add the cloud loader to an app page. It must run before the page's own
    scripts (which call /api at load), so it goes at the end of <head>."""
    tag = (f'<script src="../cloud.js?v={build_id}" data-app="{app_pkg}" '
           f'data-build="{build_id}"></script>\n')
    if "</head>" not in html:
        raise ValueError(f"{app_pkg}/index.html has no </head>")
    return html.replace("</head>", tag + "</head>", 1)


def build(out_dir: str, wheels_dir: str | None = None) -> dict:
    missing = [w for w in WHEELS if not (wheels_dir and
                                         os.path.isfile(os.path.join(wheels_dir, w)))]
    if missing:
        raise SystemExit(f"missing wheels {missing} (pip download them into --wheels)")
    zip_bytes = build_zip()
    build_id = hashlib.sha256(zip_bytes + open(os.path.join(HERE, "cloud.js"), "rb").read()
                              ).hexdigest()[:12]
    tmp = tempfile.mkdtemp(prefix="tally-tools-")
    try:
        with open(os.path.join(tmp, "app.zip"), "wb") as fh:
            fh.write(zip_bytes)
        shutil.copy(os.path.join(HERE, "cloud.js"), os.path.join(tmp, "cloud.js"))
        shutil.copy(os.path.join(HERE, "index.html"), os.path.join(tmp, "index.html"))
        os.makedirs(os.path.join(tmp, "wheels"))
        for w in WHEELS:
            shutil.copy(os.path.join(wheels_dir, w), os.path.join(tmp, "wheels", w))
        for folder, pkg in APPS.items():
            with open(os.path.join(ROOT, pkg, "index.html"), encoding="utf-8") as fh:
                html = inject(fh.read(), pkg, build_id)
            os.makedirs(os.path.join(tmp, folder))
            with open(os.path.join(tmp, folder, "index.html"), "w", encoding="utf-8") as fh:
                fh.write(html)
        meta = {"build": build_id, "pyodide": PYODIDE_VERSION, "wheels": list(WHEELS),
                "apps": APPS}
        with open(os.path.join(tmp, "build.json"), "w", encoding="utf-8") as fh:
            json.dump(meta, fh, indent=2)
        # Only replace the output once everything above succeeded.
        if os.path.exists(out_dir):
            shutil.rmtree(out_dir)
        shutil.move(tmp, out_dir)
    finally:
        if os.path.exists(tmp):
            shutil.rmtree(tmp)
    return meta


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("out_dir")
    ap.add_argument("--wheels", help="folder holding the vendored wheels")
    args = ap.parse_args(argv)
    meta = build(args.out_dir, args.wheels)
    print(f"built tally tools {meta['build']} -> {args.out_dir}")


if __name__ == "__main__":
    sys.exit(main())
