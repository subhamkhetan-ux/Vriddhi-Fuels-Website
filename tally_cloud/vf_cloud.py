"""Run the three local Tally apps' own server code inside the browser (Pyodide).

The cloud build (see ``build.py``) serves each app's unchanged ``index.html``
plus ``cloud.js``. The page still calls ``fetch("/api/...")`` exactly as it does
against the Mac server; ``cloud.js`` hands each such request to :func:`call`,
which runs the app's real ``Handler.do_GET`` / ``do_POST`` with no HTTP server
and no network — every response goes through the handler's ``_send``, which we
capture. So the cloud version is the same code, byte for byte.

Where the Mac apps keep local files next to their code, the cloud keeps them
under ``/vf_state`` (persisted in the browser's IndexedDB by ``cloud.js``):
``data.json`` (mappings / settings) and ``ledgers.json`` (uploaded master.xml).
Generated XML goes to an in-memory ``/tmp`` folder and is downloaded from there.
"""

from __future__ import annotations

import importlib
import io
import json
import os

APPS = ("bank_tally", "iocl_tally", "fleet_tally")
STATE_DIR = "/vf_state"
OUT_ROOT = "/tmp/vf_out"

_MODS: dict = {}


def setup(app: str, state_dir: str = STATE_DIR, out_root: str = OUT_ROOT):
    """Import ``<app>.server`` and point its local files at ``state_dir``."""
    if app not in APPS:
        raise ValueError(f"unknown app {app!r}")
    mod = importlib.import_module(f"{app}.server")
    uploads = {a: os.path.join(state_dir, a, "ledgers.json") for a in APPS}
    os.makedirs(os.path.join(state_dir, app), exist_ok=True)
    mod.DATA_PATH = os.path.join(state_dir, app, "data.json")
    mod.LEDGERS_PATH = uploads[app]
    mod.OUT_DIR = os.path.join(out_root, app)
    # A master.xml uploaded in any of the three apps is seen by all three.
    if hasattr(mod, "_OTHER_UPLOADS"):                       # bank
        mod._OTHER_UPLOADS = [uploads[a] for a in APPS if a != app]
    if hasattr(mod, "_UPLOADED_LEDGERS"):                    # iocl / fleet
        mod._UPLOADED_LEDGERS = [uploads[app]] + [uploads[a] for a in APPS if a != app]
    _MODS[app] = mod
    return mod


def call(app: str, method: str, path: str, body=b"") -> dict:
    """Run one request through ``<app>.server.Handler``; returns
    ``{"code", "ctype", "headers", "body"}`` (body as bytes)."""
    mod = _MODS.get(app) or setup(app)
    if isinstance(body, str):
        body = body.encode("utf-8")
    body = bytes(body or b"")
    h = mod.Handler.__new__(mod.Handler)          # no socket, no server
    h.command, h.path = method, path
    h.headers = {"Content-Length": str(len(body)), "Content-Type": "application/json"}
    h.rfile = io.BytesIO(body)
    out = {"code": 404, "ctype": "text/plain", "headers": {}, "body": b"not found"}

    def _send(code, payload, ctype, extra=None):
        out.update(code=code, ctype=ctype, headers=dict(extra or {}),
                   body=payload if isinstance(payload, bytes) else bytes(payload))

    h._send = _send
    fn = getattr(h, f"do_{method}", None)
    if fn is None:
        return {"code": 405, "ctype": "text/plain", "headers": {}, "body": b"method not allowed"}
    try:
        fn()
    except Exception as exc:                      # surface it in the page, not a blank
        out.update(code=500, ctype="application/json", headers={},
                   body=json.dumps({"error": f"{type(exc).__name__}: {exc}"}).encode())
    return out


def call_js(app: str, method: str, path: str, body: str = "") -> tuple:
    """:func:`call` flattened for JavaScript: (code, ctype, headers_json, body)."""
    r = call(app, method, path, body)
    return r["code"], r["ctype"], json.dumps(r["headers"]), r["body"]


# --- settings backup / restore (move mappings between devices or the Mac) -----

def export_state(state_dir: str = STATE_DIR) -> str:
    """All three apps' local files as one JSON bundle."""
    bundle = {"vriddhi_tally_backup": 1, "files": {}}
    for app in APPS:
        for name in ("data.json", "ledgers.json"):
            p = os.path.join(state_dir, app, name)
            try:
                with open(p, encoding="utf-8") as fh:
                    bundle["files"][f"{app}/{name}"] = json.load(fh)
            except (OSError, ValueError):
                pass
    return json.dumps(bundle, indent=2, ensure_ascii=False)


def import_state(text: str, app: str, state_dir: str = STATE_DIR) -> list:
    """Restore a bundle from :func:`export_state`, or a single ``data.json``
    copied from the Mac app (applied to ``app``). Returns what was written."""
    data = json.loads(text)
    if isinstance(data, dict) and data.get("vriddhi_tally_backup"):
        files = data.get("files", {})
    elif isinstance(data, dict):
        files = {f"{app}/data.json": data}
    elif isinstance(data, list):
        files = {f"{app}/ledgers.json": data}
    else:
        raise ValueError("not a Tally tools backup or data.json")
    written = []
    for rel, content in files.items():
        a, _, name = rel.partition("/")
        if a not in APPS or name not in ("data.json", "ledgers.json"):
            continue
        os.makedirs(os.path.join(state_dir, a), exist_ok=True)
        with open(os.path.join(state_dir, a, name), "w", encoding="utf-8") as fh:
            json.dump(content, fh, indent=2, ensure_ascii=False)
        written.append(rel)
    if app in _MODS and hasattr(_MODS[app], "_apply_accounts"):
        _MODS[app]._apply_accounts()
    return written
