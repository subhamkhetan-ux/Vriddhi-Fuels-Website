"""The decant app's Monitor page, run by the tank stock service (service.py):
the same controls as this server's own page, for the tanks picked there.
(During a decantation, "Let the tank stock server finish it" does more: auto.py.)

One-off jobs (``stockRequest``):
- **check** ("Send for decantation"): one capture of those tanks (from the
  open live session, else a connection for it), each tank's full figures
  saved as its latest stock and its zoomed card uploaded as the proof
  picture a result picture shows (dec_shots). Your live monitoring, if it
  is on, stays on;
- **capture** ("Capture only"): the same read, nothing saved;
- **upload** ("Upload these to decant"): that capture's readings saved,
  with their proof pictures, as the page's Upload does; only while it is
  still the server's last capture.
Both reads also upload the zoomed cards of those tanks as one picture for
the Monitor page to show (dec_shots, no readings, so no result picture
uses it; deleted the next day as the others).

Live monitoring (``stockMonitor``, kept apart so a capture never stops it):
- **monitor**: live monitoring (the open session, else one started for it)
  sends those tanks' volume to the app as it changes, every ``every``
  seconds (5-3600, 10 by default) at most, until the phone stops it or
  MONITOR_MAX_S has passed. If AnyDesk ends the session it connects again.

The phone writes each into the app's shared settings (``dec_config.data``)
as {id, kind, tanks, at, by, ...}; they are looked for every half minute
(service.REQUEST_EVERY). The answer goes into the same object: ``state``
(done | monitoring | ended | error), ``answeredAt``, ``message``; a read's
``capturedAt``, ``figures`` and ``image`` (its picture); a save's
``results`` per tank and whether the proof pictures went up (``picture``,
``pictureError``); a monitor's ``until``.
"""
from __future__ import annotations

import threading
import time
import traceback

from . import cards as cards_mod
from . import decantation as dz
from .capture import CaptureError

QUICK_S = 10                  # seconds: the decant app's answers, at most
REQUEST_FRESH_S = 15 * 60     # a request older than this, never answered: not taken up (as auto.py's)
MONITOR_MAX_S = 3 * 3600      # a phone's monitoring ends after this
MONITOR_EVERY_S = 10          # live reads while a phone monitors, unless it asks for another interval
EVERY = (5, 3600)             # the intervals a phone may ask for (as the page's)
RECONNECT_GAP_S = 60          # seconds between tries to connect again for a phone
RECONNECTS = 5                # tries in a row that never gave a read: it ends, and says why
ANSWERS_KEPT = 50
ONCE, LIVE = "stockRequest", "stockMonitor"
KINDS = {ONCE: ("check", "capture", "upload"), LIVE: ("monitor",)}
FIGURES = ("volume", "ullage", "height", "dip", "water", "density", "densityTc", "temp", "readingAt")


class PhoneStock:
    def __init__(self, station):
        self.st = station
        self.lock = threading.Lock()
        self.watch = None         # {"req", "tanks" (nos), "until", "every"} while a phone monitors
        self.answers = {}         # request id -> (slot, the answer written): written again until it is there
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
        w = self.watch
        return min(interval_s, w["every"]) if w else interval_s

    # ---- every half minute -------------------------------------------------------
    def check(self) -> None:
        try:
            reqs = self.st.decant.stock_requests(timeout=QUICK_S)
        except Exception:  # noqa: BLE001 - asked again next time
            return
        with self.lock:
            now = time.time()
            asked = {}
            for slot, req in reqs.items():
                rid = str((req or {}).get("id") or (req or {}).get("at") or "")
                if rid and req.get("kind") in KINDS.get(slot, ()):
                    asked[slot] = (rid, req)
            if self.watch and asked.get(LIVE, ("",))[0] != self.watch["req"]:
                self.watch = None                      # stopped on the phone, or monitoring asked anew
            for slot in (LIVE, ONCE):                  # (the quick one first: a read takes a minute)
                if slot in asked:
                    try:
                        self._one(slot, *asked[slot], now)
                    except Exception:  # noqa: BLE001 - asked again next time
                        traceback.print_exc()
            self._keep_live(now)

    def _one(self, slot: str, rid: str, req: dict, now: float) -> None:
        mine = self.answers.get(rid)
        if mine and req.get("state") != mine[1]["state"]:
            self._answer(slot, rid, mine[1])           # a phone's save lost the answer: again
            return
        if req["kind"] == "monitor" and req.get("state") == "monitoring":
            until = dz._ts(req.get("until")) or 0
            if now >= until:
                self._end(rid, f"stopped after {MONITOR_MAX_S // 3600} h; start it again to carry on")
            elif not self.watch:                       # (the service restarted)
                self._watch(rid, req, until)
            return
        if req.get("state") or now - (dz._ts(req.get("at")) or 0) > REQUEST_FRESH_S:
            return                                     # answered already, or too old to act on
        if req["kind"] in ("check", "capture"):
            self._read(rid, req, save=req["kind"] == "check")
        elif req["kind"] == "upload":
            self._upload(rid, req)
        else:
            until = now + MONITOR_MAX_S
            if self._watch(rid, req, until):
                every = self.watch["every"]
                self._answer(LIVE, rid, {"state": "monitoring", "until": dz.iso(until), "every": every,
                                         "message": f"every {every} s, for up to {MONITOR_MAX_S // 3600} h"})

    def _nos(self, ids) -> tuple[list, dict]:
        """The tank numbers of these tank ids (every tank if none are named)."""
        cfg, _ = self.st._settings()
        by_id = {t.get("id"): t.get("no") for t in cfg.get("tanks") or []}
        return sorted({by_id[i] for i in (ids or list(by_id)) if by_id.get(i)}), by_id

    @staticmethod
    def _why(exc: Exception, what: str) -> str:
        msg = str(exc) if isinstance(exc, (CaptureError, RuntimeError, ValueError)) else f"{what} failed ({type(exc).__name__})"
        return msg[:300]

    def _saved(self, nos, ids, uploads, proof) -> dict:
        """A save's answer: each tank's result, and whether its proof picture went up."""
        out = {"results": {}}
        for no in nos:
            u = uploads.get(str(no)) or uploads.get(no) or {}
            out["results"][ids[no]] = {"ok": bool(u.get("ok")) or u.get("message") == "already in the app",
                                       "message": str(u.get("message") or "not read")[:200]}
        if proof:                                      # (none: no tank was saved, so no picture either)
            out["picture"] = bool(proof.get("ok"))
            if not proof.get("ok"):
                out["pictureError"] = str(proof.get("message") or "not uploaded")[:200]
        return out

    def _read(self, rid: str, req: dict, save: bool) -> None:
        nos, by_id = self._nos(req.get("tanks"))
        if not nos:
            self._answer(ONCE, rid, {"state": "error", "message": "none of these tanks is in the decant app's settings"})
            return
        try:
            last = self.st.capture(nos, upload=save, why="decant app")
        except Exception as exc:  # noqa: BLE001 - the phone is told why
            self._answer(ONCE, rid, {"state": "error", "message": self._why(exc, "the capture")})
            return
        ids = {no: i for i, no in by_id.items()}
        figures = {}
        for no in nos:
            f = (last.get("tanks") or {}).get(str(no))
            if not f:
                figures[ids[no]] = {"problems": ["not on the screen"]}
                continue
            r = f.get("reading") or {}
            figures[ids[no]] = {**{k: r.get(k) for k in FIGURES if r.get(k) is not None},
                                "confidence": f.get("confidence"), "problems": (f.get("problems") or [])[:3]}
        answer = {"state": "done", "capturedAt": last.get("at"), "figures": figures}
        if save:
            answer.update(self._saved(nos, ids, last.get("uploads") or {}, last.get("proof")))
        try:                                           # the picture the Monitor page shows
            jpeg = cards_mod.to_jpeg(self.st.picture(nos, grid=True))
            if not jpeg:
                raise ValueError("no tank card was found on the screen")
            answer["image"] = self.st.decant.save_proof(jpeg, {})
        except Exception as exc:  # noqa: BLE001 - the figures count without it
            answer["imageError"] = self._why(exc, "the picture")
        self._answer(ONCE, rid, answer)

    def _upload(self, rid: str, req: dict) -> None:
        nos, by_id = self._nos(req.get("tanks"))
        last_at = (self.st.last or {}).get("at")
        if not nos or not req.get("of") or req.get("of") != last_at:
            self._answer(ONCE, rid, {"state": "error", "message": "the server has taken another capture since; "
                                                                 "capture again, then upload"})
            return
        try:
            results = self.st.upload_last(nos)
        except Exception as exc:  # noqa: BLE001 - the phone is told why
            self._answer(ONCE, rid, {"state": "error", "message": self._why(exc, "the upload")})
            return
        ids = {no: i for i, no in by_id.items()}
        self._answer(ONCE, rid, {"state": "done", "of": last_at,
                                 **self._saved(nos, ids, results, (self.st.last or {}).get("proof"))})

    def _watch(self, rid: str, req: dict, until: float) -> bool:
        nos, _ = self._nos(req.get("tanks"))
        if not nos:
            self._answer(LIVE, rid, {"state": "error", "message": "none of these tanks is in the decant app's settings"})
            return False
        try:
            every = int(req.get("every") or MONITOR_EVERY_S)
        except (TypeError, ValueError):
            every = MONITOR_EVERY_S
        self.watch = {"req": rid, "tanks": set(nos), "until": until, "every": max(EVERY[0], min(EVERY[1], every))}
        live = self.st.live
        if live:
            live["wake"].set()                         # its next read now, with these tanks
        return True

    def _end(self, rid: str, why: str) -> None:
        self.watch = None
        self._answer(LIVE, rid, {"state": "ended", "message": why})

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
            self._end(self.watch["req"], f"live monitoring ended {RECONNECTS} times without a read ({why}); "
                                         "start it again")
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
    def _answer(self, slot: str, rid: str, answer: dict) -> None:
        """Into the request itself; kept, and written again until it is there."""
        self.answers.pop(rid, None)
        self.answers[rid] = (slot, answer)
        for old in list(self.answers)[:-ANSWERS_KEPT]:
            del self.answers[old]
        try:
            self.st.decant.answer_stock_request(rid, answer, slot=slot, timeout=QUICK_S)
        except Exception:  # noqa: BLE001 - written again next time
            traceback.print_exc()
