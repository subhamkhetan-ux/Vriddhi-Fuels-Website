"""A phone's "Check stock now" / "Monitor the stock" (decant app), run by the
tank stock service (service.py).

While a decantation is open in the decant app, a phone can ask this server
for its tanks' stock without handing the decantation over ("Let the tank
stock server finish it" does that, auto.py):

- **check**: one capture of those tanks (from the open live session, else a
  connection for it), saved to the app as the page's "Send for decantation"
  does: the full figures and a proof picture;
- **monitor**: live monitoring (the open session, else one started for it)
  sends those tanks' volume to the app as it changes, every 10 s at most,
  until the phone stops it, the decantation is finished or cancelled, or
  MONITOR_MAX_S has passed. If AnyDesk ends the session it connects again.

The phone writes ``data.stockRequest`` = {id, kind, tanks, at, by} on the
decantation; it is looked for every half minute (service.REQUEST_EVERY).
The answer goes into the same object: ``state`` (done | monitoring | ended |
error), ``answeredAt``, ``message``, a check's ``results`` per tank and a
monitor's ``until``.
"""
from __future__ import annotations

import threading
import time
import traceback

from . import decantation as dz
from .capture import CaptureError

QUICK_S = 10                  # seconds: the decant app's answers, at most
REQUEST_FRESH_S = 15 * 60     # a request older than this, never answered: not taken up (as auto.py's)
MONITOR_MAX_S = 3 * 3600      # a phone's monitoring ends after this
MONITOR_EVERY_S = 10          # live reads while a phone monitors, whatever the live setting
RECONNECT_GAP_S = 60          # seconds between tries to connect again for a phone
RECONNECTS = 5                # tries in a row that never gave a read: it ends, and says why
ANSWERS_KEPT = 50


class PhoneStock:
    def __init__(self, station):
        self.st = station
        self.lock = threading.Lock()
        self.watches = {}         # decantation id -> {"req", "tanks" (nos), "until"}
        self.answers = {}         # request id -> the answer written (written again if a phone's save lost it)
        self.live = None          # the live session started for the phones (stopped when they're done)
        self.tries = 0            # connections in a row that gave no read
        self.tried_at = 0.0

    # ---- what live monitoring does for the phones -----------------------------
    def active(self) -> bool:
        return bool(self.watches)

    def watched(self) -> set:
        """The tanks the phones monitor (their volume goes to the app as it changes)."""
        return {no for w in list(self.watches.values()) for no in w["tanks"]}

    def interval(self, interval_s: int) -> int:
        return min(interval_s, MONITOR_EVERY_S) if self.watches else interval_s

    # ---- every half minute -------------------------------------------------------
    def check(self) -> None:
        try:
            reqs = self.st.decant.stock_requests(timeout=QUICK_S)
        except Exception:  # noqa: BLE001 - asked again next time
            return
        with self.lock:
            now = time.time()
            asked = {}
            for r in reqs:
                req = r["request"]
                rid = str(req.get("id") or req.get("at") or "")
                if rid and req.get("kind") in ("check", "monitor"):
                    asked[r["id"]] = (rid, req)
            # a decantation finished, cancelled or stopped on the phone: its watch ends
            for sid in [s for s, w in self.watches.items() if asked.get(s, ("",))[0] != w["req"]]:
                del self.watches[sid]
            for sid, (rid, req) in asked.items():
                try:
                    self._one(sid, rid, req, now)
                except Exception:  # noqa: BLE001 - the others still go
                    traceback.print_exc()
            self._keep_live(now)

    def _one(self, sid: str, rid: str, req: dict, now: float) -> None:
        mine = self.answers.get(rid)
        if mine and req.get("state") != mine["state"]:
            self._answer(sid, rid, mine)               # a phone's save lost the answer: again
            return
        if req["kind"] == "monitor" and req.get("state") == "monitoring":
            until = dz._ts(req.get("until")) or 0
            if now >= until:
                self._end(sid, rid, f"stopped after {MONITOR_MAX_S // 3600} h; ask again to carry on")
            elif sid not in self.watches:              # (the service restarted)
                self._watch(sid, rid, req, until)
            return
        if req.get("state") or now - (dz._ts(req.get("at")) or 0) > REQUEST_FRESH_S:
            return                                     # answered already, or too old to act on
        if req["kind"] == "check":
            self._check(sid, rid, req)
        else:
            until = now + MONITOR_MAX_S
            if self._watch(sid, rid, req, until):
                self._answer(sid, rid, {"state": "monitoring", "until": dz.iso(until),
                                        "message": f"every {MONITOR_EVERY_S} s, for up to {MONITOR_MAX_S // 3600} h"})

    def _nos(self, ids) -> tuple[list, dict]:
        cfg, _ = self.st._settings()
        by_id = {t.get("id"): t.get("no") for t in cfg.get("tanks") or []}
        return sorted({by_id[i] for i in ids or [] if by_id.get(i)}), by_id

    def _check(self, sid: str, rid: str, req: dict) -> None:
        nos, by_id = self._nos(req.get("tanks"))
        if not nos:
            self._answer(sid, rid, {"state": "error", "message": "none of these tanks is in the decant app's settings"})
            return
        try:
            last = self.st.capture(nos, upload=True, why="decant app")
        except Exception as exc:  # noqa: BLE001 - the phone is told why
            msg = str(exc) if isinstance(exc, (CaptureError, RuntimeError, ValueError)) \
                else f"the capture failed ({type(exc).__name__})"
            self._answer(sid, rid, {"state": "error", "message": msg[:300]})
            return
        ids = {no: i for i, no in by_id.items()}
        results = {}
        for no in nos:
            u = (last.get("uploads") or {}).get(str(no)) or {}
            results[ids[no]] = {"ok": bool(u.get("ok")) or u.get("message") == "already in the app",
                                "message": str(u.get("message") or "not read")[:200]}
        self._answer(sid, rid, {"state": "done", "results": results})

    def _watch(self, sid: str, rid: str, req: dict, until: float) -> bool:
        nos, _ = self._nos(req.get("tanks"))
        if not nos:
            self._answer(sid, rid, {"state": "error", "message": "none of these tanks is in the decant app's settings"})
            return False
        self.watches[sid] = {"req": rid, "tanks": set(nos), "until": until}
        live = self.st.live
        if live:
            live["wake"].set()                         # its next read now, with these tanks
        return True

    def _end(self, sid: str, rid: str, why: str) -> None:
        self.watches.pop(sid, None)
        self._answer(sid, rid, {"state": "ended", "message": why})

    # ---- the live session -----------------------------------------------------------
    def _keep_live(self, now: float) -> None:
        live = self.st.live
        if not self.watches:
            if self.live is not None and live is self.live and not self.st.auto.active():
                self.st.stop_live("the decant app's monitoring ended")
            self.live, self.tries = None, 0
            return
        if live:
            if live.get("reads", 0):
                self.tries = 0
            return
        # none open (it ended, or never was): connect, not too often
        if now - self.tried_at < RECONNECT_GAP_S:
            return
        if self.tries >= RECONNECTS:
            why = (self.st.live_last or {}).get("reason") or "it could not connect"
            for sid, w in list(self.watches.items()):
                self._end(sid, w["req"], f"live monitoring ended {RECONNECTS} times without a read ({why}); "
                                         "ask again")
            self.live, self.tries = None, 0
            return
        self.tried_at, self.tries = now, self.tries + 1
        try:
            self.st.start_live(auto=True)              # (the saved settings stay as they are)
        except RuntimeError:
            return                                     # (another one just started: used next time)
        self.live = self.st.live
        if self.live:
            self.live["by_auto"] = False               # not the automatic decantation's

    # ---- the answer, on the phone's decantation -------------------------------------
    def _answer(self, sid: str, rid: str, answer: dict) -> None:
        """Into the request itself; kept, and written again until it is there."""
        self.answers.pop(rid, None)
        self.answers[rid] = answer
        for old in list(self.answers)[:-ANSWERS_KEPT]:
            del self.answers[old]
        try:
            s = self.st.decant.get_session(sid, timeout=QUICK_S)
            req = (s or {}).get("data", {}).get("stockRequest")
            if not isinstance(req, dict) or str(req.get("id") or req.get("at") or "") != rid:
                return                                 # (the phone asked something else since)
            req.update(answer, answeredAt=dz.iso())
            self.st.decant.save_session(s, base=s.get("updated_at"), timeout=QUICK_S)
        except Exception:  # noqa: BLE001 - written again next time
            traceback.print_exc()
