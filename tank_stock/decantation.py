"""An automatic decantation: the decant app's tanker decanting, run by the agent.

You give the plan on the tank stock page (which chamber goes into which
tank) and press Start. The agent then does what a person does in the decant
app's decanting screen (decant/js/wizard.js), going by the tank stock it
reads every few seconds through the open AnyDesk session:

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

# ---- the app's rules (decant/js/core.js) --------------------------------

PRODUCTS = ("MS", "HSD", "XG")
DEFAULT_SETTINGS = {
    "tolerancePct": 0.25, "toleranceMinL": 25, "warnRoomL": 150, "staleMinutes": 30,
    "settleMinutes": 10, "pipeMoveSecs": 45,
    "ownTTs": [{"tt": "OD23U8210", "chambers": [5, 5, 4, 4, 4]}],
}

# How the agent judges the stock (litres / seconds).
START_RISE_L = 30          # above the stock before: decanting has started
ARRIVE_SLACK = (50, 0.02)  # a chamber has arrived within max(50 L, 2 % of it)
STILL_L = 3                # less than this in STOP_SECS: the stock stopped rising
STOP_SECS = 90
SHORT_WAIT_SECS = 300      # stopped short this long (the pipe moving takes less): ask
SETTLE_BAND_L = 5          # steady: within this for the settle time
AFTER_TRIES = 3            # full reads for the stock after before settling for the best


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


def busy_tanks(sessions: list, except_id: str | None = None) -> set:
    """busyTanks: tanks taken by a truck being decanted."""
    busy = set()
    for s in sessions or []:
        if s.get("id") == except_id or s.get("status") not in ("decanting", "settling"):
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

class Decantation:
    """One automatic decantation: the app's session plus what the agent
    follows for each tank. ``feed`` takes the latest stock and returns the
    work to do: {"save": bool, "after": [tank ids to read fully],
    "finish": bool, "events": [lines for the page and Telegram]}."""

    def __init__(self, session: dict, settings: dict, state: dict | None = None):
        self.s = session
        self.settings = settings
        self.state = state or {"tanks": {}, "log": [], "question": None}

    # -- setting it up --
    @classmethod
    def plan(cls, session: dict, plan: list, before: dict, settings: dict, busy: set) -> "Decantation":
        """prepare + "tank by tank": the plan becomes the tanks, waiting."""
        d = session["data"]
        d["plan"] = sorted(({"no": p["no"], "product": p["product"], "litres": p["litres"], "tank": p.get("tank")}
                            for p in plan), key=lambda p: p["no"])
        d["before"] = dict(before)
        chk = check_plan(d["plan"], settings["tanks"], before, busy, settings)
        if chk["blocking"]:
            raise ValueError(chk["blocking"][0])
        d["tanks"] = [{"tank": r["tank"], "tankNo": r["no"], "product": r["product"], "litres": r["litres"],
                       "chambers": r["chambers"], "before": before[r["tank"]], "after": None,
                       "pricePerL": (d.get("prices") or {}).get(r["product"]),
                       "stage": "waiting", "startedAt": None, "doneAt": None} for r in chk["perTank"]]
        d["step"] = "decant"
        d["auto"] = {"by": "tank-stock agent", "arrived": {}}
        sync_status(session)
        run = cls(session, settings)
        for t in d["tanks"]:
            run.state["tanks"][t["tank"]] = {"history": [], "arrived": 0, "lastRiseAt": None, "peak": None,
                                             "stillSince": None, "steadySince": None, "afterTries": 0}
        return run

    # -- what happens --
    def row(self, tank_id: str) -> dict:
        return next(t for t in self.s["data"]["tanks"] if t["tank"] == tank_id)

    def chamber_litres(self, no: int) -> int:
        return next((c["litres"] for c in self.s["data"]["chambers"] if c["no"] == no), 0)

    def log(self, text: str, t: float) -> str:
        self.state["log"] = (self.state["log"] + [{"at": iso(t), "text": text}])[-50:]
        return text

    def feed(self, volumes: dict, now: float | None = None) -> dict:
        """The latest product volume of each tank ({tank id: litres})."""
        now = now or time.time()
        work = {"save": False, "after": [], "finish": False, "events": []}
        for t in self.s["data"]["tanks"]:
            v = volumes.get(t["tank"])
            if v is None or t["stage"] == "read":
                continue
            self._follow(t, float(v), now, work)
        if self.s["data"]["tanks"] and all(t["stage"] == "read" and t.get("after") for t in self.s["data"]["tanks"]):
            work["finish"] = True
        return work

    def _follow(self, t: dict, v: float, now: float, work: dict) -> None:
        st = self.state["tanks"][t["tank"]]
        name = f"Tank {t['tankNo']}"
        st["history"] = [h for h in st["history"] if now - h[0] <= max(STOP_SECS, self.settings["settleMinutes"] * 60) + 60]
        st["history"].append((now, v))
        before = t["before"]["volume"]
        rise = v - before
        st["peak"] = max(st["peak"] if st["peak"] is not None else v, v)
        if st["lastRiseAt"] is None or v > (st.get("lastRiseV") or v) + STILL_L:
            st["lastRiseAt"], st["lastRiseV"] = now, v
        # waiting -> decanting
        if t["stage"] == "waiting":
            if rise >= START_RISE_L:
                t["stage"], t["startedAt"] = "decanting", iso(self._rise_began(st, before, now))
                sync_status(self.s)
                work["save"] = True
                work["events"].append(self.log(f"{name}: decanting started.", now))
            return
        if t["stage"] == "decanting":
            # chambers in, in the plan's order
            got, cum = 0, 0
            for no in t["chambers"]:
                c = self.chamber_litres(no)
                cum += c
                if rise >= cum - max(ARRIVE_SLACK[0], ARRIVE_SLACK[1] * c):
                    got += 1
                else:
                    break
            if got > st["arrived"]:
                for no in t["chambers"][st["arrived"]:got]:
                    work["events"].append(self.log(f"{name}: chamber {no} is in ({rise:,.0f} L so far).", now))
                st["arrived"] = got
                self.s["data"]["auto"]["arrived"][t["tank"]] = t["chambers"][:got]
                work["save"] = True
            if self.state.get("question", {}) and self.state["question"].get("tank") == t["tank"] \
                    and now - st["lastRiseAt"] < STOP_SECS:
                self.state["question"] = None             # rising again: the pipe went on
                work["events"].append(self.log(f"{name}: rising again.", now))
            stopped = now - st["lastRiseAt"] >= STOP_SECS
            tol = max(self.settings["toleranceMinL"], t["litres"] * self.settings["tolerancePct"] / 100)
            if stopped and st["arrived"] == len(t["chambers"]) and rise >= t["litres"] - 2 * tol - \
                    max(ARRIVE_SLACK[0], ARRIVE_SLACK[1] * self.chamber_litres(t["chambers"][-1])):
                self._done(t, st, t["chambers"], now, work)
            elif stopped and now - st["lastRiseAt"] >= SHORT_WAIT_SECS and not self.state.get("question"):
                self.state["question"] = {"tank": t["tank"], "since": iso(now), "rise": round2(rise),
                                          "arrived": t["chambers"][:st["arrived"]], "chambers": t["chambers"],
                                          "planned": t["litres"]}
                work["save"] = True
                work["events"].append(self.log(
                    f"{name}: the stock stopped rising at +{rise:,.0f} L of {t['litres']:,.0f} L planned. "
                    "Which chambers were emptied? (answer on the tank stock page)", now))
            return
        if t["stage"] == "settling":
            window = [h for h in st["history"] if now - h[0] <= self.settings["settleMinutes"] * 60]
            spread = max(x for _, x in window) - min(x for _, x in window)
            if spread > SETTLE_BAND_L:
                st["steadySince"] = None
            elif st["steadySince"] is None:
                st["steadySince"] = now
            covered = window and now - window[0][0] >= self.settings["settleMinutes"] * 60 - 15
            if st["steadySince"] is not None and covered and now - st["steadySince"] >= 0 \
                    and now - (self._ts(t["doneAt"]) or now) >= self.settings["settleMinutes"] * 60:
                work["after"].append(t["tank"])

    def _rise_began(self, st, before, now) -> float:
        """When the rise started: the last reading still at the stock before."""
        at = now
        for when, v in reversed(st["history"]):
            if v - before < START_RISE_L / 3:
                break
            at = when
        return at

    @staticmethod
    def _ts(value) -> float | None:
        try:
            return datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp()
        except ValueError:
            return None

    def _done(self, t: dict, st: dict, chambers: list, now: float, work: dict) -> None:
        """doneTanks: these chambers were emptied; the rest stay in the truck."""
        d = self.s["data"]
        keep = set(chambers)
        for p in d["plan"]:
            if p.get("tank") == t["tank"] and p["no"] not in keep:
                p["tank"] = None
        t["chambers"] = [no for no in t["chambers"] if no in keep]
        t["litres"] = sum(self.chamber_litres(no) for no in t["chambers"])
        t["stage"] = "settling"
        t["doneAt"] = iso(st["lastRiseAt"] or now)
        if not t["chambers"]:
            d["tanks"] = [x for x in d["tanks"] if x is not t]
        sync_status(self.s)
        work["save"] = True
        work["events"].append(self.log(
            f"Tank {t['tankNo']}: decanting done (chamber {', '.join(map(str, t['chambers'])) or 'none'}); "
            f"settling for {self.settings['settleMinutes']:g} min.", now))

    def answer(self, tank_id: str, chambers: list | None, now: float | None = None) -> dict:
        """The page's answer to "which chambers were emptied?" (None: still decanting)."""
        now = now or time.time()
        work = {"save": True, "after": [], "finish": False, "events": []}
        q = self.state.get("question")
        if not q or q["tank"] != tank_id:
            raise ValueError("There is no question about that tank.")
        self.state["question"] = None
        t, st = self.row(tank_id), self.state["tanks"][tank_id]
        if chambers is None:
            st["lastRiseAt"] = now                        # wait again
            work["events"].append(self.log(f"Tank {t['tankNo']}: still decanting, waiting on.", now))
            return work
        chambers = [no for no in t["chambers"] if no in set(chambers)]
        if not chambers:
            raise ValueError("Tick at least one chamber (use Cancel if nothing was decanted).")
        self._done(t, st, chambers, now, work)
        return work

    def read_after(self, tank_id: str, reading: dict | None, now: float | None = None) -> dict:
        """setReading('after'): the stock after, from a full read."""
        now = now or time.time()
        work = {"save": False, "after": [], "finish": False, "events": []}
        t, st = self.row(tank_id), self.state["tanks"][tank_id]
        st["afterTries"] += 1
        if not reading or (reading.get("confidence") == "low" and st["afterTries"] < AFTER_TRIES):
            return work                                    # try again on the next read
        t["after"] = reading
        t["stage"] = "read"
        sync_status(self.s)
        work["save"] = True
        work["events"].append(self.log(f"Tank {t['tankNo']}: stock after {reading['volume']:,.2f} L.", now))
        if all(x["stage"] == "read" and x.get("after") for x in self.s["data"]["tanks"]):
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
        lines = []
        for t in d["tanks"]:
            r = t["result"] or {}
            lines.append(f"Tank {t['tankNo']}: {t['litres']:,.0f} L decanted, gained {r.get('gain', 0):,.2f} L, "
                         f"variation {r.get('variation', 0):+,.2f} L ({r.get('band')})")
        self.log("Finished and saved in the decant app. " + "; ".join(lines), now)
        return lines

    def cancel(self, now: float | None = None) -> None:
        """cancelSession: only while nothing is decanted."""
        if any(t.get("startedAt") for t in self.s["data"]["tanks"]):
            raise ValueError("A tank has started: finish it, or leave it to the decant app.")
        now = now or time.time()
        self.s["status"] = "cancelled"
        self.s["completed_at"] = iso(now)
        self.s["data"]["cancelReason"] = "Cancelled before decanting."
        for p in self.s["data"]["plan"]:
            p["tank"] = None

    def view(self) -> dict:
        d = self.s["data"]
        out = []
        for t in d["tanks"]:
            st = self.state["tanks"].get(t["tank"], {})
            last = st.get("history", [])[-1][1] if st.get("history") else None
            steady = None
            if t["stage"] == "settling" and st.get("steadySince"):
                steady = round(time.time() - st["steadySince"])
            out.append({"tank": t["tank"], "no": t["tankNo"], "product": t["product"], "stage": t["stage"],
                        "chambers": t["chambers"], "arrived": t["chambers"][:st.get("arrived", 0)],
                        "litres": t["litres"], "before": t["before"]["volume"], "now": last,
                        "rise": round2(last - t["before"]["volume"]) if last is not None else None,
                        "after": (t.get("after") or {}).get("volume"), "result": t.get("result"),
                        "startedAt": t.get("startedAt"), "doneAt": t.get("doneAt"), "steadyFor": steady})
        return {"id": self.s["id"], "invoice_no": self.s["invoice_no"], "tt_no": self.s.get("tt_no"),
                "status": self.s["status"], "tanks": out, "question": self.state.get("question"),
                "log": self.state["log"][-20:], "settleMinutes": self.settings["settleMinutes"],
                "left": [c["no"] for c in d["chambers"] if c["product"] and c["litres"] > 0
                         and c["no"] not in set(d.get("done") or [])
                         and not any(c["no"] in t["chambers"] for t in d["tanks"])]}

    def to_json(self) -> dict:
        return {"session": self.s, "settings": self.settings, "state": self.state}

    @classmethod
    def from_json(cls, data: dict) -> "Decantation":
        state = data["state"]
        for st in state["tanks"].values():
            st["history"] = [tuple(h) for h in st.get("history", [])]
        return cls(data["session"], data["settings"], state)
