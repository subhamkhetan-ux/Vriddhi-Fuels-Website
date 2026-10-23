"""Failure/restart behaviour and the XML protocol, with synthetic financial data."""
import copy
import json
from pathlib import Path
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from tally_bridge.store import Store
from tally_bridge.tally import Tally, TallyProblem, alterable, business_equal, export_request, fuel_voucher, identity, object_data, parse, sanitize_report, voucher_xml
from tally_bridge.transport import Cloud, ConnectionProblem, LocalTally
from tally_bridge.worker import JOURNAL, Worker

ROOT = Path(__file__).resolve().parents[1]
ID = "d26d607a-40ba-4524-8fa2-c8c340855cb5"
PAYLOAD = dict(id=ID, guid=None, expected_alter=None, series="hsd", number="TEST1", date="2026-10-19", party="Test & Sons",
               vehicle="OD01A1234", qty=10, rate=100, item_amt=1000, party_amt=1000, roff=0, gst={})


def voucher(p=None, alter=1):
    node = parse(voucher_xml("Test Company", p or PAYLOAD)).find(".//VOUCHER")
    from tally_bridge.tally import tag
    tag(node, "GUID", (p or PAYLOAD)["id"])  # Tally assigns identity on import
    tag(node, "MASTERID", 50)
    tag(node, "ALTERID", alter)
    return node


def job(p=None, **extra):
    return dict(id="job-1", kind="voucher", payload=copy.deepcopy(p or PAYLOAD), lease_token="lease-1", recover_only=False, **extra)


class FakeCloud:
    url = 'https://example.supabase.co'
    def __init__(self):
        self.calls, self.instance = [], None
        self.fail = None
    def rpc(self, name, **args):
        self.calls.append((name, args))
        if self.fail == name:
            raise ConnectionProblem("Synthetic network failure")
        if name == "tally_bridge_heartbeat":
            return dict(ready=True, push_enabled=True)


class FakeTally:
    guid = 'test-company-guid'
    company = 'Test Company'
    def __init__(self, found=None, lose_response=False, missing=()):
        self.found, self.lose_response, self.imports, self.missing = found, lose_response, 0, list(missing)
    def verify(self):
        return {"name":"Test Company","guid":"test-company-guid"}
    def lookup(self, p):
        return self.found
    def missing_masters(self, p):
        return self.missing
    def party_gst(self, party, as_of):
        return None
    def voucher_mark(self):
        return None  # a Tally that does not report $AltVchId: every poll scans
    def by_guid(self, guids):
        return []  # a voucher that left the watched days is no longer in Tally
    def import_voucher(self, p, existing=None):
        self.imports += 1
        self.found = voucher(p, 12)
        if self.lose_response:
            raise ConnectionProblem("Tally accepted the voucher, response lost")


def journal(path):
    s = Store(path)
    s.set("journal", JOURNAL)  # a current journal; older ones are reset on first start
    return s


@pytest.fixture
def store(tmp_path):
    s = journal(tmp_path / "journal.sqlite3")
    yield s
    s.close()


def test_lost_tally_response_reconciles_after_restart_without_second_import(store):
    cloud, tally = FakeCloud(), FakeTally(lose_response=True)
    w = Worker(cloud,tally,store)
    j = job()
    with pytest.raises(ConnectionProblem):
        w.voucher(j)
    assert store.written(j["id"])["phase"] == "writing"
    assert cloud.calls[-1][0] == "tally_bridge_begin_write"
    restarted = Worker(cloud,tally,store)
    restarted.voucher(dict(j,recover_only=True,lease_token="new-lease"))
    assert tally.imports == 1
    assert cloud.calls[-1][0] == "tally_bridge_finish"
    assert cloud.calls[-1][1]["p_state"] == "done"


def test_uncertain_create_that_is_absent_is_never_blindly_retried(store):
    tally = FakeTally()
    with pytest.raises(TallyProblem, match="automatic recreation is blocked"):
        Worker(FakeCloud(),tally,store).voucher(dict(job(),recover_only=True))
    assert tally.imports == 0


def test_lost_cloud_ack_recovers_against_the_tally_record(store):
    cloud, tally = FakeCloud(), FakeTally()
    cloud.fail = "tally_bridge_finish"
    with pytest.raises(ConnectionProblem):
        Worker(cloud,tally,store).voucher(job())
    assert store.written("job-1")["phase"] == "done"
    cloud.fail = None
    Worker(cloud,tally,store).voucher(dict(job(), recover_only=True))
    assert tally.imports == 1


def test_preexisting_identical_invoice_is_linked_not_created(store):
    tally = FakeTally(voucher())
    Worker(FakeCloud(),tally,store).voucher(job())
    assert tally.imports == 0


def test_conflicting_invoice_number_and_concurrent_tally_edit_block_posting(store):
    newer = dict(PAYLOAD,rate=110,item_amt=1100,party_amt=1100)
    tally = FakeTally(voucher(newer,5))
    with pytest.raises(TallyProblem,match="already exists in Tally with different details"):
        Worker(FakeCloud(),tally,store).voucher(job())
    p = dict(PAYLOAD,guid=ID,expected_alter=4)
    with pytest.raises(TallyProblem,match="edited in Tally after this change"):
        Worker(FakeCloud(),tally,store).voucher(job(p))
    assert tally.imports == 0


def test_invoice_for_another_financial_year_never_reaches_tally(store):
    tally = FakeTally()
    with pytest.raises(TallyProblem, match="different financial-year company"):
        Worker(FakeCloud(), tally, store).voucher(job(dict(PAYLOAD, company="Test Company (2027-28)")))
    assert tally.imports == 0


def test_supported_alter_preserves_unrelated_tally_fields(store):
    from tally_bridge.tally import tag
    original = voucher()
    tag(original, "NARRATION", "Keep this accountant note")
    p = dict(PAYLOAD,guid=ID,expected_alter=1,qty=11,item_amt=1100,party_amt=1100)
    original.set("REMOTEID", ID)
    altered = parse(voucher_xml("Test Company",p,original)).find(".//VOUCHER")
    assert altered.attrib["ACTION"] == "Alter"
    assert altered.attrib["REMOTEID"] == ID and altered.findtext("GUID") == ID
    assert altered.findtext("NARRATION") == "Keep this accountant note"
    assert business_equal(fuel_voucher(altered),p)
    tally = FakeTally(original)
    Worker(FakeCloud(),tally,store).voucher(job(p))
    assert tally.imports == 1


def test_local_upload_queue_survives_reopen_and_lost_cloud_response(tmp_path):
    path = tmp_path/"journal.sqlite3"
    s = journal(path)
    s.stage([object_data("Voucher",voucher())])
    s.close()
    s = Store(path)
    cloud = FakeCloud(); cloud.fail="tally_bridge_ingest"
    with pytest.raises(ConnectionProblem):
        Worker(cloud,FakeTally(),s).flush()
    assert len(s.upload_batch()) == 1
    cloud.fail = None
    Worker(cloud,FakeTally(),s).flush()
    assert not s.upload_batch()
    assert ID in s.known("Voucher")
    s.close()


def seen(store, alter):
    store.stage([object_data("Voucher",voucher(alter=alter))]); store.uploaded(store.upload_batch())


def test_rejected_or_incomplete_collection_does_not_advance_cursor(store):
    seen(store,1)
    class Partial(FakeTally):
        def metadata(self,kind,after,since=None): return [voucher(alter=2)]
        def details(self,entries): return []
    with pytest.raises(TallyProblem,match="incomplete batch"):
        Worker(FakeCloud(),Partial(),store).scan("Voucher",True)
    assert store.get("cursor:Voucher") is None
    assert store.known("Voucher")[ID]["alter_id"] == 1


def test_metadata_watermark_does_not_skip_an_intervening_edit(store):
    seen(store,5)
    class ChangedDuringRead(FakeTally):
        def metadata(self,kind,after,since=None): return [voucher(alter=10)]
        def details(self,entries): return [voucher(alter=12)]
    Worker(FakeCloud(),ChangedDuringRead(),store).scan("Voucher",True)
    assert store.get("cursor:Voucher") == 10  # another voucher at AlterID 11 must be fetched next time
    assert store.known("Voucher")[ID]["alter_id"] == 12


def test_older_detail_than_metadata_never_advances_checkpoint(store):
    seen(store,5)
    class RestoredDuringRead(FakeTally):
        def metadata(self,kind,after,since=None): return [voucher(alter=12)]
        def details(self,entries): return [voucher(alter=10)]
    with pytest.raises(TallyProblem,match="older object"):
        Worker(FakeCloud(),RestoredDuringRead(),store).scan("Voucher",True)
    assert store.get("cursor:Voucher") is None
    assert store.known("Voucher")[ID]["alter_id"] == 5


def test_restart_validates_recent_snapshot_before_any_cloud_claim(tmp_path):
    from tally_bridge.tally import KINDS
    s=journal(tmp_path/'restart.sqlite3')
    s.stage([object_data('Voucher',voucher(alter=12))])
    s.set('cursor:Voucher',12)
    for kind in KINDS:
        s.set('full:'+kind,1000); s.set('scan:'+kind,1000)
    class Restored(FakeTally):
        def metadata(self,kind,after,since=None): return [voucher(alter=10)] if kind=='Voucher' else []
        def details(self,entries): raise AssertionError('Restore must be blocked before detailed reads')
    cloud=FakeCloud()
    try:
        with pytest.raises(TallyProblem,match='older revision'):
            Worker(cloud,Restored(),s,clock=lambda:1001).step()
        assert not any(name=='tally_bridge_claim' for name,args in cloud.calls)
        assert s.known('Voucher')[ID]['alter_id']==12
    finally: s.close()


def test_missing_master_is_named_and_nothing_reaches_tally(store):
    cloud,tally=FakeCloud(),FakeTally(missing=["Test & Sons"])
    with pytest.raises(TallyProblem,match="create Test & Sons in Tally Prime. It is posted by itself"):
        Worker(cloud,tally,store).voucher(job())
    assert tally.imports==0
    assert not any(name=='tally_bridge_begin_write' for name,args in cloud.calls)


def test_old_journal_is_reset_but_keeps_write_recovery(tmp_path):
    s=Store(tmp_path/'old.sqlite3')
    s.stage([dict(kind="Group",guid="g1",alter_id=1,master_id=1,data={"name":"Sundry Debtors"})])
    s.set("cursor:Voucher",999); s.write("job-1","writing")
    Worker(FakeCloud(),FakeTally(),s)
    assert not s.known("Group") and not s.upload_batch() and s.get("cursor:Voucher") is None
    assert s.written("job-1")["phase"]=="writing" and s.get("journal")==JOURNAL
    s.stage([object_data("Voucher",voucher())])
    Worker(FakeCloud(),FakeTally(),s)  # a current journal is left alone
    assert s.count("Voucher")==1
    s.close()


@pytest.mark.parametrize('wrong_identity',[False,True])
def test_lookup_rejects_stale_detail_or_reused_master_id(wrong_identity):
    tally=Tally(None,'Test Company')
    formulas=[]
    tally.collection=lambda kind,methods,formula,since=None: formulas.append(formula) or [voucher(alter=12)]
    detail=voucher(dict(PAYLOAD,id='a26d607a-40ba-4524-8fa2-c8c340855cb5') if wrong_identity else PAYLOAD,alter=12 if wrong_identity else 10)
    tally.details=lambda entries: [detail]
    with pytest.raises(TallyProblem,match='identity or version changed'):
        tally.lookup(PAYLOAD)
    # One targeted read of this invoice, never the whole company's day book.
    assert formulas==['($VoucherTypeName = "HSD CREDIT" AND $VoucherNumber = "TEST1")']


def test_pairing_bootstrap_republishes_unchanged_data_and_binding_prevents_cross_company(store):
    store.stage([object_data("Voucher",voucher())]); store.uploaded(store.upload_batch())
    class Unchanged(FakeTally):
        def metadata(self,kind,after,since=None): return [voucher()]
        def details(self,entries): raise AssertionError("Unchanged object should use the verified local copy")
    Worker(FakeCloud(),Unchanged(),store).scan("Voucher",True,force_upload=True)
    assert len(store.upload_batch()) == 1
    wrong = FakeTally(); wrong.guid="wrong-company-guid"
    with pytest.raises(TallyProblem,match="different company"):
        Worker(FakeCloud(),wrong,store)


def test_xml_escaping_amount_rounding_and_complex_vouchers():
    from tally_bridge.tally import tag
    p=dict(PAYLOAD,party='A & B <Ltd> "Test"',rate=100.74,qty=9.927,item_amt=1000,party_amt=1000)
    v=voucher(p)
    assert fuel_voucher(v)["party"] == p["party"]
    assert business_equal(fuel_voucher(v),p)
    party=v.find("LEDGERENTRIES.LIST")
    tag(party,"BILLALLOCATIONS.LIST","      ")  # Tally exports empty placeholders everywhere
    assert alterable(v)
    bill=tag(party,"BILLALLOCATIONS.LIST",""); tag(bill,"NAME","TEST1"); tag(bill,"BILLTYPE","New Ref"); tag(bill,"AMOUNT","-1000.00")
    assert business_equal(fuel_voucher(v),p)  # a bill-wise reference still reads as the same sale
    assert alterable(v)  # the customer's one New Ref is carried over for the new amount
    altered=parse(voucher_xml("Test Company",dict(p,qty=11,item_amt=1100,party_amt=1100),v)).find(".//VOUCHER")
    bills=[b for e in altered.findall("LEDGERENTRIES.LIST") for b in e.findall("BILLALLOCATIONS.LIST") if len(b)]
    assert [(b.findtext("NAME"),b.findtext("BILLTYPE"),b.findtext("AMOUNT")) for b in bills]==[("TEST1","New Ref","-1100.00")]
    against=tag(party,"BILLALLOCATIONS.LIST",""); tag(against,"NAME","OLD1"); tag(against,"BILLTYPE","Agst Ref")
    assert not alterable(v)  # against an earlier bill: left to Tally Prime
    with pytest.raises(TallyProblem,match="cannot safely alter"):
        voucher_xml("Test Company",p,v)
    with pytest.raises(TallyProblem,match="Unsafe XML"):
        parse('<!DOCTYPE a [<!ENTITY x SYSTEM "file:///etc/passwd">]><a>&x;</a>')
    with pytest.raises(TallyProblem): parse('<ENVELOPE><COLLECTION>')
    assert parse('<X>A&#4;B</X>').findtext('X')=='AB'


def test_xml_accounting_matches_existing_web_exporter_for_all_three_products():
    html=(ROOT/'tally/index.html').read_text(encoding='utf-8')
    pure=html.split('var TALLY = {',1)[1].split('// ---- Tally file parsers',1)[0]
    script='var TALLY = {'+pure+'\nconst p=JSON.parse(process.argv[1]);console.log(buildEnvelope("Test Company",[p]));'
    for series in ('hsd','ms','xg'):
        p=dict(PAYLOAD,series=series,qty=10.333,rate=101.25,item_amt=1046.22,party_amt=1046,roff=-0.22,
               gst=dict(gstin='21TESTGSTIN',reg_type='Regular',state='Odisha',place_of_supply='Odisha',country='India',pincode='768001'))
        web=dict(seriesKey=series,number=p['number'],dateISO=p['date'],party=p['party'],vehicle=p['vehicle'],qty=p['qty'],
                 rate=p['rate'],itemAmt=p['item_amt'],partyAmt=p['party_amt'],roff=p['roff'],
                 gst=dict(gstin='21TESTGSTIN',regType='Regular',state='Odisha',place='Odisha',country='India',pincode='768001'))
        js=subprocess.run(['node','-e',script,json.dumps(web)],encoding='utf-8',capture_output=True,check=True).stdout
        a=parse(js).find('.//VOUCHER'); b=parse(voucher_xml('Test Company',p)).find('.//VOUCHER')
        # Compare semantic leaf paths; GUID/REMOTEID are the deliberate bridge additions.
        def leaves(n,path=''):
            out=[]
            for child in n:
                name=path+'/'+child.tag
                if list(child): out.extend(leaves(child,name))
                elif child.tag!='GUID': out.append((name,(child.text or '').strip()))
            return sorted(out)
        assert leaves(a)==leaves(b)


def test_report_removes_executable_content_and_retains_accounting_table():
    raw='<html><head><style>evil</style></head><body><script>alert(1)</script><img src="https://evil"><table onclick="evil()"><tr><td colspan="2">₹ 1,234 &amp; tax</td></tr></table><a href="https://evil">link text</a></body></html>'
    result=sanitize_report(raw)
    assert '<script' not in result and 'onclick' not in result and 'https://' not in result
    assert '₹ 1,234 &amp; tax' in result and 'colspan="2"' in result
    assert sanitize_report(raw.encode('utf-16')) == result
    with pytest.raises(TallyProblem): sanitize_report('<RESPONSE><LINEERROR>No report</LINEERROR></RESPONSE>')


def test_report_keeps_tallys_layout_but_nothing_executable():
    raw=('<html><head><style>.amt{text-align:right;font-weight:bold;background:url(https://evil)} td.ind{padding-left:12pt}</style></head><body>'
         '<table width="100%"><tr><td align="RIGHT" valign="top" width="30%" style="border-top:1px solid #000;color:red;background:url(x)">1,234.00</td>'
         '<td class="amt ind">Total</td><td style="text-align:right;expression(alert(1))">x</td><td align="javascript:x">y</td></tr></table></body></html>')
    result=sanitize_report(raw)
    assert '<table width="100%">' in result
    assert '<td align="right" valign="top" width="30%" style="border-top:1px solid #000">' in result
    assert '<td style="text-align:right;font-weight:bold;padding-left:12pt">' in result
    assert 'url(' not in result and 'expression' not in result and 'javascript' not in result and 'color' not in result


def test_http_reaches_local_tally_and_validates_company_guid():
    requests=[]
    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            requests.append(self.rfile.read(int(self.headers['Content-Length'])))
            body=b'<ENVELOPE><BODY><DATA><COLLECTION><COMPANY NAME="Test Company"><GUID>test-company-guid</GUID></COMPANY></COLLECTION></DATA></BODY></ENVELOPE>'
            self.send_response(200); self.end_headers(); self.wfile.write(body)
        def log_message(self,*a): pass
    server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
    thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
    try:
        tally=Tally(LocalTally(server.server_port),'Test Company','test-company-guid')
        assert tally.verify()['guid']=='test-company-guid'
        tally.guid='different-company'
        with pytest.raises(TallyProblem,match='GUID changed'): tally.verify()
        assert b'<TALLYREQUEST>Export</TALLYREQUEST>' in requests[0]
    finally: server.shutdown();server.server_close();thread.join()


def test_cloud_endpoint_rejects_cleartext_and_arbitrary_hosts():
    for url in ('http://qlloauxmfenrrqvfqibp.supabase.co','https://evil.example','https://qlloauxmfenrrqvfqibp.supabase.co@evil.example'):
        with pytest.raises(ValueError): Cloud(url,'public-test-key')


def test_ledger_report_checks_live_name_and_scopes_native_request():
    requests=[]
    class HTTP:
        def post(self,xml):
            requests.append(parse(xml))
            return b'<html><table><tr><td>Test ledger</td><td>1,000.00</td></tr></table></html>'
    tally=Tally(HTTP(),'Test Company','test-company-guid')
    tally.verify=lambda: None
    ledger=parse('<LEDGER NAME="A &amp; B &lt;Ltd&gt;"/>').find('LEDGER')
    tally.collection=lambda *args: [ledger]
    args=dict(report='ledger',ledger='A & B <Ltd>',**{'from':'2026-10-01','to':'2026-10-19'})
    assert '1,000.00' in tally.report(args)
    sv=requests[0].find('.//STATICVARIABLES')
    assert sv.findtext('LEDGERNAME')==sv.findtext('SVLEDGERNAME')=='A & B <Ltd>'
    assert sv.findtext('SVCURRENTCOMPANY')=='Test Company'
    assert sv.findtext('SVFROMDATE')=='20261001' and sv.findtext('SVTODATE')=='20261019'
    tally.collection=lambda *args: []
    with pytest.raises(TallyProblem,match='no longer available'):tally.report(args)
    assert len(requests)==1


def test_prime_dated_gst_uses_the_invoice_date():
    from tally_bridge.tally import ledger_gst
    ledger=parse('''<LEDGER><LEDGSTREGDETAILS.LIST><APPLICABLEFROM>20260401</APPLICABLEFROM><GSTIN>OLDGST</GSTIN><GSTREGISTRATIONTYPE>Regular</GSTREGISTRATIONTYPE></LEDGSTREGDETAILS.LIST>
      <LEDGSTREGDETAILS.LIST><APPLICABLEFROM>20261001</APPLICABLEFROM><GSTIN>NEWGST</GSTIN><GSTREGISTRATIONTYPE>Regular</GSTREGISTRATIONTYPE></LEDGSTREGDETAILS.LIST>
      <LEDMAILINGDETAILS.LIST><APPLICABLEFROM>20260401</APPLICABLEFROM><STATE>Odisha</STATE><COUNTRY>India</COUNTRY></LEDMAILINGDETAILS.LIST></LEDGER>''').find('LEDGER')
    assert ledger_gst(ledger,'2026-09-30')['gstin']=='OLDGST'
    assert ledger_gst(ledger,'2026-10-19')['gstin']=='NEWGST'
    assert ledger_gst(ledger,'2026-10-19')['state']=='Odisha'


def test_service_worker_never_caches_financial_api_or_other_apps():
    script=r'''
      const fs=require('fs'),vm=require('vm'),assert=require('assert');const handlers={};
      const self={registration:{scope:'https://example.test/tally/'},addEventListener:(name,fn)=>handlers[name]=fn};
      vm.runInNewContext(fs.readFileSync('tally/sw.js','utf8'),{self,URL,Set,fetch:()=>Promise.resolve({ok:false})});
      for(const url of ['https://example.supabase.co/rest/v1/tally_vouchers','https://example.test/state/private.json','https://example.test/ledger/','https://example.test/tally/unknown.json']){
        handlers.fetch({request:{method:'GET',url},respondWith:()=>{throw Error('Intercepted private/non-shell data: '+url)}});
      }
      let intercepted=false;
      handlers.fetch({request:{method:'GET',url:'https://example.test/tally/bridge.js'},respondWith:()=>intercepted=true});
      assert(intercepted);
    '''
    subprocess.run(['node','-e',script],cwd=ROOT,check=True,capture_output=True)


def _recovery(tmp_path, store, tally=None, processes=lambda: [], clock=lambda: 1000):
    from tally_bridge.recovery import Recovery
    exe = tmp_path/'Tally Prime'/'Tally.exe';exe.parent.mkdir(exist_ok=True);exe.write_bytes(b'test-only')
    launches=[]
    if tally is None:
        class Offline(FakeTally):
            def verify(self):raise ConnectionProblem('Tally closed')
        tally=Offline()
    return Recovery(tally,{'enabled':True,'exe':str(exe.resolve()),'number':'10000'},store,processes,launches.append,clock=clock),launches


def test_tally_recovery_starts_once_and_retains_backoff_across_restart(tmp_path,store):
    from tally_bridge.recovery import TallyStarting
    recovery,launches=_recovery(tmp_path,store)
    with pytest.raises(TallyStarting,match='Starting Tally minimized'):recovery.ensure()
    assert len(launches)==1 and launches[0]['number']=='10000'
    assert store.get('tally_recovery_pending') is True
    restarted,other=_recovery(tmp_path,store)
    with pytest.raises(TallyStarting,match='Waiting before'):restarted.ensure()
    assert not other
    restarted.clock=lambda:2000
    with pytest.raises(TallyStarting,match='Starting Tally minimized'):restarted.ensure()
    assert len(other)==1


def test_tally_recovery_never_launches_a_competing_process_or_overrides_identity(tmp_path,store):
    from tally_bridge.recovery import TallyStarting
    recovery,launches=_recovery(tmp_path,store,processes=lambda:[{'pid':1,'exe':'another/Tally.exe'}])
    with pytest.raises(TallyStarting,match='No extra Tally instance'):recovery.ensure()
    assert not launches
    class WrongCompany(FakeTally):
        def verify(self):raise TallyProblem('Company GUID changed')
    recovery,launches=_recovery(tmp_path,store,tally=WrongCompany())
    with pytest.raises(TallyProblem,match='GUID changed'):recovery.ensure()
    assert not launches


def test_tally_recovery_leaves_healthy_tally_untouched_and_requests_reconciliation(tmp_path,store):
    def not_called():raise AssertionError('Healthy Tally must not be restarted or enumerated')
    recovery,launches=_recovery(tmp_path,store,tally=FakeTally(),processes=not_called)
    store.set('tally_recovery_pending',True);store.set('tally_launch_failures',3)
    assert recovery.ensure() is True
    assert recovery.ensure() is False
    assert store.get('tally_launch_failures')==0 and not launches


def test_tally_recovery_blocks_invalid_startup_number_and_missing_binary(tmp_path,store):
    from tally_bridge.recovery import startup_settings
    recovery,launches=_recovery(tmp_path,store)
    for number in ('10000 /TDL:evil','../10000','0','-1','10000&echo',''):
        with pytest.raises(RuntimeError):startup_settings(recovery.config['exe'],number)
    Path(recovery.config['exe']).unlink()
    with pytest.raises(TallyProblem,match='installed local Tally'):recovery.ensure()
    assert not launches


def test_worker_reconciles_before_claiming_after_tally_restart(tmp_path):
    from tally_bridge.tally import KINDS
    scanned=[]
    class Empty(FakeTally):
        def metadata(self,kind,after,since=None):scanned.append((kind,after));return []
        def details(self,*args):raise AssertionError('Empty company has no detailed reads')
    class Restarted:
        def ensure(self):return True
    db=Store(tmp_path/'resumed.sqlite3');cloud=FakeCloud()
    try:
        for kind in KINDS:
            db.set('full:'+kind,1000);db.set('scan:'+kind,1000)
        worker=Worker(cloud,Empty(),db,clock=lambda:1001,recovery=Restarted());worker.initial_scan=False
        worker.step()
        assert [kind for kind,after in scanned]==list(KINDS)
        assert all(after==0 for kind,after in scanned)
        assert any(name=='tally_bridge_claim' for name,args in cloud.calls)
    finally:db.close()


def test_stop_during_heartbeat_does_not_reopen_tally_or_claim_work(tmp_path):
    from tally_bridge.worker import Stopped
    class Flag:
        stopped=False
        def is_set(self):return self.stopped
    flag=Flag()
    class StopCloud(FakeCloud):
        def rpc(self,name,**args):
            if name=='tally_bridge_heartbeat':flag.stopped=True
            return super().rpc(name,**args)
    class Never:
        def ensure(self):raise AssertionError('Stopped bridge must not launch Tally')
    db=Store(tmp_path/'stopped.sqlite3');cloud=StopCloud()
    try:
        w=Worker(cloud,FakeTally(),db,recovery=Never());w.stop=flag
        with pytest.raises(Stopped):w.step()
        assert not any(name=='tally_bridge_claim' for name,args in cloud.calls)
    finally:db.close()


def test_package_verification_detects_tampering_and_unlisted_files(tmp_path):
    from tally_bridge import __version__
    from tally_bridge.packaging import LAUNCHER,digest,verify_package
    files=['runtime/python.exe','runtime/pythonw.exe','bridge.pyw',LAUNCHER]
    for name in files:
        p=tmp_path/name;p.parent.mkdir(exist_ok=True);p.write_bytes(b'public-test-fixture')
    manifest={'format':1,'version':__version__,'files':{name:digest(tmp_path/name) for name in files}}
    (tmp_path/'bridge-package.json').write_text(json.dumps(manifest))
    verify_package(tmp_path)
    (tmp_path/'bridge.pyw').write_text('modified')
    with pytest.raises(RuntimeError,match='verification failed'):verify_package(tmp_path)
    (tmp_path/'bridge.pyw').write_bytes(b'public-test-fixture')
    (tmp_path/'unexpected.py').write_text('unlisted')
    with pytest.raises(RuntimeError,match='verification failed'):verify_package(tmp_path)


def test_startup_task_is_interactive_per_user_and_uses_readable_runtime():
    import xml.etree.ElementTree as ET
    from tally_bridge.windows import task_xml
    root=ET.fromstring(task_xml(Path('C:/Business Apps/Vriddhi Bridge'),'S-1-5-21-test'))
    ns={'t':'http://schemas.microsoft.com/windows/2004/02/mit/task'}
    assert root.findtext('.//t:LogonType',namespaces=ns)=='InteractiveToken'
    assert root.findtext('.//t:RunLevel',namespaces=ns)=='LeastPrivilege'
    assert root.findtext('.//t:LogonTrigger/t:UserId',namespaces=ns)=='S-1-5-21-test'
    assert root.findtext('.//t:Exec/t:Command',namespaces=ns).replace('\\','/').endswith('runtime/pythonw.exe')
    args=root.findtext('.//t:Exec/t:Arguments',namespaces=ns)
    assert '-I -B' in args and 'bridge.pyw" --supervise' in args
    assert root.findtext('.//t:ExecutionTimeLimit',namespaces=ns)=='PT0S'


def test_startup_number_discovery_is_scoped_to_verified_company():
    class HTTP:
        def post(self,xml):
            assert 'VFBRIDGECOMPANYNUMBER:@@SetCmpNumStr' in xml
            return '<ENVELOPE><COMPANY NAME="Test Company"><GUID>test-company-guid</GUID><VFBRIDGECOMPANYNUMBER>(10000)</VFBRIDGECOMPANYNUMBER></COMPANY></ENVELOPE>'
    t=Tally(HTTP(),'Test Company','test-company-guid')
    assert t.startup_number()=='10000'
    t.guid='wrong'
    assert t.startup_number() is None


def test_real_tally_export_shape_reads_as_the_same_fuel_sale():
    """Tally's '*' export adds empty placeholder lists and a truncated amount-mode quantity."""
    from tally_bridge.tally import tag
    # Amount-mode sale: ₹1000 at 100.99 gives trunc3(9.90197)=9.901 LTR, so qty×rate is ₹0.09 short.
    p=dict(PAYLOAD,qty=9.901,rate=100.99,item_amt=1000,party_amt=1000)
    v=voucher(p)
    for entry in v.iter():
        if entry.tag in ("LEDGERENTRIES.LIST","ALLINVENTORYENTRIES.LIST"):
            for name in ("BANKALLOCATIONS.LIST","BILLALLOCATIONS.LIST","COSTCENTREALLOCATIONS.LIST"):
                tag(entry,name,"       ")
    tag(v,"EWAYBILLDETAILS.LIST","      ")
    assert alterable(v)
    assert business_equal(fuel_voucher(v),p)


def test_identity_error_names_the_voucher_and_missing_fields():
    v=voucher()
    v.find("ALTERID").text=" "
    with pytest.raises(TallyProblem,match=r"AlterID for HSD CREDIT #TEST1"):
        identity(v)
    v.find("ALTERID").text=" 1,234"
    assert identity(v)[2]==1234


def test_watch_request_is_scoped_to_fuel_vouchers_and_alterations():
    sent=[]
    class HTTP:
        def post(self,xml):
            sent.append(parse(xml)); return b'<ENVELOPE><BODY><DATA><COLLECTION></COLLECTION></DATA></BODY></ENVELOPE>'
    tally=Tally(HTTP(),'Test Company')
    assert tally.metadata("Voucher",42)==[]
    col=sent[0].find('.//COLLECTION')
    assert col.findtext('TYPE')=='Voucher'
    assert [m.text for m in col.findall('NATIVEMETHOD')]==['GUID','MasterID','AlterID','VoucherNumber','VoucherTypeName','Date','IsCancelled','IsOptional']
    formula=sent[0].findtext('.//SYSTEM')
    assert '$VoucherTypeName = "HSD CREDIT"' in formula and '"MS CREDIT"' in formula and '"XG CREDIT"' in formula
    assert formula.endswith('AND $AlterID > 42')


def test_masters_are_checked_live_and_case_insensitively():
    seen=[]
    class HTTP:
        def post(self,xml):
            seen.append(parse(xml).findtext('.//SYSTEM'))
            kind=parse(xml).findtext('.//COLLECTION/TYPE')
            names={'Ledger':['TEST & SONS','SALE (HSD)'],'StockItem':['High Speed Diesel'],'VoucherType':['HSD CREDIT']}[kind]
            rows=''.join(f'<{kind.upper()} NAME="{n.replace("&","&amp;")}"/>' for n in names)
            return f'<ENVELOPE><BODY><DATA><COLLECTION>{rows}</COLLECTION></DATA></BODY></ENVELOPE>'.encode()
    tally=Tally(HTTP(),'Test Company')
    assert tally.missing_masters(PAYLOAD)==[]
    assert tally.missing_masters(dict(PAYLOAD,roff=0.2))==['R/off']
    assert tally.missing_masters(dict(PAYLOAD,party='Quoted "Name"'))==['Quoted "Name"']
    assert None in seen  # a quote cannot go in a TDL formula: the full list is compared instead


def test_tally_rejection_reason_is_kept():
    with pytest.raises(TallyProblem,match="Ledger 'Test & Sons' does not exist"):
        parse("<RESPONSE><LINEERROR>Ledger 'Test &amp; Sons' does not exist!</LINEERROR><CREATED>0</CREATED></RESPONSE>")


def test_cloud_rejection_message_reaches_the_status():
    from tally_bridge.transport import CloudRejected, post
    import urllib.request
    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            self.rfile.read(int(self.headers['Content-Length']))
            self.send_response(400); self.send_header('Content-Type','application/json'); self.end_headers()
            self.wfile.write(b'{"code":"P0001","message":"Bridge credential invalid or revoked"}')
        def log_message(self,*a): pass
    server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
    thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
    try:
        opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with pytest.raises(CloudRejected,match='credential invalid or revoked'):
            post(opener,f'http://127.0.0.1:{server.server_port}',b'{}',{})
    finally: server.shutdown();server.server_close();thread.join()
    class Rejecting(FakeCloud):
        def rpc(self,name,**args):
            raise CloudRejected("Bridge credential invalid or revoked")
    class Once:
        calls=0
        def is_set(self): return self.calls>0
        def wait(self,s): self.calls+=1
    s=Store(':memory:')
    Worker(Rejecting(),FakeTally(),s).run(Once())
    assert s.get('status')['detail']=='The web app refused the bridge: Bridge credential invalid or revoked'
    from tally_bridge import __version__
    assert s.get('status')['version']==__version__  # Setup can tell a stale worker's record apart


def test_collection_export_lacks_fuel_lines_so_details_come_from_the_day_book():
    """Tally's collection export with NativeMethod * (a real #4291) has no ledger or inventory lines."""
    from tally_bridge.tally import tag
    header_only=voucher()
    for name in ("LEDGERENTRIES.LIST","ALLINVENTORYENTRIES.LIST"):
        for e in header_only.findall(name): header_only.remove(e)
    assert fuel_voucher(header_only) is None
    sent=[]
    full=voucher(alter=7)
    other=voucher(dict(PAYLOAD,id='b26d607a-40ba-4524-8fa2-c8c340855cb5',number='OTHER'),alter=7)
    class HTTP:
        def post(self,xml):
            sent.append(parse(xml))
            body=''.join('<TALLYMESSAGE>'+__import__('xml.etree.ElementTree',fromlist=['x']).tostring(v,encoding='unicode')+'</TALLYMESSAGE>' for v in (other,full))
            return ('<ENVELOPE><HEADER><VERSION>1</VERSION><STATUS>1</STATUS></HEADER><BODY><IMPORTDATA><REQUESTDATA>'+body+'</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>').encode()
    tally=Tally(HTTP(),'Test Company')
    got=tally.details([header_only])
    assert [identity(v)[0] for v in got]==[ID] and business_equal(fuel_voucher(got[0]),PAYLOAD)
    req=sent[0]
    assert req.findtext('.//TALLYREQUEST')=='Export Data' and req.findtext('.//REPORTNAME')=='Day Book'
    assert req.findtext('.//SVFROMDATE')==req.findtext('.//SVTODATE')=='20261019'
    assert req.findtext('.//SVCURRENTCOMPANY')=='Test Company'


def test_stored_xml_drops_empty_fields_but_keeps_every_value():
    from tally_bridge.tally import tag
    v=voucher()
    for name in ("VATDEALERTYPE","NARRATION","EWAYBILLDETAILS.LIST"): tag(v,name,"   ")
    xml=object_data("Voucher",v)["data"]["xml"]
    assert "VATDEALERTYPE" not in xml and "EWAYBILLDETAILS" not in xml
    kept=parse(xml).find("VOUCHER")
    assert business_equal(fuel_voucher(kept),PAYLOAD) and identity(kept)==identity(v)
    assert v.find("VATDEALERTYPE") is not None  # the live object is untouched


def test_idle_polls_ask_tally_one_small_question(store):
    seen(store,5)
    calls=[]
    class Tally(FakeTally):
        mark=100
        def voucher_mark(self): calls.append("mark"); return self.mark
        def metadata(self,kind,after,since=None): calls.append("scan"); return []
    clock=[10000.0]
    t=Tally(); w=Worker(FakeCloud(),t,store,clock=lambda:clock[0])
    w.step()  # first step: full reconciliation
    calls.clear()
    for _ in range(6):
        clock[0]+=5; w.step()
    assert calls==["mark","mark","mark"]  # every 10 s, and no voucher scan while nothing changed
    t.mark=101; clock[0]+=10; w.step()
    assert calls[-2:]==["mark","scan"]


def test_switched_off_bridge_leaves_tally_alone(store):
    class Off(FakeCloud):
        def rpc(self,name,**args):
            super().rpc(name,**args)
            return dict(ready=True,push_enabled=True,active=False) if name=="tally_bridge_heartbeat" else None
    class Untouched(FakeTally):
        def verify(self): raise AssertionError("Tally must not be read while the bridge is off")
        def voucher_mark(self): raise AssertionError("Tally must not be read while the bridge is off")
    cloud=Off()
    Worker(cloud,Untouched(),store).step()
    assert store.get("status")["health"]=="off"
    assert [n for n,_ in cloud.calls]==["tally_bridge_heartbeat","tally_bridge_claim","tally_bridge_heartbeat"]


def test_masters_found_once_are_not_asked_again():
    asked=[]
    class HTTP:
        def post(self,xml):
            asked.append(1)
            kind=parse(xml).findtext('.//COLLECTION/TYPE')
            names={'Ledger':['Test & Sons','SALE (HSD)'],'StockItem':['High Speed Diesel'],'VoucherType':['HSD CREDIT']}[kind]
            rows=''.join(f'<{kind.upper()} NAME="{n.replace("&","&amp;")}"/>' for n in names)
            return f'<ENVELOPE><BODY><DATA><COLLECTION>{rows}</COLLECTION></DATA></BODY></ENVELOPE>'.encode()
    tally=Tally(HTTP(),'Test Company')
    assert tally.missing_masters(PAYLOAD)==[] and len(asked)==3
    assert tally.missing_masters(PAYLOAD)==[] and len(asked)==3


def test_voucher_made_in_tally_after_first_sync_is_read_in_full(store):
    seen(store,5)
    p2=dict(PAYLOAD,id="c26d607a-40ba-4524-8fa2-c8c340855cb5",number="4290")
    class Tally(FakeTally):
        def metadata(self,kind,after,since=None): return [voucher(alter=5),voucher(p2,alter=6)]
        def details(self,entries): return [voucher(p2,alter=6)]
    Worker(FakeCloud(),Tally(),store).scan("Voucher")
    assert store.object_payload("Voucher",p2["id"])["app_voucher"]["number"]=="4290"


def test_readback_matches_tallys_spelling_of_the_party():
    assert business_equal(dict(PAYLOAD,party="SHYAM METALICS AND ENERGY LTD"),dict(PAYLOAD,party="Shyam Metalics and Energy Ltd"))


def test_only_vouchers_dated_today_and_yesterday_are_watched(store):
    import datetime as dt
    today=dt.date(2026,10,22)
    clock=dt.datetime(2026,10,22,15,0).timestamp()
    def dated(n,day,alter):
        return voucher(dict(PAYLOAD,id=f"{n:08d}-0000-4000-8000-000000000000",number=str(n),date=day),alter)
    old,yesterday,new=dated(1,"2026-10-20",7),dated(2,"2026-10-21",8),dated(3,"2026-10-22",9)
    asked=[]; read=[]
    class Tally(FakeTally):
        def metadata(self,kind,after,since=None):
            asked.append(since)
            return [v for v in (old,yesterday,new) if since is None or dt.date.fromisoformat(fuel_voucher(v)["date"])>=since]
        def details(self,entries): read.extend(identity(e)[0] for e in entries); return list(entries)
    store.stage([object_data("Voucher",old)]); store.uploaded(store.upload_batch())
    w=Worker(FakeCloud(),Tally(),store,clock=lambda:clock)
    w.scan("Voucher",True)
    assert asked==[dt.date(2026,10,21)]  # Tally is asked for two days, never the whole book
    assert sorted(read)==["00000002-0000-4000-8000-000000000000","00000003-0000-4000-8000-000000000000"]
    # Sales vouchers are never deleted: one that left the window is not marked deleted.
    assert not store.known("Voucher")["00000001-0000-4000-8000-000000000000"]["deleted"]


def test_metadata_drops_older_vouchers_even_if_tally_ignores_the_period():
    import datetime as dt
    sent=[]
    v_old=voucher(dict(PAYLOAD,date="2026-01-05")); v_new=voucher(dict(PAYLOAD,id='b26d607a-40ba-4524-8fa2-c8c340855cb5',date="2026-10-22"))
    class HTTP:
        def post(self,xml):
            sent.append(parse(xml))
            rows=''.join(__import__('xml.etree.ElementTree',fromlist=['x']).tostring(v,encoding='unicode') for v in (v_old,v_new))
            return ('<ENVELOPE><BODY><DATA><COLLECTION>'+rows+'</COLLECTION></DATA></BODY></ENVELOPE>').encode()
    got=Tally(HTTP(),'Test Company').metadata("Voucher",0,dt.date(2026,10,21))
    assert [fuel_voucher(v)["date"] for v in got]==["2026-10-22"]
    assert sent[0].findtext('.//SVFROMDATE')=='20261021'


def test_use_tally_version_reads_an_older_voucher_by_guid(store):
    import datetime as dt
    old=voucher(dict(PAYLOAD,date="2026-09-01"),alter=4)
    store.stage([object_data("Voucher",voucher(dict(PAYLOAD,date="2026-09-01"),alter=3))]); store.uploaded(store.upload_batch())
    class Tally(FakeTally):
        def metadata(self,kind,after,since=None): return []
        def by_guid(self,guids): assert guids==[ID]; return [old]
        def details(self,entries): return [old]
    class Cloud(FakeCloud):
        def rpc(self,name,**args):
            super().rpc(name,**args)
            return dict(ready=True,push_enabled=True,refresh_guids=[ID]) if name=="tally_bridge_heartbeat" else None
    w=Worker(Cloud(),Tally(),store,clock=lambda:dt.datetime(2026,10,22).timestamp())
    w.heartbeat()
    w.scan("Voucher",True)
    assert store.known("Voucher")[ID]["alter_id"]==4


def test_auto_revive_clears_a_stop_from_before_the_windows_restart():
    from tally_bridge.windows import stale_stop
    booted = 1_000_000.0
    assert stale_stop(booted - 60, booted, True)        # stopped before the restart: revive
    assert not stale_stop(booted + 60, booted, True)    # stopped after signing in: stay stopped
    assert not stale_stop(booted - 60, booted, False)   # auto-revive off: Stop lasts until Start
    assert not stale_stop(None, booted, True)            # never stopped


def test_startup_task_waits_for_sign_in_and_restarts_the_supervisor():
    from tally_bridge.windows import task_xml
    from xml.etree import ElementTree as ET
    ns = {"t": "http://schemas.microsoft.com/windows/2004/02/mit/task"}
    task = ET.fromstring(task_xml(r"C:\Users\x\AppData\Local\Programs\VriddhiTallyBridge\1.3.1", "S-1-5-21-1").split("\n", 1)[1])
    logon = task.find(".//t:LogonTrigger", ns)
    assert logon.findtext("t:Delay", namespaces=ns) == "PT20S" and logon.findtext("t:UserId", namespaces=ns) == "S-1-5-21-1"
    assert task.findtext(".//t:RestartOnFailure/t:Count", namespaces=ns) == "999"
    assert "--supervise" in task.findtext(".//t:Exec/t:Arguments", namespaces=ns)


class FakeWindows:
    """The Windows layer the bridge app talks to, in memory."""
    def __init__(self, tmp_path, config=None, running=False, installed=None, autostart=True):
        self.tmp, self.config, self.running, self.installed = tmp_path, config, running, installed
        self.state = {"autostart": autostart, "scheduled_task": True}
        self.calls = []
    def load_config(self):
        if not self.config: raise OSError("no credential")
        return dict(self.config)
    def save_config(self, config): self.calls.append("save"); self.config = dict(config)
    def data_dir(self): return self.tmp
    def worker_running(self): return self.running
    def startup_state(self): return dict(self.state)
    def startup_problems(self): return [] if self.state["autostart"] else ["Auto-revive is off: the bridge starts only with Start."]
    def installed_version(self): return self.installed
    def recent_log(self, n=4): return ["22 Oct 10:00:00  Bridge started"][-n:]
    def tally_processes(self): return [{"pid": 1, "exe": r"C:\Program Files\TallyPrime\tally.exe"}]
    def stop_before_pairing(self): self.calls.append("stop_before_pairing")
    def install(self, autostart=True): self.calls.append(("install", autostart)); self.state["autostart"] = autostart; return self.tmp
    def start(self, root=None): self.calls.append("start"); self.running = True
    def stop(self): self.calls.append("stop")
    def set_autostart(self, on, root=None): self.calls.append(("autostart", on)); self.state["autostart"] = on
    def set_tally_visible(self, visible, pids=None): self.calls.append(("visible", visible)); return 1
    def command(self, root, *args): return [str(root), *args]
    def detached(self, args): self.calls.append(("detached", args))


CONFIG = dict(url="https://example.supabase.co", key="k", company="Test Company", guid="test-company-guid", token="t",
              port=9000, tally_startup={"enabled": False}, keep_awake=True)


def test_app_reads_a_pairing_code_from_whatever_was_copied():
    from tally_bridge.control import Controller, Problem
    package = {"protocol": 1, "url": "https://example.supabase.co", "key": "k", "company": "VRIDDHI FUELS (2026-27)", "code": "c" * 64}
    assert Controller.read_pairing("Pairing package:\n" + json.dumps(package) + "\n")["company"] == "VRIDDHI FUELS (2026-27)"
    for bad in ("", "hello", json.dumps(dict(package, protocol=2)), json.dumps(dict(package, code=""))):
        with pytest.raises(Problem, match="not a pairing code"):
            Controller.read_pairing(bad)


def test_app_home_status_reads_the_journal_and_the_background_bridge(tmp_path):
    from tally_bridge import __version__
    from tally_bridge.control import Controller
    win = FakeWindows(tmp_path)
    assert Controller(win).snapshot()["title"] == "Not set up yet"
    win.config = CONFIG
    s = Controller(win).snapshot()
    assert (s["title"], s["tone"], s["company"]) == ("Stopped", "bad", "Test Company")
    db = Store(tmp_path / "journal.sqlite3")
    db.set("status", {"health": "online", "at": 1_800_000_000, "detail": "Watching 2 fuel vouchers", "version": __version__})
    db.stage([object_data("Voucher", voucher()), object_data("Voucher", voucher(dict(PAYLOAD, id="b26d607a-40ba-4524-8fa2-c8c340855cb5")))])
    db.close()
    win.running = True
    s = Controller(win).snapshot()
    assert (s["title"], s["tone"], s["vouchers"], s["detail"]) == ("Running", "good", 2, "Watching 2 fuel vouchers")
    db = Store(tmp_path / "journal.sqlite3"); db.set("status", {"health": "online", "at": 1, "detail": "", "version": "1.0.2"}); db.close()
    assert Controller(win).snapshot()["title"] == "Running an older version"
    assert "Auto-revive is off" in Controller(FakeWindows(tmp_path, CONFIG, autostart=False)).snapshot()["problems"][0]


def test_app_check_tally_explains_a_closed_tally_and_reports_what_it_found(tmp_path):
    from tally_bridge.control import Controller, Problem
    import socket
    probe = socket.socket(); probe.bind(("127.0.0.1", 0)); free = probe.getsockname()[1]; probe.close()
    with pytest.raises(Problem, match=f"not answering on port {free}"):
        Controller(FakeWindows(tmp_path)).check_tally(free)  # nothing listens there
    with pytest.raises(Problem, match="usually 9000"):
        Controller(FakeWindows(tmp_path)).check_tally("90a")
    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            body = self.rfile.read(int(self.headers['Content-Length'])).decode()
            if "<TYPE>Company</TYPE>" in body:
                out = '<ENVELOPE><BODY><DATA><COLLECTION><COMPANY NAME="Test Company"><GUID>g</GUID></COMPANY></COLLECTION></DATA></BODY></ENVELOPE>'
            else:
                out = '<ENVELOPE><BODY><DATA><COLLECTION>' + ET_tostring(voucher()) + '</COLLECTION></DATA></BODY></ENVELOPE>'
            self.send_response(200); self.end_headers(); self.wfile.write(out.encode())
        def log_message(self, *a): pass
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
    try:
        found = Controller(FakeWindows(tmp_path)).check_tally(server.server_port)
    finally:
        server.shutdown(); server.server_close(); thread.join()
    assert found["companies"] == ["Test Company"] and found["company"] == "Test Company"
    assert found["vouchers"] == 1 and found["exe"].endswith("tally.exe")


def ET_tostring(node):
    from xml.etree import ElementTree as ET
    return ET.tostring(node, encoding="unicode")


def test_app_start_stop_and_auto_revive_words(tmp_path):
    from tally_bridge.control import Controller, Problem
    with pytest.raises(Problem, match="Connect this PC first"):
        Controller(FakeWindows(tmp_path)).start()
    win = FakeWindows(tmp_path, CONFIG)
    ctl = Controller(win)
    assert "background" in ctl.start() and win.running
    assert "after the next Windows restart" in ctl.stop()
    assert "waits for you" in ctl.set_autostart(False) and win.calls[-1] == ("autostart", False)
    assert "stays stopped until you choose Start" in ctl.stop()
    message = ctl.install(dict(CONFIG), False)
    assert "Connected to Test Company" in message and "Auto-revive is off" in message
    assert ("install", False) in win.calls and win.calls[-1] == "start"


def test_app_window_opens_on_every_page(tmp_path, monkeypatch):
    """The real window, with a fake Windows layer (needs a display: Windows CI, or X)."""
    monkeypatch.setattr("tally_bridge.updater.fetch", lambda url, limit, timeout=60: json.dumps(RELEASES).encode())
    tk = pytest.importorskip("tkinter")
    import os, sys
    if sys.platform != "win32" and not os.environ.get("DISPLAY"):
        pytest.skip("no display")
    from tally_bridge.app import App
    from tally_bridge.control import Controller
    try:
        root = tk.Tk()
    except tk.TclError:
        pytest.skip("no display")
    try:
        root.withdraw()
        app = App(root, Controller(FakeWindows(tmp_path, CONFIG, running=True, installed="1.0.2")))
        deadline = __import__("time").monotonic() + 10
        while (app.snap is None or app.release is None) and __import__("time").monotonic() < deadline:
            root.update(); __import__("time").sleep(0.05)
        assert app.snap and app.snap["company"] == "Test Company"
        assert app.banner.winfo_manager() == "pack"  # an older background bridge, then a newer release, offer Update now
        assert "Version 9.9.9" in app.banner_text["text"]
        for page in ("home", "connect", "settings", "activity"):
            app.show(page); root.update()
        app.pair_text.insert("1.0", json.dumps({"protocol": 1, "url": "https://x.supabase.co", "key": "k", "company": "Test Company", "code": "c"}))
        app.pairing_changed()
        assert "Test Company" in app.pair_state["text"]
    finally:
        root.destroy()



def test_background_tally_is_hidden_while_loading_and_shown_if_it_never_answers(tmp_path, store):
    from tally_bridge.recovery import TallyStarting
    clock = [1000.0]
    seen = []
    exe = tmp_path / 'Tally Prime' / 'Tally.exe'; exe.parent.mkdir(); exe.write_bytes(b'test-only')
    class Closed(FakeTally):
        up = False
        def verify(self):
            if not self.up: raise ConnectionProblem('Tally closed')
            return {"name": "Test Company", "guid": "test-company-guid"}
    tally, running = Closed(), []
    from tally_bridge.recovery import Recovery
    r = Recovery(tally, {'enabled': True, 'exe': str(exe.resolve()), 'number': '10000', 'hidden': True}, store,
                 lambda: running, lambda settings: (seen.append(('launch', settings['hidden'])), 4242)[1],
                 clock=lambda: clock[0], show=lambda visible, pids: seen.append((visible, pids)))
    with pytest.raises(TallyStarting, match='in the background'):
        r.ensure()
    assert seen == [('launch', True)] and store.get('tally_hidden_pid') == 4242
    running.append({'pid': 4242, 'exe': str(exe)})
    clock[0] += 30
    with pytest.raises(TallyStarting, match='waiting for its XML server'):
        r.ensure()
    assert seen[-1] == (False, [4242])  # a window opened while loading is hidden
    clock[0] += 100  # two minutes without an answer: perhaps a prompt nobody can see
    with pytest.raises(TallyStarting, match='now shown on screen'):
        r.ensure()
    assert seen[-1] == (True, [4242]) and store.get('tally_hidden_pid') is None
    # Answering in time: it is kept hidden as the company finishes loading, then left alone.
    store.set('tally_hidden_pid', 4242); store.set('tally_last_launch', clock[0])
    tally.up = True
    r.ensure()
    assert seen[-1] == (False, [4242])
    clock[0] += 400
    count = len(seen)
    r.ensure()
    assert len(seen) == count and store.get('tally_hidden_pid') is None


def test_a_visible_tally_setting_never_hides_anything(tmp_path, store):
    from tally_bridge.recovery import Recovery, TallyStarting, startup_settings
    exe = tmp_path / 'Tally.exe'; exe.write_bytes(b'test-only')
    assert startup_settings(str(exe.resolve()), '10000')['hidden'] is False
    seen = []
    class Closed(FakeTally):
        def verify(self): raise ConnectionProblem('Tally closed')
    r = Recovery(Closed(), {'enabled': True, 'exe': str(exe.resolve()), 'number': '10000'}, store, lambda: [],
                 lambda settings: 7, show=lambda *a: seen.append(a))
    with pytest.raises(TallyStarting, match='minimized'):
        r.ensure()
    assert store.get('tally_hidden_pid') is None and not seen


def test_app_show_and_hide_tally(tmp_path):
    from tally_bridge.control import Controller, Problem
    win = FakeWindows(tmp_path, CONFIG)
    ctl = Controller(win)
    assert ctl.show_tally(True) == "Tally is on screen." and win.calls[-1] == ("visible", True)
    assert "second copy" in ctl.show_tally(False)
    win.tally_processes = lambda: []
    with pytest.raises(Problem, match="not running"):
        ctl.show_tally(True)


def guard_rig(store):
    from tally_bridge.guard import TallyGuard
    world = {"procs": [], "now": 1000.0, "shown": [], "closed": [], "log": []}
    g = TallyGuard(store, lambda: list(world["procs"]), lambda visible, pids: world["shown"].append((visible, pids)),
                   lambda pid: world["closed"].append(pid), world["log"].append, clock=lambda: world["now"])
    return g, world


def test_opening_tally_again_brings_the_background_tally_forward_and_closes_the_copy(store):
    g, w = guard_rig(store)
    w["procs"] = [{"pid": 100, "parent": 4}]           # the bridge's background Tally
    store.set("tally_hidden_pid", 100)
    g.poll()                                            # first look: nothing is new
    assert not w["shown"] and not w["closed"]
    w["procs"].append({"pid": 200, "parent": 8})        # an employee clicks the Tally icon
    w["now"] += 1; g.poll()
    assert w["shown"] == [(True, [100])] and w["closed"] == [200]
    assert store.get("tally_hidden_pid") is None        # employees use it now: never hidden again
    w["procs"] = [{"pid": 100, "parent": 4}]            # the copy closed as asked
    w["now"] += 1; g.poll()
    assert "one Tally is open" in w["log"][-1] and w["closed"] == [200]


def test_a_tally_child_process_and_a_first_tally_are_left_alone(store):
    g, w = guard_rig(store)
    g.poll()
    w["procs"] = [{"pid": 100, "parent": 4}]            # Tally opened when none was running
    w["now"] += 1; g.poll()
    w["procs"].append({"pid": 101, "parent": 100})      # started by Tally itself
    w["now"] += 1; g.poll()
    assert not w["shown"] and not w["closed"]


def test_a_copy_that_will_not_close_is_reported_never_forced(store):
    g, w = guard_rig(store)
    w["procs"] = [{"pid": 100, "parent": 4}]
    g.poll()
    w["procs"].append({"pid": 200, "parent": 8})        # an employee's own Tally was already visible
    for _ in range(25):
        w["now"] += 1; g.poll()
    assert w["shown"] == [(True, [100])] and set(w["closed"]) == {200} and len(w["closed"]) <= 21
    assert "Two copies of Tally are open" in store.get("tally_notice")["text"]
    worker = Worker(FakeCloud(), FakeTally(), store)
    assert worker.watching().startswith("Two copies of Tally are open")
    w["procs"] = [{"pid": 100, "parent": 4}]            # someone closed one
    w["now"] += 1; g.poll()
    assert store.get("tally_notice") is None


def test_bridge_exit_shows_a_tally_it_had_hidden(tmp_path):
    from tally_bridge.cli import reveal_hidden_tally
    db = Store(tmp_path / "journal.sqlite3"); db.set("tally_hidden_pid", 4242); db.close()
    calls = []
    class Win:
        def data_dir(self): return tmp_path
        def set_tally_visible(self, visible, pids=None): calls.append((visible, pids))
        def log(self, message): calls.append(message)
    reveal_hidden_tally(Win())
    assert calls[0] == (True, [4242])
    db = Store(tmp_path / "journal.sqlite3"); assert db.get("tally_hidden_pid") is None; db.close()


def test_closed_tally_is_a_calm_wait_never_an_error_or_a_launch(store):
    from tally_bridge.recovery import Recovery, TallyWaiting
    from tally_bridge.tally import CompanyNotOpen
    launched = []
    class Closed(FakeTally):
        def verify(self): raise ConnectionProblem("Tally closed")
    running = []
    r = Recovery(Closed(), {"enabled": False}, store, lambda: running, launched.append)
    with pytest.raises(TallyWaiting, match="Tally is closed. Vouchers from the web app wait"):
        r.ensure()
    running.append({"pid": 5, "exe": "tally.exe", "parent": 1})
    with pytest.raises(TallyWaiting, match="starting or busy"):
        r.ensure()
    class SelectCompany(FakeTally):  # e.g. the export script just started Tally
        def verify(self): raise CompanyNotOpen("Open the exact company")
    with pytest.raises(TallyWaiting, match="sync starts once Test Company is loaded"):
        Recovery(SelectCompany(), {"enabled": False}, store, lambda: [], launched.append).ensure()
    assert not launched  # the bridge never opens Tally unless told to


def test_waiting_for_tally_keeps_queued_vouchers_untouched_and_polls_promptly(store):
    from tally_bridge.recovery import TallyWaiting
    cloud = FakeCloud()
    class Closed:
        def ensure(self): raise TallyWaiting("Tally is closed. Vouchers from the web app wait and post when Tally is next opened.")
    class Once:
        waits = []
        def is_set(self): return len(self.waits) >= 2
        def wait(self, s): self.waits.append(s)
    stop = Once()
    Worker(cloud, FakeTally(), store, recovery=Closed()).run(stop)
    assert all(s < 7 for s in stop.waits)            # no growing back-off while Tally is simply closed
    assert store.get("status")["health"] == "tally_closed"
    assert not any(name in ("tally_bridge_claim", "tally_bridge_finish") for name, _ in cloud.calls)


def test_export_script_pauses_every_tally_request(store):
    cloud = FakeCloud()
    class Untouched(FakeTally):
        def verify(self): raise AssertionError("Tally must not be touched while the export script runs")
        def metadata(self, *a, **k): raise AssertionError("Tally must not be touched while the export script runs")
    w = Worker(cloud, Untouched(), store, paused=lambda: True)
    w.step()
    assert store.get("status")["health"] == "paused"
    assert [n for n, _ in cloud.calls] == ["tally_bridge_heartbeat", "tally_bridge_heartbeat"]


def test_company_closed_mid_post_leaves_the_job_for_later_not_failed(store):
    from tally_bridge.tally import CompanyNotOpen
    class Cloud(FakeCloud):
        def rpc(self, name, **args):
            r = super().rpc(name, **args)
            return job() if name == "tally_bridge_claim" else r
    class Closing(FakeTally):
        def verify(self): raise CompanyNotOpen("Open the exact company")
    cloud = Cloud()
    w = Worker(cloud, Closing(), store)
    with pytest.raises(CompanyNotOpen):
        w.claim()
    assert not any(name == "tally_bridge_finish" for name, _ in cloud.calls)


def test_export_script_is_recognised_by_its_autohotkey_window_title():
    from tally_bridge.windows import is_tally_script
    assert is_tally_script(r"C:\Users\Office\Desktop\VriddhiTally.ahk - AutoHotkey v2.0.18")
    assert is_tally_script(r"C:\Scripts\VriddhiTally.exe")
    assert not is_tally_script(r"C:\Users\Office\Documents\Clipboard.ahk - AutoHotkey v2.0")


# ---- 1.5.0: Tally edits are read in more layouts, or the reason is shown --------------------

def test_round_off_spelling_case_and_a_blank_rate_still_read_as_the_fuel_sale():
    from tally_bridge.tally import read_fuel
    p = dict(PAYLOAD, item_amt=999.8, party_amt=1000, roff=0.2)
    v = voucher(p)
    for e in v.iter("LEDGERENTRIES.LIST"):
        if e.findtext("LEDGERNAME") == "R/off": e.find("LEDGERNAME").text = "ROUND OFF"
        else: e.find("LEDGERNAME").text = "TEST & SONS"  # Tally keeps names in any capitalisation
    v.find(".//ALLINVENTORYENTRIES.LIST/RATE").text = ""
    got, why = read_fuel(v)
    assert why is None and business_equal(got, dict(p, rate=99.98))


def test_accounting_voucher_view_reads_the_stock_line_inside_the_sales_ledger():
    import xml.etree.ElementTree as ET
    from tally_bridge.tally import tag
    v = voucher()
    inv = v.find("ALLINVENTORYENTRIES.LIST")
    v.remove(inv)
    sales = ET.SubElement(v, "LEDGERENTRIES.LIST")
    tag(sales, "LEDGERNAME", "SALE (HSD)"); tag(sales, "AMOUNT", "1000.00")
    alloc = ET.SubElement(sales, "INVENTORYALLOCATIONS.LIST")
    for k in ("STOCKITEMNAME", "RATE", "AMOUNT", "BILLEDQTY"):
        tag(alloc, k, inv.findtext(k))
    assert business_equal(fuel_voucher(v), PAYLOAD)
    assert not alterable(v)  # read, but the web editor leaves such a voucher to Tally


def test_an_edit_the_app_cannot_hold_carries_its_reason():
    import xml.etree.ElementTree as ET
    from tally_bridge.tally import tag
    v = voucher(alter=3)
    extra = ET.SubElement(v, "LEDGERENTRIES.LIST")
    tag(extra, "LEDGERNAME", "Freight"); tag(extra, "AMOUNT", "50.00")
    data = object_data("Voucher", v)["data"]
    assert data["app_voucher"] is None and data["unreadable"].startswith("Extra ledger in Tally: Freight")
    v.find(".//ALLINVENTORYENTRIES.LIST/STOCKITEMNAME").text = "Lube Oil"
    assert "Stock item is Lube Oil" in object_data("Voucher", v)["data"]["unreadable"]
    assert "unreadable" not in object_data("Voucher", voucher())["data"]


def test_a_readback_the_day_book_has_not_returned_yet_is_retried_not_flagged(store, monkeypatch):
    from tally_bridge.tally import NotReadYet
    from tally_bridge.worker import READ_TRIES
    monkeypatch.setattr(Tally, "settle", 0)
    found = voucher(alter=4)
    class HTTP:
        def post(self, xml):
            req = parse(xml)
            if req.findtext(".//REPORTNAME") == "Day Book":  # Tally lists it, the Day Book does not return it yet
                return b"<ENVELOPE><BODY><IMPORTDATA><REQUESTDATA></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>"
            body = __import__("xml.etree.ElementTree", fromlist=["x"]).tostring(found, encoding="unicode")
            return ("<ENVELOPE><BODY><DATA><COLLECTION>" + body + "</COLLECTION></DATA></BODY></ENVELOPE>").encode()
    with pytest.raises(NotReadYet):
        Tally(HTTP(), "Test Company").lookup(PAYLOAD)
    class Cloud(FakeCloud):
        attempts = 1
        def rpc(self, name, **args):
            r = super().rpc(name, **args)
            return dict(job(attempts=self.attempts), recover_only=True) if name == "tally_bridge_claim" else r
    class Slow(FakeTally):
        def lookup(self, p): raise NotReadYet("HSD CREDIT #TEST1 is in Tally but could not be read yet")
    cloud = Cloud()
    w = Worker(cloud, Slow(), store)
    assert w.claim() and not any(n == "tally_bridge_finish" for n, _ in cloud.calls)  # checked again after its lease
    cloud.attempts = READ_TRIES
    w.claim()
    finish = [a for n, a in cloud.calls if n == "tally_bridge_finish"]
    assert finish and finish[0]["p_state"] == "conflict" and "Recheck Tally" in finish[0]["p_detail"]


# ---- 1.5.0: updates from inside the app -----------------------------------------------------

RELEASES = [
    {"tag_name": "tally-bridge-v9.9.9", "draft": False, "assets": [
        {"name": "VriddhiTallyBridge-Windows.zip", "browser_download_url": "https://github.com/x/9.9.9.zip"},
        {"name": "SHA256SUMS.txt", "browser_download_url": "https://github.com/x/9.9.9.sums"}]},
]


def test_newest_release_is_the_highest_complete_one_above_this_version():
    from tally_bridge.updater import newest
    assets = RELEASES[0]["assets"]
    releases = [
        {"tag_name": "tally-bridge-v1.10.0", "assets": assets},
        {"tag_name": "tally-bridge-v1.9.9", "assets": assets},
        {"tag_name": "tally-bridge-v2.0.0", "draft": True, "assets": assets},  # not published
        {"tag_name": "tally-bridge-v3.0.0", "assets": assets[:1]},  # no checksums
        {"tag_name": "ledger-v9.0.0", "assets": assets},
    ]
    assert newest(releases, "1.5.0")["version"] == "1.10.0"
    assert newest(releases, "1.10.0") is None
    assert newest({"message": "API rate limit exceeded"}, "1.5.0") is None


def fake_package(root, version):
    from tally_bridge.packaging import LAUNCHER, digest
    files = ["runtime/python.exe", "runtime/pythonw.exe", "bridge.pyw", LAUNCHER]
    for name in files:
        p = root / name; p.parent.mkdir(parents=True, exist_ok=True); p.write_bytes(b"public-test-fixture")
    (root / "bridge-package.json").write_text(json.dumps({"format": 1, "version": version,
                                                         "files": {n: digest(root / n) for n in files}}))


def release_zip(tmp_path, version, extra=None):
    import hashlib, zipfile
    src = tmp_path / "src" / "VriddhiTallyBridge"
    fake_package(src, version)
    archive = tmp_path / "release.zip"
    with zipfile.ZipFile(archive, "w") as z:
        for f in src.rglob("*"):
            # Windows PowerShell 5 stores backslash paths; both are accepted.
            z.write(f, "VriddhiTallyBridge\\" + str(f.relative_to(src)).replace("/", "\\"))
        if extra:
            z.writestr(extra, "x")
    data = archive.read_bytes()
    return data, hashlib.sha256(data).hexdigest()


def test_update_download_is_checked_against_its_checksum_and_manifest(tmp_path):
    from tally_bridge.updater import download
    data, sha = release_zip(tmp_path, "9.9.9")
    release = {"version": "9.9.9", "zip": "z", "sums": "s"}
    get = lambda url, limit, timeout=60: (sha + "  VriddhiTallyBridge-Windows.zip\n").encode() if url == "s" else data
    root = download(release, tmp_path / "updates" / "9.9.9", get)
    assert (root / "bridge.pyw").is_file() and root.name == "VriddhiTallyBridge"
    bad = lambda url, limit, timeout=60: ("0" * 64 + "  VriddhiTallyBridge-Windows.zip").encode() if url == "s" else data
    with pytest.raises(RuntimeError, match="checksum"):
        download(release, tmp_path / "updates" / "9.9.9", bad)
    with pytest.raises(RuntimeError, match="verification failed"):  # a package claiming another version
        download(dict(release, version="9.9.8"), tmp_path / "updates" / "9.9.8", get)
    data, sha = release_zip(tmp_path / "evil", "9.9.9", extra="../outside.txt")
    with pytest.raises(RuntimeError, match="unsafe path"):
        download(release, tmp_path / "updates" / "9.9.9", get)
    assert not (tmp_path / "updates" / "outside.txt").exists()


def test_update_hands_over_to_the_new_version_which_switches_the_bridge_without_tally(tmp_path, monkeypatch):
    from tally_bridge.control import Controller, Problem
    win = FakeWindows(tmp_path, CONFIG, running=True, autostart=False)
    ctl = Controller(win)
    monkeypatch.setattr("tally_bridge.updater.fetch", lambda url, limit, timeout=60: json.dumps(RELEASES).encode())
    release = ctl.check_update()
    assert release["version"] == "9.9.9"
    monkeypatch.setattr("tally_bridge.updater.download", lambda release, folder, get: tmp_path / "pkg")
    assert "switches the bridge over" in ctl.download_update(release)
    assert win.calls[-1] == ("detached", [str(tmp_path / "pkg"), "--finish-update"])
    message = ctl.switch_to_this()  # what the new version runs first; no Tally request at all
    assert "Updated to version" in message
    assert win.calls[-3:] == ["stop_before_pairing", ("install", False), "start"]  # auto-revive left as it was
    def offline(url, limit, timeout=60): raise OSError("offline")
    monkeypatch.setattr("tally_bridge.updater.fetch", offline)
    with pytest.raises(Problem, match="GitHub did not answer"):
        ctl.check_update()


# ---- 1.5.0: the edge cases between the app and Tally -----------------------------------------

DAY = __import__("datetime").datetime(2026, 10, 20, 12).timestamp()  # PAYLOAD is dated the 19th: watched


class Book(FakeTally):
    """A Tally with a voucher book: metadata lists it, by_guid finds any, details reads it whole."""
    def __init__(self, *vouchers):
        super().__init__()
        self.book, self.asked = {identity(v)[0]: v for v in vouchers}, []
    def metadata(self, kind="Voucher", after=0, since=None):
        from tally_bridge.tally import series_of, voucher_date
        return [v for v in self.book.values() if series_of(v) and identity(v)[2] > after
                and (since is None or voucher_date(v) >= since)]
    def by_guid(self, guids):
        self.asked.append(sorted(guids))
        return [self.book[g] for g in guids if g in self.book]
    def details(self, entries):
        return [self.book[identity(e)[0]] for e in entries if identity(e)[0] in self.book]


def staged(store):
    return [json.loads(r["payload"]) for r in store.upload_batch()]


def test_a_voucher_deleted_in_tally_is_sent_as_deleted(store):
    seen(store, 3)
    w = Worker(FakeCloud(), Book(), store, clock=lambda: DAY)
    w.scan("Voucher")
    out = staged(store)
    assert [(o["guid"], o["deleted"], o["alter_id"]) for o in out] == [(ID, True, 3)]
    assert out[0]["data"]["number"] == "TEST1"  # what was stored about it stands
    store.uploaded(store.upload_batch())
    w.scan("Voucher")
    assert not staged(store)  # told once


def test_a_voucher_re_dated_or_re_typed_in_tally_is_read_again_not_lost(store):
    from tally_bridge.tally import tag
    seen(store, 3)
    older = voucher(dict(PAYLOAD, date="2026-09-30"), alter=4)  # re-dated before the watched days
    book = Book(older)
    Worker(FakeCloud(), book, store, clock=lambda: DAY).scan("Voucher")
    assert book.asked == [[ID]]
    out = staged(store)
    assert out[-1]["data"]["app_voucher"]["date"] == "2026-09-30" and not out[-1]["deleted"]
    store.uploaded(store.upload_batch())
    # Moved to a cash Sales voucher in Tally: sent as gone from the fuel vouchers.
    sale = voucher(dict(PAYLOAD), alter=5)
    sale.find("VOUCHERTYPENAME").text = "Sales"
    sale.set("VCHTYPE", "Sales")
    store.stage([object_data("Voucher", voucher(alter=4))]); store.uploaded(store.upload_batch())
    Worker(FakeCloud(), Book(sale), store, clock=lambda: DAY).scan("Voucher")
    out = staged(store)
    assert out[-1]["deleted"] and out[-1]["data"]["voucher_type"] == "Sales"
    assert store.count("Voucher") == 0  # and it is not looked for again


def test_a_refresh_request_is_read_at_most_once_a_minute(store):
    clock = [DAY]
    w = Worker(FakeCloud(), Book(), store, clock=lambda: clock[0])
    w.config = {"refresh_guids": ["gone-guid"]}
    assert w.refresh_due() and not w.refresh_due()
    clock[0] += 61
    assert w.refresh_due()
    w.config = {"refresh_guids": []}
    assert not w.refresh_due()


def test_older_vouchers_altered_in_tally_are_caught_every_half_hour(store):
    clock = [DAY]
    old = voucher(dict(PAYLOAD, date="2026-10-01", number="OLD1", id="c26d607a-40ba-4524-8fa2-c8c340855cb5"), alter=40)
    book = Book(old)
    w = Worker(FakeCloud(), book, store, clock=lambda: clock[0])
    store.set("cursor:Voucher", 40)
    w.pending_mark = 1
    w.wide_check()  # first time: from now on
    assert store.get("cursor:wide") == 40 and not staged(store)
    book.book[identity(old)[0]] = voucher(dict(PAYLOAD, date="2026-10-01", number="OLD1", id="c26d607a-40ba-4524-8fa2-c8c340855cb5", qty=12, item_amt=1200, party_amt=1200), alter=41)
    clock[0] += 600; w.pending_mark = 2
    w.wide_check()
    assert not staged(store)  # not yet half an hour
    clock[0] += 1200
    w.wide_check()
    out = staged(store)
    assert out[0]["data"]["app_voucher"]["qty"] == "12.000" and store.get("cursor:wide") == 41
    store.uploaded(store.upload_batch())
    clock[0] += 1800  # nothing changed in Tally since: not even asked
    book.metadata = lambda *a, **k: (_ for _ in ()).throw(AssertionError("asked Tally"))
    w.wide_check()


def test_a_refused_posting_that_changed_nothing_is_offered_for_correction(store):
    from tally_bridge.tally import Rejected
    class Refusing(FakeTally):
        def import_voucher(self, p, existing=None):
            self.imports += 1
            raise Rejected("Tally rejected the request: Voucher date is before books beginning")
    class Cloud(FakeCloud):
        def rpc(self, name, **args):
            r = super().rpc(name, **args)
            return job() if name == "tally_bridge_claim" else r
    cloud = Cloud()
    Worker(cloud, Refusing(), store).claim()
    finish = [a for n, a in cloud.calls if n == "tally_bridge_finish"][0]
    assert finish["p_state"] == "error" and finish["p_result"] == {"not_written": True}
    assert "before books beginning" in finish["p_detail"] and "Nothing was posted" in finish["p_detail"]
    # Refused, yet a voucher appeared: never offered for re-posting.
    class Appeared(Refusing):
        def import_voucher(self, p, existing=None):
            self.found = voucher(dict(p, party="Someone else"), 3)
            raise Rejected("Tally rejected the request")
    cloud = Cloud()
    Worker(cloud, Appeared(), store).claim()
    finish = [a for n, a in cloud.calls if n == "tally_bridge_finish"][0]
    assert finish["p_state"] == "conflict" and "Recheck Tally" in finish["p_detail"]


def test_a_company_closed_just_before_posting_goes_back_to_the_queue(store):
    from tally_bridge.tally import NotSent
    class Closing(FakeTally):
        def import_voucher(self, p, existing=None): raise NotSent("Open the exact company")
    class Cloud(FakeCloud):
        def rpc(self, name, **args):
            r = super().rpc(name, **args)
            return job() if name == "tally_bridge_claim" else r
    cloud = Cloud()
    Worker(cloud, Closing(), store).claim()
    finish = [a for n, a in cloud.calls if n == "tally_bridge_finish"][0]
    assert finish["p_state"] == "retry" and finish["p_result"] == {"not_written": True}
    # And the real Tally raises it before sending anything when the company is not open.
    from tally_bridge.tally import CompanyNotOpen
    t = Tally(None, "Test Company")
    t.verify = lambda: (_ for _ in ()).throw(CompanyNotOpen("Open the exact company"))
    with pytest.raises(NotSent):
        t.import_voucher(PAYLOAD)


def test_an_edit_made_while_the_bridge_claims_it_is_left_to_its_new_job(store):
    from tally_bridge.transport import CloudRejected
    class Cloud(FakeCloud):
        def rpc(self, name, **args):
            if name == "tally_bridge_begin_write": raise CloudRejected("Voucher changed or job lease expired")
            return super().rpc(name, **args)
    tally = FakeTally()
    Worker(Cloud(), tally, store).voucher(job())
    assert tally.imports == 0 and store.written("job-1") is None


def test_a_tally_voucher_the_editor_cannot_alter_is_refused_before_posting(store):
    import xml.etree.ElementTree as ET
    from tally_bridge.tally import tag
    found = voucher(alter=7)
    cc = ET.SubElement(found.find("ALLINVENTORYENTRIES.LIST"), "COSTCENTREALLOCATIONS.LIST")
    tag(cc, "NAME", "Pump 2"); tag(cc, "AMOUNT", "1000.00")
    cloud, tally = FakeCloud(), FakeTally(found)
    p = dict(PAYLOAD, guid=ID, expected_alter=7, qty=11, item_amt=1100, party_amt=1100)
    with pytest.raises(TallyProblem, match="cannot change safely"):
        Worker(cloud, tally, store).voucher(job(p))
    assert tally.imports == 0 and not any(n == "tally_bridge_begin_write" for n, _ in cloud.calls)


def test_one_voucher_the_web_app_refuses_is_named_and_the_rest_flow(store):
    class Cloud(FakeCloud):
        def rpc(self, name, **args):
            r = super().rpc(name, **args)
            if name == "tally_bridge_ingest":
                return {"unmatched": [], "rejected": [{"guid": ID, "error": "HSD CREDIT #TEST1: Invalid fuel voucher"}]}
            return r
    seen(store, 1)
    store.stage([object_data("Voucher", voucher(alter=2))])
    w = Worker(Cloud(), FakeTally(), store)
    w.flush()
    assert store.pending() == 0
    assert "Not applied in the web app: HSD CREDIT #TEST1: Invalid fuel voucher" in w.watching()
