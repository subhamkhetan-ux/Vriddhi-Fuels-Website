// Pumps page logic (the Vriddhi Fuels app's Pumps tab). Its own file so the
// page runs under a strict CSP (no inline script). Everything from the
// server is shown with textContent.
"use strict";
(() => {
  const CSRF = document.querySelector('meta[name="ts-csrf"]').content;
  // shown inside the Vriddhi Fuels app's Pumps tab: that app has the title bar
  if (window.self !== window.top) document.documentElement.classList.add("embedded");
  const $ = (id) => document.getElementById(id);
  const AMOUNTS = [100, 200, 500, 1000, 2000];
  const LITRES = [5, 10, 20, 50, 100];
  // FuelTrans' statuses: how each reads here, and its kind (the tile's colour)
  const STATES = {
    FUELING: ["Fuelling", "on"], CALLING: ["Nozzle up", "wait"], AUTHORISED: ["Authorised", "wait"],
    SUSPENDED: ["Paused", "wait"], "SALE END": ["Sale end", "idle"], IDLE: ["Idle", "idle"],
    OFFLINE: ["Offline", "bad"], "PUMP LOCK": ["Pump lock", "bad"], "PUMP STOP": ["Pump stop", "bad"],
    INOPERATIVE: ["Inoperative", "bad"], UNKNOWN: ["No news", "idle"],
  };
  let state = null;
  let timer = null;
  let open = null;          // the pump whose sheet is open
  let shownPreset = "";     // the preset the sheet's preset part was drawn for

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
  const num = (v, d = 2) => (v === null || v === undefined ? "–"
    : Number(v).toLocaleString("en-IN", { minimumFractionDigits: d, maximumFractionDigits: d }));
  const rupees = (v) => `₹${num(v)}`;
  const mmss = (s) => {
    if (s === null || s === undefined) return "–";
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = String(s % 60).padStart(2, "0");
    return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
  };
  const ago = (s) => (s < 60 ? `${s} s` : s < 3600 ? `${Math.round(s / 60)} min` : `${Math.round(s / 3600)} h`);
  const clock = (t) => new Date(t * 1000).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" });
  const presetText = (p) => (p.kind === "amount" ? `₹${num(p.value, 0)}` : `${num(p.value, p.value % 1 ? 2 : 0)} L`);
  const kindOf = (c) => (c.locks && c.locks.length ? "bad" : (STATES[c.status] || ["", "idle"])[1]);
  const label = (c) => (STATES[c.status] || [c.status])[0];
  const short = (lock) => lock.replace(/\s*INTERLOCK\s*/i, "").trim() || lock;
  const card = (pump) => state && state.watching.find((c) => c.pump === pump);

  async function act(path, body, where) {
    try {
      state = await api("POST", path, body);
      render();
    } catch (e) {
      $(where || "chooseStatus").textContent = e.message;
      $(where || "chooseStatus").classList.add("err");
    }
  }

  // ---- the control bar --------------------------------------------------------
  function renderControl() {
    const f = state.feed || {}, dot = $("dot");
    dot.className = "dot";
    let text, sub = "";
    if (!state.available) {
      text = "Not available"; sub = "Needs the FuelTrans tunnel (tank stock from FuelTrans)"; dot.classList.add("bad");
    } else if (!state.on) {
      text = "Off";
      sub = state.stopped ? `Since ${clock(state.stopped.at)}: ${state.stopped.why}` : "Tick nozzles, then Start";
    } else if (f.connected && !f.stale) {
      text = "Live"; dot.classList.add("live");
      sub = "Auto-off 15 min after you leave";
    } else if (f.error) {
      text = "Connecting again…"; sub = f.error; dot.classList.add("bad");
    } else if (f.stale && f.age_s !== null) {
      text = "Waiting for FuelTrans"; sub = `No news for ${ago(f.age_s)}`; dot.classList.add("wait");
    } else {
      text = "Connecting…"; dot.classList.add("wait");
    }
    $("feedText").textContent = text;
    $("feedSub").textContent = sub;
    $("start").hidden = state.on;
    $("start").disabled = !state.watching.length || !state.available;
    $("stop").hidden = !state.on;

    const stats = $("stats");
    stats.hidden = !state.on || !state.watching.length;
    stats.textContent = "";
    if (!stats.hidden) {
      const n = { on: 0, wait: 0, idle: 0, bad: 0 };
      for (const c of state.watching) n[kindOf(c)] += 1;
      for (const [k, name] of [["on", "Fuelling"], ["wait", "Waiting"], ["idle", "Idle"], ["bad", "Locked"]]) {
        const s = el("div", `stat${n[k] ? ` ${k}` : ""}`);
        s.append(el("b", "", String(n[k])), el("span", "", name));
        stats.appendChild(s);
      }
    }
  }

  // ---- a watched nozzle's tile -----------------------------------------------------
  function tile(c) {
    const live = state.on && c.seen_s !== null && c.seen_s <= 15;
    const kind = live ? kindOf(c) : "idle";
    const fueling = live && c.status === "FUELING";
    const t = el("div", `tile k-${kind}${live ? "" : " stale"}`);
    t.setAttribute("role", "button");
    t.tabIndex = 0;
    t.setAttribute("aria-label", `Pump ${c.pump}: details and preset`);
    t.addEventListener("click", () => openSheet(c.pump));
    t.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openSheet(c.pump); } });

    const head = el("div", "t-head");
    head.appendChild(el("span", "pno", String(c.pump)));
    if (c.product) head.appendChild(el("span", `prod ${c.product}`, c.product));
    head.appendChild(el("span", "st", live ? label(c) : state.on ? "No news" : "Off"));
    t.appendChild(head);
    t.appendChild(el("div", "t-where", [c.du && `DU ${c.du}`, c.tank && `Tank ${c.tank}`].filter(Boolean).join(" · ")));

    if (fueling) {
      const l = el("div", "t-litres", num(c.litres));
      l.appendChild(el("small", "", "L"));
      t.append(l, el("div", "t-amt", rupees(c.amount)));
    }
    // (not fuelling: FuelTrans still shows the last sale's figures)
    const last = c.sales && c.sales.length ? c.sales[0] : null;
    if (fueling) {
      const line = el("div", "t-line");
      line.append(el("b", "", c.lpm ? `${num(c.lpm, 1)} L/min` : "… L/min"),
        document.createTextNode(` · ${c.joined ? "seen " : ""}${mmss(c.fueling_s)}`));
      t.appendChild(line);
    } else if (last || (live && c.litres)) {
      const line = el("div", "t-line");
      line.append(document.createTextNode("Last sale "), el("b", "", `${num(last ? last.litres : c.litres)} L`),
        document.createTextNode(` · ₹${num(last ? last.amount : c.amount, 0)}${last ? ` · ${clock(last.ended)}` : ""}`));
      t.appendChild(line);
    }

    if (c.preset && c.target_litres) {
      if (fueling && c.progress !== null) {
        const bar = el("div", "bar"), fill = el("i");
        fill.style.width = `${Math.round(c.progress * 100)}%`;
        bar.appendChild(fill);
        t.appendChild(bar);
      }
      const left = el("div", "t-left");
      left.append(el("b", "", c.left_s === null ? "…" : mmss(c.left_s)),
        el("span", "", fueling ? `left of ${presetText(c.preset)}` : `for ${presetText(c.preset)}`));
      t.appendChild(left);
    } else if (fueling) {
      t.appendChild(el("div", "t-hint", "Tap to set the preset → time left"));
    }
    if (live && c.locks && c.locks.length) t.appendChild(el("div", "t-locks", `🔒 ${c.locks.map(short).join(" · ")}`));
    return t;
  }

  // ---- a nozzle's sheet ------------------------------------------------------------
  function openSheet(pump) {
    open = pump;
    shownPreset = null;
    renderSheet();
    const d = $("sheet");
    if (!d.open) d.showModal();
  }
  function closeSheet() {
    open = null;
    if ($("sheet").open) $("sheet").close();
  }

  function figure(name, value, unit = "", hi = false) {
    const f = el("div", `s-fig${hi ? " hi" : ""}`);
    const b = el("b", "", value);
    if (unit) b.appendChild(el("small", "", unit));
    f.append(el("span", "", name), b);
    return f;
  }

  function presetPart(c) {
    const box = $("sPreset");
    box.textContent = "";
    if (c.preset) {
      const cur = el("div", "current");
      const what = el("div");
      what.appendChild(el("b", "", presetText(c.preset)));
      if (c.target_litres) what.appendChild(el("div", "note", `≈ ${num(c.target_litres)} L`));
      const clear = el("button", "up", "✕ Clear");
      clear.type = "button";
      clear.addEventListener("click", () => act("api/pumps/preset", { pump: c.pump, value: null }, "sStatus"));
      cur.append(what, clear);
      box.appendChild(cur);
      return;
    }
    box.appendChild(el("div", "note", "As set on the dispenser's keypad. It clears when the sale ends."));
    for (const [kind, values, text] of [["amount", AMOUNTS, (v) => `₹${v}`], ["litres", LITRES, (v) => `${v} L`]]) {
      const row = el("div", "presets");
      row.style.marginTop = "8px";
      for (const v of values) {
        const b = el("button", "chip", text(v));
        b.type = "button";
        b.addEventListener("click", () => act("api/pumps/preset", { pump: c.pump, kind, value: v }, "sStatus"));
        row.appendChild(b);
      }
      box.appendChild(row);
    }
    const custom = el("div", "custom");
    const input = el("input");
    input.type = "number"; input.min = "1"; input.step = "any"; input.inputMode = "decimal"; input.placeholder = "Other amount";
    const unit = el("select");
    for (const [v, t] of [["amount", "₹"], ["litres", "L"]]) { const o = el("option", "", t); o.value = v; unit.appendChild(o); }
    const set = el("button", "up", "Set");
    set.type = "button";
    set.addEventListener("click", () => act("api/pumps/preset", { pump: c.pump, kind: unit.value, value: input.value }, "sStatus"));
    custom.append(input, unit, set);
    box.appendChild(custom);
  }

  function renderSheet() {
    const c = open === null ? null : card(open);
    if (!c) { closeSheet(); return; }
    const live = state.on && c.seen_s !== null && c.seen_s <= 15;
    const fueling = live && c.status === "FUELING";
    $("sTitle").textContent = `Pump ${c.pump}`;
    const prod = $("sProd");
    prod.className = c.product ? `prod ${c.product}` : "";
    prod.textContent = c.product || "";
    $("sWhere").textContent = [c.du && `DU ${c.du}`, c.nozzle && `nozzle ${c.nozzle}`, c.tank && `Tank ${c.tank}`,
      c.make, c.price && `₹${num(c.price)}/L`, live ? label(c) : state.on ? "no news" : "monitoring off"]
      .filter(Boolean).join(" · ");

    const figs = $("sFigs");
    figs.textContent = "";
    figs.append(figure(fueling ? "Litres" : "Last litres", num(c.litres), "L"),
      figure(fueling ? "Rupees" : "Last rupees", rupees(c.amount)));
    if (fueling) {
      figs.append(figure("Flow now", c.lpm ? num(c.lpm, 1) : "…", "L/min"),
        figure(c.joined ? "Seen for" : "Fuelling for", mmss(c.fueling_s)));
    }
    if (c.preset && c.target_litres) figs.appendChild(figure("Time left", c.left_s === null ? "…" : mmss(c.left_s), "", true));
    figs.appendChild(figure("Usual flow", c.usual_lpm ? num(c.usual_lpm, 1) : "learning", c.usual_lpm ? "L/min" : ""));

    const locks = $("sLocks");
    locks.textContent = "";
    if (live) for (const l of c.locks || []) locks.appendChild(el("span", "lock", `🔒 ${l}`));

    // (the preset part only when it changes: not under the fingers of someone typing one)
    const key = JSON.stringify(c.preset || null);
    if (key !== shownPreset && !$("sPreset").contains(document.activeElement)) {
      presetPart(c);
      shownPreset = key;
    }

    const sales = $("sSales");
    sales.textContent = "";
    if (!c.sales || !c.sales.length) {
      sales.appendChild(el("div", "note", "None yet: a sale is noted when it ends while monitoring."));
    } else {
      const t = el("table", "sales");
      const hr = el("tr");
      for (const h of ["Ended", "Litres", "₹", "Took", "L/min"]) hr.appendChild(el("th", "", h));
      t.appendChild(hr);
      for (const s of c.sales) {
        const tr = el("tr");
        for (const v of [clock(s.ended), num(s.litres), num(s.amount, 0), `${s.joined ? "≥" : ""}${mmss(s.secs)}`,
                         s.lpm ? num(s.lpm, 1) : "–"]) tr.appendChild(el("td", "", v));
        t.appendChild(tr);
      }
      sales.appendChild(t);
    }
  }

  // ---- the nozzles to watch ---------------------------------------------------------
  function setWatch(pumps) { act("api/pumps/watch", { pumps }); }

  function renderChoose() {
    const box = $("choose");
    box.textContent = "";
    $("chooseCount").textContent = state.pumps.length ? `${state.watching.length} of ${state.pumps.length}` : "";
    $("all").disabled = $("noneBtn").disabled = !state.pumps.length;
    if (!state.pumps.length) {
      box.appendChild(el("div", state.layout_error ? "note err" : "note",
        !state.available ? "The pumps come from FuelTrans through the IOCL PC's tunnel, which this server doesn't use yet."
          : state.layout_error ? `Couldn't read FuelTrans' pumps: ${state.layout_error}. Trying again in a minute.`
            : "Reading FuelTrans' pumps…"));
      return;
    }
    const byDu = new Map();
    for (const p of state.pumps) {
      if (!byDu.has(p.du)) byDu.set(p.du, []);
      byDu.get(p.du).push(p);
    }
    for (const [du, pumps] of byDu) {
      const group = el("div", "du");
      group.appendChild(el("div", "note", `DU ${du}${pumps[0].make ? ` · ${pumps[0].make}` : ""}`));
      const chips = el("div", "choose-grid");
      for (const p of pumps) {
        const b = el("button", "chip");
        b.type = "button";
        b.setAttribute("aria-pressed", String(p.watched));
        b.append(el("b", "", `Pump ${p.pump}`), el("span", `prod ${p.product}`, p.product));
        b.addEventListener("click", () => {
          const want = new Set(state.watching.map((c) => c.pump));
          if (want.has(p.pump)) want.delete(p.pump); else want.add(p.pump);
          setWatch([...want]);
        });
        chips.appendChild(b);
      }
      group.appendChild(chips);
      box.appendChild(group);
    }
  }

  // ---- the whole page -----------------------------------------------------------------
  function render() {
    if (!state) return;
    $("chooseStatus").textContent = "";
    $("chooseStatus").classList.remove("err");
    for (const id of ["onStatus", "sStatus"]) {
      $(id).textContent = "";
      $(id).classList.remove("err");
    }
    renderControl();
    const grid = $("grid");
    grid.textContent = "";
    for (const c of state.watching) grid.appendChild(tile(c));
    $("none").hidden = state.watching.length > 0;
    if (!state.watching.length && state.pumps.length && !$("chooser").dataset.touched) $("chooser").open = true;
    renderChoose();
    if (open !== null) renderSheet();
    $("alerts").checked = Boolean(state.alerts);
  }

  async function refresh() {
    clearTimeout(timer);
    try {
      if (!document.hidden) {
        state = await api("GET", "api/pumps?seen=1");
        render();
      }
    } catch (e) {
      $("feedText").textContent = "Can't reach the server";
      $("feedSub").textContent = e.message;
      $("dot").className = "dot bad";
    }
    timer = setTimeout(refresh, state && state.on ? 1000 : 30000);
  }

  $("alerts").addEventListener("change", () => act("api/pumps/alerts", { on: $("alerts").checked }));
  $("start").addEventListener("click", () => act("api/pumps/start", {}, "onStatus").then(refresh));
  $("stop").addEventListener("click", () => act("api/pumps/stop", {}, "onStatus"));
  $("all").addEventListener("click", () => setWatch(state.pumps.map((p) => p.pump)));
  $("noneBtn").addEventListener("click", () => setWatch([]));
  $("chooser").addEventListener("toggle", () => { $("chooser").dataset.touched = "1"; });
  $("sClose").addEventListener("click", closeSheet);
  $("sheet").addEventListener("close", () => { open = null; });
  $("sheet").addEventListener("click", (e) => { if (e.target === $("sheet")) closeSheet(); });   // (the backdrop)
  $("sUnwatch").addEventListener("click", () => {
    const pump = open;
    closeSheet();
    setWatch(state.watching.map((c) => c.pump).filter((p) => p !== pump));
  });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
  refresh();
})();
