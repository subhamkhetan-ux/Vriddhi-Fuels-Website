/* Vriddhi Fuels — Tanker Loading: pictures to send a customer.
   A trip slip (one sale: tanker, when, invoices) and a trip statement (a
   customer's trips over a period), drawn on a canvas in the app's colours,
   shared as PNG or as a PDF (written here, no library). Takes the figures
   ready to print; the litres on them are always the invoiced ones. */
(function(){
  const LOGO = "../Vriddhi%20Fuels%20Logo.png";
  // the business, as on the letterhead (tanker/assets/letterhead.png)
  const BIZ = { name:"Vriddhi Fuels", dealer:"Dealer: Indian Oil Corporation Limited",
    address:"At Kherual, Post Badmal, Jharsuguda, Odisha 768202", phone:"9937344411 · 7008540577", gstin:"21AATFV8250A1Z8" };
  const PRODUCT = "High Speed Diesel (HSD)";
  const SANS = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  const DISPLAY = '"Sora", ' + SANS;
  const MONO = '"IBM Plex Mono", ui-monospace, Menlo, monospace';
  /* Light, and dark as the ledger app's pictures (ledger/js/share-svg.js):
     near-black with an orange and a purple glow, light text, glass cards.
     The orange letterhead band, the tanker and the plates are the same in
     both. trip() / statement() pick one from d.dark. */
  const LIGHT = { bg:"#ffffff", ink:"#1b2130", muted:"#5d6475", faint:"#8b91a0", line:"#e6e1da", soft:"#f7f3ee",
    orange:"#F4511E", good:"#12804a", warn:"#a05f00", navy:"#2353c4",
    strip:"#fdf0e6", stripInk:"#8a4a17", loaded:"rgba(18,128,74,.10)", follow:"rgba(250,178,25,.16)", thead:"#1d2538", glow:false };
  const DARK = { bg:"#0b0807", ink:"#f5f0eb", muted:"#b4aba2", faint:"#7c746c", line:"rgba(255,255,255,.12)", soft:"rgba(255,255,255,.06)",
    orange:"#ff9e42", good:"#2fd08a", warn:"#ffb23e", navy:"#2353c4",
    strip:"rgba(255,158,66,.12)", stripInk:"#ffc08a", loaded:"rgba(47,208,138,.13)", follow:"rgba(255,178,62,.14)", thead:"rgba(255,255,255,.10)", glow:true };
  let C = LIGHT;

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
  /* A name that must show in full (the customer's): one line at `px`, else
     the words over two lines at a smaller size (down to 2/3), only then cut.
     Draws from baseline y; returns how far below y the last line is. */
  function name(ctx, s, x, y, px, maxW){
    s = String(s == null || s === "" ? "—" : s);
    const f = p => "800 " + p + "px " + DISPLAY;
    ctx.font = f(px);
    if (ctx.measureText(s).width <= maxW) { txt(ctx, s, x, y, f(px), C.ink); return 0; }
    const words = s.split(/\s+/);
    for (let p = Math.round(px * 0.86); p >= Math.round(px * 0.66); p -= 2) {
      ctx.font = f(p);
      // the split whose longer line is shortest
      let best = null;
      for (let k = 1; k < words.length; k++) {
        const a = words.slice(0, k).join(" "), b = words.slice(k).join(" ");
        const w = Math.max(ctx.measureText(a).width, ctx.measureText(b).width);
        if (!best || w < best.w) best = { a: a, b: b, w: w };
      }
      if (best && best.w <= maxW) {
        txt(ctx, best.a, x, y, f(p), C.ink); txt(ctx, best.b, x, y + p * 1.15, f(p), C.ink);
        return p * 1.15;
      }
    }
    txt(ctx, s, x, y, f(px), C.ink, "left", maxW); return 0;
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
  /* The app's tanker (index.html tankerSVG), drawn on the canvas: the same
     320-unit side view, chambers as wide as their share of the capacity and
     numbered, each sight glass filled to `fill` (0..1), the livery naming
     the tanker's rated size (`kl`). Wide `w`, from (x, y). */
  function tanker(ctx, caps, fill, kl, x, y, w){
    const s = w / 320, TX = 52, TY = 10, TW = 262, TH = 54, GT = 19, GB = 50.5, OT = TY + 43, BOT = TY + TH;
    const capT = caps.reduce((a, c) => a + (+c || 0), 0) || 1;
    ctx.save(); ctx.translate(x, y + 8 * s); ctx.scale(s, s);
    const box = (bx, by, bw, bh, r, color) => { rr(ctx, bx, by, bw, bh, r); ctx.fillStyle = color; ctx.fill(); };
    let cx = TX; const bx = caps.map(c => { const cw = TW * ((+c || 0) / capT), o = { x: cx, w: cw }; cx += cw; return o; });
    box(44, BOT, TX + TW - 44, 5, 0.01, "#86c5de");                       // chassis
    box(TX + 8, BOT + 3, 56, 8, 2, "#a8b0b8"); ctx.lineWidth = 0.8; ctx.strokeStyle = "#6d757d"; ctx.stroke();
    box(8, 28, 40, 42, 6, "#1e3a8a"); ctx.fillStyle = "#f4f4f2"; ctx.fillRect(8, 52, 40, 13);   // cab
    box(11, 31.5, 34, 2.6, 1, "#f36a21");
    ctx.globalAlpha = 0.9; box(11, 36.5, 34, 12, 3, "#9fb3c8"); ctx.globalAlpha = 1;
    box(5, 64, 46, 6, 2, "#86c5de");
    bx.forEach(b => box(b.x + b.w / 2 - 6, TY - 3.5, 12, 4.5, 1.6, "#59616a"));   // fillers
    box(TX, TY, TW, TH, 10, "#f4f4f2");                                   // body and its bands
    ctx.save(); rr(ctx, TX, TY, TW, TH, 10); ctx.clip();
    ctx.fillStyle = "#1e3a8a"; ctx.fillRect(TX, TY, TW, 7);
    ctx.fillStyle = "#ef6a28"; ctx.fillRect(TX, OT, TW, BOT - OT);
    ctx.fillStyle = "#f5c02a"; ctx.fillRect(TX, OT - 1, TW, 1.6);
    ctx.strokeStyle = "rgba(0,0,0,.16)"; ctx.lineWidth = 1;
    bx.slice(0, -1).forEach(b => { ctx.beginPath(); ctx.moveTo(b.x + b.w, TY + 7); ctx.lineTo(b.x + b.w, BOT); ctx.stroke(); });
    ctx.restore();
    if ("letterSpacing" in ctx) ctx.letterSpacing = "0.75px";
    txt(ctx, "VRIDDHI FUELS" + (kl ? " · " + kl + " KL" : ""), TX + TW / 2, TY + 5.1, "700 4.8px " + DISPLAY, "#fff", "center");
    if ("letterSpacing" in ctx) ctx.letterSpacing = "0px";
    const liq = ctx.createLinearGradient(0, GT, 0, GB); liq.addColorStop(0, "#5fd69a"); liq.addColorStop(1, "#1f9d55");
    bx.forEach((b, i) => {                                                // sight glasses, filled
      const gw = Math.max(b.w - 8, 6), gx = b.x + b.w / 2 - gw / 2, f = Math.max(0, Math.min(1, +(fill && fill[i]) || 0));
      box(gx, GT, gw, GB - GT, 4, "#20262c");
      if (f > 0) { ctx.save(); rr(ctx, gx, GT, gw, GB - GT, 4); ctx.clip(); ctx.fillStyle = liq; ctx.fillRect(gx, GB - (GB - GT) * f, gw, (GB - GT) * f); ctx.restore(); }
      rr(ctx, gx, GT, gw, GB - GT, 4); ctx.lineWidth = 1; ctx.strokeStyle = "#8d969e"; ctx.stroke();
    });
    rr(ctx, TX, TY, TW, TH, 10); ctx.lineWidth = 1.2; ctx.strokeStyle = "rgba(0,0,0,.18)"; ctx.stroke();
    bx.forEach((b, i) => txt(ctx, "C" + (i + 1), b.x + b.w / 2, OT + 8.2, "800 7.4px " + DISPLAY, "#fff", "center"));   // "C1"
    [30, 214, 250, 286].forEach(wx => {                                   // wheels
      ctx.beginPath(); ctx.arc(wx, 79, 10, 0, Math.PI * 2); ctx.fillStyle = "#1b1b1b"; ctx.fill();
      if (C.glow) { ctx.lineWidth = 1.2; ctx.strokeStyle = "rgba(255,255,255,.28)"; ctx.stroke(); }   // dark page: a rim, or the tyre vanishes
      ctx.beginPath(); ctx.arc(wx, 79, 4.2, 0, Math.PI * 2); ctx.fillStyle = "#b9bfc6"; ctx.fill();
    });
    ctx.restore();
    return 98 * s;                                                        // the height drawn
  }
  /* The letterhead: the orange band with the logo, the name and the
     dealership, the document's title (and number) on the right; under it a
     strip with the address, phone numbers and GSTIN. Returns its height. */
  function header(ctx, W, title, im, ref){
    const H = 230, g = ctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, "#E5420E"); g.addColorStop(0.5, "#F7651C"); g.addColorStop(1, "#FF9A3C");
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    rr(ctx, 64, 55, 120, 120, 28); ctx.fillStyle = "#fff"; ctx.fill();
    if (im) { const s = 100 / Math.max(im.width, im.height); ctx.drawImage(im, 124 - im.width * s / 2, 115 - im.height * s / 2, im.width * s, im.height * s); }
    txt(ctx, BIZ.name, 214, 118, "800 56px " + DISPLAY, "#fff", "left", W - 214 - 340);
    txt(ctx, BIZ.dealer, 214, 162, "600 25px " + SANS, "rgba(255,255,255,.92)", "left", W - 214 - 340);
    txt(ctx, title.toUpperCase(), W - 64, 108, "800 30px " + DISPLAY, "#fff", "right");
    if (ref) txt(ctx, ref, W - 64, 150, "600 24px " + MONO, "rgba(255,255,255,.92)", "right");
    ctx.fillStyle = C.strip; ctx.fillRect(0, H, W, 64);
    txt(ctx, BIZ.address + "  ·  ☎ " + BIZ.phone + "  ·  GSTIN " + BIZ.gstin, W / 2, H + 41, "600 21px " + SANS, C.stripInk, "center", W - 96);
    return H + 64;
  }
  function footer(ctx, W, H, im, right){
    ctx.fillStyle = C.line; ctx.fillRect(64, H - 120, W - 128, 2);
    if (im) { const s = 56 / Math.max(im.width, im.height); ctx.drawImage(im, 64, H - 92, im.width * s, im.height * s); }
    txt(ctx, "Thank you for your business — " + BIZ.name, 136, H - 64, "700 24px " + DISPLAY, C.ink, "left", W - 136 - 260);
    txt(ctx, "Generated " + dateShort(Date.now()) + ", " + time(Date.now()), 136, H - 32, "500 21px " + SANS, C.faint);
    if (right) txt(ctx, right, W - 64, H - 64, "500 22px " + SANS, C.faint, "right");
  }
  // a page in the palette's background; dark: with the ledger's glows
  function canvas(W, H){
    const c = document.createElement("canvas"); c.width = W; c.height = H;
    const x = c.getContext("2d"); x.fillStyle = C.bg; x.fillRect(0, 0, W, H);
    if (C.glow) [[0.85, 0, 0.65, "244,81,30", 0.30], [0, 0.06, 0.55, "255,158,66", 0.13], [0.5, 1.04, 0.6, "120,40,180", 0.16]].forEach(g => {
      const r = g[2] * Math.max(W, H), gr = x.createRadialGradient(g[0] * W, g[1] * H, 0, g[0] * W, g[1] * H, r);
      gr.addColorStop(0, "rgba(" + g[3] + "," + g[4] + ")"); gr.addColorStop(1, "rgba(" + g[3] + ",0)");
      x.fillStyle = gr; x.fillRect(0, 0, W, H);
    });
    return c;
  }

  /* One sale. d = { customer, plate, ts, ref (the slip's number), density
     (at 15 °C), obs + temp (the hydrometer reading and its temperature),
     seal, po (as typed; in the details card only when given), caps,
     fill (0..1 a chamber), kl, chambers:[{ rated (L), loaded }] | null,
     invoices:[{no, date (YYYY-MM-DD) | null, qty | null}], qty }
     chambers: a card per chamber under the drawing, its rated capacity and
     whether it went out loaded. qty: the invoiced litres (the bills', or
     typed with the invoice no.) — shown when known; with no invoice,
     "Invoice to follow" and no litres. Drawn on a tall see-through canvas,
     then put on a page cut to what was drawn. */
  function trip(d){
    return ready().then(im => {
      C = d.dark ? DARK : LIGHT;
      const W = 1080, inv = d.invoices || [], hasQ = d.qty != null && d.qty > 0;
      const art = d.caps && d.caps.length > 0;
      const chs = art && d.chambers && d.chambers.length === d.caps.length ? d.chambers : null;
      const big = document.createElement("canvas"); big.width = W; big.height = 3200;   // see-through: the page's background goes under it at the end
      const ctx = big.getContext("2d");
      let y = header(ctx, W, "Trip slip", im, d.ref) + 80;
      txt(ctx, "DELIVER TO", 64, y, "700 24px " + SANS, C.muted); y += 64;
      y += name(ctx, d.customer, 64, y, 58, W - 128) + 40;
      if (art) { y += 30; y += tanker(ctx, d.caps, d.fill, d.kl, 64, y, W - 128) + 10; }
      if (chs) {                                                          // C1 · 4,000 L rated · Loaded
        y += 10;
        const gap = 16, cw = (W - 128 - gap * (chs.length - 1)) / chs.length;
        chs.forEach((ch, i) => {
          const x = 64 + i * (cw + gap);
          rr(ctx, x, y, cw, 140, 22); ctx.fillStyle = ch.loaded ? C.loaded : C.soft; ctx.fill();
          txt(ctx, "C" + (i + 1), x + 26, y + 50, "800 34px " + DISPLAY, C.ink);
          txt(ctx, ch.loaded ? "✓ Loaded" : "Empty", x + cw - 24, y + 48, "700 24px " + SANS, ch.loaded ? C.good : C.faint, "right", cw - 110);
          txt(ctx, nf(ch.rated) + " L", x + 26, y + 98, "700 30px " + DISPLAY, C.ink, "left", cw - 52);
          txt(ctx, "rated capacity", x + 26, y + 126, "500 20px " + SANS, C.muted, "left", cw - 52);
        });
        y += 140 + 10;
      }

      // tanker, when, product, size (and density, seal no. when typed)
      const den = String(d.density || "").trim(), seal = String(d.seal || "").trim();
      const obs = String(d.obs || "").trim(), temp = String(d.temp || "").trim(), po = String(d.po || "").trim();
      // the typed details, two to a row: density (with its reading), PO no., seal no.
      const unit = v => v + (/[a-z]/i.test(v) ? "" : " kg/m³");
      const reading = obs ? "(" + obs + (temp ? " @ " + temp + "°C" : "") + ")" : "";
      const cells = [];
      if (den || obs) cells.push({ lab: den ? "DENSITY @ 15°C" : "DENSITY", val: den ? unit(den) : unit(obs) + (temp ? " @ " + temp + "°C" : ""), sub: den ? reading : "" });
      if (po) cells.push({ lab: "PO NO.", val: po });
      if (seal) cells.push({ lab: "SEAL NO.", val: seal });
      const rows = Math.ceil(cells.length / 2);
      const cardH = 330 + rows * 150;
      y += 20; rr(ctx, 64, y, W - 128, cardH, 28); ctx.fillStyle = C.soft; ctx.fill();
      txt(ctx, "TANKER", 104, y + 56, "700 22px " + SANS, C.muted);
      plate(ctx, d.plate || "—", 104, y + 78, 74);
      txt(ctx, "SENT", W - 104, y + 56, "700 22px " + SANS, C.muted, "right");
      txt(ctx, dateLong(d.ts), W - 104, y + 108, "700 34px " + DISPLAY, C.ink, "right");
      txt(ctx, time(d.ts), W - 104, y + 150, "600 30px " + SANS, C.muted, "right");
      ctx.fillStyle = C.line; ctx.fillRect(104, y + 182, W - 208, 2);
      txt(ctx, "PRODUCT", 104, y + 230, "700 22px " + SANS, C.muted);
      txt(ctx, PRODUCT, 104, y + 280, "700 34px " + DISPLAY, C.ink, "left", 520);
      txt(ctx, "TANKER SIZE", W - 104, y + 230, "700 22px " + SANS, C.muted, "right");
      txt(ctx, (d.kl ? d.kl + " KL" : "—") + (d.caps && d.caps.length ? " · " + d.caps.length + " chamber" + (d.caps.length === 1 ? "" : "s") : ""), W - 104, y + 280, "700 34px " + DISPLAY, C.ink, "right", 300);
      for (let rI = 0; rI < rows; rI++) {
        const ly = y + 332 + rI * 150;                                   // the divider above the row
        ctx.fillStyle = C.line; ctx.fillRect(104, ly, W - 208, 2);
        const pair = cells.slice(rI * 2, rI * 2 + 2);
        pair.forEach((cl, k) => {
          const right = k === 1, x = right ? W - 104 : 104, al = right ? "right" : "left";
          const maxW = pair.length > 1 ? (right ? 330 : 520) : W - 208;
          txt(ctx, cl.lab, x, ly + 48, "700 22px " + SANS, C.muted, al);
          if (cl.sub && right) {                                          // right column: the bracket ends at the edge
            const sw = txt(ctx, cl.sub, x, ly + 98, "600 24px " + SANS, C.muted, "right", 200);
            txt(ctx, cl.val, x - sw - 12, ly + 98, "700 34px " + DISPLAY, C.ink, "right", maxW - sw - 12);
          } else {
            const w = txt(ctx, cl.val, x, ly + 98, "700 34px " + DISPLAY, C.ink, al, maxW);
            if (cl.sub) txt(ctx, cl.sub, x + w + 12, ly + 98, "600 24px " + SANS, C.muted, "left", Math.max(60, maxW - w - 12));
          }
        });
      }
      y += cardH + 80;

      // the quantity invoiced
      if (hasQ) {
        txt(ctx, "QUANTITY INVOICED", 64, y, "700 24px " + SANS, C.muted); y += 112;
        const w = txt(ctx, nf(d.qty), 64, y, "800 120px " + DISPLAY, C.ink);
        txt(ctx, "litres", 64 + w + 20, y, "700 40px " + DISPLAY, C.orange); y += 70;
      }

      // the invoices
      if (inv.length) {
        y += 10;
        inv.forEach(b => {
          ctx.fillStyle = C.line; ctx.fillRect(64, y, W - 128, 2); y += 56;
          txt(ctx, "Invoice #" + b.no, 64, y, "700 32px " + DISPLAY, C.ink, "left", 520);
          txt(ctx, isNaN(keyDate(b.date)) ? "" : dateShort(keyDate(b.date)), 620, y, "500 28px " + SANS, C.muted);
          if (b.qty != null) txt(ctx, nf(b.qty) + " L", W - 64, y, "700 32px " + DISPLAY, C.ink, "right");
          y += 20;
        });
      } else {
        y -= 30;
        rr(ctx, 64, y, W - 128, 80, 20); ctx.fillStyle = C.follow; ctx.fill();
        txt(ctx, "Invoice to follow.", 96, y + 52, "600 28px " + SANS, C.warn);
        y += 80;
      }
      const H = y + 200;
      footer(ctx, W, H, im);
      const c = canvas(W, H); c.getContext("2d").drawImage(big, 0, 0);
      return [c];
    });
  }

  /* A customer's trips over a period, on A4 pages. d = { customer, period,
     rows:[{ ts, plate, bills:"#4781, #4782", qty, pending }] }: qty is the
     invoiced litres; a trip still waiting for its invoice (pending) shows
     "to follow" and no litres. */
  function statement(d){
    return ready().then(im => {
      C = d.dark ? DARK : LIGHT;
      const W = 1240, H = 1754, rows = d.rows || [], ROW = 70, X = 64;
      const cols = { date: X + 20, time: X + 250, plate: X + 420, bills: X + 640, qty: W - X - 20 };
      const firstTop = 800, top = 400, bottom = H - 170;
      // (room on page 1 for the customer's name on two lines)
      const per1 = Math.floor((bottom - firstTop - 70 - 90) / ROW), per = Math.floor((bottom - top - 90) / ROW);
      const pages = [];
      let i = 0;
      do { const n = pages.length ? per : per1; pages.push(rows.slice(i, i + n)); i += n; } while (i < rows.length);
      const invoiced = rows.filter(r => !r.pending).reduce((s, r) => s + (+r.qty || 0), 0);
      const pend = rows.filter(r => r.pending);
      return pages.map((list, p) => {
        const c = canvas(W, H), ctx = c.getContext("2d");
        let y = header(ctx, W, "Trip statement", im, d.period) + 80;
        if (p === 0) {
          txt(ctx, "TO", X, y, "700 24px " + SANS, C.muted); y += 64;
          y += name(ctx, d.customer, X, y, 56, W - 2 * X) + 56;
          txt(ctx, d.period || "", X, y, "600 30px " + SANS, C.muted); y += 44;
          txt(ctx, "Product: " + PRODUCT, X, y, "600 26px " + SANS, C.muted); y += 46;
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
          y = Math.max(firstTop, y + 150 + 50);
        } else {
          txt(ctx, (d.customer || "") + " · " + (d.period || ""), X, y, "700 30px " + SANS, C.muted, "left", W - 2 * X);
          y = top;
        }
        // the table
        rr(ctx, X, y, W - 2 * X, 64, 16); ctx.fillStyle = C.thead; ctx.fill();
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
          txt(ctx, r.pending ? "—" : nf(r.qty), cols.qty, by, "700 28px " + DISPLAY, r.pending ? C.faint : C.ink, "right");
          y += ROW;
        });
        if (p === pages.length - 1) {
          ctx.fillStyle = C.ink; ctx.fillRect(X, y, W - 2 * X, 3); y += 58;
          txt(ctx, "Total invoiced", cols.date, y, "800 30px " + DISPLAY, C.ink);
          txt(ctx, nf(invoiced) + " L", cols.qty, y, "800 32px " + DISPLAY, C.ink, "right");
          if (!rows.length) { y += 50; txt(ctx, "No trips in this period.", cols.date, y, "500 26px " + SANS, C.muted); }
        }
        footer(ctx, W, H, im, pages.length > 1 ? "Page " + (p + 1) + " of " + pages.length : "");
        return c;
      });
    });
  }

  /* Density at 15 °C from a hydrometer reading (kg/m³) taken at t °C — the
     density chart's sum: ASTM D1250 / API MPMS 11.1 Table 53B (generalized
     refined products), with the glass hydrometer's own expansion taken out
     of the reading first, as the printed tables do. Solved by iteration
     (the expansion depends on the answer). null outside the tables' range. */
  function density15(obs, t){
    obs = +obs; t = +t;
    if (!(obs >= 610 && obs <= 1100) || !(t >= -20 && t <= 100)) return null;
    const dt = t - 15;
    const rt = obs * (1 - 0.000023 * dt - 0.00000002 * dt * dt);   // the glass hydrometer's expansion
    const alpha = r => r < 770.3520 ? 346.4228 / (r * r) + 0.4388 / r          // gasolines
      : r < 787.5195 ? -0.00336312 + 2680.3206 / (r * r)                      // transition zone
      : r < 838.3127 ? 594.5418 / (r * r)                                     // jet fuels / kerosene
      : 186.9696 / (r * r) + 0.4862 / r;                                      // fuel oils, diesel
    let r = rt;
    for (let i = 0; i < 60; i++) {
      const a = alpha(r), vcf = Math.exp(-a * dt * (1 + 0.8 * a * dt)), n = rt / vcf;
      if (Math.abs(n - r) < 1e-7) { r = n; break; }
      r = n;
    }
    return Math.round(r * 10) / 10;
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

  window.Slip = { trip: trip, statement: statement, png: png, pdf: pdf, share: share, density15: density15 };
})();
