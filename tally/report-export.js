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
  function blocks(html) {
    const doc=new DOMParser().parseFromString(html,'text/html'), out=[];
    let cells=0;
    function walk(n) {
      if(n.nodeType===3) { const s=clean(n.textContent); if(s)out.push({text:s}); return; }
      if(n.nodeType!==1 || ['SCRIPT','STYLE','HEAD','IMG','IFRAME','OBJECT'].includes(n.tagName))return;
      if(n.tagName==='TABLE' && !n.querySelector('table')) {
        const rows=[], merges=[];
        Array.from(n.rows).forEach((tr,r)=> {
          rows[r] ||= []; let c=0;
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
            c+=cs;
          });
        });
        const width=Math.max(0,...rows.map(r=>r.length));
        if(rows.length && width)out.push({rows:rows.map(r=>Array.from({length:width},(_,i)=>r[i]||'')),merges});
      } else if(n.querySelector('table')) Array.from(n.childNodes).forEach(walk);
      else { const text=displayedText(n); if(text)out.push({text}); }
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
    const header=['Vriddhi Fuels | '+meta.title,meta.ledger || '',meta.from+' to '+meta.to,'Fetched: '+meta.fetched,meta.notice].filter(Boolean);
    [...header,...data.flatMap(b=>b.rows?b.rows.flat():[b.text])].forEach(printable);
    doc.setTitle(meta.title+(meta.ledger?' — '+meta.ledger:''));doc.setSubject('Saved Tally snapshot fetched '+meta.fetched);doc.setCreator('Vriddhi Fuels Tally');
    const W=842,H=595,M=30,usable=W-2*M,size=9,line=12;
    let page,y,pages=0;
    function wrap(value,width) {
      const lines=[];let current='';
      for(const ch of String(value)) {
        if(ch==='\n' || (current && font.widthOfTextAtSize(current+ch,size)>width)) { lines.push(current);current=ch==='\n'?'':ch; }
        else current+=ch;
      }
      lines.push(current);return lines;
    }
    function text(s,x,yy) {page.drawText(s,{x,y:yy,font,size,color:P.rgb(.12,.15,.19)});}
    function newPage() {
      if(pages>=500)throw new Error('Report exceeds 500 PDF pages. Choose a shorter period.');
      page=doc.addPage([W,H]);pages++;y=H-M;
      header.forEach(s=>wrap(s,usable).forEach(t=> {text(t,M,y);y-=line;}));y-=10;
      text('Saved Tally report | Page '+pages,M,15);
    }
    newPage();
    for(const b of data) {
      if(!b.rows) {
        for(const t of wrap(b.text,usable)) {if(y<45)newPage();text(t,M,y);y-=line;} y-=8;continue;
      }
      const count=b.rows[0].length;
      if(count>16)throw new Error('This table is too wide for a readable PDF. Use Excel or Print / Save PDF.');
      const spans=new Map((b.merges || []).map(m=>[m.s.r+':'+m.s.c,m.e.c-m.s.c+1]));
      const weights=Array.from({length:count},(_,c)=>Math.min(45,Math.max(10,...b.rows.map((r,i)=>(spans.get(i+':'+c)||1)>1?0:r[c].length))));
      const sum=weights.reduce((a,b)=>a+b,0),widths=weights.map(w=>w/sum*usable);
      let rowIndex=0;
      for(const row of b.rows) {
        if(rowIndex++%50===0)await new Promise(resolve=>setTimeout(resolve,0));
        const cells=[];
        for(let c=0;c<count;) {
          const span=spans.get((rowIndex-1)+':'+c)||1,width=widths.slice(c,c+span).reduce((a,b)=>a+b,0);
          cells.push({width,lines:wrap(row[c],width-8)});c+=span;
        }
        let pos=0,total=Math.max(...cells.map(cell=>cell.lines.length));
        while(pos<total) {
          if(y<60)newPage();
          const take=Math.min(total-pos,Math.floor((y-40-8)/line)),height=take*line+8;let x=M;
          cells.forEach(cell=> {
            page.drawRectangle({x,y:y-height,width:cell.width,height,borderWidth:.4,borderColor:P.rgb(.8,.81,.83)});
            for(let i=0;i<take;i++)if(cell.lines[pos+i])text(cell.lines[pos+i],x+4,y-12-i*line);
            x+=cell.width;
          });y-=height;pos+=take;
        }
      }
      y-=10;
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
