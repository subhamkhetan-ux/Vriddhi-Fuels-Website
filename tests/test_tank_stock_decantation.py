"""The automatic decantation engine (tank_stock/decantation.py), fed made-up
stock every 10 s as live monitoring reads it: chambers found from the rise,
questions when the stock says something else happened, settling, the stock
after and the finish."""
import json

import pytest

from tank_stock import decant
from tank_stock import decantation as dz

T0 = 1_791_000_000.0
INVOICE = {
    "invoice_no": "7011294526", "invoice_date": "13/10/2026", "invoice_time": "14:15", "tt_no": "OD23U8210",
    "lines": [
        {"product": "EBMS [PDRP]", "column_key": "MS | EBMS", "qty_kl": 5, "compartments": [1], "density15": 748.2, "value": 524764},
        {"product": "HSD-BSVI [PDRP]", "column_key": "HSD", "qty_kl": 17, "compartments": [2, 3, 4, 5], "density15": 829.3, "value": 1668487},
    ],
    "chambers": [{"no": 1, "qty_kl": 5}, {"no": 2, "qty_kl": 5}, {"no": 3, "qty_kl": 4}, {"no": 4, "qty_kl": 4}, {"no": 5, "qty_kl": 4}],
}
BEFORE = {"T1": 7682.0, "T2": 10755.0, "T3": 11495.0, "T4": 2560.0}
SETTINGS = dz.settings_with({}, decant.DEFAULT_TANKS)


def reading(volume, at=T0):
    return {"volume": volume, "ullage": 20000 - volume, "capacity": 20000, "readingAt": dz.iso(at),
            "confidence": "high", "source": "photo", "via": "server"}


def start(plan):
    """plan: {chamber: tank id}."""
    layout = dz.layout_for(INVOICE, SETTINGS)
    s = dz.new_session(INVOICE, layout, [])
    rows = [{"no": c["no"], "product": c["product"], "litres": c["litres"], "tank": plan.get(c["no"])} for c in layout["chambers"]]
    used = {plan[no] for no in plan}
    return dz.Decantation.plan(s, rows, {t: reading(BEFORE[t]) for t in used}, SETTINGS, set(), now=T0)


class Truck:
    """What each tank's stock does: runs of flow [(tank, start s, litres, secs)],
    sales [(tank, at s, litres)] and one-off misreads {(tank, at s): volume}."""

    def __init__(self, flows, sales=(), misreads=None):
        self.flows, self.sales, self.misreads = flows, sales, misreads or {}

    def volume(self, tank, secs):
        v = BEFORE[tank]
        for t, at, litres, dur in self.flows:
            if t == tank:
                v += litres * min(1.0, max(0.0, (secs - at) / dur))
        v -= sum(l for t, at, l in self.sales if t == tank and secs >= at)
        return round(self.misreads.get((tank, secs), v), 2)


def run_for(run, truck, until, answers=None, step=10, after_ok=True, watch=("T1", "T2", "T3", "T4")):
    """Feed every `step` s up to `until` s; do what the work says. answers:
    {question kind: callable(run, q) -> chambers | None | 'drop'}."""
    events, asked, afters = [], [], []
    secs = 0
    while secs <= until:
        now = T0 + secs
        work = run.feed({t: truck.volume(t, secs) for t in watch}, now)
        events += work["events"]
        for b in work["before"]:
            events += run.set_before(b["tank"], reading(truck.volume(b["tank"], secs), now), now)["events"]
        for a in work["after"]:
            v = a.get("volume", truck.volume(a["tank"], secs))
            got = run.read_after(a["tank"], reading(v, now) if after_ok else None,
                                 fallback=reading(v, now), now=now)
            afters.append((a, secs))
            events += got["events"]
            work["finish"] = work["finish"] or got["finish"]
        for q in list(run.state["questions"].values()):
            if answers and q["kind"] in answers and q["tank"] not in [x["tank"] for x in asked]:
                asked.append(q)
                ans = answers[q["kind"]](run, q)
                events += run.answer(q["tank"], ans, now)["events"]
        if work["finish"] or run._all_read():
            run.finish(now)
            break
        if run.s["status"] in ("done", "cancelled"):
            break
        secs += step
    return {"events": [e["text"] for e in events], "asked": asked, "afters": afters, "secs": secs}


def row(run, tank):
    return run.row(tank)


def test_two_tanks_follow_the_stock_to_the_finish():
    run = start({1: "T1", 2: "T2", 3: "T2"})
    assert run.s["status"] == "draft" and run.s["data"]["step"] == "decant"
    assert [t["stage"] for t in run.s["data"]["tanks"]] == ["waiting", "waiting"]
    # T1: C1 from 60 s for 495 s; T2: C2 from 100 s (495 s), the pipe moved (45 s), C3 (420 s)
    truck = Truck([("T1", 60, 4990, 495), ("T2", 100, 4985, 495), ("T2", 640, 3992, 420)])
    out = run_for(run, truck, 4000)
    d = run.s["data"]
    assert run.s["status"] == "done", out["events"]
    t1, t2 = row(run, "T1"), row(run, "T2")
    assert t2["chambers"] == [2, 3] and t1["chambers"] == [1]
    assert any("chamber 2 is in" in e for e in out["events"]) and any("chamber 3 is in" in e for e in out["events"])
    # it started when the stock began to rise, done when it stopped
    assert abs(dz._ts(t2["startedAt"]) - (T0 + 100)) <= 10
    assert abs(dz._ts(t2["doneAt"]) - (T0 + 1060)) <= 10
    # the after reading came once steady for the settle time (10 min)
    after_at = [s for a, s in out["afters"] if a["tank"] == "T2"][0]
    assert 1060 + 600 <= after_at <= 1060 + 600 + 30
    assert t2["result"]["gain"] == 8977.0 and t2["result"]["variation"] == -23.0 and t2["result"]["band"] == "ok"
    assert t1["result"]["variation"] == -10.0
    assert d["completedAt"] and run.s["completed_at"] and d["auto"]["arrived"]["T2"] == [2, 3]
    assert not out["asked"]


def test_chambers_emptied_out_of_the_plans_order_are_put_in_the_pipes_order():
    run = start({2: "T2", 3: "T2"})
    truck = Truck([("T2", 50, 3995, 420), ("T2", 520, 4990, 495)])      # C3 first, then C2
    out = run_for(run, truck, 1100)
    assert row(run, "T2")["chambers"] == [3, 2]                          # as the decant app shows the pipe
    assert out["events"].index(next(e for e in out["events"] if "chamber 3 is in" in e)) < \
        out["events"].index(next(e for e in out["events"] if "chamber 2 is in" in e))


def test_a_tank_stopped_short_asks_which_chambers_and_the_rest_stays_in_the_truck():
    run = start({2: "T2", 3: "T2"})
    truck = Truck([("T2", 50, 4990, 495)])                                 # C3 never comes
    out = run_for(run, truck, 5000, answers={"short": lambda r, q: q["suggest"]})
    q = out["asked"][0]
    assert q["kind"] == "short" and q["suggest"] == [2] and "stopped rising at +4,990 L of 9,000 L" in q["text"]
    t2 = row(run, "T2")
    assert t2["chambers"] == [2] and t2["litres"] == 5000
    assert next(p for p in run.s["data"]["plan"] if p["no"] == 3)["tank"] is None      # C3 back on the list
    assert run.s["status"] == "done" and t2["result"]["variation"] == -10.0


def test_waiting_on_after_a_question_and_rising_again_withdraws_it():
    run = start({2: "T2", 3: "T2"})
    # C2, then a long break (8 min), then C3
    truck = Truck([("T2", 50, 4990, 495), ("T2", 1025, 3990, 420)])
    out = run_for(run, truck, 3000)
    assert any("Which chambers were emptied" in e for e in out["events"])
    assert any("rising again, so the question is withdrawn" in e for e in out["events"])
    assert row(run, "T2")["chambers"] == [2, 3] and run.s["status"] == "done"


def test_a_chamber_planned_for_another_tank_that_went_into_this_one_is_moved_over():
    run = start({2: "T2", 3: "T2", 4: "T3", 5: "T3"})
    # C2, C3 and C4 into T2 (by mistake); only C5 into T3
    truck = Truck([("T2", 50, 4990, 495), ("T2", 590, 3992, 420), ("T2", 1055, 3990, 420),
                   ("T3", 60, 3993, 420)])
    out = run_for(run, truck, 6000, answers={"extra": lambda r, q: q["suggest"]})
    q = out["asked"][0]
    # C4 and C5 hold the same 4 KL: the stock can't tell which went where, so
    # it suggests the one T3 hasn't had (you confirm or change it)
    assert q["kind"] == "extra" and q["tank"] == "T2" and sorted(q["suggest"])[:2] == [2, 3]
    moved = sorted(q["suggest"])[2]
    assert moved in (4, 5) and {o["no"]: o["from"] for o in q["options"]}[moved] == "T3"
    assert sorted(row(run, "T2")["chambers"]) == [2, 3, moved] and row(run, "T3")["chambers"] == [9 - moved]
    assert next(p for p in run.s["data"]["plan"] if p["no"] == moved)["tank"] == "T2"
    assert run.s["status"] == "done"
    assert all(t["result"]["band"] == "ok" for t in run.s["data"]["tanks"])


def test_a_misread_is_ignored_and_a_real_jump_counts_once_seen_twice():
    run = start({2: "T2"})
    truck = Truck([], misreads={("T2", 30): 12755.0})                       # +2,000 L in 10 s, once
    run_for(run, truck, 200)
    assert row(run, "T2")["stage"] == "waiting"
    run2 = start({2: "T2"})
    run_for(run2, Truck([("T2", 30, 4990, 1)]), 100)                        # (made up) instant 5 KL, seen again: real
    assert row(run2, "T2")["stage"] != "waiting"


def test_a_tank_that_sells_before_it_starts_is_read_again_and_the_rise_counts_from_its_lowest():
    run = start({2: "T2"})
    truck = Truck([("T2", 300, 4990, 495)], sales=[("T2", 100, 25), ("T2", 200, 15)])
    out = run_for(run, truck, 2000)
    # the full re-read (set_before) gave the stock after each sale
    assert any("stock before read again: 10,730.00 L" in e for e in out["events"])
    t2 = row(run, "T2")
    assert t2["before"]["volume"] == 10715.0
    assert t2["result"]["gain"] == 4990.0 and t2["result"]["variation"] == -10.0


def test_without_a_fresh_full_read_the_stock_before_is_the_live_figure_just_before_the_rise():
    run = start({2: "T2"})
    run.set_before = lambda *a, **k: dz._work()                               # the full read failed
    truck = Truck([("T2", 300, 4990, 495)], sales=[("T2", 100, 40)])
    out = run_for(run, truck, 2000)
    t2 = row(run, "T2")
    assert t2["before"]["volume"] == 10715.0 and t2["before"]["timeRead"] is False
    assert any("it sold 40 L after its stock was read" in e for e in out["events"])
    assert t2["result"]["variation"] == -10.0


def test_when_sales_come_back_while_settling_the_stock_after_is_from_before_the_fall():
    run = start({2: "T2"})
    truck = Truck([("T2", 50, 4990, 495)], sales=[("T2", 900, 30)])
    out = run_for(run, truck, 3000)
    a = [a for a, _ in out["afters"]][0]
    assert a["from"] == "peak" and a["volume"] == 15745.0
    assert row(run, "T2")["after"]["volume"] == 15745.0
    assert any("so it sells again" in e for e in out["events"])


def test_a_tank_that_never_starts_is_asked_about_and_left_out():
    run = start({2: "T2", 4: "T3"})
    truck = Truck([("T2", 50, 4990, 495)])
    out = run_for(run, truck, 4000, answers={"notstarted": lambda r, q: "drop"})
    assert out["asked"][0]["kind"] == "notstarted" and out["asked"][0]["tank"] == "T3"
    assert [t["tank"] for t in run.s["data"]["tanks"]] == ["T2"]
    assert next(p for p in run.s["data"]["plan"] if p["no"] == 4)["tank"] is None
    assert run.s["status"] == "done"


def test_nothing_decanted_at_all_cancels_it():
    run = start({4: "T3"})
    out = run_for(run, Truck([]), 2400, answers={"notstarted": lambda r, q: "drop"})
    assert run.s["status"] == "cancelled" and run.s["data"]["cancelReason"] == "Nothing was decanted."
    assert any("Nothing was decanted" in e for e in out["events"])


def test_a_tank_outside_the_plan_rising_is_a_warning():
    run = start({2: "T2"})
    truck = Truck([("T2", 50, 4990, 495), ("T4", 100, 300, 60)])
    out = run_for(run, truck, 400)
    assert any("Tank 4 is rising" in e and "isn't in this decantation" in e for e in out["events"])


def test_a_pause_in_the_middle_of_a_chamber_is_not_taken_for_a_chamber():
    run = start({2: "T2", 3: "T2"})
    # C2 in two halves with a 60 s stop, then C3
    truck = Truck([("T2", 50, 2500, 250), ("T2", 360, 2490, 250), ("T2", 655, 3992, 420)])
    out = run_for(run, truck, 2600)
    ins = [e for e in out["events"] if " is in " in e]
    assert len(ins) == 2 and "chamber 2 is in" in ins[0] and "chamber 3 is in" in ins[1]
    assert run.s["status"] == "done"


def test_a_failing_full_read_after_settling_falls_back_to_the_live_figure():
    run = start({2: "T2"})
    out = run_for(run, Truck([("T2", 50, 4990, 495)]), 3000, after_ok=False)
    tries = [s for a, s in out["afters"] if a["tank"] == "T2"]
    assert len(tries) == dz.AFTER_TRIES
    after = row(run, "T2")["after"]
    assert after["volume"] == 15745.0 and "live figure" in after["note"]
    assert run.s["status"] == "done"


def test_a_phone_marking_a_tank_done_is_taken_over_and_the_run_carries_on():
    run = start({2: "T2", 3: "T2"})
    truck = Truck([("T2", 50, 4990, 495)])
    run_for(run, truck, 700)
    remote = json.loads(json.dumps(run.s))
    t = next(t for t in remote["data"]["tanks"] if t["tank"] == "T2")
    t.update(stage="settling", doneAt=dz.iso(T0 + 560), chambers=[2], litres=5000)
    remote["status"] = "settling"
    run.adopt(remote, T0 + 710)
    assert row(run, "T2")["stage"] == "settling"
    secs = 720
    while run.s["status"] != "done" and secs < 3000:
        work = run.feed({"T2": truck.volume("T2", secs)}, T0 + secs)
        for a in work["after"]:
            work = run.read_after("T2", reading(truck.volume("T2", secs), T0 + secs), now=T0 + secs)
        if work["finish"]:
            run.finish(T0 + secs)
        secs += 10
    assert run.s["status"] == "done" and row(run, "T2")["result"]["variation"] == -10.0


def test_the_run_survives_a_restart_mid_way():
    run = start({2: "T2", 3: "T2"})
    truck = Truck([("T2", 50, 4990, 495), ("T2", 590, 3992, 420)])
    run_for(run, truck, 600)
    again = dz.Decantation.from_json(json.loads(json.dumps(run.to_json())))
    secs = 610
    while again.s["status"] != "done" and secs < 4000:
        work = again.feed({"T2": truck.volume("T2", secs)}, T0 + secs)
        for a in work["after"]:
            work = again.read_after("T2", reading(truck.volume("T2", secs), T0 + secs), now=T0 + secs)
        if work["finish"]:
            again.finish(T0 + secs)
        secs += 10
    assert again.s["status"] == "done" and row(again, "T2")["chambers"] == [2, 3]


def test_the_page_can_end_a_tank_take_its_stock_after_now_drop_cancel_or_hand_over():
    run = start({2: "T2", 4: "T3"})
    with pytest.raises(ValueError):
        run.done_now("T2", [2])                                              # not decanting yet
    run.drop("T3")
    assert [t["tank"] for t in run.s["data"]["tanks"]] == ["T2"]
    run.cancel()
    assert run.s["status"] == "cancelled" and not run.active()
    run2 = start({2: "T2", 3: "T2"})
    run_for(run2, Truck([("T2", 50, 4990, 495)]), 600)
    with pytest.raises(ValueError):
        run2.cancel()                                                        # it has started
    run2.done_now("T2", [2])
    assert row(run2, "T2")["stage"] == "settling"
    assert run2.after_now("T2")["after"][0]["tank"] == "T2"
    run2.release()
    assert not run2.active() and run2.s["data"]["auto"]["released"]
    assert run2.feed({"T2": 15745.0})["events"] == []


def test_the_suggestion_is_the_chambers_closest_to_the_rise():
    opts = [(2, 5000), (3, 4000), (4, 4000), (5, 4000)]
    assert dz.best_subset(opts, 9000, prefer={2, 3}) == [2, 3]
    assert dz.best_subset(opts, 8010, prefer={4, 5}) == [4, 5]
    assert dz.best_subset(opts, 4990) == [2]


def test_two_hoses_into_one_tank_at_once_are_two_chambers():
    run = start({2: "T2", 3: "T2"})
    truck = Truck([("T2", 50, 4990, 495), ("T2", 60, 3990, 420)])
    out = run_for(run, truck, 1500)
    assert any("chamber 2 + 3 is in" in e or "chamber 3 + 2 is in" in e for e in out["events"])
    assert sorted(row(run, "T2")["chambers"]) == [2, 3] and run.s["status"] == "done"


def test_a_gap_in_the_readings_while_it_flows_loses_nothing():
    run = start({2: "T2", 3: "T2"})
    truck = Truck([("T2", 50, 4990, 495), ("T2", 590, 3992, 420)])
    secs = 0
    while secs <= 3000:
        if not 300 <= secs < 420:                                           # AnyDesk reconnecting: no readings
            work = run.feed({"T2": truck.volume("T2", secs)}, T0 + secs)
            for a in work["after"]:
                work = run.read_after("T2", reading(truck.volume("T2", secs), T0 + secs), now=T0 + secs)
            if work["finish"]:
                run.finish(T0 + secs)
                break
        secs += 10
    assert run.s["status"] == "done" and row(run, "T2")["chambers"] == [2, 3]
    assert not run.state["questions"]


def test_reading_every_5_seconds_gives_the_same_result():
    run = start({1: "T1", 2: "T2", 3: "T2"})
    truck = Truck([("T1", 60, 4990, 495), ("T2", 100, 4985, 495), ("T2", 640, 3992, 420)])
    out = run_for(run, truck, 4000, step=5)
    assert run.s["status"] == "done" and not out["asked"]
    t2 = row(run, "T2")
    assert t2["chambers"] == [2, 3] and t2["result"]["variation"] == -23.0
    assert sum(" is in " in e for e in out["events"]) == 3


def test_a_draft_the_agent_runs_or_set_up_tank_by_tank_holds_its_tanks():
    t = [{"tank": "T2", "stage": "waiting"}]
    agent = {"id": "A", "status": "draft", "data": {"tanks": t, "auto": {"by": "tank stock agent", "released": False}}}
    stepwise = {"id": "B", "status": "draft", "data": {"tanks": [{"tank": "T3", "stage": "waiting"}], "step": "decant"}}
    planning = {"id": "C", "status": "draft", "data": {"tanks": [{"tank": "T4", "stage": "waiting"}], "step": "plan"}}
    handed = {"id": "D", "status": "draft", "data": {"tanks": [{"tank": "T1", "stage": "waiting"}],
                                                     "auto": {"released": True}}}
    assert dz.busy_tanks([agent, stepwise, planning, handed]) == {"T2", "T3"}
    assert dz.busy_tanks([agent], except_id="A") == set()
