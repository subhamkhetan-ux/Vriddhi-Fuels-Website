"""Serial worker, durable uploads and reconciliation-first financial writes."""
import json
import random
import time
import uuid

from . import __version__
from .tally import KINDS, SERIES, TallyProblem, business_equal, fuel_voucher, identity, object_data, ledger_gst, parse
from .transport import ConnectionProblem


class Stopped(Exception):
    pass


class Worker:
    def __init__(self, cloud, tally, store, clock=time.time):
        self.cloud, self.tally, self.store, self.clock = cloud, tally, store, clock
        self.cloud.instance = str(uuid.uuid4())
        self.last_pulse = 0
        self.config = {}
        self.stop = None
        binding = {"company_guid": tally.guid, "cloud": cloud.url}
        if store.get("binding") not in (None, binding):
            raise TallyProblem("This recovery journal belongs to a different company or cloud project. Keep it for administrator review.")
        store.set("binding", binding)

    def heartbeat(self, health="online", detail=""):
        self.config = self.cloud.rpc("tally_bridge_heartbeat", p_health=health, p_detail=detail, p_version=__version__)
        self.last_pulse = self.clock()
        return self.config

    def pulse(self):
        if self.stop and self.stop.is_set():
            raise Stopped()
        if self.clock() - self.last_pulse > 20:
            try:
                self.heartbeat("syncing")
            except ConnectionProblem:
                pass  # Tally -> durable SQLite continues while the Internet is down

    def flush(self):
        while rows := self.store.upload_batch():
            self.pulse()
            self.cloud.rpc("tally_bridge_ingest", p_objects=[json.loads(r["payload"]) for r in rows])
            self.store.uploaded(rows)

    def scan(self, kind, full=False, force_upload=False):
        cursor = 0 if full else self.store.get("cursor:" + kind, 0)
        meta = self.tally.metadata(kind, cursor)
        if not meta and not full:
            self.store.set("scan:" + kind, self.clock())
            return  # idle polls never load historical XML from SQLite
        known = self.store.identities(kind)
        current = {identity(m)[0]: identity(m) for m in meta}
        for guid, _, alter in current.values():
            if guid in known and alter < known[guid]["alter_id"]:
                raise TallyProblem("Tally was restored to an older revision; sync is paused for reconciliation")
        changed = [i for g, i in current.items() if g not in known or i[2] != known[g]["alter_id"] or known[g]["deleted"]]
        # Full reconciliation also refreshes unresolved conflicts after 'Use Tally version'.
        refresh = set(self.config.get("refresh_guids", [])) if kind == "Voucher" else set()
        changed.extend(i for g, i in current.items() if g in refresh and i not in changed)
        for offset in range(0, len(changed), 30):
            self.pulse()
            batch = changed[offset:offset + 30]
            nodes = self.tally.objects(kind, [i[1] for i in batch])
            if {identity(n)[0] for n in nodes} != {i[0] for i in batch}:
                raise TallyProblem("Tally changed during the read. The incomplete batch will be retried.")
            self.tally.verify()
            objects = [object_data(kind, n) for n in nodes]
            if kind == "Ledger":
                groups = {json.loads(r["data"])["name"]: json.loads(r["data"])["parent"]
                          for r in self.store.known("Group").values() if not r["deleted"]}
                for o in objects:
                    parent, seen = o["data"]["parent"], set()
                    while parent in groups and parent not in seen and parent != "Sundry Debtors":
                        seen.add(parent)
                        parent = groups[parent]
                    o["data"]["is_debtor"] = parent == "Sundry Debtors"
            self.store.stage(objects)
        if force_upload:
            # Pairing a replacement PC/cloud bootstrap must republish unchanged cached objects too.
            self.tally.verify()
            self.store.stage([dict(kind=kind,guid=g,master_id=i[1],alter_id=i[2],data=self.store.object_payload(kind,g))
                              for g,i in current.items() if g in known and i not in changed])
        if full:
            self.tally.verify()
            removed = [dict(kind=kind, guid=g, alter_id=r["alter_id"], master_id=r["master_id"],
                            data=self.store.object_payload(kind,g), deleted=True)
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
            if not p.get("guid") or alter != p.get("expected_alter"):
                raise TallyProblem("Tally already has a different invoice or a newer edit. Review both versions.")
            if fuel_voucher(found) is None:
                raise TallyProblem("This invoice has allocations unsupported by the fuel editor. Edit it in Tally Prime.")
        elif recovering or p.get("guid"):
            raise TallyProblem("Invoice not found after an earlier posting. Review in Tally Prime; automatic recreation is blocked.")
        required = {"Ledger": [p["party"], SERIES[p["series"]][2], "R/off"],
                    "StockItem": [SERIES[p["series"]][1]], "VoucherType": [SERIES[p["series"]][0]]}
        for kind, names in required.items():
            available = {json.loads(r["data"])["name"] for r in self.store.known(kind).values() if not r["deleted"]}
            if not set(names).issubset(available):
                raise TallyProblem("Required party, sales ledger, stock item or voucher type is missing in Tally. Create it there first.")
        # Use Tally's dated registration for this invoice, including older invoice edits.
        for row in self.store.known("Ledger").values():
            data = json.loads(row["data"])
            if data["name"] == p["party"] and data.get("xml"):
                p = dict(p, gst=ledger_gst(parse(data["xml"]).find(".//LEDGER"), p["date"]))
                break
        # Cloud guard is committed BEFORE touching Tally. A lost response is recovery-only.
        self.cloud.rpc("tally_bridge_begin_write", p_job=job["id"], p_lease=job["lease_token"])
        self.store.write(job["id"], "writing")
        self.tally.import_voucher(p, found)
        readback = self.tally.lookup(p)
        if readback is None or not business_equal(fuel_voucher(readback), p):
            raise TallyProblem("Tally read-back does not match the submitted voucher. Review in Tally Prime.")
        self.confirmed(job, readback)

    def step(self):
        cloud_ok = True
        try:
            self.heartbeat("syncing")
        except ConnectionProblem:
            cloud_ok = False
        self.tally.verify()
        for kind in KINDS:
            bootstrap = cloud_ok and not self.config.get("ready")
            full = bootstrap or self.clock() - self.store.get("full:" + kind, 0) >= 3600
            interval = 5 if kind == "Voucher" else 60
            if full or self.clock() - self.store.get("scan:" + kind, 0) >= interval:
                self.scan(kind, full, force_upload=bootstrap)
        # A manual conflict resolution requires a fresh read, even when AlterID has not changed.
        if self.config.get("refresh_guids"):
            self.scan("Voucher", True)
        if not cloud_ok:
            self.store.set("status", {"health": "internet_offline", "at": self.clock(), "detail": "Changes retained on this PC; uploads resume on reconnection."})
            return
        self.heartbeat("syncing")
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
        self.heartbeat("online", "Watching Tally; cloud queue checked every 5 seconds")
        self.store.set("status", {"health": "online", "at": self.clock(), "detail": "Connected to Tally and the web app"})

    def run(self, stop=None):
        self.stop = stop
        failures = 0
        while stop is None or not stop.is_set():
            try:
                self.step()
                failures = 0
            except Stopped:
                return
            except (ConnectionProblem, TallyProblem, ValueError) as e:
                failures += 1
                detail = str(e) if isinstance(e, TallyProblem) else "Connection unavailable; queued work is retained and will be checked again."
                self.store.set("status", {"health": "needs_attention", "at": self.clock(), "detail": detail})
                try:
                    self.heartbeat("needs_attention", detail)
                except ConnectionProblem:
                    pass
            delay = min(60, 5 * 2 ** min(failures, 4)) + random.uniform(0, 1)
            if stop:
                stop.wait(delay)
            else:
                time.sleep(delay)
