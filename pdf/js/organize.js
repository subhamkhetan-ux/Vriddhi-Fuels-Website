// Organize PDF: visual page grid — reorder by drag, rotate, delete, duplicate,
// insert blank pages, and pull in pages from more PDFs.

import { PDFDocument, degrees, readBytes, loadPdf, openPdfjs, renderPage, out, baseName } from "./lib.js";
import { h, toast, withBusy, pickFiles, dropTarget, reportError } from "./ui.js";

const SRC_COLORS = ["#e5322d", "#2c6ecb", "#3d9a42", "#a347ba", "#f5a623", "#111e3e"];

export async function mount(el, { files, done }) {
  const sources = []; // {name, bytes, pdf (pdfjs)}
  let pages = []; // {src, index, rot, w, h, blank, id}
  let selected = new Set();
  let nextId = 1;

  async function addSources(fs) {
    await withBusy("Loading pages…", async (ctx) => {
      for (const f of fs) {
        ctx.progress(null, `Loading ${f.name}`);
        const bytes = await readBytes(f);
        const pdf = await openPdfjs(bytes);
        const src = sources.push({ name: f.name, bytes, pdf }) - 1;
        for (let i = 0; i < pdf.numPages; i++) {
          const vp = (await pdf.getPage(i + 1)).getViewport({ scale: 1 });
          pages.push({ src, index: i, rot: 0, w: vp.width, h: vp.height, id: nextId++ });
        }
      }
    });
  }

  await addSources(files);

  const grid = h("div", { class: "pages" });
  const count = h("span", { class: "help" });
  const toolbar = h("div", { class: "toolbar" },
    h("button", { class: "btn ghost small", type: "button", onclick: () => { selected = selected.size === pages.length ? new Set() : new Set(pages.map((p) => p.id)); draw(); } }, "Select all"),
    h("button", { class: "btn ghost small", type: "button", onclick: () => rotSel(-90) }, "↺ Rotate left"),
    h("button", { class: "btn ghost small", type: "button", onclick: () => rotSel(90) }, "↻ Rotate right"),
    h("button", { class: "btn ghost small", type: "button", onclick: () => delSel() }, "🗑 Delete"),
    h("button", { class: "btn ghost small", type: "button", onclick: () => { pages.reverse(); draw(); } }, "⇅ Reverse order"),
    h("button", { class: "btn ghost small", type: "button", onclick: async () => {
      const fs = await pickFiles({ accept: ".pdf,application/pdf", multiple: true });
      if (fs.length) { try { await addSources(fs); draw(); } catch (e) { reportError(e); } }
    } }, "+ Add PDF"),
    count,
    h("span", { class: "sp" }),
    h("button", { class: "btn", type: "button", onclick: save }, "Save PDF →"));
  el.append(h("div", { class: "panel" }, toolbar,
    h("p", { class: "help", style: "margin:0 0 12px" }, "Click to select pages, drag to reorder. Use the buttons under a page to rotate, duplicate, add a blank page after it, or delete it."),
    grid));
  dropTarget(grid, async (fs) => { const pdfs = fs.filter((f) => /\.pdf$/i.test(f.name)); if (pdfs.length) { await addSources(pdfs); draw(); } });

  const thumbCache = new Map();
  async function thumb(p) {
    const key = p.blank ? "blank" + p.w + "x" + p.h : p.src + ":" + p.index;
    if (!thumbCache.has(key)) {
      thumbCache.set(key, (async () => {
        if (p.blank) {
          const c = document.createElement("canvas");
          c.width = 120; c.height = Math.round((120 * p.h) / p.w);
          const cx = c.getContext("2d"); cx.fillStyle = "#fff"; cx.fillRect(0, 0, c.width, c.height);
          return c;
        }
        const page = await sources[p.src].pdf.getPage(p.index + 1);
        return renderPage(page, 130 / Math.max(p.w, p.h));
      })());
    }
    const c = await thumbCache.get(key);
    const copy = document.createElement("canvas");
    copy.width = c.width; copy.height = c.height;
    copy.getContext("2d").drawImage(c, 0, 0);
    return copy;
  }

  function rotSel(d) {
    if (!selected.size) return toast("Select pages first (click them).");
    pages.forEach((p) => selected.has(p.id) && (p.rot = (p.rot + d + 360) % 360));
    draw();
  }
  function delSel() {
    if (!selected.size) return toast("Select pages first (click them).");
    if (selected.size >= pages.length) return toast("You can't delete every page.", "error");
    pages = pages.filter((p) => !selected.has(p.id));
    selected.clear();
    draw();
  }

  let dragId = null;
  function draw() {
    grid.innerHTML = "";
    count.textContent = `${pages.length} pages${selected.size ? ` · ${selected.size} selected` : ""}`;
    pages.forEach((p, i) => {
      const pv = h("div", { class: "pv" });
      thumb(p).then((c) => { c.style.transform = `rotate(${p.rot}deg)`; pv.append(c); });
      const tile = h("div", { class: "pg" + (selected.has(p.id) ? " sel" : ""), draggable: "true" },
        sources.length > 1 && !p.blank ? h("span", { class: "src", style: { background: SRC_COLORS[p.src % SRC_COLORS.length] }, title: sources[p.src].name }, String.fromCharCode(65 + p.src)) : null,
        pv,
        h("div", { class: "num" }, p.blank ? `${i + 1} · blank` : `${i + 1}`),
        h("div", { class: "tools" },
          h("button", { type: "button", title: "Rotate", onclick: (e) => { e.stopPropagation(); p.rot = (p.rot + 90) % 360; draw(); } }, "↻"),
          h("button", { type: "button", title: "Duplicate", onclick: (e) => { e.stopPropagation(); pages.splice(i + 1, 0, { ...p, id: nextId++ }); draw(); } }, "⧉"),
          h("button", { type: "button", title: "Insert blank page after", onclick: (e) => { e.stopPropagation(); pages.splice(i + 1, 0, { blank: true, w: p.rot % 180 ? p.h : p.w, h: p.rot % 180 ? p.w : p.h, rot: 0, id: nextId++ }); draw(); } }, "＋"),
          h("button", { type: "button", title: "Delete", onclick: (e) => { e.stopPropagation(); if (pages.length > 1) { pages.splice(i, 1); selected.delete(p.id); draw(); } } }, "🗑")));
      tile.onclick = (e) => {
        if (e.shiftKey && selected.size) {
          const last = pages.findIndex((q) => selected.has(q.id));
          const [a, b] = [Math.min(last, i), Math.max(last, i)];
          for (let k = a; k <= b; k++) selected.add(pages[k].id);
        } else if (selected.has(p.id)) selected.delete(p.id);
        else selected.add(p.id);
        draw();
      };
      tile.addEventListener("dragstart", (e) => { dragId = p.id; e.dataTransfer.setData("text/plain", ""); tile.classList.add("drag"); });
      tile.addEventListener("dragend", () => { dragId = null; tile.classList.remove("drag"); });
      tile.addEventListener("dragover", (e) => { if (dragId != null) { e.preventDefault(); tile.classList.add("dropbefore"); } });
      tile.addEventListener("dragleave", () => tile.classList.remove("dropbefore"));
      tile.addEventListener("drop", (e) => {
        if (dragId == null) return;
        e.preventDefault();
        // move the dragged page (or the whole selection if it's part of it)
        const moving = selected.has(dragId) ? pages.filter((q) => selected.has(q.id)) : pages.filter((q) => q.id === dragId);
        if (moving.some((q) => q.id === p.id)) return draw();
        const rest = pages.filter((q) => !moving.includes(q));
        rest.splice(rest.indexOf(p), 0, ...moving);
        pages = rest;
        draw();
      });
      grid.append(tile);
    });
  }
  draw();

  async function save() {
    try {
      const bytes = await withBusy("Building PDF…", async (ctx) => {
        const doc = await PDFDocument.create();
        const libs = [];
        for (let i = 0; i < pages.length; i++) {
          ctx.progress(i / pages.length, `Page ${i + 1} of ${pages.length}`);
          const p = pages[i];
          if (p.blank) { doc.addPage([p.w, p.h]); continue; }
          libs[p.src] ||= await loadPdf(sources[p.src].bytes);
          const [cp] = await doc.copyPages(libs[p.src], [p.index]);
          if (p.rot) cp.setRotation(degrees((cp.getRotation().angle + p.rot) % 360));
          doc.addPage(cp);
        }
        return doc.save({ useObjectStreams: true });
      });
      const name = sources.length === 1 ? baseName(sources[0].name) + "_organized.pdf" : "organized.pdf";
      sources.forEach((s) => s.pdf.destroy());
      done([out(name, bytes)]);
    } catch (e) {
      reportError(e);
    }
  }
}
