"""Connect to the IOCL automation PC with AnyDesk's unattended access and take
a screenshot of what its screen shows (normally the tank stock page).

Runs on the India server (infra/anydesk/setup.sh installs the client). The
AnyDesk client draws on a private virtual display (Xvfb); nothing is
installed on, or changed on, the IOCL PC. The password goes to AnyDesk on
stdin (its documented ``--with-password`` mode), never on a command line.
"""
from __future__ import annotations

import os
import re
import shutil
import signal
import subprocess
import time

DISPLAY = ":98"                  # XtraPower uses :99
SCREEN = "1920x1080x24"


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


def capture(anydesk_id: str, password: str, *, connect_wait: int = 60, settle: int = 12) -> tuple[bytes, list]:
    """Returns the PNG of the virtual screen and the windows seen on it."""
    for tool in ("anydesk", "Xvfb", "xdotool", "import"):
        if not shutil.which(tool):
            raise CaptureError(f"{tool} is not installed; run infra/anydesk/setup.sh on the server.")
    if not re.fullmatch(r"[0-9 ]{9,13}|[A-Za-z0-9._@-]{3,64}", anydesk_id or ""):
        raise CaptureError("ANYDESK_ID must be the IOCL PC's AnyDesk number or alias.")
    if not password:
        raise CaptureError("ANYDESK_PASSWORD (the unattended-access password) is not set.")
    env = {**os.environ, "DISPLAY": DISPLAY}
    xvfb = subprocess.Popen(["Xvfb", DISPLAY, "-screen", "0", SCREEN, "-nolisten", "tcp"],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    client = None
    try:
        time.sleep(2)
        client = subprocess.Popen(["anydesk", anydesk_id.replace(" ", ""), "--with-password"],
                                  stdin=subprocess.PIPE, stdout=subprocess.DEVNULL,
                                  stderr=subprocess.DEVNULL, env=env, start_new_session=True)
        client.stdin.write((password + "\n").encode())
        client.stdin.close()
        # The session window is the large one; AnyDesk's own small windows
        # (main window, dialogs) come first.
        deadline, session = time.monotonic() + connect_wait, None
        while time.monotonic() < deadline and session is None:
            time.sleep(2)
            big = [w for w in windows(env) if w[2] >= 600 and w[3] >= 400]
            session = big[-1] if big else None
        if session:
            _run(["xdotool", "windowmove", session[0], "0", "0"], env)
            _run(["xdotool", "windowsize", session[0], "100%", "100%"], env)
        time.sleep(settle)             # let the remote screen finish drawing
        png = subprocess.run(["import", "-window", "root", "png:-"], env=env,
                             capture_output=True, timeout=30).stdout
        if not png.startswith(b"\x89PNG"):
            raise CaptureError("The screenshot of the virtual display failed.")
        return png, windows(env)
    finally:
        for proc in (client, xvfb):
            if proc and proc.poll() is None:
                try:
                    os.killpg(proc.pid, signal.SIGTERM)
                except OSError:
                    pass
