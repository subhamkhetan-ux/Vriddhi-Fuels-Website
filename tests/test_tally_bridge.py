"""Failure/restart behaviour and the XML protocol, with synthetic financial data."""
import copy
import json
from pathlib import Path
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from tally_bridge.store import Store
from tally_bridge.tally import Tally, TallyProblem, business_equal, export_request, fuel_voucher, identity, object_data, parse, sanitize_report, voucher_xml
from tally_bridge.transport import Cloud, ConnectionProblem, LocalTally
from tally_bridge.worker import Worker

ROOT = Path(__file__).resolve().parents[1]
ID = "d26d607a-40ba-4524-8fa2-c8c340855cb5"
PAYLOAD = dict(id=ID, guid=None, expected_alter=None, series="hsd", number="TEST1", date="2026-10-19", party="Test & Sons",
               vehicle="OD01A1234", qty=10, rate=100, item_amt=1000, party_amt=1000, roff=0, gst={})


def voucher(p=None, alter=1):
    node = parse(voucher_xml("Test Company", p or PAYLOAD)).find(".//VOUCHER")
    from tally_bridge.tally import tag
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
    def __init__(self, found=None, lose_response=False):
        self.found, self.lose_response, self.imports = found, lose_response, 0
    def verify(self):
        return {"name":"Test Company","guid":"test-company-guid"}
    def lookup(self, p):
        return self.found
    def import_voucher(self, p, existing=None):
        self.imports += 1
        self.found = voucher(p, 12)
        if self.lose_response:
            raise ConnectionProblem("Tally accepted the voucher, response lost")


@pytest.fixture
def store(tmp_path):
    s = Store(tmp_path / "journal.sqlite3")
    for kind, names in {"Ledger":["Test & Sons", "R/off", "SALE (HSD)"], "StockItem":["High Speed Diesel"], "VoucherType":["HSD CREDIT"]}.items():
        s.stage([dict(kind=kind, guid=kind+str(i), alter_id=1, master_id=i+1, data={"name":name}) for i,name in enumerate(names)])
    s.uploaded(s.upload_batch())
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
    with pytest.raises(TallyProblem,match="different invoice"):
        Worker(FakeCloud(),tally,store).voucher(job())
    p = dict(PAYLOAD,guid=ID,expected_alter=4)
    with pytest.raises(TallyProblem,match="newer edit"):
        Worker(FakeCloud(),tally,store).voucher(job(p))
    assert tally.imports == 0


def test_supported_alter_preserves_unrelated_tally_fields(store):
    from tally_bridge.tally import tag
    original = voucher()
    tag(original, "NARRATION", "Keep this accountant note")
    p = dict(PAYLOAD,guid=ID,expected_alter=1,qty=11,item_amt=1100,party_amt=1100)
    altered = parse(voucher_xml("Test Company",p,original)).find(".//VOUCHER")
    assert altered.attrib["ACTION"] == "Alter"
    assert altered.attrib["TAGVALUE"] == ID
    assert altered.findtext("NARRATION") == "Keep this accountant note"
    assert business_equal(fuel_voucher(altered),p)
    tally = FakeTally(original)
    Worker(FakeCloud(),tally,store).voucher(job(p))
    assert tally.imports == 1


def test_local_upload_queue_survives_reopen_and_lost_cloud_response(tmp_path):
    path = tmp_path/"journal.sqlite3"
    s = Store(path)
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


def test_rejected_or_incomplete_collection_does_not_advance_cursor(store):
    class Partial(FakeTally):
        def metadata(self,kind,after): return [voucher()]
        def objects(self,kind,ids): return []
    with pytest.raises(TallyProblem,match="incomplete batch"):
        Worker(FakeCloud(),Partial(),store).scan("Voucher",True)
    assert store.get("cursor:Voucher") is None
    assert not store.known("Voucher")


def test_metadata_watermark_does_not_skip_an_intervening_edit(store):
    class ChangedDuringRead(FakeTally):
        def metadata(self,kind,after): return [voucher(alter=10)]
        def objects(self,kind,ids): return [voucher(alter=12)]
    Worker(FakeCloud(),ChangedDuringRead(),store).scan("Voucher",True)
    assert store.get("cursor:Voucher") == 10  # another voucher at AlterID 11 must be fetched next time
    assert store.known("Voucher")[ID]["alter_id"] == 12


def test_pairing_bootstrap_republishes_unchanged_data_and_binding_prevents_cross_company(store):
    store.stage([object_data("Voucher",voucher())]); store.uploaded(store.upload_batch())
    class Unchanged(FakeTally):
        def metadata(self,kind,after): return [voucher()]
        def objects(self,kind,ids): raise AssertionError("Unchanged object should use the verified local copy")
    Worker(FakeCloud(),Unchanged(),store).scan("Voucher",True,force_upload=True)
    assert len(store.upload_batch()) == 1
    wrong = FakeTally(); wrong.guid="wrong-company-guid"
    with pytest.raises(TallyProblem,match="different company"):
        Worker(FakeCloud(),wrong,store)


def test_full_scan_detects_deletion_but_restore_is_blocked(store):
    p2=dict(PAYLOAD,id="a26d607a-40ba-4524-8fa2-c8c340855cb5",number="TEST2")
    v1,v2=voucher(),voucher(p2)
    store.stage([object_data("Voucher",v1),object_data("Voucher",v2)])
    store.uploaded(store.upload_batch())
    class Deleted(FakeTally):
        def metadata(self,kind,after): return [v1]
        def objects(self,kind,ids): return []
    Worker(FakeCloud(),Deleted(),store).scan("Voucher",True)
    assert store.known("Voucher")[p2["id"]]["deleted"]
    v1.find("ALTERID").text="0"
    with pytest.raises(TallyProblem):
        Worker(FakeCloud(),Deleted(),store).scan("Voucher",True)


def test_xml_escaping_amount_rounding_and_complex_vouchers():
    from tally_bridge.tally import tag
    p=dict(PAYLOAD,party='A & B <Ltd> "Test"',rate=100.74,qty=9.927,item_amt=1000,party_amt=1000)
    v=voucher(p)
    assert fuel_voucher(v)["party"] == p["party"]
    assert business_equal(fuel_voucher(v),p)
    tag(v,"BILLALLOCATIONS.LIST","")
    assert fuel_voucher(v) is None
    with pytest.raises(TallyProblem,match="allocations"):
        voucher_xml("Test Company",p,v)
    with pytest.raises(TallyProblem,match="Unsafe XML"):
        parse('<!DOCTYPE a [<!ENTITY x SYSTEM "file:///etc/passwd">]><a>&x;</a>')
    with pytest.raises(TallyProblem): parse('<ENVELOPE><COLLECTION>')
    assert parse('<X>A&#4;B</X>').findtext('X')=='AB'


def test_xml_accounting_matches_existing_web_exporter_for_all_three_products():
    html=(ROOT/'tally/index.html').read_text()
    pure=html.split('var TALLY = {',1)[1].split('// ---- Tally file parsers',1)[0]
    script='var TALLY = {'+pure+'\nconst p=JSON.parse(process.argv[1]);console.log(buildEnvelope("Test Company",[p]));'
    for series in ('hsd','ms','xg'):
        p=dict(PAYLOAD,series=series,qty=10.333,rate=101.25,item_amt=1046.22,party_amt=1046,roff=-0.22,
               gst=dict(gstin='21TESTGSTIN',reg_type='Regular',state='Odisha',place_of_supply='Odisha',country='India',pincode='768001'))
        web=dict(seriesKey=series,number=p['number'],dateISO=p['date'],party=p['party'],vehicle=p['vehicle'],qty=p['qty'],
                 rate=p['rate'],itemAmt=p['item_amt'],partyAmt=p['party_amt'],roff=p['roff'],
                 gst=dict(gstin='21TESTGSTIN',regType='Regular',state='Odisha',place='Odisha',country='India',pincode='768001'))
        js=subprocess.run(['node','-e',script,json.dumps(web)],text=True,capture_output=True,check=True).stdout
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
    with pytest.raises(TallyProblem): sanitize_report('<RESPONSE><LINEERROR>No report</LINEERROR></RESPONSE>')


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
