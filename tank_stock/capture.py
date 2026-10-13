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

As on a desktop, AnyDesk's main window is started first (with a D-Bus session
bus, which a bare server job lacks), and ``anydesk <ID>`` hands it the
connection request.
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
# AnyDesk logs to these trace files, not to its console.
TRACES = (Path.home() / ".anydesk" / "anydesk.trace", Path("/var/log/anydesk.trace"))


class CaptureError(Exception):
    """Credential-free, safe for the public job log. ``attempts`` carries what
    each failed connection showed (screenshots, windows, AnyDesk's output)
    for private delivery to Telegram only."""

    def __init__(self, message, attempts=(), trace=""):
        super().__init__(message)
        self.attempts = list(attempts)
        self.trace = trace


def _run(cmd, env, timeout=15) -> str:
    try:
        return subprocess.run(cmd, env=env, capture_output=True, text=True, timeout=timeout).stdout
    except (OSError, subprocess.TimeoutExpired):
        return ""


def windows(env) -> list[tuple[str, str, int, int]]:
    """Visible windows on the virtual display, untitled ones too: (id, title, width, height)."""
    found = []
    ids = (_run(["xdotool", "search", "--onlyvisible", "--name", "."], env).split()
           + _run(["xdotool", "search", "--onlyvisible", "--class", "."], env).split())
    for wid in dict.fromkeys(ids):
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


def _screenshot(env) -> bytes:
    try:
        png = subprocess.run(["import", "-window", "root", "png:-"], env=env,
                             capture_output=True, timeout=30).stdout
    except (OSError, subprocess.TimeoutExpired):
        return b""
    return png if png.startswith(b"\x89PNG") else b""


def _session_bus(env):
    """A D-Bus session bus for AnyDesk's GTK window (desktops always have one)."""
    if env.get("DBUS_SESSION_BUS_ADDRESS") or not shutil.which("dbus-daemon"):
        return None
    try:
        bus = subprocess.Popen(["dbus-daemon", "--session", "--nofork", "--print-address=1"],
                               stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=env,
                               start_new_session=True, text=True)
        address = bus.stdout.readline().strip()
    except OSError:
        return None
    if address:
        env["DBUS_SESSION_BUS_ADDRESS"] = address
    return bus


def _frontend(env, log_path, wait: int = 30):
    """AnyDesk's main window, which ``anydesk <ID>`` passes the request to."""
    try:
        out = open(log_path, "wb")
        proc = subprocess.Popen(["anydesk"], stdin=subprocess.DEVNULL, stdout=out,
                                stderr=subprocess.STDOUT, env=env, start_new_session=True)
    except OSError:
        return None
    deadline = time.monotonic() + wait
    while time.monotonic() < deadline and proc.poll() is None and not windows(env):
        time.sleep(2)
    time.sleep(3)                      # let it reach the AnyDesk service
    return proc


def _read_tail(path, size: int) -> str:
    try:
        with open(path, "rb") as f:
            f.seek(0, os.SEEK_END)
            f.seek(max(0, f.tell() - size))
            return f.read().decode(errors="replace")
    except OSError:
        return ""


def _mask(text: str) -> str:
    return re.sub(r"\d{5,}", "…", text)


def diagnosis(trace: str) -> list[str]:
    """Safe for the public log (long numbers masked): who is logged in, and
    why AnyDesk stopped, so a failure can be read without the private report."""
    env = dict(os.environ)
    lines = []
    for row in _run(["loginctl", "list-sessions", "--no-legend"], env).splitlines():
        sid = row.split()[0] if row.split() else ""
        props = _run(["loginctl", "show-session", sid, "-p", "Name", "-p", "Seat", "-p", "VTNr",
                      "-p", "Type", "-p", "Class", "-p", "Active", "-p", "State"], env).split()
        lines.append(f"login session {sid}: {' '.join(props) or row.strip()}")
    if not lines:
        lines.append("login sessions: none")
    active = _run(["loginctl", "show-seat", "seat0", "-p", "ActiveSession", "--value"], env).strip()
    lines.append(f"seat0 active session: {active or 'none'}")
    who = _run(["who"], env).split("\n")
    lines.append(f"logged in (who): {', '.join(w.split()[0] for w in who if w.split()) or 'nobody'}")
    # The client's ("ad") own errors; the service ("gsvc") logs harmless ones.
    reasons = [l.split(" - ", 1)[-1].strip() for l in trace.splitlines()
               if re.match(r"\s*(explode|error)\s+\S+\s+\S+\s+ad\s", l)]
    for reason in list(dict.fromkeys(reasons))[-4:]:
        lines.append(f"AnyDesk: {reason[:200]}")
    return [_mask(l) for l in lines]


def _trace(frontend_log, frontend, bus) -> str:
    """For the private Telegram report: AnyDesk's own logs from this run."""
    rc = frontend.poll() if frontend else "not started"
    parts = [f"main window process: {'running' if rc is None else f'exited with {rc}'}",
             f"session bus: {'started by job' if bus else "the session's own" if os.environ.get('DBUS_SESSION_BUS_ADDRESS') else 'none'}",
             "--- login sessions (loginctl) ---",
             _run(["loginctl", "list-sessions", "--no-legend"], dict(os.environ)).strip() or "(none)",
             "--- main window console ---", _read_tail(frontend_log, 3000).strip() or "(none)"]
    for path in TRACES:
        parts += [f"--- {path} ---", _read_tail(path, 12000).strip() or "(missing or unreadable)"]
    return "\n".join(parts)


def _connect(anydesk_id: str, password: str, env, wait: int, log_path=None):
    """Start a session; returns (client process, session window) or (proc, None)."""
    before = {w[0] for w in windows(env)}  # the main window is not a session
    out = open(log_path, "wb") if log_path else subprocess.DEVNULL
    client = subprocess.Popen(["anydesk", anydesk_id, "--with-password"],
                              stdin=subprocess.PIPE, stdout=out,
                              stderr=subprocess.STDOUT, env=env, start_new_session=True)
    client.stdin.write((password + "\n").encode())
    client.stdin.close()
    # The session window is the large one; AnyDesk's own small windows
    # (main window, "not available" and other messages) don't count.
    deadline = time.monotonic() + wait
    while time.monotonic() < deadline:
        time.sleep(2)
        big = [w for w in windows(env) if w[2] >= 600 and w[3] >= 400 and w[0] not in before]
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
    client, frontend, bus, attempts = None, None, None, []
    log_dir = LAST_ID.parent
    try:
        log_dir.mkdir(parents=True, exist_ok=True)
    except OSError:
        pass
    frontend_log = log_dir / "anydesk-frontend.txt"
    try:
        time.sleep(2)
        bus = _session_bus(env)
        frontend = _frontend(env, frontend_log)
        for anydesk_id in ordered(ids):
            log_path = log_dir / "anydesk-output.txt"
            client, session = _connect(anydesk_id, password, env, connect_wait, log_path)
            if session:
                break
            # What the virtual screen shows instead (a message, a prompt...),
            # for the private Telegram report.
            try:
                output = log_path.read_text(errors="replace")[-1500:]
            except OSError:
                output = ""
            attempts.append({"position": ids.index(anydesk_id) + 1, "id": anydesk_id,
                             "png": _screenshot(env), "windows": windows(env), "output": output,
                             "exit": client.poll()})
            _stop(client)
            client = None
        else:
            raise CaptureError(f"None of the {len(ids)} AnyDesk IDs opened a session (PC off, "
                               "offline, or the password changed).", attempts,
                               _trace(frontend_log, frontend, bus))
        remember(anydesk_id)
        _run(["xdotool", "windowmove", session[0], "0", "0"], env)
        _run(["xdotool", "windowsize", session[0], "100%", "100%"], env)
        time.sleep(settle)             # let the remote screen finish drawing
        png = _screenshot(env)
        if not png:
            raise CaptureError("The screenshot of the virtual display failed.")
        return png, windows(env), ids.index(anydesk_id) + 1
    finally:
        _stop(client)
        _stop(frontend)
        _stop(bus)
        _stop(xvfb)
