// App shell: hash router, tool grid, and the generic "add files → options →
// process → download" page that every non-interactive tool uses.

import { TOOLS, CATEGORIES, toolById } from "./tools.js";
import { readBytes, baseName, out, fmtSize } from "./lib.js";
import {
  h, toast, withBusy, subCtx, defaults, renderForm, pickFiles, matchesAccept, dropTarget,
  thumbnail, showResults, asFile, Cancelled, reportError,
} from "./ui.js";

const view = document.getElementById("view");
const search = document.getElementById("search");
let homeCat = "all";
// files handed from one tool's result to the next ("continue with…")
let carried = null;

const INTERACTIVE = {
  organize: () => import("./organize.js"),
  edit: () => import("./editor.js"),
  sign: () => import("./editor.js"),
  redact: () => import("./editor.js"),
  crop: () => import("./editor.js"),
  forms: () => import("./forms.js"),
  compare: () => import("./compare.js"),
  workflow: () => import("./workflow.js"),
};

function route() {
  const m = location.hash.match(/^#\/tool\/([\w-]+)/);
  const tool = m && toolById(m[1]);
  window.scrollTo(0, 0);
  if (tool) {
    document.title = `${tool.name} · PDF Toolkit`;
    toolPage(tool);
  } else {
    document.title = "PDF Toolkit";
    home();
  }
}
window.addEventListener("hashchange", route);

// ===========================================================================
// HOME
// ===========================================================================

function toolCard(t, small = false) {
  return h("a", { class: "card", href: `#/tool/${t.id}` },
    h("div", { class: "glyph", style: { background: t.color } }, t.glyph),
    h("h3", {}, t.name),
    small ? null : h("p", {}, t.desc));
}

function home() {
  view.innerHTML = "";
  const q = search.value.trim().toLowerCase();
  view.append(
    h("section", { class: "hero" },
      h("h1", {}, "Every tool you need to work with PDFs"),
      h("p", {}, "Merge, split, compress, convert, OCR, edit, sign, redact and protect — all free, with no limits, running right on your device.")),
  );
  const chips = h("div", { class: "chips", role: "toolbar" },
    [["all", "All"], ...CATEGORIES].map(([id, label]) =>
      h("button", { class: "chip", type: "button", "aria-pressed": String(homeCat === id), onclick: () => { homeCat = id; home(); } }, label)));
  view.append(chips);
  const list = TOOLS.filter((t) =>
    (homeCat === "all" || t.cat === homeCat) &&
    (!q || (t.name + " " + t.desc).toLowerCase().includes(q)));
  view.append(list.length ? h("div", { class: "grid" }, list.map((t) => toolCard(t))) : h("p", { class: "empty" }, "No tool matches that search."));
  view.append(h("section", { class: "features" },
    feature("No limits", "No file-size caps, page caps, daily task limits or waiting."),
    feature("Batch processing", "Drop in dozens of PDFs and process them all in one go."),
    feature("Private by design", "Files are processed in your browser and never uploaded anywhere."),
    feature("Works offline", "Install it as an app; once loaded, most tools work without internet."),
  ));
}
const feature = (t, d) => h("div", { class: "feature" }, h("b", {}, t), d);

search.addEventListener("input", () => {
  if (location.hash.startsWith("#/tool/")) location.hash = "#/";
  else home();
});

// ===========================================================================
// TOOL PAGE
// ===========================================================================

function header(tool) {
  return h("div", {},
    h("a", { class: "back", href: "#/" }, "← All tools"),
    h("div", { class: "tool-head" },
      h("div", { class: "glyph", style: { background: tool.color } }, tool.glyph),
      h("div", {}, h("h1", {}, tool.name), h("p", {}, tool.desc))));
}

function continueWith(fromTool) {
  return (pdfs) => {
    const next = TOOLS.filter((t) => t.id !== fromTool.id && t.accept?.includes(".pdf") && (pdfs.length === 1 || t.multiple || t.batch));
    return h("div", { class: "continue" },
      h("p", { class: "sub", style: "margin:0" }, "Continue with…"),
      h("div", { class: "grid" }, next.map((t) => {
        const a = toolCard(t, true);
        a.addEventListener("click", () => { carried = pdfs.map(asFile); });
        return a;
      })));
  };
}

function toolPage(tool) {
  view.innerHTML = "";
  view.append(header(tool));
  const body = h("div", {});
  view.append(body);
  let files = carried ? carried.filter((f) => matchesAccept(f, tool.accept)) : [];
  carried = null;

  if (tool.interactive) {
    const start = async (fs) => {
      const mod = await INTERACTIVE[tool.interactive]();
      body.innerHTML = "";
      try {
        await mod.mount(body, {
          tool, files: fs,
          done: (outputs, extra = {}) => showResults(body, outputs, { ...extra, onRestart: () => toolPage(tool), continueWith: continueWith(tool) }),
          restart: () => toolPage(tool),
        });
      } catch (e) {
        reportError(e);
        toolPage(tool);
      }
    };
    const multi = tool.interactive === "compare" || tool.interactive === "workflow" || tool.interactive === "organize";
    if (files.length && (tool.interactive !== "compare" || files.length >= 2)) return start(multi ? files : files.slice(0, 1));
    return body.append(dropZone(tool, (fs) => start(multi ? fs : fs.slice(0, 1)), multi));
  }

  const values = defaults(tool.options);
  const render = () => {
    body.innerHTML = "";
    if (!files.length) {
      body.append(dropZone(tool, (fs) => { files = tool.multiple || tool.batch ? fs : fs.slice(0, 1); render(); }, tool.multiple || tool.batch));
      if (tool.filesOptional) body.append(sidePanel());
      return;
    }
    body.append(h("div", { class: "layout" }, fileGrid(), sidePanel()));
  };

  function fileGrid() {
    const grid = h("div", { class: "files" });
    files.forEach((f, i) => {
      const thumb = h("div", { class: "thumb" }, "…");
      const meta = h("div", { class: "meta" }, fmtSize(f.size));
      thumbnail(f).then((t) => {
        thumb.innerHTML = "";
        thumb.append(t.el);
        if (t.pages) meta.textContent = `${fmtSize(f.size)} · ${t.pages} page${t.pages > 1 ? "s" : ""}`;
        if (t.locked) meta.textContent = `${fmtSize(f.size)} · password-protected`;
      });
      const card = h("div", { class: "file" + (tool.ordered ? " ordered" : ""), draggable: tool.ordered ? "true" : null },
        tool.ordered ? h("span", { class: "ord" }, i + 1) : null,
        h("button", { class: "x", type: "button", title: "Remove", onclick: () => { files.splice(i, 1); render(); } }, "×"),
        thumb, h("div", { class: "name", title: f.name }, f.name), meta,
        tool.ordered ? h("div", { class: "moves" },
          h("button", { type: "button", title: "Move earlier", disabled: i === 0 || null, onclick: () => { move(i, i - 1); } }, "◀"),
          h("button", { type: "button", title: "Move later", disabled: i === files.length - 1 || null, onclick: () => { move(i, i + 1); } }, "▶")) : null);
      if (tool.ordered) {
        card.addEventListener("dragstart", (e) => { e.dataTransfer.setData("text/x-idx", String(i)); card.classList.add("drag"); });
        card.addEventListener("dragend", () => card.classList.remove("drag"));
        card.addEventListener("dragover", (e) => { if (e.dataTransfer.types.includes("text/x-idx")) { e.preventDefault(); card.classList.add("dropbefore"); } });
        card.addEventListener("dragleave", () => card.classList.remove("dropbefore"));
        card.addEventListener("drop", (e) => {
          const from = e.dataTransfer.getData("text/x-idx");
          if (from === "") return;
          e.preventDefault();
          move(+from, i);
        });
      }
      grid.append(card);
    });
    if (tool.multiple || tool.batch) {
      const add = h("button", { class: "addmore", type: "button" }, "+ Add more files");
      add.onclick = async () => addFiles(await pickFiles({ accept: tool.accept, multiple: true, capture: tool.capture }));
      dropTarget(add, addFiles);
      grid.append(add);
    }
    dropTarget(grid, addFiles);
    return grid;
  }

  function move(from, to) {
    if (to < 0 || to >= files.length || from === to) return;
    const [f] = files.splice(from, 1);
    files.splice(to, 0, f);
    render();
  }

  function addFiles(fs) {
    const ok = fs.filter((f) => matchesAccept(f, tool.accept));
    if (ok.length < fs.length) toast(`Skipped ${fs.length - ok.length} file(s) this tool can't use.`, "error");
    files.push(...ok);
    render();
  }

  function sidePanel() {
    const panel = h("div", { class: "panel side" });
    panel.append(h("h2", {}, "Options"));
    if (tool.note) panel.append(h("p", { class: "note" }, tool.note));
    if (tool.options?.length) panel.append(renderForm(tool.options, values));
    else panel.append(h("p", { class: "note" }, files.length > 1 ? `${files.length} files will be processed.` : "No options needed."));
    const need = tool.min || 1;
    const btn = h("button", { class: "btn big", type: "button", style: "width:100%;margin-top:6px" }, (tool.verb || "Process") + " →");
    if (files.length < need && !tool.filesOptional) {
      btn.disabled = true;
      panel.append(h("p", { class: "err" }, `Add at least ${need} files.`));
    }
    btn.onclick = () => process();
    panel.append(btn);
    return panel;
  }

  async function process() {
    const inputSize = files.reduce((s, f) => s + f.size, 0);
    let notes = [];
    try {
      const outputs = await withBusy(`${tool.verb || "Processing"}…`, async (ctx) => {
        notes = ctx.notes;
        if (!files.length && tool.run) return tool.run([], values, ctx);
        if (tool.batch) {
          const res = [];
          for (let i = 0; i < files.length; i++) {
            const f = files[i];
            const c = subCtx(ctx, i, files.length, files.length > 1 ? `File ${i + 1}/${files.length}` : "");
            c.progress(0, files.length > 1 ? `File ${i + 1} of ${files.length}: ${f.name}` : f.name);
            try {
              if (tool.transform) {
                const bytes = await tool.transform(await readBytes(f), { ...values, __name: f.name }, c);
                res.push(out(baseName(f.name) + (tool.suffix ?? "") + ".pdf", bytes));
              } else res.push(...(await tool.perFile(f, values, c)));
            } catch (e) {
              if (e instanceof Cancelled || files.length === 1) throw e;
              ctx.note(`${f.name}: ${e.message}`);
            }
          }
          if (!res.length) throw new Error(ctx.notes.join("\n") || "Nothing was produced.");
          return res;
        }
        return tool.run(files, values, ctx);
      });
      showResults(body, outputs, {
        inputSize: tool.id === "compress" ? inputSize : null,
        notes,
        onRestart: () => toolPage(tool),
        continueWith: continueWith(tool),
      });
    } catch (e) {
      reportError(e);
    }
  }

  render();
}

function dropZone(tool, onFiles, multiple) {
  const zone = h("div", { class: "drop" });
  const pick = async () => {
    const fs = await pickFiles({ accept: tool.accept, multiple, capture: tool.capture });
    if (fs.length) accept(fs);
  };
  const accept = (fs) => {
    const ok = fs.filter((f) => matchesAccept(f, tool.accept));
    if (!ok.length) return toast("Those files can't be used with this tool.", "error");
    onFiles(ok);
  };
  const what = tool.accept?.startsWith("image") ? "images" : tool.accept?.includes(".docx") ? "Word files"
    : tool.accept?.includes(".pptx") ? "PowerPoint files" : tool.accept?.includes(".xlsx") ? "spreadsheets"
    : tool.accept?.includes(".html") ? "HTML files" : "PDF files";
  zone.append(
    h("button", { class: "btn big", type: "button", onclick: pick }, tool.capture ? "📷  Take photos / choose images" : `Select ${what}`),
    h("p", {}, multiple ? `or drop ${what} here — as many as you like` : `or drop a file here`));
  dropTarget(zone, accept);
  return zone;
}

// ---- boot -----------------------------------------------------------------
route();
if ("serviceWorker" in navigator && location.protocol === "https:") {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
