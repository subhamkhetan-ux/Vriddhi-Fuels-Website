/* Local-only exports of the exact saved Tally report. No accounting totals are inferred. */
(function(global) {
  'use strict';
  const loaders = new Map();
  const clean = s => String(s || '').replace(/\u00a0/g,' ').replace(/[\t\r ]+/g,' ').trim();
  function displayedText(node) {
    const copy=node.cloneNode(true);
    copy.querySelectorAll('br').forEach(br=>br.replaceWith(document.createTextNode('\n')));
    copy.querySelectorAll('p,div,pre,h1,h2,h3,h4').forEach(el=>el.appendChild(document.createTextNode('\n')));
    return clean(copy.textContent);
  }
  function script(url, name) {
    if (global[name]) return Promise.resolve(global[name]);
    if (!loaders.has(url)) loaders.set(url,new Promise((resolve,reject)=> {
      const el=document.createElement('script'); el.src=url;
      const timer=setTimeout(()=>fail(),25000);
      function fail() { clearTimeout(timer); el.remove(); loaders.delete(url); reject(new Error('Export tools could not load. Check your Internet connection and try again.')); }
      el.onerror=fail; el.onload=()=> { clearTimeout(timer); if(global[name])resolve(global[name]);else fail(); };
      document.head.appendChild(el);
    }));
    return loaders.get(url);
  }
  // How Tally laid a cell out (bridge.js keeps its alignment and marks
  // amounts .n, header rows .h and total rows .t): a = 'r' | 'c' | '', b = bold.
  function cellFormat(td) {
    const style=(td.getAttribute('style')||'').toLowerCase(),align=(td.getAttribute('align')||'').toLowerCase();
    const a=/text-align:\s*right/.test(style) || align==='right' || td.classList.contains('n') ? 'r'
      : /text-align:\s*center/.test(style) || align==='center' ? 'c' : '';
    const strong=td.querySelectorAll('b,strong');
    const b=td.tagName==='TH' || /font-weight:\s*(?:bold|bolder|[6-9]00)/.test(style)
      || (strong.length>0 && clean(Array.from(strong).map(e=>e.textContent).join(''))===clean(td.textContent));
    return {a,b};
  }
  function blocks(html) {
    const doc=new DOMParser().parseFromString(html,'text/html'), out=[];
    let cells=0;
    function walk(n) {
      if(n.nodeType===3) { const s=clean(n.textContent); if(s)out.push({text:s}); return; }
      if(n.nodeType!==1 || ['SCRIPT','STYLE','HEAD','IMG','IFRAME','OBJECT'].includes(n.tagName))return;
      if(n.tagName==='TABLE' && !n.querySelector('table')) {
        const rows=[], merges=[], format=[];
        Array.from(n.rows).forEach((tr,r)=> {
          rows[r] ||= []; let c=0;
          format[r] ||= {cells:[]};
          format[r].h=tr.classList.contains('h') || !!tr.querySelector('th');
          format[r].t=tr.classList.contains('t');
          format[r].b=tr.classList.contains('b');
          Array.from(tr.cells).forEach(td=> {
            while(rows[r][c]!==undefined)c++;
            const rs=Math.min(100,Math.max(1,td.rowSpan)),cs=Math.min(100,Math.max(1,td.colSpan));
            if((cells+=rs*cs)>200000 || r+rs>20000 || c+cs>100)throw new Error('Report is too large to export safely. Choose a shorter period.');
            const content=displayedText(td);
            if(content.length>32767)throw new Error('A report cell exceeds Excel’s text limit. Choose a shorter period.');
            for(let y=r;y<r+rs;y++) { rows[y] ||= []; for(let x=c;x<c+cs;x++) {
              if(rows[y][x]!==undefined)throw new Error('Report has overlapping table cells. Use Print / Save PDF to preserve its layout.');
              rows[y][x]=(y===r && x===c)?content:'';
            }}
            if(rs>1 || cs>1)merges.push({s:{r,c},e:{r:r+rs-1,c:c+cs-1}});
            format[r].cells[c]=cellFormat(td);
            c+=cs;
          });
        });
        const width=Math.max(0,...rows.map(r=>r.length));
        if(rows.length && width)out.push({rows:rows.map(r=>Array.from({length:width},(_,i)=>r[i]||'')),merges,
          format:rows.map((_,r)=>format[r]||{cells:[]})});
      } else if(n.querySelector('table')) Array.from(n.childNodes).forEach(walk);
      else { const text=displayedText(n); if(text)out.push({text,bold:/^(?:H[1-4]|B|STRONG)$/.test(n.tagName)}); }
    }
    walk(doc.body);
    if(!out.length)throw new Error('This saved report has no exportable content. Fetch it again from Tally.');
    return out;
  }
  function filename(meta, ext) {
    const name=String(meta.ledger || meta.title).replace(/[<>:"/\\|?*\x00-\x1f]/g,'-').slice(0,80).replace(/[. ]+$/,'');
    return 'Tally-'+name+'-'+meta.from+'-'+meta.to+'.'+ext;
  }
  function info(meta) {
    return [['Company','Vriddhi Fuels'],['Report',meta.title],['Ledger',meta.ledger || '—'],['From',meta.from],['To',meta.to],
      ['Data fetched from Tally',meta.fetched],['Export created',new Date().toISOString()],['Status',meta.notice],
      ['Values','Report sheets use numeric cells only for plain amounts under Debit/Credit/Amount/Balance headings. Original sheets preserve displayed text. Dates, IDs, formulas and Dr/Cr text are never reinterpreted.']];
  }
  async function excel(html, meta) {
    const data=blocks(html),X=await script('../pdf/vendor/xlsx.full.min.js','XLSX'),book=X.utils.book_new();
    const details=X.utils.aoa_to_sheet(info(meta)); details['!cols']=[{wch:27},{wch:105}];
    X.utils.book_append_sheet(book,details,'Report info');
    const combined=[],typedCombined=[],merges=[];let anyConverted=false;
    data.forEach(b=> {
      const rows=b.rows || [[b.text]];
      // Explicit string cells prevent formulas, date coercion and lost leading zeroes.
      const typed=rows.map(r=>r.map(v=>({t:'s',v:String(v)})));
      const heading=/^(debit|credit|amount|balance)(?:\s*\((?:rs\.?|inr|₹)\))?$/i;
      const hr=rows.findIndex((r,i)=>i<10 && r.some(s=>heading.test(s)));
      let converted=false;
      if(hr>=0)rows[hr].forEach((h,c)=> {if(heading.test(h))for(let r=hr+1;r<rows.length;r++) {
        const s=rows[r][c].trim();
        if(!/^-?(?:\d+|\d{1,3}(?:,\d{3})+|\d{1,2}(?:,\d{2})*,\d{3})(?:\.\d{1,2})?$/.test(s))continue;
        const plain=s.replace(/,/g,''),n=Number(plain);
        if(/^[-]?0\d/.test(plain) || Math.abs(n)>999999999999.99)continue;
        typed[r][c]={t:'n',v:n,z:'#,##0.00;[Red]-#,##0.00'};converted=true;
      }});
      const offset=combined.length;
      (b.merges || []).forEach(m=>merges.push({s:{r:m.s.r+offset,c:m.s.c},e:{r:m.e.r+offset,c:m.e.c}}));
      combined.push(...rows,[]);typedCombined.push(...typed,[]);anyConverted ||= converted;
    });
    const sheet=X.utils.aoa_to_sheet(typedCombined);sheet['!merges']=merges;
    sheet['!cols']=Array.from({length:Math.max(...combined.map(r=>r.length))},()=>({wch:24}));
    X.utils.book_append_sheet(book,sheet,meta.ledger?'Ledger':'Report');
    if(anyConverted) {
      const original=X.utils.aoa_to_sheet(combined.map(r=>r.map(v=>({t:'s',v:String(v)}))));
      original['!cols']=sheet['!cols'];original['!merges']=merges;
      X.utils.book_append_sheet(book,original,'Original display');
    }
    return new Blob([X.write(book,{bookType:'xlsx',type:'array',compression:true})],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
  }
  // The saved report as Tally Prime prints it: A4 (landscape only for wide
  // tables), the company heading, report title and period centred on the
  // first page, column headings between rules and repeated on every page,
  // amounts right-aligned, totals bold under a rule, "Page n" at the foot.
  // meta.head: [kind, text] lines from bridge.js (co, addr, ledger, title, period).
  async function pdf(html, meta) {
    const data=blocks(html);
    const [P,fontkit]=await Promise.all([import('../pdf/vendor/pdf-lib.esm.min.js'),script('vendor/fontkit.umd.min.js','fontkit')]);
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),25000);
    let bytes;
    try { const r=await fetch('vendor/NotoSans-Regular.ttf',{signal:controller.signal}); if(!r.ok)throw new Error();bytes=await r.arrayBuffer(); }
    catch(e) { throw new Error('PDF font could not load. Try again, or use Print / Save PDF.'); }
    finally { clearTimeout(timer); }
    const doc=await P.PDFDocument.create(); doc.registerFontkit(fontkit);
    // Embed the full font: avoids incompatible subset encoders across the existing PDF library and fontkit.
    const font=await doc.embedFont(bytes,{subset:false}),supported=new Set(font.getCharacterSet());
    function printable(s) {
      for(const ch of s)if(ch!=='\n' && !supported.has(ch.codePointAt(0)))throw new Error('This report uses characters the download font cannot render. Use Print / Save PDF to preserve those names.');
      return s;
    }
    const head=(meta.head && meta.head.length ? meta.head : [['co','Vriddhi Fuels'],['ledger',meta.ledger || ''],['title',meta.title],['period',meta.from+' to '+meta.to]]).filter(l=>l[1]);
    const source='Saved from Tally Prime: '+meta.fetched+' | '+meta.notice;
    [...head.map(l=>l[1]),source,...data.flatMap(b=>b.rows?b.rows.flat():[b.text])].forEach(printable);
    doc.setTitle(meta.title+(meta.ledger?' — '+meta.ledger:''));doc.setSubject('Saved Tally snapshot fetched '+meta.fetched);doc.setCreator('Vriddhi Fuels Tally');
    if(data.some(b=>b.rows && b.rows[0].length>16))throw new Error('This table is too wide for a readable PDF. Use Excel or Print / Save PDF.');
    const wide=data.some(b=>b.rows && b.rows[0].length>7);
    const W=wide?842:595,H=wide?595:842,M=34,usable=W-2*M,size=8.5,line=11.5,ink=P.rgb(0,0,0);
    let page,y,pages=0,repeat=null;
    const width=(s,sz)=>font.widthOfTextAtSize(s,sz||size);
    function wrap(value,room,sz) {
      const lines=[];let current='';
      for(const ch of String(value)) {
        if(ch==='\n' || (current && width(current+ch,sz)>room)) { lines.push(current);current=ch==='\n'?'':ch; }
        else current+=ch;
      }
      lines.push(current);return lines;
    }
    // Noto Sans has no bold face here; a second pass a hair to the right reads as Tally's bold.
    function text(s,x,yy,o={}) {
      const sz=o.size||size;
      if(o.align==='r')x-=width(s,sz); else if(o.align==='c')x-=width(s,sz)/2;
      page.drawText(s,{x,y:yy,font,size:sz,color:o.grey?P.rgb(.35,.35,.35):ink});
      if(o.bold)page.drawText(s,{x:x+.3,y:yy,font,size:sz,color:ink});
    }
    function rule(yy,x0=M,x1=W-M) {page.drawLine({start:{x:x0,y:yy},end:{x:x1,y:yy},thickness:.6,color:ink});}
    const HEAD={co:{size:12.5,bold:true},addr:{size:8},ledger:{size:11,bold:true,gap:6},title:{size:10,bold:true,gap:4},period:{size:8}};
    function newPage() {
      if(pages>=500)throw new Error('Report exceeds 500 PDF pages. Choose a shorter period.');
      page=doc.addPage([W,H]);pages++;y=H-M;
      if(pages===1) {
        let after='';
        head.forEach(([kind,value])=> {
          const o=Object.assign({},HEAD[kind]||{size});
          if(kind==='title' && after==='ledger') {o.bold=false;o.gap=0;}
          y-=(o.gap||0);
          wrap(value,usable,o.size).forEach(t=> {y-=o.size*1.25;text(t,W/2,y,{size:o.size,bold:o.bold,align:'c'});});
          after=kind;
        });
        y-=14;
      } else {
        const title=head.filter(l=>l[0]==='co' || l[0]==='ledger' || l[0]==='title').map(l=>l[1]).join(' · ');
        y-=10;text(title,W/2,y,{size:8,bold:true,align:'c'});
        y-=11;text((head.find(l=>l[0]==='period')||['',''])[1]+' (continued)',W/2,y,{size:7.5,align:'c'});y-=12;
      }
      wrap(source,usable-60,6.5).slice(0,2).forEach((t,i)=>text(t,M,18-i*8,{size:6.5,grey:true}));
      text('Page '+pages,W-M,18,{size:7.5,align:'r'});
      if(repeat)repeat();
    }
    newPage();
    for(const b of data) {
      if(!b.rows) {
        repeat=null;
        for(const t of wrap(b.text,usable)) {if(y<50)newPage();y-=line;text(t,M,y,{bold:b.bold});} y-=4;continue;
      }
      const count=b.rows[0].length;
      const spans=new Map((b.merges || []).map(m=>[m.s.r+':'+m.s.c,m.e.c-m.s.c+1]));
      const right=c=>b.format.filter((f,r)=>!f.h && b.rows[r][c]).some(f=>f.cells[c] && f.cells[c].a==='r');
      const weights=Array.from({length:count},(_,c)=>Math.min(45,Math.max(right(c)?11:6,...b.rows.map((r,i)=>(spans.get(i+':'+c)||1)>1?0:r[c].length))));
      const sum=weights.reduce((a,b)=>a+b,0),widths=weights.map(w=>w/sum*usable);
      function drawRow(r) {
        const row=b.rows[r],f=b.format[r]||{cells:[]},cells=[];
        for(let c=0;c<count;) {
          const span=spans.get(r+':'+c)||1,w=widths.slice(c,c+span).reduce((a,b)=>a+b,0),cf=f.cells[c]||{};
          cells.push({x:M+widths.slice(0,c).reduce((a,b)=>a+b,0),w,lines:row[c]?wrap(row[c],w-8):[],a:cf.a,b:cf.b || f.h || f.t || f.b});c+=span;
        }
        const total=Math.max(1,...cells.map(cell=>cell.lines.length));
        let pos=0;
        while(pos<total) {
          if(y-line-6<34)newPage();
          const take=Math.min(total-pos,Math.max(1,Math.floor((y-40)/line)));
          // headings ruled full width; totals only above their amounts
          if(f.h)rule(y);
          else if(f.t && pos===0)cells.forEach(cell=> {if(cell.a==='r' && cell.lines.length)rule(y,cell.x+4,cell.x+cell.w-2);});
          cells.forEach(cell=> {
            for(let i=0;i<take;i++) {
              const t=cell.lines[pos+i];if(!t)continue;
              const x=cell.a==='r'?cell.x+cell.w-4:cell.a==='c'?cell.x+cell.w/2:cell.x+4;
              text(t,x,y-9-i*line,{align:cell.a,bold:cell.b});
            }
          });
          y-=take*line+(f.h?5:2);pos+=take;
          if(f.h)rule(y+1);
        }
      }
      const heads=[];for(let r=0;r<b.rows.length && b.format[r] && b.format[r].h;r++)heads.push(r);
      repeat=null;
      for(let r=0;r<b.rows.length;r++) {
        if(r%50===0)await new Promise(resolve=>setTimeout(resolve,0));
        drawRow(r);
        if(r===heads[heads.length-1])repeat=()=>heads.forEach(drawRow);
      }
      repeat=null;y-=8;
      await new Promise(resolve=>setTimeout(resolve,0));
    }
    return new Blob([await doc.save()],{type:'application/pdf'});
  }
  function download(blob,name) {
    const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;
    document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);
  }
  global.VFTallyExport={blocks,filename,excel,pdf,download};
})(window);
