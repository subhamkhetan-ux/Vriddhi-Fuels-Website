"""What the bridge can do on the Mac — the only things it will ever run.

A command from Jarvis names an action and gives it arguments; anything not
in ACTIONS is refused. Scripts are run only if the owner listed them in the
bridge's config.json on this Mac (``scripts``) — never a command line sent
from the cloud.

Each action returns {"text": <one or two plain sentences for Jarvis to say>,
...data}. Raise ActionError for a problem worth telling the owner.
"""

from __future__ import annotations

import os
import re
import socket
import subprocess
import sys
from typing import Any, Callable, Optional

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))   # the repo


class ActionError(Exception):
    pass


class Ctx:
    """Where things are. Tests point it at a temporary folder."""

    def __init__(self, root: str = ROOT, xtrapower_config: Optional[str] = None,
                 scripts: Optional[dict] = None, run: Callable = subprocess.run, popen: Callable = subprocess.Popen,
                 port_open: Optional[Callable[[int], bool]] = None):
        self.root = root
        self.xp_config = xtrapower_config or os.path.join(root, "xtrapower", "config.json")
        self.scripts = scripts or {}
        self.run = run
        self.popen = popen
        self.port_open = port_open or _port_open


def _port_open(port: int) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", int(port)), timeout=0.5):
            return True
    except OSError:
        return False


def _norm(s: Any) -> str:
    return re.sub(r"[^a-z0-9]+", " ", str(s or "").lower()).strip()


def pick_account(accounts: list, query: str) -> dict:
    """The account the owner means: by label or customer id — exact, then
    starts-with, then every word found. Several matches -> ask which."""
    q = _norm(query)
    if not q:
        raise ActionError("Which account? " + ", ".join(a.get("label", "?") for a in accounts))
    keys = [(a, _norm(a.get("label")), _norm(a.get("customer_id"))) for a in accounts]
    for test in (
        lambda l, c: q in (l, c),
        lambda l, c: l.startswith(q) or (c and c.startswith(q)),
        lambda l, c: all(w in l.split() or w in c for w in q.split()),
        lambda l, c: q in l or (c and q in c),
        lambda l, c: bool(l) and all(w in q.split() for w in l.split()),     # "shyam metalics account"
    ):
        hits = [a for a, l, c in keys if test(l, c)]
        if len(hits) == 1:
            return hits[0]
        if len(hits) > 1:
            raise ActionError(f'"{query}" matches several accounts: ' + ", ".join(a.get("label", "?") for a in hits) + ". Which one?")
    raise ActionError(f'No XtraPower account matches "{query}". Accounts: ' + ", ".join(a.get("label", "?") for a in accounts))


# ---- XtraPower ------------------------------------------------------------------

def _xp_app(ctx: Ctx):
    if ctx.root not in sys.path:
        sys.path.insert(0, ctx.root)
    from xtrapower import manage                     # stdlib only; reads/writes xtrapower/config.json
    if not os.path.exists(ctx.xp_config):
        raise ActionError("XtraPower isn't set up on this Mac yet (no xtrapower/config.json) — run ./xtrapower/setup-mac.sh.")
    return manage, manage.App(ctx.xp_config, manage.DEFAULT_PORT)


def _monitor(ctx: Ctx, verb: str) -> str:
    script = os.path.join(ctx.root, "xtrapower", "monitor-mac.sh")
    try:
        proc = ctx.run(["bash", script, verb], cwd=ctx.root, capture_output=True, text=True, timeout=60)
    except subprocess.TimeoutExpired:
        raise ActionError(f"monitor-mac.sh {verb} took too long.") from None
    out = ((proc.stdout or "") + (proc.stderr or "")).strip()
    if proc.returncode != 0:
        raise ActionError(out or f"monitor-mac.sh {verb} failed.")
    return out


def _status_data(ctx: Ctx) -> dict:
    manage, app = _xp_app(ctx)
    snap = app.snapshot()
    accts = []
    for a in snap["accounts"]:
        accts.append({
            "label": a["label"], "customer_id": a["customer_id"], "watch": a["watch"],
            "chrome_open": ctx.port_open(a["cdp_port"]) if a.get("cdp_port") else False,
            "last_ccms": a["last_ccms"], "updated_at": a["updated_at"],
            "last_error": a["last_error"], "last_error_at": a["last_error_at"],
        })
    return {"running": snap["monitor"]["running"], "accounts": accts}


def xp_status(ctx: Ctx, args: dict) -> dict:
    d = _status_data(ctx)
    watched = [a for a in d["accounts"] if a["watch"]]
    parts = [f"Monitoring is {'ON' if d['running'] else 'OFF'}."]
    for a in d["accounts"]:
        bits = ["watching" if a["watch"] else "off"]
        if a["watch"] and not a["chrome_open"]:
            bits.append("Chrome window closed")
        if a["last_ccms"]:
            bits.append(f"CCMS {a['last_ccms']}")
        parts.append(f"{a['label']}: {', '.join(bits)}.")
    if d["running"] and not watched:
        parts.append("No account is being watched.")
    return {"text": " ".join(parts), **d}


def xp_start(ctx: Ctx, args: dict) -> dict:
    out = _monitor(ctx, "start")
    return {"text": "XtraPower monitoring is ON." if "ON" in out or "Already" in out else out, "output": out}


def xp_stop(ctx: Ctx, args: dict) -> dict:
    out = _monitor(ctx, "stop")
    return {"text": "XtraPower monitoring is OFF.", "output": out}


def xp_logs(ctx: Ctx, args: dict) -> dict:
    n = max(1, min(int(args.get("lines") or 20), 80))
    path = os.path.join(ctx.root, "xtrapower", "monitor.log")
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            lines = f.read().splitlines()[-n:]
    except OSError:
        lines = []
    return {"text": f"The last {len(lines)} log lines." if lines else "No monitor log yet.", "lines": lines}


def xp_open_window(ctx: Ctx, args: dict) -> dict:
    manage, app = _xp_app(ctx)
    acct = pick_account(app.read()["accounts"], args.get("account", ""))
    try:
        app.open_window(manage.account_key(acct))
    except manage.ValidationError as exc:
        raise ActionError(str(exc)) from None
    return {"text": f"Opened the Chrome window for {acct.get('label')}.", "account": acct.get("label")}


def xp_watch(ctx: Ctx, args: dict) -> dict:
    """Start / stop watching one account: switch it on in config.json, open its
    Chrome window if closed, and make sure the monitor runs (or, when nothing
    is watched any more, stop it)."""
    manage, app = _xp_app(ctx)
    cfg = app.read()
    acct = pick_account(cfg["accounts"], args.get("account", ""))
    want = args.get("watch", True) not in (False, "false", "off", "no", 0)
    label = acct.get("label") or acct.get("customer_id")
    app.set_watch(manage.account_key(acct), want)
    notes = []
    running = manage.monitor_status(app.pid_path)["running"]
    if want:
        if acct.get("cdp_port") and not ctx.port_open(acct["cdp_port"]):
            try:
                app.open_window(manage.account_key(acct))
                notes.append("opened its Chrome window" + ("" if acct.get("password") else " — log in there and leave it on Balance Info"))
            except manage.ValidationError as exc:
                notes.append(f"couldn't open Chrome ({exc})")
        if not running:
            _monitor(ctx, "start")
            notes.append("started the monitor")
        text = f"Now watching {label}" + (f" — {', '.join(notes)}." if notes else ". The monitor picks it up on its next check (about 2 minutes).")
    else:
        others = [a for a in app.read()["accounts"] if a.get("watch", True)]
        if not others and running:
            _monitor(ctx, "stop")
            text = f"Stopped watching {label}. No account is left, so I turned the monitor off."
        else:
            text = f"Stopped watching {label}." + (f" Still watching: {', '.join(a.get('label', '?') for a in others)}." if others else "")
    return {"text": text, "account": label, "watch": want}


# ---- owner's scripts (config.json "scripts") -------------------------------------

def script_list(ctx: Ctx, args: dict) -> dict:
    items = [{"name": k, "label": v.get("label", k), "background": bool(v.get("background"))} for k, v in sorted(ctx.scripts.items())]
    return {"text": ("Scripts I can run: " + ", ".join(i["label"] for i in items) + ".") if items else
            "No scripts are set up for me on the Mac yet (jarvis/bridge/config.json → scripts).", "scripts": items}


def script_run(ctx: Ctx, args: dict) -> dict:
    name = str(args.get("name") or "")
    spec = ctx.scripts.get(name)
    if not spec:
        for k, v in ctx.scripts.items():                 # by its label too
            if _norm(v.get("label")) == _norm(name):
                name, spec = k, v
                break
    if not spec:
        raise ActionError(f'No script named "{name}" is set up on the Mac. ' + script_list(ctx, {})["text"])
    cmd = spec.get("run")
    if not isinstance(cmd, list) or not cmd or not all(isinstance(x, str) for x in cmd):
        raise ActionError(f'Script "{name}": "run" must be a list like ["bash", "local_agent/agentctl.sh", "status"].')
    label = spec.get("label", name)
    if spec.get("background"):
        logs = os.path.join(ctx.root, "jarvis", "bridge", "logs")
        os.makedirs(logs, exist_ok=True)
        log = open(os.path.join(logs, f"{name}.log"), "ab")
        ctx.popen(cmd, cwd=ctx.root, stdout=log, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, start_new_session=True)
        return {"text": f"Started {label} on the Mac.", "script": name}
    try:
        proc = ctx.run(cmd, cwd=ctx.root, capture_output=True, text=True, timeout=int(spec.get("timeout", 120)))
    except subprocess.TimeoutExpired:
        raise ActionError(f"{label} took too long.") from None
    out = ((proc.stdout or "") + (proc.stderr or "")).strip()[-3000:]
    if proc.returncode != 0:
        raise ActionError(f"{label} failed (exit {proc.returncode}): {out[-500:]}")
    return {"text": f"Ran {label}.", "output": out, "script": name}


ACTIONS: dict = {
    "xtrapower.status": xp_status,
    "xtrapower.start": xp_start,
    "xtrapower.stop": xp_stop,
    "xtrapower.logs": xp_logs,
    "xtrapower.watch": xp_watch,
    "xtrapower.open_window": xp_open_window,
    "script.list": script_list,
    "script.run": script_run,
}


def run_action(ctx: Ctx, action: str, args: Optional[dict]) -> dict:
    if action == "bridge.ping":
        return {"text": "The Mac is online.", "actions": sorted(ACTIONS), "scripts": sorted(ctx.scripts)}
    fn = ACTIONS.get(action)
    if not fn:
        raise ActionError(f'The bridge doesn\'t know "{action}".')
    return fn(ctx, args if isinstance(args, dict) else {})
