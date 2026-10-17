// Page editor used by Edit PDF, Sign PDF, Redact PDF and Crop PDF.
// Objects live in "visual" page coordinates: PDF points, origin top-left of
// the page as displayed (after /Rotate). They are burned in on save.

import {
  PDFLib, StandardFonts, rgb, readBytes, baseName, out, loadPdf, openPdfjs, renderPage,
  canvasBytes, hexToRgb, winAnsiSafe, visual, decodeImage,
} from "./lib.js";
import { h, toast, withBusy, pickFiles, reportError } from "./ui.js";

const FONTS = {
  helvetica: { css: "Helvetica, Arial, sans-serif", std: [StandardFonts.Helvetica, StandardFonts.HelveticaBold], base: 0.92 },
  times: { css: "'Times New Roman', Times, serif", std: [StandardFonts.TimesRoman, StandardFonts.TimesRomanBold], base: 0.91 },
  courier: { css: "'Courier New', Courier, monospace", std: [StandardFonts.Courier, StandardFonts.CourierBold], base: 0.88 },
};

const EDIT_MODES = [
  ["select", "⬚", "Select"], ["text", "T", "Text"], ["image", "🖼", "Image"],
  ["rect", "▭", "Rectangle"], ["ellipse", "◯", "Ellipse"], ["line", "╱", "Line"],
  ["draw", "✎", "Draw"], ["whiteout", "▯", "White-out"], ["highlight", "▬", "Highlight"],
];

const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem("pdftk." + k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem("pdftk." + k, JSON.stringify(v)); } catch {} },
};

export async function mount(el, { tool, files, done }) {
  const kind = tool.interactive; // edit | sign | redact | crop
  const file = files[0];
  const bytes = await readBytes(file);
  const pdf = await openPdfjs(bytes);
  const n = pdf.numPages;
  const sizes = [];
  for (let i = 1; i <= n; i++) {
    const vp = (await pdf.getPage(i)).getViewport({ scale: 1 });
    sizes.push({ w: vp.width, h: vp.height });
  }

  let cur = 0, zoom = 1, scale = 1;
  let mode = kind === "redact" ? "redact" : "select";
  let objects = []; // {id, page, type, x, y, w, h, ...}
  let sel = null, nextId = 1;
  let crop = null; // {x, y, w, h} visual pts on current page
  const style = { color: "#111111", size: 16, font: "helvetica", bold: false, stroke: 2, fill: "", sigColor: "#0d2a8a" };

  // ---- layout ---------------------------------------------------------------
  const strip = h("div", { class: "strip" });
  const bgCanvasHolder = h("div", {});
  const overlay = h("div", { class: "ov" });
  const sheet = h("div", { class: "sheet" }, bgCanvasHolder, overlay);
  const stage = h("div", { class: "stage" }, sheet);
  const side = h("div", { class: "panel side" });
  const pageLabel = h("span", { class: "help" });
  const nav = h("div", { class: "toolbar" },
    h("button", { class: "btn ghost small", type: "button", onclick: () => go(cur - 1) }, "◀"),
    pageLabel,
    h("button", { class: "btn ghost small", type: "button", onclick: () => go(cur + 1) }, "▶"),
    h("span", { class: "sp" }),
    h("button", { class: "btn ghost small", type: "button", title: "Zoom out", onclick: () => { zoom = Math.max(0.4, zoom / 1.2); show(); } }, "−"),
    h("button", { class: "btn ghost small", type: "button", title: "Zoom in", onclick: () => { zoom = Math.min(4, zoom * 1.2); show(); } }, "+"));
  el.append(h("div", { class: "ed" }, strip, h("div", {}, nav, stage), side));

  // thumbnails, rendered one after another
  const thumbs = [];
  for (let i = 0; i < n; i++) {
    const t = h("div", { class: "st", onclick: () => go(i) }, h("div", {}), `${i + 1}`);
    thumbs.push(t);
    strip.append(t);
  }
  (async () => {
    for (let i = 0; i < n; i++) {
      try {
        const page = await pdf.getPage(i + 1);
        thumbs[i].firstChild.append(await renderPage(page, 160 / sizes[i].w));
      } catch {}
    }
  })();

  // ---- page display ----------------------------------------------------------
  let renderToken = 0;
  async function show() {
    const token = ++renderToken;
    const { w } = sizes[cur];
    const avail = Math.max(280, stage.clientWidth - 36);
    scale = Math.min(1.8, avail / w) * zoom;
    const page = await pdf.getPage(cur + 1);
    const canvas = await renderPage(page, scale * (window.devicePixelRatio || 1));
    if (token !== renderToken) return;
    canvas.className = "bgc";
    canvas.style.width = sizes[cur].w * scale + "px";
    canvas.style.height = sizes[cur].h * scale + "px";
    bgCanvasHolder.innerHTML = "";
    bgCanvasHolder.append(canvas);
    pageLabel.textContent = `Page ${cur + 1} of ${n}`;
    thumbs.forEach((t, i) => t.classList.toggle("on", i === cur));
    drawObjects();
  }
  function go(i) {
    if (i < 0 || i >= n) return;
    cur = i;
    sel = null;
    if (kind === "crop" && crop && !cropAll.checked) crop = null;
    show();
    thumbs[i].scrollIntoView({ block: "nearest", inline: "nearest" });
    renderSide();
  }
  window.addEventListener("resize", () => { if (el.isConnected) show(); });

  // ---- objects ---------------------------------------------------------------
  const px = (v) => v * scale + "px";

  function objEl(o) {
    const e = h("div", { class: "obj " + o.type + (sel === o ? " on" : "") });
    Object.assign(e.style, { left: px(o.x), top: px(o.y), width: px(o.w), height: px(o.h) });
    if (o.type === "text") {
      const t = h("div", { contenteditable: "true", spellcheck: "false" });
      t.textContent = o.text;
      Object.assign(t.style, { fontSize: px(o.size), color: o.color, fontFamily: FONTS[o.font].css, fontWeight: o.bold ? "700" : "400" });
      t.addEventListener("input", () => { o.text = t.innerText.replace(/\n$/, ""); measure(o, t); e.style.width = px(o.w); e.style.height = px(o.h); });
      t.addEventListener("pointerdown", (ev) => { if (sel === o) ev.stopPropagation(); });
      e.style.width = e.style.height = "auto";
      e.append(t);
      requestAnimationFrame(() => measure(o, t));
      if (o.focus) { delete o.focus; requestAnimationFrame(() => { t.focus(); document.getSelection().selectAllChildren(t); }); }
    } else if (o.type === "image") {
      e.append(h("img", { src: o.src, alt: "" }));
    } else if (o.type === "rect" || o.type === "whiteout" || o.type === "highlight" || o.type === "redact" || o.type === "ellipse") {
      Object.assign(e.style, {
        background: o.type === "whiteout" ? "#fff" : o.type === "highlight" ? "rgba(255,230,0,.45)" : o.type === "redact" ? "rgba(0,0,0,.75)" : o.fill || "transparent",
        border: o.type === "rect" || o.type === "ellipse" ? `${Math.max(0, o.stroke) * scale}px solid ${o.color}` : o.type === "whiteout" ? "1px dashed #bbb" : "0",
        borderRadius: o.type === "ellipse" ? "50%" : "0",
        boxSizing: "border-box",
        mixBlendMode: o.type === "highlight" ? "multiply" : "normal",
      });
    } else if (o.type === "path") {
      const d = o.points.map((p, i) => `${i ? "L" : "M"}${p[0]} ${p[1]}`).join(" ");
      e.innerHTML = `<svg viewBox="0 0 ${Math.max(o.w0, 0.01)} ${Math.max(o.h0, 0.01)}" preserveAspectRatio="none"><path d="${d}" fill="none" stroke="${o.color}" stroke-width="${o.stroke}" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke" style="stroke-width:${o.stroke * scale}px"/></svg>`;
    }
    if (o.type !== "text") e.append(h("i", { class: "rz" }));
    e.append(h("button", { class: "del", type: "button", title: "Delete", onclick: (ev) => { ev.stopPropagation(); remove(o); } }, "×"));
    e.addEventListener("pointerdown", (ev) => startDrag(ev, o, e));
    return e;
  }

  function measure(o, t) {
    const r = t.getBoundingClientRect();
    o.w = r.width / scale;
    o.h = r.height / scale;
  }

  function drawObjects() {
    overlay.innerHTML = "";
    for (const o of objects) if (o.page === cur) overlay.append(objEl(o));
    if (kind === "crop") drawCrop();
  }
  function remove(o) {
    objects = objects.filter((x) => x !== o);
    if (sel === o) sel = null;
    drawObjects();
    renderSide();
  }
  function select(o) { sel = o; drawObjects(); renderSide(); }

  function startDrag(ev, o, e) {
    if (mode !== "select" && kind !== "sign" && kind !== "redact") return;
    ev.stopPropagation();
    if (sel !== o) { select(o); }
    const resizing = ev.target.classList.contains("rz");
    const sx = ev.clientX, sy = ev.clientY;
    const start = { x: o.x, y: o.y, w: o.w, h: o.h };
    const ratio = o.w / o.h;
    const node = overlay.querySelector(".obj.on") || e;
    const moveFn = (m) => {
      const dx = (m.clientX - sx) / scale, dy = (m.clientY - sy) / scale;
      if (resizing) {
        o.w = Math.max(4, start.w + dx);
        o.h = o.type === "image" && !m.shiftKey ? o.w / ratio : Math.max(4, start.h + dy);
        node.style.width = px(o.w); node.style.height = px(o.h);
      } else {
        o.x = start.x + dx; o.y = start.y + dy;
        node.style.left = px(o.x); node.style.top = px(o.y);
      }
    };
    const up = () => { window.removeEventListener("pointermove", moveFn); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", moveFn);
    window.addEventListener("pointerup", up);
  }

  const toPt = (ev) => {
    const r = overlay.getBoundingClientRect();
    return { x: (ev.clientX - r.left) / scale, y: (ev.clientY - r.top) / scale };
  };

  let pendingImage = null; // {src, w, h} waiting to be placed with a click
  overlay.addEventListener("pointerdown", async (ev) => {
    if (kind === "crop") return;
    const p = toPt(ev);
    if (pendingImage) {
      const { src, w, h: hh } = pendingImage;
      const o = { id: nextId++, page: cur, type: "image", src, x: p.x - w / 2, y: p.y - hh / 2, w, h: hh };
      objects.push(o);
      pendingImage = null;
      overlay.style.cursor = "";
      select(o);
      return;
    }
    if (mode === "select") { if (sel) select(null); return; }
    if (mode === "text") {
      const o = { id: nextId++, page: cur, type: "text", text: "Text", x: p.x, y: p.y - style.size * 0.6, w: 40, h: style.size * 1.15, size: +style.size, color: style.color, font: style.font, bold: style.bold, focus: true };
      objects.push(o);
      setMode("select");
      select(o);
      return;
    }
    if (mode === "image") {
      const [f] = await pickFiles({ accept: "image/*" });
      if (!f) return;
      const img = await loadImageData(f);
      const w = Math.min(200, sizes[cur].w * 0.5), hh = (w * img.h) / img.w;
      const o = { id: nextId++, page: cur, type: "image", src: img.src, x: p.x, y: p.y, w, h: hh };
      objects.push(o);
      setMode("select");
      select(o);
      return;
    }
    // drag-to-create shapes and paths
    const isPath = mode === "draw" || mode === "line";
    const o = isPath
      ? { id: nextId++, page: cur, type: "path", line: mode === "line", points: [[0, 0]], x: p.x, y: p.y, w: 1, h: 1, w0: 1, h0: 1, color: style.color, stroke: +style.stroke, abs: [[p.x, p.y]] }
      : { id: nextId++, page: cur, type: mode, x: p.x, y: p.y, w: 1, h: 1, color: style.color, stroke: +style.stroke, fill: style.fill };
    objects.push(o);
    let node = objEl(o);
    overlay.append(node);
    overlay.setPointerCapture(ev.pointerId);
    const moveFn = (m) => {
      const q = toPt(m);
      if (isPath) {
        if (o.line) o.abs = [o.abs[0], [q.x, q.y]];
        else o.abs.push([q.x, q.y]);
        normalizePath(o);
      } else {
        o.x = Math.min(p.x, q.x); o.y = Math.min(p.y, q.y);
        o.w = Math.abs(q.x - p.x); o.h = Math.abs(q.y - p.y);
      }
      const nn = objEl(o);
      node.replaceWith(nn);
      node = nn;
    };
    const up = () => {
      overlay.removeEventListener("pointermove", moveFn);
      overlay.removeEventListener("pointerup", up);
      if (!isPath && (o.w < 3 || o.h < 3)) { objects = objects.filter((x) => x !== o); drawObjects(); return; }
      if (isPath && o.abs.length < 2) { objects = objects.filter((x) => x !== o); drawObjects(); return; }
      delete o.abs;
      drawObjects();
      renderSide();
    };
    overlay.addEventListener("pointermove", moveFn);
    overlay.addEventListener("pointerup", up);
  });

  function normalizePath(o) {
    const xs = o.abs.map((a) => a[0]), ys = o.abs.map((a) => a[1]);
    const pad = o.stroke;
    o.x = Math.min(...xs) - pad; o.y = Math.min(...ys) - pad;
    o.w = o.w0 = Math.max(...xs) - o.x + pad;
    o.h = o.h0 = Math.max(...ys) - o.y + pad;
    o.points = o.abs.map(([x, y]) => [x - o.x, y - o.y]);
  }

  document.addEventListener("keydown", (ev) => {
    if (!el.isConnected || !sel) return;
    if ((ev.key === "Delete" || ev.key === "Backspace") && !ev.target.isContentEditable && !/INPUT|TEXTAREA/.test(ev.target.tagName)) {
      ev.preventDefault();
      remove(sel);
    }
  });

  async function loadImageData(f) {
    const src = await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(f); });
    const bmp = await decodeImage(f);
    return { src, w: bmp.width, h: bmp.height };
  }

  // ---- side panel --------------------------------------------------------------
  let modeButtons = [];
  function setMode(m) {
    mode = m;
    modeButtons.forEach(([k, b]) => b.setAttribute("aria-pressed", String(k === m)));
    overlay.style.cursor = m === "select" ? "" : m === "text" ? "text" : "crosshair";
  }

  function styleControls() {
    const box = h("div", {});
    const o = sel;
    const target = o || style;
    const set = (k, v) => {
      if (o) { o[k] = v; drawObjects(); }
      style[k === "fill" ? "fill" : k] = v;
    };
    const showText = o ? o.type === "text" : mode === "text";
    const showStroke = o ? ["rect", "ellipse", "path"].includes(o.type) : ["rect", "ellipse", "line", "draw"].includes(mode);
    if (showText || showStroke) {
      const color = h("input", { type: "color", value: target.color || "#111111" });
      color.oninput = () => set("color", color.value);
      box.append(h("div", { class: "field" }, h("label", { class: "lbl" }, "Color"), color));
    }
    if (showText) {
      const size = h("input", { type: "number", min: 4, max: 200, value: target.size });
      size.oninput = () => set("size", +size.value || 12);
      const font = h("select", {}, Object.keys(FONTS).map((k) => h("option", { value: k }, k[0].toUpperCase() + k.slice(1))));
      font.value = target.font;
      font.onchange = () => set("font", font.value);
      const bold = h("input", { type: "checkbox" });
      bold.checked = !!target.bold;
      bold.onchange = () => set("bold", bold.checked);
      box.append(h("div", { class: "field" }, h("label", { class: "lbl" }, "Font size"), size),
        h("div", { class: "field" }, h("label", { class: "lbl" }, "Font"), font),
        h("label", { class: "check" }, bold, h("span", {}, "Bold")));
    }
    if (showStroke) {
      const stroke = h("input", { type: "number", min: 0, max: 30, step: 0.5, value: target.stroke });
      stroke.oninput = () => set("stroke", +stroke.value);
      box.append(h("div", { class: "field" }, h("label", { class: "lbl" }, "Line width"), stroke));
      if (o ? o.type !== "path" : !["line", "draw"].includes(mode)) {
        const fillOn = h("input", { type: "checkbox" });
        fillOn.checked = !!target.fill;
        const fill = h("input", { type: "color", value: target.fill || "#ffeb3b" });
        fillOn.onchange = () => set("fill", fillOn.checked ? fill.value : "");
        fill.oninput = () => { if (fillOn.checked) set("fill", fill.value); };
        box.append(h("div", { class: "field" }, h("label", { class: "check" }, fillOn, h("span", {}, "Fill")), fill));
      }
    }
    return box;
  }

  const cropAll = h("input", { type: "checkbox", checked: true });

  function renderSide() {
    side.innerHTML = "";
    if (kind === "edit") {
      side.append(h("h2", {}, "Tools"));
      const modes = h("div", { class: "modes" });
      modeButtons = EDIT_MODES.map(([k, g, l]) => {
        const b = h("button", { type: "button", "aria-pressed": String(mode === k), onclick: () => { setMode(k); sel = null; drawObjects(); renderSide(); } }, h("b", {}, g), l);
        modes.append(b);
        return [k, b];
      });
      side.append(modes, styleControls());
      side.append(h("p", { class: "help" }, mode === "select" ? "Click an item to select it; drag to move, use the dot to resize, Delete to remove. Double-click text to edit." : "Click or drag on the page to add."));
    } else if (kind === "sign") {
      signPanel();
    } else if (kind === "redact") {
      redactPanel();
    } else if (kind === "crop") {
      cropPanel();
    }
    const saveBtn = h("button", { class: "btn big", type: "button", style: "width:100%;margin-top:12px" },
      { edit: "Save PDF →", sign: "Sign & save →", redact: "Redact & save →", crop: "Crop & save →" }[kind]);
    saveBtn.onclick = save;
    side.append(saveBtn);
  }

  // ---- signing ---------------------------------------------------------------
  let sigs = store.get("signatures", []);
  function signPanel() {
    side.append(h("h2", {}, "Signatures"));
    const list = h("div", { class: "sigs" });
    sigs.forEach((s, i) => {
      const b = h("button", { type: "button", title: "Click, then click on the page to place" }, h("img", { src: s.src, alt: "Signature" }));
      b.onclick = () => { pendingImage = { src: s.src, w: s.kind === "initials" ? 70 : 150, h: (s.kind === "initials" ? 70 : 150) / s.ratio }; overlay.style.cursor = "copy"; toast("Click on the page where it should go."); };
      b.oncontextmenu = (e) => { e.preventDefault(); if (confirm("Delete this saved signature?")) { sigs.splice(i, 1); store.set("signatures", sigs); renderSide(); } };
      list.append(b);
    });
    if (sigs.length) side.append(h("p", { class: "help" }, "Click a signature, then click on the page. Right-click to delete a saved one."), list);
    side.append(signatureMaker());
    side.append(h("h2", { style: "margin-top:16px" }, "Add fields"));
    side.append(h("div", { class: "toolbar" },
      h("button", { class: "btn ghost small", type: "button", onclick: () => addText(new Date().toLocaleDateString()) }, "📅 Date"),
      h("button", { class: "btn ghost small", type: "button", onclick: () => addText(store.get("name", "Your name")) }, "👤 Name"),
      h("button", { class: "btn ghost small", type: "button", onclick: () => addText("Text") }, "T Text"),
      h("button", { class: "btn ghost small", type: "button", onclick: () => addText("✓") }, "✓ Check")));
    if (sel) {
      side.append(styleControls());
      side.append(h("button", { class: "btn ghost small", type: "button", onclick: () => {
        for (let i = 0; i < n; i++) if (i !== sel.page) objects.push({ ...sel, id: nextId++, page: i });
        toast(`Copied to all ${n} pages.`);
      } }, "Place on every page"));
    }
  }
  function addText(text) {
    const o = { id: nextId++, page: cur, type: "text", text, x: 60, y: 60, w: 60, h: 18, size: 14, color: "#111111", font: "helvetica", bold: false };
    objects.push(o);
    select(o);
  }

  function signatureMaker() {
    let tab = "draw";
    const wrap = h("div", { class: "panel", style: "padding:12px;box-shadow:none" });
    const kindSel = h("select", {}, h("option", { value: "signature" }, "Signature"), h("option", { value: "initials" }, "Initials"));
    const colorSel = h("select", {}, [["#0d2a8a", "Blue"], ["#111111", "Black"], ["#b71c1c", "Red"]].map(([v, l]) => h("option", { value: v }, l)));
    colorSel.value = style.sigColor;
    const body = h("div", {});
    const tabs = h("div", { class: "tabs" }, ["draw", "type", "upload"].map((t) =>
      h("button", { type: "button", "aria-pressed": String(t === tab), onclick: () => { tab = t; tabs.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b.textContent.toLowerCase() === t))); paint(); } }, t[0].toUpperCase() + t.slice(1))));
    let getCanvas = () => null;
    function paint() {
      body.innerHTML = "";
      if (tab === "draw") {
        const c = h("canvas", { class: "sigpad" });
        body.append(c, h("p", { class: "help" }, "Sign with your mouse, finger or stylus."));
        requestAnimationFrame(() => {
          const r = c.getBoundingClientRect();
          c.width = r.width * 2; c.height = r.height * 2;
          const cx = c.getContext("2d");
          cx.lineCap = cx.lineJoin = "round";
          cx.lineWidth = 5;
          let last = null;
          c.onpointerdown = (e) => { c.setPointerCapture(e.pointerId); last = [e.offsetX * 2, e.offsetY * 2]; };
          c.onpointermove = (e) => {
            if (!last) return;
            cx.strokeStyle = colorSel.value;
            const p = [e.offsetX * 2, e.offsetY * 2];
            cx.lineWidth = 3 + 4 * (e.pressure || 0.5);
            cx.beginPath(); cx.moveTo(...last); cx.lineTo(...p); cx.stroke();
            last = p;
          };
          c.onpointerup = () => (last = null);
        });
        getCanvas = () => c;
      } else if (tab === "type") {
        const input = h("input", { type: "text", placeholder: "Type your name", value: store.get("name", "") });
        const fonts = ["'Segoe Script','Brush Script MT','Snell Roundhand',cursive", "'Lucida Handwriting','Apple Chancery',cursive", "'Bradley Hand','Comic Sans MS',cursive", "Georgia,serif"];
        let font = fonts[0];
        const previews = h("div", { class: "radios" });
        const draw = () => {
          previews.innerHTML = "";
          fonts.forEach((f) => {
            const r = h("input", { type: "radio", name: "sigfont" });
            r.checked = f === font;
            r.onchange = () => (font = f);
            previews.append(h("label", {}, r, h("span", { style: { fontFamily: f, fontSize: "24px", color: colorSel.value } }, input.value || "Your name")));
          });
        };
        input.oninput = draw;
        colorSel.onchange = draw;
        draw();
        body.append(h("div", { class: "field" }, input), previews);
        getCanvas = () => {
          if (!input.value.trim()) return null;
          store.set("name", input.value.trim());
          const c = document.createElement("canvas");
          const cx = c.getContext("2d");
          cx.font = `96px ${font}`;
          c.width = Math.ceil(cx.measureText(input.value).width + 40); c.height = 150;
          cx.font = `96px ${font}`;
          cx.fillStyle = colorSel.value;
          cx.textBaseline = "middle";
          cx.fillText(input.value, 20, 75);
          return c;
        };
      } else {
        const input = h("input", { type: "file", accept: "image/*" });
        const clean = h("input", { type: "checkbox", checked: true });
        body.append(h("div", { class: "field" }, input), h("label", { class: "check" }, clean, h("span", {}, "Remove white background")));
        let bmp = null;
        input.onchange = async () => { bmp = input.files[0] ? await decodeImage(input.files[0]) : null; };
        getCanvas = () => {
          if (!bmp) return null;
          const c = document.createElement("canvas");
          c.width = bmp.width; c.height = bmp.height;
          const cx = c.getContext("2d");
          cx.drawImage(bmp, 0, 0);
          if (clean.checked) {
            const d = cx.getImageData(0, 0, c.width, c.height);
            for (let i = 0; i < d.data.length; i += 4) {
              const l = (d.data[i] + d.data[i + 1] + d.data[i + 2]) / 3;
              if (l > 200) d.data[i + 3] = Math.max(0, 255 - (l - 200) * 4.6);
            }
            cx.putImageData(d, 0, 0);
          }
          return c;
        };
      }
    }
    paint();
    const add = h("button", { class: "btn navy small", type: "button" }, "Save signature");
    add.onclick = () => {
      style.sigColor = colorSel.value;
      const c = getCanvas();
      const trimmed = c && trimCanvas(c);
      if (!trimmed) return toast("Create a signature first.", "error");
      sigs.push({ src: trimmed.toDataURL("image/png"), ratio: trimmed.width / trimmed.height, kind: kindSel.value });
      store.set("signatures", sigs.slice(-8));
      renderSide();
      const s = sigs.at(-1);
      pendingImage = { src: s.src, w: s.kind === "initials" ? 70 : 150, h: (s.kind === "initials" ? 70 : 150) / s.ratio };
      overlay.style.cursor = "copy";
      toast("Now click on the page where it should go.");
    };
    wrap.append(h("div", { class: "toolbar" }, kindSel, colorSel), tabs, body, add);
    return wrap;
  }

  // ---- redaction ---------------------------------------------------------------
  function redactPanel() {
    side.append(h("h2", {}, "Redact"));
    side.append(h("p", { class: "help" }, "Drag on the page to mark areas, or search for text to mark every match. Marked content is permanently removed when you save."));
    setMode("redact");
    const q = h("input", { type: "text", placeholder: "Text to find, e.g. account number" });
    const regex = h("input", { type: "checkbox" });
    const findBtn = h("button", { class: "btn navy small", type: "button" }, "Mark all matches");
    findBtn.onclick = async () => {
      if (!q.value.trim()) return;
      let re;
      try { re = regex.checked ? new RegExp(q.value, "gi") : new RegExp(q.value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"); }
      catch { return toast("That pattern isn't valid.", "error"); }
      const count = await markMatches(re);
      toast(count ? `Marked ${count} match${count > 1 ? "es" : ""}.` : "No matches found.");
      drawObjects(); renderSide();
    };
    const presets = h("div", { class: "toolbar" },
      [["Emails", "[\\w.+-]+@[\\w-]+\\.[\\w.]+"], ["Phone numbers", "\\+?\\d[\\d\\s-]{8,}\\d"], ["Long numbers", "\\b\\d{6,}\\b"]].map(([l, p]) =>
        h("button", { class: "btn ghost small", type: "button", onclick: () => { q.value = p; regex.checked = true; findBtn.click(); } }, l)));
    side.append(h("div", { class: "field" }, q), h("label", { class: "check" }, regex, h("span", {}, "Regular expression")), findBtn,
      h("p", { class: "help", style: "margin-top:12px" }, "Quick patterns:"), presets);
    const marks = objects.filter((o) => o.type === "redact").length;
    side.append(h("p", { class: "note", style: "margin-top:12px" }, `${marks} area${marks === 1 ? "" : "s"} marked. Pages with marks are flattened into images so the hidden text can't be recovered.`));
    if (marks) side.append(h("button", { class: "btn ghost small", type: "button", onclick: () => { objects = objects.filter((o) => o.type !== "redact"); drawObjects(); renderSide(); } }, "Clear all marks"));
  }

  const measureCx = document.createElement("canvas").getContext("2d");
  async function markMatches(re) {
    let count = 0;
    for (let i = 0; i < n; i++) {
      const page = await pdf.getPage(i + 1);
      const vp = page.getViewport({ scale: 1 });
      const tc = await page.getTextContent();
      for (const it of tc.items) {
        if (!it.str) continue;
        // proportional offsets within the item, measured with a matching font
        measureCx.font = `100px ${tc.styles[it.fontName]?.fontFamily || "sans-serif"}`;
        const full = measureCx.measureText(it.str).width || 1;
        const at = (k) => (it.width * measureCx.measureText(it.str.slice(0, k)).width) / full;
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(it.str))) {
          if (!m[0].length) { re.lastIndex++; continue; }
          const t = it.transform;
          const fh = Math.hypot(t[2], t[3]) || 10;
          const ux = t[0] / (Math.hypot(t[0], t[1]) || 1), uy = t[1] / (Math.hypot(t[0], t[1]) || 1);
          const a = at(m.index) - fh * 0.15, b = at(m.index + m[0].length) + fh * 0.15;
          // corners in PDF space: along the baseline, then up by the font height
          const pts = [[a, -0.25 * fh], [b, -0.25 * fh], [a, fh * 0.95], [b, fh * 0.95]].map(([s, up]) =>
            vp.convertToViewportPoint(t[4] + ux * s - uy * up, t[5] + uy * s + ux * up));
          const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
          objects.push({ id: nextId++, page: i, type: "redact", x: Math.min(...xs) - 1, y: Math.min(...ys) - 1, w: Math.max(...xs) - Math.min(...xs) + 2, h: Math.max(...ys) - Math.min(...ys) + 2 });
          count++;
        }
      }
    }
    return count;
  }

  // ---- crop ------------------------------------------------------------------
  function cropPanel() {
    side.append(h("h2", {}, "Crop"));
    side.append(h("p", { class: "help" }, "Drag the box or its corners to choose the area to keep."));
    side.append(h("label", { class: "check" }, cropAll, h("span", {}, "Apply to all pages")));
    side.append(h("button", { class: "btn ghost small", type: "button", onclick: autoTrim }, "✂ Auto-trim white margins"));
    side.append(h("button", { class: "btn ghost small", type: "button", style: "margin-left:6px", onclick: () => { crop = null; drawObjects(); } }, "Reset"));
    if (crop) {
      const s = sizes[cur];
      side.append(h("p", { class: "note", style: "margin-top:12px" },
        `Margins (pt): top ${crop.y.toFixed(0)}, left ${crop.x.toFixed(0)}, right ${(s.w - crop.x - crop.w).toFixed(0)}, bottom ${(s.h - crop.y - crop.h).toFixed(0)}`));
    }
  }
  function drawCrop() {
    const s = sizes[cur];
    if (!crop) crop = { x: s.w * 0.05, y: s.h * 0.05, w: s.w * 0.9, h: s.h * 0.9 };
    const box = h("div", { class: "crop-box" });
    const place = () => Object.assign(box.style, { left: px(crop.x), top: px(crop.y), width: px(crop.w), height: px(crop.h) });
    place();
    const corners = [["nw", 0, 0], ["ne", 1, 0], ["sw", 0, 1], ["se", 1, 1]];
    for (const [k, cx, cy] of corners) {
      const dot = h("i", { "data-c": k, style: { left: cx ? "auto" : "-8px", right: cx ? "-8px" : "auto", top: cy ? "auto" : "-8px", bottom: cy ? "-8px" : "auto", cursor: k + "-resize" } });
      box.append(dot);
    }
    box.addEventListener("pointerdown", (ev) => {
      ev.stopPropagation();
      const c = ev.target.dataset.c;
      const sx = ev.clientX, sy = ev.clientY, st = { ...crop };
      const mv = (m) => {
        const dx = (m.clientX - sx) / scale, dy = (m.clientY - sy) / scale;
        if (!c) { crop.x = clamp(st.x + dx, 0, s.w - st.w); crop.y = clamp(st.y + dy, 0, s.h - st.h); }
        else {
          if (c.includes("w")) { crop.x = clamp(st.x + dx, 0, st.x + st.w - 10); crop.w = st.w + st.x - crop.x; }
          if (c.includes("e")) crop.w = clamp(st.w + dx, 10, s.w - st.x);
          if (c.includes("n")) { crop.y = clamp(st.y + dy, 0, st.y + st.h - 10); crop.h = st.h + st.y - crop.y; }
          if (c.includes("s")) crop.h = clamp(st.h + dy, 10, s.h - st.y);
        }
        place();
      };
      const up = () => { window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", up); renderSide(); };
      window.addEventListener("pointermove", mv);
      window.addEventListener("pointerup", up);
    });
    overlay.append(box);
  }
  async function autoTrim() {
    const page = await pdf.getPage(cur + 1);
    const c = await renderPage(page, 1);
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    let x0 = c.width, y0 = c.height, x1 = 0, y1 = 0;
    for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
      const i = (y * c.width + x) * 4;
      if (d[i] < 245 || d[i + 1] < 245 || d[i + 2] < 245) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
    if (x1 <= x0) return toast("The page looks blank.");
    const pad = 8;
    crop = { x: Math.max(0, x0 - pad), y: Math.max(0, y0 - pad), w: Math.min(sizes[cur].w, x1 + pad) - Math.max(0, x0 - pad), h: Math.min(sizes[cur].h, y1 + pad) - Math.max(0, y0 - pad) };
    drawObjects(); renderSide();
  }
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  // ---- saving -----------------------------------------------------------------
  async function save() {
    try {
      if (kind === "redact" && !objects.some((o) => o.type === "redact")) return toast("Mark something to redact first.", "error");
      if (kind === "sign" && !objects.length) return toast("Place a signature on the page first.", "error");
      const result = await withBusy("Saving…", async (ctx) => {
        const doc = await loadPdf(bytes);
        if (kind === "crop") return applyCrop(doc);
        if (kind === "redact") return applyRedactions(doc, ctx);
        await burnObjects(doc, objects, ctx);
        return doc.save({ useObjectStreams: true });
      });
      const suffix = { edit: "_edited", sign: "_signed", redact: "_redacted", crop: "_cropped" }[kind];
      pdf.destroy();
      done([out(baseName(file.name) + suffix + ".pdf", result)]);
    } catch (e) {
      reportError(e);
    }
  }

  async function applyCrop(doc) {
    const targets = cropAll.checked ? doc.getPages().map((_, i) => i) : [cur];
    const ref = sizes[cur];
    for (const i of targets) {
      const page = doc.getPage(i);
      const v = visual(page);
      // scale the crop proportionally on pages of a different size
      const sx = v.width / ref.w, sy = v.height / ref.h;
      const a = v.map(crop.x * sx, v.height - crop.y * sy), b = v.map((crop.x + crop.w) * sx, v.height - (crop.y + crop.h) * sy);
      const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y), w = Math.abs(a.x - b.x), hh = Math.abs(a.y - b.y);
      page.setCropBox(x, y, w, hh);
      page.setMediaBox(x, y, w, hh);
      page.node.delete(PDFLib.PDFName.of("TrimBox"));
      page.node.delete(PDFLib.PDFName.of("BleedBox"));
      page.node.delete(PDFLib.PDFName.of("ArtBox"));
    }
    return doc.save({ useObjectStreams: true });
  }

  async function applyRedactions(doc, ctx) {
    const byPage = new Map();
    for (const o of objects) if (o.type === "redact") (byPage.get(o.page) || byPage.set(o.page, []).get(o.page)).push(o);
    let k = 0;
    for (const [i, boxes] of byPage) {
      ctx.progress(k++ / byPage.size, `Redacting page ${i + 1}`);
      const page = await pdf.getPage(i + 1);
      const sc = 200 / 72;
      const c = await renderPage(page, sc);
      const cx = c.getContext("2d");
      cx.fillStyle = "#000";
      for (const b of boxes) cx.fillRect(b.x * sc, b.y * sc, b.w * sc, b.h * sc);
      const img = await doc.embedPng(await canvasBytes(c, "image/png"));
      const { w, h: hh } = sizes[i];
      doc.removePage(i);
      const np = doc.insertPage(i, [w, hh]);
      np.drawImage(img, { x: 0, y: 0, width: w, height: hh });
    }
    // other edits (if any) and metadata scrub
    await burnObjects(doc, objects.filter((o) => o.type !== "redact"), ctx);
    doc.setTitle(""); doc.setAuthor(""); doc.setSubject(""); doc.setKeywords([]);
    doc.catalog.delete(PDFLib.PDFName.of("Metadata"));
    return doc.save({ useObjectStreams: true });
  }

  renderSide();
  await show();
}

function trimCanvas(c) {
  const cx = c.getContext("2d");
  const d = cx.getImageData(0, 0, c.width, c.height).data;
  let x0 = c.width, y0 = c.height, x1 = -1, y1 = -1;
  for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
    if (d[(y * c.width + x) * 4 + 3] > 10) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  if (x1 < 0) return null;
  const pad = 6;
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(c.width - 1, x1 + pad); y1 = Math.min(c.height - 1, y1 + pad);
  const o = document.createElement("canvas");
  o.width = x1 - x0 + 1; o.height = y1 - y0 + 1;
  o.getContext("2d").drawImage(c, x0, y0, o.width, o.height, 0, 0, o.width, o.height);
  return o;
}

/** Text a standard font can't encode is drawn as a crisp image instead. */
function textToImage(o) {
  const k = 4;
  const c = document.createElement("canvas");
  const lines = o.text.split("\n");
  c.width = Math.ceil(o.w * k) + 4; c.height = Math.ceil(o.h * k) + 4;
  const cx = c.getContext("2d");
  cx.font = `${o.bold ? "bold " : ""}${o.size * k}px ${FONTS[o.font].css}`;
  cx.fillStyle = o.color;
  cx.textBaseline = "alphabetic";
  lines.forEach((l, i) => cx.fillText(l, 0, (FONTS[o.font].base + i * 1.15) * o.size * k));
  return c;
}

export async function burnObjects(doc, objects, ctx) {
  const fonts = {};
  const font = async (f, bold) => (fonts[f + bold] ||= await doc.embedFont(FONTS[f].std[bold ? 1 : 0]));
  const images = new Map();
  for (const o of objects) {
    const page = doc.getPage(o.page);
    const v = visual(page);
    const bl = (x, y) => v.map(x, v.height - y); // visual top-left coords → PDF
    if (o.type === "text") {
      if (!o.text.trim()) continue;
      const f = await font(o.font, o.bold);
      let encodable = true;
      try { f.encodeText(o.text.replace(/\n/g, "")); } catch { encodable = false; }
      if (!encodable) {
        const c = textToImage(o);
        const img = await doc.embedPng(await canvasBytes(c, "image/png"));
        const p = bl(o.x, o.y + c.height / 4);
        page.drawImage(img, { x: p.x, y: p.y, width: c.width / 4, height: c.height / 4, rotate: v.rotate });
        continue;
      }
      o.text.split("\n").forEach((line, i) => {
        const p = bl(o.x, o.y + (FONTS[o.font].base + i * 1.15) * o.size);
        page.drawText(winAnsiSafe(f, line), { x: p.x, y: p.y, size: o.size, font: f, color: hexToRgb(o.color), rotate: v.rotate });
      });
    } else if (o.type === "image") {
      if (!images.has(o.src)) {
        const b64 = o.src.split(",")[1];
        const raw = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
        images.set(o.src, /^data:image\/jpe?g/.test(o.src) ? await doc.embedJpg(raw) : /^data:image\/png/.test(o.src) ? await doc.embedPng(raw) : await embedViaCanvas(doc, o.src));
      }
      const p = bl(o.x, o.y + o.h);
      page.drawImage(images.get(o.src), { x: p.x, y: p.y, width: o.w, height: o.h, rotate: v.rotate });
    } else if (o.type === "rect" || o.type === "whiteout" || o.type === "highlight") {
      const p = bl(o.x, o.y + o.h);
      const opts = { x: p.x, y: p.y, width: o.w, height: o.h, rotate: v.rotate };
      if (o.type === "whiteout") page.drawRectangle({ ...opts, color: rgb(1, 1, 1) });
      else if (o.type === "highlight") page.drawRectangle({ ...opts, color: rgb(1, 0.9, 0), opacity: 0.45, blendMode: PDFLib.BlendMode.Multiply });
      // the CSS border is drawn inside the box; pdf-lib centers it on the edge
      else page.drawRectangle({ ...insetRect(bl, o, v), color: o.fill ? hexToRgb(o.fill) : undefined, borderColor: o.stroke ? hexToRgb(o.color) : undefined, borderWidth: o.stroke || 0 });
    } else if (o.type === "ellipse") {
      const c = bl(o.x + o.w / 2, o.y + o.h / 2);
      const inset = (o.stroke || 0) / 2;
      page.drawEllipse({ x: c.x, y: c.y, xScale: Math.max(1, o.w / 2 - inset), yScale: Math.max(1, o.h / 2 - inset), rotate: v.rotate,
        color: o.fill ? hexToRgb(o.fill) : undefined, borderColor: o.stroke ? hexToRgb(o.color) : undefined, borderWidth: o.stroke || 0 });
    } else if (o.type === "path") {
      const sx = o.w / o.w0, sy = o.h / o.h0;
      const d = o.points.map((p, i) => `${i ? "L" : "M"}${(p[0] * sx).toFixed(2)} ${(p[1] * sy).toFixed(2)}`).join(" ");
      const p = bl(o.x, o.y);
      page.drawSvgPath(d, { x: p.x, y: p.y, borderColor: hexToRgb(o.color), borderWidth: o.stroke, borderLineCap: PDFLib.LineCapStyle.Round, rotate: v.rotate });
    }
  }
}

function insetRect(bl, o, v) {
  const s = (o.stroke || 0) / 2;
  const p = bl(o.x + s, o.y + o.h - s);
  return { x: p.x, y: p.y, width: Math.max(0, o.w - 2 * s), height: Math.max(0, o.h - 2 * s), rotate: v.rotate };
}

async function embedViaCanvas(doc, src) {
  const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
  const c = document.createElement("canvas");
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  c.getContext("2d").drawImage(img, 0, 0);
  return doc.embedPng(await canvasBytes(c, "image/png"));
}
