"""A phone's "Check stock now" / "Monitor the stock" on the decant app's home
page, run by the tank stock service (service.py). (During a decantation,
"Let the tank stock server finish it" does more: auto.py.)

- **check**: what the page's Capture followed by "Send for decantation"
  does: one capture of the tanks (from the open live session, else a
  connection for it), each tank's full figures saved as its latest stock,
  and its zoomed card uploaded as the proof picture a result picture shows
  (dec_shots). Your live monitoring, if it is on, stays on;
- **monitor**: live monitoring (the open session, else one started for it)
  sends the tanks' volume to the app as it changes, every 10 s at most,
  until the phone stops it or MONITOR_MAX_S has passed. If AnyDesk ends the
  session it connects again.

The phone writes ``stockRequest`` = {id, kind, tanks, at, by} into the app's
shared settings (``dec_config.data``); it is looked for every half minute
(service.REQUEST_EVERY). The answer goes into the same object: ``state``
(done | monitoring | ended | error), ``answeredAt``, ``message``; a check's
``results`` per tank and whether the proof pictures were uploaded
(``picture``, ``pictureError``); a monitor's ``until``.
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
        self.watch = None         # {"req", "tanks" (nos), "until"} while a phone monitors
        self.answers = {}         # request id -> the answer written (written again until it is there)
        self.live = None          # the live session started for the phone (stopped when it's done)
        self.tries = 0            # connections in a row that gave no read
        self.tried_at = 0.0

    # ---- what live monitoring does for the phone ------------------------------
    def active(self) -> bool:
        return self.watch is not None

    def watched(self) -> set:
        """The tanks the phone monitors (their volume goes to the app as it changes)."""
        w = self.watch
        return set(w["tanks"]) if w else set()

    def interval(self, interval_s: int) -> int:
        return min(interval_s, MONITOR_EVERY_S) if self.watch else interval_s

    # ---- every half minute -------------------------------------------------------
    def check(self) -> None:
        try:
            req = self.st.decant.stock_request(timeout=QUICK_S)
        except Exception:  # noqa: BLE001 - asked again next time
            return
        with self.lock:
            now = time.time()
            rid = str((req or {}).get("id") or (req or {}).get("at") or "")
            if not rid or req.get("kind") not in ("check", "monitor"):
                req = None
            if self.watch and (not req or rid != self.watch["req"]):
                self.watch = None                      # stopped on the phone, or something else asked
            if req:
                try:
                    self._one(rid, req, now)
                except Exception:  # noqa: BLE001 - asked again next time
                    traceback.print_exc()
            self._keep_live(now)

    def _one(self, rid: str, req: dict, now: float) -> None:
        mine = self.answers.get(rid)
        if mine and req.get("state") != mine["state"]:
            self._answer(rid, mine)                    # a phone's save lost the answer: again
            return
        if req["kind"] == "monitor" and req.get("state") == "monitoring":
            until = dz._ts(req.get("until")) or 0
            if now >= until:
                self._end(rid, f"stopped after {MONITOR_MAX_S // 3600} h; ask again to carry on")
            elif not self.watch:                       # (the service restarted)
                self._watch(rid, req, until)
            return
        if req.get("state") or now - (dz._ts(req.get("at")) or 0) > REQUEST_FRESH_S:
            return                                     # answered already, or too old to act on
        if req["kind"] == "check":
            self._check(rid, req)
        else:
            until = now + MONITOR_MAX_S
            if self._watch(rid, req, until):
                self._answer(rid, {"state": "monitoring", "until": dz.iso(until),
                                   "message": f"every {MONITOR_EVERY_S} s, for up to {MONITOR_MAX_S // 3600} h"})

    def _nos(self, ids) -> tuple[list, dict]:
        """The tank numbers of these tank ids (every tank if none are named)."""
        cfg, _ = self.st._settings()
        by_id = {t.get("id"): t.get("no") for t in cfg.get("tanks") or []}
        return sorted({by_id[i] for i in (ids or list(by_id)) if by_id.get(i)}), by_id

    def _check(self, rid: str, req: dict) -> None:
        nos, by_id = self._nos(req.get("tanks"))
        if not nos:
            self._answer(rid, {"state": "error", "message": "none of these tanks is in the decant app's settings"})
            return
        try:
            last = self.st.capture(nos, upload=True, why="decant app")
        except Exception as exc:  # noqa: BLE001 - the phone is told why
            msg = str(exc) if isinstance(exc, (CaptureError, RuntimeError, ValueError)) \
                else f"the capture failed ({type(exc).__name__})"
            self._answer(rid, {"state": "error", "message": msg[:300]})
            return
        ids = {no: i for i, no in by_id.items()}
        results = {}
        for no in nos:
            u = (last.get("uploads") or {}).get(str(no)) or {}
            results[ids[no]] = {"ok": bool(u.get("ok")) or u.get("message") == "already in the app",
                                "message": str(u.get("message") or "not read")[:200]}
        answer = {"state": "done", "results": results}
        proof = last.get("proof")                      # (none: no tank was saved, so no picture either)
        if proof:
            answer["picture"] = bool(proof.get("ok"))
            if not proof.get("ok"):
                answer["pictureError"] = str(proof.get("message") or "not uploaded")[:200]
        self._answer(rid, answer)

    def _watch(self, rid: str, req: dict, until: float) -> bool:
        nos, _ = self._nos(req.get("tanks"))
        if not nos:
            self._answer(rid, {"state": "error", "message": "none of these tanks is in the decant app's settings"})
            return False
        self.watch = {"req": rid, "tanks": set(nos), "until": until}
        live = self.st.live
        if live:
            live["wake"].set()                         # its next read now, with these tanks
        return True

    def _end(self, rid: str, why: str) -> None:
        self.watch = None
        self._answer(rid, {"state": "ended", "message": why})

    # ---- the live session -----------------------------------------------------------
    def _keep_live(self, now: float) -> None:
        live = self.st.live
        if not self.watch:
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
            self._end(self.watch["req"], f"live monitoring ended {RECONNECTS} times without a read ({why}); ask again")
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

    # ---- the answer, in the app's shared settings ------------------------------------
    def _answer(self, rid: str, answer: dict) -> None:
        """Into the request itself; kept, and written again until it is there."""
        self.answers.pop(rid, None)
        self.answers[rid] = answer
        for old in list(self.answers)[:-ANSWERS_KEPT]:
            del self.answers[old]
        try:
            self.st.decant.answer_stock_request(rid, answer, timeout=QUICK_S)
        except Exception:  # noqa: BLE001 - written again next time
            traceback.print_exc()
