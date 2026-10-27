// Tank stock page logic. Its own file so the page runs under a strict CSP
// (no inline script). Everything from the server is shown with textContent.
"use strict";
(() => {
  const CSRF = document.querySelector('meta[name="ts-csrf"]').content;
  // shown inside the XtraPower app's Tank stock tab: that app has the title bar
  if (window.self !== window.top) document.documentElement.classList.add("embedded");
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
      setStatus("status", "The FuelTrans login isn't saved on the server yet: run infra/fueltrans/tank-stock-setup.sh there.", true);
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
    const notes = [last.settings_note || ""].filter(Boolean);
    if (last.proof) notes.push(last.proof.ok ? `Proof picture of Tank ${last.proof.tanks.join(", ")} saved for today's result pictures.`
      : `Proof picture not saved: ${last.proof.message}`);
    const none = !Object.keys(last.tanks || {}).length;
    const missing = [...picked].filter((n) => !last.tanks?.[n]);
    if (none) notes.push("No tank cards on that screen: this is what the IOCL PC showed (also sent to the XtraPower bot).");
    else if (missing.length) notes.push(`Not found on that screen: Tank ${missing.join(", ")} (the whole screen was sent to the XtraPower bot).`);
    $("resultNote").textContent = notes.join(" · ");
    $("fullScreen").hidden = none || !missing.length;
    $("fullScreen").href = `api/picture?full=1&v=${encodeURIComponent(last.at)}`;
    $("upAll").hidden = none;
    // On a phone the cards go one under another, so each stays big enough to read.
    const stack = window.innerWidth < 700 ? 1 : 0;
    const key = `${last.at}|${sel.join(",")}|${stack}`;
    if (none && $("shot").dataset.key !== `${last.at}|full`) {
      // nothing to crop: the whole screen, so you can see what's wrong on the PC
      $("shot").src = `api/picture?full=1&v=${encodeURIComponent(last.at)}`;
      $("shot").dataset.key = `${last.at}|full`;
    } else if (sel.length && $("shot").dataset.key !== key) {
      $("shot").src = `api/picture?tanks=${sel.join(",")}&stack=${stack}&v=${encodeURIComponent(last.at)}`;
      $("shot").dataset.key = key;
    }
    $("shot").hidden = !sel.length && !none;
    const box = $("figures");
    box.textContent = "";
    for (const no of sel) {
      const info = last.tanks[no];
      const r = info.reading || {};
      const tank = el("div", "tank");
      const head = el("div", "tank-head");
      head.appendChild(el("strong", "", `Tank ${no}`));
      if (info.product) head.appendChild(el("span", `prod ${info.product}`, info.product));
      if (info.confidence) head.appendChild(el("span", `badge ${info.confidence}`, BADGE[info.confidence]));
      const save = el("button", "up save", "Save");
      save.title = "Save this tank's picture";
      save.addEventListener("click", () => saveImage([no]));
      const up = el("button", "up", "Upload");
      up.disabled = Boolean(state.busy) || info.confidence === "low";
      up.addEventListener("click", () => upload([no]));
      const acts = el("span", "acts");
      acts.append(save, up);
      head.appendChild(acts);
      tank.appendChild(head);
      const grid = el("div", "minis");
      for (const [label, v, d, unit] of [["Stock", r.volume, 2, "L"], ["Ullage", r.ullage, 2, "L"], ["Dip", r.dip, 1, "cm"]]) {
        const cell = el("div", "mini");
        const b = el("b", "", v === null || v === undefined ? "–" : fmt(v, d));
        if (v != null) b.appendChild(el("small", "", unit));
        cell.append(el("span", "", label), b);
        grid.appendChild(cell);
      }
      tank.appendChild(grid);
      const more = [r.water != null && `Water ${fmt(r.water, 0)} L`, r.temp != null && `${fmt(r.temp, 1)} °C`,
        r.density != null && `${fmt(r.density, 1)} kg/m³`].filter(Boolean);
      if (more.length) tank.appendChild(el("div", "tk-line", more.join(" · ")));
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
      images.set(key, fetch(`api/picture?tanks=${tanks.join(",")}&grid=1&v=${encodeURIComponent(at)}`, { credentials: "same-origin" })
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
    $("liveStop").hidden = !live || autoActive();       // the automatic decantation needs it
    $("liveStart").disabled = Boolean(state.busy) || !state.login_saved;
    let text, err = false;
    if (live && !isLive()) {
      text = "Connecting… (about a minute)";
    } else if (live) {
      const watch = live.watched || live.tanks;
      const sending = live.sending || (live.auto_upload ? watch : []);
      text = `Live since ${when(live.connected || live.since)}: Tank ${watch.join(", ")}, every ${live.every_s || live.interval_s} s`
        + `${autoActive() ? " (for the automatic decantation)" : ""}`
        + `${sending.length ? `, sending ${sending.length === watch.length ? "the" : `Tank ${sending.join(", ")}'s`} volume to decant` : ""}`
        + `. ${live.reads} read${live.reads === 1 ? "" : "s"}`
        + `${live.last_read ? `, last ${clock(live.last_read)}` : ""}${live.read_s ? ` (a read takes ${live.read_s} s)` : ""}.`;
      if (live.last_error) { text += ` Last problem: ${live.last_error}`; err = true; }
    } else if (prev.ended) {
      text = `Off. Last session ${when(prev.since)} → ${when(prev.ended)} (${prev.lasted}, ${prev.reads} read${prev.reads === 1 ? "" : "s"}): ${prev.reason}.`;
    } else {
      text = "Off.";
    }
    setStatus("liveState", text, err);
    renderSessions(state.sessions);
    renderControl(live, prev);
    if (monitorDirty) return;
    const s = state.settings;
    $("mEvery").value = s.interval_s;
    $("mEvery").min = state.limits.interval_s[0];
    $("mEvery").max = state.limits.interval_s[1];
    $("mUp").checked = s.auto_upload;
    $("mRe").checked = Boolean(s.reconnect);
    $("mReLine").hidden = state.source === "fueltrans";   // (from FuelTrans it always connects again)
    watched = new Set(s.tanks);
    chips($("mTanks"), watched, () => { monitorDirty = true; });
  }

  // The recent live sessions: when, how long, and who or what ended them.
  const span = (s) => {
    if (s == null) return "–";
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    return h ? `${h} h ${m} min` : m ? `${m} min ${s % 60} s` : `${s} s`;
  };
  const BY = { anydesk: "the PC's connection ended it", you: "stopped by you", agent: "ended by the agent", problem: "a problem" };
  function renderSessions(sess) {
    const recent = sess?.recent || [];
    $("sessions").hidden = !recent.length;
    if (!recent.length) return;
    // (how long a session lasts before the connection ends it: only worth
    // showing for a connection that rations them)
    const a = sess.anydesk, rationed = state.source !== "fueltrans";
    $("sessStats").hidden = !rationed;
    $("sessStats").textContent = !rationed ? "" : a
      ? `The connection ended ${a.count} session${a.count === 1 ? "" : "s"} by itself: typically after ${span(a.typical_s)}`
        + ` (shortest ${span(a.shortest_s)}, longest ${span(a.longest_s)}).`
      : "The connection hasn't ended a session by itself yet.";
    const ul = $("sessList");
    ul.textContent = "";
    for (const r of recent) {
      const li = el("li", r.by === "anydesk" ? "warn" : r.by === "problem" ? "ask" : "",
        `${when(r.connected || r.since)}: ${r.lasted_s == null ? "didn't connect" : span(r.lasted_s)} · ${BY[r.by] || r.by}`
        + (r.by === "problem" ? ` (${r.reason})` : ""));
      ul.appendChild(li);
    }
  }

  const clock = (iso) => (iso ? new Date(iso).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", second: "2-digit", timeZone: "Asia/Kolkata" }) : "");

  // ---- the control bar: what the server is doing with the PC right now ----
  let pending = "";             // "Starting…" / "Stopping…" until the server says so
  function renderControl(live, prev) {
    const dot = $("dot");
    dot.className = "dot";
    let text, sub;
    if (autoActive()) {
      text = "Decantation running"; dot.classList.add("auto");
      sub = live && isLive() ? `Live, every ${live.every_s || live.interval_s} s · last read ${clock(live.last_read)}` : "Connecting to the PC…";
    } else if (live && !isLive()) {
      text = "Connecting…"; dot.classList.add("wait"); sub = "FuelTrans on the server: about a minute";
    } else if (live) {
      const watch = live.watched || live.tanks;
      text = "Live"; dot.classList.add("live");
      sub = `Tank ${watch.join(", ")} every ${live.every_s || live.interval_s} s`
        + `${live.last_read ? ` · last read ${clock(live.last_read)}` : ""}`
        + `${(live.sending || []).length || live.auto_upload ? " · sending to decant" : ""}`;
    } else if (state.busy) {
      text = "Reading the tanks…"; dot.classList.add("wait"); sub = `started ${ago(state.busy.since)}`;
    } else {
      text = "On demand";
      sub = !state.login_saved ? "The FuelTrans login isn't saved on the server yet"
        : prev.ended ? `Last live ${when(prev.since)} → ${clock(prev.ended)}: ${prev.reason}` : "Nothing connects until you ask";
    }
    if (live && live.last_error) dot.className = "dot bad";
    $("ctlText").textContent = pending && !(pending === "Starting…" && live && isLive()) && !(pending === "Stopping…" && !live) ? pending : text;
    if ($("ctlText").textContent === text) pending = "";
    $("ctlSub").textContent = sub;
    setStatus("liveErr", live && live.last_error ? `Last problem: ${live.last_error}` : "", true);
  }

  // ---- the four tanks at a glance: the freshest figures of each ----------------
  const COLOUR = { MS: "var(--p-ms)", HSD: "var(--p-hsd)", XG: "var(--p-xg)" };
  function figuresOf(no) {
    const live = state.live;
    const f = live && isLive() ? live.figures?.[no] : null;
    const cap = state.last?.tanks?.[no];
    if (f?.reading?.volume != null) return { r: f.reading, at: f.at, live: true, confidence: f.confidence, problems: f.problems };
    if (cap?.reading?.volume != null) return { r: cap.reading, at: state.last.at, live: false, confidence: cap.confidence, problems: cap.problems };
    return null;
  }
  function renderTanks() {
    const box = $("tanks");
    box.textContent = "";
    const run = autoActive() ? state.auto?.run : null;
    for (const no of TANKS) {
      const f = figuresOf(no);
      const product = state.last?.tanks?.[no]?.product || state.live?.products?.[no] || "";
      const dec = (run?.tanks || []).find((t) => t.no === no && t.stage !== "read");
      const probe = state.live && isLive() ? state.live.probes?.[no] : null;
      const card = el("div", "tk");
      if (dec) card.classList.add("busy");
      else if (probe?.frozen || f?.confidence === "low") card.classList.add("bad");
      else if (f?.live) card.classList.add("live");

      const head = el("div", "tk-head");
      head.appendChild(el("strong", "", `Tank ${no}`));
      if (product) head.appendChild(el("span", `prod ${product}`, product));
      head.appendChild(el("span", `src${f?.live ? " live" : ""}`, f ? (f.live ? "● live" : clock(f.at).replace(/:\d\d(?= |$)/, "")) : "–"));
      card.appendChild(head);

      const body = el("div", "tk-body");
      const r = f?.r || {};
      const capacity = r.capacity || (r.volume != null && r.ullage != null ? r.volume + r.ullage : null);
      const pct = r.volume != null && capacity ? Math.max(0, Math.min(100, (100 * r.volume) / capacity)) : null;
      const gauge = el("div", "gauge");
      const fill = el("i");
      fill.style.height = `${pct ?? 0}%`;
      if (COLOUR[product]) fill.style.setProperty("--fill", COLOUR[product]);
      gauge.append(fill, el("span", "", pct == null ? "–" : `${Math.round(pct)}%`));
      const figs = el("div", "tk-figs");
      const vol = el("div", "tk-vol", r.volume == null ? "–" : fmt(r.volume, 0));
      if (r.volume != null) vol.appendChild(el("small", "", "L"));
      figs.appendChild(vol);
      const room = r.ullage ?? (capacity && r.volume != null ? capacity - r.volume : null);
      figs.appendChild(el("div", "tk-line", room == null ? "no reading yet" : `${fmt(room, 0)} L room`));
      if (capacity) figs.appendChild(el("div", "tk-line", `of ${fmt(capacity, 0)} L`));
      body.append(gauge, figs);
      card.appendChild(body);

      if (dec) {
        const what = { waiting: "Decantation: waiting", decanting: "Decanting", settling: "Settling" }[dec.stage] || dec.stage;
        card.appendChild(el("div", "tk-flag acc", dec.stage === "waiting" ? `${what} for C${dec.chambers.join(", C")}`
          : `${what}${dec.rise != null ? ` · +${fmt(Math.max(0, dec.rise), 0)} L of ${fmt(dec.litres, 0)}` : ""}`));
      }
      if (probe?.frozen) card.appendChild(el("div", "tk-flag warn", `⚠ Card not updating since ${clock(probe.since)}`));
      else if (f?.confidence === "low") card.appendChild(el("div", "tk-flag warn", `Please check: ${(f.problems || []).join(", ") || "not read right"}`));
      else if (f?.confidence === "medium") card.appendChild(el("div", "tk-flag mid", "Fixed & checked"));
      box.appendChild(card);
    }
  }

  // ---- automatic decantation ---------------------------------------------
  // Set up: an invoice, then a tank (or "keep in the truck") for each of its
  // chambers; the server checks the plan as the decant app does. Running: each
  // tank's stage and stock, the chambers in, questions to answer, the log.
  const ACTIVE = ["starting", "running", "paused"];
  const STAGE_NAME = { waiting: "waiting", decanting: "decanting", settling: "settling", read: "done ✓" };
  const kl = (l) => `${(Math.round(l / 100) / 10).toLocaleString("en-IN")} KL`;
  const litres = (v) => (v == null ? "–" : `${fmt(v, 0)} L`);
  let setup = null;             // {options, invoice, plan: {chamber: tank|""}, check}
  let ticks = {};               // a question's / a "done now" box's ticked chambers, kept across polls
  let doneOpen = null;          // the tank whose "Done now" chambers are shown
  const autoActive = () => ACTIVE.includes(state?.auto?.phase);

  async function autoAct(action, body = {}) {
    setStatus("autoStatus", "…");
    try {
      const r = await api("POST", `api/auto/${action}`, body);
      setStatus("autoStatus", "");
      if (r.auto !== undefined) state.auto = r.auto;
      renderAuto();
      poll();
    } catch (e) {
      setStatus("autoStatus", e.message, true);
    }
  }

  function renderAuto() {
    const box = $("autoBody");
    box.textContent = "";
    const a = state?.auto;
    if (a && (ACTIVE.includes(a.phase) || a.run || a.error)) {
      renderRun(box, a);
      if (ACTIVE.includes(a.phase)) return;
      if (!a.run) box.appendChild(ended(a));
    }
    if (!setup) {
      if (!a) {
        box.appendChild(el("div", "note", "Pick the truck's invoice and the chambers' tanks: it reads the stock before, follows "
          + "the chambers in, waits for the stock to settle, reads the stock after and finishes it in the decant app."));
      }
      const row = el("div", "row two");
      const b = el("button", "main", "Start a decantation");
      b.disabled = !state?.login_saved;
      b.addEventListener("click", openSetup);
      row.appendChild(b);
      const more = el("button", "alt", "Carry on from the decant app");
      more.disabled = !state?.login_saved;
      more.addEventListener("click", openTakeover);
      row.appendChild(more);
      box.appendChild(row);
      const prev = state?.auto_last;
      if (!a && prev) {
        const done = { finished: "finished ✓", cancelled: "cancelled", released: "handed over to the decant app", failed: "didn't start" }[prev.phase] || prev.phase;
        box.appendChild(el("div", "lastline", `Last: ${prev.title} · ${done} ${when(prev.at)}`
          + `${(prev.result || []).length ? ` · ${prev.result.map((r) => r.replace(/^(Tank \d+):.*variation ([^ ]+ L) \(([^)]*)\)$/, "$1 $2 ($3)")).join(", ")}` : ""}`));
      }
      return;
    }
    if (setup.mode === "open") renderOpen(box); else renderSetup(box);
  }

  // A decantation started in the decant app (its stock before and chambers
  // set there), followed and finished from here.
  async function openTakeover() {
    setStatus("autoStatus", "Loading the decant app's decantations…");
    try {
      const options = await api("GET", "api/auto/options");
      setup = { mode: "open", options };
      setStatus("autoStatus", (options.open || []).length ? "" : "Nothing is being decanted in the decant app right now.",
        !(options.open || []).length);
      renderAuto();
    } catch (e) {
      setStatus("autoStatus", e.message, true);
    }
  }

  const STAGE = { waiting: "waiting", decanting: "decanting", settling: "settling", read: "stock after read" };
  function renderOpen(box) {
    box.appendChild(el("div", "note", "Carried on from where it is: its stock before and chambers stay the decant app's. "
      + "A waiting tank starts when its stock rises; a decanting one is followed from now; a settling one settles in full "
      + "from now, then its stock after is read and the result saved in the decant app."));
    for (const o of setup.options.open || []) {
      const card = el("div", "tank");
      const head = el("div", "tank-head");
      head.appendChild(el("strong", "", `${o.tt_no || "?"} · invoice ${o.invoice_no || ""}`));
      head.appendChild(el("span", "stage", o.status));
      card.appendChild(head);
      const ul = el("ul", "msgs");
      for (const t of o.tanks) {
        ul.appendChild(el("li", "", `Tank ${t.no}: ${STAGE[t.stage] || t.stage} · C${(t.chambers || []).join(", C")} (${kl(t.litres)})`
          + (t.before != null ? ` · stock before ${litres(t.before)}` : " · no stock before yet (read when taken over)")));
      }
      card.appendChild(ul);
      if (o.byAgent) {
        card.appendChild(el("div", "note", "The decant app shows it run by the tank stock agent, but it isn't running here "
          + "(a restart?): take it over to carry on."));
      }
      const b = el("button", "main", "Take over");
      b.addEventListener("click", async () => { setup = null; await autoAct("takeover", { session_id: o.id }); });
      card.appendChild(b);
      box.appendChild(card);
    }
    const back = el("button", "alt", "Close");
    back.addEventListener("click", () => { setup = null; renderAuto(); });
    box.appendChild(back);
  }

  async function openSetup() {
    setStatus("autoStatus", "Loading the decant app's invoices…");
    try {
      const options = await api("GET", "api/auto/options");
      setup = { options, invoice: options.invoices[0]?.invoice_no || "", plan: {}, check: null };
      pickInvoice(setup.invoice);
      setStatus("autoStatus", options.invoices.length ? "" : "No invoice with chambers still in the truck. Add the invoice's PDF in the decant app first.", !options.invoices.length);
    } catch (e) {
      setStatus("autoStatus", e.message, true);
    }
  }

  function pickInvoice(no) {
    setup.invoice = no;
    const inv = setup.options.invoices.find((i) => i.invoice_no === no);
    setup.plan = {};
    for (const c of inv?.chambers || []) setup.plan[c.no] = inv.plan[c.no] || "";
    checkPlan();
  }

  let checking = 0;
  async function checkPlan() {
    renderAuto();
    if (!setup.invoice) return;
    const mine = ++checking;
    try {
      const chk = await api("POST", "api/auto/check", { invoice_no: setup.invoice, plan: setup.plan });
      if (mine === checking && setup) { setup.check = chk; renderAuto(); }
    } catch (e) {
      if (mine === checking && setup) { setup.check = { blocking: [e.message], warnings: [], perTank: [] }; renderAuto(); }
    }
  }

  function renderSetup(box) {
    const { options } = setup;
    const sel = el("select");
    for (const i of options.invoices) {
      const o = el("option", "", `${i.tt_no || "?"} · ${i.date || ""} ${i.time || ""} · ${i.invoice_no}${i.status === "partial" ? " (rest)" : ""}`);
      o.value = i.invoice_no;
      o.selected = i.invoice_no === setup.invoice;
      sel.appendChild(o);
    }
    sel.addEventListener("change", () => pickInvoice(sel.value));
    box.appendChild(sel);
    const inv = options.invoices.find((i) => i.invoice_no === setup.invoice);
    if (!inv) return;
    box.appendChild(stockTable(options));
    const list = el("div");
    for (const c of inv.chambers) {
      const r = el("div", "plan-row");
      r.appendChild(el("div", "", `C${c.no} · ${c.product} · ${kl(c.litres)}`));
      const seg = el("div", "seg");
      const choices = [...options.tanks.filter((t) => t.product === c.product).map((t) => [t.id, `Tank ${t.no}${t.busy ? " (busy)" : ""}`]), ["", "Keep in truck"]];
      for (const [id, label] of choices) {
        const b = el("button", "", label);
        b.type = "button";
        b.setAttribute("aria-pressed", (setup.plan[c.no] || "") === id ? "true" : "false");
        b.addEventListener("click", () => { setup.plan[c.no] = id; checkPlan(); });
        seg.appendChild(b);
      }
      r.appendChild(seg);
      list.appendChild(r);
    }
    box.appendChild(list);
    const chk = setup.check;
    if (chk) {
      const ul = el("ul", "msgs");
      for (const t of chk.perTank || []) {
        const tk = options.tanks.find((x) => x.id === t.tank);
        ul.appendChild(el("li", "", t.before == null ? `Tank ${t.no}: + ${kl(t.litres)} (no stock in the app yet: it is read at the start)`
          : `Tank ${t.no}: ${litres(t.before)} now (${ago(tk?.readingAt)}) + ${kl(t.litres)} → ${litres(t.after)}, ${litres(t.leftRoom)} room left`));
      }
      for (const b of chk.blocking || []) if (!/^Add Tank/.test(b)) ul.appendChild(el("li", "bad", b));
      for (const w of chk.warnings || []) ul.appendChild(el("li", "warn", w));
      box.appendChild(ul);
    }
    box.appendChild(el("div", "note", `Once a tank's stock stops rising it waits until it has been steady for ${options.settleMinutes} min, then reads the stock after. `
      + "Live monitoring runs meanwhile (every 10 s, all tanks)."));
    const row = el("div", "row");
    const go = el("button", "main", "Start");
    const blocking = (chk?.blocking || []).filter((b) => !/^Add Tank/.test(b));
    go.disabled = !chk || blocking.length > 0 || !Object.values(setup.plan).some(Boolean);
    go.addEventListener("click", async () => {
      const body = { invoice_no: setup.invoice, plan: setup.plan };
      setup = null;
      await autoAct("start", body);
    });
    const back = el("button", "alt", "Close");
    back.addEventListener("click", () => { setup = null; renderAuto(); });
    const planned = [...new Set(Object.values(setup.plan).filter(Boolean))]
      .map((id) => options.tanks.find((t) => t.id === id)?.no).filter(Boolean);
    const img = el("button", "alt", planned.length ? `Tank stock image (Tank ${planned.sort().join(", ")})` : "Tank stock image");
    img.addEventListener("click", () => captureTanks(planned.length ? planned : [...picked]));
    row.append(go, img, back);
    box.appendChild(row);
  }

  function renderRun(box, a) {
    const run = a.run;
    const title = el("div", "tank-head");
    title.appendChild(el("strong", "", `${a.tt_no || ""} · invoice ${a.invoice_no || ""}`));
    const phase = { starting: "starting", running: "running", paused: "paused", finished: "finished ✓", cancelled: "cancelled", released: "handed over", failed: "didn't start" }[a.phase] || a.phase;
    title.appendChild(el("span", `stage ${a.phase === "finished" ? "read" : a.phase === "running" ? "decanting" : ""}`, phase));
    box.appendChild(title);
    const notes = [];
    if (a.phase === "starting") notes.push(`${a.step ? a.step[0].toUpperCase() + a.step.slice(1) : "Starting"}…`);
    if (a.reconnect) notes.push(`Connection to the PC lost (${a.lost?.reason || ""}): connecting again, try ${a.reconnect.tries}.`);
    if (a.stale) notes.push(a.stale + ".");
    if (a.frozen) notes.push(a.frozen);
    if (a.cloud_error) notes.push(`Decant app: ${a.cloud_error} (saved when it's back).`);
    if (a.error) notes.push(a.error);
    if (notes.length) box.appendChild(el("div", "note" + (a.error || a.cloud_error || a.stale || a.reconnect || a.frozen ? " err" : ""), notes.join(" ")));
    if (!run) { return actions(box, a, null); }
    if (!ACTIVE.includes(a.phase)) box.appendChild(ended(a));
    for (const q of run.questions || []) box.appendChild(question(q));
    for (const t of run.tanks) box.appendChild(tankCard(t, run, a));
    if (run.held?.length && a.phase === "running") box.appendChild(heldBox(run));
    else if (run.left?.length && ACTIVE.includes(a.phase)) box.appendChild(el("div", "note", `C${run.left.join(", C")} stay in the truck.`));
    actions(box, a, run);
    if (run.log?.length) {
      const log = el("details", "log-box");
      const last = run.log[run.log.length - 1];
      log.appendChild(el("summary", "", `Log · ${clock(last.at)} ${last.text.length > 70 ? last.text.slice(0, 70) + "…" : last.text}`));
      const ul = el("ul", "log");
      for (const e of [...run.log].reverse().slice(0, 15)) ul.appendChild(el("li", e.level, `${clock(e.at)} ${e.text}`));
      log.appendChild(ul);
      log.open = logOpen;
      log.addEventListener("toggle", () => { logOpen = log.open; });
      box.appendChild(log);
    }
  }
  let logOpen = false;
  const proofOpen = new Set();   // the tanks whose proof pictures are unfolded

  // A decantation that has ended: what came of it, and when it leaves the page.
  function ended(a) {
    const ok = a.phase === "finished";
    const box = el("div", `result${ok ? "" : " plain"}`);
    box.appendChild(el("strong", "", { finished: "✅ Finished and saved in the decant app", cancelled: "Cancelled",
      released: "Handed over to the decant app", failed: "It didn't start" }[a.phase] || a.phase));
    if ((a.result || []).length) {
      const ul = el("ul");
      for (const line of a.result) ul.appendChild(el("li", "", line));
      box.appendChild(ul);
    }
    const row = el("div", "row");
    const c = el("button", "up", "Clear now");
    c.addEventListener("click", () => autoAct("clear"));
    row.appendChild(c);
    if (a.clears_in_s != null) row.appendChild(el("span", "note", `Leaves this page by itself in ${Math.max(1, Math.ceil(a.clears_in_s / 60))} min`));
    box.appendChild(row);
    return box;
  }

  function tickBox(key, options, preset) {
    if (!ticks[key]) ticks[key] = new Set(preset);
    const set = ticks[key];
    const wrap = el("div");
    for (const o of options) {
      const lab = el("label");
      const cb = el("input");
      cb.type = "checkbox";
      cb.checked = set.has(o.no);
      cb.addEventListener("change", () => { cb.checked ? set.add(o.no) : set.delete(o.no); });
      lab.append(cb, el("span", "", `C${o.no} · ${kl(o.litres || 0)}${o.from && o.from !== o.tank ? ` (planned for Tank ${String(o.from).replace("T", "")})` : !o.from ? " (left in the truck)" : ""}`));
      wrap.appendChild(lab);
    }
    return wrap;
  }

  // Chambers kept in the truck: into a tank now, while this decantation runs.
  let heldPlan = {};            // chamber -> tank id ("" = keep in the truck)
  function heldBox(run) {
    const box = el("div", "ask");
    box.appendChild(el("strong", "", `Still in the truck: C${run.held.map((c) => c.no).join(", C")}`));
    box.appendChild(el("div", "note", "Pick a tank for the ones you decant now: the agent reads its stock before and follows it with the rest. "
      + "This decantation finishes once every tank's stock after is read."));
    const busy = new Set((run.tanks || []).filter((t) => t.stage === "read").map((t) => t.tank));
    for (const c of run.held) {
      const r = el("div", "plan-row");
      r.appendChild(el("div", "", `C${c.no} · ${c.product} · ${kl(c.litres)}`));
      const seg = el("div", "seg");
      const choices = [...(run.tankOptions || []).filter((t) => t.product === c.product && !busy.has(t.id))
        .map((t) => [t.id, `Tank ${t.no}`]), ["", "Keep in truck"]];
      for (const [id, label] of choices) {
        const b = el("button", "", label);
        b.type = "button";
        b.setAttribute("aria-pressed", (heldPlan[c.no] || "") === id ? "true" : "false");
        b.addEventListener("click", () => { heldPlan[c.no] = id; renderAuto(); });
        seg.appendChild(b);
      }
      r.appendChild(seg);
      box.appendChild(r);
    }
    const picks = run.held.filter((c) => heldPlan[c.no]);
    const go = el("button", "main", picks.length ? `Add C${picks.map((c) => c.no).join(", C")} to this decantation` : "Add to this decantation");
    go.disabled = !picks.length;
    go.addEventListener("click", async () => {
      const byTank = {};
      for (const c of picks) (byTank[heldPlan[c.no]] ||= []).push(c.no);
      for (const [tank, chambers] of Object.entries(byTank)) await autoAct("add", { tank, chambers });
      heldPlan = {};
    });
    const row = el("div", "row");
    row.appendChild(go);
    box.appendChild(row);
    return box;
  }

  function question(q) {
    const box = el("div", "ask");
    box.appendChild(el("strong", "", q.text));
    const key = `${q.tank}|${q.since}`;
    const row = el("div", "row");
    if (q.kind === "held") {
      box.appendChild(tickBox(key, q.options.map((o) => ({ ...o, tank: q.tank })), q.suggest));
      const yes = el("button", "main", "Yes, these are going in");
      yes.addEventListener("click", () => autoAct("answer", { tank: q.tank, chambers: [...ticks[key]] }));
      const no = el("button", "alt", "No, not from this truck");
      no.addEventListener("click", () => autoAct("answer", { tank: q.tank, chambers: "drop" }));
      row.append(yes, no);
    } else if (q.kind === "notstarted") {
      const drop = el("button", "main", "Leave it out");
      drop.addEventListener("click", () => autoAct("answer", { tank: q.tank, chambers: "drop" }));
      const wait = el("button", "alt", "Keep waiting");
      wait.addEventListener("click", () => autoAct("answer", { tank: q.tank, chambers: null }));
      row.append(drop, wait);
    } else {
      box.appendChild(tickBox(key, q.options.map((o) => ({ ...o, tank: q.tank })), q.suggest));
      box.appendChild(el("div", "note", "Ticked: emptied into this tank. Unticked chambers stay in the truck (or with the tank they were planned for)."));
      const ok = el("button", "main", "These went in: done");
      ok.addEventListener("click", () => autoAct("answer", { tank: q.tank, chambers: [...ticks[key]] }));
      const wait = el("button", "alt", "Still decanting: wait");
      wait.addEventListener("click", () => autoAct("answer", { tank: q.tank, chambers: null }));
      row.append(ok, wait);
    }
    box.appendChild(row);
    return box;
  }

  function tankCard(t, run, a) {
    const card = el("div", "tank");
    const head = el("div", "tank-head");
    head.appendChild(el("strong", "", `Tank ${t.no} · ${NAMES[t.product] || t.product}`));
    head.appendChild(el("span", `stage ${t.stage}`, STAGE_NAME[t.stage] || t.stage));
    card.appendChild(head);
    const order = ["waiting", "decanting", "settling", "read"];
    const at = order.indexOf(t.stage);
    const steps = el("div", "steps");
    for (const [i, name] of ["Waiting", "Decanting", "Settling", "Done"].entries()) {
      steps.appendChild(el("div", i < at || t.stage === "read" ? "done" : i === at ? "now" : "", name));
    }
    card.appendChild(steps);
    const chs = el("div");
    for (const no of t.chambers) chs.appendChild(el("span", `ch${t.arrived.includes(no) || t.stage === "settling" || t.stage === "read" ? " in" : ""}`, `C${no}`));
    chs.appendChild(el("span", "note", ` ${kl(t.litres)}`));
    card.appendChild(chs);
    const minis = el("div", "minis");
    const mini = (name, v, cls = "") => {
      const m = el("div", `mini${cls ? ` ${cls}` : ""}`);
      const b = el("b", "", v == null ? "–" : fmt(v, 0));
      if (v != null) b.appendChild(el("small", "", "L"));
      m.append(el("span", "", name), b);
      return m;
    };
    minis.appendChild(mini("Before", t.before));
    if (t.stage === "read" || t.after != null) minis.appendChild(mini("After", t.after));
    else minis.appendChild(mini("Now", t.now));
    const gained = t.stage === "read" && t.after != null && t.before != null ? t.after - t.before : t.rise;
    const g = mini(t.stage === "read" ? "Gained" : "Risen", gained, "up");
    if (gained != null) g.querySelector("b").firstChild.textContent = `${gained >= 0 ? "+" : ""}${fmt(gained, 0)}`;
    minis.appendChild(g);
    card.appendChild(minis);
    const lines = [];
    if (t.result) lines.push(`Variation ${t.result.variation > 0 ? "+" : ""}${fmt(t.result.variation, 2)} L (${t.result.band})`);
    if (t.stage === "settling" && t.settleLeft != null) {
      lines.push(t.settleLeft > 0 ? `Settling: ${Math.ceil(t.settleLeft / 60)} min to go` : `Settling: waiting for it to be steady (moved ${fmt(t.spread, 1)} L)`);
    }
    if (lines.length) card.appendChild(el("div", "note", lines.join(" · ")));
    const probe = state?.live?.probes?.[t.no];
    if (probe && ACTIVE.includes(a.phase) && t.stage !== "read") {
      card.appendChild(el("div", `probe ${probe.frozen ? "no" : "ok"}`, probe.frozen
        ? `⚠ Card frozen on the PC since ${clock(probe.since)}: nothing is taken from it until it updates.`
        : "Card updating on the PC ✓"));
    }
    // the stock before / after pictures, folded (their figures are above)
    const pr = a.proofs?.[t.tank] || {};
    const fold = el("details", "log-box");
    const has = ["before", "after"].filter((w) => pr[w]?.picture);
    fold.appendChild(el("summary", "", `Proof pictures${has.length ? ` · ${has.map((w) => `${w} ${pr[w].cloud ? "✓" : "…"}`).join(" · ")}` : " · none yet"}`));
    fold.appendChild(proofs(t, a));
    fold.open = proofOpen.has(t.tank);
    fold.addEventListener("toggle", () => { if (fold.open) proofOpen.add(t.tank); else proofOpen.delete(t.tank); });
    card.appendChild(fold);
    if (["decanting", "settling", "read"].includes(t.stage) && t.litres && t.rise != null) {
      const bar = el("div", "bar");
      const fill = el("span");
      fill.style.width = `${Math.max(0, Math.min(100, (100 * (t.stage === "read" && t.after != null ? t.after - t.before : t.rise)) / t.litres))}%`;
      bar.appendChild(fill);
      card.appendChild(bar);
    }
    if (a.phase !== "running") return card;
    const row = el("div", "row");
    if (t.stage === "waiting") {
      const b = el("button", "up", "Leave out");
      b.addEventListener("click", () => autoAct("drop", { tank: t.tank }));
      row.appendChild(b);
    } else if (t.stage === "decanting") {
      const b = el("button", "up", doneOpen === t.tank ? "Close" : "Done now…");
      b.addEventListener("click", () => { doneOpen = doneOpen === t.tank ? null : t.tank; renderAuto(); });
      row.appendChild(b);
    } else if (t.stage === "settling") {
      const b = el("button", "up", "Read the stock after now");
      b.addEventListener("click", () => autoAct("after", { tank: t.tank }));
      row.appendChild(b);
    }
    if (row.childNodes.length) card.appendChild(row);
    if (doneOpen === t.tank && t.stage === "decanting") {
      const key = `done|${t.tank}`;
      card.appendChild(tickBox(key, t.chambers.map((no) => ({ no, from: t.tank, tank: t.tank, litres: null })), t.arrived.length ? t.arrived : t.chambers));
      const ok = el("button", "main", "These were emptied: done");
      ok.addEventListener("click", () => { doneOpen = null; autoAct("done", { tank: t.tank, chambers: [...ticks[key]] }); delete ticks[key]; });
      card.appendChild(ok);
    }
    return card;
  }

  // Each tank's stock before / after: the zoomed card the agent read it from,
  // its figures, and whether the decant app has the picture for its result.
  function proofs(t, a) {
    const box = el("div", "proofs");
    const pr = a.proofs?.[t.tank] || {};
    for (const which of ["before", "after"]) {
      const p = pr[which];
      const cell = el("div", "proof");
      cell.appendChild(el("span", "label", which === "before" ? "Stock before" : "Stock after"));
      if (!p) {
        const v = which === "before" ? t.before : t.after;
        if (v != null) {                      // set in the decant app (or before this page kept pictures)
          cell.appendChild(el("div", "value", `${fmt(v, 2)} L`));
          if (which === "before" && t.beforeAt) cell.appendChild(el("div", "meta", clock(t.beforeAt)));
          cell.appendChild(el("div", "pf mid", "From the decant app (no picture taken here)"));
        } else {
          cell.appendChild(el("div", "meta", which === "before" ? "read when it starts" : "read once it has settled"));
        }
        box.appendChild(cell);
        continue;
      }
      cell.appendChild(el("div", "value", p.volume == null ? "–" : `${fmt(p.volume, 2)} L`));
      const meta = [p.readingAt ? clock(p.readingAt) : "", p.height != null ? `${fmt(p.height / 10, 1)} cm` : "",
        p.density ? `${fmt(p.density, 1)} kg/m³` : "", p.temp ? `${fmt(p.temp, 1)} °C` : ""].filter(Boolean);
      if (meta.length) cell.appendChild(el("div", "meta", meta.join(" · ")));
      if (p.picture) {
        const src = `api/auto/proof?tank=${encodeURIComponent(t.tank)}&which=${which}&v=${encodeURIComponent(p.at || "")}`;
        const link = el("a");
        link.href = src;
        link.target = "_blank";
        link.rel = "noopener";
        const img = el("img");
        img.src = src;
        img.alt = `Tank ${t.no} stock ${which} on the automation screen`;
        img.loading = "lazy";
        link.appendChild(img);
        cell.appendChild(link);
        const pf = el("div", `pf ${p.cloud ? "ok" : "mid"}`, p.cloud ? "✓ Proof in the decant app" : "Saving the proof to the decant app…");
        const save = el("a", "save", "Save");
        save.href = src;
        save.download = `Tank ${t.no} stock ${which} ${(p.readingAt || "").slice(0, 16).replace("T", " ").replace(":", "-")}.jpg`;
        pf.appendChild(save);
        cell.appendChild(pf);
      } else {
        cell.appendChild(el("div", "pf no", `No picture: ${p.note || "the card couldn't be pictured"}`));
      }
      box.appendChild(cell);
    }
    return box;
  }

  // The tanks' latest stock in the decant app, for the plan.
  function stockTable(options) {
    const tbl = el("table", "stocks");
    for (const tk of options.tanks) {
      const tr = el("tr");
      tr.appendChild(el("td", "", `Tank ${tk.no} · ${NAMES[tk.product] || tk.product}${tk.busy ? " (busy)" : ""}`));
      tr.appendChild(el("td", "n", tk.volume == null ? "no stock yet" : `${fmt(tk.volume, 0)} L`));
      const room = tk.volume == null ? null : (tk.fillTo || tk.capacity) - tk.volume;
      tr.appendChild(el("td", "n", room == null ? "" : `${fmt(room, 0)} L room`));
      tr.appendChild(el("td", "n note", tk.readingAt ? ago(tk.readingAt) : ""));
      tbl.appendChild(tr);
    }
    return tbl;
  }

  // A fresh picture of these tanks (from the open live session if there is one).
  async function captureTanks(nos) {
    picked = new Set(nos);
    keep("ts-picked", [...picked]);
    chips($("pick"), picked, () => { keep("ts-picked", [...picked]); renderResult(); });
    await start(false);
    $("result").hidden = false;
    $("result").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function actions(box, a, run) {
    const row = el("div", "row");
    const nos = (run?.tanks || []).map((t) => t.no).filter(Boolean);
    if (nos.length) {
      const img = el("button", "alt", `Tank stock image (Tank ${nos.join(", ")})`);
      img.addEventListener("click", () => captureTanks(nos));
      row.appendChild(img);
    }
    if (a.phase === "paused") {
      const b = el("button", "main", "Connect again");
      b.addEventListener("click", () => autoAct("reconnect"));
      row.appendChild(b);
    }
    if (ACTIVE.includes(a.phase)) {
      const started = (run?.tanks || []).some((t) => t.startedAt);
      if (a.phase === "starting" || !started) {
        const c = el("button", "alt", "Cancel");
        c.addEventListener("click", () => { if (confirm("Cancel this decantation? (only if nothing was decanted)")) autoAct("cancel"); });
        row.appendChild(c);
      }
      if (run && a.phase !== "starting") {
        const h = el("button", "alt", "Hand over to the decant app");
        h.addEventListener("click", () => { if (confirm("Stop running it here? The decantation stays in the decant app, to finish there.")) autoAct("release"); });
        row.appendChild(h);
      }
    }
    if (row.childNodes.length) box.appendChild(row);
  }

  function render() {
    if (!setup) renderAuto();
    chips($("pick"), picked, () => { keep("ts-picked", [...picked]); renderResult(); });
    renderStatus();
    renderResult();
    renderLive();
    renderTanks();
  }

  async function refresh() {
    try {
      state = await api("GET", document.hidden ? "api/state" : "api/state?seen=1");
      render();
    } catch (e) {
      setStatus("status", e.message, true);
    }
  }

  // One chain of polls, whoever asks for one (a button, the tab coming back):
  // never two timers asking the server twice as often.
  let polling = false, pollTimer = 0;
  const pollIn = (ms) => { clearTimeout(pollTimer); pollTimer = setTimeout(poll, ms); };
  async function poll() {
    clearTimeout(pollTimer);
    if (polling) return;
    polling = true;
    try { await refresh(); } finally { polling = false; }
    if (state?.busy || waiting || state?.live || autoActive()) {   // live: the figures as they come
      if (waiting && !state.busy) waiting = false;
      pollIn(state?.live && !state.busy ? 3000 : 2500);
    }
  }

  async function start(decantation) {
    try {
      await api("POST", "api/capture", { tanks: [...picked], decantation });
      waiting = true;
      setStatus("status", isLive() ? "Reading the live session…" : "Connecting to the automation PC… This takes about a minute.");
      $("go").disabled = $("goDec").disabled = true;
      pollIn(1500);
    } catch (e) {
      setStatus("status", e.message, true);
    }
  }

  async function upload(tanks) {
    setStatus("upStatus", "Uploading…");
    try {
      const { results } = await api("POST", "api/upload", { tanks });
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
  for (const id of ["mEvery", "mUp", "mRe"]) $(id).addEventListener("input", () => { monitorDirty = true; });
  const liveSettings = () => ({ interval_s: Number($("mEvery").value), auto_upload: $("mUp").checked,
    reconnect: $("mRe").checked, tanks: [...watched] });
  async function send(path, body, done, where = "mStatus") {
    try {
      await api("POST", path, body);
      monitorDirty = false;
      setStatus(where, done);
      await poll();
    } catch (e) {
      pending = "";
      setStatus(where, e.message, true);
    }
  }
  $("mSave").addEventListener("click", () => send("api/settings", liveSettings(), "Saved."));
  $("liveStart").addEventListener("click", () => { pending = "Starting…"; $("ctlText").textContent = pending; send("api/live/start", liveSettings(), "", "liveErr"); });
  $("liveStop").addEventListener("click", () => { pending = "Stopping…"; $("ctlText").textContent = pending; send("api/live/stop", {}, "", "liveErr"); });

  poll();
  setInterval(() => { if (!waiting && !document.hidden) refresh(); }, 30000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) poll(); });
})();
