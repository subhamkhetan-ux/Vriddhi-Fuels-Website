"""Ask the monitor how it's doing, from Telegram on your phone.

Send your bot:
  /status     is the monitor running, when it last checked, and each account
  /logs       the monitor's last 15 log lines   (/logs 40 for more, max 50)
  /help       this list

The monitor itself answers, so a reply is proof it is alive. No reply within
a minute or so means the monitor (or the Mac) is down — or asleep.

How it works: a background thread long-polls Telegram's getUpdates for new
messages to the bot. That's an outbound request, like sending an alert, so
nothing on the Mac is exposed to the network. It answers only messages from
the chat_id in config.json and ignores everything else, and it skips commands
sent while the monitor was off instead of answering them late.

Only one program can read a bot's messages at a time. If another tool also
reads this bot, Telegram answers 409 Conflict; the monitor logs that once and
keeps retrying, and monitoring itself carries on unaffected.
"""

from __future__ import annotations

import html
import json
import logging
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import deque
from datetime import datetime
from typing import Any, Callable, Optional

log = logging.getLogger("xtrapower.telegram")

API_BASE = "https://api.telegram.org"
LONG_POLL_SECONDS = 50        # Telegram holds the request open until a message arrives
DEFAULT_LOG_LINES = 15
MAX_LOG_LINES = 50
MAX_MESSAGE_CHARS = 3800      # Telegram's limit is 4096; leave room for markup
STALE_GRACE_SECONDS = 60      # commands sent just before start-up still count
_PLACEHOLDER = "PUT-YOUR"

# Read at call time so tests can swap in a proxy-free opener.
_urlopen = urllib.request.urlopen

ERROR_LABELS = {
    "chrome-unreachable": "Chrome window not open",
    "no-page": "No tab open in its Chrome window",
    "read-failed": "Couldn't read the page",
    "waf-block": "Blocked by the portal firewall",
    "logged-out": "Logged out",
    "auto-login-failed": "Auto-login failed",
    "login-captcha": "Login needs you (reCAPTCHA)",
    "nav-failed": "Couldn't reach Balance Info",
    "no-search-button": "Search button not found",
    "no-ccms": "Couldn't read the CCMS value",
}

HELP_TEXT = (
    "<b>XtraPower monitor</b>\n"
    "/status — is it running, last check, each account\n"
    "/logs — last 15 log lines (/logs 40 for more)\n"
    "/help — this list\n\n"
    "No reply within a minute means the monitor or the Mac is down."
)


# ---- recent log lines -----------------------------------------------------------

class LogBuffer(logging.Handler):
    """Keeps the monitor's recent log lines in memory for /logs."""

    def __init__(self, capacity: int = 300):
        super().__init__(level=logging.INFO)
        self.lines: deque = deque(maxlen=capacity)
        self.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s",
                                            "%d %b %H:%M:%S"))

    def emit(self, record: logging.LogRecord) -> None:
        try:
            self.lines.append(self.format(record))
        except Exception:  # noqa: BLE001 — logging must never raise
            self.handleError(record)

    def tail(self, n: int) -> list:
        if n <= 0:
            return []
        self.acquire()              # emit() runs under the same lock, on any thread
        try:
            return list(self.lines)[-n:]
        finally:
            self.release()


# ---- pure helpers (unit-tested) -----------------------------------------------

_KNOWN = {"status": "status", "logs": "logs", "log": "logs", "help": "help", "start": "help"}


def parse_command(text: str) -> Optional[tuple]:
    """``'/status'``, ``'/status@MyBot'``, ``'/logs 30'``, ``'status'`` -> ``(cmd, arg)``.

    Unknown ``/commands`` get the help text; ordinary chat that isn't a known
    word is ignored, so the bot stays quiet in a group.
    """
    t = (text or "").strip()
    if not t:
        return None
    head, _, rest = t.partition(" ")
    word = head.lstrip("/").split("@", 1)[0].lower()
    if word in _KNOWN:
        return _KNOWN[word], rest.strip()
    if head.startswith("/"):
        return "help", ""
    return None


def select_commands(updates: list, chat_id: Any, not_before: float,
                    offset: Optional[int]) -> tuple:
    """Pick the commands to answer from one getUpdates batch.

    Returns ``(commands, next_offset)``. Messages from any other chat, and ones
    sent before ``not_before`` (while the monitor was off), are skipped. The
    returned offset acknowledges everything seen, so nothing is fetched twice.
    """
    commands = []
    want = str(chat_id or "").strip()
    for update in updates:
        uid = update.get("update_id")
        if isinstance(uid, int):
            offset = max(offset or 0, uid + 1)
        msg = update.get("message") or update.get("edited_message") or {}
        chat = str((msg.get("chat") or {}).get("id", ""))
        if not chat:
            continue
        if chat != want:
            log.info("telegram: ignored a message from another chat (%s)", chat)
            continue
        if msg.get("date", 0) < not_before:
            continue
        cmd = parse_command(msg.get("text", ""))
        if cmd:
            commands.append(cmd)
    return commands, offset


def ago(seconds: float) -> str:
    s = max(0, int(seconds))
    if s < 60:
        return "just now"
    if s < 3600:
        return f"{s // 60} min ago"
    if s < 86400:
        h, m = divmod(s // 60, 60)
        return f"{h} h {m} min ago" if m else f"{h} h ago"
    d = s // 86400
    return f"{d} day{'s' if d != 1 else ''} ago"


def duration(seconds: float) -> str:
    s = max(0, int(seconds))
    if s < 60:
        return "under a minute"
    if s < 3600:
        return f"{s // 60} min"
    if s < 86400:
        h, m = divmod(s // 60, 60)
        return f"{h} h {m} min" if m else f"{h} h"
    d, h = divmod(s // 3600, 24)
    return f"{d} day{'s' if d != 1 else ''} {h} h" if h else f"{d} day{'s' if d != 1 else ''}"


def _age_of(iso: Optional[str], now: float) -> Optional[float]:
    if not iso:
        return None
    try:
        return now - datetime.fromisoformat(iso).timestamp()
    except (TypeError, ValueError):
        return None


def format_status(snap: dict, now: float) -> str:
    """The /status reply. ``snap`` is the monitor's live snapshot:

    ``started``, ``last_end`` (epoch seconds of the last finished check, or
    None), ``poll`` (seconds), ``accounts`` ([{label, key, watch}]), ``ready``
    ({key: bool}) and ``state`` (the contents of state.json).
    """
    e = html.escape
    poll = int(snap.get("poll") or 120)
    last_end = snap.get("last_end")
    out = []
    if last_end is None:
        out.append("🟡 <b>XtraPower monitor is running</b> — the first check is still going.")
    elif now - last_end > max(3 * poll, 600):
        out.append(f"🟠 <b>XtraPower monitor is running, but its last check finished "
                   f"{ago(now - last_end)}</b> — it may be stuck. On the Mac run "
                   "<code>./xtrapower/monitor-mac.sh stop</code> then <code>start</code>.")
    else:
        out.append("🟢 <b>XtraPower monitor is running</b>")
    every = f"{poll // 60} min" if poll % 60 == 0 else f"{poll} s"
    sub = f"Up {duration(now - snap['started'])}"
    if last_end is not None:
        sub += f" · last check {ago(now - last_end)}"
    out.append(f"{sub} · checks every {every}")
    out.append("")

    accounts = snap.get("accounts") or []
    if not accounts:
        out.append("No accounts in config.json yet.")
    saved = (snap.get("state") or {}).get("accounts") or {}
    ready = snap.get("ready") or {}
    for acct in accounts:
        name = e(str(acct.get("label") or acct.get("key")))
        if not acct.get("watch", True):
            out.append(f"⚪ <b>{name}</b> — off")
            continue
        s = saved.get(acct.get("key"), {})
        if ready.get(acct.get("key")):
            out.append(f"✅ <b>{name}</b> — watching")
        else:
            out.append(f"⏳ <b>{name}</b> — not confirmed yet (waiting for login or its first read)")
        if s.get("ccms"):
            age = _age_of(s.get("updated_at"), now)
            out.append(f"     CCMS {e(str(s['ccms']))}" + (f" · read {ago(age)}" if age is not None else ""))
        if s.get("last_error"):
            age = _age_of(s.get("last_error_at"), now)
            label = ERROR_LABELS.get(s["last_error"], s["last_error"])
            out.append(f"     ⚠️ {e(label)}" + (f" · {ago(age)}" if age is not None else ""))
    out.append("")
    out.append("Send /logs for recent activity.")
    return "\n".join(out)


def format_logs(lines: list, requested: int) -> str:
    """The /logs reply: the newest lines that fit in one Telegram message."""
    if not lines:
        return "No log lines yet — the monitor has only just started."
    picked, size = [], 0
    for line in reversed(lines):
        esc = html.escape(line)
        if size + len(esc) + 1 > MAX_MESSAGE_CHARS - 100:
            break
        picked.append(esc)
        size += len(esc) + 1
    picked.reverse()
    head = f"🧾 <b>Last {len(picked)} log line{'s' if len(picked) != 1 else ''}</b>"
    if len(picked) < min(requested, len(lines)):
        head += " (trimmed to fit one message)"
    return head + "\n<pre>" + "\n".join(picked) + "</pre>"


def log_count(arg: str) -> int:
    try:
        n = int(arg)
    except (TypeError, ValueError):
        return DEFAULT_LOG_LINES
    return max(1, min(MAX_LOG_LINES, n))


# ---- talking to Telegram --------------------------------------------------------

def get_updates(token: str, offset: Optional[int], timeout: int,
                api_base: Optional[str] = None) -> list:
    """One long-poll for new messages to the bot."""
    params = {"timeout": timeout,
              "allowed_updates": json.dumps(["message", "edited_message"])}
    if offset is not None:
        params["offset"] = offset
    url = f"{api_base or API_BASE}/bot{token}/getUpdates"
    req = urllib.request.Request(url, data=urllib.parse.urlencode(params).encode())
    with _urlopen(req, timeout=timeout + 15) as resp:
        payload = json.loads(resp.read().decode("utf-8"))
    if not payload.get("ok"):
        raise RuntimeError("Telegram getUpdates returned ok=false")
    return payload.get("result") or []


class CommandListener:
    """Answers /status, /logs and /help. Run ``run_forever`` in a daemon thread.

    ``get_tg`` returns the monitor's current Telegram client (it can change
    when config.json is edited); ``snapshot`` returns the live status data
    described in :func:`format_status`.
    """

    def __init__(self, get_tg: Callable[[], Any], snapshot: Callable[[], dict],
                 logs: LogBuffer, started_at: float, api_base: Optional[str] = None,
                 long_poll: int = LONG_POLL_SECONDS):
        self.get_tg = get_tg
        self.snapshot = snapshot
        self.logs = logs
        self.started_at = started_at
        self.api_base = api_base
        self.long_poll = long_poll
        self._offset: Optional[int] = None
        self._token: Optional[str] = None
        self._last_problem: Optional[str] = None

    def respond(self, cmd: str, arg: str, now: Optional[float] = None) -> str:
        now = time.time() if now is None else now
        if cmd == "status":
            return format_status(self.snapshot(), now)
        if cmd == "logs":
            n = log_count(arg)
            return format_logs(self.logs.tail(n), n)
        return HELP_TEXT

    def poll_once(self) -> Optional[int]:
        """One getUpdates round. Returns commands answered, or None if Telegram
        isn't configured. Transport errors are raised to ``run_forever``."""
        tg = self.get_tg()
        token = getattr(tg, "token", None)
        chat = getattr(tg, "chat_id", None)
        if not token or not chat or _PLACEHOLDER in str(token):
            return None
        if token != self._token:            # a different bot: start from scratch
            self._token, self._offset = token, None
        updates = get_updates(token, self._offset, self.long_poll, self.api_base)
        commands, self._offset = select_commands(
            updates, chat, self.started_at - STALE_GRACE_SECONDS, self._offset)
        for cmd, arg in commands:
            try:
                text = self.respond(cmd, arg)
            except Exception as exc:  # noqa: BLE001 — a bad reply must not stop the thread
                log.exception("telegram: couldn't build the /%s reply", cmd)
                text = f"⚠️ Couldn't build that reply ({html.escape(type(exc).__name__)})."
            tg.send(text)
            log.info("telegram: answered /%s", cmd)
        return len(commands)

    def _report(self, problem: str) -> None:
        if problem != self._last_problem:      # say it once, not every retry
            log.warning("telegram commands: %s", problem)
            self._last_problem = problem

    def run_forever(self) -> None:
        while True:
            try:
                answered = self.poll_once()
                if answered is None:
                    time.sleep(60)                 # Telegram not set up yet
                    continue
                if self._last_problem:
                    log.info("telegram commands: working again")
                self._last_problem = None
            except urllib.error.HTTPError as exc:
                if exc.code == 409:
                    self._report("another program is reading this bot's messages (Telegram "
                                 "409 Conflict), so /status can't be answered. Monitoring is "
                                 "unaffected. Stop the other program, or give the monitor its own bot.")
                elif exc.code in (401, 404):
                    self._report(f"Telegram rejected the bot token (HTTP {exc.code}). "
                                 "Check it in the account manager.")
                else:
                    self._report(f"Telegram getUpdates failed (HTTP {exc.code}); retrying.")
                time.sleep(60 if exc.code in (401, 404, 409) else 15)
            except Exception as exc:  # noqa: BLE001 — network blips, sleep, DNS…
                self._report(f"couldn't reach Telegram ({type(exc).__name__}); retrying.")
                time.sleep(15)
