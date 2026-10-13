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
import json
from pathlib import Path
import re
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


def _http(method: str, path: str, data, headers: dict, timeout: int = 30):
    url, key = cloud()
    headers = {"apikey": key, "Authorization": f"Bearer {key}", **headers}
    req = urllib.request.Request(f"{url}/{path}", data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
    except urllib.error.HTTPError as exc:
        raise DecantError(f"The decant database refused ({exc.code}).") from None
    except (urllib.error.URLError, OSError) as exc:
        raise DecantError(f"The decant database could not be reached ({type(exc).__name__}).") from None
    try:
        return json.loads(raw) if raw else None
    except ValueError:
        return None


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
    _rest("POST", "dec_shots?on_conflict=id",
          [{"id": shot_id, "day": day, "at": now.isoformat(), "readings": marks, "path": path, "source": "agent"}],
          prefer="resolution=merge-duplicates,return=minimal")
    return path


def drop_old_proofs(now=None) -> int:
    """Delete earlier days' screenshots (rows and files). Returns how many."""
    today = ist_day(now)
    rows = _rest("GET", f"dec_shots?day=lt.{today}&select=id,path&limit=500") or []
    if rows:
        _http("DELETE", f"storage/v1/object/{BUCKET}", json.dumps({"prefixes": [r["path"] for r in rows]}).encode(),
              {"Content-Type": "application/json"})
        _rest("DELETE", f"dec_shots?day=lt.{today}")
    return len(rows)


def dip_chart() -> dict:
    """The app's built-in dip chart (decant/js/dipchart.js)."""
    text = (ROOT / "decant" / "js" / "dipchart.js").read_text(encoding="utf-8")
    start = float(re.search(r"startCm:\s*([\d.]+)", text).group(1))
    step = float(re.search(r"stepCm:\s*([\d.]+)", text).group(1))
    body = text[text.index("litres:"):]
    body = body[body.index("[") + 1:body.index("]")]
    body = re.sub(r"//[^\n]*", "", body)
    return {"startCm": start, "stepCm": step, "litres": [float(v) for v in re.findall(r"[\d.]+", body)]}


def settings() -> dict:
    """{tanks, dateOrder, chart} from the app's saved settings, else defaults."""
    rows = _rest("GET", "dec_config?id=eq.1&select=data") or []
    data = (rows[0].get("data") if rows else None) or {}
    s = data.get("settings") or {}
    chart = data.get("chart") if (data.get("chart") or {}).get("litres") else dip_chart()
    tanks = s.get("tanks") if isinstance(s.get("tanks"), list) and s.get("tanks") else DEFAULT_TANKS
    return {"tanks": tanks, "dateOrder": s.get("dateOrder") or "MDY", "chart": chart}


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


def make_reading(card: dict, tank: dict, cfg: dict) -> dict:
    """core.js readingFrom + the photo reader's extras."""
    result = check(card, tank, cfg["chart"])
    cap = card.get("capacity") or tank.get("capacity") or 20000
    vol = round(card["volume"], 2) if card.get("volume") is not None else None
    height = card.get("height")
    density = card.get("density") if DENSITY[0] <= (card.get("density") or 0) <= DENSITY[1] else None
    density_tc = card.get("densityTc") if DENSITY[0] <= (card.get("densityTc") or 0) <= DENSITY[1] else None
    temp = card.get("temp") if TEMP[0] <= (card.get("temp") or 0) <= TEMP[1] else None
    at = reading_time(card.get("time"), cfg.get("dateOrder", "MDY"))
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
        "readingAt": at or datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
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


def upload(cards: dict, tanks, cfg=None, now=None, only_volume: bool = False) -> dict:
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
        built = make_reading(card, tank, cfg)
        if built["confidence"] == "low":
            out[no] = {"ok": False, "tank_id": tank["id"],
                       "message": "not saved: " + "; ".join(built["problems"] or ["check failed"])}
            continue
        reading = {**(volume_only(built["reading"]) if only_volume else built["reading"]), "savedAt": saved_at}
        rows = _rest("GET", f"dec_tank_state?tank_id=eq.{urllib.parse.quote(tank['id'])}&select=reading") or []
        current = rows[0].get("reading") if rows else None
        if current and _when(current) > _when(reading):
            out[no] = {"ok": False, "tank_id": tank["id"], "message": "the app already has a newer reading"}
            continue
        if current and _when(current) == _when(reading) and current.get("volume") == reading["volume"]:
            out[no] = {"ok": True, "tank_id": tank["id"], "message": "already in the app", "unchanged": True}
            continue
        _rest("POST", "dec_tank_state?on_conflict=tank_id",
              [{"tank_id": tank["id"], "reading": reading, "updated_at": saved_at}],
              prefer="resolution=merge-duplicates,return=minimal")
        out[no] = {"ok": True, "tank_id": tank["id"],
                   "mark": {"readingAt": reading["readingAt"], "volume": reading["volume"]},
                   "message": f"saved {reading['volume']:,.2f} L ({'Checked' if built['confidence'] == 'high' else 'Fixed & checked'})"}
    return out
