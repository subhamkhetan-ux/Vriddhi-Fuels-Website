"""Save tank readings to the decant app, as its own "From a screenshot" does.

The decant app (decant/) keeps each tank's latest stock as one row of its
Supabase table ``dec_tank_state``: ``{tank_id: 'T1', reading: {...},
updated_at}``, written with the app's public (publishable) key. This module
builds the same ``reading`` (core.js ``readingFrom``), runs the same two
checks the app's photo reader does (automation.js ``settleReading``):

- sum:   volume + ullage = capacity, to a litre;
- chart: the dip chart's litres at the product height = the volume, to
         max(15 L, 0.2 %);

and, like the app (store.js ``newer``), never replaces a newer reading.
Tanks, the date order and the dip chart come from the app's settings
(``dec_config``), else its defaults.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
import http.client
import json
from pathlib import Path
import re
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_TANKS = [
    {"id": "T1", "no": 1, "product": "MS", "capacity": 20000},
    {"id": "T2", "no": 2, "product": "HSD", "capacity": 20000},
    {"id": "T3", "no": 3, "product": "HSD", "capacity": 20000},
    {"id": "T4", "no": 4, "product": "XG", "capacity": 20000},
]
DENSITY = (400, 1200)
TEMP = (5, 55)


class DecantError(Exception):
    """Safe to show: no key or URL in it."""


def cloud() -> tuple[str, str]:
    """(project URL, publishable key) from decant/config.js."""
    text = (ROOT / "decant" / "config.js").read_text(encoding="utf-8")
    url = re.search(r'SUPABASE_URL:\s*"([^"]+)"', text)
    key = re.search(r'SUPABASE_ANON_KEY:\s*"([^"]+)"', text)
    if not url or not key or "PASTE_" in url.group(1) + key.group(1):
        raise DecantError("decant/config.js has no Supabase project set.")
    return url.group(1).rstrip("/"), key.group(1)


def _rest(method: str, path: str, body=None, prefer: str = "", timeout: int = 30):
    """The app's tables (PostgREST)."""
    headers = {"Content-Type": "application/json"}
    if prefer:
        headers["Prefer"] = prefer
    data = json.dumps(body).encode() if body is not None else None
    return _http(method, f"rest/v1/{path}", data, headers, timeout)


GET_TRIES = (1, 3)          # seconds before trying a read again after a network blip


def why_unreachable(exc: BaseException, url: str = "") -> str:
    """What went wrong, in words, with what to check (never the URL or key)."""
    reason = getattr(exc, "reason", None) or exc
    text = str(reason).replace(url, "the cloud") if url else str(reason)
    low = text.lower()
    if "certificate" in low and ("not yet valid" in low or "expired" in low):
        hint = ("the server's clock is probably wrong (a VM's clock can drift while the Mac sleeps): "
                "run `sudo timedatectl set-ntp true` on it")
    elif "certificate" in low:
        hint = "its secure connection couldn't be checked (CA certificates: `sudo apt install --reinstall ca-certificates`)"
    elif "name resolution" in low or "name or service not known" in low or "nodename nor servname" in low \
            or "getaddrinfo" in low or "errno -2" in low or "errno -3" in low:
        hint = "the server can't look its name up: no internet or DNS on it right now"
    elif "timed out" in low or isinstance(reason, TimeoutError):
        hint = "no answer in time: the server's internet is down or very slow"
    elif "refused" in low or "unreachable" in low or "no route" in low:
        hint = "the server has no working internet connection right now"
    else:
        hint = ""
    detail = text[:120]
    return f"{type(exc).__name__}: {detail}" + (f" - {hint}" if hint else "")


def _http(method: str, path: str, data, headers: dict, timeout: int = 30):
    url, key = cloud()
    headers = {"apikey": key, "Authorization": f"Bearer {key}", **headers}
    req = urllib.request.Request(f"{url}/{path}", data=data, method=method, headers=headers)
    # a read is tried again after a short blip; a write never (a conditional one
    # that went through but whose answer was lost would look refused the second time)
    # (a quick one - live monitoring's - gives up at once: it is sent again later anyway)
    waits = GET_TRIES if method == "GET" and timeout >= 20 else ()
    for attempt in range(len(waits) + 1):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read()
            break
        except urllib.error.HTTPError as exc:
            # what it said (PostgREST's message: never the key), so a refusal for good is told apart
            said = ""
            try:
                body = json.loads(exc.read()[:2000] or b"{}")
                said = str(body.get("message") or body.get("error") or "")[:160] if isinstance(body, dict) else ""
            except Exception:  # noqa: BLE001 - only a nicer message
                said = ""
            raise DecantError(f"The decant database refused ({exc.code}{': ' + said if said else ''}).") from None
        except (urllib.error.URLError, OSError, http.client.HTTPException) as exc:
            # (HTTPException: a reply cut short - IncompleteRead, BadStatusLine - is "not reached" too)
            if attempt < len(waits):
                time.sleep(waits[attempt])
                continue
            raise DecantError(f"The decant database could not be reached ({why_unreachable(exc, url)}).") from None
    try:
        return json.loads(raw) if raw else None
    except ValueError:
        # (a page from something in between - a captive portal, a proxy - is not "no rows")
        raise DecantError("The decant database could not be reached (its answer wasn't the database's).") from None


# ---- the stock proof for the app's result pictures -------------------------
# The app keeps the day's stock screenshots in its private storage bucket
# `dec-shots` with a `dec_shots` row naming the readings each gave (decant/js/
# shots.js); a result picture made on any phone that day shows the ones
# behind its before / after stock. The agent adds its zoomed tank cards the
# same way, and deletes earlier days' (as the phones do) once a day.
BUCKET = "dec-shots"


def ist_day(now=None) -> str:
    return (now or datetime.now(timezone.utc)).astimezone(timezone(timedelta(hours=5, minutes=30))).date().isoformat()


def save_proof(jpeg: bytes, marks: dict, now=None) -> str:
    """Store the picture behind these readings ({tank_id: {readingAt, volume}}).
    Returns the file's path."""
    now = now or datetime.now(timezone.utc)
    day = ist_day(now)
    shot_id = f"{int(now.timestamp() * 1000)}-agent"
    path = f"{day}/{shot_id}.jpg"
    _http("POST", f"storage/v1/object/{BUCKET}/{path}", jpeg,
          {"Content-Type": "image/jpeg", "x-upsert": "true"}, timeout=60)
    try:
        _rest("POST", "dec_shots?on_conflict=id",
              [{"id": shot_id, "day": day, "at": now.isoformat(), "readings": marks, "path": path, "source": "agent"}],
              prefer="resolution=merge-duplicates,return=minimal")
    except DecantError:
        try:                                # (a file without its row would never be cleared)
            _http("DELETE", f"storage/v1/object/{BUCKET}", json.dumps({"prefixes": [path]}).encode(),
                  {"Content-Type": "application/json"})
        except DecantError:
            pass
        raise
    return path


def drop_old_proofs(now=None) -> int:
    """Delete the screenshots from before yesterday (rows and files): a
    decantation that ran past midnight still finds its stock before's, as
    the app does (decant/js/shots.js). Returns how many."""
    keep_from = ist_day((now or datetime.now(timezone.utc)) - timedelta(days=1))
    total = 0
    for _ in range(20):                    # 500 at a time; a row goes only once its file has
        rows = _rest("GET", f"dec_shots?day=lt.{keep_from}&select=id,path&limit=500") or []
        if not rows:
            break
        _http("DELETE", f"storage/v1/object/{BUCKET}", json.dumps({"prefixes": [r["path"] for r in rows]}).encode(),
              {"Content-Type": "application/json"})
        ids = ",".join(urllib.parse.quote(str(r["id"])) for r in rows)
        _rest("DELETE", f"dec_shots?id=in.({ids})")
        total += len(rows)
        if len(rows) < 500:
            break
    return total


def dip_chart() -> dict:
    """The app's built-in dip chart (decant/js/dipchart.js)."""
    text = (ROOT / "decant" / "js" / "dipchart.js").read_text(encoding="utf-8")
    start = float(re.search(r"startCm:\s*([\d.]+)", text).group(1))
    step = float(re.search(r"stepCm:\s*([\d.]+)", text).group(1))
    body = text[text.index("litres:"):]
    body = body[body.index("[") + 1:body.index("]")]
    body = re.sub(r"//[^\n]*", "", body)
    return {"startCm": start, "stepCm": step, "litres": [float(v) for v in re.findall(r"[\d.]+", body)]}


def settings(timeout: int = 30) -> dict:
    """{tanks, dateOrder, chart, app} from the app's saved settings, else
    defaults (app: what a decantation needs, decantation.settings_with)."""
    from .decantation import settings_with
    rows = _rest("GET", "dec_config?id=eq.1&select=data", timeout=timeout) or []
    data = (rows[0].get("data") if rows else None) or {}
    s = data.get("settings") or {}
    chart = data.get("chart") if (data.get("chart") or {}).get("litres") else dip_chart()
    tanks = s.get("tanks") if isinstance(s.get("tanks"), list) and s.get("tanks") else DEFAULT_TANKS
    return {"tanks": tanks, "dateOrder": s.get("dateOrder") or "MDY", "chart": chart,
            "app": settings_with(s, tanks)}


# ---- decantations (dec_invoices, dec_sessions) ------------------------------

def _month_start_last(now=None) -> str:
    """The start of last month, IST (the app keeps invoices from then)."""
    ist = (now or datetime.now(timezone.utc)).astimezone(timezone(timedelta(hours=5, minutes=30)))
    y, m = (ist.year, ist.month - 1) if ist.month > 1 else (ist.year - 1, 12)
    return f"{y}-{m:02d}-01T00:00:00+05:30"


def invoices_and_sessions(now=None) -> tuple[list, list]:
    """The app's invoice list and the sessions that decide their status."""
    since = urllib.parse.quote(_month_start_last(now))
    invoices = _rest("GET", f"dec_invoices?created_at=gte.{since}&order=created_at.desc&limit=1000&select=*") or []
    sessions = _rest("GET", "dec_sessions?select=id,invoice_no,tt_no,status,data,created_at,updated_at,completed_at"
                            f"&or=(status.in.(draft,decanting,settling),created_at.gte.{since})&limit=1000") or []
    return invoices, sessions


def handover_requests(timeout: int = 10) -> list:
    """Open decantations a phone asked the agent to finish ("Let the tank stock
    server finish it" in the decant app): [{id, updated_at, request}]."""
    rows = _rest("GET", "dec_sessions?status=in.(draft,decanting,settling)&data->autoRequest=not.is.null"
                        "&select=id,updated_at,request:data->autoRequest&limit=20", timeout=timeout) or []
    return [r for r in rows if isinstance(r.get("request"), dict)]


def get_session(session_id: str, timeout: int = 30) -> dict | None:
    rows = _rest("GET", f"dec_sessions?id=eq.{urllib.parse.quote(session_id)}&select=*", timeout=timeout) or []
    return rows[0] if rows else None


def save_session(s: dict, now=None, base: str | None = None, timeout: int = 30) -> dict | None:
    """saveSession: the whole row, updated_at now. With ``base`` (the
    updated_at the cloud had when it was last looked at) only over that very
    version: None if someone saved it since (theirs stays)."""
    from .decantation import iso
    stamp = iso(now.timestamp() if now else None)
    created = s.get("created_at") or stamp
    row = {k: s.get(k) for k in ("id", "invoice_no", "tt_no", "status", "data")}
    row.update(created_at=created, updated_at=stamp, completed_at=s.get("completed_at"))
    s["_sent_at"] = stamp                  # (if the answer is lost, this version is still known as ours)
    if base:
        got = _rest("PATCH", f"dec_sessions?id=eq.{urllib.parse.quote(str(s['id']))}"
                             f"&updated_at=eq.{urllib.parse.quote(str(base))}&select=id", row,
                    prefer="return=representation", timeout=timeout)
        if not got:
            return None
    else:
        _rest("POST", "dec_sessions?on_conflict=id", [row], prefer="resolution=merge-duplicates,return=minimal",
              timeout=timeout)
    s["updated_at"], s["created_at"] = stamp, created
    return s


def save_tank_reading(tank_id: str, reading: dict, now=None) -> bool:
    """saveTankReading: the tank's latest stock, unless the app has a newer one."""
    saved_at = (now or datetime.now(timezone.utc)).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    r = {**reading, "savedAt": saved_at}
    rows = _rest("GET", f"dec_tank_state?tank_id=eq.{urllib.parse.quote(tank_id)}&select=reading") or []
    current = rows[0].get("reading") if rows else None
    if current and _when(current) > _when(r):
        return False
    _rest("POST", "dec_tank_state?on_conflict=tank_id", [{"tank_id": tank_id, "reading": r, "updated_at": saved_at}],
          prefer="resolution=merge-duplicates,return=minimal")
    return True


def tank_states() -> dict:
    """{tank id: the app's latest reading}."""
    return {r["tank_id"]: r.get("reading") for r in _rest("GET", "dec_tank_state?select=tank_id,reading") or []}


def litres_at_dip(chart: dict, cm):
    """core.js litresAtDip."""
    litres, start, step = chart["litres"], chart["startCm"], chart["stepCm"]
    if cm is None or cm < 0 or not litres or cm > start + (len(litres) - 1) * step + 1e-9:
        return None
    if cm <= start:
        return round(litres[0] * cm / start, 2)
    pos = (cm - start) / step
    i = min(int(pos + 1e-9), len(litres) - 2)
    return round(litres[i] + (litres[i + 1] - litres[i]) * (pos - i), 2)


def chart_tol(v: float) -> float:
    return max(15, abs(v) * 0.002)


def reading_time(parts, date_order: str = "MDY"):
    """"10/13/2026 18:01:55" on the screen (IST) -> ISO with +05:30, like istISO."""
    if not parts:
        return None
    a, b, y, hh, mm, ss = (int(p) if p else 0 for p in parts)
    month, day = (b, a) if date_order == "DMY" else (a, b)
    if not (1 <= month <= 12 and 1 <= day <= 31 and hh <= 23 and mm <= 59):
        return None
    return f"{y}-{month:02d}-{day:02d}T{hh:02d}:{mm:02d}:{ss:02d}+05:30"


def check(card: dict, tank: dict, chart: dict) -> dict:
    """The app's two checks and its confidence for one card."""
    cap = card.get("capacity") or tank.get("capacity") or 20000
    vol, ull, height = card.get("volume"), card.get("ullage"), card.get("height")
    sum_ok = vol is not None and ull is not None and abs(vol + ull - cap) <= 1.01
    at = litres_at_dip(chart, height / 10) if height is not None else None
    chart_ok = None if at is None or vol is None else abs(at - vol) <= chart_tol(vol)
    checks = {"sum": {"ok": sum_ok, "capacity": cap},
              "chart": {"ok": chart_ok, "litres": at, "diff": round(vol - at, 2)} if at is not None and vol is not None
              else {"ok": None},
              "corrected": []}
    problems = []
    if vol is None:
        problems.append("no volume read")
    elif not sum_ok:
        problems.append("volume + ullage ≠ capacity")
    if chart_ok is False:
        problems.append("the volume doesn't match the dip chart at that height")
    if card.get("disagree"):
        problems.append("the two reads differ on " + ", ".join(card["disagree"]))
    if card.get("product") and tank.get("product") and card["product"] != tank["product"]:
        problems.append(f"the screen shows {card['product']} but the app has {tank['product']} "
                        f"in Tank {tank.get('no')} (check the app's Settings)")
    # As the app's badge: both checks -> "Checked", the sum alone (no height
    # to check on the chart) -> "Fixed & checked"; anything wrong -> not saved.
    if problems:
        confidence = "low"
    elif chart_ok:
        confidence = "high"
    else:
        confidence = "medium"
    return {"checks": checks, "confidence": confidence, "problems": problems}


FUTURE_S = 1800            # a "Last Updated" time this far ahead of the clock here is a misread
                           # (not less: a VM's clock can lag a little after the Mac sleeps)


def _utc(t: datetime) -> str:
    return t.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def make_reading(card: dict, tank: dict, cfg: dict, now=None) -> dict:
    """core.js readingFrom + the photo reader's extras. A card whose time
    couldn't be read is stamped with when the screen was taken (the card's
    ``seenAt``), not when it is sent; a time read in the future (a misread
    digit) counts as not read - else no later reading could ever replace it."""
    result = check(card, tank, cfg["chart"])
    cap = card.get("capacity") or tank.get("capacity") or 20000
    vol = round(card["volume"], 2) if card.get("volume") is not None else None
    height = card.get("height")
    density = card.get("density") if DENSITY[0] <= (card.get("density") or 0) <= DENSITY[1] else None
    density_tc = card.get("densityTc") if DENSITY[0] <= (card.get("densityTc") or 0) <= DENSITY[1] else None
    temp = card.get("temp") if TEMP[0] <= (card.get("temp") or 0) <= TEMP[1] else None
    at = reading_time(card.get("time"), cfg.get("dateOrder", "MDY"))
    seen = card.get("seenAt") or _utc(now or datetime.now(timezone.utc))
    try:
        if at and datetime.fromisoformat(at).timestamp() > _when({"readingAt": seen}) + FUTURE_S:
            at = None
    except ValueError:
        at = None
    reading = {
        "volume": vol,
        "ullage": round(card["ullage"], 2) if card.get("ullage") is not None else (round(cap - vol, 2) if vol is not None else None),
        "capacity": cap,
        "height": height,
        "dip": round(height / 10, 2) if height is not None else None,
        "water": card.get("water"),
        "density": density,
        "densityTc": density_tc,
        "temp": temp,
        "status": None,
        "readingAt": at or seen,
        "timeRead": bool(at),
        "source": "photo",
        "via": "anydesk",                 # taken by the tank-stock agent, not a phone
        "confidence": result["confidence"],
        "checks": result["checks"],
    }
    return {"reading": reading, "problems": result["problems"], "confidence": result["confidence"]}


def _when(r) -> float:
    for key in ("readingAt", "savedAt"):
        try:
            return datetime.fromisoformat(str((r or {}).get(key)).replace("Z", "+00:00")).timestamp()
        except ValueError:
            continue
    return 0.0


def tank_for(no: int, cfg: dict):
    return next((t for t in cfg["tanks"] if t.get("no") == no), None)


VOLUME_ONLY_DROP = ("height", "dip", "water", "density", "densityTc", "temp")


def volume_only(reading: dict) -> dict:
    """Live monitoring sends the product volume alone: the app works the
    ullage out from it, and the dip from its chart (as for typed litres)."""
    out = {**reading, **{k: None for k in VOLUME_ONLY_DROP}}
    if out.get("volume") is not None:
        out["ullage"] = round((out.get("capacity") or 20000) - out["volume"], 2)
    return out


def upload(cards: dict, tanks, cfg=None, now=None, only_volume: bool = False, timeout: int = 30) -> dict:
    """Save the given tanks' readings. {tank no: {"ok", "message", "tank_id"}}.
    Only a card the app would call "Checked" (high) or "Fixed & checked"
    (medium) is saved; an older reading never replaces a newer one."""
    cfg = cfg or settings()
    saved_at = (now or datetime.now(timezone.utc)).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    out = {}
    for no in sorted(tanks):
        card, tank = cards.get(no), tank_for(no, cfg)
        if not card:
            out[no] = {"ok": False, "message": "not on the screenshot"}
            continue
        if not tank:
            out[no] = {"ok": False, "message": f"the decant app has no Tank {no}"}
            continue
        built = make_reading(card, tank, cfg, now)
        if built["confidence"] == "low":
            out[no] = {"ok": False, "tank_id": tank["id"],
                       "message": "not saved: " + "; ".join(built["problems"] or ["check failed"])}
            continue
        reading = {**(volume_only(built["reading"]) if only_volume else built["reading"]), "savedAt": saved_at}
        rows = _rest("GET", f"dec_tank_state?tank_id=eq.{urllib.parse.quote(tank['id'])}&select=reading",
                     timeout=timeout) or []
        current = rows[0].get("reading") if rows else None
        if current and _when(current) > _when(reading):
            out[no] = {"ok": False, "tank_id": tank["id"], "message": "the app already has a newer reading"}
            continue
        if current and _when(current) == _when(reading) and current.get("volume") == reading["volume"]:
            # The same reading is already there (typically sent by live
            # monitoring, which sends the volume alone). A full read still
            # gives it its figures, and its proof picture (the mark).
            if not only_volume and any(current.get(k) is None and reading.get(k) is not None
                                       for k in VOLUME_ONLY_DROP):
                current = {**current, **{k: reading[k] for k in VOLUME_ONLY_DROP if reading.get(k) is not None}}
                _rest("POST", "dec_tank_state?on_conflict=tank_id",
                      [{"tank_id": tank["id"], "reading": current, "updated_at": saved_at}],
                      prefer="resolution=merge-duplicates,return=minimal", timeout=timeout)
            out[no] = {"ok": True, "tank_id": tank["id"], "message": "already in the app", "unchanged": True,
                       "reading": current, "mark": {"readingAt": current["readingAt"], "volume": current["volume"]}}
            continue
        _rest("POST", "dec_tank_state?on_conflict=tank_id",
              [{"tank_id": tank["id"], "reading": reading, "updated_at": saved_at}],
              prefer="resolution=merge-duplicates,return=minimal", timeout=timeout)
        out[no] = {"ok": True, "tank_id": tank["id"], "reading": reading,
                   "mark": {"readingAt": reading["readingAt"], "volume": reading["volume"]},
                   "message": f"saved {reading['volume']:,.2f} L ({'Checked' if built['confidence'] == 'high' else 'Fixed & checked'})"}
    return out
