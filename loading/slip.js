/* Vriddhi Fuels — Tanker Loading: pictures to send a customer.
   A trip slip (one sale: tanker, when, invoices) and a trip statement (a
   customer's trips over a period), drawn on a canvas in the app's colours,
   shared as PNG or as a PDF (written here, no library). Takes the figures
   ready to print; every quantity carries the label the app gives it
   ("Invoiced" = the bills' litres, "Dispatched" = the litres sent). */
(function(){
  const LOGO = "../Vriddhi%20Fuels%20Logo.png";
  const SANS = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  const DISPLAY = '"Sora", ' + SANS;
  const MONO = '"IBM Plex Mono", ui-monospace, Menlo, monospace';
  const C = { ink:"#1b2130", muted:"#5d6475", faint:"#8b91a0", line:"#e6e1da", soft:"#f7f3ee",
    orange:"#F4511E", orange2:"#FF8A2B", good:"#12804a", warn:"#a05f00", navy:"#2353c4" };

  const nf = n => Number(n || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 });
  const dateShort = ts => new Date(ts).toLocaleDateString("en-IN", { day:"2-digit", month:"short", year:"numeric" });
  const dateLong = ts => new Date(ts).toLocaleDateString("en-IN", { weekday:"short" }) + ", " + dateShort(ts);
  const time = ts => new Date(ts).toLocaleTimeString("en-IN", { hour:"numeric", minute:"2-digit", hour12:true }).toUpperCase();
  const keyDate = k => { const p = String(k || "").split("-").map(Number); return p.length === 3 ? new Date(p[0], p[1] - 1, p[2]).getTime() : NaN; };

  let logoP = null;
  function logo(){
    if (!logoP) logoP = new Promise(res => { const im = new Image(); im.onload = () => res(im); im.onerror = () => res(null); im.src = LOGO; });
    return logoP;
  }
  function ready(){
    const f = document.fonts;
    const fonts = f && f.load ? Promise.all(["800 40px Sora", "700 40px Sora", "600 40px IBM Plex Mono"].map(x => f.load(x).catch(() => {}))) : Promise.resolve();
    return Promise.all([fonts, logo()]).then(r => r[1]);
  }

  function rr(ctx, x, y, w, h, r){
    ctx.beginPath(); ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }
  // one line kept within maxW: a smaller font (down to 3/4), then cut with "…"
  function txt(ctx, s, x, y, font, color, align, maxW){
    s = String(s == null ? "" : s);
    const m = /^(\d+) (\d+)px (.*)$/.exec(font);
    ctx.textAlign = align || "left"; ctx.fillStyle = color || C.ink; ctx.font = font;
    if (maxW && m) {
      let px = +m[2];
      while (ctx.measureText(s).width > maxW && px > +m[2] * 0.75) { px -= 1; ctx.font = m[1] + " " + px + "px " + m[3]; }
      if (ctx.measureText(s).width > maxW) { while (s.length > 1 && ctx.measureText(s + "…").width > maxW) s = s.slice(0, -1); s += "…"; }
    }
    ctx.fillText(s, x, y);
    return ctx.measureText(s).width;
  }
  // an Indian HSRP-style plate, as on the app's screens
  function plate(ctx, s, x, y, h){
    ctx.font = "600 " + Math.round(h * 0.52) + "px " + MONO;
    const strip = h * 0.42, w = ctx.measureText(s).width + strip + h * 0.62;
    rr(ctx, x, y, w, h, h * 0.16); ctx.fillStyle = "#fff"; ctx.fill();
    ctx.lineWidth = Math.max(3, h * 0.06); ctx.strokeStyle = "#10141f"; ctx.stroke();
    ctx.save(); rr(ctx, x, y, w, h, h * 0.16); ctx.clip();
    ctx.fillStyle = C.navy; ctx.fillRect(x, y, strip, h); ctx.restore();
    txt(ctx, "IND", x + strip / 2, y + h * 0.82, "700 " + Math.round(h * 0.2) + "px " + SANS, "#fff", "center");
    txt(ctx, s, x + strip + h * 0.3, y + h * 0.7, "600 " + Math.round(h * 0.52) + "px " + MONO, "#0f1320");
    return w;
  }
  function header(ctx, W, title, im){
    const H = 230, g = ctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, "#E5420E"); g.addColorStop(0.5, "#F7651C"); g.addColorStop(1, "#FF9A3C");
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    rr(ctx, 64, 55, 120, 120, 28); ctx.fillStyle = "#fff"; ctx.fill();
    if (im) { const s = 100 / Math.max(im.width, im.height); ctx.drawImage(im, 124 - im.width * s / 2, 115 - im.height * s / 2, im.width * s, im.height * s); }
    txt(ctx, "Vriddhi Fuels", 214, 118, "800 56px " + DISPLAY, "#fff");
    txt(ctx, title, 214, 165, "600 30px " + SANS, "rgba(255,255,255,.92)");
    return H;
  }
  function footer(ctx, W, H, right){
    ctx.fillStyle = C.line; ctx.fillRect(64, H - 96, W - 128, 2);
    txt(ctx, "Vriddhi Fuels · generated " + dateShort(Date.now()) + ", " + time(Date.now()), 64, H - 48, "500 24px " + SANS, C.faint);
    if (right) txt(ctx, right, W - 64, H - 48, "500 24px " + SANS, C.faint, "right");
  }
  function canvas(W, H){ const c = document.createElement("canvas"); c.width = W; c.height = H; const x = c.getContext("2d"); x.fillStyle = "#fff"; x.fillRect(0, 0, W, H); return c; }

  /* One sale. d = { customer, plate, ts, bills:[{no, date (YYYY-MM-DD), qty}], dispatched }
     With bills: the invoiced litres and each invoice. Without: the litres
     dispatched, the invoice to follow. */
  function trip(d){
    return ready().then(im => {
      const W = 1080, bills = d.bills || [], billed = bills.length > 0;
      const H = 1180 + Math.max(0, bills.length - 1) * 76;
      const c = canvas(W, H), ctx = c.getContext("2d");
      let y = header(ctx, W, "Trip slip", im) + 90;
      txt(ctx, "TO", 64, y, "700 24px " + SANS, C.muted); y += 64;
      txt(ctx, d.customer || "—", 64, y, "800 58px " + DISPLAY, C.ink, "left", W - 128); y += 70;

      // tanker and when
      y += 20; rr(ctx, 64, y, W - 128, 180, 28); ctx.fillStyle = C.soft; ctx.fill();
      txt(ctx, "TANKER", 104, y + 56, "700 22px " + SANS, C.muted);
      plate(ctx, d.plate || "—", 104, y + 78, 74);
      txt(ctx, "SENT", W - 104, y + 56, "700 22px " + SANS, C.muted, "right");
      txt(ctx, dateLong(d.ts), W - 104, y + 108, "700 34px " + DISPLAY, C.ink, "right");
      txt(ctx, time(d.ts), W - 104, y + 152, "600 30px " + SANS, C.muted, "right");
      y += 180 + 80;

      // the quantity
      txt(ctx, billed ? "QUANTITY INVOICED" : "QUANTITY DISPATCHED", 64, y, "700 24px " + SANS, C.muted); y += 112;
      const q = billed ? bills.reduce((s, b) => s + (+b.qty || 0), 0) : d.dispatched;
      const w = txt(ctx, nf(q), 64, y, "800 120px " + DISPLAY, C.ink);
      txt(ctx, "litres", 64 + w + 20, y, "700 40px " + DISPLAY, C.orange); y += 70;

      // the invoices
      if (billed) {
        y += 10;
        bills.forEach(b => {
          ctx.fillStyle = C.line; ctx.fillRect(64, y, W - 128, 2); y += 56;
          txt(ctx, "Invoice #" + b.no, 64, y, "700 32px " + DISPLAY, C.ink);
          txt(ctx, isNaN(keyDate(b.date)) ? "" : dateShort(keyDate(b.date)), 420, y, "500 28px " + SANS, C.muted);
          txt(ctx, nf(b.qty) + " L", W - 64, y, "700 32px " + DISPLAY, C.ink, "right");
          y += 20;
        });
      } else {
        rr(ctx, 64, y, W - 128, 80, 20); ctx.fillStyle = "rgba(250,178,25,.16)"; ctx.fill();
        txt(ctx, "Invoice to follow.", 96, y + 52, "600 28px " + SANS, C.warn);
      }
      footer(ctx, W, H);
      return [c];
    });
  }

  /* A customer's trips over a period, on A4 pages. d = { customer, period,
     rows:[{ ts, plate, bills:"#4781, #4782", qty, pending }] }: qty is the
     invoiced litres, or for a trip still waiting for its bills (pending)
     the litres dispatched. */
  function statement(d){
    return ready().then(im => {
      const W = 1240, H = 1754, rows = d.rows || [], ROW = 70, X = 64;
      const cols = { date: X + 20, time: X + 250, plate: X + 420, bills: X + 640, qty: W - X - 20 };
      const firstTop = 760, top = 330, bottom = H - 150;
      const per1 = Math.floor((bottom - firstTop - 90) / ROW), per = Math.floor((bottom - top - 90) / ROW);
      const pages = [];
      let i = 0;
      do { const n = pages.length ? per : per1; pages.push(rows.slice(i, i + n)); i += n; } while (i < rows.length);
      const invoiced = rows.filter(r => !r.pending).reduce((s, r) => s + (+r.qty || 0), 0);
      const pend = rows.filter(r => r.pending);
      return pages.map((list, p) => {
        const c = canvas(W, H), ctx = c.getContext("2d");
        let y = header(ctx, W, "Trip statement", im) + 80;
        if (p === 0) {
          txt(ctx, "TO", X, y, "700 24px " + SANS, C.muted); y += 64;
          txt(ctx, d.customer || "—", X, y, "800 56px " + DISPLAY, C.ink, "left", W - 2 * X); y += 56;
          txt(ctx, d.period || "", X, y, "600 30px " + SANS, C.muted); y += 50;
          // totals
          const tiles = [["TRIPS", nf(rows.length)], ["INVOICED", nf(invoiced) + " L"]];
          if (pend.length) tiles.push(["AWAITING INVOICE", pend.length + " trip" + (pend.length === 1 ? "" : "s")]);
          const tw = (W - 2 * X - (tiles.length - 1) * 24) / tiles.length;
          tiles.forEach((t, k) => {
            const tx = X + k * (tw + 24);
            rr(ctx, tx, y, tw, 150, 24); ctx.fillStyle = C.soft; ctx.fill();
            txt(ctx, t[0], tx + 30, y + 50, "700 22px " + SANS, C.muted);
            txt(ctx, t[1], tx + 30, y + 112, "800 48px " + DISPLAY, C.ink, "left", tw - 60);
          });
          y = firstTop;
        } else {
          txt(ctx, (d.customer || "") + " · " + (d.period || ""), X, y, "700 30px " + SANS, C.muted, "left", W - 2 * X);
          y = top;
        }
        // the table
        rr(ctx, X, y, W - 2 * X, 64, 16); ctx.fillStyle = "#1d2538"; ctx.fill();
        const hf = "700 22px " + SANS;
        txt(ctx, "DATE", cols.date, y + 41, hf, "#fff"); txt(ctx, "TIME", cols.time, y + 41, hf, "#fff");
        txt(ctx, "TANKER", cols.plate, y + 41, hf, "#fff"); txt(ctx, "INVOICE", cols.bills, y + 41, hf, "#fff");
        txt(ctx, "LITRES", cols.qty, y + 41, hf, "#fff", "right");
        y += 64;
        list.forEach((r, k) => {
          if (k % 2) { ctx.fillStyle = C.soft; ctx.fillRect(X, y, W - 2 * X, ROW); }
          const by = y + 45;
          txt(ctx, dateShort(r.ts), cols.date, by, "600 26px " + SANS, C.ink);
          txt(ctx, time(r.ts), cols.time, by, "500 26px " + SANS, C.muted);
          txt(ctx, r.plate, cols.plate, by, "600 26px " + MONO, C.ink);
          txt(ctx, r.pending ? "to follow" : r.bills, cols.bills, by, (r.pending ? "italic 500 24px " : "600 26px ") + SANS, r.pending ? C.warn : C.ink, "left", cols.qty - cols.bills - 190);
          txt(ctx, nf(r.qty) + (r.pending ? " *" : ""), cols.qty, by, "700 28px " + DISPLAY, C.ink, "right");
          y += ROW;
        });
        if (p === pages.length - 1) {
          ctx.fillStyle = C.ink; ctx.fillRect(X, y, W - 2 * X, 3); y += 58;
          txt(ctx, "Total invoiced", cols.date, y, "800 30px " + DISPLAY, C.ink);
          txt(ctx, nf(invoiced) + " L", cols.qty, y, "800 32px " + DISPLAY, C.ink, "right");
          if (pend.length) { y += 50; txt(ctx, "* dispatched — invoice to follow (not in the total)", cols.date, y, "500 24px " + SANS, C.warn); }
          if (!rows.length) { y += 50; txt(ctx, "No trips in this period.", cols.date, y, "500 26px " + SANS, C.muted); }
        }
        footer(ctx, W, H, pages.length > 1 ? "Page " + (p + 1) + " of " + pages.length : "");
        return c;
      });
    });
  }

  function blob(c, type, q){ return new Promise((res, rej) => c.toBlob(b => b ? res(b) : rej(new Error("Couldn't make the picture")), type, q)); }
  function png(c){ return blob(c, "image/png"); }

  /* A PDF with one A4 page per canvas, each page the canvas as a JPEG. */
  function pdf(cs){
    return Promise.all(cs.map(c => blob(c, "image/jpeg", 0.92).then(b => b.arrayBuffer()).then(a => ({ c, jpg: new Uint8Array(a) })))).then(imgs => {
      const enc = new TextEncoder(), parts = [], offs = [];
      let len = 0;
      const put = x => { const u = typeof x === "string" ? enc.encode(x) : x; parts.push(u); len += u.length; };
      const obj = (n, body) => { offs[n] = len; put(n + " 0 obj\n"); body(); put("\nendobj\n"); };
      const PW = 595.28, PH = 841.89, n = imgs.length;
      put("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");
      obj(1, () => put("<< /Type /Catalog /Pages 2 0 R >>"));
      obj(2, () => put("<< /Type /Pages /Count " + n + " /Kids [" + imgs.map((_, k) => (3 + k * 3) + " 0 R").join(" ") + "] >>"));
      imgs.forEach((im, k) => {
        const pg = 3 + k * 3, cs = pg + 1, ix = pg + 2;
        const s = Math.min(PW / im.c.width, PH / im.c.height), w = (im.c.width * s).toFixed(2), h = (im.c.height * s).toFixed(2);
        const ox = ((PW - w) / 2).toFixed(2), oy = ((PH - h) / 2).toFixed(2);
        obj(pg, () => put("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 " + PW + " " + PH + "] /Resources << /XObject << /Im" + k + " " + ix + " 0 R >> >> /Contents " + cs + " 0 R >>"));
        const body = "q " + w + " 0 0 " + h + " " + ox + " " + oy + " cm /Im" + k + " Do Q";
        obj(cs, () => put("<< /Length " + body.length + " >>\nstream\n" + body + "\nendstream"));
        obj(ix, () => { put("<< /Type /XObject /Subtype /Image /Width " + im.c.width + " /Height " + im.c.height
          + " /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length " + im.jpg.length + " >>\nstream\n"); put(im.jpg); put("\nendstream"); });
      });
      const total = 3 + n * 3, xref = len;
      put("xref\n0 " + total + "\n0000000000 65535 f \n");
      for (let k = 1; k < total; k++) put(String(offs[k]).padStart(10, "0") + " 00000 n \n");
      put("trailer\n<< /Size " + total + " /Root 1 0 R >>\nstartxref\n" + xref + "\n%%EOF");
      return new Blob(parts, { type: "application/pdf" });
    });
  }

  /* Share files with the phone's share sheet (WhatsApp, Mail…); where a
     browser can't share files, download them instead. */
  function share(files, title){
    const fs = files.map(f => new File([f.blob], f.name, { type: f.blob.type }));
    if (navigator.canShare && navigator.canShare({ files: fs }))
      return navigator.share({ files: fs, title: title }).then(() => "shared", e => (e && e.name === "AbortError") ? "cancelled" : Promise.reject(e));
    fs.forEach(f => {
      const url = URL.createObjectURL(f), a = document.createElement("a");
      a.href = url; a.download = f.name; document.body.appendChild(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
    });
    return Promise.resolve("downloaded");
  }

  window.Slip = { trip: trip, statement: statement, png: png, pdf: pdf, share: share };
})();
