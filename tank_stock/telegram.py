"""Private delivery of the screenshot and results (this repo's job logs are
public, so pictures of the automation screen go to Telegram, never the log)."""
from __future__ import annotations

import json
import os
import urllib.request
import uuid


def _post(method: str, fields: dict, files: dict | None = None, timeout: int = 60) -> bool:
    token, chat = os.environ.get("TELEGRAM_TOKEN"), os.environ.get("TELEGRAM_CHAT")
    if not token or not chat:
        print("Telegram is not configured (TELEGRAM_TOKEN / TELEGRAM_CHAT); nothing sent.")
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
    req = urllib.request.Request(f"https://api.telegram.org/bot{token}/{method}", data=bytes(body),
                                 headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return bool(json.loads(resp.read() or b"{}").get("ok"))
    except Exception as exc:  # noqa: BLE001 - delivery is best-effort
        print(f"Telegram {method} failed: {type(exc).__name__}")
        return False


def send_text(text: str) -> bool:
    return _post("sendMessage", {"text": text[:4000]})


def send_photo(png: bytes, caption: str) -> bool:
    """As a document, so the screen stays sharp enough to read its figures."""
    return _post("sendDocument", {"caption": caption[:1000]},
                 {"document": ("tank-stock.png", png, "image/png")})
