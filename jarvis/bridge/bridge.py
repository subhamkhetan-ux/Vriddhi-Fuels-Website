"""The Jarvis bridge — runs on the Mac and does what Jarvis asks there.

Every few seconds it checks in with the ledger Supabase project
(jarvis_bridge_poll, supabase/jarvis-schema.sql), takes the next command
queued for it, runs it if it is one of the actions in actions.py, and posts
the result (jarvis_bridge_finish). Jarvis — on a phone anywhere — reads the
result and tells the owner.

Run:   ./jarvis/bridge/bridge-mac.sh start      (background; see that file)
       python -m jarvis.bridge.bridge --once    (one check, for a test)
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import platform
import signal
import socket
import sys
import time
from typing import Optional

from . import actions
from .supa import Supabase, SupaError, read_js_config

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_CONFIG = os.path.join(HERE, "config.json")
VERSION = 1
log = logging.getLogger("jarvis.bridge")


def load_config(path: str) -> dict:
    try:
        with open(path, encoding="utf-8") as f:
            cfg = json.load(f)
    except FileNotFoundError:
        sys.exit(f"No {path} yet. Copy jarvis/bridge/config.example.json to config.json and fill in the login.")
    except json.JSONDecodeError as exc:
        sys.exit(f"{path} is not valid JSON (line {exc.lineno}): {exc.msg}")
    ledger = read_js_config(os.path.join(actions.ROOT, "ledger", "config.js"))
    cfg.setdefault("name", "mac")
    cfg["supabase_url"] = cfg.get("supabase_url") or ledger.get("SUPABASE_URL", "")
    cfg["anon_key"] = cfg.get("anon_key") or ledger.get("SUPABASE_ANON_KEY", "")
    cfg.setdefault("poll_seconds", 3)
    cfg.setdefault("scripts", {})
    return cfg


class Bridge:
    def __init__(self, cfg: dict, supa: Optional[Supabase] = None, ctx: Optional[actions.Ctx] = None):
        self.cfg = cfg
        self.name = cfg["name"]
        self.supa = supa or Supabase(cfg["supabase_url"], cfg["anon_key"], cfg.get("email", ""), cfg.get("password", ""))
        self.ctx = ctx or actions.Ctx(xtrapower_config=cfg.get("xtrapower_config"), scripts=cfg.get("scripts"))
        self.info = {"version": VERSION, "host": socket.gethostname(), "os": platform.system(),
                     "actions": sorted(actions.ACTIONS), "scripts": sorted(self.ctx.scripts)}

    def step(self) -> bool:
        """One check-in. True if a command was run (so check again soon)."""
        cmd = self.supa.rpc("jarvis_bridge_poll", {"p_name": self.name, "p_info": self.info})
        if not cmd:
            return False
        cid, action, args = cmd["id"], cmd.get("action", ""), cmd.get("args") or {}
        log.info("command %s: %s %s (from %s)", cid, action, json.dumps(args, ensure_ascii=False), cmd.get("created_email", ""))
        ok, result, error = True, None, None
        try:
            result = actions.run_action(self.ctx, action, args)
        except actions.ActionError as exc:
            ok, error = False, str(exc)
        except Exception as exc:                              # never let one command stop the bridge
            log.exception("command %s crashed", cid)
            ok, error = False, f"{type(exc).__name__}: {exc}"
        log.info("command %s: %s", cid, "done" if ok else f"failed — {error}")
        self.supa.rpc("jarvis_bridge_finish", {"p_id": cid, "p_ok": ok, "p_result": result, "p_error": error})
        return True

    def run_forever(self) -> None:
        stop = {"now": False}
        signal.signal(signal.SIGTERM, lambda *_: stop.update(now=True))
        delay = float(self.cfg["poll_seconds"])
        failures = 0
        log.info("Jarvis bridge '%s' started — checking every %ss.", self.name, delay)
        while not stop["now"]:
            try:
                busy = self.step()
                if failures:
                    log.info("connected again")
                failures = 0
                if busy:
                    continue
            except SupaError as exc:
                failures += 1
                if failures in (1, 5) or failures % 60 == 0:
                    log.warning("can't check in (%s) — will keep trying", exc)
            time.sleep(delay if not failures else min(60.0, delay * (2 ** min(failures, 5))))


def main(argv=None) -> None:
    ap = argparse.ArgumentParser(description="Jarvis bridge — runs Jarvis's Mac actions.")
    ap.add_argument("--config", default=DEFAULT_CONFIG)
    ap.add_argument("--once", action="store_true", help="check in once, run at most one command, exit")
    a = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s", datefmt="%Y-%m-%d %H:%M:%S")
    bridge = Bridge(load_config(a.config))
    if a.once:
        try:
            ran = bridge.step()
        except SupaError as exc:
            sys.exit(f"✗ {exc}")
        print("✓ Connected." + (" Ran one command." if ran else " Nothing was waiting."))
        return
    bridge.run_forever()


if __name__ == "__main__":
    main()
