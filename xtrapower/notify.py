"""Telegram push notifications.

Same best-effort pattern as ``agent/telegram.py``: sending is never allowed to
crash the monitor, so a Telegram outage degrades to a logged warning rather
than killing the poll loop. Token and chat id come from config (or the
``XTRA_TELEGRAM_TOKEN`` / ``XTRA_TELEGRAM_CHAT`` env vars as a fallback).
"""

from __future__ import annotations

import logging
import os
import urllib.parse
import urllib.request

log = logging.getLogger("xtrapower.notify")


class Telegram:
    def __init__(self, token: str | None, chat_id: str | None):
        self.token = token or os.environ.get("XTRA_TELEGRAM_TOKEN")
        self.chat_id = chat_id or os.environ.get("XTRA_TELEGRAM_CHAT")

    @property
    def configured(self) -> bool:
        return bool(self.token and self.chat_id)

    def send(self, text: str) -> bool:
        if not self.configured:
            log.warning("Telegram not configured; message dropped: %s", text)
            return False
        url = f"https://api.telegram.org/bot{self.token}/sendMessage"
        data = urllib.parse.urlencode({
            "chat_id": self.chat_id,
            "text": text[:4000],
            "parse_mode": "HTML",
            "disable_web_page_preview": "true",
        }).encode()
        try:
            with urllib.request.urlopen(url, data=data, timeout=20) as resp:
                ok = resp.status == 200
                if not ok:
                    log.warning("Telegram sendMessage returned %s", resp.status)
                return ok
        except Exception as exc:  # noqa: BLE001 — best-effort, must not raise
            log.warning("Telegram send failed: %s", exc)
            return False
