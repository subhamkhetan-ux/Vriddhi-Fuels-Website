"""Telegram failure alerts — same pattern as the IOCL monitor (spec §2, §7).

Never fail silently: on any run error the orchestrator sends a short Telegram
message and uploads logs as a run artifact. Sending is best-effort — a Telegram
outage must not mask the original error — so failures here are swallowed.
"""

from __future__ import annotations

import os
import urllib.parse
import urllib.request

from .config import TELEGRAM_CHAT_ENV, TELEGRAM_TOKEN_ENV


def notify(text: str) -> bool:
    token = os.environ.get(TELEGRAM_TOKEN_ENV)
    chat = os.environ.get(TELEGRAM_CHAT_ENV)
    if not token or not chat:
        return False
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    data = urllib.parse.urlencode({
        "chat_id": chat,
        "text": text[:4000],
        "disable_web_page_preview": "true",
    }).encode()
    try:
        with urllib.request.urlopen(url, data=data, timeout=20) as resp:
            return resp.status == 200
    except Exception:
        return False
