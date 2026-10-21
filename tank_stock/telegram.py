"""Private delivery of the screenshot and results (this repo's job logs are
public, so pictures of the automation screen go to Telegram, never the log).

Messages go to the XtraPower monitor's bot and chat: its token and chat id
are copied for the runner by infra/anydesk/use-xtrapower-bot.sh into
``TANK_TELEGRAM_FILE`` (default /opt/agents/tank-telegram.json).
``TANK_TELEGRAM_TOKEN`` / ``TANK_TELEGRAM_CHAT`` override it when both are set.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import urllib.error
import urllib.request
import uuid

BOT_FILE = Path(os.environ.get("TANK_TELEGRAM_FILE", "/opt/agents/tank-telegram.json"))
_reported = False


def _config() -> tuple[str, str, str]:
    """(token, chat, where they came from)"""
    if os.environ.get("TANK_TELEGRAM_TOKEN") and os.environ.get("TANK_TELEGRAM_CHAT"):
        return os.environ["TANK_TELEGRAM_TOKEN"], os.environ["TANK_TELEGRAM_CHAT"], "TANK_TELEGRAM_*"
    try:
        bot = json.loads(BOT_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return "", "", ""
    return str(bot.get("token") or ""), str(bot.get("chat_id") or ""), "XtraPower bot"


def _mask(name: str) -> str:
    return name if len(name) <= 4 else f"{name[:2]}…{name[-2:]}"


def _call(token: str, method: str, body: bytes, ctype: str, timeout: int) -> dict:
    req = urllib.request.Request(f"https://api.telegram.org/bot{token}/{method}", data=body,
                                 headers={"Content-Type": ctype})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as exc:   # Telegram explains 4xx in the body
        try:
            return json.loads(exc.read() or b"{}")
        except ValueError:
            return {"ok": False, "description": f"HTTP {exc.code}"}


def _report(token: str, chat: dict, which: str) -> None:
    """Once per run, where messages went, masked for the public log, so a
    message that "never arrived" can be traced to the bot and chat."""
    global _reported
    if _reported:
        return
    _reported = True
    try:
        me = _call(token, "getMe", b"", "application/x-www-form-urlencoded", 8).get("result") or {}
    except Exception:  # noqa: BLE001
        me = {}
    who = chat.get("title") or chat.get("first_name") or ""
    print(f"Telegram ({which}): delivered by bot @{_mask(me.get('username', '?'))} "
          f"to a {chat.get('type', '?')} chat '{_mask(who)}'.")


def _post(method: str, fields: dict, files: dict | None = None, timeout: int = 0) -> bool:
    # (never long: a message is sent from the live reads and the decantation itself)
    timeout = timeout or (30 if files else 12)
    token, chat, which = _config()
    if not token or not chat:
        print("Telegram is not configured; nothing sent. On the server run "
              "bash infra/anydesk/use-xtrapower-bot.sh to use the XtraPower bot.")
        return False
    boundary = uuid.uuid4().hex
    body = bytearray()
    for name, value in {"chat_id": chat, **fields}.items():
        body += (f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n"
                 f"{value}\r\n").encode()
    for name, (filename, data, ctype) in (files or {}).items():
        body += (f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"; "
                 f"filename=\"{filename}\"\r\nContent-Type: {ctype}\r\n\r\n").encode()
        body += data + b"\r\n"
    body += f"--{boundary}--\r\n".encode()
    try:
        result = _call(token, method, bytes(body), f"multipart/form-data; boundary={boundary}", timeout)
    except Exception as exc:  # noqa: BLE001 - delivery is best-effort
        print(f"Telegram {method} failed: {type(exc).__name__}")
        return False
    if not result.get("ok"):
        # e.g. "Bad Request: chat not found", "Forbidden: bot was blocked by the user"
        print(f"Telegram {method} refused ({which}): {str(result.get('description', 'no reason'))[:120]}")
        return False
    _report(token, (result.get("result") or {}).get("chat") or {}, which)
    return True


def send_text(text: str) -> bool:
    return _post("sendMessage", {"text": text[:4000]})


def send_file(data: bytes, filename: str, ctype: str, caption: str) -> bool:
    return _post("sendDocument", {"caption": caption[:1000]}, {"document": (filename, data, ctype)})


def send_photo(png: bytes, caption: str) -> bool:
    """As a document, so the screen stays sharp enough to read its figures."""
    return send_file(png, "tank-stock.png", "image/png", caption)
