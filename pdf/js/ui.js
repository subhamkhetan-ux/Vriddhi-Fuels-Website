// Shared UI pieces: element helper, busy overlay, toasts, option forms, results.

import { download, zipOutputs, fmtSize, openPdfjs, renderPage, readBytes } from "./lib.js";

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k === "html") el.innerHTML = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

// ---- toast ----------------------------------------------------------------
let toastTimer;
export function toast(msg, kind = "") {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.className = "toast " + kind;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), kind === "error" ? 7000 : 3500);
}

// ---- busy overlay with progress + cancel ----------------------------------
export class Cancelled extends Error { constructor() { super("Cancelled"); } }

export function reportError(e) {
  if (e instanceof Cancelled) return toast("Cancelled.");
  console.error(e);
  toast(e?.message || String(e), "error");
}

/** Run `fn(ctx)` behind the progress overlay. ctx.progress throws once cancelled. */
export async function withBusy(label, fn) {
  const box = document.getElementById("busy");
  const lab = document.getElementById("busy-label");
  const bar = document.getElementById("busy-bar");
  const cancel = document.getElementById("busy-cancel");
  let cancelled = false, last = 0;
  const notes = [];
  cancel.onclick = () => { cancelled = true; lab.textContent = "Stopping…"; };
  lab.textContent = label;
  bar.style.width = "0";
  box.hidden = false;
  const ctx = {
    progress(frac, text) {
      if (cancelled) throw new Cancelled();
      if (frac != null) { last = Math.max(0, Math.min(1, frac)); bar.style.width = (last * 100).toFixed(1) + "%"; }
      if (text) lab.textContent = text;
    },
    note(msg) { notes.push(msg); },
    notes,
    get cancelled() { return cancelled; },
  };
  try {
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
    return await fn(ctx);
  } finally {
    box.hidden = true;
  }
}

/** Scale progress of sub-task i of n into the parent ctx. */
export function subCtx(ctx, i, n, prefix = "") {
  return {
    ...ctx,
    progress: (f, t) => ctx.progress(f == null ? null : (i + f) / n, t && prefix ? `${prefix} — ${t}` : t),
  };
}

// ---- option forms ----------------------------------------------------------
export function defaults(options = []) {
  const o = {};
  for (const opt of options) o[opt.key] = opt.default ?? (opt.type === "checkbox" ? false : "");
  return o;
}

/** Render a declarative options form; values object is mutated in place. */
export function renderForm(options = [], values, onChange = () => {}) {
  const root = h("div", { class: "form" });
  const rows = [];
  for (const opt of options) {
    if (opt.type === "hidden") continue;
    const id = "opt-" + opt.key + "-" + Math.random().toString(36).slice(2, 7);
    let row;
    const set = (v) => { values[opt.key] = v; refresh(); onChange(values); };
    if (opt.type === "checkbox") {
      const input = h("input", { type: "checkbox", id });
      input.checked = !!values[opt.key];
      input.onchange = () => set(input.checked);
      row = h("label", { class: "check", for: id }, input, h("span", {}, opt.label));
    } else {
      let input;
      if (opt.type === "select") {
        input = h("select", { id }, opt.choices.map(([v, l]) => h("option", { value: v }, l)));
        input.value = values[opt.key];
        input.onchange = () => set(input.value);
      } else if (opt.type === "radio") {
        input = h("div", { class: "radios", role: "radiogroup" }, opt.choices.map(([v, l]) => {
          const r = h("input", { type: "radio", name: id, value: v });
          r.checked = String(values[opt.key]) === String(v);
          r.onchange = () => set(v);
          return h("label", {}, r, h("span", {}, l));
        }));
      } else if (opt.type === "textarea") {
        input = h("textarea", { id, placeholder: opt.placeholder || "" });
        input.value = values[opt.key] || "";
        input.oninput = () => { values[opt.key] = input.value; onChange(values); };
      } else if (opt.type === "file") {
        input = h("input", { type: "file", id, accept: opt.accept || "" });
        input.onchange = () => set(input.files[0] || null);
      } else if (opt.type === "range") {
        const val = h("span", { class: "help" }, values[opt.key] + "%");
        const r = h("input", { type: "range", id, min: opt.min, max: opt.max, step: opt.step || 1 });
        r.value = values[opt.key];
        r.oninput = () => { values[opt.key] = +r.value; val.textContent = r.value + "%"; onChange(values); };
        input = h("div", { style: "display:flex;gap:10px;align-items:center" }, r, val);
      } else {
        input = h("input", {
          type: opt.type === "number" ? "number" : opt.type === "password" ? "password" : opt.type === "color" ? "color" : "text",
          id, placeholder: opt.placeholder || "", min: opt.min, max: opt.max, step: opt.step,
          autocomplete: opt.type === "password" ? "new-password" : "off",
        });
        input.value = values[opt.key] ?? "";
        input.oninput = () => { values[opt.key] = input.value; onChange(values); };
      }
      row = h("div", { class: "field" },
        h(opt.type === "radio" ? "div" : "label", { class: "lbl", for: id }, opt.label),
        input,
        opt.help ? h("div", { class: "help" }, opt.help) : null);
    }
    rows.push([opt, row]);
    root.append(row);
  }
  function refresh() {
    for (const [opt, row] of rows) row.hidden = opt.when ? !opt.when(values) : false;
  }
  refresh();
  return root;
}

// ---- file picking -----------------------------------------------------------
export function pickFiles({ accept = "", multiple = false, capture = false } = {}) {
  return new Promise((resolve) => {
    const input = h("input", { type: "file", accept, multiple: multiple || null, capture: capture ? "environment" : null, style: "display:none" });
    input.onchange = () => { resolve([...input.files]); input.remove(); };
    document.body.append(input);
    input.click();
  });
}

export function matchesAccept(file, accept) {
  if (!accept) return true;
  const name = file.name.toLowerCase();
  return accept.split(",").map((s) => s.trim().toLowerCase()).some((a) =>
    a.startsWith(".") ? name.endsWith(a) : a.endsWith("/*") ? (file.type || "").startsWith(a.slice(0, -1)) : file.type === a);
}

/** Make an element a drop target for files. */
export function dropTarget(el, onFiles) {
  el.addEventListener("dragover", (e) => { if ([...e.dataTransfer.types].includes("Files")) { e.preventDefault(); el.classList.add("over"); } });
  el.addEventListener("dragleave", () => el.classList.remove("over"));
  el.addEventListener("drop", (e) => {
    if (!e.dataTransfer.files.length) return;
    e.preventDefault();
    el.classList.remove("over");
    onFiles([...e.dataTransfer.files]);
  });
}

// ---- thumbnails -------------------------------------------------------------
export async function thumbnail(file, maxW = 160) {
  if ((file.type || "").startsWith("image/")) {
    const img = h("img", { alt: "" });
    img.src = URL.createObjectURL(file);
    return { el: img };
  }
  if (!/\.pdf$/i.test(file.name) && file.type !== "application/pdf") return { el: h("span", {}, "📄") };
  try {
    const pdf = await openPdfjs(await readBytes(file));
    const page = await pdf.getPage(1);
    const vp = page.getViewport({ scale: 1 });
    const c = await renderPage(page, maxW / vp.width);
    const pages = pdf.numPages;
    pdf.destroy();
    return { el: c, pages };
  } catch (e) {
    return { el: h("span", { title: e.message }, e.name === "PasswordError" || /password/i.test(e.message) ? "🔒" : "⚠️"), locked: /password/i.test(e.message) };
  }
}

// ---- results ----------------------------------------------------------------
export function showResults(container, outputs, { inputSize, onRestart, continueWith, notes = [] } = {}) {
  container.innerHTML = "";
  const total = outputs.reduce((s, o) => s + o.blob.size, 0);
  const many = outputs.length > 1;
  const panel = h("div", { class: "panel done" });
  panel.append(h("h2", {}, many ? `${outputs.length} files are ready` : "Your file is ready"));
  if (inputSize && outputs.length === 1 && /\.pdf$/i.test(outputs[0].name)) {
    const pct = Math.round((1 - total / inputSize) * 100);
    if (pct > 0) panel.append(h("div", { class: "saving" }, `${pct}% smaller · ${fmtSize(inputSize)} → ${fmtSize(total)}`));
    else if (pct < 0 && pct > -5) panel.append(h("div", { class: "sub" }, "This file was already well optimized."));
  }
  for (const n of notes) panel.append(h("p", { class: "note" }, n));
  panel.append(h("p", { class: "sub" }, many ? `${fmtSize(total)} in total` : `${outputs[0].name} · ${fmtSize(total)}`));
  const dl = h("button", { class: "btn big", type: "button" }, many ? "⬇  Download all (.zip)" : "⬇  Download");
  dl.onclick = async () => download(many ? await zipOutputs(outputs, "pdf-toolkit.zip") : outputs[0]);
  panel.append(dl);
  if (many) {
    panel.append(h("ul", { class: "outlist" }, outputs.map((o) =>
      h("li", {}, h("span", {}, o.name), h("small", {}, fmtSize(o.blob.size)),
        h("button", { class: "btn ghost small", type: "button", onclick: () => download(o) }, "Download")))));
  }
  const again = h("div", { style: "margin-top:18px" },
    h("button", { class: "btn ghost", type: "button", onclick: onRestart }, "↺ Start over"));
  panel.append(again);
  if (continueWith) {
    const pdfs = outputs.filter((o) => /\.pdf$/i.test(o.name));
    if (pdfs.length) panel.append(continueWith(pdfs));
  }
  container.append(panel);
  return panel;
}

export const asFile = (o) => new File([o.blob], o.name, { type: o.blob.type || "application/pdf" });
