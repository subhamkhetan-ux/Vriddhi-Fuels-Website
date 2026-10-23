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
      then(resolve){const data=table==='tally_settings'?settings:table==='tally_series'?series:table==='tally_vouchers'?(window.customerPriceVouchers||[]):table==='tally_parties'?(window.customerPriceParties||[]):[];return Promise.resolve({data,error:null}).then(resolve)}};return q},
    rpc(name,args){window.bridgeCalls.push({name,args});
      if(window.bridgeNetworkError)return Promise.resolve({error:{message:'Connection unavailable'}});
      if(!window.bridgeConfigured)return Promise.resolve({error:{code:'PGRST202',message:'function tally_bridge_status does not exist'}});
      if(name==='tally_bridge_status')return Promise.resolve({data:{config:{active:window.bridgeOn!==false,ready:true,push_enabled:true},device:{label:'Office PC',last_seen:'2026-01-01T00:00:00Z',health:'online'},pending:2,attention:1,objects:1247,jobs:[{id:'job1',kind:'voucher',number:'101',voucher_id:'v1',state:'conflict',detail:'Tally and web versions differ.',updated_at:new Date().toISOString()}]}});
      if(name==='tally_bridge_control'&&['on','off'].includes(args.p_action))window.bridgeOn=args.p_action==='on';
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


def test_import_from_tally_works_while_paired(browser,server,tmp_path):
    page=browser.new_page();page.route('**/*',lambda r:r.continue_() if r.request.url.startswith(server) else r.abort())
    page.add_init_script(MOCK);page.goto(server+'/tally/')
    page.locator('#bridgeHomeStatus').filter(has_text='PC offline').wait_for()  # the bridge is paired
    daybook=tmp_path/'DayBook.xml'
    daybook.write_text('<ENVELOPE><VOUCHER VCHTYPE="HSD CREDIT"><DATE>20261019</DATE><VOUCHERTYPENAME>HSD CREDIT</VOUCHERTYPENAME>'
        '<VOUCHERNUMBER>11</VOUCHERNUMBER><PARTYLEDGERNAME>Test Debtor</PARTYLEDGERNAME><ALLINVENTORYENTRIES.LIST>'
        '<RATE>100.00/LTR</RATE><AMOUNT>1000.00</AMOUNT><BILLEDQTY> 10.000 LTR</BILLEDQTY></ALLINVENTORYENTRIES.LIST></VOUCHER></ENVELOPE>')
    page.on('dialog',lambda d:d.accept())
    with page.expect_file_chooser() as chooser:
        page.locator('#btnImportDaybook').click()
    chooser.value.set_files(str(daybook))
    page.wait_for_function("window.bridgeCalls.some(c=>c.name==='tally_import_daybook')")
    call=page.evaluate("window.bridgeCalls.find(c=>c.name==='tally_import_daybook')")
    assert call['args']['p_vouchers'][0]['number']=='11'
    page.close()


@pytest.mark.parametrize('width',[390,1280])
def test_bridge_switches_off_and_on_from_the_connection_screen(browser,server,width):
    page=browser.new_page(viewport={'width':width,'height':900})
    errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
    page.route('**/*',lambda r:r.continue_() if r.request.url.startswith(server) else r.abort())
    page.add_init_script(MOCK);page.goto(server+'/tally/')
    page.on('dialog',lambda d:d.accept())
    page.locator('#btnBridge').click()
    toggle=page.get_by_role('switch',name='Sync vouchers with Tally')
    toggle.wait_for()
    page.wait_for_function("document.getElementById('bridgeMode').getAttribute('aria-checked')==='true'")
    toggle.click()
    page.wait_for_function("document.getElementById('bridgeMode').getAttribute('aria-checked')==='false'")
    assert page.evaluate("window.bridgeCalls.some(c=>c.name==='tally_bridge_control'&&c.args.p_action==='off')")
    assert 'Bridge off' in page.locator('#bridgeState').inner_text()
    assert 'works on its own' in page.locator('#bridgeModeHint').inner_text()
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
    page.wait_for_timeout(400)  # let the switch finish its transition
    page.screenshot(path=f'/tmp/tally-bridge-switch-{width}.png')
    toggle.click()
    page.wait_for_function("document.getElementById('bridgeMode').getAttribute('aria-checked')==='true'")
    assert not errors
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


def test_report_tabs_keyboard_navigation_and_theme(browser,server):
    page=browser.new_page(viewport={'width':320,'height':800},reduced_motion='reduce')
    page.route('**/*',lambda r:r.continue_() if r.request.url.startswith(server) else r.abort())
    page.add_init_script(MOCK);page.goto(server+'/tally/');page.locator('#btnBridge').click()
    reports=page.get_by_role('tab',name='Reports',exact=True)
    reports.focus();reports.press('ArrowLeft')
    setup=page.get_by_role('tab',name='Connect PC',exact=True)
    assert setup.evaluate('(el)=>el===document.activeElement')
    assert page.get_by_role('tabpanel',name='Connect PC').is_visible()
    assert page.locator('[role=tab][tabindex="0"]').count()==1
    setup.press('Home')
    assert page.get_by_role('tabpanel',name='Reports',exact=True).is_visible()
    reports.press('ArrowRight')
    assert page.get_by_role('tabpanel',name='Tally data',exact=True).is_visible()
    assert page.get_by_label('Search',exact=True).is_visible()
    page.locator('#btnTheme').click()
    assert page.evaluate('document.documentElement.dataset.theme')=='light'
    assert page.locator('meta[name="theme-color"]').get_attribute('content')=='#c64511'
    assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
    page.reload();page.locator('#btnBridge').wait_for()
    assert page.evaluate('document.documentElement.dataset.theme')=='light'
    page.locator('#cardHSD').click()
    assert page.get_by_label('Quantity (Litres)',exact=True).is_visible()
    assert page.get_by_label('Vehicle number (optional)',exact=True).is_visible()
    page.close()


def test_report_request_shows_progress_and_recovers_after_error(browser,server):
    page=browser.new_page()
    page.route('**/*',lambda r:r.continue_() if r.request.url.startswith(server) else r.abort())
    page.add_init_script(MOCK)
    page.add_init_script("""const originalFactory=window.__VF_TEST_SUPABASE_FACTORY;
      window.__VF_TEST_SUPABASE_FACTORY=()=>{
        const client=originalFactory(),rpc=client.rpc;
        client.rpc=(name,args)=>name==='tally_bridge_report'
          ? new Promise(resolve=>window.finishRequest=()=>resolve({error:{message:'Please reconnect and try again.'}}))
          : rpc(name,args);
        return client;
      };""")
    page.goto(server+'/tally/');page.locator('#btnBridge').click();page.locator('#bridgeFetch').click()
    assert page.get_by_role('button',name='Requesting…',exact=True).is_disabled()
    assert page.locator('#bridgeCached').is_disabled()
    assert page.get_by_role('tabpanel').get_attribute('aria-busy')=='true'
    page.evaluate('window.finishRequest()')
    page.locator('#bridgeMessage').filter(has_text='Please reconnect').wait_for()
    assert page.get_by_role('button',name='Fetch from Tally',exact=True).is_enabled()
    assert page.locator('#bridgeCached').is_enabled()
    assert page.get_by_role('tabpanel').get_attribute('aria-busy') is None
    page.close()


# Records the pages instead of making a real PDF, so no CDN is needed.
FAKE_JSPDF="""window.jspdf={jsPDF:class{constructor(o){this.pages=1;this.images=[];window.pdfMade=this;this.format=o.format}
  addPage(){this.pages++} addImage(src){this.images.push(src.slice(0,23))}
  output(){return new Blob(['%PDF-fake'],{type:'application/pdf'})}}};"""
IPHONE='Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'
SHARE_STUB="""navigator.canShare=(d)=>!!(d&&d.files);
navigator.share=(d)=>{window.shared=d.files.map(f=>({name:f.name,type:f.type}));return Promise.resolve()};
window.print=()=>{window.printCalled=true};"""


def _customer_price_page(browser,server,**page_options):
    """Exercise the real persistent backend without accessing live business records."""
    def voucher(number,day,rate,series='hsd',party='Alpha Customer',**extra):
        return dict(seriesKey=series,number=number,dateISO=day,party=party,
                    rate=rate,qty=10,amount=rate*10,partyAmt=rate*10,roff=0,source='tally',**extra)
    data={
        'company':'Test Company','autoClear':False,'companyFy':False,
        'series':{'hsd':{'last':'0','rate':100},'ms':{'last':'MS0','rate':110},'xg':{'last':'XG0','rate':106}},
        'parties':['Alpha Customer','New Customer'],'queue':[],
        'history':[
            voucher('14','2025-01-02',94),voucher('12','2025-01-01',90),
            voucher('13','2025-01-02',93),voucher('MS2','2025-01-02',105,'ms'),
            voucher('99','2099-01-01',99),voucher('98','2025-01-03',98,bridgeState='deleted'),
            voucher('97','2025-01-03',97,bridgeState='conflict'),
            voucher('96','2025-01-03',96,party='Alpha Customer Ltd'),
            voucher('95','2025-01-05',95,bridgeState='deleted'),
        ]
    }
    page=browser.new_page(viewport={'width':390,'height':900},service_workers='block',**page_options)
    def route(r):
        if r.request.url==server+'/tally/config.js':r.fulfill(content_type='application/javascript',body='window.VRIDDHI_TALLY_CONFIG={};')
        elif r.request.url.endswith('/jspdf.umd.min.js'):r.fulfill(content_type='application/javascript',body=FAKE_JSPDF)
        elif r.request.url.startswith(server):r.continue_()
        else:r.abort()
    page.route('**/*',route)
    page.add_init_script("if(!localStorage.getItem('vf_tally_v1'))localStorage.setItem('vf_tally_v1',"+json.dumps(json.dumps(data))+");")
    page.goto(server+'/tally/');page.locator('#cardHSD').wait_for()
    return page


def test_customer_price_is_saved_and_reused_on_next_invoice(browser,server):
    page=_customer_price_page(browser,server)
    page.locator('#cardHSD').click()
    page.locator('#fPartyList').get_by_role('button',name='Alpha Customer',exact=True).click()
    assert page.locator('#fPrice').input_value()=='94.00'
    assert 'invoice #14' in page.locator('#priceHint').inner_text()
    page.locator('#fQty').fill('10')
    assert page.locator('#fAmt').input_value()=='940.00'
    page.locator('#fPrice').fill('97.50')
    assert page.locator('#fAmt').input_value()=='975.00'
    page.locator('#btnSave').click();page.locator('#scrHome.on').wait_for()
    # Reopening the app proves the suggestion is sourced from the saved invoice.
    page.reload();page.locator('#cardHSD').click()
    page.locator('#fPartyList').get_by_role('button',name='Alpha Customer',exact=True).click()
    assert page.locator('#fPrice').input_value()=='97.50'
    page.locator('#btnBill').click();page.locator('#blPrice').wait_for()
    assert page.locator('#blPrice').input_value()=='97.50'
    assert page.evaluate("JSON.parse(localStorage.getItem('vf_tally_v1')).series.hsd.rate")==100
    page.close()


def test_customer_price_product_date_and_manual_override_are_independent(browser,server):
    page=_customer_price_page(browser,server)
    page.locator('#cardHSD').click();page.locator('#fQty').fill('10')
    page.locator('#fPartyList').get_by_role('button',name='Alpha Customer',exact=True).click()
    assert page.locator('#fPrice').input_value()=='94.00'
    assert page.locator('#fAmt').input_value()=='940.00'
    page.locator('#prodMs').click()
    assert page.locator('#fPrice').input_value()=='105.00'
    assert page.locator('#fAmt').input_value()=='1050.00'
    page.locator('#prodXg').click()
    assert page.locator('#fPrice').input_value()=='106.00'
    assert 'No earlier' in page.locator('#priceHint').inner_text()
    page.locator('#prodHsd').click()
    page.locator('#fDate').fill('2025-01-01');page.locator('#fDate').dispatch_event('change')
    assert page.locator('#fPrice').input_value()=='90.00'
    page.locator('#fPrice').fill('88.00')
    page.locator('#fDate').fill('2025-01-02');page.locator('#fDate').dispatch_event('change')
    assert page.locator('#fPrice').input_value()=='88.00'
    page.locator('#btnChangeParty').click()
    page.locator('#fPartyList').get_by_role('button',name='New Customer',exact=True).click()
    assert page.locator('#fPrice').input_value()=='100.00'
    # An unsaved rate is never remembered for another invoice.
    page.locator('#fPrice').fill('77.00');page.locator('#btnBack').click();page.locator('#cardHSD').click()
    page.locator('#fPartyList').get_by_role('button',name='Alpha Customer',exact=True).click()
    assert page.locator('#fPrice').input_value()=='94.00'
    page.close()


def test_editing_an_existing_invoice_keeps_its_saved_rate(browser,server):
    page=_customer_price_page(browser,server)
    page.on('dialog',lambda dialog:dialog.accept())
    page.locator('#btnHistory').click()
    page.get_by_role('button',name='High Speed Diesel',exact=False).click()
    page.get_by_role('button',name='01/01/2025',exact=False).click()
    page.get_by_role('button',name='Alter old voucher 12',exact=True).click()
    assert page.locator('#fPrice').input_value()=='90.00'
    page.locator('#btnChangeParty').click()
    page.locator('#fPartyList').get_by_role('button',name='New Customer',exact=True).click()
    page.locator('#fDate').fill('2025-02-01');page.locator('#fDate').dispatch_event('change')
    assert page.locator('#fPrice').input_value()=='90.00'
    assert "voucher's saved rate" in page.locator('#priceHint').inner_text()
    page.close()


def test_customer_price_uses_the_shared_cloud_invoice_history(browser,server):
    page=browser.new_page()
    page.route('**/*',lambda r:r.continue_() if r.request.url.startswith(server) else r.abort())
    page.add_init_script(MOCK)
    page.add_init_script("""window.customerPriceParties=[{name:'Cloud Customer'}];
      window.customerPriceVouchers=[{
        id:'shared-voucher',series:'hsd',number:'15',date:'2025-01-02',party:'Cloud Customer',
        qty:'10.000',rate:'91.25',item_amt:'912.50',party_amt:'912.50',roff:'0',
        status:'history',source:'tally',bridge_state:'synced',created_at:'2025-01-02T12:00:00Z'
      }];""")
    page.goto(server+'/tally/');page.locator('#cardHSD').click()
    page.locator('#fPartyList').get_by_role('button',name='Cloud Customer',exact=True).click()
    assert page.locator('#fPrice').input_value()=='91.25'
    assert 'invoice #15' in page.locator('#priceHint').inner_text()
    page.locator('#fAmt').fill('912.50')
    assert page.locator('#fQty').input_value()=='10.000'
    page.locator('#prodMs').click()
    assert page.locator('#fPrice').input_value()=='110.00'
    assert page.locator('#fAmt').input_value()=='912.50'
    assert page.locator('#fQty').input_value()=='8.295'
    page.close()


LEDGER_MOCK=r"""
window.__VF_TEST_LEDGER_FACTORY=(url,key,opts)=>{
  window.ledgerClient={url,key,opts};let session=window.ledgerSignedIn?{user:{id:'l'}}:null;
  return {auth:{getSession:()=>Promise.resolve({data:{session}}),
      signInWithPassword:({email,password})=>{window.ledgerLogin={email,password};
        if(password!=='ledger-pass')return Promise.resolve({error:{message:'Invalid login'}});
        session={user:{id:'l'}};return Promise.resolve({data:{session},error:null})},
      signOut:()=>{session=null;return Promise.resolve({})}},
    rpc:(name)=>Promise.resolve(name==='ledger_po_data'?{data:window.ledgerData,error:null}:{data:null,error:{message:'unknown'}})};
};
"""


def test_tanker_bill_takes_the_open_po_from_the_ledger(browser,server):
    """Ledger bills used 6,000 L of PO-A (10,000); a voucher here the Ledger has not imported yet
    uses 3,000 more, so today's 5,000 L bill no longer fits PO-A and gets PO-B."""
    page=browser.new_page(viewport={'width':390,'height':900})
    errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
    page.route('**/*',lambda r:r.continue_() if r.request.url.startswith(server) else r.abort())
    page.add_init_script(MOCK);page.add_init_script(LEDGER_MOCK)
    page.add_init_script("""(()=>{const today=new Date().toLocaleDateString('en-CA');
      const row=(id,number,qty)=>({id,series:'hsd',number,date:today,party:'Twin Steel Ltd',vehicle:'OD01',qty:String(qty),
        rate:'100',item_amt:String(qty*100),party_amt:String(qty*100),roff:'0',status:'pending',source:'app',bridge_state:'unlinked',
        created_at:new Date().toISOString()});
      window.customerPriceParties=[{name:'Twin Steel Ltd'}];
      window.customerPriceVouchers=[row('v1','701',3000),row('v2','702',5000)];
      window.ledgerData={groups:[{code:'Twin_Bulk',title:'Twin Steel Ltd — Bulk',kind:'po',units:[]}],
        members:[{id:1,name:'TWIN STEEL LIMITED',key:'twin',group:'Twin_Bulk',archived:false}],
        pos:[{id:1,group_code:'Twin_Bulk',unit:'',po_no:'PO-A',allotted:10000,seq:1},{id:2,group_code:'Twin_Bulk',unit:'',po_no:'PO-B',allotted:20000,seq:2}],
        bills:[{id:9,group:'Twin_Bulk',product:'HSD',date:'2026-04-02',bill_no:'600',qty:6000,unit:'',po_mode:'auto',po_fixed:'',seq:1}]};
    })();""")
    page.goto(server+'/tally/')
    page.get_by_role('button',name='Create bill for voucher 702').click()
    page.locator('#blLedgerForm').wait_for()
    assert 'Connect the Ledger once' in page.locator('#blPoHint').inner_text()
    page.locator('#blLedgerEmail').fill('owner@example.com');page.locator('#blLedgerPass').fill('ledger-pass')
    page.locator('#blLedgerGo').click()
    page.wait_for_function("document.getElementById('blPo').value==='PO-B'")
    assert '15,000 L left after this bill' in page.locator('#blPoHint').inner_text()
    assert page.locator('#blPPoVal').text_content()=='PO-B'  # printed on the bill
    assert page.locator('#blLedgerForm').is_hidden()
    assert page.evaluate("window.ledgerClient.opts.auth.storageKey")=='vf-tally-ledger-auth'
    # Fewer litres fit the 1,000 L still on PO-A; a P.O. No. typed by hand is kept.
    page.locator('#blQty').fill('1000')
    page.wait_for_function("document.getElementById('blPo').value==='PO-A'")
    page.locator('#blPo').fill('MANUAL-1')
    page.locator('#blQty').fill('4000')
    page.wait_for_function("document.getElementById('blPoHint').textContent.includes('Kept the P.O. No. you typed')")
    assert page.locator('#blPo').input_value()=='MANUAL-1'
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
    assert not errors
    page.close()


def test_tanker_bill_falls_back_to_the_sheet_po_without_a_ledger_group(browser,server):
    page=browser.new_page()
    page.route('**/*',lambda r:r.continue_() if r.request.url.startswith(server) else r.abort())
    page.add_init_script(MOCK);page.add_init_script(LEDGER_MOCK)
    page.add_init_script("""(()=>{const today=new Date().toLocaleDateString('en-CA');window.ledgerSignedIn=true;
      window.customerPriceVouchers=[{id:'v1',series:'hsd',number:'801',date:today,party:'Aryan Ispat & Power Private Ltd.',qty:'1000',
        rate:'100',item_amt:'100000',party_amt:'100000',roff:'0',status:'pending',source:'app',bridge_state:'unlinked',created_at:new Date().toISOString()}];
      window.ledgerData={groups:[],members:[],pos:[],bills:[]};})();""")
    page.goto(server+'/tally/')
    page.get_by_role('button',name='Create bill for voucher 801').click()
    page.wait_for_function("document.getElementById('blPoHint').textContent.includes('Not a PO customer')")
    sheet=__import__('json').load(open(ROOT/'state/tanker_billing.json'))
    expected=next(c['po_no'] for c in sheet['customers'] if c['company']=='Aryan Ispat & Power Private Ltd.')
    assert page.locator('#blPo').input_value()==expected
    page.close()



def test_unit_wise_po_comes_from_the_unit_in_the_customer_name(browser,server):
    page=browser.new_page(viewport={'width':390,'height':900})
    page.route('**/*',lambda r:r.continue_() if r.request.url.startswith(server) else r.abort())
    page.add_init_script(MOCK);page.add_init_script(LEDGER_MOCK)
    page.add_init_script("""(()=>{const today=new Date().toLocaleDateString('en-CA');window.ledgerSignedIn=true;
      const row=(id,number,party,qty)=>({id,series:'hsd',number,date:today,party,qty:String(qty),rate:'99.5',item_amt:String(qty*99.5),
        party_amt:String(qty*99.5),roff:'0',status:'pending',source:'app',bridge_state:'unlinked',created_at:new Date().toISOString()});
      window.customerPriceVouchers=[row('v1','4331','SMC Power Generation LTD, UNIT II',12000),row('v2','4332','SMC Power Generation Ltd',3000)];
      window.ledgerData={groups:[{code:'SMC_Bulk',title:'SMC — Bulk',kind:'po_units',units:['UNIT 1','UNIT 2']}],
        members:[{id:1,name:'SMC Power Generation LTD, UNIT II',group:'SMC_Bulk',archived:false},{id:2,name:'SMC Power Generation Ltd',group:'SMC_Bulk',archived:false}],
        pos:[{id:1,group_code:'SMC_Bulk',unit:'UNIT 1',po_no:'U1-PO',allotted:50000,seq:1},{id:2,group_code:'SMC_Bulk',unit:'UNIT 2',po_no:'4500220906',allotted:60000,seq:1}],
        bills:[{id:9,group:'SMC_Bulk',product:'HSD',date:'2026-04-02',bill_no:'100',qty:2000,unit:'UNIT 1',customer:'SMC Power Generation Ltd',po_mode:'auto',po_fixed:'',seq:1}]};
    })();""")
    page.goto(server+'/tally/')
    page.get_by_role('button',name='Create bill for voucher 4331').click()
    page.wait_for_function("document.getElementById('blPo').value==='4500220906'")
    assert 'for UNIT 2' in page.locator('#blPoHint').inner_text() and '48,000 L left after this bill' in page.locator('#blPoHint').inner_text()
    page.goto(server+'/tally/')
    # No unit in the name: the customer's last Ledger bill was UNIT 1.
    page.get_by_role('button',name='Create bill for voucher 4332').click()
    page.wait_for_function("document.getElementById('blPo').value==='U1-PO'")
    page.close()


def test_stock_summary_is_product_wise_then_date_wise(browser,server):
    page=_customer_price_page(browser,server)
    page.locator('#btnHistory').click()
    table=page.locator('#ssTable')
    # Products like Tally's Stock Summary; a voucher deleted in Tally is not counted.
    assert 'High Speed Diesel' in table.inner_text() and 'Motor Spirit' in table.inner_text()
    total=table.locator('.ss-total')
    assert '70.000' in total.inner_text() and '₹6,740.00' in total.inner_text()
    assert '7 vouchers' in total.inner_text()
    page.get_by_role('button',name='High Speed Diesel',exact=False).click()
    assert page.locator('#hdrTitle').inner_text()=='High Speed Diesel'
    rows=page.locator('#ssTable button.ss-row')
    assert rows.first.locator('b').inner_text()=='01/01/2099'
    assert '05/01/2025' not in page.locator('#ssTable').inner_text()  # only a voucher deleted in Tally that day
    assert '₹5,690.00' in page.locator('#ssTable .ss-total').inner_text()
    page.get_by_role('button',name='02/01/2025',exact=False).click()
    assert page.locator('#histList .vitem').count()==2
    assert '₹1,870.00' in page.locator('#ssFoot').inner_text()
    # Back steps up one level at a time.
    page.locator('#btnBack').click()
    assert page.locator('#hdrTitle').inner_text()=='High Speed Diesel'
    page.locator('#btnBack').click()
    assert page.locator('#hdrTitle').inner_text()=='Stock Summary'
    page.locator('#histSearch').fill('MS2')
    assert page.locator('#histList .vitem').count()==1
    assert not page.evaluate('document.documentElement.scrollWidth>innerWidth')
    page.close()


def test_ios_prints_the_bill_and_slip_through_the_share_sheet(browser,server):
    page=_customer_price_page(browser,server,user_agent=IPHONE)
    page.add_init_script(SHARE_STUB);page.reload();page.locator('#cardHSD').wait_for()
    # the bill: both pages become an A4 PDF for the share sheet's Print
    page.locator('#btnHistory').click()
    page.get_by_role('button',name='High Speed Diesel',exact=False).click()
    page.get_by_role('button',name='01/01/2025',exact=False).click()
    page.get_by_role('button',name='Create bill for voucher 12',exact=True).click()
    page.locator('#blPrint').click()
    sheet=page.locator('#vf-share')
    sheet.get_by_role('heading',name='Ready to print').wait_for()
    assert page.evaluate('pdfMade.pages')==2
    assert page.evaluate('pdfMade.format')==[595.28,841.89]
    assert page.evaluate('pdfMade.images.every(s=>s.startsWith("data:image/jpeg"))')
    sheet.get_by_role('button',name='Print / Save PDF').click()
    sheet.wait_for(state='detached')
    assert page.evaluate('shared')==[{'name':'Bill-12.pdf','type':'application/pdf'}]
    assert not page.evaluate('!!window.printCalled')
    # a voucher's fuel slip: A5, same route
    page.locator('#btnBack').click();page.locator('#btnBack').click();page.locator('#btnBack').click()
    page.locator('#btnBack').click();page.locator('#cardHSD').click()
    page.locator('#fPartyList').get_by_role('button',name='Alpha Customer',exact=True).click()
    page.locator('#fQty').fill('10');page.locator('#btnSlipPrint').click()
    sheet.get_by_role('heading',name='Ready to print').wait_for()
    assert page.evaluate('pdfMade.format')==[420,595]
    sheet.get_by_role('button',name='Print / Save PDF').click()
    assert page.evaluate('shared[0].name').endswith('.pdf')
    # the slip PDF download goes to the same sheet instead of a dead link
    page.locator('#btnSlipPdf').click()
    sheet.get_by_role('heading',name='PDF ready').wait_for()
    sheet.get_by_role('button',name='Close').click()
    sheet.wait_for(state='detached')
    page.close()


def test_desktop_bill_print_still_uses_the_browser_print(browser,server):
    page=_customer_price_page(browser,server)
    page.add_init_script(SHARE_STUB);page.reload();page.locator('#cardHSD').wait_for()
    page.locator('#btnHistory').click()
    page.get_by_role('button',name='High Speed Diesel',exact=False).click()
    page.get_by_role('button',name='01/01/2025',exact=False).click()
    page.get_by_role('button',name='Create bill for voucher 12',exact=True).click()
    page.locator('#blPrint').click()
    assert page.evaluate('window.printCalled')
    assert page.locator('#vf-share').count()==0
    page.close()


TALLY_LEDGER=('<table><tr><td>Date</td><td>Particulars</td><td>Vch Type</td><td>Vch No.</td><td>Debit</td><td>Credit</td></tr>'
    '<tr><td></td><td>Opening Balance</td><td></td><td></td><td>2,45,000.00</td><td></td></tr>'
    +''.join(f'<tr><td>{i+1}-Oct-26</td><td>SALE (HSD)</td><td>HSD CREDIT</td><td>{4200+i}</td><td>50,706.79</td><td></td></tr>' for i in range(60))
    +'<tr><td></td><td></td><td></td><td></td><td>32,87,407.40</td><td>0.00</td></tr>'
    '<tr><td></td><td>Closing Balance</td><td></td><td></td><td></td><td>32,87,407.40</td></tr></table>')


def _ledger_report(browser,server,**page_options):
    page=browser.new_page(viewport={'width':390,'height':900},**page_options)
    errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
    page.route('**/*',lambda r:r.continue_() if r.request.url.startswith(server) else r.abort())
    page.add_init_script(MOCK);page.add_init_script(SHARE_STUB)
    page.goto(server+'/tally/');page.locator('#btnBridge').click()
    page.locator('#bridgeReport').select_option('ledger');page.locator('#bridgeLedger').fill('Keshav Minerals')
    page.locator('#bridgeFrom').fill('2026-10-01');page.locator('#bridgeTo').fill('2026-10-23')
    page.evaluate('(s)=>window.reportFixture=s',TALLY_LEDGER)
    page.locator('#bridgeFetch').click();page.locator('iframe.bridge-report').wait_for()
    return page,errors


def test_report_is_shown_in_tallys_print_layout(browser,server):
    page,errors=_ledger_report(browser,server)
    doc=page.locator('iframe.bridge-report').get_attribute('srcdoc')
    for line in ('<div class="co">VRIDDHI FUELS</div>','GSTIN/UIN: 21AATFV8250A1Z8','<div class="ledger">Keshav Minerals</div>',
                 '<div class="title">Ledger Account</div>','<div class="period">1-Oct-26 to 23-Oct-26</div>'):
        assert line in doc
    frame=page.frame_locator('iframe.bridge-report')
    # column headings ruled, amounts and their headings right-aligned, totals bold
    assert frame.locator('tr.h').count()==1 and frame.locator('tr.t').count()==1 and frame.locator('tr.b').count()==2
    align=lambda text:frame.get_by_text(text,exact=True).first.evaluate('e=>getComputedStyle(e).textAlign')
    assert align('Debit')=='right' and align('50,706.79')=='right' and align('SALE (HSD)')=='left'
    assert frame.get_by_text('32,87,407.40',exact=True).first.evaluate('e=>getComputedStyle(e).fontWeight')=='700'
    assert not errors
    page.close()


def test_ios_prints_the_report_through_the_share_sheet(browser,server):
    page,errors=_ledger_report(browser,server,user_agent=IPHONE)
    page.evaluate("""()=>{navigator.share=d=>d.files[0].arrayBuffer().then(b=>{
      const u=new Uint8Array(b);let s='';for(let i=0;i<u.length;i+=8192)s+=String.fromCharCode.apply(null,u.subarray(i,i+8192));
      window.shared=[{name:d.files[0].name,type:d.files[0].type}];window.sharedPdf=btoa(s);})}""")
    page.locator('#bridgePrint:not([disabled])').click()
    sheet=page.locator('#vf-share');sheet.get_by_role('heading',name='Ready to print').wait_for(timeout=30000)
    sheet.get_by_role('button',name='Print / Save PDF').click();page.wait_for_function('window.sharedPdf')
    assert page.evaluate('shared')==[{'name':'Tally-Keshav Minerals-2026-10-01-2026-10-23.pdf','type':'application/pdf'}]
    assert not page.evaluate('!!window.printCalled')
    import base64, pymupdf
    with pymupdf.open(stream=base64.b64decode(page.evaluate('sharedPdf')),filetype='pdf') as doc:
        assert len(doc)==2 and doc[0].rect.width<doc[0].rect.height  # A4 portrait, like Tally
        first,second=doc[0].get_text(),doc[1].get_text()
        for value in ('VRIDDHI FUELS','Keshav Minerals','Ledger Account','1-Oct-26 to 23-Oct-26','Page 1'):
            assert value in first
        assert 'Debit' in second and '(continued)' in second and 'Closing Balance' in second  # headings repeat
    assert not errors
    page.close()
