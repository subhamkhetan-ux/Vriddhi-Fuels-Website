"""Serial worker, durable uploads and reconciliation-first financial writes."""
import datetime as dt
import json
import random
import time
import uuid

from . import __version__
from .tally import (SERIES, CompanyNotOpen, NotReadYet, NotSent, Rejected, TallyProblem, alterable, business_equal,
                    fuel_voucher, identity, object_data, series_of, voucher_date)
from .transport import CloudRejected, ConnectionProblem
from .recovery import TallyStarting, TallyWaiting

# Vouchers dated today and yesterday are watched; older ones are never read.
WINDOW_DAYS = 2

# 1.0.x mirrored every master and voucher type; 2 kept only HSD/MS/XG CREDIT vouchers;
# 3 re-reads them because 1.1.x details came from a collection export without fuel lines.
JOURNAL = 3
# A read-back Tally keeps missing is put up for review after this many tries (a few minutes apart).
READ_TRIES = 5
# Every half hour, and only after something changed in Tally, alterations to fuel vouchers dated
# up to five weeks back are asked for (one filtered list, usually empty): a corrected older invoice.
WIDE_DAYS, WIDE_EVERY = 35, 1800
# A voucher the web app asks to read again is read at most once a minute.
REFRESH_EVERY = 60


class NotPosted(TallyProblem):
    """Not posted, and certainly not in Tally: retried by itself (outcome "error") or, when nothing
    was sent at all, put back in the queue (outcome "retry")."""
    def __init__(self, message, outcome="error"):
        super().__init__(message)
        self.outcome = outcome


class Stopped(Exception):
    pass


class Worker:
    def __init__(self, cloud, tally, store, clock=time.time, recovery=None, paused=None):
        self.cloud, self.tally, self.store, self.clock = cloud, tally, store, clock
        self.cloud.instance = str(uuid.uuid4())
        self.last_pulse = 0
        self.config = {}
        self.stop = None
        self.initial_scan = True
        self.recovery = recovery
        # paused(): True while the Tally export script drives Tally's keyboard; Tally is not touched then.
        self.paused = paused or (lambda: False)
        self.tally_ready = recovery is None
        self.pending_mark = None
        self.refreshed = ([], 0)
        self.notes = []  # objects the web app could not apply, shown in the status
        binding = {"company_guid": tally.guid, "cloud": cloud.url}
        if store.get("binding") not in (None, binding):
            raise TallyProblem("This recovery journal belongs to a different company or cloud project. Keep it for administrator review.")
        store.set("binding", binding)
        if store.get("journal") != JOURNAL:
            # Cursors from the old all-voucher/all-master snapshot do not apply to the
            # fuel-voucher watch. Re-read from scratch; in-flight write records are kept.
            store.reset_snapshot()
            store.set("journal", JOURNAL)

    def status(self, health, detail):
        """What Setup's Status button shows; the version tells an old worker's record apart."""
        self.store.set("status", {"health": health, "at": self.clock(), "detail": detail, "version": __version__})

    def progress(self, detail):
        self.status("syncing", detail)
        try:
            self.heartbeat("syncing", detail)
        except CloudRejected:
            raise
        except ConnectionProblem:
            pass

    def heartbeat(self, health="online", detail=""):
        self.config = self.cloud.rpc("tally_bridge_heartbeat", p_health=health, p_detail=detail, p_version=__version__) or {}
        self.last_pulse = self.clock()
        return self.config

    def pulse(self):
        if self.stop and self.stop.is_set():
            raise Stopped()
        if self.clock() - self.last_pulse > 20:
            try:
                self.heartbeat("syncing", "Reading Tally vouchers")
            except CloudRejected:
                raise
            except ConnectionProblem:
                pass  # Tally -> durable SQLite continues while the Internet is down

    def flush(self):
        pending = self.store.pending()
        if pending > 100:
            self.progress(f"Sending {pending:,} Tally vouchers to the web app")
        while rows := self.store.upload_batch():
            self.pulse()
            objects = [json.loads(r["payload"]) for r in rows]
            result = self.cloud.rpc("tally_bridge_ingest", p_objects=objects) or {}
            self.store.uploaded(rows)
            # One voucher the web app cannot apply never holds up the others; it is named in the status.
            self.notes = [str(x.get("error", ""))[:200] for x in result.get("rejected") or [] if isinstance(x, dict)][:3]

    def validate_snapshot(self, kind, meta):
        current = {identity(m)[0]: identity(m) for m in meta}
        known = self.store.identities(kind)
        # A restored backup brings back older revisions of vouchers already seen. Deleting
        # or retyping the newest voucher is ordinary work and must not pause sync.
        for guid, _, alter in current.values():
            if guid in known and not known[guid]["deleted"] and alter < known[guid]["alter_id"]:
                raise TallyProblem("Tally was restored to an older revision; sync is paused for reconciliation")
        return current, known

    def window(self):
        """Only vouchers dated today or yesterday are watched: sales are entered on the day
        (or the morning after) and never deleted, so older ones never need reading."""
        return dt.date.fromtimestamp(self.clock()) - dt.timedelta(days=WINDOW_DAYS - 1)

    def scan(self, kind, full=False, force_upload=False):
        """Read new and altered fuel vouchers of the two watched days. The days are listed whole
        (metadata only), so a voucher that left the list is noticed: it is asked for by GUID, and
        is then either re-dated or re-typed in Tally (read in full) or deleted (sent as deleted)."""
        cursor = self.store.get("cursor:" + kind, 0)
        since = self.window()
        meta = self.tally.metadata(kind, 0, since)
        listed = {identity(m)[0] for m in meta}
        # 'Use Tally version' / 'Read again' may name an older voucher: read just those, whatever their date.
        refresh = set(self.config.get("refresh_guids") or []) if full else set()
        absent = (set(self.store.dated_from(kind, since.strftime("%Y%m%d"))) | refresh) - listed
        if absent:
            found = self.tally.by_guid(sorted(absent))
            meta += found
            gone = absent - {identity(m)[0] for m in found}
        else:
            gone = set()
        current, known = self.validate_snapshot(kind, meta)
        by_guid = {identity(m)[0]: m for m in meta}
        changed = [i for g, i in current.items() if g in refresh or g not in known
                   or i[2] != known[g]["alter_id"] or known[g]["deleted"]]
        self.read(kind, changed, by_guid, current)
        self.stage_gone(kind, gone, known)
        if force_upload:
            # Pairing a replacement PC/cloud bootstrap must republish unchanged cached objects too.
            self.store.stage([dict(kind=kind, guid=g, master_id=i[1], alter_id=i[2], data=self.store.object_payload(kind, g))
                              for g, i in current.items() if g in known and i not in changed])
        # Advance to the METADATA snapshot, not a later read's AlterID. Otherwise an edit
        # between these requests could skip another voucher's intermediate alteration.
        self.store.set("cursor:" + kind, max([cursor] + [i[2] for i in current.values()]))
        self.store.set("scan:" + kind, self.clock())

    def read(self, kind, changed, by_guid, current):
        """Complete copies of these vouchers from Tally's Day Book, one read per date."""
        if changed:
            self.progress(f"Reading {len(changed):,} new or altered voucher{'s' if len(changed) != 1 else ''} from Tally")
        by_date = {}
        for i in changed:
            by_date.setdefault(voucher_date(by_guid[i[0]]), []).append(i)
        for _, batch in sorted(by_date.items(), reverse=True):
            self.pulse()
            nodes = self.tally.details([by_guid[i[0]] for i in batch])
            if {identity(n)[0] for n in nodes} != {i[0] for i in batch}:
                raise TallyProblem("Tally changed during the read. The incomplete batch will be retried.")
            if any(identity(n)[2] < current[identity(n)[0]][2] for n in nodes):
                raise TallyProblem("Tally returned an older object than its metadata. No checkpoint was advanced; review a possible restore.")
            self.tally.verify()
            objects = [object_data(kind, n) for n in nodes]
            for o, n in zip(objects, nodes):
                # Moved to another voucher type in Tally: no longer a fuel voucher, nor watched.
                o["deleted"] = series_of(n) is None
            self.store.stage(objects)

    def stage_gone(self, kind, gone, known):
        """Vouchers Tally no longer has (deleted there). A reappearing one is read again."""
        objects = []
        for g in sorted(gone):
            k = known.get(g)
            if k and k["deleted"]:
                continue
            objects.append(dict(kind=kind, guid=g, master_id=k["master_id"] if k else 0, alter_id=k["alter_id"] if k else 0,
                                data=(self.store.object_payload(kind, g) if k else None) or {}, deleted=True))
        if objects:
            self.store.stage(objects)

    def wide_check(self, kind="Voucher"):
        """Alterations to fuel vouchers dated before the watched days (a corrected older invoice,
        a voucher entered late). Rare and filtered by AlterID, so Tally hardly notices it."""
        if self.clock() - self.store.get("wide_at", 0) < WIDE_EVERY:
            return
        mark = self.pending_mark
        if mark is not None and mark == self.store.get("wide_mark"):
            self.store.set("wide_at", self.clock())
            return  # nothing changed in Tally since the last check
        base = self.store.get("cursor:wide")
        if base is None:
            # From now on: older history arrives through Import from Tally, as before the bridge.
            self.store.set("cursor:wide", self.store.get("cursor:" + kind, 0))
        else:
            since = dt.date.fromtimestamp(self.clock()) - dt.timedelta(days=WIDE_DAYS)
            meta = self.tally.metadata(kind, base, since)
            current, known = self.validate_snapshot(kind, meta)
            changed = [i for g, i in current.items() if g not in known or i[2] != known[g]["alter_id"] or known[g]["deleted"]]
            self.read(kind, changed, {identity(m)[0]: m for m in meta}, current)
            self.store.set("cursor:wide", max([base] + [i[2] for i in current.values()]))
        self.store.set("wide_mark", mark)
        self.store.set("wide_at", self.clock())

    def refresh_due(self):
        """The web app asked for vouchers to be read again: at most once a minute for the same ones."""
        wanted = sorted(self.config.get("refresh_guids") or [])
        if not wanted or wanted == self.refreshed[0] and self.clock() - self.refreshed[1] < REFRESH_EVERY:
            return False
        self.refreshed = (wanted, self.clock())
        return True

    def finish(self, job, state, result=None, detail=""):
        self.store.write(job["id"], state, result)
        self.cloud.rpc("tally_bridge_finish", p_job=job["id"], p_lease=job["lease_token"],
                       p_state=state, p_result=result or {}, p_detail=detail)

    def confirmed(self, job, found):
        obj = object_data("Voucher", found)
        self.finish(job, "done", {"guid": obj["guid"], "alter_id": obj["alter_id"]})
        self.store.stage([obj])

    def voucher(self, job):
        p = job["payload"]
        label = SERIES[p["series"]][0] + " #" + p["number"]
        if p.get("company") and p["company"] != self.tally.company:
            raise TallyProblem("This invoice belongs to a different financial-year company. Pairing needs accountant review before posting.")
        previous = self.store.written(job["id"])
        recovering = job.get("recover_only") or previous and previous["phase"] in ("writing", "done")
        self.tally.verify()
        found = self.tally.lookup(p)
        if found is not None:
            guid, _, alter = identity(found)
            if p.get("guid") and guid != p["guid"]:
                raise TallyProblem("The invoice number now belongs to a different GUID. Review in Tally Prime.")
            if business_equal(fuel_voucher(found), p):
                self.confirmed(job, found)
                return
            if recovering:
                raise TallyProblem("Posting outcome is uncertain. Review the invoice in Tally, then check again; it will not be posted twice.")
            if not p.get("guid"):
                raise TallyProblem(label + " already exists in Tally with different details. Use Tally version, or assign the next invoice number.")
            if alter != p.get("expected_alter"):
                raise TallyProblem(label + " was edited in Tally after this change was made. Review both versions.")
            if not alterable(found):
                raise TallyProblem(label + " was saved in Tally with details the web editor cannot change safely "
                                   "(cost centres, several bill references or batches). Choose Use Tally version, then edit it in Tally Prime.")
        elif recovering or p.get("guid"):
            raise TallyProblem("Invoice not found after an earlier posting. Review in Tally Prime; automatic recreation is blocked.")
        missing = self.tally.missing_masters(p)
        if missing:
            raise NotPosted("Not posted yet: create " + ", ".join(missing) + " in Tally Prime. It is posted by itself "
                            "within a few minutes once it exists (or correct the voucher here).")
        # Tally's dated GST registration for this invoice; the app's copy if Tally has none.
        gst = self.tally.party_gst(p["party"], p["date"])
        if gst:
            p = dict(p, gst=gst)
        # Cloud guard is committed BEFORE touching Tally. A lost response is recovery-only.
        try:
            self.cloud.rpc("tally_bridge_begin_write", p_job=job["id"], p_lease=job["lease_token"])
        except CloudRejected as e:
            if "Voucher changed or job lease expired" in str(e):
                return  # edited in the web app meanwhile: the new revision is its own job; nothing was sent
            raise
        self.store.write(job["id"], "writing")
        try:
            self.tally.import_voucher(p, found)
        except NotSent as e:
            raise NotPosted(label + " waits: " + str(e), "retry") from None
        except Rejected as e:
            # Tally said no. Make sure it applied nothing before the voucher is offered for editing again.
            after = self.tally.lookup(p)
            if (after is None) == (found is None) and (after is None or identity(after) == identity(found)):
                raise NotPosted("Tally refused " + label + ": " + str(e).replace("Tally rejected the request: ", "")
                                + ". Nothing was posted; correct it here or in Tally Prime. It is tried again by itself.") from None
            raise TallyProblem("Tally refused " + label + " but its copy changed. Review it in Tally Prime, then choose Recheck Tally.") from None
        readback = self.tally.lookup(p)
        if readback is None or not business_equal(fuel_voucher(readback), p):
            raise TallyProblem("Tally read-back of " + label + " does not match the submitted voucher. Review in Tally Prime.")
        self.confirmed(job, readback)

    def watching(self):
        count = self.store.count("Voucher")
        notice = self.store.get("tally_notice")  # e.g. two Tally copies open (guard.py)
        notes = ("Not applied in the web app: " + "; ".join(self.notes) + ". ") if self.notes else ""
        return ((notice["text"] + " " if notice else "") + notes + "Watching " + format(count, ",") + " fuel voucher"
                + ("" if count == 1 else "s") + " in Tally; new web vouchers are checked every 5 seconds")

    def changed_in_tally(self):
        """An unchanged $AltVchId means no voucher changed, so the voucher list is not
        scanned (that scan is what slowed Tally for the people using it)."""
        self.pending_mark = self.tally.voucher_mark()
        return self.pending_mark is None or self.pending_mark != self.store.get("mark")

    def step(self):
        cloud_ok = True
        try:
            self.heartbeat("syncing", "Checking Tally")
        except CloudRejected:
            raise
        except ConnectionProblem:
            cloud_ok = False
        if self.stop and self.stop.is_set():
            raise Stopped()
        if cloud_ok and self.config.get("active") is False:
            return self.idle()
        if self.paused():
            self.tally_ready = False
            detail = "Paused while the Tally export script runs; nothing is sent to Tally until it finishes."
            self.status("paused", detail)
            if cloud_ok:
                self.heartbeat("paused", detail)
            return
        bootstrap = cloud_ok and not self.config.get("ready")
        # A manual conflict resolution requires a fresh read, even when AlterID has not changed.
        full = self.initial_scan or bootstrap or self.refresh_due()
        # Tally is asked at most every 10 seconds; the cloud queue is still checked every 5.
        if full or self.clock() - self.store.get("polled", 0) >= 10:
            self.store.set("polled", self.clock())
            self.tally_ready = False
            if self.recovery:
                if self.recovery.ensure():
                    self.initial_scan = full = True
            else:
                self.tally.verify()
            self.tally_ready = True
            if self.initial_scan:
                self.status("syncing", "Bridge " + __version__ + " started; reading the fuel voucher list from Tally")
            if self.changed_in_tally() or full:
                self.scan("Voucher", full, force_upload=bootstrap)
                # The counter read BEFORE the scan: a change during it is seen next time.
                self.store.set("mark", self.pending_mark)
            self.wide_check()
        self.initial_scan = False
        if not cloud_ok:
            self.status("internet_offline", "Changes retained on this PC; uploads resume on reconnection.")
            return
        self.flush()
        if not self.config.get("ready"):
            self.cloud.rpc("tally_bridge_ready")
        self.claim()
        detail = self.watching()
        self.heartbeat("online", detail)
        self.status("online", detail)

    def claim(self):
        if not self.tally_ready:
            return False  # Tally closed or busy: queued work waits, nothing is marked failed
        job = self.cloud.rpc("tally_bridge_claim")
        if not job:
            return False
        try:
            if job["kind"] == "report":
                self.tally.verify()
                self.finish(job, "done", {"content": self.tally.report(job["payload"])})
            else:
                self.voucher(job)
        except CompanyNotOpen:
            raise  # closed between checks: the job's lease expires and it is claimed again later
        except NotReadYet as e:
            if int(job.get("attempts") or 0) < READ_TRIES:
                return True  # its lease expires and it is checked again; a posting is never repeated
            self.finish(job, "conflict", detail=str(e) + ". Open the invoice once in Tally Prime, then choose Recheck Tally.")
        except NotPosted as e:
            self.finish(job, e.outcome, {"not_written": True}, detail=str(e))
        except TallyProblem as e:
            self.finish(job, "conflict" if job["kind"] == "voucher" else "error", detail=str(e))
        # Network/HTTP failure leaves a leased/writing job for safe recovery after expiry.
        return True

    def idle(self):
        """Bridge switched off in the web app: Tally is not read or started. Only report
        requests and the recheck of an uncertain earlier posting are served."""
        if self.claim():
            return
        detail = "Bridge switched off in the web app; Tally is not being read"
        self.heartbeat("off", detail)
        self.status("off", detail)
        self.initial_scan = True  # a full reconciliation when it is switched back on

    def run(self, stop=None):
        self.stop = stop
        failures = 0
        while stop is None or not stop.is_set():
            try:
                self.step()
                failures = 0
            except Stopped:
                return
            except TallyStarting as e:
                # Waiting for people to open Tally is normal: keep checking every few seconds.
                failures = 0 if isinstance(e, TallyWaiting) else failures + 1
                self.status(e.health, str(e))
                try:
                    self.heartbeat(e.health, str(e))
                except ConnectionProblem:
                    pass
            except (ConnectionProblem, TallyProblem, ValueError) as e:
                failures += 1
                if isinstance(e, CloudRejected):
                    detail = "The web app refused the bridge: " + str(e)
                elif isinstance(e, TallyProblem):
                    detail = str(e)
                else:
                    detail = "Connection unavailable; queued work is retained and will be checked again."
                self.status("needs_attention", detail)
                try:
                    self.heartbeat("needs_attention", detail)
                except ConnectionProblem:
                    pass
            delay = min(60, 5 * 2 ** min(failures, 4)) + random.uniform(0, 1)
            if stop:
                stop.wait(delay)
            else:
                time.sleep(delay)
