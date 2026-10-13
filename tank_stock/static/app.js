// Tank stock page logic. Its own file so the page runs under a strict CSP
// (no inline script). Everything from the server is shown with textContent.
"use strict";
(() => {
  const CSRF = document.querySelector('meta[name="ts-csrf"]').content;
  const $ = (id) => document.getElementById(id);
  const TANKS = [1, 2, 3, 4];
  const NAMES = { MS: "Petrol (MS)", HSD: "Diesel (HSD)", XG: "XtraGreen" };
  const BADGE = { high: "Checked", medium: "Fixed & checked", low: "Please check" };
  let state = null;
  let shownAt = null;           // the capture on screen
  let waiting = false;          // a capture this page started
  let monitorDirty = false;     // don't overwrite settings being edited

  const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
  const keep = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } };
  let picked = new Set(load("ts-picked", TANKS));
  let watched = new Set();

  async function api(method, path, body) {
    const res = await fetch(path, {
      method, credentials: "same-origin",
      headers: { "Content-Type": "application/json", "X-TS-CSRF": CSRF },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `The server answered ${res.status}.`);
    return data;
  }

  const el = (tag, cls = "", text = null) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== null) e.textContent = text;
    return e;
  };
  const fmt = (v, d = 2) => (v === null || v === undefined ? "–" : Number(v).toLocaleString("en-IN", { minimumFractionDigits: d, maximumFractionDigits: d }));
  const when = (iso) => (iso ? new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" }) : "");
  const ago = (iso) => {
    if (!iso) return "";
    const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
    return m < 1 ? "just now" : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
  };
  function tankName(no) {
    const p = state?.last?.tanks?.[no]?.product;
    return `Tank ${no}${p ? " · " + (NAMES[p] || p) : ""}`;
  }

  function chips(box, set, onChange) {
    box.textContent = "";
    for (const no of TANKS) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "chip";
      b.textContent = tankName(no);
      b.setAttribute("aria-pressed", set.has(no) ? "true" : "false");
      b.addEventListener("click", () => {
        if (set.has(no) && set.size === 1) return;          // keep at least one
        set.has(no) ? set.delete(no) : set.add(no);
        b.setAttribute("aria-pressed", set.has(no) ? "true" : "false");
        onChange();
      });
      box.appendChild(b);
    }
  }

  function setStatus(id, text, err = false) {
    $(id).textContent = text || "";
    $(id).className = "status" + (err ? " err" : "");
  }

  function renderStatus() {
    const busy = state.busy;
    $("go").disabled = $("goUp").disabled = Boolean(busy);
    $("upAll").disabled = Boolean(busy);
    const last = state.last || {};
    if (busy) {
      setStatus("status", `Connecting to the automation PC… (${busy.what === "monitor" ? "the monitor's run" : "started " + ago(busy.since)}). This takes about a minute.`);
    } else if (last.error && (!last.at || last.error_at > last.at)) {
      setStatus("status", `Last try (${when(last.error_at)}) failed: ${last.error}`, true);
    } else if (!state.login_saved) {
      setStatus("status", "The AnyDesk login isn't on the server yet: in GitHub, run the 'Tank stock' workflow once with mode save-login.", true);
    } else {
      setStatus("status", last.at ? `Last capture ${when(last.at)} (${ago(last.at)}).` : "No capture yet.");
    }
  }

  function renderResult() {
    const last = state.last || {};
    if (!last.at) { $("result").hidden = true; return; }
    $("result").hidden = false;
    const sel = [...picked].sort().filter((n) => last.tanks?.[n]);
    $("resultTitle").textContent = `Capture of ${when(last.at)}`;
    const notes = [`${last.page || ""}`, last.settings_note || ""].filter(Boolean);
    const missing = [...picked].filter((n) => !last.tanks?.[n]);
    if (missing.length) notes.push(`Not on that screen: Tank ${missing.join(", ")}.`);
    $("resultNote").textContent = notes.join(" ");
    // On a phone the cards go one under another, so each stays big enough to read.
    const stack = window.innerWidth < 700 ? 1 : 0;
    const key = `${last.at}|${sel.join(",")}|${stack}`;
    if (sel.length && $("shot").dataset.key !== key) {
      $("shot").src = `/api/picture?tanks=${sel.join(",")}&stack=${stack}&v=${encodeURIComponent(last.at)}`;
      $("shot").dataset.key = key;
    }
    $("shot").hidden = !sel.length;
    const box = $("figures");
    box.textContent = "";
    for (const no of sel) {
      const info = last.tanks[no];
      const r = info.reading || {};
      const tank = el("div", "tank");
      const head = el("div", "tank-head");
      const name = el("strong", "", tankName(no));
      head.appendChild(name);
      if (info.confidence) head.appendChild(el("span", `badge ${info.confidence}`, BADGE[info.confidence]));
      const up = el("button", "up", "Upload");
      up.disabled = Boolean(state.busy) || info.confidence === "low";
      up.addEventListener("click", () => upload([no]));
      head.appendChild(up);
      tank.appendChild(head);
      const grid = el("div", "grid");
      for (const [label, v, d, unit] of [["Stock", r.volume, 2, " L"], ["Ullage", r.ullage, 2, " L"], ["Dip", r.dip, 1, " cm"],
        ["Water", r.water, 0, " L"], ["Temp", r.temp, 1, " °C"], ["Density", r.density, 1, ""]]) {
        const cell = el("div", "fig");
        cell.appendChild(el("span", "label", label));
        cell.appendChild(el("span", "value", v === null || v === undefined ? "–" : fmt(v, d) + unit));
        grid.appendChild(cell);
      }
      tank.appendChild(grid);
      const said = [...(info.problems || [])];
      const u = last.uploads?.[no];
      if (u) said.push(`Decant (${when(u.at)}): ${u.message}`);
      if (said.length) tank.appendChild(el("div", "note" + ((info.problems || []).length || (u && !u.ok) ? " err" : ""), said.join(" · ")));
      box.appendChild(tank);
    }
    shownAt = last.at;
  }

  function renderMonitor() {
    if (monitorDirty) return;
    const s = state.settings;
    $("mOn").checked = s.monitor;
    $("mEvery").value = s.interval_min;
    $("mEvery").min = state.limits.interval_min[0];
    $("mEvery").max = state.limits.interval_min[1];
    $("mUp").checked = s.auto_upload;
    watched = new Set(s.tanks);
    chips($("mTanks"), watched, () => { monitorDirty = true; });
    const m = state.monitor || {};
    const parts = [];
    if (!s.monitor) parts.push("The monitor is off.");
    else if (m.next_run) parts.push(`Next run ${when(m.next_run)}.`);
    if (m.last_run) parts.push(`Last run ${when(m.last_run)}${m.last_error ? ": " + m.last_error : ", fine."}`);
    setStatus("mStatus", parts.join(" "), Boolean(m.last_error));
    $("sub").textContent = s.monitor
      ? `Monitor on: every ${s.interval_min} min, Tank ${s.tanks.join(", ")}${s.auto_upload ? ", uploading to decant" : ""}.`
      : "Monitor off. Capture on demand below.";
  }

  function render() {
    chips($("pick"), picked, () => { keep("ts-picked", [...picked]); renderResult(); });
    renderStatus();
    renderResult();
    renderMonitor();
  }

  async function refresh() {
    try {
      state = await api("GET", "/api/state");
      render();
    } catch (e) {
      setStatus("status", e.message, true);
    }
  }

  async function poll() {
    await refresh();
    if (state?.busy || waiting) {
      if (waiting && !state.busy) waiting = false;
      setTimeout(poll, 2500);
    }
  }

  async function start(upload) {
    try {
      await api("POST", "/api/capture", { tanks: [...picked], upload });
      waiting = true;
      setStatus("status", "Connecting to the automation PC… This takes about a minute.");
      $("go").disabled = $("goUp").disabled = true;
      setTimeout(poll, 1500);
    } catch (e) {
      setStatus("status", e.message, true);
    }
  }

  async function upload(tanks) {
    setStatus("upStatus", "Uploading…");
    try {
      const { results } = await api("POST", "/api/upload", { tanks });
      const lines = Object.entries(results).map(([no, r]) => `Tank ${no}: ${r.message}`);
      setStatus("upStatus", lines.join(" · "), Object.values(results).some((r) => !r.ok));
      await refresh();
    } catch (e) {
      setStatus("upStatus", e.message, true);
    }
  }

  $("go").addEventListener("click", () => start(false));
  $("goUp").addEventListener("click", () => start(true));
  $("upAll").addEventListener("click", () => upload([...picked].filter((n) => state?.last?.tanks?.[n])));
  for (const id of ["mOn", "mEvery", "mUp"]) $(id).addEventListener("input", () => { monitorDirty = true; });
  $("mSave").addEventListener("click", async () => {
    try {
      await api("POST", "/api/settings", {
        monitor: $("mOn").checked, interval_min: Number($("mEvery").value),
        auto_upload: $("mUp").checked, tanks: [...watched],
      });
      monitorDirty = false;
      setStatus("mStatus", "Saved.");
      await refresh();
    } catch (e) {
      setStatus("mStatus", e.message, true);
    }
  });

  poll();
  setInterval(() => { if (!waiting && !document.hidden) refresh(); }, 30000);
})();
