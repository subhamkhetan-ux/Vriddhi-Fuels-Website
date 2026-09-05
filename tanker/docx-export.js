/* Dependency-free .docx generator for the tanker bill.
 * Builds a real Office Open XML (.docx) file — a ZIP of XML parts — in the
 * browser, with no external library or CDN. Exposes window.TankerDocx.build(model)
 * which returns a Uint8Array. The same code runs under Node for testing.
 *
 * model = {
 *   date, product, name, address:[l1,l2,l3], poLabel, poVal,
 *   density, seal, payment:[p1..p5],
 *   row:{date,bill,vehicle,qty,price,amount},   // strings, pre-formatted
 *   images:{ letterhead:Uint8Array, stamp:Uint8Array }
 * }
 */
(function (global) {
  "use strict";

  // ---- bytes helpers ----
  var enc = new TextEncoder();
  function str(s) { return enc.encode(s); }
  function concat(chunks) {
    var n = 0, i;
    for (i = 0; i < chunks.length; i++) n += chunks[i].length;
    var out = new Uint8Array(n), o = 0;
    for (i = 0; i < chunks.length; i++) { out.set(chunks[i], o); o += chunks[i].length; }
    return out;
  }
  function u16(n) { return new Uint8Array([n & 255, (n >> 8) & 255]); }
  function u32(n) { return new Uint8Array([n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]); }

  // ---- CRC32 ----
  var CRC = (function () {
    var t = new Uint32Array(256), c, n, k;
    for (n = 0; n < 256; n++) {
      c = n;
      for (k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(u8) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 255] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  // ---- ZIP (stored, no compression) ----
  function zip(files) { // files: [{name, data:Uint8Array}]
    var local = [], central = [], offset = 0, i;
    for (i = 0; i < files.length; i++) {
      var name = str(files[i].name), data = files[i].data, crc = crc32(data);
      var lh = concat([
        u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0),
        u32(crc), u32(data.length), u32(data.length),
        u16(name.length), u16(0), name
      ]);
      local.push(lh, data);
      central.push(concat([
        u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0),
        u32(crc), u32(data.length), u32(data.length),
        u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), name
      ]));
      offset += lh.length + data.length;
    }
    var cd = concat(central), cdOffset = offset;
    var end = concat([
      u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length),
      u32(cd.length), u32(cdOffset), u16(0)
    ]);
    return concat(local.concat([cd, end]));
  }

  // ---- XML helpers ----
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
  var FONT = '<w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:cs="Times New Roman"/>';
  function run(text, o) {
    o = o || {};
    var sz = o.size || 24;
    var rpr = "<w:rPr>" + FONT +
      (o.bold ? "<w:b/>" : "") + (o.italic ? "<w:i/>" : "") +
      (o.color ? '<w:color w:val="' + o.color + '"/>' : "") +
      '<w:sz w:val="' + sz + '"/><w:szCs w:val="' + sz + '"/></w:rPr>';
    return "<w:r>" + rpr + '<w:t xml:space="preserve">' + esc(text) + "</w:t></w:r>";
  }
  function para(runs, o) {
    o = o || {};
    var ppr = "<w:pPr>" +
      (o.align ? '<w:jc w:val="' + o.align + '"/>' : "") +
      '<w:spacing w:after="' + (o.after == null ? 0 : o.after) + '" w:line="240" w:lineRule="auto"/>' +
      "</w:pPr>";
    return "<w:p>" + ppr + (runs || "") + "</w:p>";
  }

  var _id = 1;
  function image(relId, cx, cy, name, align) {
    var id = _id++;
    return "<w:p>" + (align ? '<w:pPr><w:jc w:val="' + align + '"/></w:pPr>' : "") +
      "<w:r><w:drawing><wp:inline distT=\"0\" distB=\"0\" distL=\"0\" distR=\"0\">" +
      '<wp:extent cx="' + cx + '" cy="' + cy + '"/>' +
      '<wp:docPr id="' + id + '" name="' + name + '"/>' +
      "<a:graphic><a:graphicData uri=\"http://schemas.openxmlformats.org/drawingml/2006/picture\">" +
      "<pic:pic><pic:nvPicPr><pic:cNvPr id=\"" + id + "\" name=\"" + name + "\"/><pic:cNvPicPr/></pic:nvPicPr>" +
      '<pic:blipFill><a:blip r:embed="' + relId + '"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>' +
      "<pic:spPr><a:xfrm><a:off x=\"0\" y=\"0\"/><a:ext cx=\"" + cx + "\" cy=\"" + cy + "\"/></a:xfrm>" +
      "<a:prstGeom prst=\"rect\"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>" +
      "</a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>";
  }

  function tcBordersNil() {
    return "<w:tcBorders><w:top w:val=\"nil\"/><w:left w:val=\"nil\"/><w:bottom w:val=\"nil\"/><w:right w:val=\"nil\"/></w:tcBorders>";
  }
  function cell(content, w, o) {
    o = o || {};
    return "<w:tc><w:tcPr><w:tcW w:w=\"" + w + "\" w:type=\"dxa\"/>" +
      (o.nb ? tcBordersNil() : "") +
      (o.valign ? '<w:vAlign w:val="' + o.valign + '"/>' : "") +
      "</w:tcPr>" + (content || para("")) + "</w:tc>";
  }
  function tblBorders(nil) {
    var e = nil ? "nil" : "single";
    function b(t) { return "<w:" + t + " w:val=\"" + e + "\" w:sz=\"6\" w:space=\"0\" w:color=\"000000\"/>"; }
    return "<w:tblBorders>" + b("top") + b("left") + b("bottom") + b("right") + b("insideH") + b("insideV") + "</w:tblBorders>";
  }
  function table(rows, grid, o) {
    o = o || {};
    var total = grid.reduce(function (a, b) { return a + b; }, 0);
    return "<w:tbl><w:tblPr><w:tblW w:w=\"" + total + "\" w:type=\"dxa\"/>" +
      tblBorders(!!o.nb) + "<w:tblLayout w:type=\"fixed\"/><w:tblLook w:val=\"0000\"/></w:tblPr>" +
      "<w:tblGrid>" + grid.map(function (w) { return '<w:gridCol w:w="' + w + '"/>'; }).join("") + "</w:tblGrid>" +
      rows + "</w:tbl>";
  }
  function trow(cells) { return "<w:tr>" + cells + "</w:tr>"; }

  var EMU = 9525; // per pixel at 96dpi
  function px(n) { return Math.round(n * EMU); }

  function build(m) {
    _id = 1;
    var img = m.images || {};
    var body = [];

    // letterhead (full content width)
    var lhW = 740, lhH = Math.round(lhW * 303 / 979);
    body.push(image("rId1", px(lhW), px(lhH), "letterhead", "center"));
    body.push(para("", { after: 120 }));

    // header block: Bill To / Date+Product
    var left =
      para(run("Bill To", { bold: true, color: "E97132" })) +
      para(run(m.name || "", { bold: true })) +
      para(run(m.address[0] || "")) +
      para(run(m.address[1] || "")) +
      para(run(m.address[2] || "", { italic: true }));
    var right =
      para(run("Date: ", { bold: true, color: "E97132" }) + run(m.date || "", { bold: true }), { align: "right" }) +
      para("") + para("") +
      para(run("Product: ", { bold: true, color: "E97132" }) + run(m.product || "", { bold: true }), { align: "right" });
    body.push(table(trow(cell(left, 6800, { nb: true, valign: "top" }) + cell(right, 4302, { nb: true, valign: "top" })), [6800, 4302], { nb: true }));

    body.push(para("", { after: 120 }));
    body.push(para(run("Invoice Details:", { bold: true, size: 22 })));

    // invoice table
    var grid = [1763, 1540, 2508, 1589, 1614, 2088];
    function hc(t, w) { return cell(para(run(t, { bold: true, size: 22 }), { align: "center" }), w, { valign: "center" }); }
    function dc(t, w, o) { o = o || {}; return cell(para(run(t, { bold: !!o.bold, color: o.color, size: 22 }), { align: "center" }), w, { valign: "center" }); }
    var header = trow(hc("Date", grid[0]) + hc("Bill No", grid[1]) + hc("Vehicle", grid[2]) + hc("Quantity", grid[3]) + hc("Price/Ltr", grid[4]) + hc("Amount", grid[5]));
    var r = m.row || {};
    var data = trow(
      dc(r.date, grid[0]) + dc(r.bill, grid[1]) + dc(r.vehicle, grid[2]) +
      dc(r.qty, grid[3]) + dc(r.price, grid[4]) + dc(r.amount, grid[5], { bold: true, color: "FF0000" })
    );
    body.push(table(header + data, grid));

    // PO
    body.push(para("", { after: 120 }));
    if (m.poLabel) body.push(para(run(m.poLabel + "  ", { bold: true }) + run(m.poVal || "", { bold: true })));

    // density / seal
    if (m.density) { body.push(para("")); body.push(para(run("Density-", { italic: true }))); }
    if (m.seal) { body.push(para("")); body.push(para(run("Seal No-", { italic: true }))); }

    // payment
    body.push(para("", { after: 120 })); body.push(para(""));
    if (m.payment && m.payment.length) {
      body.push(para(run(m.payment[0] || "", { bold: true })));
      for (var i = 1; i < m.payment.length; i++) if (m.payment[i]) body.push(para(run(m.payment[i])));
    }

    // footer: stamp + for VRIDDHI FUELS | Signature of Customer
    body.push(para("")); body.push(para("")); body.push(para(""));
    var stW = 150, stH = Math.round(stW * 171 / 431);
    var fLeft = image("rId2", px(stW), px(stH), "stamp", "left") + para(run("for VRIDDHI FUELS"));
    var fRight = para("") + para("") + para(run("Signature of Customer", { italic: true }), { align: "right" });
    body.push(table(trow(cell(fLeft, 6800, { nb: true, valign: "bottom" }) + cell(fRight, 4302, { nb: true, valign: "bottom" })), [6800, 4302], { nb: true }));

    var doc =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
      'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
      'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
      'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
      "<w:body>" + body.join("") +
      "<w:sectPr><w:pgSz w:w=\"11906\" w:h=\"16838\"/>" +
      "<w:pgMar w:top=\"403\" w:right=\"403\" w:bottom=\"403\" w:left=\"403\" w:header=\"0\" w:footer=\"0\" w:gutter=\"0\"/></w:sectPr>" +
      "</w:body></w:document>";

    var ns = "http://schemas.openxmlformats.org/";
    var contentTypes =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="' + ns + 'package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Default Extension="png" ContentType="image/png"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      "</Types>";
    var rels =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="' + ns + 'package/2006/relationships">' +
      '<Relationship Id="rId1" Type="' + ns + 'officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      "</Relationships>";
    var docRels =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="' + ns + 'package/2006/relationships">' +
      '<Relationship Id="rId1" Type="' + ns + 'officeDocument/2006/relationships/image" Target="media/image1.png"/>' +
      '<Relationship Id="rId2" Type="' + ns + 'officeDocument/2006/relationships/image" Target="media/image2.png"/>' +
      "</Relationships>";

    var files = [
      { name: "[Content_Types].xml", data: str(contentTypes) },
      { name: "_rels/.rels", data: str(rels) },
      { name: "word/document.xml", data: str(doc) },
      { name: "word/_rels/document.xml.rels", data: str(docRels) },
      { name: "word/media/image1.png", data: img.letterhead || new Uint8Array(0) },
      { name: "word/media/image2.png", data: img.stamp || new Uint8Array(0) }
    ];
    return zip(files);
  }

  global.TankerDocx = { build: build, zip: zip, crc32: crc32 };
})(typeof window !== "undefined" ? window : globalThis);
