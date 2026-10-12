"""A tiny Supabase client for the bridge (standard library only).

Signs in with an email + password (a ledger member's login) and calls the
jarvis_* SQL functions over the REST API with the project's PUBLIC key, the
same way the Jarvis page does. No secret / service_role key is ever needed.
"""

from __future__ import annotations

import json
import re
import time
import urllib.error
import urllib.request
from typing import Any, Optional


class SupaError(Exception):
    pass


def read_js_config(path: str) -> dict:
    """SUPABASE_URL / SUPABASE_ANON_KEY out of an app's config.js
    (e.g. ledger/config.js), so the bridge never needs them typed twice."""
    try:
        text = open(path, encoding="utf-8").read()
    except OSError:
        return {}
    out = {}
    for key in ("SUPABASE_URL", "SUPABASE_ANON_KEY"):
        m = re.search(key + r'\s*:\s*["\']([^"\']+)["\']', text)
        if m and "PASTE_" not in m.group(1):
            out[key] = m.group(1)
    return out


class Supabase:
    def __init__(self, url: str, anon_key: str, email: str, password: str, timeout: float = 20.0):
        if not url or not anon_key:
            raise SupaError("The Supabase URL / public key are missing (ledger/config.js).")
        if not email or not password:
            raise SupaError("Set the bridge's login (email + password of a ledger member) in jarvis/bridge/config.json.")
        self.url = url.rstrip("/")
        self.key = anon_key
        self.email = email
        self.password = password
        self.timeout = timeout
        self.token: Optional[str] = None
        self.refresh: Optional[str] = None
        self.expires_at = 0.0

    # ---- HTTP -------------------------------------------------------------
    def _post(self, path: str, body: Any, bearer: Optional[str] = None) -> Any:
        req = urllib.request.Request(
            self.url + path, data=json.dumps(body).encode("utf-8"), method="POST",
            headers={"apikey": self.key, "Content-Type": "application/json",
                     "Authorization": f"Bearer {bearer or self.key}"})
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                raw = resp.read().decode("utf-8")
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace")
            try:
                j = json.loads(detail)
                detail = j.get("message") or j.get("msg") or j.get("error_description") or j.get("error") or detail
            except ValueError:
                pass
            raise SupaError(f"{exc.code}: {detail}") from None
        except (urllib.error.URLError, OSError) as exc:
            raise SupaError(f"can't reach Supabase: {exc}") from None
        return json.loads(raw) if raw.strip() else None

    # ---- auth -------------------------------------------------------------
    def _take(self, tok: dict) -> None:
        self.token = tok["access_token"]
        self.refresh = tok.get("refresh_token")
        self.expires_at = time.time() + float(tok.get("expires_in", 3600)) - 120

    def sign_in(self) -> None:
        try:
            tok = self._post("/auth/v1/token?grant_type=password", {"email": self.email, "password": self.password})
        except SupaError as exc:
            raise SupaError(f"sign-in failed for {self.email} — {exc}") from None
        self._take(tok)

    def ensure(self) -> str:
        if self.token and time.time() < self.expires_at:
            return self.token
        if self.refresh:
            try:
                self._take(self._post("/auth/v1/token?grant_type=refresh_token", {"refresh_token": self.refresh}))
                return self.token
            except SupaError:
                pass
        self.sign_in()
        return self.token

    def rpc(self, fn: str, args: Optional[dict] = None) -> Any:
        try:
            return self._post(f"/rest/v1/rpc/{fn}", args or {}, bearer=self.ensure())
        except SupaError as exc:
            if str(exc).startswith("401"):              # token revoked: sign in again once
                self.token = None
                self.refresh = None
                return self._post(f"/rest/v1/rpc/{fn}", args or {}, bearer=self.ensure())
            raise
