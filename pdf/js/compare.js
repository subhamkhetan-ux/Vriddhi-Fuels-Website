// Compare PDF: word-level text differences and a pixel overlay per page.

import { readBytes, openPdfjs, renderPage, pageLines, escapeHtml } from "./lib.js";
import { h, withBusy, pickFiles, toast, reportError } from "./ui.js";

/** LCS-based diff of two token arrays → [{op: '=', '-', '+', text}] */
function diffTokens(a, b) {
  // trim the common prefix/suffix first; keeps the DP small for similar docs
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let ea = a.length, eb = b.length;
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) { ea--; eb--; }
  const A = a.slice(s, ea), B = b.slice(s, eb);
  const res = [];
  if (s) res.push({ op: "=", t: a.slice(0, s) });
  const n = A.length, m = B.length;
  if (n * m > 8e6) {
    // too large for a full table: report the middle as replaced
    if (n) res.push({ op: "-", t: A });
    if (m) res.push({ op: "+", t: B });
  } else if (n || m) {
    const w = m + 1;
    const dp = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        dp[i * w + j] = A[i] === B[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    let i = 0, j = 0;
    const push = (op, t) => { const l = res.at(-1); if (l && l.op === op) l.t.push(t); else res.push({ op, t: [t] }); };
    while (i < n && j < m) {
      if (A[i] === B[j]) { push("=", A[i]); i++; j++; }
      else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) push("-", A[i++]);
      else push("+", B[j++]);
    }
    while (i < n) push("-", A[i++]);
    while (j < m) push("+", B[j++]);
  }
  if (ea < a.length) res.push({ op: "=", t: a.slice(ea) });
  return res;
}

const tokens = (text) => text.split(/(\s+)/).filter((t) => t.length);

async function docText(pdf) {
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const { lines } = await pageLines(await pdf.getPage(i));
    pages.push(lines.map((l) => l.text).join("\n"));
  }
  return pages;
}

export async function mount(el, { files, restart }) {
  if (files.length < 2) {
    el.append(h("div", { class: "panel" }, h("p", {}, `First file: ${files[0].name}`),
      h("button", { class: "btn", type: "button", onclick: async () => {
        const [f] = await pickFiles({ accept: ".pdf,application/pdf" });
        if (f) { el.innerHTML = ""; mount(el, { files: [files[0], f], restart }).catch(reportError); }
      } }, "Choose the second PDF")));
    return;
  }
  const [fa, fb] = files;
  const { pa, pb, ta, tb } = await withBusy("Comparing…", async (ctx) => {
    ctx.progress(0.1, "Reading " + fa.name);
    const pa = await openPdfjs(await readBytes(fa));
    ctx.progress(0.3, "Reading " + fb.name);
    const pb = await openPdfjs(await readBytes(fb));
    ctx.progress(0.5, "Extracting text");
    return { pa, pb, ta: await docText(pa), tb: await docText(pb) };
  });

  const pages = Math.max(ta.length, tb.length);
  let added = 0, removed = 0, changedPages = 0;
  const diffs = [];
  for (let i = 0; i < pages; i++) {
    const d = diffTokens(tokens(ta[i] || ""), tokens(tb[i] || ""));
    let changed = false;
    for (const part of d) {
      const words = part.t.filter((t) => t.trim()).length;
      if (part.op === "+") { added += words; changed ||= words > 0; }
      if (part.op === "-") { removed += words; changed ||= words > 0; }
    }
    if (changed) changedPages++;
    diffs.push({ d, changed });
  }

  let mode = "text", page = 0;
  const content = h("div", {});
  const pageSel = h("select", {}, [...Array(pages).keys()].map((i) => h("option", { value: i }, `Page ${i + 1}${diffs[i].changed ? " •" : ""}`)));
  pageSel.onchange = () => { page = +pageSel.value; draw(); };
  const modeBtns = h("div", { class: "tabs" }, [["text", "Text changes"], ["visual", "Visual overlay"]].map(([k, l]) =>
    h("button", { type: "button", "aria-pressed": String(k === mode), onclick: (e) => { mode = k; modeBtns.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b === e.currentTarget))); draw(); } }, l)));

  el.append(h("div", { class: "panel" },
    h("div", { class: "cmp-stats" },
      h("span", {}, `${fa.name} (${pa.numPages} p) ⇆ ${fb.name} (${pb.numPages} p)`),
      h("span", { style: "color:#0b5e2a" }, `+${added} words added`),
      h("span", { style: "color:#8a1c14" }, `−${removed} words removed`),
      h("span", {}, `${changedPages} of ${pages} pages changed`)),
    h("div", { class: "toolbar" }, modeBtns, h("span", { class: "sp" }), pageSel,
      h("button", { class: "btn ghost small", type: "button", onclick: () => { pa.destroy(); pb.destroy(); restart(); } }, "Compare others")),
    content));

  async function draw() {
    content.innerHTML = "";
    if (mode === "text") {
      const { d } = diffs[page];
      const left = d.filter((p) => p.op !== "+").map((p) => p.op === "-" ? `<del>${escapeHtml(p.t.join(""))}</del>` : escapeHtml(p.t.join(""))).join("");
      const right = d.filter((p) => p.op !== "-").map((p) => p.op === "+" ? `<ins>${escapeHtml(p.t.join(""))}</ins>` : escapeHtml(p.t.join(""))).join("");
      content.append(h("div", { class: "cmp" },
        h("div", {}, h("p", { class: "help" }, fa.name), h("div", { class: "col", html: left || "<i>(no text on this page)</i>" })),
        h("div", {}, h("p", { class: "help" }, fb.name), h("div", { class: "col", html: right || "<i>(no text on this page)</i>" }))));
    } else {
      content.append(h("p", { class: "help" }, "Unchanged areas are faded; red marks pixels that differ between the two versions."));
      const scale = 1.4;
      const [ca, cb] = await Promise.all([
        page < pa.numPages ? pa.getPage(page + 1).then((p) => renderPage(p, scale)) : null,
        page < pb.numPages ? pb.getPage(page + 1).then((p) => renderPage(p, scale)) : null,
      ]);
      if (!ca || !cb) { content.append(h("p", { class: "note" }, "This page exists in only one of the files.")); return; }
      const w = Math.max(ca.width, cb.width), hh = Math.max(ca.height, cb.height);
      const c = document.createElement("canvas");
      c.width = w; c.height = hh;
      const cx = c.getContext("2d");
      const get = (src) => { const t = document.createElement("canvas"); t.width = w; t.height = hh; const x = t.getContext("2d"); x.fillStyle = "#fff"; x.fillRect(0, 0, w, hh); x.drawImage(src, 0, 0); return x.getImageData(0, 0, w, hh).data; };
      const A = get(ca), B = get(cb);
      const outImg = cx.createImageData(w, hh);
      const o = outImg.data;
      let diffPx = 0;
      for (let i = 0; i < A.length; i += 4) {
        const d = Math.abs(A[i] - B[i]) + Math.abs(A[i + 1] - B[i + 1]) + Math.abs(A[i + 2] - B[i + 2]);
        if (d > 60) { o[i] = 230; o[i + 1] = 30; o[i + 2] = 30; o[i + 3] = 255; diffPx++; }
        else { const g = 255 - (255 - (B[i] + B[i + 1] + B[i + 2]) / 3) * 0.35; o[i] = o[i + 1] = o[i + 2] = g; o[i + 3] = 255; }
      }
      cx.putImageData(outImg, 0, 0);
      content.append(h("p", { class: "note" }, diffPx ? `${((diffPx / (w * hh)) * 100).toFixed(2)}% of the page differs.` : "No visual difference on this page."),
        h("div", { class: "visual" }, c));
    }
  }
  const first = diffs.findIndex((d) => d.changed);
  if (first > 0) { page = first; pageSel.value = first; }
  if (!added && !removed) toast("No text differences found.");
  draw();
}
