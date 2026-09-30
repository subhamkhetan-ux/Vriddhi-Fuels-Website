/* Cloud (in-browser) runtime for the Bank / IOCL / Fleet -> Tally tools.
 *
 * Each tool's page is the same index.html the Mac app serves. On the Mac its
 * fetch("/api/...") calls go to a small local Python server; here this script
 * starts Python in the browser (Pyodide), loads that same server code
 * (app.zip) and answers those calls itself — so every feature works the same,
 * and statements / PADs / invoices never leave this device.
 *
 *  - /api/* fetches        -> vf_cloud.call(app, method, path, body)
 *  - <a href="/download/*"> -> same, saved as a file download
 *  - mappings, settings, uploaded master.xml -> IndexedDB (per browser/device);
 *    "Backup / Restore" moves them between devices (or from the Mac app).
 */
(function () {
  "use strict";
  const me = document.currentScript;
  const APP = me.dataset.app;                         // bank_tally | iocl_tally | fleet_tally
  const BUILD = me.dataset.build || "";
  const BASE = new URL(".", me.src).href;             // …/tally-tools/
  const STATE = "/vf_state", CODE = "/home/pyodide/vf", INVOICES = "/tmp/vf_invoices";
  const realFetch = window.fetch.bind(window);
  let py = null, callJs = null;

  // ---------- status banner ----------
  const css = `
  #vfBoot{position:fixed;left:16px;bottom:16px;z-index:50;max-width:min(420px,calc(100vw - 32px));
    background:rgba(24,20,18,.9);color:#F5F0EB;border:1px solid rgba(255,255,255,.14);border-radius:14px;
    padding:10px 14px;font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
    backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px);box-shadow:0 18px 40px -20px #000}
  #vfBoot.err{border-color:#FF6B5E;color:#ffd0cb}
  #vfBoot .spin{display:inline-block;width:12px;height:12px;border:2px solid #fff6;border-top-color:#FF7A1A;
    border-radius:50%;animation:vfsp .7s linear infinite;vertical-align:-2px;margin-right:7px}
  @keyframes vfsp{to{transform:rotate(360deg)}}
  .vfCloud{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-left:auto}
  .vfPill{font-size:11px;font-weight:700;padding:4px 10px;border-radius:999px;border:1px solid rgba(255,255,255,.38);
    background:rgba(255,255,255,.18);color:#fff;white-space:nowrap}
  .vfInv{margin-top:12px;padding:12px;border:1px dashed rgba(255,255,255,.18);border-radius:12px}
  @media(max-width:640px){.vfPill{display:none}}`;
  function banner(html, err) {
    let b = document.getElementById("vfBoot");
    if (!b) {
      if (!document.body) { document.addEventListener("DOMContentLoaded", () => banner(html, err)); return; }
      b = document.createElement("div"); b.id = "vfBoot"; document.body.appendChild(b);
    }
    b.className = err ? "err" : ""; b.innerHTML = html; b.hidden = !html;
  }
  const st = document.createElement("style"); st.textContent = css; document.head.appendChild(st);

  // ---------- boot ----------
  function loadScript(src) {
    return new Promise((res, rej) => {
      const s = document.createElement("script"); s.src = src; s.onload = res;
      s.onerror = () => rej(new Error("could not load " + src)); document.head.appendChild(s);
    });
  }
  function syncfs(populate) {
    return new Promise((res, rej) => py.FS.syncfs(populate, e => (e ? rej(e) : res())));
  }
  async function boot() {
    const step = t => banner(`<span class="spin"></span>${t}`);
    step("Starting the Tally engine in your browser…");
    const meta = await (await realFetch(BASE + "build.json?v=" + BUILD)).json();
    const cdn = `https://cdn.jsdelivr.net/pyodide/v${meta.pyodide}/full/`;
    await loadScript(cdn + "pyodide.js");
    py = await window.loadPyodide({ indexURL: cdn });
    const pkgs = ["micropip", "xlrd"].concat(APP === "iocl_tally" ? ["pymupdf"] : []);
    step(APP === "iocl_tally" ? "Loading the PDF reader (first visit ~20 MB, then cached)…"
                              : "Loading the spreadsheet readers…");
    await py.loadPackage(pkgs);
    const micropip = py.pyimport("micropip");
    await micropip.install.callKwargs(meta.wheels.map(w => BASE + "wheels/" + w), { deps: false });
    step("Loading your saved mappings…");
    py.FS.mkdirTree(STATE);
    py.FS.mount(py.FS.filesystems.IDBFS, {}, STATE);
    await syncfs(true);
    const zip = await (await realFetch(BASE + "app.zip?v=" + BUILD)).arrayBuffer();
    py.unpackArchive(zip, "zip", { extractDir: CODE });
    py.runPython(`import sys\nif ${JSON.stringify(CODE)} not in sys.path: sys.path.insert(0, ${JSON.stringify(CODE)})\n` +
                 `import vf_cloud\nvf_cloud.setup(${JSON.stringify(APP)})`);
    callJs = py.pyimport("vf_cloud").call_js;
    banner("");
  }
  const ready = boot().catch(e => {
    console.error(e);
    banner(`⚠ The Tally engine could not start: ${String(e.message || e)}<br>` +
           `Check the internet connection and reload the page.`, true);
    throw e;
  });

  // ---------- request bridge ----------
  async function pyCall(method, path, body) {
    await ready;
    await new Promise(r => setTimeout(r, 25));          // let the page paint its spinner first
    const t = callJs(APP, method, path, body || "");
    let out;
    try {
      const [code, ctype, headers, raw] = t.toJs();
      const bytes = raw instanceof Uint8Array ? raw.slice()
        : (raw && raw.toJs ? raw.toJs() : new Uint8Array(raw || []));
      if (raw && raw.destroy) raw.destroy();
      out = { code, ctype, headers: JSON.parse(headers), body: bytes };
    } finally { t.destroy(); }
    if (method !== "GET") await syncfs(false).catch(e => console.warn("save failed", e));
    return out;
  }
  window.fetch = async function (input, init) {
    if (typeof input === "string" && /^\/(api|download)\//.test(input)) {
      const method = ((init && init.method) || "GET").toUpperCase();
      let body = init && init.body != null ? String(init.body) : "";
      // IOCL: the Mac app reads invoices from a folder path; here they're the
      // PDFs added on this page (see addInvoiceUpload), wherever the path says.
      if (APP === "iocl_tally" && input.split("?")[0] === "/api/run" && body) {
        try { const j = JSON.parse(body); j.invoices_dir = INVOICES; body = JSON.stringify(j); } catch (_) {}
      }
      const r = await pyCall(method, input, body);
      return new Response(r.body, { status: r.code, headers: { "Content-Type": r.ctype } });
    }
    return realFetch(input, init);
  };

  // Downloads: the pages link to /download/...; answer them here as a file save.
  document.addEventListener("click", async e => {
    const a = e.target.closest && e.target.closest("a[href]");
    if (!a) return;
    const href = a.getAttribute("href") || "";
    if (!/^\/download\//.test(href)) return;
    e.preventDefault();
    try {
      const r = await pyCall("GET", href, "");
      if (r.code !== 200) { alert(new TextDecoder().decode(r.body) || "Nothing to download yet — generate first."); return; }
      const m = /filename="([^"]+)"/.exec(r.headers["Content-Disposition"] || "");
      const name = m ? m[1] : href.split("?")[0].split("/").pop();
      saveBlob(new Blob([r.body], { type: r.ctype }), name);
    } catch (err) { alert("Download failed: " + (err.message || err)); }
  }, true);
  // (.btn sets display, which beats the [hidden] attribute — toggle inline.)
  function show(el, on) { if (el) el.style.display = on ? "" : "none"; }
  function saveBlob(blob, name) {
    const url = URL.createObjectURL(blob), a = document.createElement("a");
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  // ---------- page additions (cloud-only) ----------
  document.addEventListener("DOMContentLoaded", () => {
    // Header: where it runs + settings backup / restore.
    const header = document.querySelector("header");
    if (header) {
      const box = document.createElement("div"); box.className = "vfCloud";
      box.innerHTML = `<span class="vfPill" title="Files are read in this browser and never uploaded">☁ Runs in your browser</span>
        <button class="btn sm" id="vfBackup" title="Download this device's mappings & settings">⬇ Backup</button>
        <button class="btn sm" id="vfRestore" title="Load a backup, or a data.json from the Mac app">⇪ Restore</button>
        <input type="file" id="vfRestoreFile" accept=".json,application/json" hidden>`;
      const spacer = header.querySelector(".spacer");
      if (spacer) spacer.remove();
      header.appendChild(box);
      box.querySelector("#vfBackup").onclick = async () => {
        await ready;
        const text = py.pyimport("vf_cloud").export_state();
        const d = new Date(), ymd = d.toISOString().slice(0, 10);
        saveBlob(new Blob([text], { type: "application/json" }), `tally-tools-backup-${ymd}.json`);
      };
      const fi = box.querySelector("#vfRestoreFile");
      box.querySelector("#vfRestore").onclick = () => fi.click();
      fi.onchange = async () => {
        const f = fi.files[0]; if (!f) return;
        try {
          await ready;
          const text = await f.text();
          const vc = py.pyimport("vf_cloud");
          const written = vc.import_state(text, APP).toJs();
          await syncfs(false);
          alert(`Restored: ${written.join(", ") || "nothing"}.\nThe page will reload.`);
          location.reload();
        } catch (err) { alert("Could not restore: " + (err.message || err)); }
        fi.value = "";
      };
    }
    if (APP === "iocl_tally") addInvoiceUpload();
  });

  // IOCL purchases need their invoice PDFs. The Mac app reads a folder; here you
  // add the PDFs (or a whole folder on a computer) and they're read in-browser.
  function addInvoiceUpload() {
    const anchor = document.getElementById("fileInput");
    const btn = document.getElementById("settingsBtn");
    if (btn) show(btn, false);                           // no folder path in the cloud
    if (!anchor) return;
    const box = document.createElement("div"); box.className = "vfInv";
    box.innerHTML = `<b>Invoice PDFs for the purchases</b>
      <div class="hint" style="margin:4px 0 8px">Add the month's IOCL invoice PDFs so fuel purchases can be generated.
        Without them purchases are listed as waiting and everything else still generates.</div>
      <div class="row" style="margin-top:0">
        <button class="btn" id="vfInvBtn">📄 Add invoice PDFs</button>
        <button class="btn" id="vfInvDirBtn">📁 Add a folder</button>
        <button class="btn sm ghost" id="vfInvClear" style="display:none">Clear</button>
        <span class="hint" id="vfInvStatus" style="margin:0">none added</span>
      </div>
      <input type="file" id="vfInvFiles" accept="application/pdf,.pdf" multiple hidden>
      <input type="file" id="vfInvDir" webkitdirectory multiple hidden>`;
    anchor.after(box);
    if (!("webkitdirectory" in document.createElement("input"))) show(box.querySelector("#vfInvDirBtn"), false);
    let n = 0;
    const status = () => {
      box.querySelector("#vfInvStatus").textContent = n ? `${n} invoice PDF(s) ready` : "none added";
      show(box.querySelector("#vfInvClear"), n > 0);
    };
    async function add(list) {
      const pdfs = [...list].filter(f => /\.pdf$/i.test(f.name));
      if (!pdfs.length) { alert("No PDF files in that selection."); return; }
      box.querySelector("#vfInvStatus").textContent = "Reading…";
      await ready;
      py.FS.mkdirTree(INVOICES);
      for (const f of pdfs) {
        const safe = f.name.replace(/[\/\\]/g, "_");
        if (!py.FS.analyzePath(`${INVOICES}/${safe}`).exists) n++;
        py.FS.writeFile(`${INVOICES}/${safe}`, new Uint8Array(await f.arrayBuffer()));
      }
      status();
    }
    const fFiles = box.querySelector("#vfInvFiles"), fDir = box.querySelector("#vfInvDir");
    box.querySelector("#vfInvBtn").onclick = () => fFiles.click();
    box.querySelector("#vfInvDirBtn").onclick = () => fDir.click();
    fFiles.onchange = () => { add(fFiles.files); fFiles.value = ""; };
    fDir.onchange = () => { add(fDir.files); fDir.value = ""; };
    box.querySelector("#vfInvClear").onclick = async () => {
      await ready;
      if (py.FS.analyzePath(INVOICES).exists)
        for (const f of py.FS.readdir(INVOICES)) if (f !== "." && f !== "..") py.FS.unlink(`${INVOICES}/${f}`);
      n = 0; status();
    };
  }
})();
