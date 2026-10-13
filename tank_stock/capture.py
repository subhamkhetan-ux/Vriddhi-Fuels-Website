"""Connect to the IOCL automation PC with AnyDesk's unattended access and take
a screenshot of what its screen shows (normally the tank stock page).

Runs on the India server (infra/anydesk/setup.sh installs the client). The
AnyDesk client draws on a private virtual display (Xvfb); nothing is
installed on, or changed on, the IOCL PC. The password goes to AnyDesk on
stdin (its documented ``--with-password`` mode), never on a command line.

The PC's AnyDesk alternates between two IDs every few days, and only one is
online (the green dot in the AnyDesk app). AnyDesk can't be asked whether a
remote ID is online, so each ID is tried in turn: an offline one never opens
a session window, only a small "not available" message. The ID that worked
last is tried first.
"""
from __future__ import annotations

import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import time

DISPLAY = ":98"                  # XtraPower uses :99
SCREEN = "1920x1080x24"
LAST_ID = Path(os.environ.get("TANK_STOCK_STATE", Path.home() / ".cache" / "tank_stock")) / "last-id"


class CaptureError(Exception):
    """Credential-free, safe for the public job log."""


def _run(cmd, env, timeout=15) -> str:
    try:
        return subprocess.run(cmd, env=env, capture_output=True, text=True, timeout=timeout).stdout
    except (OSError, subprocess.TimeoutExpired):
        return ""


def windows(env) -> list[tuple[str, str, int, int]]:
    """Visible windows on the virtual display: (id, title, width, height)."""
    found = []
    for wid in _run(["xdotool", "search", "--onlyvisible", "--name", "."], env).split():
        title = _run(["xdotool", "getwindowname", wid], env).strip()
        geo = _run(["xdotool", "getwindowgeometry", "--shell", wid], env)
        size = dict(re.findall(r"(WIDTH|HEIGHT)=(\d+)", geo))
        found.append((wid, title, int(size.get("WIDTH", 0)), int(size.get("HEIGHT", 0))))
    return found


def parse_ids(raw: str) -> list[str]:
    """``ANYDESK_IDS``: the PC's AnyDesk numbers or aliases, comma/newline separated."""
    ids = [re.sub(r"\s+", "", part) for part in re.split(r"[,;\n]", raw or "")]
    ids = [i for i in ids if i]
    if not ids:
        raise CaptureError("Set ANYDESK_IDS to the IOCL PC's AnyDesk numbers (both, comma separated).")
    for i in ids:
        if not re.fullmatch(r"[0-9]{9,12}|[A-Za-z0-9._@-]{3,64}", i):
            raise CaptureError("Each entry in ANYDESK_IDS must be an AnyDesk number or alias.")
    return list(dict.fromkeys(ids))


def ordered(ids: list[str]) -> list[str]:
    """The ID that connected last time first."""
    try:
        last = LAST_ID.read_text(encoding="utf-8").strip()
    except OSError:
        last = ""
    return sorted(ids, key=lambda i: i != last)


def remember(anydesk_id: str) -> None:
    try:
        LAST_ID.parent.mkdir(parents=True, exist_ok=True)
        LAST_ID.write_text(anydesk_id, encoding="utf-8")
    except OSError:
        pass


def _stop(proc) -> None:
    if proc and proc.poll() is None:
        try:
            os.killpg(proc.pid, signal.SIGTERM)
            proc.wait(timeout=10)
        except (OSError, subprocess.TimeoutExpired):
            pass


def _connect(anydesk_id: str, password: str, env, wait: int):
    """Start a session; returns (client process, session window) or (proc, None)."""
    client = subprocess.Popen(["anydesk", anydesk_id, "--with-password"],
                              stdin=subprocess.PIPE, stdout=subprocess.DEVNULL,
                              stderr=subprocess.DEVNULL, env=env, start_new_session=True)
    client.stdin.write((password + "\n").encode())
    client.stdin.close()
    # The session window is the large one; AnyDesk's own small windows
    # (main window, "not available" and other messages) don't count.
    deadline = time.monotonic() + wait
    while time.monotonic() < deadline:
        time.sleep(2)
        big = [w for w in windows(env) if w[2] >= 600 and w[3] >= 400]
        if big:
            return client, big[-1]
    return client, None


def capture(ids: list[str], password: str, *, connect_wait: int = 35,
            settle: int = 12) -> tuple[bytes, list, int]:
    """Screenshot via whichever ID is online. Returns (PNG, windows seen,
    1-based position of the ID used in ``ids``)."""
    for tool in ("anydesk", "Xvfb", "xdotool", "import"):
        if not shutil.which(tool):
            raise CaptureError(f"{tool} is not installed; run infra/anydesk/setup.sh on the server.")
    if not password:
        raise CaptureError("ANYDESK_PASSWORD (the unattended-access password) is not set.")
    env = {**os.environ, "DISPLAY": DISPLAY}
    xvfb = subprocess.Popen(["Xvfb", DISPLAY, "-screen", "0", SCREEN, "-nolisten", "tcp"],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    client = None
    try:
        time.sleep(2)
        for anydesk_id in ordered(ids):
            client, session = _connect(anydesk_id, password, env, connect_wait)
            if session:
                break
            _stop(client)
            client = None
        else:
            raise CaptureError(f"None of the {len(ids)} AnyDesk IDs opened a session (PC off, "
                               "offline, or the password changed).")
        remember(anydesk_id)
        _run(["xdotool", "windowmove", session[0], "0", "0"], env)
        _run(["xdotool", "windowsize", session[0], "100%", "100%"], env)
        time.sleep(settle)             # let the remote screen finish drawing
        png = subprocess.run(["import", "-window", "root", "png:-"], env=env,
                             capture_output=True, timeout=30).stdout
        if not png.startswith(b"\x89PNG"):
            raise CaptureError("The screenshot of the virtual display failed.")
        return png, windows(env), ids.index(anydesk_id) + 1
    finally:
        _stop(client)
        _stop(xvfb)
