/* =====================================================================
 * Vriddhi Fuels — Fuel slips for the Tally Voucher app.
 * ---------------------------------------------------------------------
 * The Ledger app's "Print Bills" (the Master Ledger's Module7
 * ExportBillsPerCustomer): every voucher as the HSD Bill sheet's A5
 * credit memo, one PDF per customer named "<Customer> Slips <date>",
 * zipped in a "Fuel Bills <from> to <to>" folder.
 *
 * slipSvg() and slipBundles() are the Ledger app's own drawing and
 * grouping (ledger/js/render.js, ledger/js/bills.js), ported to a plain
 * script because the Pages site serves only /tanker/ and /tally/.
 * tests/ledger_web/tally_slips.test.mjs checks that both give exactly the
 * same output, so a change to one without the other fails the tests.
 *
 * The drawing and grouping are pure (also run under Node); the PDF / zip /
 * print helpers need a browser. Exposed as window.VFSlips.
 * ===================================================================== */
(function (global) {
"use strict";

var A5 = { width: 420, height: 595 };
var A4 = { width: 595.28, height: 841.89 };

var PRODUCT_NAME = { HSD: "High Speed Diesel", MS: "Motor Spirit", XG: "XtraGreen Diesel" };

var ARIAL = "Arial,&quot;Arial Unicode MS&quot;,Arimo,&quot;Liberation Sans&quot;,Helvetica,sans-serif";
var TIMES = "&quot;Times New Roman&quot;,Times,&quot;Liberation Serif&quot;,serif";

var ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
function esc(v){ return String(v == null ? "" : v).replace(/[&<>"']/g, function(c){ return ESC[c]; }); }

// 2026-09-05 -> 05-09-2026 (file and folder names)
function dmy(iso){
  if (!iso) return "";
  return iso.slice(8, 10) + "-" + iso.slice(5, 7) + "-" + iso.slice(0, 4);
}

// 2026-09-05 -> 5-9-2026 (the Date on the slip)
function dmyShort(iso){
  return iso ? Number(iso.slice(8, 10)) + "-" + Number(iso.slice(5, 7)) + "-" + iso.slice(0, 4) : "";
}

// 1791000 -> 17,91,000.00 (Excel's "#,##0.00" on an Indian-locale Mac)
function inr2(n){
  var v = Number(n) || 0;
  var parts = Math.abs(v).toFixed(2).split(".");
  var whole = parts[0];
  var grouped = whole.length <= 3 ? whole
    : whole.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",") + "," + whole.slice(-3);
  return (v < 0 ? "-" : "") + grouped + "." + parts[1];
}

/* ---------------- the slip (A5 credit memo) ----------------
   Positions, sizes and lines are measured from a real Excel export of
   Print Bills.
   bill: {bill_no, sale_date, customer, vehicle, product, qty, rate, amount}
   header: {title, mobile, lines[]} (HSD Bill sheet A1, D1, A2:A8)
   stamp: signature / stamp image URL, or "" for none */
function slipSvg(bill, header, stamp){
  header = header || {};
  stamp = stamp || "";
  var W = A5.width, H = A5.height;
  var out = [];
  // text placed by its PDF box top (y0) -> SVG baseline (Arial ascent .905, Times .891)
  function t(x, y0, size, text, o){
    o = o || {};
    var font = o.font || ARIAL, fill = o.fill || "#000", anchor = o.anchor || "start";
    var base = y0 + size * (font === TIMES ? 0.891 : 0.905);
    out.push('<text x="' + x + '" y="' + base.toFixed(2) + '" font-size="' + size + '" font-family="' + font + '"'
      + (o.bold ? ' font-weight="bold"' : "")
      + (anchor !== "start" ? ' text-anchor="' + anchor + '"' : "")
      + (fill !== "#000" ? ' fill="' + fill + '"' : "")
      + (o.clip ? ' clip-path="url(#' + o.clip + ')"' : "")
      + ">" + esc(text) + "</text>");
  }
  function rect(x0, y0, x1, y1){
    out.push('<rect x="' + x0 + '" y="' + y0 + '" width="' + (x1 - x0).toFixed(2) + '" height="' + (y1 - y0).toFixed(2) + '" fill="#000"/>');
  }

  rect(18.62, 17.64, 128.38, 35.28);
  t(21.6, 18.9, 13.7, header.title || "CREDIT MEMO", { bold: true, fill: "#fff" });
  if (header.mobile) t(396.9, 19.1, 13.7, header.mobile, { bold: true, anchor: "end", font: TIMES });
  var tops = [40.9, 59.0, 74.7, 90.4, 106.1, 121.8, 138.4];
  (header.lines || []).slice(0, 7).forEach(function(line, i){
    if (i === 0) t(210, tops[0], 15.7, line, { bold: true, anchor: "middle", font: TIMES });
    else t(210, tops[i], 12.7, line, { anchor: "middle" });
  });

  t(21.6, 162.0, 13.7, "No. :");
  t(130.3, 162.0, 13.7, bill.bill_no, { bold: true });
  t(264.6, 162.0, 13.7, "Date :");
  t(306.7, 162.0, 13.7, dmyShort(bill.sale_date), { bold: true });
  t(21.6, 187.5, 13.7, "M/s :");
  t(130.3, 188.4, 12.7, bill.customer, { bold: true, clip: "edge" });
  t(21.6, 210.0, 13.7, "Vehicle No. :");
  t(130.3, 210.0, 13.7, bill.vehicle || "", { bold: true, clip: "edge" });

  // table borders: 0.98 pt filled bars, as in the export
  rect(18.62, 239.12, 19.6, 513.52);
  rect(398.86, 240.1, 399.84, 513.52);
  rect(166.6, 240.1, 167.58, 393.96);
  rect(258.72, 240.1, 259.7, 410.62);
  rect(303.8, 240.1, 304.78, 410.62);
  [239.12, 255.78, 392.98, 409.64, 426.3, 512.54].forEach(function(y){ rect(19.6, y, 399.84, y + 0.98); });

  t(21.6, 240.4, 13.7, "Particulars");
  t(213.15, 240.4, 13.7, "Quantity", { anchor: "middle" });
  t(282.1, 240.4, 13.7, "Rate", { anchor: "middle" });
  t(352.25, 240.4, 13.7, "Amount", { anchor: "middle" });
  var qty = Number(bill.qty) || 0;
  t(21.6, 263.9, 13.7, PRODUCT_NAME[bill.product] || PRODUCT_NAME.HSD, { bold: true, clip: "col1" });
  t(213.85, 264.8, 12.7, qty.toFixed(2) + " LTR", { bold: true, anchor: "middle" });
  t(302.1, 264.8, 12.7, (Number(bill.rate) || 0).toFixed(2), { bold: true, anchor: "end" });
  t(397.1, 264.8, 12.7, inr2(bill.amount), { bold: true, anchor: "end" });

  t(139.15, 394.3, 13.7, "Thank You", { bold: true, anchor: "middle" });
  t(301.7, 394.3, 13.7, "Total", { bold: true, anchor: "end" });
  t(397.1, 395.2, 12.7, "₹ " + inr2(bill.amount), { bold: true, anchor: "end" });

  if (stamp) out.push('<image href="' + esc(stamp) + '" x="300.86" y="428.26" width="83.3" height="65.66" preserveAspectRatio="none"/>');
  t(21.6, 497.2, 13.7, "Customer's Sign.", { bold: true });
  t(396.5, 497.2, 13.7, "Sign.of Salesman", { bold: true, anchor: "end" });

  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + " " + H + '" width="' + W + '" height="' + H + '">\n'
    + '<defs><clipPath id="edge"><rect x="0" y="0" width="398.8" height="' + H + '"/></clipPath><clipPath id="col1"><rect x="0" y="0" width="166.6" height="' + H + '"/></clipPath></defs>\n'
    + '<rect x="0" y="0" width="' + W + '" height="' + H + '" fill="#fff"/>\n'
    + out.join("\n") + "\n</svg>";
}

/* ---------------- which slips go into which PDF ---------------- */

function safeName(s){
  var t = String(s == null ? "" : s).replace(/[/\\:*?"<>|\n\r\t]/g, " ").replace(/ {2,}/g, " ").trim();
  if (!t) t = "Customer";
  return t.slice(0, 120);
}

function normKey(s){
  return String(s == null ? "" : s).replace(/[\t\n\v\f\r  ]+/g, " ").trim().toLowerCase();
}

var SLIP_ORDER = ["HSD", "MS", "XG"];

// One PDF per customer (one A5 page per bill): diesel bills first, then
// petrol, then XtraGreen, each in seq order. The filter is an exact name
// (any case); blank = everyone.
// sales: [{product, bill_no, sale_date, customer, vehicle, qty, rate, amount, seq}]
function slipBundles(o){
  var from = o.from, to = o.to;
  var f = String(o.filter || "").trim().toLowerCase();
  var rows = o.sales
    .filter(function(s){
      return SLIP_ORDER.indexOf(s.product) !== -1 && String(s.bill_no == null ? "" : s.bill_no).trim()
        && s.sale_date >= from && s.sale_date <= to;
    })
    .sort(function(a, b){
      return SLIP_ORDER.indexOf(a.product) - SLIP_ORDER.indexOf(b.product)
        || (a.seq == null ? 0 : a.seq) - (b.seq == null ? 0 : b.seq)
        || (a.id == null ? 0 : a.id) - (b.id == null ? 0 : b.id);
    })
    .map(function(s){
      var r = {};
      for (var k in s) r[k] = s[k];
      r.who = String(s.customer == null ? "" : s.customer).trim() || "(No Customer)";
      return r;
    })
    .filter(function(s){ return !f || s.who.toLowerCase() === f; });

  var dateStr = from === to ? dmy(from) : dmy(from) + " to " + dmy(to);
  var groups = [], byKey = {};
  rows.forEach(function(s){
    var k = s.who.toLowerCase();
    if (!byKey[k]){ byKey[k] = { name: s.who, bills: [] }; groups.push(byKey[k]); }
    byKey[k].bills.push(s);
  });
  var used = {};
  var bundles = groups.map(function(g){
    var base = safeName(g.name + " Slips " + dateStr);
    var name = base;
    for (var dup = 2; used[name.toLowerCase()]; dup++) name = base + " (" + dup + ")";
    used[name.toLowerCase()] = 1;
    return { key: normKey(g.name), fileName: name + ".pdf", name: g.name, bills: g.bills };
  });
  return { folder: "Fuel Bills " + dmy(from) + " to " + dmy(to), bundles: bundles, bills: rows.length };
}

/* ---------------- the company name and its financial year ----------------
   The HSD Bill sheet's first heading line — like the Tally company name —
   carries the financial year: "VRIDDHI FUELS (2026-27)". */

// Indian financial year of an ISO date: 2026-04-01 .. 2027-03-31 -> "2026-27"
function fyOf(iso){
  var y = Number(iso.slice(0, 4));
  var m = Number(iso.slice(5, 7));
  var start = m >= 4 ? y : y - 1;
  return start + "-" + String((start + 1) % 100).padStart(2, "0");
}

var FY_END = /\s*\(\s*\d{4}\s*-\s*\d{2,4}\s*\)\s*$/;

// "VRIDDHI FUELS (2026-27)" -> {name: "VRIDDHI FUELS", fy: true}
function splitCompany(line){
  var s = String(line == null ? "" : line).trim();
  return FY_END.test(s) ? { name: s.replace(FY_END, "").trim(), fy: true } : { name: s, fy: false };
}

// The slip heading for one bill: company {name, fy} replaces the first
// line — followed by the bill's own financial year when fy is set. No name:
// the heading as it is.
function slipHeaderFor(header, company, iso){
  var name = String((company && company.name) == null ? "" : company.name).trim();
  if (!name) return header;
  var lines = (header.lines || []).slice();
  lines[0] = company.fy && iso ? name + " (" + fyOf(iso) + ")" : name;
  var out = {};
  for (var k in header) out[k] = header[k];
  out.lines = lines;
  return out;
}

/* ---------------- browser only: PDF, zip, print ---------------- */

var JSPDF = "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js";
var JSZIP = "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js";

function loadScript(src, ready){
  if (ready()) return Promise.resolve(ready());
  return new Promise(function(resolve, reject){
    var s = document.createElement("script");
    s.src = src;
    s.onload = function(){ ready() ? resolve(ready()) : reject(new Error(src + " loaded without its library")); };
    s.onerror = function(){ reject(new Error("Couldn't load " + new URL(src).hostname + ". Check the internet connection.")); };
    document.head.appendChild(s);
  });
}

function svgToJpeg(svg, size, scale){
  var img = new Image();
  img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  return img.decode().then(function(){
    var canvas = document.createElement("canvas");
    canvas.width = Math.round(size.width * scale);
    canvas.height = Math.round(size.height * scale);
    var ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.92);
  });
}

// page SVG strings (images already as data: URLs) -> PDF Blob
function pdfFromSvgs(svgs, size, scale){
  size = size || A5;
  scale = scale || 2;
  return loadScript(JSPDF, function(){ return global.jspdf; }).then(function(lib){
    var pdf = new lib.jsPDF({ unit: "pt", format: [size.width, size.height], orientation: "portrait", compress: true });
    return svgs.reduce(function(prev, svg, i){
      return prev.then(function(){
        return svgToJpeg(svg, size, scale).then(function(jpg){
          if (i) pdf.addPage([size.width, size.height], "portrait");
          pdf.addImage(jpg, "JPEG", 0, 0, size.width, size.height);
        });
      });
    }, Promise.resolve()).then(function(){ return pdf.output("blob"); });
  });
}

// files: [{name, blob}] -> zip Blob, inside `folder` when given
function zipBlob(files, folder){
  return loadScript(JSZIP, function(){ return global.JSZip; }).then(function(JSZip){
    var zip = new JSZip();
    var dir = folder ? zip.folder(folder) : zip;
    files.forEach(function(f){ dir.file(f.name, f.blob); });
    return zip.generateAsync({ type: "blob" });
  });
}

// iPhone / iPad. iPadOS reports itself as a Mac, so touch gives it away.
function isIOS(){
  var n = global.navigator || {};
  return /iPad|iPhone|iPod/.test(n.userAgent || "") || (n.platform === "MacIntel" && n.maxTouchPoints > 1);
}
function shareableFile(blob, name){
  try {
    var file = new File([blob], name, { type: blob.type || "application/octet-stream" });
    return navigator.canShare && navigator.canShare({ files: [file] }) ? file : null;
  } catch (e){ return null; }
}

// On iOS a home-screen web app cannot print (window.print does nothing) and
// a download link has nowhere to save to. The share sheet does both, with
// Print, Save to Files and WhatsApp. It only opens from a tap, though, and
// making a PDF takes longer than a tap stays valid, so the file is made
// first and this sheet asks for the tap that hands it over.
function offerFile(file, print){
  var old = document.getElementById("vf-share");
  if (old) old.remove();
  var d = document.createElement("dialog");
  d.id = "vf-share";
  d.className = "share-sheet";
  d.setAttribute("aria-labelledby", "vf-share-title");
  d.innerHTML = '<h2 id="vf-share-title"></h2><p class="share-name"></p><p class="share-note"></p>'
    + '<button type="button" class="btn primary" data-share></button>'
    + '<button type="button" class="btn ghost" data-close>Close</button>';
  d.querySelector("h2").textContent = print ? "Ready to print" : "PDF ready";
  d.querySelector(".share-name").textContent = file.name;
  d.querySelector(".share-note").textContent = print
    ? "Tap Print in the share sheet, or Save to Files for a PDF."
    : "Save it to Files, or send it on WhatsApp or Mail.";
  d.querySelector("[data-share]").textContent = print ? "🖨 Print / Save PDF" : "Share / Save PDF";
  function close(){ if (d.open) d.close(); d.remove(); }
  d.querySelector("[data-close]").onclick = close;
  d.addEventListener("cancel", function(){ d.remove(); });
  d.querySelector("[data-share]").onclick = function(){
    navigator.share({ files: [file] }).then(close, function(e){
      if (e && e.name === "AbortError") return;      // closed the share sheet: try again or Close
      close();
      saveLink(file, file.name);
    });
  };
  document.body.appendChild(d);
  d.showModal();
}

// A ready PDF to print: on iOS through the share sheet's Print; elsewhere
// it opens in the browser's PDF viewer, which prints it.
function printFile(blob, name){
  var file = isIOS() && typeof HTMLDialogElement === "function" ? shareableFile(blob, name) : null;
  if (file){ offerFile(file, true); return; }
  var url = URL.createObjectURL(blob);
  if (!global.open(url, "_blank")) saveLink(blob, name);
  setTimeout(function(){ URL.revokeObjectURL(url); }, 60000);
}

// Saves the file. Returns true when it went straight to the downloads, false
// when the iOS share sheet was offered instead.
function download(blob, name){
  var file = isIOS() && typeof HTMLDialogElement === "function" ? shareableFile(blob, name) : null;
  if (file){ offerFile(file, false); return false; }
  saveLink(blob, name);
  return true;
}
function saveLink(blob, name){
  var url = URL.createObjectURL(blob);
  var a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(function(){ URL.revokeObjectURL(url); }, 60000);
}

// Print pages (A5 slips by default). On iOS the pages become a PDF for the
// share sheet's Print; elsewhere everything else on the page is hidden while
// the browser prints (see #print-area in index.html). Returns a promise.
function printPages(svgs, size, name){
  size = size || A5;
  if (isIOS() && typeof HTMLDialogElement === "function"
      && shareableFile(new Blob(["%PDF"], { type: "application/pdf" }), "check.pdf")){
    return pdfFromSvgs(svgs, size, size === A4 ? 2.5 : 2).then(function(blob){
      offerFile(new File([blob], name || "Print.pdf", { type: "application/pdf" }), true);
    });
  }
  printSlips(svgs, size);
  return Promise.resolve();
}
function printSlips(svgs, size){
  var old = document.getElementById("print-area");
  if (old) old.remove();
  old = document.getElementById("print-style");
  if (old) old.remove();
  var area = document.createElement("div");
  area.id = "print-area";
  area.innerHTML = svgs.map(function(svg){ return '<div class="print-page">' + svg + "</div>"; }).join("");
  var style = document.createElement("style");
  style.id = "print-style";
  style.textContent = "@page { size: " + (size === A4 ? "A4" : "A5") + " portrait; margin: 0; }";
  document.head.appendChild(style);
  document.body.appendChild(area);
  document.body.classList.add("printing");
  function done(){
    document.body.classList.remove("printing");
    area.remove();
    style.remove();
    global.removeEventListener("afterprint", done);
  }
  global.addEventListener("afterprint", done);
  setTimeout(function(){ global.print(); }, 50);
}

var api = {
  A5: A5,
  A4: A4,
  PRODUCT_NAME: PRODUCT_NAME,
  dmy: dmy,
  fyOf: fyOf,
  inr2: inr2,
  splitCompany: splitCompany,
  slipHeaderFor: slipHeaderFor,
  safeName: safeName,
  slipSvg: slipSvg,
  slipBundles: slipBundles,
  pdfFromSvgs: pdfFromSvgs,
  zipBlob: zipBlob,
  download: download,
  isIOS: isIOS,
  printPages: printPages,
  printFile: printFile,
  printSlips: printSlips
};

if (typeof module !== "undefined" && module.exports) module.exports = api;
else global.VFSlips = api;

})(typeof window !== "undefined" ? window : this);
