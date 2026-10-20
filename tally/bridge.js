/* Tally Prime connection and native reports. No financial data or device tokens in localStorage. */
(function (global) {
  'use strict';
  const RELEASE = 'https://github.com/subhamkhetan-ux/Vriddhi-Fuels-Website/releases/tag/tally-bridge-v1.0.2';
  const DOCS = 'https://github.com/subhamkhetan-ux/Vriddhi-Fuels-Website/blob/main/tally_bridge/README.md';
  const REPORTS = {daybook:'Day book',ledger:'Ledger statement',trial_balance:'Trial balance',balance_sheet:'Balance sheet',
    profit_loss:'Profit & loss',receivables:'Receivables',payables:'Payables',stock:'Stock summary',cash_bank:'Cash & bank'};
  const LABELS = {queued:'Queued for Tally',confirming:'Confirming in Tally',synced:'Confirmed in Tally',conflict:'Needs review',
    needs_edit:'Not posted — correct details or retry',deleted:'Cancelled / deleted in Tally',unsupported:'Changed in Tally — view current report',awaiting_tally:'Fetching Tally version',unlinked:'Not linked'};
  let client, cfg, user, timer, pairingExpiry, ledgerTimer, epoch = 0, tab = 'reports', report = null, busy = false, exportBusy = false, reportArgs = null, status = null, offset = 0;
  const $ = id => document.getElementById(id);
  const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const date = value => value ? new Date(value).toLocaleString('en-IN', {dateStyle:'medium',timeStyle:'short'}) : 'Not yet';
  const node = (tag, value) => { const el = document.createElement(tag); el.textContent = value; return el; };
  function error(e) { if ($('bridgeMessage')) $('bridgeMessage').textContent = e.message || 'Could not connect. Try again.'; }
  async function rpc(name, args = {}) {
    const generation = epoch;
    if (!client || !user) throw new Error('Sign in to use the Tally connection.');
    const result = await client.rpc(name, args);
    if (generation !== epoch) throw new Error('Session changed.');
    if (result.error) throw Object.assign(new Error(result.error.message || 'Could not connect.'),{code:result.error.code});
    return result.data;
  }
  function online() { return status && status.device && Date.now() - Date.parse(status.device.last_seen) < 95000; }
  function title() {
    if (!status) return 'Connection not configured';
    if (!status.device) return 'Pair your Windows PC';
    if (!online()) return 'PC offline · cached data available';
    if (status.device.health === 'starting_tally') return 'Starting Tally Prime…';
    if (status.device.health === 'needs_attention') return 'Connection needs attention';
    if (!status.config.ready) return 'First sync in progress';
    return status.config.push_enabled ? 'Connected to Tally Prime' : 'Voucher posting paused';
  }
  function paintStatus() {
    $('bridgeHomeStatus').textContent = title();
    $('bridgeHomeDot').className = 'bridge-dot' + (online() && status.device.health === 'online' ? ' online' : '');
    if (!$('bridgeState')) return;
    $('bridgeState').textContent = title();
    $('bridgePending').textContent = status ? status.pending : '—';
    $('bridgeAttention').textContent = status ? status.attention : '—';
    $('bridgeObjects').textContent = status ? status.objects.toLocaleString('en-IN') : '—';
    $('bridgeLastSeen').textContent = status && status.device ? 'Last contact: ' + date(status.device.last_seen) + ' · ' + status.device.label : 'Pair one Windows PC with your Vriddhi Fuels company.';
    if ($('bridgeDeviceDetail')) {
      $('bridgeDeviceDetail').textContent = status?.device?.detail || '';
      $('bridgeDeviceDetail').hidden = !status?.device?.detail;
    }
    if (tab === 'activity') paintActivity();
  }
  async function refreshStatus() {
    try {
      status = await rpc('tally_bridge_status');
      global.dispatchEvent(new CustomEvent('tally-bridge-status', {detail:status}));
      paintStatus();
    } catch (e) {
      if (!user) return;
      if (!status) $('bridgeHomeStatus').textContent = 'Setup required · open connection';
      if ($('bridgeMessage')) $('bridgeMessage').textContent = /function|schema cache|does not exist/i.test(e.message)
        ? 'The bridge database update has not been installed. Open Setup instructions to apply tally-bridge.sql to the Tally Supabase project.' : e.message;
    }
  }
  function mount() {
    const root = $('scrBridge');
    root.innerHTML = `<div class="bridge-intro"><div><span class="eyebrow">VRIDDHI FUELS · TALLY PRIME</span>
      <h2>Tally connection <span>&amp; reports</span></h2>
      <p>Your office books, with you. Review reports, follow sync progress, and manage your connection.</p></div>
      <span class="bridge-chip" id="bridgeState">Checking connection…</span></div>
      <div class="bridge-metrics"><div class="bridge-metric"><small>WAITING TO SYNC</small><strong id="bridgePending">—</strong></div>
      <div class="bridge-metric"><small>NEEDS REVIEW</small><strong id="bridgeAttention">—</strong></div>
      <div class="bridge-metric"><small>TALLY RECORDS</small><strong id="bridgeObjects">—</strong></div></div>
      <p class="vsub" id="bridgeLastSeen"></p><p class="hint" id="bridgeDeviceDetail" hidden></p>
      <div class="bridge-tabs" role="tablist" aria-label="Tally connection"><button role="tab" data-tab="reports">Reports</button><button role="tab" data-tab="browse">Tally data</button><button role="tab" data-tab="activity">Sync activity</button><button role="tab" data-tab="setup">Connect PC</button></div>
      <p id="bridgeMessage" class="bridge-notice" role="status">Reports show their last refresh time. New requests wait safely when the PC is offline.</p><div id="bridgeContent" role="tabpanel" tabindex="0"></div>`;
    const tabs = Array.from(root.querySelectorAll('[data-tab]'));
    tabs.forEach((b, index) => {
      b.id = 'bridgeTab-' + b.dataset.tab;
      b.setAttribute('aria-controls', 'bridgeContent');
      b.onclick = () => selectTab(b.dataset.tab);
      b.onkeydown = e => {
        let next;
        if (e.key === 'ArrowRight') next = (index + 1) % tabs.length;
        else if (e.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
        else if (e.key === 'Home') next = 0;
        else if (e.key === 'End') next = tabs.length - 1;
        else return;
        e.preventDefault();
        tabs[next].focus();
        selectTab(tabs[next].dataset.tab);
      };
    });
    selectTab(tab);
    paintStatus();
  }
  function selectTab(value) {
    tab = value;
    $('scrBridge').querySelectorAll('[data-tab]').forEach(b => {
      const selected = b.dataset.tab === tab;
      b.setAttribute('aria-selected', String(selected));
      b.tabIndex = selected ? 0 : -1;
    });
    const content = $('bridgeContent');
    content.setAttribute('aria-labelledby', 'bridgeTab-' + tab);
    content.removeAttribute('aria-busy');
    if (tab === 'reports') {
      const today = new Date().toLocaleDateString('en-CA');
      content.innerHTML = `<div class="bridge-panel"><h3>Choose your report</h3><p>Choose a report and period. Previously fetched reports remain available while the Windows PC is offline.</p>
        <div class="bridge-form"><div class="wide"><label for="bridgeReport">Report</label><select id="bridgeReport">${Object.entries(REPORTS).map(([k,v])=>`<option value="${k}">${esc(v)}</option>`).join('')}</select></div>
        <div><label for="bridgeFrom">From</label><input type="date" id="bridgeFrom"></div><div><label for="bridgeTo">To</label><input type="date" id="bridgeTo"></div>
        <div class="wide" id="bridgeLedgerField" hidden><label for="bridgeLedger">Ledger</label><input id="bridgeLedger" list="bridgeLedgerNames" placeholder="Search your synced Tally ledgers" maxlength="250" autocomplete="off"><datalist id="bridgeLedgerNames"></datalist></div></div>
        <div class="bridge-actions"><button class="btn primary" id="bridgeFetch">Fetch from Tally</button><button class="btn ghost" id="bridgeCached">Open saved report</button></div>
        <div class="bridge-actions bridge-export-actions" role="group" aria-label="Export saved report"><button class="btn ghost" id="bridgePdf" disabled>Download PDF</button><button class="btn ghost" id="bridgeExcel" disabled>Download Excel</button><button class="btn ghost" id="bridgePrint" disabled>Print / Save PDF</button><button class="btn ghost" id="bridgeDownload" disabled>Save HTML</button></div>
        <p id="bridgeReportTime" class="vsub">No report selected.</p><div id="bridgeReportOutput" class="bridge-empty"><svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3h7l4 4v14H6V3Z M14 3v5h4 M9 12h6 M9 16h4"/></svg><strong>A clear view of your books</strong><span>Choose a report and period, then fetch from Tally.<br>You can also open a previously saved report.</span></div></div>`;
      $('bridgeFrom').value = today.slice(0, 8) + '01'; $('bridgeTo').value = today;
      $('bridgeReport').onchange = () => { $('bridgeLedgerField').hidden = $('bridgeReport').value !== 'ledger'; syncExportButtons(); if($('bridgeReport').value==='ledger')suggestLedgers(); };
      ['bridgeFrom','bridgeTo','bridgeLedger'].forEach(id=>$(id).addEventListener('input',syncExportButtons));
      $('bridgeLedger').addEventListener('input',()=> {clearTimeout(ledgerTimer);ledgerTimer=setTimeout(suggestLedgers,250);});
      $('bridgeFetch').onclick = () => fetchReport(true).catch(error);
      $('bridgeCached').onclick = () => fetchReport(false).catch(error);
      $('bridgeDownload').onclick = downloadReport;
      $('bridgePdf').onclick = () => exportReport('pdf').catch(error);
      $('bridgeExcel').onclick = () => exportReport('xlsx').catch(error);
      $('bridgePrint').onclick = printReport;
      if (reportArgs) {
        $('bridgeReport').value = reportArgs.p_report; $('bridgeFrom').value = reportArgs.p_from; $('bridgeTo').value = reportArgs.p_to;
        $('bridgeLedger').value = reportArgs.p_ledger; $('bridgeReport').onchange(); paintReport();
      }
    } else if (tab === 'setup') {
      content.innerHTML = `<div class="bridge-panel"><h3>Connect your Windows PC</h3><p>Open Vriddhi Fuels in Tally Prime, enable its local XML server, and extract the Windows ZIP on that PC. Open Setup.cmd to install. Pairing locks the bridge to this company's identity.</p>
        <div class="bridge-actions"><a class="btn primary" href="${RELEASE}" target="_blank" rel="noopener">Windows installer</a><a class="btn ghost" href="${DOCS}" target="_blank" rel="noopener">Setup instructions</a></div>
        <div class="bridge-actions"><button class="btn primary" id="bridgePair">Create pairing package</button><button class="btn ghost" id="bridgePause">${status && status.config.push_enabled ? 'Pause posting' : 'Resume posting'}</button><button class="btn ghost" id="bridgeRevoke">Disconnect PC</button></div><div id="bridgePairOutput"></div>
        <p>Starts after Windows sign-in. Enable automatic Tally recovery in Setup.cmd to reopen Tally minimized with your company loaded when employees close it. Keep Windows signed in; the screen may lock. The bridge checks new web vouchers about every 5 seconds, masters every minute, and deletions every hour. Initial sync may take longer.</p></div>
        <div class="bridge-panel"><h3>Existing vouchers</h3><p>Previously saved vouchers are not automatically reposted. Queue an unlinked voucher from Sync activity; the bridge first checks whether it already exists in Tally.</p><p>New vouchers and supported edits queue automatically after pairing. Resolve conflicting edits in Sync activity. Manual DayBook imports and history deletion are protected while connected.</p></div>`;
      $('bridgePair').onclick = async () => {
        try {
          const data = await rpc('tally_bridge_pair_code');
          const pack = JSON.stringify({protocol:1,url:cfg.SUPABASE_URL,key:cfg.SUPABASE_ANON_KEY,company:data.company,code:data.code});
          const out = $('bridgePairOutput'); if (!out) return;
          out.innerHTML = '<p>Paste this package in the Windows installer. It expires in 10 minutes and pairs one PC.</p><textarea class="bridge-code" id="bridgePairCode" readonly aria-label="One-time pairing package"></textarea><div class="bridge-actions"><button class="btn ghost" id="bridgeCopy">Copy pairing package</button></div>';
          $('bridgePairCode').value = pack;
          $('bridgeCopy').onclick = () => navigator.clipboard.writeText(pack).then(()=> { $('bridgeCopy').textContent = 'Copied'; }).catch(()=> $('bridgePairCode').select());
          const generation = epoch;
          clearTimeout(pairingExpiry);
          pairingExpiry = setTimeout(()=> { if (epoch===generation && $('bridgePairOutput')) $('bridgePairOutput').textContent = 'Pairing package expired. Create another if needed.'; }, 600000);
          refreshStatus();
        } catch(e) { error(e); }
      };
      $('bridgePause').onclick = () => control(status && status.config.push_enabled ? 'pause' : 'resume').then(()=>selectTab('setup')).catch(error);
      $('bridgeRevoke').onclick = () => { if (confirm('Disconnect this PC? Pending vouchers remain saved. You can pair it again later.')) control('revoke').then(()=>selectTab('setup')).catch(error); };
    } else if (tab === 'activity') {
      content.innerHTML = '<div class="bridge-panel"><h3>Sync activity</h3><p>Confirmed means the bridge read the voucher back from Tally. If a posting is uncertain, it is checked again before any further action.</p><div id="bridgeJobs"></div></div><div class="bridge-panel"><h3>Unlinked vouchers</h3><p>Queue a saved voucher to check and link it with Tally.</p><div id="bridgeUnlinked"></div></div>';
      paintActivity();
      loadUnlinked().catch(error);
    } else {
      content.innerHTML = `<div class="bridge-panel"><h3>Explore Tally data</h3><p>All voucher types and the synced accounting masters. Cancelled or deleted records stay labelled for reference.</p><div class="bridge-form"><div><label for="bridgeKind">Records</label><select id="bridgeKind">${['Voucher','Ledger','Group','StockItem','StockGroup','Unit','Godown','VoucherType','CostCentre','Currency'].map(k=>`<option>${k}</option>`).join('')}</select></div><div><label for="bridgeSearch">Search</label><input id="bridgeSearch" type="search" enterkeyhint="search" placeholder="Name, party or invoice"></div></div><div class="bridge-actions"><button class="btn primary" id="bridgeFind">Search</button><button class="btn ghost" id="bridgePrev">Previous</button><button class="btn ghost" id="bridgeNext">Next 50</button></div><div id="bridgeRecords"></div></div>`;
      $('bridgeFind').onclick = () => { offset = 0; browse().catch(error); };
      $('bridgePrev').onclick = () => { offset = Math.max(0,offset-50); browse().catch(error); };
      $('bridgeNext').onclick = () => { offset += 50; browse().catch(error); };
      $('bridgeKind').onchange = () => { offset=0; browse().catch(error); };
      $('bridgeSearch').onkeydown = e => { if (e.key === 'Enter') $('bridgeFind').click(); };
      offset = 0; browse().catch(error);
    }
  }
  async function control(action, id = null) { await rpc('tally_bridge_control', {p_action:action,p_voucher:id}); await refreshStatus(); }
  function paintActivity() {
    if (!$('bridgeJobs')) return;
    const jobs = status ? status.jobs : [];
    $('bridgeJobs').innerHTML = jobs.length ? '<div class="bridge-table-wrap"><table class="bridge-table"><thead><tr><th>Record</th><th>Status</th><th>Updated</th></tr></thead><tbody></tbody></table></div>' : '<div class="bridge-empty">No sync activity yet.</div>';
    const body = $('bridgeJobs').querySelector('tbody');
    jobs.forEach(j => {
      const tr = document.createElement('tr');
      tr.appendChild(node('td',j.kind === 'voucher' ? 'Invoice #' + j.number : (REPORTS[j.report] || 'Report')));
      const info = node('td', {pending:'Queued',leased:'Reading Tally',writing:'Confirming',done:'Confirmed',error:'Needs review',conflict:'Needs review'}[j.state] || j.state);
      if (j.detail) info.appendChild(node('small',j.detail));
      if (j.voucher_id && ['conflict','error'].includes(j.state)) {
        [[j.write_started === false ? 'Try sync again' : 'Recheck Tally',j.write_started === false ? 'retry' : 'recheck'],['Use Tally version','use_tally']].forEach(([label,action]) => {
          const b = node('button',label); b.style.marginRight='12px';
          b.onclick = () => { if (action !== 'use_tally' || confirm('Replace the pending web edit with the version in Tally after a fresh read?')) control(action,j.voucher_id).catch(error); };
          info.appendChild(b);
        });
        if (j.write_started === false && !j.linked_guid) {
          const b=node('button','Assign next invoice number');
          b.onclick=()=> { if(confirm('Reserve a new invoice number for this unposted voucher? Update any bill already printed with the old number.')) control('renumber',j.voucher_id).catch(error); };
          info.appendChild(b);
        }
      }
      tr.appendChild(info); tr.appendChild(node('td',date(j.updated_at))); body.appendChild(tr);
    });
  }
  async function loadUnlinked() {
    const generation=epoch;
    const res=await client.from('tally_vouchers').select('id,number,party,date').eq('bridge_state','unlinked').order('date',{ascending:false}).limit(50);
    if (epoch!==generation || !$('bridgeUnlinked')) return;
    if(res.error) throw new Error(res.error.message);
    const out=$('bridgeUnlinked'); out.replaceChildren();
    if (!res.data.length) out.appendChild(node('p','No unlinked vouchers.'));
    res.data.forEach(v=> { const row=node('p','#'+v.number+' · '+v.party+' · '+v.date+' '); const b=node('button','Queue for Tally'); b.className='linkbtn'; b.onclick=()=>control('queue',v.id).then(loadUnlinked).catch(error); row.appendChild(b); out.appendChild(row); });
  }
  async function fetchReport(refresh, polling=false) {
    if (busy) return;
    const generation=epoch;
    busy=true;
    if (!polling && $('bridgeFetch')) {
      $('bridgeFetch').disabled = true;
      $('bridgeCached').disabled = true;
      $(refresh ? 'bridgeFetch' : 'bridgeCached').textContent = 'Requesting…';
      $('bridgeContent').setAttribute('aria-busy', 'true');
    }
    try {
      const args = polling ? reportArgs : {p_report:$('bridgeReport').value,p_from:$('bridgeFrom').value,p_to:$('bridgeTo').value,p_ledger:$('bridgeLedger').value.trim()};
      if (!args || !args.p_from || !args.p_to || args.p_from>args.p_to) throw new Error('Choose a valid date range.');
      const result=await rpc('tally_bridge_report',Object.assign({},args,{p_refresh:refresh}));
      reportArgs=args; report=result;
      if(tab==='reports') paintReport();
      if (refresh) await refreshStatus();
    } finally {
      if(epoch===generation) {
        busy=false;
        if (!polling && $('bridgeFetch')) {
          $('bridgeFetch').disabled = false; $('bridgeFetch').textContent = 'Fetch from Tally';
          $('bridgeCached').disabled = false; $('bridgeCached').textContent = 'Open saved report';
          $('bridgeContent').removeAttribute('aria-busy');
        }
      }
    }
  }
  function selectionMatches() {
    return !!(reportArgs && $('bridgeReport') && reportArgs.p_report===$('bridgeReport').value && reportArgs.p_from===$('bridgeFrom').value && reportArgs.p_to===$('bridgeTo').value &&
      (reportArgs.p_report!=='ledger' || reportArgs.p_ledger===$('bridgeLedger').value.trim()));
  }
  function syncExportButtons() {
    ['bridgeDownload','bridgePdf','bridgeExcel','bridgePrint'].forEach(id=> {if($(id))$(id).disabled=exportBusy || !report?.content || !selectionMatches();});
    if(report && !selectionMatches() && $('bridgeReportTime'))$('bridgeReportTime').textContent='Selection changed. Fetch or open the saved report for this ledger and period before exporting.';
  }
  async function suggestLedgers() {
    if(!$('bridgeLedger') || $('bridgeReport').value!=='ledger')return;
    const value=$('bridgeLedger').value.trim();
    try {
      const items=await rpc('tally_bridge_browse',{p_kind:'Ledger',p_search:value.slice(0,100),p_offset:0});
      if(!$('bridgeLedgerNames') || $('bridgeLedger').value.trim()!==value)return;
      $('bridgeLedgerNames').replaceChildren(...items.filter(o=>!o.deleted && o.data.name).map(o=> {const e=document.createElement('option');e.value=o.data.name;return e;}));
    } catch(e) { /* Exact ledger entry remains usable if suggestions are unavailable. */ }
  }
  function exportMeta() {
    return {title:REPORTS[reportArgs.p_report],ledger:reportArgs.p_report==='ledger'?reportArgs.p_ledger:'',from:reportArgs.p_from,to:reportArgs.p_to,
      fetched:report.fetched_at || 'Unknown — verify in Tally',
      notice:'Saved snapshot'+(!online()?' | Windows PC offline':'')+(['pending','leased'].includes(report.state)?' | Refresh pending':'')+'. This file is not a live balance.'};
  }
  function exportHTML() {
    const meta=exportMeta();
    const heading='<h1>'+esc(meta.title)+'</h1><p>'+esc(meta.ledger)+'</p><p>'+esc(meta.from+' to '+meta.to)+'</p><p>Fetched: '+esc(meta.fetched)+'</p><p>'+esc(meta.notice)+'</p>';
    const body=new DOMParser().parseFromString(safeReport(report.content),'text/html').body.innerHTML;
    return safeReport(heading+body);
  }
  async function exportReport(format) {
    if(exportBusy || !report?.content || !selectionMatches())return;
    const generation=epoch,snapshot=report,meta=exportMeta(),html=safeReport(report.content);
    exportBusy=true;syncExportButtons();$('bridgeMessage').textContent='Preparing your '+(format==='pdf'?'PDF':'Excel')+' file…';
    try {
      const E=global.VFTallyExport;
      const blob=await (format==='pdf'?E.pdf(html,meta):E.excel(html,meta));
      if(epoch!==generation || report!==snapshot || !user || !selectionMatches())return;
      E.download(blob,E.filename(meta,format));
      $('bridgeMessage').textContent='Download prepared from the saved Tally snapshot. Its ledger, period and fetch time are included.';
    } finally {if(epoch===generation){exportBusy=false;syncExportButtons();}}
  }
  function printReport() {
    if(!report?.content || !selectionMatches())return;
    const win=window.open('','_blank');
    if(!win){error(new Error('Allow pop-ups to open the print view.'));return;}
    let printed=false;const print=()=> {if(!printed){printed=true;win.print();}};
    win.addEventListener('load',print,{once:true});
    win.opener=null;win.document.write(exportHTML());win.document.close();
    if(win.document.readyState==='complete')print();
  }
  // Defence in depth: allowlist again in the browser, even for a compromised device.
  function safeReport(content) {
    const doc = new DOMParser().parseFromString(content,'text/html');
    const allowed = new Set(['TABLE','THEAD','TBODY','TFOOT','TR','TD','TH','P','BR','B','STRONG','I','EM','H1','H2','H3','H4','DIV','SPAN','PRE','HR']);
    const output=document.createElement('div');
    function copy(source,target) {
      Array.from(source.childNodes).forEach(n=> {
        if(n.nodeType===3) target.appendChild(document.createTextNode(n.textContent));
        else if(n.nodeType===1 && allowed.has(n.tagName)) {
          const e=document.createElement(n.tagName.toLowerCase());
          ['colspan','rowspan'].forEach(k=> {const v=n.getAttribute(k); if(v && /^\d+$/.test(v) && +v>0 && +v<=100) e.setAttribute(k,v);});
          copy(n,e); target.appendChild(e);
        }
      });
    }
    copy(doc.body,output);
    return '<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; base-uri \'none\'; form-action \'none\'"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tally report</title><style>body{font:13px system-ui;color:#202b37;background:white;padding:20px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ddd;padding:7px;text-align:left}h1,h2,h3{color:#c04e22}@media print{body{padding:0;font-size:10px}}</style></head><body>'+output.innerHTML+'</body></html>';
  }
  function paintReport() {
    if(!report || !$('bridgeReportOutput')) return;
    const waiting=['pending','leased'].includes(report.state);
    $('bridgeReportTime').textContent=(report.fetched_at?'Saved from Tally: '+date(report.fetched_at):'No saved result yet')+(waiting?' · Refresh queued; keep working while the PC reconnects.':'')+(report.detail?' · '+report.detail:'');
    syncExportButtons();
    const output=$('bridgeReportOutput'); output.replaceChildren();
    if(report.content) {
      const frame=document.createElement('iframe'); frame.className='bridge-report'; frame.title=REPORTS[reportArgs.p_report]; frame.setAttribute('sandbox',''); frame.referrerPolicy='no-referrer'; frame.srcdoc=safeReport(report.content); output.className=''; output.appendChild(frame);
    } else { output.className='bridge-empty'; output.textContent=waiting?'Your report is queued. It will appear here when Tally responds.':'No saved report for this period. Choose Fetch from Tally.'; }
  }
  function downloadReport() {
    if(!report || !report.content || !selectionMatches()) return;
    const url=URL.createObjectURL(new Blob([exportHTML()],{type:'text/html'}));
    const a=document.createElement('a'); a.href=url; a.download='Tally-'+reportArgs.p_report+'-'+reportArgs.p_from+'-'+reportArgs.p_to+'.html'; a.click(); setTimeout(()=>URL.revokeObjectURL(url),10000);
  }
  async function browse() {
    const kind=$('bridgeKind').value;
    const data=await rpc('tally_bridge_browse',{p_kind:kind,p_search:$('bridgeSearch').value.trim(),p_offset:offset});
    if(!$('bridgeRecords')) return;
    $('bridgePrev').disabled=offset===0; $('bridgeNext').disabled=data.length<50;
    $('bridgeRecords').innerHTML='<div class="bridge-table-wrap"><table class="bridge-table"><thead><tr><th>Record</th><th>Details</th><th>Last synced</th></tr></thead><tbody></tbody></table></div>';
    const body=$('bridgeRecords').querySelector('tbody');
    data.forEach(o=> {const d=o.data,tr=document.createElement('tr');
      const record=node('td',d.number?'#'+d.number+' · '+d.voucher_type:d.name);
      const view=node('button','View details'); view.style.display='block'; view.onclick=()=>details(kind,o.guid).catch(error); record.appendChild(view); tr.appendChild(record);
      if(kind==='Ledger' && !o.deleted && d.name) {
        const ledger=node('button','Open ledger report');ledger.onclick=()=> {selectTab('reports');$('bridgeReport').value='ledger';$('bridgeLedger').value=d.name;$('bridgeReport').onchange();fetchReport(false).catch(error);};record.appendChild(ledger);
      }
      const info=node('td',d.party||d.parent||d.unit||'');
      if(d.closing_balance) info.appendChild(node('small','Closing balance: '+d.closing_balance));
      if(o.deleted||d.cancelled) info.appendChild(node('small','Cancelled / deleted in Tally'));
      tr.appendChild(info);tr.appendChild(node('td',date(o.updated_at)));body.appendChild(tr);
    });
    if(!data.length) $('bridgeRecords').appendChild(node('p','No matching records in the last sync.'));
  }
  async function details(kind,guid) {
    const obj=await rpc('tally_bridge_object',{p_kind:kind,p_guid:guid});
    if (!obj || !$('bridgeRecords')) return;
    const panel=document.createElement('div'); panel.className='bridge-panel';
    panel.appendChild(node('h3',obj.data.number?'Invoice #'+obj.data.number:obj.data.name||kind));
    panel.appendChild(node('p','Last synced: '+date(obj.updated_at)+(obj.deleted?' · Deleted in Tally':'')));
    const download=node('button','Download full Tally record'); download.className='btn ghost';
    download.onclick=()=> { const url=URL.createObjectURL(new Blob([obj.data.xml],{type:'application/octet-stream'})); const a=document.createElement('a'); a.href=url; a.download='Tally-'+kind+'-'+guid.replace(/[^a-zA-Z0-9-]/g,'')+'.xml'; a.click(); setTimeout(()=>URL.revokeObjectURL(url),10000); };
    panel.appendChild(download);
    const xml=new DOMParser().parseFromString(obj.data.xml,'application/xml');
    const table=document.createElement('table'); table.className='bridge-table';
    const labels={DATE:'Date',VOUCHERNUMBER:'Invoice number',VOUCHERTYPENAME:'Voucher type',PARTYLEDGERNAME:'Party',LEDGERNAME:'Ledger',STOCKITEMNAME:'Stock item',AMOUNT:'Amount',BILLEDQTY:'Billed quantity',RATE:'Rate',NAME:'Name',PARENT:'Parent group',CLOSINGBALANCE:'Closing balance',NARRATION:'Narration',GSTIN:'GSTIN',PARTYGSTIN:'GSTIN',GSTREGISTRATIONTYPE:'GST registration',EIVEHNO:'Vehicle'};
    Array.from(xml.querySelectorAll('*')).filter(e=>!e.children.length && e.textContent.trim() && labels[e.localName]).slice(0,300).forEach(e=> { const tr=document.createElement('tr'); tr.appendChild(node('td',labels[e.localName])); tr.appendChild(node('td',e.textContent)); table.appendChild(tr); });
    panel.appendChild(table);
    const old=$('bridgeRecordDetail'); if(old)old.remove(); panel.id='bridgeRecordDetail'; $('bridgeRecords').appendChild(panel); panel.scrollIntoView({block:'start',behavior:'smooth'});
  }
  global.VFTallyBridge = {
    init(c,config,session) {
      this.clear(); client=c; cfg=config; user=session.user.id; $('btnBridge').hidden=false;
      refreshStatus();
      timer=setInterval(()=> {if(document.hidden || !user) return; refreshStatus(); if(!exportBusy && tab==='reports' && report && selectionMatches() && ['pending','leased'].includes(report.state)) fetchReport(false,true).catch(error);},10000);
    },
    open() { mount(); refreshStatus(); },
    active() { return !!(status && status.config.active); },
    async assertManual() {
      try {status=await rpc('tally_bridge_status');}
      catch(e) {if(['PGRST202','42883'].includes(e.code))return;throw new Error('Could not verify the Tally connection. Manual XML export is blocked until the connection can be checked.');}
      if(!status || status.config.active)throw new Error('Automatic Tally sync is enabled. Manual XML export is blocked to avoid duplicate posting.');
    },
    label(value) { return value && value!=='unlinked' ? LABELS[value] || value : ''; },
    safeReport,
    clear() { epoch++; clearInterval(timer); clearTimeout(pairingExpiry); clearTimeout(ledgerTimer); client=null; user=null; status=null; report=null; reportArgs=null; busy=false;exportBusy=false;
      if($('scrBridge')) $('scrBridge').replaceChildren(); if($('btnBridge')) $('btnBridge').hidden=true; }
  };
})(window);
