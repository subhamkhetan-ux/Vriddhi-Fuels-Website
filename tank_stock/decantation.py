"""An automatic decantation: the decant app's tanker decanting, run by the agent.

You give the plan on the tank stock page (which chamber goes into which
tank) and press Start. The agent then does what a person does in the decant
app's decanting screen (decant/js/wizard.js), going by the tank stock it
reads every few seconds through the open live session (FuelTrans' Tank Status):

- the stock before (a full read, with its proof picture) when it starts;
- a tank is **decanting** once its stock rises (the person's "▶ start");
- each chamber has **arrived** once the tank's rise covers it (in the plan's
  order, the order the pipe goes round);
- a tank is **done** (settling) once it has stopped rising with all its
  chambers in. Stopped short of them for longer than moving the pipe takes,
  it asks on the page which chambers were emptied (the app's "which chambers
  were emptied?"), unless the rise starts again first;
- **settled**, the stock steady for the app's settle time, it takes the
  stock after (a full read, with its proof picture);
- every tank read, it **finishes** the decantation with the app's own
  result (tankResult) and saves it.

Every step is written to the app's ``dec_sessions`` row as the app writes it,
so phones show it live and the result, reports and log treat it like any
other. Nothing here does any I/O: the service feeds it readings and does
what it says (``Decantation.feed`` returns the work to do).

The rules below are ports of decant/js/core.js and wizard.js; each names its
original.
"""
from __future__ import annotations

from datetime import datetime, timezone
import math
import random
import re
import string
import time
import traceback

# ---- the app's rules (decant/js/core.js) --------------------------------

PRODUCTS = ("MS", "HSD", "XG")
DEFAULT_SETTINGS = {
    "tolerancePct": 0.25, "toleranceMinL": 25, "warnRoomL": 150, "staleMinutes": 30,
    "settleMinutes": 10, "pipeMoveSecs": 45,
    "ownTTs": [{"tt": "OD23U8210", "chambers": [5, 5, 4, 4, 4]}],
}

# How the agent judges the stock (litres / seconds). It reads every ~10 s.
START_RISE_L = 30          # above the stock before: decanting has started
ARRIVE_SLACK = (50, 0.02)  # a chamber has arrived within max(50 L, 2 % of it)
STILL_L = 3                # within this the stock isn't moving
PAUSE_SECS = 25            # still this long after flowing: the pipe is being moved (a chamber ended)
STOP_SECS = 90             # still this long: the pipe has stopped
EXTRA_WAIT_SECS = 180      # stopped with more than planned this long: ask which chambers came
SHORT_WAIT_SECS = 300      # stopped short this long (moving the pipe takes less): ask
NOT_STARTED_SECS = 1800    # a tank still waiting this long, nothing else decanting: ask
MAX_FLOW_LPS = 40          # faster than this is a misread (a chamber takes minutes)
MISREAD_L = 50             # ... give or take this
FALL_L = 20                # a tank being decanted doesn't sell: a bigger fall needs a second reading
SALE_L = 5                 # a waiting tank fell this much: it sold, so its stock before is read again
BEFORE_EVERY = 60          # ... at most this often
SETTLE_BAND_L = 5          # steady: within this for the settle time
SETTLE_BAND_PCT = 0.05     # ... or this much of the stock, if more
SETTLE_MAX = 3             # not steady after this many settle times: read it anyway
SALES_BACK_L = 15          # settling and fell this much: sales are back on
RISE_AGAIN_L = 30          # settling and rose this much: decanting again
UNPLANNED_RISE_L = 60      # a tank outside the plan rose this much: warn
AFTER_TRIES = 3            # full reads for the stock after before taking the live figure


def slack(litres: float) -> float:
    """How far a tank's gain may be from a chamber's litres and still be it."""
    return max(ARRIVE_SLACK[0], ARRIVE_SLACK[1] * litres)


def js_round(x: float) -> float:
    """JavaScript's Math.round: halves go up (-100.5 -> -100), unlike round()."""
    return math.floor(x + 0.5)


def round2(n: float) -> float:
    """round2: Math.round(n * 100) / 100."""
    return js_round(n * 100) / 100


def pct_of(part: float, whole: float) -> float:
    """pctOf: to 3 decimals."""
    return js_round(part / whole * 100000) / 1000 if whole > 0 else 0


def norm_tt(s) -> str:
    return re.sub(r"[^A-Z0-9]", "", str(s or "").upper())


def product_key(text) -> str | None:
    """productKey."""
    u = str(text or "").upper()
    if not u.strip():
        return None
    if re.search(r"XTRA\s*GR|XTRAGRN|\bXG\b", u):
        return "XG"
    if re.search(r"LSHF", u):
        return "LSHF"
    if re.search(r"EBMS|(^|[^A-Z])MS([^A-Z]|$)|PETROL|MOTOR\s*SPIRIT|\bMOTOR\b", u):
        return "MS"
    if re.search(r"HSD|DIESEL|HIGH\s*SPEED", u):
        return "HSD"
    return None


def settings_with(saved: dict | None, tanks: list) -> dict:
    """The parts of settingsWith a decantation needs."""
    s = {**DEFAULT_SETTINGS, **(saved or {})}
    s["tanks"] = [{"id": str(t.get("id") or f"T{i + 1}"), "no": int(t.get("no") or i + 1),
                   "product": t.get("product") if t.get("product") in PRODUCTS else "HSD",
                   "capacity": float(t.get("capacity") or 20000),
                   "fillTo": float(t.get("fillTo") or (20500 if float(t.get("capacity") or 20000) == 20000
                                                       else t.get("capacity") or 20000))}
                  for i, t in enumerate(tanks)]
    for k in ("tolerancePct", "toleranceMinL", "warnRoomL", "staleMinutes", "settleMinutes", "pipeMoveSecs"):
        try:
            s[k] = float(s[k])
        except (TypeError, ValueError):
            s[k] = DEFAULT_SETTINGS[k]
    return s


def fill_limit(tank: dict) -> float:
    return float(tank.get("fillTo") or tank.get("capacity") or 20000)


def room_of(reading: dict | None, tank: dict | None) -> float:
    """roomOf."""
    if not reading or reading.get("volume") is None:
        return float("nan")
    return round2((fill_limit(tank) if tank else reading.get("capacity") or 20000) - reading["volume"])


def to_litres(kl) -> int:
    return round(float(kl or 0) * 1000)


def chamber_layout(inv: dict, vehicle: dict | None = None) -> dict:
    """chamberLayout: the truck's chambers with the product in each."""
    src = inv.get("chambers") or (vehicle or {}).get("chambers") or []
    chambers = sorted(({"no": int(c.get("no") or 0), "litres": to_litres(c.get("qty_kl")),
                        "dipCm": c.get("dip_cm"), "product": None, "how": "empty"}
                       for c in src if int(c.get("no") or 0) > 0), key=lambda c: c["no"])
    by_no = {c["no"]: c for c in chambers}
    lines = []
    for i, ln in enumerate(inv.get("lines") or []):
        qty = ln.get("qty_kl", ln.get("qty"))
        lines.append({"i": i, "key": product_key(ln.get("column_key") or ln.get("product")) or "HSD",
                      "litres": to_litres(qty),
                      "compartments": [int(n) for n in ln.get("compartments") or [] if int(n) > 0],
                      "density15": ln.get("density15"),
                      "pricePerL": (ln["value"] / to_litres(qty)) if ln.get("value") and float(qty or 0) else None})
    for ln in lines:
        for no in ln["compartments"]:
            if no in by_no:
                by_no[no].update(product=ln["key"], how="invoice")
    rest = sorted((ln for ln in lines if not ln["compartments"]), key=lambda ln: (ln["key"] != "MS", ln["i"]))
    free = [c for c in chambers if not c["product"] and c["litres"] > 0]
    k = 0
    for ln in rest:
        got = 0
        while k < len(free) and got < ln["litres"]:
            free[k].update(product=ln["key"], how="ms-rule" if ln["key"] == "MS" else "order")
            got += free[k]["litres"]
            k += 1
    return {"chambers": chambers, "lines": lines}


def layout_for(inv: dict, settings: dict) -> dict:
    """layoutFor: an own TT's chambers stand in when the invoice has none."""
    own = next((o for o in settings.get("ownTTs") or [] if norm_tt(o.get("tt")) == norm_tt(inv.get("tt_no"))), None)
    vehicle = {"chambers": [{"no": i + 1, "qty_kl": kl} for i, kl in enumerate(own["chambers"])]} if own else None
    return chamber_layout(inv, vehicle)


def used_chambers(sessions: list, invoice_no: str, except_id: str | None = None) -> set:
    """usedChambers."""
    used = set()
    for s in sessions or []:
        if s.get("invoice_no") != invoice_no or s.get("id") == except_id or s.get("status") in ("cancelled", "draft"):
            continue
        for p in (s.get("data") or {}).get("plan") or []:
            if p.get("tank"):
                used.add(p["no"])
    return used


def tank_stage(session: dict, row: dict) -> str:
    """tankStage."""
    if row.get("stage"):
        return row["stage"]
    st = session.get("status")
    if st == "decanting":
        return "decanting"
    if st == "draft":
        return "waiting"
    return "read" if row.get("after") else "settling"


def reserving_draft(s: dict) -> bool:
    """A draft whose tanks are taken already: the agent is running it (they
    are waiting for the truck), or it is set up to decant tank by tank."""
    d = s.get("data") or {}
    auto = d.get("auto") or {}
    return s.get("status") == "draft" and bool(d.get("tanks")) and \
        (bool(auto) and not auto.get("released") or d.get("step") == "decant")


def busy_tanks(sessions: list, except_id: str | None = None) -> set:
    """busyTanks: tanks taken by a truck being decanted, or next in line for
    one (a draft the agent runs, or one set up tank by tank)."""
    busy = set()
    for s in sessions or []:
        if s.get("id") == except_id or not (s.get("status") in ("decanting", "settling") or reserving_draft(s)):
            continue
        for t in (s.get("data") or {}).get("tanks") or []:
            if tank_stage(s, t) != "read":
                busy.add(t.get("tank"))
    return busy


def invoice_status(inv: dict, sessions: list, layout: dict) -> str:
    """invoiceStatus."""
    if inv.get("dismissed"):
        return "dismissed"
    mine = [s for s in sessions or [] if s.get("invoice_no") == inv.get("invoice_no") and s.get("status") != "cancelled"]
    if any(s.get("status") in ("decanting", "settling") for s in mine):
        return "active"
    used = used_chambers(sessions, inv.get("invoice_no"))
    loaded = [c for c in layout["chambers"] if c["product"] in PRODUCTS and c["litres"] > 0]
    if loaded and all(c["no"] in used for c in loaded):
        return "done"
    return "partial" if used else "new"


def check_plan(plan: list, tanks: list, readings: dict, busy: set, settings: dict, now: float | None = None) -> dict:
    """checkPlan: {perTank, blocking, warnings}."""
    now = now or time.time()
    blocking, warnings, per_tank = [], [], []
    by_id = {t["id"]: t for t in tanks}
    for p in plan:
        t = by_id.get(p.get("tank")) if p.get("tank") else None
        if p.get("tank") and not t:
            blocking.append(f"Chamber {p['no']}: unknown tank {p['tank']}.")
        if t and t["product"] != p["product"]:
            blocking.append(f"Chamber {p['no']} holds {p['product']} — it can't go into Tank {t['no']} ({t['product']}).")
    for t in tanks:
        rows = [p for p in plan if p.get("tank") == t["id"]]
        if not rows:
            continue
        litres = sum(p["litres"] for p in rows)
        r = (readings or {}).get(t["id"])
        row = {"tank": t["id"], "no": t["no"], "product": t["product"], "litres": litres,
               "chambers": [p["no"] for p in rows], "level": "ok"}
        if t["id"] in busy:
            blocking.append(f"Tank {t['no']} is already being decanted — finish that first.")
        if not r or r.get("volume") is None:
            blocking.append(f"Add Tank {t['no']}'s stock before decanting.")
            row["level"] = "noreading"
            per_tank.append(row)
            continue
        room = room_of(r, t)
        row.update(room=room, before=r["volume"], after=round2(r["volume"] + litres), leftRoom=round2(room - litres))
        if litres > room + 1e-6:
            row["level"] = "over"
            blocking.append(f"Tank {t['no']} has room for {room:,.0f} L; {litres:,.0f} L is planned. Hold a chamber back.")
        elif row["leftRoom"] < settings["warnRoomL"]:
            row["level"] = "tight"
            warnings.append(f"Tank {t['no']} will be nearly full ({row['leftRoom']:,.0f} L room left).")
        if (r.get("water") or 0) > 0:
            warnings.append(f"Tank {t['no']} shows {r['water']:,.0f} L of water.")
        per_tank.append(row)
    if not any(p.get("tank") for p in plan):
        blocking.append("Pick at least one chamber to decant.")
    return {"perTank": per_tank, "blocking": blocking, "warnings": warnings}


def tank_result(litres: float, before: dict, after: dict, settings: dict, sales_l: float = 0) -> dict | None:
    """tankResult: variation = (after − before) − decanted."""
    if not before or not after or before.get("volume") is None or after.get("volume") is None:
        return None
    gain = round2(after["volume"] - before["volume"])
    expected = round2(litres - (sales_l or 0))
    variation = round2(gain - expected)
    tol = max(settings["toleranceMinL"], litres * settings["tolerancePct"] / 100)
    a = abs(variation)
    return {"gain": gain, "expected": expected, "variation": variation, "pct": pct_of(variation, litres),
            "tol": round2(tol), "band": "ok" if a <= tol else "watch" if a <= 2 * tol else "high",
            "direction": "short" if variation < 0 else "excess" if variation > 0 else "exact"}


def suggest_plan(chambers: list, tanks: list, readings: dict) -> list:
    """A first plan for the page: each chamber into a tank of its product, a
    product with two tanks filling the one with more room first. (The app's
    own suggestPlan weighs more; this is only where the page starts, and
    you change any chamber.)"""
    room = {t["id"]: room_of(readings.get(t["id"]), t) for t in tanks}
    plan = []
    for c in chambers:
        options = [t for t in tanks if t["product"] == c["product"]]
        fits = [t for t in options if (room[t["id"]] if not math.isnan(room[t["id"]]) else 0) >= c["litres"]]
        pick = max(fits, key=lambda t: room[t["id"]], default=None)
        if pick:
            room[pick["id"]] -= c["litres"]
        plan.append({"no": c["no"], "product": c["product"], "litres": c["litres"], "tank": pick["id"] if pick else None})
    return plan


def sync_status(s: dict) -> None:
    """syncStatus: the session's status and times follow its tanks."""
    d = s["data"]
    for t in d["tanks"]:
        stage = tank_stage(s, t)
        t["startedAt"] = t.get("startedAt") or (None if stage == "waiting" else d.get("startedAt"))
        t["doneAt"] = t.get("doneAt") or (d.get("decantedAt") if stage in ("settling", "read") else None)
        t["stage"] = stage
    running = any(t["stage"] == "decanting" for t in d["tanks"])
    waiting = any(t["stage"] == "waiting" for t in d["tanks"])
    started = any(t.get("startedAt") for t in d["tanks"])
    if not d["tanks"] or (waiting and not started):
        s["status"] = "draft"
    elif running or waiting:
        s["status"] = "decanting"
    else:
        s["status"] = "settling"
    starts = sorted(t["startedAt"] for t in d["tanks"] if t.get("startedAt"))
    dones = sorted(t["doneAt"] for t in d["tanks"] if t.get("doneAt"))
    d["startedAt"] = starts[0] if starts else None
    d["decantedAt"] = None if (running or waiting) else (dones[-1] if dones else None)


def new_id(prefix: str = "S") -> str:
    """newId: S-<ms in base 36>-<6 random base 36>."""
    n, digits = int(time.time() * 1000), string.digits + string.ascii_lowercase
    b36 = ""
    while n:
        n, r = divmod(n, 36)
        b36 = digits[r] + b36
    return f"{prefix}-{b36}-{''.join(random.choice(digits) for _ in range(6))}"


def iso(t: float | None = None) -> str:
    """Like the app's new Date().toISOString()."""
    return datetime.fromtimestamp(t or time.time(), timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def new_session(inv: dict, layout: dict, sessions: list, operator: str = "Tank stock agent") -> dict:
    """startSession: a new decantation for an invoice."""
    used = used_chambers(sessions, inv["invoice_no"])
    return {
        "id": new_id("S"), "invoice_no": inv["invoice_no"], "tt_no": inv.get("tt_no"), "status": "draft",
        "data": {
            "step": "truck",
            "invoice": {k: inv.get(k) for k in ("invoice_no", "invoice_date", "invoice_time", "tt_no", "lines",
                                                "chambers", "density15", "seals", "source")},
            "chambers": [{k: c[k] for k in ("no", "litres", "product", "dipCm", "how")} for c in layout["chambers"]],
            "done": sorted(used),
            "prices": {ln["key"]: round2(ln["pricePerL"]) for ln in layout["lines"] if ln["pricePerL"]},
            "densities": {ln["key"]: ln["density15"] for ln in layout["lines"] if ln["density15"]},
            "checks": {"density": {}}, "before": {}, "plan": [], "tanks": [], "operator": operator,
        },
    }


# ---- the run ----------------------------------------------------------------

_FRACTION = re.compile(r"\.(\d{1,6})(?=[+-]\d\d:?\d\d$|$)")


def _ts(value) -> float | None:
    """An ISO time as Postgres or a phone writes it. (Python before 3.11 only
    takes 3 or 6 fraction digits; Postgres drops trailing zeros: .12)"""
    text = str(value).replace("Z", "+00:00")
    text = _FRACTION.sub(lambda m: "." + m.group(1).ljust(6, "0"), text, count=1)
    try:
        return datetime.fromisoformat(text).timestamp()
    except ValueError:
        return None


def best_subset(options: list, litres: float, prefer=()) -> list:
    """The chambers ([(no, litres)]) whose litres come closest to ``litres``
    (fewest left out of ``prefer`` on a tie). At most 8 options: 256 sums."""
    best, best_key = [], None
    opts = options[:8]
    for mask in range(1, 1 << len(opts)):
        pick = [opts[i] for i in range(len(opts)) if mask >> i & 1]
        key = (abs(sum(c for _, c in pick) - litres), -sum(1 for no, _ in pick if no in prefer), len(pick))
        if best_key is None or key < best_key:
            best, best_key = [no for no, _ in pick], key
    return best


def _work() -> dict:
    # save: write the session; before / after: [{"tank", "from"}] full reads to do;
    # peak: tanks whose screen now shows their highest settling stock (kept for
    # an after read if sales come back); low: waiting tanks whose screen now shows
    # their lowest stock (kept for a stock before if it sells just before
    # decanting starts); finish; events: [{"at", "text", "level"}]
    return {"save": False, "before": [], "after": [], "peak": [], "low": [], "finish": False, "events": []}


class Decantation:
    """One automatic decantation: the app's session plus what the agent
    follows for each tank. ``feed`` takes the latest stock and returns the
    work to do (see ``_work``)."""

    def __init__(self, session: dict, settings: dict, state: dict | None = None):
        self.s = session
        self.settings = settings
        self.state = state or {"tanks": {}, "log": [], "questions": {}, "others": {}}
        self.state.setdefault("questions", {})
        self.state.setdefault("others", {})

    # -- setting it up --
    @classmethod
    def plan(cls, session: dict, plan: list, before: dict, settings: dict, busy: set,
             now: float | None = None) -> "Decantation":
        """prepare + "tank by tank": the plan becomes the tanks, waiting."""
        now = now or time.time()
        d = session["data"]
        d["plan"] = sorted(({"no": p["no"], "product": p["product"], "litres": p["litres"], "tank": p.get("tank")}
                            for p in plan), key=lambda p: p["no"])
        d["before"] = {**(d.get("before") or {}), **before}
        chk = check_plan(d["plan"], settings["tanks"], before, busy, settings, now)
        if chk["blocking"]:
            raise ValueError(chk["blocking"][0])
        d["tanks"] = [{"tank": r["tank"], "tankNo": r["no"], "product": r["product"], "litres": r["litres"],
                       "chambers": r["chambers"], "before": before[r["tank"]], "after": None,
                       "pricePerL": (d.get("prices") or {}).get(r["product"]),
                       "stage": "waiting", "startedAt": None, "doneAt": None} for r in chk["perTank"]]
        d["step"] = "decant"
        d["auto"] = {"by": "tank stock agent", "arrived": {}, "questions": [], "released": False}
        sync_status(session)
        run = cls(session, settings)
        for t in d["tanks"]:
            run._st(t, now)
        run.log("Set up: " + "; ".join(f"C{', C'.join(map(str, t['chambers']))} into Tank {t['tankNo']}"
                                       for t in d["tanks"]) + ". Waiting for the stock to rise.", now)
        return run

    @classmethod
    def take_over(cls, session: dict, settings: dict, volumes: dict, now: float | None = None,
                  befores: dict | None = None) -> "Decantation":
        """A decantation started in the decant app, carried on from where it is:
        its plan, chambers and stock before stay the app's. Each tank picks up
        at its stage, by its live stock now (``volumes``: {tank id: litres}):

        - waiting: waits for its stock to rise (its stock before is read again
          if it sells meanwhile); ``befores`` gives one it had none of;
        - decanting: followed from here (all that went in since its stock
          before counts); one that hasn't risen yet waits for the rise instead;
        - settling: settles in full from now, then its stock after;
        - read: done.
        Refused (ValueError, said plainly) if it can't be followed safely."""
        now = now or time.time()
        d = session.get("data") or {}
        if session.get("status") not in ("draft", "decanting", "settling"):
            raise ValueError("It is already finished or cancelled in the decant app.")
        rows = d.get("tanks") or []
        if not rows:
            raise ValueError("It has no tank set up yet in the decant app: plan it there first (or start it here).")
        known = {t["id"]: t for t in settings["tanks"]}
        gone = [t.get("tankNo") or t["tank"] for t in rows if t["tank"] not in known]
        if gone:
            raise ValueError(f"Tank {', '.join(map(str, gone))} is no longer in the decant app's settings.")
        for t in rows:
            t["stage"] = tank_stage(session, t)
            t["tankNo"] = t.get("tankNo") or known[t["tank"]]["no"]
            if t["stage"] == "read":
                continue
            if (t.get("before") or {}).get("volume") is None:
                if (befores or {}).get(t["tank"]):
                    t["before"] = befores[t["tank"]]
                    d.setdefault("before", {})[t["tank"]] = t["before"]
                elif t["stage"] == "waiting":
                    raise ValueError(f"Tank {t['tankNo']} has no stock before.")
                else:
                    raise ValueError(f"Tank {t['tankNo']} is {t['stage']} but has no stock before in the app.")
            if volumes.get(t["tank"]) is None:
                raise ValueError(f"Tank {t['tankNo']}'s stock isn't on the PC's screen.")
        d["auto"] = {"by": "tank stock agent", "arrived": {}, "questions": [], "released": False, "takenOver": iso(now)}
        d.pop("autoRequest", None)
        d["step"] = "decant"
        run = cls(session, settings)
        said = []
        for t in rows:
            st = run._st(t, now)
            if t["stage"] == "read":
                continue
            before, v = t["before"]["volume"], float(volumes[t["tank"]])
            name = f"Tank {t['tankNo']}"
            if t["stage"] == "decanting" and v - before < START_RISE_L:
                # marked started in the app, but nothing has gone in yet: its start is the rise
                t["stage"], t["startedAt"] = "waiting", None
                said.append(f"{name} marked started but hasn't risen yet ({v:,.0f} L): waiting for the rise")
            elif t["stage"] == "waiting":
                said.append(f"{name} waiting (stock before {before:,.2f} L)")
            if t["stage"] == "waiting":
                st["low"] = [now, min(before, v)]
            elif t["stage"] == "decanting":
                t["startedAt"] = t.get("startedAt") or iso(now)
                st.update(lastRiseAt=now, lastRiseV=v, segFrom=before, flowing=True, acc=0.0, low=None)
                said.append(f"{name} decanting, +{v - before:,.0f} L of {t['litres']:,.0f} L in")
            elif t["stage"] == "settling":
                t["doneAt"] = t.get("doneAt") or iso(now)
                st.update(settledFrom=v, flowing=False, peak=None, afterTries=0, settleFrom=now,
                          lastRiseV=v, segFrom=before)
                said.append(f"{name} settling at {v:,.0f} L (it settles in full from now)")
        sync_status(session)
        run._sync_auto()
        run.log("Taken over from the decant app: " + "; ".join(said) + ".", now, "done")
        return run

    # -- helpers --
    def row(self, tank_id: str) -> dict | None:
        return next((t for t in self.s["data"]["tanks"] if t["tank"] == tank_id), None)

    def chamber_litres(self, no: int) -> float:
        return next((c["litres"] for c in self.s["data"]["chambers"] if c["no"] == no), 0)

    def tank_no(self, tank_id: str):
        return next((t["no"] for t in self.settings["tanks"] if t["id"] == tank_id), tank_id)

    def _st(self, t: dict, now: float) -> dict:
        st = self.state["tanks"].get(t["tank"])
        if st is None:
            v = (t.get("before") or {}).get("volume")
            st = self.state["tanks"][t["tank"]] = {
                "history": [], "pending": None, "lastRiseAt": None, "lastRiseV": None, "flowing": False,
                "arrived": [], "acc": 0.0, "segFrom": None, "low": [now, v] if v is not None else None,
                "beforeAskedAt": 0, "waitSince": now, "peak": None, "afterTries": 0}
        return st

    def log(self, text: str, t: float, level: str = "info") -> dict:
        ev = {"at": iso(t), "text": text, "level": level}
        self.state["log"] = (self.state["log"] + [ev])[-80:]
        return ev

    def _say(self, work: dict, text: str, now: float, level: str = "info") -> None:
        work["events"].append(self.log(text, now, level))

    def _sync_auto(self) -> None:
        """What the app's session row carries of the agent's view."""
        a = self.s["data"].setdefault("auto", {"by": "tank stock agent", "released": False})
        a["arrived"] = {k: list(v["arrived"]) for k, v in self.state["tanks"].items() if v.get("arrived")}
        a["questions"] = [{"tank": q["tank"], "kind": q["kind"], "text": q["text"]}
                          for q in self.state["questions"].values()]

    def active(self) -> bool:
        return self.s.get("status") in ("draft", "decanting", "settling") and \
            not (self.s["data"].get("auto") or {}).get("released")

    # -- what happens --
    def feed(self, volumes: dict, now: float | None = None) -> dict:
        """The latest product volume of the tanks read ({tank id: litres})."""
        now = now or time.time()
        work = _work()
        if not self.active():
            return work
        for tank_id, v in volumes.items():
            if v is None:
                continue
            t = self.row(tank_id)
            if t is None or t["stage"] == "read":
                self._watch_other(tank_id, float(v), now, work, t)
                continue
            st = self._st(t, now)
            try:
                v = self._accept(t, st, float(v), now)
                if v is not None:
                    getattr(self, f"_{t['stage']}")(t, st, v, now, work)
            except Exception as exc:  # noqa: BLE001 - one tank's trouble never stops the others
                key = f"{t['tank']}:{type(exc).__name__}"
                if self.state.get("failing") != key:
                    self.state["failing"] = key
                    traceback.print_exc()
                    self._say(work, f"Tank {t.get('tankNo')}: its stock couldn't be followed ({type(exc).__name__}): "
                                    "check it in the decant app.", now, "warn")
        self._waiting_long(now, work)
        if self.ready_to_finish():
            work["finish"] = True
        if work["save"]:
            self._sync_auto()
        return work

    def ready_to_finish(self) -> bool:
        """Every tank has its stock after, and no held chamber is being asked
        about (it may be going into a tank yet to be added)."""
        return self._all_read() and not any(q.get("kind") == "held" for q in self.state["questions"].values())

    # -- chambers kept in the truck --
    def held(self) -> list:
        """The truck's chambers still in it: loaded, in no tank, not decanted before."""
        d = self.s["data"]
        planned = {p["no"] for p in d.get("plan") or [] if p.get("tank")}
        done = set(d.get("done") or [])
        return [{"no": c["no"], "product": c["product"], "litres": c["litres"]} for c in d["chambers"]
                if c.get("product") in PRODUCTS and c.get("litres", 0) > 0 and c["no"] not in planned
                and c["no"] not in done]

    def _tank(self, tank_id: str) -> dict | None:
        return next((t for t in self.settings["tanks"] if t["id"] == tank_id), None)

    def _ask_held(self, tank_id: str, tank: dict, held: list, rise: float, now: float, work: dict) -> None:
        nos = ", ".join(f"C{c['no']}" for c in held)
        q = {"kind": "held", "tank": tank_id, "tankNo": tank["no"], "since": iso(now), "rise": round2(rise),
             "planned": None, "options": [{"no": c["no"], "litres": c["litres"], "from": None} for c in held],
             "suggest": best_subset([(c["no"], c["litres"]) for c in held], rise) if len(held) > 1 else [held[0]["no"]],
             "text": f"Tank {tank['no']} is rising (+{rise:,.0f} L) but isn't in this decantation. {nos} "
                     f"({tank['product']}) {'is' if len(held) == 1 else 'are'} still in the truck: going into Tank {tank['no']}?"}
        self.state["questions"][tank_id] = q
        work["save"] = True
        self._sync_auto()
        self._say(work, q["text"] + " (answer on the tank stock page)", now, "ask")

    def _answer_held(self, q: dict, chambers, now: float) -> dict:
        tank_id = q["tank"]
        self.state["questions"].pop(tank_id, None)
        if not chambers or chambers == "drop":
            work = _work()
            work["save"] = True
            self._sync_auto()
            self._say(work, f"⚠ Tank {q['tankNo']} is rising, but not with this truck's chambers, as you said. "
                            "Is something else going into it?", now, "warn")
            return work
        o = self.state["others"].get(tank_id) or {}
        before = self.low_reading(tank_id, o.get("low"), o.get("lowAt"), now)
        return self.add(tank_id, chambers, before, now, from_low=True)

    def low_reading(self, tank_id: str, low, low_at, now: float) -> dict | None:
        """A stock before from the live figure just before the tank rose (read
        in full from that screen afterwards, when it was kept)."""
        if low is None:
            return None
        cap = float((self._tank(tank_id) or {}).get("capacity") or 20000)
        return {"volume": round2(low), "ullage": round2(cap - low), "capacity": cap, "height": None, "dip": None,
                "water": None, "density": None, "densityTc": None, "temp": None, "status": None,
                "readingAt": low_at or iso(now), "timeRead": False, "source": "photo", "via": "server",
                "confidence": "medium", "savedAt": iso(now),
                "note": "the live product volume just before it started rising"}

    def add(self, tank_id: str, chambers, before: dict | None, now: float | None = None,
            from_low: bool = False) -> dict:
        """Held chambers into a tank, while the decantation runs: into a tank in
        it (planned litres up; one settling waits for them again) or a new one
        with this stock ``before`` (``from_low``: the live figure just before it
        rose, read in full from that screen next)."""
        now = now or time.time()
        work = _work()
        d = self.s["data"]
        if not self.active():
            raise ValueError("This decantation has ended: decant them as a new one.")
        held = {c["no"]: c for c in self.held()}
        nos = sorted({int(n) for n in chambers or []})
        if not nos:
            raise ValueError("Tick the chambers to add.")
        gone = [n for n in nos if n not in held]
        if gone:
            raise ValueError(f"C{', C'.join(map(str, gone))} isn't in the truck any more (in a tank, or decanted).")
        tank = self._tank(tank_id)
        if not tank:
            raise ValueError("That tank isn't in the decant app's settings.")
        wrong = [n for n in nos if held[n]["product"] != tank["product"]]
        if wrong:
            raise ValueError(f"C{', C'.join(map(str, wrong))} holds {held[wrong[0]]['product']}: it can't go into "
                             f"Tank {tank['no']} ({tank['product']}).")
        t = self.row(tank_id)
        if t and t["stage"] == "read":
            raise ValueError(f"Tank {tank['no']}'s stock after is already taken: decant C{', C'.join(map(str, nos))} "
                             "into it as a new decantation once this one is saved.")
        litres = round2(sum(held[n]["litres"] for n in nos))
        plan_nos = {p["no"] for p in d["plan"]}
        for p in d["plan"]:
            if p["no"] in nos:
                p["tank"] = tank_id
        d["plan"] += [{"no": n, "product": held[n]["product"], "litres": held[n]["litres"], "tank": tank_id}
                      for n in nos if n not in plan_nos]
        d["plan"].sort(key=lambda p: p["no"])
        names = f"C{', C'.join(map(str, nos))}"
        if t:
            t["chambers"] = sorted(set(t["chambers"]) | set(nos))
            t["litres"] = round2(t["litres"] + litres)
            st = self._st(t, now)
            if t["stage"] == "settling":
                # more is coming: it decants again, and waits for it (asked if it doesn't come)
                last = st["history"][-1][1] if st.get("history") else t["before"]["volume"] + t["litres"] - litres
                t["stage"], t["doneAt"] = "decanting", None
                st.update(lastRiseAt=now, lastRiseV=last, flowing=False, peak=None)
                if st.get("segFrom") is None:
                    st["segFrom"] = last
            text = f"{names} ({litres:,.0f} L) added to Tank {tank['no']}: {t['litres']:,.0f} L planned now."
        else:
            if not before or before.get("volume") is None:
                raise ValueError(f"Tank {tank['no']}'s stock before couldn't be read.")
            t = {"tank": tank_id, "tankNo": tank["no"], "product": tank["product"], "litres": litres, "chambers": nos,
                 "before": before, "after": None, "pricePerL": (d.get("prices") or {}).get(tank["product"]),
                 "stage": "waiting", "startedAt": None, "doneAt": None}
            d["tanks"].append(t)
            d["before"][tank_id] = before
            self.state["others"].pop(tank_id, None)
            self._st(t, now)
            if from_low:
                work["before"].append({"tank": tank_id, "from": "low", "volume": before["volume"]})
            text = (f"{names} ({litres:,.0f} L) added: into Tank {tank['no']}, stock before "
                    f"{before['volume']:,.2f} L.")
        self.state["questions"].pop(tank_id, None)
        sync_status(self.s)
        self._sync_auto()
        work["save"] = True
        self._say(work, text, now)
        return work

    def _all_read(self) -> bool:
        rows = self.s["data"]["tanks"]
        return bool(rows) and all(t["stage"] == "read" and t.get("after") for t in rows)

    def _accept(self, t: dict, st: dict, v: float, now: float) -> float | None:
        """A reading that couldn't have happened (a jump faster than a pipe
        fills, or a fall where nothing sells) counts only once a second
        reading agrees with it."""
        h = st["history"]
        if h:
            t0, v0 = h[-1]
            dt = max(1.0, now - t0)
            up = MAX_FLOW_LPS * dt + MISREAD_L
            down = {"decanting": FALL_L, "settling": SALES_BACK_L}.get(t["stage"], up)
            if not -down <= v - v0 <= up:
                p = st.get("pending")
                if not (p and abs(v - p[1]) <= MAX_FLOW_LPS * max(1.0, now - p[0]) + STILL_L):
                    st["pending"] = [now, v]
                    return None
        st["pending"] = None
        h.append([now, v])
        keep = max(STOP_SECS, SHORT_WAIT_SECS, self.settings["settleMinutes"] * 60 * SETTLE_MAX) + 120
        while h and now - h[0][0] > keep:
            h.pop(0)
        return v

    def _rising(self, st: dict, v: float, now: float) -> bool:
        if st["lastRiseV"] is None or v > st["lastRiseV"] + STILL_L:
            st["lastRiseAt"], st["lastRiseV"] = now, v
            return True
        return False

    def _waiting(self, t: dict, st: dict, v: float, now: float, work: dict) -> None:
        name = f"Tank {t['tankNo']}"
        before = t["before"]["volume"]
        if st["low"] is None or v < st["low"][1]:
            st["low"] = [now, v]
            work["low"].append(t["tank"])
        base = min(before, st["low"][1])
        if before - v >= SALE_L and now - st["beforeAskedAt"] >= BEFORE_EVERY:
            st["beforeAskedAt"] = now                    # it sold: read its stock before again
            work["before"].append({"tank": t["tank"]})
        if v - base < START_RISE_L:
            return
        # the rise began after the last reading still at the stock it rested at
        began = st["low"][0]
        for when, x in st["history"]:
            if when >= st["low"][0] and x - base < START_RISE_L / 3:
                began = when
        if before - base > STILL_L:
            # it sold since its stock before was read: that stock, from the live figure
            t["before"] = {**t["before"], **{k: None for k in ("height", "dip", "water", "density", "densityTc", "temp")},
                           "volume": round2(base), "ullage": round2((t["before"].get("capacity") or 20000) - base),
                           "readingAt": iso(st["low"][0]), "timeRead": False, "confidence": "medium",
                           "note": "the live product volume just before decanting (it sold after the full read)"}
            self.s["data"]["before"][t["tank"]] = t["before"]
            # and in full, with its picture, from the screen kept at that low
            work["before"].append({"tank": t["tank"], "from": "low", "volume": round2(base)})
            self._say(work, f"{name}: it sold {before - base:,.0f} L after its stock was read; "
                            f"the stock before is now {base:,.2f} L.", now, "warn")
        t["stage"], t["startedAt"] = "decanting", iso(began)
        st.update(lastRiseAt=now, lastRiseV=v, flowing=True, segFrom=base, acc=0.0)
        self.state["questions"].pop(t["tank"], None)
        sync_status(self.s)
        work["save"] = True
        self._say(work, f"{name}: decanting started (+{v - base:,.0f} L).", now)

    def _decanting(self, t: dict, st: dict, v: float, now: float, work: dict) -> None:
        name = f"Tank {t['tankNo']}"
        if st["lastRiseV"] is None or st["segFrom"] is None:
            # (decanting without a rise seen here: a phone said so, or added chambers to a settled tank)
            base = st["history"][-2][1] if len(st["history"]) > 1 else t["before"]["volume"]
            st["lastRiseAt"] = st["lastRiseAt"] or now
            st["lastRiseV"] = base if st["lastRiseV"] is None else st["lastRiseV"]
            st["segFrom"] = base if st["segFrom"] is None else st["segFrom"]
        rise = v - t["before"]["volume"]
        rose = self._rising(st, v, now)
        q = self.state["questions"].get(t["tank"])
        if rose:
            if not st["flowing"]:
                st["flowing"] = True
            if q and q["kind"] in ("short", "extra"):
                self.state["questions"].pop(t["tank"])
                work["save"] = True
                self._say(work, f"{name}: rising again, so the question is withdrawn.", now)
            return
        still = now - st["lastRiseAt"]
        if st["flowing"] and still >= PAUSE_SECS:
            # a run of flow ended: the pipe is being moved, or has stopped
            st["acc"] += st["lastRiseV"] - st["segFrom"]
            st["segFrom"], st["flowing"] = st["lastRiseV"], False
            self._match(t, st, now, work)
        if still < STOP_SECS or q:
            return
        planned = t["litres"]
        left = [no for no in t["chambers"] if no not in st["arrived"]]
        extra = self._extra_options(t)
        if rise > planned + slack(planned) and extra:
            if still >= EXTRA_WAIT_SECS:
                self._ask(t, "extra", rise, now, work)
        elif not left or abs(rise - planned) <= slack(planned):
            if rise > planned + slack(planned):
                self._say(work, f"{name}: it got {rise - planned:,.0f} L more than planned "
                                "and no other chamber of that product is left.", now, "warn")
            self._done(t, st, t["chambers"], now, work)
        elif still >= SHORT_WAIT_SECS:
            self._ask(t, "short", rise, now, work)

    def _match(self, t: dict, st: dict, now: float, work: dict) -> None:
        """Which chamber(s) that run of flow emptied: the one whose litres it
        matches (or two together, or the next few in the plan's order)."""
        acc = st["acc"]
        left = [no for no in t["chambers"] if no not in st["arrived"]]
        if acc < START_RISE_L or not left:
            return
        size = {no: self.chamber_litres(no) for no in left}
        pick = None
        singles = sorted((abs(acc - size[no]), i, [no]) for i, no in enumerate(left) if abs(acc - size[no]) <= slack(size[no]))
        if singles:
            pick = singles[0][2]
        else:
            pairs = sorted((abs(acc - size[a] - size[b]), i, [a, b]) for i, a in enumerate(left) for b in left[i + 1:]
                           if abs(acc - size[a] - size[b]) <= slack(size[a] + size[b]))
            if pairs:
                pick = pairs[0][2]
            else:
                total = 0
                for i, no in enumerate(left):
                    total += size[no]
                    if abs(acc - total) <= slack(total):
                        pick = left[:i + 1]
                        break
        if not pick:
            return                                       # part of a chamber: wait for the rest
        st["arrived"] += pick
        st["acc"] = 0.0
        t["chambers"] = st["arrived"] + [no for no in t["chambers"] if no not in st["arrived"]]
        work["save"] = True
        rise = st["lastRiseV"] - t["before"]["volume"]
        self._say(work, f"Tank {t['tankNo']}: chamber {' + '.join(map(str, pick))} is in "
                        f"(+{rise:,.0f} L of {t['litres']:,.0f} L).", now)

    def _extra_options(self, t: dict) -> list:
        """Chambers of t's product that may have gone into t instead: not yet in
        any tank (another tank's not arrived, or left in the truck)."""
        d = self.s["data"]
        out = []
        for r in d["tanks"]:
            if r is t or r["product"] != t["product"] or r["stage"] not in ("waiting", "decanting"):
                continue
            got = set(self.state["tanks"].get(r["tank"], {}).get("arrived") or [])
            out += [{"no": no, "litres": self.chamber_litres(no), "from": r["tank"]} for no in r["chambers"] if no not in got]
        planned = {p["no"] for p in d["plan"] if p.get("tank")}
        done = set(d.get("done") or [])
        out += [{"no": c["no"], "litres": c["litres"], "from": None} for c in d["chambers"]
                if c["product"] == t["product"] and c["litres"] > 0 and c["no"] not in planned and c["no"] not in done]
        return out

    def _ask(self, t: dict, kind: str, rise: float, now: float, work: dict) -> None:
        name = f"Tank {t['tankNo']}"
        own = [{"no": no, "litres": self.chamber_litres(no), "from": t["tank"]} for no in t["chambers"]]
        if kind == "notstarted":
            q = {"text": f"{name} hasn't started (C{', C'.join(map(str, t['chambers']))}). Leave its chambers in "
                         "the truck, or keep waiting?", "options": own, "suggest": []}
        else:
            options = own + (self._extra_options(t) if kind == "extra" else [])
            arrived = self.state["tanks"][t["tank"]]["arrived"]
            suggest = best_subset([(o["no"], o["litres"]) for o in options], rise, prefer=set(arrived) | set(t["chambers"]))
            if kind == "extra":
                text = (f"{name} got +{rise:,.0f} L, {rise - t['litres']:,.0f} L more than planned "
                        f"({t['litres']:,.0f} L). Which chambers went into it?")
            else:
                text = (f"{name}'s stock stopped rising at +{rise:,.0f} L of {t['litres']:,.0f} L planned. "
                        "Which chambers were emptied into it?")
            q = {"text": text, "options": options, "suggest": suggest}
        q.update(kind=kind, tank=t["tank"], tankNo=t["tankNo"], since=iso(now), rise=round2(rise), planned=t["litres"])
        self.state["questions"][t["tank"]] = q
        work["save"] = True
        self._say(work, q["text"] + " (answer on the tank stock page)", now, "ask")

    def _done(self, t: dict, st: dict, chambers: list, now: float, work: dict) -> None:
        """doneTanks: these chambers were emptied; the rest stay in the truck."""
        d = self.s["data"]
        keep = set(chambers)
        for p in d["plan"]:
            if p.get("tank") == t["tank"] and p["no"] not in keep:
                p["tank"] = None
        t["chambers"] = [no for no in t["chambers"] if no in keep]
        t["litres"] = sum(self.chamber_litres(no) for no in t["chambers"])
        st["arrived"] = list(t["chambers"])
        t["stage"] = "settling"
        t["doneAt"] = iso(st["lastRiseAt"] or now)
        st.update(peak=None, flowing=False, afterTries=0, settledFrom=st["lastRiseV"])
        self.state["questions"].pop(t["tank"], None)
        if not t["chambers"]:
            d["tanks"] = [x for x in d["tanks"] if x is not t]
        sync_status(self.s)
        work["save"] = True
        if t["chambers"]:
            self._say(work, f"Tank {t['tankNo']}: decanting done (C{', C'.join(map(str, sorted(t['chambers'])))}, "
                            f"{t['litres']:,.0f} L); settling for {self.settings['settleMinutes']:g} min.", now)
        else:
            self._say(work, f"Tank {t['tankNo']}: nothing went in; its chambers stay in the truck.", now, "warn")
        if not d["tanks"]:
            self._end_empty(now, work)

    def _end_empty(self, now: float, work: dict) -> None:
        """Every tank left out: nothing to finish."""
        self.s["status"] = "cancelled"
        self.s["completed_at"] = iso(now)
        self.s["data"]["cancelReason"] = "Nothing was decanted."
        work["save"] = True
        self._say(work, "Nothing was decanted: the decantation is cancelled and the chambers stay on the list.", now, "warn")

    def _settling(self, t: dict, st: dict, v: float, now: float, work: dict) -> None:
        name = f"Tank {t['tankNo']}"
        level = st.get("settledFrom") if st.get("settledFrom") is not None else v
        if v - level >= RISE_AGAIN_L:                     # the pipe went on again
            t["stage"], t["doneAt"] = "decanting", None
            st.update(lastRiseAt=now, lastRiseV=v, flowing=True, peak=None)
            sync_status(self.s)
            work["save"] = True
            self._say(work, f"{name}: rising again (+{v - level:,.0f} L): decanting.", now, "warn")
            return
        if st["peak"] is None or v >= st["peak"][1]:
            st["peak"] = [now, v]
            work["peak"].append(t["tank"])
        if st["peak"][1] - v >= SALES_BACK_L:
            # it sells again: its stock after is the one just before that
            work["after"].append({"tank": t["tank"], "from": "peak", "volume": st["peak"][1], "at": st["peak"][0]})
            self._say(work, f"{name}: the stock fell {st['peak'][1] - v:,.0f} L, so it sells again; "
                            "the stock after is taken from before the fall.", now, "warn")
            return
        settle = self.settings["settleMinutes"] * 60
        # (from when it was done, or from when the clock was last found to have jumped: settled again in full)
        since = now - max(_ts(t.get("doneAt")) or now, st.get("settleFrom") or 0)
        window = [x for when, x in st["history"] if now - when <= settle]
        covered = any(now - when >= settle - 15 for when, _ in st["history"])
        steady = covered and window and max(window) - min(window) <= max(SETTLE_BAND_L, SETTLE_BAND_PCT / 100 * v)
        if since >= settle and steady:
            work["after"].append({"tank": t["tank"], "from": "now"})
        elif since >= settle * SETTLE_MAX:
            work["after"].append({"tank": t["tank"], "from": "now", "unsteady": True})

    def _watch_other(self, tank_id: str, v: float, now: float, work: dict, row: dict | None) -> None:
        """A tank this truck isn't filling (or one already read) shouldn't rise."""
        first = tank_id not in self.state["others"]
        o = self.state["others"].setdefault(tank_id, {"low": v, "lowAt": iso(now), "warned": False, "over": 0})
        if first or v < o["low"] or not o.get("lowAt"):
            o["low"], o["lowAt"] = v, iso(now)
            if row is None:
                work["low"].append(tank_id)             # its screen at the low: a stock before, if it's this truck's
        if o["warned"]:
            return
        if v - o["low"] >= UNPLANNED_RISE_L:
            o["over"] += 1
            if o["over"] >= 2:                            # two readings in a row: not a misread
                o["warned"] = True
                tank = self._tank(tank_id)
                held = [c for c in self.held() if tank and c["product"] == tank["product"]] if row is None else []
                if held and tank_id not in self.state["questions"]:
                    self._ask_held(tank_id, tank, held, v - o["low"], now, work)
                    return
                what = "after its stock after was taken" if row else "but it isn't in this decantation"
                self._say(work, f"⚠ Tank {self.tank_no(tank_id)} is rising (+{v - o['low']:,.0f} L) {what}. "
                                "Is a chamber going into the wrong tank?", now, "warn")
        else:
            o["over"] = 0

    def clock_jumped(self, jump: float, now: float) -> None:
        """The server's clock was set right by `jump` seconds (the VM slept with
        the Mac and woke up behind). Times kept here no longer say how long
        anything took, so nothing is decided from them: a settling tank
        settles again in full, a still pipe and a waiting tank are timed from
        now. Fail-safe: it only ever waits longer."""
        for t in self.s["data"]["tanks"]:
            st = self._st(t, now)
            if t["stage"] == "settling":
                st.update(history=[], settleFrom=now, afterTries=0)
            else:
                st["history"] = [[when + jump, v] for when, v in st.get("history") or []]
            if st.get("lastRiseAt") is not None:
                st["lastRiseAt"] = now
            st["waitSince"] = now
            if st.get("low"):
                st["low"] = [st["low"][0] + jump, st["low"][1]]
        for q in self.state["questions"].values():
            q["since"] = iso(now)
        self.log(f"The server's clock was {'behind' if jump > 0 else 'ahead'} by {abs(jump) / 60:,.0f} min and has "
                 "been set right: settling and waiting times start again from now.", now, "warn")

    def _waiting_long(self, now: float, work: dict) -> None:
        rows = self.s["data"]["tanks"]
        if any(t["stage"] in ("decanting", "settling") for t in rows):
            # one tank after another: a tank waits its turn while another
            # decants or settles; its wait counts from when that is over
            for t in rows:
                if t["stage"] == "waiting":
                    self._st(t, now)["waitSince"] = now
            return
        for t in rows:
            st = self._st(t, now)
            if t["stage"] == "waiting" and t["tank"] not in self.state["questions"] \
                    and now - st["waitSince"] >= NOT_STARTED_SECS:
                self._ask(t, "notstarted", 0, now, work)

    # -- the stock before / after, from full reads --
    def set_before(self, tank_id: str, reading: dict, now: float | None = None, from_low: bool = False) -> dict:
        """A fresh full read of a tank still waiting (it sold since); or, with
        ``from_low``, the full read of the screen kept at its lowest stock just
        before decanting began (its stock before, from the live figure until now)."""
        now = now or time.time()
        work = _work()
        t = self.row(tank_id)
        if not t or not reading or reading.get("volume") is None:
            return work
        if from_low:
            if t["stage"] not in ("waiting", "decanting", "settling") or not t.get("before") or \
                    abs(reading["volume"] - t["before"]["volume"]) > STILL_L:
                return work                                # not that screen's stock: the live figure stays
            t["before"] = reading
            self.s["data"]["before"][tank_id] = reading
            work["save"] = True
            self._sync_auto()
            self._say(work, f"Tank {t['tankNo']}: stock before read in full from the screen just before "
                            f"decanting: {reading['volume']:,.2f} L.", now)
            return work
        if t["stage"] != "waiting":
            return work
        st = self._st(t, now)
        if reading["volume"] - (st["low"][1] if st["low"] else reading["volume"]) >= START_RISE_L:
            return work                                    # it has started meanwhile: the live figures decide
        t["before"] = reading
        self.s["data"]["before"][tank_id] = reading
        st["low"] = [now, reading["volume"]]
        work["save"] = True
        self._sync_auto()
        self._say(work, f"Tank {t['tankNo']}: it sold; stock before read again: {reading['volume']:,.2f} L.", now)
        return work

    def read_after(self, tank_id: str, reading: dict | None, fallback: dict | None = None,
                   note: str = "", now: float | None = None) -> dict:
        """setReading('after'): the stock after, from a full read; after
        AFTER_TRIES failed reads, the live figure (``fallback``)."""
        now = now or time.time()
        work = _work()
        t = self.row(tank_id)
        if not t or t["stage"] != "settling":
            return work
        st = self._st(t, now)
        st["afterTries"] += 1
        if not reading or reading.get("confidence") == "low" or reading.get("volume") is None:
            if st["afterTries"] < AFTER_TRIES or not fallback:
                return work                                # again on the next read
            reading, note = fallback, (note + "; " if note else "") + "from the live figure (the full read failed)"
        t["after"] = {**reading, **({"note": note} if note else {})}
        t["stage"] = "read"
        self.state["others"][tank_id] = {"low": reading["volume"], "warned": False, "over": 0}
        sync_status(self.s)
        work["save"] = True
        self._sync_auto()
        self._say(work, f"Tank {t['tankNo']}: stock after {reading['volume']:,.2f} L"
                        f"{f' ({note})' if note else ''}.", now)
        if self.ready_to_finish():
            work["finish"] = True
        return work

    def finish(self, now: float | None = None) -> list:
        """finish: every tank's result, and the decantation done."""
        now = now or time.time()
        d = self.s["data"]
        for t in d["tanks"]:
            t["result"] = tank_result(t["litres"], t["before"], t["after"], self.settings, t.get("salesL") or 0)
        sync_status(self.s)
        for t in d["tanks"]:
            t["stage"] = "read"
        d["completedAt"] = iso(now)
        self.s["completed_at"] = d["completedAt"]
        self.s["status"] = "done"
        self.state["questions"] = {}
        self._sync_auto()
        lines = []
        for t in d["tanks"]:
            r = t["result"] or {}
            lines.append(f"Tank {t['tankNo']}: {t['litres']:,.0f} L decanted, gained {r.get('gain', 0):,.2f} L, "
                         f"variation {r.get('variation', 0):+,.2f} L ({r.get('band')})")
        self.log("Finished and saved in the decant app. " + "; ".join(lines), now, "done")
        return lines

    # -- what you tell it on the page --
    def answer(self, tank_id: str, chambers: list | None, now: float | None = None) -> dict:
        """The answer to the tank's question: the chambers that went into it
        (short / extra), "drop" (not started: leave it out), or None (wait on)."""
        now = now or time.time()
        work = _work()
        q = self.state["questions"].get(tank_id)
        if q and q.get("kind") == "held":
            return self._answer_held(q, chambers, now)
        t = self.row(tank_id)
        if not q or not t:
            raise ValueError("That question has been answered or withdrawn.")
        st = self._st(t, now)
        if chambers is None:
            self.state["questions"].pop(tank_id)
            st["waitSince"] = now
            if t["stage"] == "decanting":
                st["lastRiseAt"] = now                     # wait the full time again
            work["save"] = True
            self._say(work, f"Tank {t['tankNo']}: waiting on, as you said.", now)
        elif q["kind"] == "notstarted":
            self.drop(tank_id, now, work)
        else:
            self.done_now(tank_id, chambers, now, work)
        self._sync_auto()
        return work

    def done_now(self, tank_id: str, chambers: list, now: float | None = None, work: dict | None = None) -> dict:
        """This tank is done with these chambers emptied into it (any of its
        own, or ones planned for another tank or left in the truck)."""
        now = now or time.time()
        work = work if work is not None else _work()
        t = self.row(tank_id)
        if not t or t["stage"] != "decanting":
            raise ValueError("That tank isn't decanting.")
        allowed = {o["no"]: o for o in [{"no": no, "from": tank_id} for no in t["chambers"]] + self._extra_options(t)}
        chosen = [int(no) for no in chambers if int(no) in allowed]
        if not chosen:
            raise ValueError("Tick at least one chamber (Cancel or Hand over if nothing was decanted).")
        d = self.s["data"]
        for no in chosen:
            src = allowed[no]["from"]
            if src == tank_id:
                continue
            if src:                                        # planned for another tank: it's this one's now
                other = self.row(src)
                other["chambers"] = [x for x in other["chambers"] if x != no]
                other["litres"] = sum(self.chamber_litres(x) for x in other["chambers"])
                self.state["questions"].pop(src, None)   # its question was about chambers it no longer has
                if not other["chambers"]:
                    d["tanks"] = [x for x in d["tanks"] if x is not other]
            for p in d["plan"]:
                if p["no"] == no:
                    p["tank"] = tank_id
            t["chambers"].append(no)
        st = self._st(t, now)
        st["arrived"] = [no for no in st["arrived"] if no in chosen] + [no for no in chosen if no not in st["arrived"]]
        t["chambers"] = st["arrived"] + [no for no in t["chambers"] if no not in st["arrived"]]
        self._done(t, st, chosen, now, work)
        self._sync_auto()
        return work

    def drop(self, tank_id: str, now: float | None = None, work: dict | None = None) -> dict:
        """dropTank: a tank not started is left out; its chambers stay in the truck."""
        now = now or time.time()
        work = work if work is not None else _work()
        t = self.row(tank_id)
        if not t or t["stage"] != "waiting":
            raise ValueError("Only a tank that hasn't started can be left out.")
        d = self.s["data"]
        for p in d["plan"]:
            if p.get("tank") == tank_id:
                p["tank"] = None
        d["tanks"] = [x for x in d["tanks"] if x is not t]
        self.state["questions"].pop(tank_id, None)
        sync_status(self.s)
        work["save"] = True
        self._say(work, f"Tank {t['tankNo']} left out: C{', C'.join(map(str, t['chambers']))} stay in the truck.", now)
        if not d["tanks"]:
            self._end_empty(now, work)
        elif self.ready_to_finish():
            work["finish"] = True
        self._sync_auto()
        return work

    def after_now(self, tank_id: str) -> dict:
        """Take this settling tank's stock after now, without waiting."""
        t = self.row(tank_id)
        if not t or t["stage"] != "settling":
            raise ValueError("That tank isn't settling.")
        work = _work()
        work["after"].append({"tank": tank_id, "from": "now", "asked": True})
        return work

    def release(self, now: float | None = None) -> None:
        """Hand it over to the decant app: the agent stops running it."""
        now = now or time.time()
        self.s["data"].setdefault("auto", {})["released"] = True
        self.state["questions"] = {}
        self._sync_auto()
        self.log("Handed over to the decant app: finish it there.", now, "done")

    def cancel(self, now: float | None = None) -> None:
        """cancelSession: only while nothing is decanted."""
        if any(t.get("startedAt") for t in self.s["data"]["tanks"]):
            raise ValueError("A tank has started: finish it, or hand it over to the decant app.")
        now = now or time.time()
        self.s["status"] = "cancelled"
        self.s["completed_at"] = iso(now)
        self.s["data"]["cancelReason"] = "Cancelled before decanting."
        for p in self.s["data"]["plan"]:
            p["tank"] = None
        self.state["questions"] = {}
        self._sync_auto()
        self.log("Cancelled before decanting.", now, "done")

    def adopt(self, remote: dict, now: float | None = None) -> list:
        """A phone changed the session in the decant app: it's the truth now
        (its stages, chambers and readings); the agent carries on from there."""
        now = now or time.time()
        old = {t["tank"]: t["stage"] for t in self.s["data"]["tanks"]}
        self.s = remote
        notes = []
        for t in remote["data"].get("tanks") or []:
            t["stage"] = tank_stage(remote, t)
            st = self._st(t, now)
            if t["tank"] not in old:
                self._adopt_new(t, st, now)
            v = (t.get("before") or {}).get("volume")
            if t["stage"] == "waiting" and v is not None and st["low"] and abs(st["low"][1] - v) > STILL_L \
                    and (not st["history"] or abs(st["history"][-1][1] - v) <= SALE_L):
                st["low"] = [now, v]                     # a new stock before from a phone
            if old.get(t["tank"]) != t["stage"]:
                notes.append(f"Tank {t.get('tankNo') or self.tank_no(t['tank'])}: {t['stage']} (from the decant app)")
                if t["stage"] == "settling":
                    # the level it settled from: the last rise seen here, else the latest
                    # reading, else the stock before and what went in
                    level = st.get("lastRiseV")
                    if level is None:
                        level = st["history"][-1][1] if st["history"] else \
                            ((t.get("before") or {}).get("volume") or 0) + (t.get("litres") or 0)
                    st.update(peak=None, flowing=False, afterTries=0, settledFrom=level)
                    if st.get("segFrom") is None:
                        st["segFrom"] = (t.get("before") or {}).get("volume")
                    if not t.get("doneAt"):
                        t["doneAt"] = iso(now)          # (else its settle time never starts)
                if t["stage"] == "decanting" and st["lastRiseV"] is None:
                    st.update(lastRiseAt=now, lastRiseV=(t.get("before") or {}).get("volume"),
                              segFrom=(t.get("before") or {}).get("volume"))
            q = self.state["questions"].get(t["tank"])
            if q and (q["kind"] == "held"               # (the phone put it in the decantation: that's the answer)
                      or not (q["kind"] == "notstarted" and t["stage"] == "waiting"
                              or q["kind"] != "notstarted" and t["stage"] == "decanting")):
                self.state["questions"].pop(t["tank"])
        rows = {t["tank"] for t in remote["data"].get("tanks") or []}
        for k in list(self.state["questions"]):
            if k not in rows:
                self.state["questions"].pop(k)
        for n in notes:
            self.log(n, now)
        if remote.get("status") == "done":
            self.log("Finished in the decant app.", now, "done")
        elif remote.get("status") == "cancelled":
            self.log("Cancelled in the decant app.", now, "done")
        elif (remote["data"].get("auto") or {}).get("released"):
            self.log("Handed over in the decant app.", now, "done")
        return notes

    def recheck_added(self, now: float | None = None) -> None:
        """Tanks a phone added that the agent watched before (after a restart:
        the same check as when they were taken over)."""
        now = now or time.time()
        for t in self.s["data"].get("tanks") or []:
            if t["tank"] in self.state.get("others", {}) and t["stage"] in ("waiting", "decanting"):
                self._adopt_new(t, self._st(t, now), now)

    def _adopt_new(self, t: dict, st: dict, now: float) -> None:
        """A tank a phone added to this decantation. The agent has watched its
        stock: if the app's stock before was taken after it had started rising
        (part of a chamber already in), the stock before is the one just before
        it rose; either way it is read in full from the screen kept then, for
        its proof picture (state "fullBefore", done by auto.py)."""
        o = self.state["others"].pop(t["tank"], None)
        v = (t.get("before") or {}).get("volume")
        if not o or o.get("low") is None or v is None or t["stage"] not in ("waiting", "decanting"):
            return
        low, name = o["low"], f"Tank {t.get('tankNo') or self.tank_no(t['tank'])}"
        if v - low >= START_RISE_L:
            t["before"] = self.low_reading(t["tank"], low, o.get("lowAt"), now)
            self.s["data"].setdefault("before", {})[t["tank"]] = t["before"]
            st["low"] = [_ts(o.get("lowAt")) or now, low]
            st["segFrom"] = low
            text = (f"⚠ {name}: its stock before in the decant app ({v:,.2f} L) isn't the stock just before it "
                    f"started rising (it was taken once the chamber was going in, or before sales): it is now "
                    f"{low:,.2f} L, the stock the agent saw just before it rose.")
            self.log(text, now, "warn")
            self.state.setdefault("corrected", []).append(text)
            self.state.setdefault("fullBefore", []).append({"tank": t["tank"], "volume": round2(low)})
        elif abs(v - low) <= STILL_L:
            self.state.setdefault("fullBefore", []).append({"tank": t["tank"], "volume": round2(v)})

    # -- the page --
    def view(self, now: float | None = None) -> dict:
        now = now or time.time()
        d = self.s["data"]
        settle = self.settings["settleMinutes"] * 60
        out = []
        for t in d["tanks"]:
            st = self.state["tanks"].get(t["tank"], {})
            last = st["history"][-1][1] if st.get("history") else None
            row = {"tank": t["tank"], "no": t.get("tankNo"), "product": t["product"], "stage": t["stage"],
                   "chambers": t["chambers"], "arrived": [no for no in st.get("arrived", []) if no in t["chambers"]],
                   "litres": t["litres"], "before": (t.get("before") or {}).get("volume"),
                   "beforeAt": (t.get("before") or {}).get("readingAt"), "now": last,
                   "rise": round2(last - t["before"]["volume"]) if last is not None and t.get("before") else None,
                   "after": (t.get("after") or {}).get("volume"), "result": t.get("result"),
                   "startedAt": t.get("startedAt"), "doneAt": t.get("doneAt")}
            if t["stage"] == "settling" and t.get("doneAt"):
                row["settleLeft"] = max(0, round(settle - (now - (_ts(t["doneAt"]) or now))))
                window = [x for when, x in st.get("history", []) if now - when <= settle]
                row["spread"] = round2(max(window) - min(window)) if window else None
            out.append(row)
        planned = {p["no"] for p in d.get("plan") or [] if p.get("tank")}
        return {"id": self.s["id"], "invoice_no": self.s["invoice_no"], "tt_no": self.s.get("tt_no"),
                "status": self.s["status"], "released": bool((d.get("auto") or {}).get("released")),
                "tanks": out, "questions": list(self.state["questions"].values()),
                "log": self.state["log"][-30:], "settleMinutes": self.settings["settleMinutes"],
                "left": [c["no"] for c in d["chambers"] if c["product"] and c["litres"] > 0
                         and c["no"] not in set(d.get("done") or []) and c["no"] not in planned],
                "held": self.held(),
                "tankOptions": [{"id": t["id"], "no": t["no"], "product": t["product"]} for t in self.settings["tanks"]]}

    def to_json(self) -> dict:
        return {"session": self.s, "settings": self.settings, "state": self.state}

    @classmethod
    def from_json(cls, data: dict) -> "Decantation":
        return cls(data["session"], data["settings"], data["state"])
