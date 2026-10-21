"""Serial worker, durable uploads and reconciliation-first financial writes."""
import json
import random
import time
import uuid

from . import __version__
from .tally import KINDS, SERIES, TallyProblem, business_equal, fuel_voucher, identity, light_object, object_data
from .transport import CloudRejected, ConnectionProblem
from .recovery import TallyStarting

# 1.0.x mirrored every master and voucher type; 2 keeps only HSD/MS/XG CREDIT vouchers.
JOURNAL = 2


class Stopped(Exception):
    pass


class Worker:
    def __init__(self, cloud, tally, store, clock=time.time, recovery=None):
        self.cloud, self.tally, self.store, self.clock = cloud, tally, store, clock
        self.cloud.instance = str(uuid.uuid4())
        self.last_pulse = 0
        self.config = {}
        self.stop = None
        self.initial_scan = True
        self.recovery = recovery
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
            self.cloud.rpc("tally_bridge_ingest", p_objects=[json.loads(r["payload"]) for r in rows])
            self.store.uploaded(rows)

    def validate_snapshot(self, kind, meta):
        current = {identity(m)[0]: identity(m) for m in meta}
        known = self.store.identities(kind)
        # A restored backup brings back older revisions of vouchers already seen. Deleting
        # or retyping the newest voucher is ordinary work and must not pause sync.
        for guid, _, alter in current.values():
            if guid in known and not known[guid]["deleted"] and alter < known[guid]["alter_id"]:
                raise TallyProblem("Tally was restored to an older revision; sync is paused for reconciliation")
        return current, known

    def scan(self, kind, full=False, force_upload=False):
        cursor = 0 if full else self.store.get("cursor:" + kind, 0)
        meta = self.tally.metadata(kind, cursor)
        if not meta and not full:
            self.store.set("scan:" + kind, self.clock())
            return  # idle polls never load historical XML from SQLite
        current, known = self.validate_snapshot(kind, meta)
        # Full reconciliation also refreshes unresolved conflicts after 'Use Tally version'.
        refresh = set(self.config.get("refresh_guids") or [])
        # Details are read only for alterations of vouchers already seen. A voucher seen for
        # the first time is recorded from its metadata: the first sync is one Tally request.
        changed = [i for g, i in current.items() if g in refresh
                   or g in known and (i[2] != known[g]["alter_id"] or known[g]["deleted"])]
        first = [m for m in meta if identity(m)[0] not in known and identity(m)[0] not in refresh]
        if first:
            self.store.stage([light_object(kind, m) for m in first])
        if changed:
            self.progress(f"Reading {len(changed):,} altered voucher{'s' if len(changed) != 1 else ''} from Tally")
        for offset in range(0, len(changed), 30):
            self.pulse()
            batch = changed[offset:offset + 30]
            nodes = self.tally.objects(kind, [i[1] for i in batch])
            if {identity(n)[0] for n in nodes} != {i[0] for i in batch}:
                raise TallyProblem("Tally changed during the read. The incomplete batch will be retried.")
            if any(identity(n)[2] < current[identity(n)[0]][2] for n in nodes):
                raise TallyProblem("Tally returned an older object than its metadata. No checkpoint was advanced; review a possible restore.")
            self.tally.verify()
            self.store.stage([object_data(kind, n) for n in nodes])
        if force_upload:
            # Pairing a replacement PC/cloud bootstrap must republish unchanged cached objects too.
            self.tally.verify()
            self.store.stage([dict(kind=kind, guid=g, master_id=i[1], alter_id=i[2], data=self.store.object_payload(kind, g))
                              for g, i in current.items() if g in known and i not in changed])
        if full:
            self.tally.verify()
            removed = [dict(kind=kind, guid=g, alter_id=r["alter_id"], master_id=r["master_id"],
                            data=self.store.object_payload(kind, g), deleted=True)
                       for g, r in known.items() if g not in current and not r["deleted"]]
            self.store.stage(removed)
            self.store.set("full:" + kind, self.clock())
        # Advance to the METADATA snapshot, not a later read's AlterID. Otherwise an edit
        # between these requests could skip another voucher's intermediate alteration.
        self.store.set("cursor:" + kind, max([cursor] + [i[2] for i in current.values()]))
        self.store.set("scan:" + kind, self.clock())

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
        elif recovering or p.get("guid"):
            raise TallyProblem("Invoice not found after an earlier posting. Review in Tally Prime; automatic recreation is blocked.")
        missing = self.tally.missing_masters(p)
        if missing:
            raise TallyProblem("Not posted: create " + ", ".join(missing) + " in Tally Prime first, then choose Try sync again.")
        # Tally's dated GST registration for this invoice; the app's copy if Tally has none.
        gst = self.tally.party_gst(p["party"], p["date"])
        if gst:
            p = dict(p, gst=gst)
        # Cloud guard is committed BEFORE touching Tally. A lost response is recovery-only.
        self.cloud.rpc("tally_bridge_begin_write", p_job=job["id"], p_lease=job["lease_token"])
        self.store.write(job["id"], "writing")
        self.tally.import_voucher(p, found)
        readback = self.tally.lookup(p)
        if readback is None or not business_equal(fuel_voucher(readback), p):
            raise TallyProblem("Tally read-back of " + label + " does not match the submitted voucher. Review in Tally Prime.")
        self.confirmed(job, readback)

    def watching(self):
        count = self.store.count("Voucher")
        return "Watching " + format(count, ",") + " fuel voucher" + ("" if count == 1 else "s") + " in Tally; new web vouchers are checked every 5 seconds"

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
        if self.recovery:
            if self.recovery.ensure():
                self.initial_scan = True
        else:
            self.tally.verify()
        if self.initial_scan:
            self.status("syncing", "Bridge " + __version__ + " started; reading the fuel voucher list from Tally")
        for kind in KINDS:
            bootstrap = cloud_ok and not self.config.get("ready")
            full = self.initial_scan or bootstrap or self.clock() - self.store.get("full:" + kind, 0) >= 3600
            # A manual conflict resolution requires a fresh read, even when AlterID has not changed.
            full = full or bool(self.config.get("refresh_guids"))
            if full or self.clock() - self.store.get("scan:" + kind, 0) >= 5:
                self.scan(kind, full, force_upload=bootstrap)
        self.initial_scan = False
        if not cloud_ok:
            self.status("internet_offline", "Changes retained on this PC; uploads resume on reconnection.")
            return
        self.flush()
        if not self.config.get("ready"):
            self.cloud.rpc("tally_bridge_ready")
        job = self.cloud.rpc("tally_bridge_claim")
        if job:
            try:
                if job["kind"] == "report":
                    self.finish(job, "done", {"content": self.tally.report(job["payload"])})
                else:
                    self.voucher(job)
            except TallyProblem as e:
                self.finish(job, "conflict" if job["kind"] == "voucher" else "error", detail=str(e))
            # Network/HTTP failure leaves a leased/writing job for safe recovery after expiry.
        detail = self.watching()
        self.heartbeat("online", detail)
        self.status("online", detail)

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
                failures += 1
                self.status("starting_tally", str(e))
                try:
                    self.heartbeat("starting_tally", str(e))
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
