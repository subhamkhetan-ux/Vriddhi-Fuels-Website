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
  let state = null;
  let timer = null;

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
  const secs = (s) => {
    if (s === null || s === undefined) return "–";
    const m = Math.floor(s / 60);
    return m ? `${m}:${String(s % 60).padStart(2, "0")} min` : `${s} s`;
  };
  const clock = (t) => new Date(t * 1000).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" });
  const presetText = (p) => (p.kind === "amount" ? `₹${num(p.value, 0)}` : `${num(p.value, p.value % 1 ? 2 : 0)} L`);

  async function act(path, body, where) {
    try {
      state = await api("POST", path, body);
      render();
    } catch (e) {
      $(where || "chooseStatus").textContent = e.message;
      $(where || "chooseStatus").classList.add("err");
    }
  }

  function renderSub() {
    const sub = $("sub"), f = state.feed || {};
    sub.classList.remove("live");
    if (!state.available) sub.textContent = "Needs the FuelTrans tunnel (tank stock from FuelTrans)";
    else if (!state.on) sub.textContent = "Off";
    else if (f.connected && !f.stale) { sub.textContent = "Live from FuelTrans"; sub.classList.add("live"); }
    else if (f.error) sub.textContent = `Connecting again… (${f.error})`;
    else if (f.stale && f.age_s !== null) sub.textContent = `No news for ${secs(f.age_s)}`;
    else sub.textContent = "Connecting to FuelTrans…";
  }

  function presetRow(card) {
    const row = el("div", "presets");
    if (card.preset) {
      row.appendChild(el("span", "note", `Preset ${presetText(card.preset)}`));
      const clear = el("button", "up", "✕ Clear");
      clear.type = "button";
      clear.addEventListener("click", () => act("api/pumps/preset", { pump: card.pump, value: null }));
      row.appendChild(clear);
      return row;
    }
    row.appendChild(el("span", "note", "Preset:"));
    for (const [kind, values, label] of [["amount", AMOUNTS, (v) => `₹${v}`], ["litres", LITRES, (v) => `${v} L`]]) {
      for (const v of values) {
        const b = el("button", "chip", label(v));
        b.type = "button";
        b.addEventListener("click", () => act("api/pumps/preset", { pump: card.pump, kind, value: v }));
        row.appendChild(b);
      }
    }
    const input = el("input");
    input.type = "number"; input.min = "1"; input.step = "any"; input.placeholder = "other";
    const unit = el("select");
    for (const [v, t] of [["amount", "₹"], ["litres", "L"]]) { const o = el("option", "", t); o.value = v; unit.appendChild(o); }
    unit.style.width = "auto";
    const set = el("button", "up", "Set");
    set.type = "button";
    set.addEventListener("click", () => act("api/pumps/preset", { pump: card.pump, kind: unit.value, value: input.value }));
    row.append(input, unit, set);
    return row;
  }

  function cardFor(c) {
    const box = el("div", "pump");
    const head = el("div", "pump-head");
    head.appendChild(el("strong", "", `Pump ${c.pump}`));
    if (c.product) head.appendChild(el("span", `prod ${c.product}`, c.product));
    head.appendChild(el("span", "where", [c.du && `DU ${c.du}`, c.nozzle && `nozzle ${c.nozzle}`, c.tank && `Tank ${c.tank}`]
      .filter(Boolean).join(" · ")));
    head.appendChild(el("span", `state ${String(c.status).toLowerCase().replace(/\s+/g, "-")}`, c.status));
    box.appendChild(head);

    const fueling = c.status === "FUELING";
    const big = el("div", "big");
    for (const [label, value] of [[fueling ? "Rupees" : "Last sale ₹", `₹${num(c.amount)}`],
                                  [fueling ? "Litres" : "Last sale litres", `${num(c.litres)} L`]]) {
      const f = el("div", "fig");
      f.append(el("span", "label", label), el("span", "value", value));
      big.appendChild(f);
    }
    box.appendChild(big);

    const usual = c.usual_lpm ? `usual ${num(c.usual_lpm, 1)} L/min (${c.learnt_from} sale${c.learnt_from === 1 ? "" : "s"})`
      : "usual flow: learnt after its first sale";
    const facts = el("div", "facts");
    facts.textContent = fueling
      ? `Fuelling for ${secs(c.fueling_s)} · now ${c.lpm ? `${num(c.lpm, 1)} L/min` : "…"} · ${usual}`
      : usual[0].toUpperCase() + usual.slice(1);
    box.appendChild(facts);

    if (c.preset && c.target_litres) {
      if (fueling && c.progress !== null) {
        const bar = el("div", "bar"), fill = el("i");
        fill.style.width = `${Math.round(c.progress * 100)}%`;
        bar.appendChild(fill);
        box.appendChild(bar);
      }
      const done = c.preset.kind === "amount" ? `₹${num(c.amount, 0)} of ${presetText(c.preset)}` : `${num(c.litres)} of ${presetText(c.preset)}`;
      box.appendChild(el("div", "left", fueling
        ? `${done} · ${c.left_s === null ? "time left: after a few seconds of flow" : `about ${secs(c.left_s)} left`}`
        : `${presetText(c.preset)} (~${num(c.target_litres)} L): ${c.left_s === null ? "time once it learns this nozzle" : `about ${secs(c.left_s)} once it fuels`}`));
    }
    box.appendChild(presetRow(c));

    if (c.locks && c.locks.length) {
      const locks = el("div", "locks");
      for (const l of c.locks) locks.appendChild(el("span", "lock", `🔒 ${l}`));
      box.appendChild(locks);
    }
    if (c.sales && c.sales.length) {
      const d = el("details", "sales");
      d.appendChild(el("summary", "", `Last ${c.sales.length} sale${c.sales.length === 1 ? "" : "s"}`));
      const t = el("table");
      const hr = el("tr");
      for (const h of ["Ended", "Litres", "₹", "Took", "L/min"]) hr.appendChild(el("td", "", h));
      t.appendChild(hr);
      for (const s of c.sales) {
        const tr = el("tr");
        for (const v of [clock(s.ended), num(s.litres), num(s.amount), secs(s.secs), s.lpm ? num(s.lpm, 1) : "–"]) tr.appendChild(el("td", "", v));
        t.appendChild(tr);
      }
      d.appendChild(t);
      box.appendChild(d);
    }
    if (c.seen_s !== null && c.seen_s > 15) box.appendChild(el("div", "note err", `No news from this pump for ${secs(c.seen_s)}.`));
    return box;
  }

  function renderChoose() {
    const box = $("choose");
    box.textContent = "";
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
      group.appendChild(el("div", "note", `DU ${du} · ${pumps[0].make || ""}`));
      const chips = el("div", "chips");
      for (const p of pumps) {
        const b = el("button", "chip", `Pump ${p.pump} · ${p.product}`);
        b.type = "button";
        b.setAttribute("aria-pressed", String(p.watched));
        b.addEventListener("click", () => {
          const want = new Set(state.watching.map((c) => c.pump));
          if (want.has(p.pump)) want.delete(p.pump); else want.add(p.pump);
          act("api/pumps/watch", { pumps: [...want] });
        });
        chips.appendChild(b);
      }
      group.appendChild(chips);
      box.appendChild(group);
    }
  }

  function render() {
    if (!state) return;
    renderSub();
    $("chooseStatus").textContent = "";
    $("chooseStatus").classList.remove("err");
    $("onStatus").classList.remove("err");
    // (not while a custom preset is being typed)
    if (!$("cards").contains(document.activeElement)) {
      $("cards").textContent = "";
      for (const c of state.watching) $("cards").appendChild(cardFor(c));
    }
    $("none").hidden = state.watching.length > 0;
    $("start").hidden = state.on;
    $("start").disabled = !state.watching.length || !state.available;
    $("stop").hidden = !state.on;
    const st = state.stopped;
    $("onStatus").textContent = state.on
      ? `On. Stops by itself in ${secs(state.stops_in_s)} if this page is closed.`
      : st ? `Off since ${clock(st.at)} (${st.why}).` : "Off.";
    renderChoose();
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
      $("sub").textContent = e.message;
    }
    timer = setTimeout(refresh, state && state.on ? 1000 : 30000);
  }

  $("alerts").addEventListener("change", () => act("api/pumps/alerts", { on: $("alerts").checked }));
  $("start").addEventListener("click", () => act("api/pumps/start", {}, "onStatus").then(refresh));
  $("stop").addEventListener("click", () => act("api/pumps/stop", {}, "onStatus"));
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
  refresh();
})();
