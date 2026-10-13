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
  let monitorDirty = false;     // don't overwrite live settings being edited

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

  const isLive = () => state?.live?.state === "live";

  function renderStatus() {
    const busy = state.busy;
    const connecting = state.live && !isLive();
    $("go").disabled = $("goDec").disabled = Boolean(busy) || Boolean(connecting);
    $("upAll").disabled = Boolean(busy);
    const last = state.last || {};
    if (busy) {
      const what = { "live read": "Reading the live session", "connecting for live monitoring": "Connecting for live monitoring",
        decantation: "Reading the tanks for decantation", upload: "Uploading" }[busy.what] || "Connecting to the automation PC";
      setStatus("status", `${what}… (started ${ago(busy.since)}). ${isLive() ? "" : "Connecting takes about a minute."}`);
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
    if (last.proof) notes.push(last.proof.ok ? `Proof picture of Tank ${last.proof.tanks.join(", ")} saved for today's result pictures.`
      : `Proof picture not saved: ${last.proof.message}`);
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
      const save = el("button", "up save", "Save image");
      save.addEventListener("click", () => saveImage([no]));
      const up = el("button", "up", "Upload");
      up.disabled = Boolean(state.busy) || info.confidence === "low";
      up.addEventListener("click", () => upload([no]));
      const acts = el("span", "acts");
      acts.append(save, up);
      head.appendChild(acts);
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
    // One picture of the tanks picked above (as shown), and one per tank.
    $("saveAll").hidden = sel.length < 2;
    $("saveAll").textContent = sel.length === allTanks().length ? "Save image of all tanks" : "Save image of these tanks";
    // Fetch the pictures now: a phone only opens its share sheet straight from a tap.
    for (const tanks of [...sel.map((n) => [n]), ...(sel.length > 1 ? [sel] : [])]) image(tanks).catch(() => {});
  }

  // ---- pictures to save or send ----------------------------------------
  const images = new Map();      // "at|tanks" -> Promise<Blob>
  const allTanks = () => Object.keys(state?.last?.tanks || {}).map(Number).sort();
  const shownTanks = () => [...picked].sort().filter((n) => state?.last?.tanks?.[n]);
  function image(tanks) {
    const at = state.last.at;
    const key = `${at}|${tanks.join(",")}`;
    if (!images.has(key)) {
      images.set(key, fetch(`/api/picture?tanks=${tanks.join(",")}&grid=1&v=${encodeURIComponent(at)}`, { credentials: "same-origin" })
        .then((r) => { if (!r.ok) throw new Error("The picture isn't available."); return r.blob(); }));
      images.get(key).catch(() => images.delete(key));
    }
    return images.get(key);
  }
  function fileName(tanks) {
    const at = state.last.at || "";             // "2026-10-13T19:28:10+05:30", the PC's IST
    const stamp = `${at.slice(0, 10)} ${at.slice(11, 16).replace(":", "-")}`;
    const what = tanks.length === allTanks().length && tanks.length > 1 ? "all tanks"
      : tanks.map((n) => tankName(n).replace(" · ", " ").replace(/[()]/g, "")).join(", ");
    return `Tank stock ${what} ${stamp}.png`;
  }
  async function saveImage(tanks) {
    try {
      const blob = await image(tanks);
      const name = fileName(tanks);
      const file = new File([blob], name, { type: "image/png" });
      if (navigator.canShare?.({ files: [file] })) {
        try { await navigator.share({ files: [file], title: name }); return; } catch (e) { if (e.name === "AbortError") return; }
      }
      const a = el("a");
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    } catch (e) {
      setStatus("upStatus", e.message, true);
    }
  }

  function renderLive() {
    const live = state.live;
    const prev = state.live_last || {};
    $("liveStart").hidden = Boolean(live);
    $("liveStop").hidden = !live;
    $("liveStart").disabled = Boolean(state.busy);
    let text, err = false;
    if (live && !isLive()) {
      text = "Connecting… (about a minute)";
    } else if (live) {
      text = `Live since ${when(live.connected || live.since)}: Tank ${live.tanks.join(", ")}, every ${live.interval_s} s`
        + `${live.auto_upload ? ", sending figures to decant" : ""}. ${live.reads} read${live.reads === 1 ? "" : "s"}`
        + `${live.last_read ? `, last ${clock(live.last_read)}` : ""}${live.read_s ? ` (a read takes ${live.read_s} s)` : ""}.`;
      if (live.last_error) { text += ` Last problem: ${live.last_error}`; err = true; }
    } else if (prev.ended) {
      text = `Off. Last session ${when(prev.since)} → ${when(prev.ended)} (${prev.lasted}, ${prev.reads} read${prev.reads === 1 ? "" : "s"}): ${prev.reason}.`;
    } else {
      text = "Off.";
    }
    setStatus("liveState", text, err);
    renderLiveFigures(live);
    renderLog(live ? live.log : prev.log, Boolean(live || prev.ended));
    if (["Starting…", "Stopping…"].includes($("mStatus").textContent) && (live ? isLive() : true)) setStatus("mStatus", "");
    $("sub").textContent = live ? (isLive() ? "Live monitoring is on." : "Connecting for live monitoring…")
      : "On demand: nothing connects until you ask.";
    if (monitorDirty) return;
    const s = state.settings;
    $("mEvery").value = s.interval_s;
    $("mEvery").min = state.limits.interval_s[0];
    $("mEvery").max = state.limits.interval_s[1];
    $("mUp").checked = s.auto_upload;
    watched = new Set(s.tanks);
    chips($("mTanks"), watched, () => { monitorDirty = true; });
  }

  const clock = (iso) => (iso ? new Date(iso).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", second: "2-digit", timeZone: "Asia/Kolkata" }) : "");

  // While live: each watched tank's latest stock (numbers only, no pictures).
  function renderLiveFigures(live) {
    const box = $("liveFigures");
    box.textContent = "";
    if (!live || !isLive()) return;
    for (const no of live.tanks) {
      const f = live.figures?.[no];
      const tank = el("div", "tank");
      const head = el("div", "tank-head");
      head.appendChild(el("strong", "", tankName(no)));
      if (f?.confidence) head.appendChild(el("span", `badge ${f.confidence}`, BADGE[f.confidence]));
      if (f?.at) head.appendChild(el("span", "note", `read ${clock(f.at)}`));
      tank.appendChild(head);
      const r = f?.reading || {};
      const grid = el("div", "grid");
      for (const [label, value] of [["Stock", r.volume == null ? "–" : fmt(r.volume, 2) + " L"],
        ["Screen time", clock(r.readingAt) || "–"]]) {
        const cell = el("div", "fig");
        cell.appendChild(el("span", "label", label));
        cell.appendChild(el("span", "value", value));
        grid.appendChild(cell);
      }
      tank.appendChild(grid);
      const said = [...(f?.problems || [])];
      const u = live.uploads?.[no];
      if (u) said.push(`Decant (${clock(u.at)}): ${u.message}`);
      if (!f) said.push("Not read yet.");
      if (said.length) tank.appendChild(el("div", "note" + ((f?.problems || []).length || (u && !u.ok) ? " err" : ""), said.join(" · ")));
      box.appendChild(tank);
    }
  }

  // The log: newest first, the stock of each tank at every change.
  function renderLog(log, show) {
    $("liveLog").hidden = !show || !(log || []).length;
    if ($("liveLog").hidden) return;
    const nos = Object.keys(log[log.length - 1]).filter((k) => k !== "at").sort();
    const t = $("logTable");
    t.textContent = "";
    const head = t.insertRow();
    for (const h of ["Time", ...nos.map((n) => `T${n} stock`)]) head.appendChild(el("th", "", h));
    for (const row of [...log].reverse().slice(0, 12)) {
      const tr = t.insertRow();
      tr.insertCell().textContent = clock(row.at);
      for (const n of nos) tr.insertCell().textContent = row[n]?.volume == null ? "–" : fmt(row[n].volume, 2);
    }
  }

  function render() {
    chips($("pick"), picked, () => { keep("ts-picked", [...picked]); renderResult(); });
    renderStatus();
    renderResult();
    renderLive();
  }

  async function refresh() {
    try {
      state = await api("GET", "/api/state");
      render();
    } catch (e) {
      setStatus("status", e.message, true);
    }
  }

  let polling = false;
  async function poll() {
    if (polling) return;
    polling = true;
    try { await refresh(); } finally { polling = false; }
    if (state?.busy || waiting || state?.live) {          // live: the figures as they come
      if (waiting && !state.busy) waiting = false;
      setTimeout(poll, state?.live && !state.busy ? 3000 : 2500);
    }
  }

  async function start(decantation) {
    try {
      await api("POST", "/api/capture", { tanks: [...picked], decantation });
      waiting = true;
      setStatus("status", isLive() ? "Reading the live session…" : "Connecting to the automation PC… This takes about a minute.");
      $("go").disabled = $("goDec").disabled = true;
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
  $("goDec").addEventListener("click", () => start(true));
  $("upAll").addEventListener("click", () => upload([...picked].filter((n) => state?.last?.tanks?.[n])));
  $("saveAll").addEventListener("click", () => saveImage(shownTanks()));
  for (const id of ["mEvery", "mUp"]) $(id).addEventListener("input", () => { monitorDirty = true; });
  const liveSettings = () => ({ interval_s: Number($("mEvery").value), auto_upload: $("mUp").checked, tanks: [...watched] });
  async function send(path, body, done) {
    try {
      await api("POST", path, body);
      monitorDirty = false;
      setStatus("mStatus", done);
      await poll();
    } catch (e) {
      setStatus("mStatus", e.message, true);
    }
  }
  $("mSave").addEventListener("click", () => send("/api/settings", liveSettings(), "Saved."));
  $("liveStart").addEventListener("click", () => send("/api/live/start", liveSettings(), "Starting…"));
  $("liveStop").addEventListener("click", () => send("/api/live/stop", {}, "Stopping…"));

  poll();
  setInterval(() => { if (!waiting && !document.hidden) refresh(); }, 30000);
})();
