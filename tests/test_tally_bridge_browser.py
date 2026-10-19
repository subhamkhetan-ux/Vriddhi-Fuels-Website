"""The real Tally web app with a synthetic Supabase boundary, on desktop/mobile."""
import functools
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import shutil
import threading

import pytest

ROOT=Path(__file__).resolve().parents[1]
MOCK=r"""
window.__VF_TEST_SUPABASE_FACTORY = () => {
  window.bridgeCalls=[]; window.bridgeConfigured=true;
  const settings={company:'VRIDDHI FUELS (2026-27)',auto_clear:false};
  const series=[{key:'hsd',baseline:'10',rate:100},{key:'ms',baseline:'MS20',rate:110},{key:'xg',baseline:'XG1',rate:106}];
  let authCallback;
  const client={
    from(table){let single=false; const q={select(){return q},eq(){return q},order(){return q},range(){return q},limit(){return q},single(){single=true;return q},
      then(resolve){const data=table==='tally_settings'?settings:table==='tally_series'?series:[];return Promise.resolve({data,error:null}).then(resolve)}};return q},
    rpc(name,args){window.bridgeCalls.push({name,args});
      if(window.bridgeNetworkError)return Promise.resolve({error:{message:'Connection unavailable'}});
      if(!window.bridgeConfigured)return Promise.resolve({error:{code:'PGRST202',message:'function tally_bridge_status does not exist'}});
      if(name==='tally_bridge_status')return Promise.resolve({data:{config:{active:true,ready:true,push_enabled:true},device:{label:'Office PC',last_seen:'2026-01-01T00:00:00Z',health:'online'},pending:2,attention:1,objects:1247,jobs:[{id:'job1',kind:'voucher',number:'101',voucher_id:'v1',state:'conflict',detail:'Tally and web versions differ.',updated_at:new Date().toISOString()}]}});
      if(name==='tally_bridge_pair_code')return Promise.resolve({data:{company:settings.company,code:'c'.repeat(64)}});
      if(name==='tally_bridge_report')return Promise.resolve({data:{key:'report1',state:'pending',fetched_at:'2026-10-18T12:00:00Z',content:window.reportFixture || '<table><tr><td>Test Debtor</td><td>₹ 1,234.00</td></tr></table><script>parent.pwned=true</script><img src="https://attacker.invalid/leak">',params:args}});
      if(name==='tally_bridge_browse')return Promise.resolve({data:[{guid:'g1',updated_at:new Date().toISOString(),deleted:false,data:{number:'101',party:'Example Customer',voucher_type:'Sales'}}]});
      return Promise.resolve({data:null,error:null});
    },
    channel(){return {on(){return this},subscribe(){return this}}},
    auth:{onAuthStateChange(cb){authCallback=cb;window.testSignOut=()=>cb('SIGNED_OUT')},getSession(){return Promise.resolve({data:{session:{user:{id:'test-user',email:'test@vriddhi.local'}}}})},signOut(){authCallback('SIGNED_OUT');return Promise.resolve({})}}
  };return client;
};
"""


@pytest.fixture(scope="module")
def server():
    class Handler(SimpleHTTPRequestHandler):
        def log_message(self,*args): pass
    s=ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Handler,directory=str(ROOT)))
    thread=threading.Thread(target=s.serve_forever,daemon=True);thread.start()
    yield f'http://127.0.0.1:{s.server_port}'
    s.shutdown();s.server_close();thread.join()


@pytest.fixture(scope="module")
def browser():
    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        executable=shutil.which('chromium') or shutil.which('chromium-browser')
        b=p.chromium.launch(executable_path=executable,headless=True,args=['--no-sandbox'])
        yield b
        b.close()


@pytest.mark.parametrize('width',[390,1280])
def test_connection_reports_and_signout(browser,server,width):
    page=browser.new_page(viewport={'width':width,'height':900})
    errors=[];page.on('pageerror',lambda error:errors.append(str(error)))
    page.route('**/*',lambda route:route.continue_() if route.request.url.startswith(server) else route.abort())
    page.add_init_script(MOCK)
    page.goto(server+'/tally/')
    page.locator('#btnBridge').click()
    page.locator('#bridgeState').filter(has_text='PC offline').wait_for()
    assert page.locator('#bridgePending').inner_text()=='2'
    page.locator('#bridgeFetch').click()
    page.locator('iframe.bridge-report').wait_for()
    page.frame_locator('iframe.bridge-report').get_by_text('Test Debtor',exact=True).wait_for()
    assert 'Saved from Tally' in page.locator('#bridgeReportTime').inner_text()
    assert 'Refresh queued' in page.locator('#bridgeReportTime').inner_text()
    frame=page.locator('iframe.bridge-report')
    assert frame.get_attribute('sandbox')==''
    assert '<script' not in frame.get_attribute('srcdoc')
    assert 'attacker.invalid' not in frame.get_attribute('srcdoc')
    assert page.evaluate('window.pwned') is None
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
    frame.scroll_into_view_if_needed()
    page.screenshot(path=f'/tmp/tally-bridge-{width}.png',full_page=True)
    page.get_by_role('tab',name='Sync activity').click()
    assert page.get_by_role('button',name='Recheck Tally').count()==1
    page.get_by_role('tab',name='Tally data',exact=True).click()
    page.get_by_text('Example Customer',exact=True).wait_for()
    page.get_by_role('tab',name='Connect PC').click()
    page.get_by_role('button',name='Create pairing package').click()
    package=json.loads(page.locator('#bridgePairCode').input_value())
    assert package['protocol']==1 and package['company']=='VRIDDHI FUELS (2026-27)'
    assert page.evaluate('Object.keys(localStorage).some(k => /bridge|report|pair/i.test(k))') is False
    page.evaluate('window.testSignOut()')
    assert page.locator('#scrLogin').is_visible()
    assert page.locator('#scrBridge').inner_html()==''
    assert not page.locator('#btnBridge').is_visible()
    assert not errors
    page.close()


def test_missing_migration_has_actionable_setup_message(browser,server):
    page=browser.new_page()
    page.route('**/*',lambda r:r.continue_() if r.request.url.startswith(server) else r.abort())
    page.add_init_script(MOCK)
    page.goto(server+'/tally/')
    page.locator('#btnBridge').wait_for()
    page.evaluate('window.bridgeConfigured=false')
    page.locator('#btnBridge').click()
    page.locator('#bridgeMessage').filter(has_text='database update has not been installed').wait_for()
    page.close()


@pytest.mark.parametrize('width',[390,1280])
def test_ledger_pdf_and_excel_preserve_snapshot_values(browser,server,tmp_path,width):
    import pymupdf as fitz
    import zipfile
    from xml.etree import ElementTree as ET
    page=browser.new_page(viewport={'width':width,'height':900})
    errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
    page.route('**/*',lambda r:r.continue_() if r.request.url.startswith(server) else r.abort())
    page.add_init_script(MOCK)
    page.goto(server+'/tally/')
    page.locator('#btnBridge').click()
    page.locator('#bridgeReport').select_option('ledger')
    page.locator('#bridgeLedger').fill('Test Debtor')
    fixture='<h2>Opening balance: 2,500.00 Dr</h2><table><tr><th>Date</th><th>Voucher</th><th>Particulars</th><th>Debit</th><th>Credit</th></tr>'
    fixture+=''.join(f'<tr><td>2026-10-19</td><td>{i:06d}</td><td>Customer ₹ invoice {i}<br>Second line</td><td>1,234.50</td><td>0.00</td></tr>' for i in range(70))
    fixture+='<tr><td colspan="5">Closing balance: 88,915.00 Dr</td></tr></table><p>=HYPERLINK("https://attacker.invalid","click")</p>'
    page.evaluate('(s)=>window.reportFixture=s',fixture)
    page.locator('#bridgeFetch').click()
    page.locator('#bridgePdf:not([disabled])').wait_for()
    with page.expect_download() as download:
        page.locator('#bridgePdf').click()
    pdf=tmp_path/'ledger.pdf';download.value.save_as(pdf)
    assert download.value.suggested_filename.startswith('Tally-Test Debtor-')
    with fitz.open(pdf) as doc:
        assert len(doc)>1
        text='\n'.join(p.get_text() for p in doc)
        for value in ('000000','000069','Opening balance','Closing balance','₹','Second line','2026-10-18T12:00:00Z','Windows PC offline','Refresh pending'):
            assert value in text
        assert all(not p.get_links() for p in doc)
    with page.expect_download() as download:
        page.locator('#bridgeExcel').click()
    xlsx=tmp_path/'ledger.xlsx';download.value.save_as(xlsx)
    with zipfile.ZipFile(xlsx) as z:
        sheets=[ET.fromstring(z.read(n)) for n in z.namelist() if n.startswith('xl/worksheets/') and n.endswith('.xml')]
        assert all(not s.findall('.//{*}f') for s in sheets)
        assert any(c.get('t','n')=='n' and c.findtext('{*}v')=='1234.5' for s in sheets for c in s.findall('.//{*}c'))
        text=' '.join(''.join(s.itertext()) for s in sheets)
        if 'xl/sharedStrings.xml' in z.namelist():text+=' '+''.join(ET.fromstring(z.read('xl/sharedStrings.xml')).itertext())
        for value in ('000000','000069','1,234.50','=HYPERLINK','Closing balance: 88,915.00 Dr','2026-10-18T12:00:00Z','Windows PC offline'):
            assert value in text
    page.locator('#bridgeLedger').fill('Different ledger')
    assert page.locator('#bridgePdf').is_disabled() and page.locator('#bridgeExcel').is_disabled()
    assert 'Selection changed' in page.locator('#bridgeReportTime').inner_text()
    assert not errors
    page.close()


def test_manual_xml_export_fails_closed_when_bridge_status_is_unavailable(browser,server):
    page=browser.new_page();page.route('**/*',lambda r:r.continue_() if r.request.url.startswith(server) else r.abort())
    page.add_init_script(MOCK);page.goto(server+'/tally/');page.locator('#btnBridge').wait_for()
    check="async()=>{try{await VFTallyBridge.assertManual();return 'allowed'}catch(e){return e.message}}"
    assert 'duplicate posting' in page.evaluate(check)
    page.evaluate('window.bridgeNetworkError=true')
    assert 'blocked until' in page.evaluate(check)
    page.evaluate('window.bridgeNetworkError=false;window.bridgeConfigured=false')
    assert page.evaluate(check)=='allowed'
    page.close()


def test_signout_during_export_cannot_download_previous_users_report(browser,server):
    page=browser.new_page()
    page.route('**/*',lambda r:r.continue_() if r.request.url.startswith(server) else r.abort())
    page.add_init_script(MOCK);page.goto(server+'/tally/');page.locator('#btnBridge').click();page.locator('#bridgeFetch').click()
    page.locator('#bridgeExcel:not([disabled])').wait_for()
    page.evaluate("()=> {window.VFTallyExport.excel=()=>new Promise(resolve=>window.completeExport=()=>resolve(new Blob(['test'])));}")
    downloads=[];page.on('download',lambda d:downloads.append(d))
    page.locator('#bridgeExcel').click();page.evaluate('window.testSignOut(); window.completeExport()')
    page.wait_for_timeout(100)
    assert not downloads and page.locator('#scrBridge').inner_html()==''
    page.close()
