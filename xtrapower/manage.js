// XtraPower account manager — page logic.
// Served as its own file so the page can run under a strict CSP (no inline
// script). Everything user-supplied is rendered with textContent, never HTML.
"use strict";
(() => {
  const CSRF = document.querySelector('meta[name="xp-csrf"]').content;
  const $ = (id) => document.getElementById(id);
  let state = null;
  let editingKey = null;        // null while adding a new account
  let settingsDirty = false;    // don't overwrite settings the user is typing

  const ERRORS = {
    "chrome-unreachable": "Chrome window not open",
    "no-page": "No tab open in its Chrome window",
    "read-failed": "Couldn't read the page",
    "waf-block": "Blocked by the portal firewall",
    "logged-out": "Logged out",
    "auto-login-failed": "Auto-login failed",
    "login-captcha": "Login needs you (reCAPTCHA)",
    "nav-failed": "Couldn't reach Balance Info",
    "no-search-button": "Search button not found",
    "no-ccms": "Couldn't read the CCMS value",
    "check-timeout": "The check got stuck (stopped; retrying)",
  };

  async function api(method, path, body) {
    const res = await fetch(path, {
      method,
      headers: { "Content-Type": "application/json", "X-XP-CSRF": CSRF },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "same-origin",
    });
    let data = {};
    try { data = await res.json(); } catch (e) { /* no body */ }
    if (!res.ok) throw new Error(data.error || `Something went wrong (${res.status}).`);
    return data;
  }

  function toast(msg) {
    const t = $("toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => t.classList.remove("show"), 2800);
  }

  function el(tag, props = {}, ...kids) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === "class") node.className = v;
      else if (k === "text") node.textContent = v;
      else if (k === "onclick") node.addEventListener("click", v);
      else node.setAttribute(k, v);
    }
    for (const kid of kids) if (kid) node.append(kid);
    return node;
  }

  function ago(iso) {
    if (!iso) return "";
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return iso;
    const s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 90) return "just now";
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return new Date(t).toLocaleString();
  }

  function render(s) {
    state = s;
    const mon = $("monitor");
    mon.textContent = s.monitor.running ? "Monitor running" : "Monitor stopped";
    mon.classList.toggle("on", s.monitor.running);
    // the Tank stock tab is the server's (the Mac has no tank stock service)
    $("tabTs").hidden = !s.server;
    if (!s.server && tab === "ts") show("xp");
    $("nAccounts").textContent = s.accounts.length;
    $("nWatching").textContent = s.accounts.filter((a) => a.watch).length;
    const problems = s.accounts.filter((a) => a.watch && a.last_error).length;
    $("nProblems").textContent = problems;
    $("alertTile").classList.toggle("alert", problems > 0);

    // Server mode: start / stop / restart the monitor service from here.
    $("monitorCard").hidden = !s.server;
    if (s.server) {
      const m = s.monitor;
      $("monitorMeta").textContent = m.running
        ? "Running. Checks each watched account and alerts on Telegram."
        : `Stopped (${m.state}). No checks or alerts until you press Start.`;
      $("startBtn").disabled = m.running;
      $("stopBtn").disabled = !m.running;
      $("restartBtn").disabled = !m.running;
    }

    const list = $("list");
    list.replaceChildren();
    if (!s.accounts.length) {
      list.append(el("div", { class: "card empty", text: "No accounts yet. Tap Add account." }));
    }
    for (const a of s.accounts) list.append(card(a));

    if (!settingsDirty) {
      $("sToken").value = "";
      $("sToken").placeholder = s.settings.telegram_token_set
        ? `Saved (${s.settings.telegram_token_hint}). Leave blank to keep it.`
        : "Paste the BotFather token";
      $("sChat").value = s.settings.chat_id;
      $("sPoll").value = s.settings.poll_seconds;
    }
  }

  function card(a) {
    const key = encodeURIComponent(a.customer_id);

    const sw = el("input", { type: "checkbox", "aria-label": `Watch ${a.label}` });
    sw.checked = a.watch;
    sw.addEventListener("change", async () => {
      sw.disabled = true;
      try {
        render(await api("POST", `/api/accounts/${key}/watch`, { watch: sw.checked }));
        toast(sw.checked ? `Watching ${a.label}` : `Stopped watching ${a.label}`);
      } catch (e) {
        sw.checked = !sw.checked;
        toast(e.message);
      } finally {
        sw.disabled = false;
      }
    });
    const toggle = el("label", { class: "switch" },
      sw, el("span", { class: "track" }), el("span", { text: a.watch ? "Watching" : "Off" }));

    const login = a.has_password
      ? `Auto-login as ${a.username || "(no User ID set)"}`
      : "Manual login (no password saved)";
    const meta = el("div", { class: "meta", text: `ID ${a.customer_id} · Chrome port ${a.cdp_port} · ${login}` });
    const bal = a.last_ccms
      ? el("div", { class: "bal" }, el("span", { class: "k", text: "CCMS" }),
        el("span", { class: "v", text: a.last_ccms }), el("span", { class: "t", text: ago(a.updated_at) }))
      : el("div", { class: "bal none", text: "No balance read yet" });
    const err = a.last_error
      ? el("div", { class: "err", text: `⚠ ${ERRORS[a.last_error] || a.last_error} · ${ago(a.last_error_at)}` })
      : null;

    const actions = el("div", { class: "actions" },
      el("button", { type: "button", text: "Edit", onclick: () => openEditor(a) }),
      // On the server the windows open by themselves; only the Mac needs this.
      state.server ? null : el("button", {
        type: "button", text: "Open window on Mac", onclick: async (ev) => {
          ev.currentTarget.disabled = true;
          const btn = ev.currentTarget;
          try {
            await api("POST", `/api/accounts/${key}/open`);
            toast(`Opened a Chrome window for ${a.label} on the Mac`);
          } catch (e) { toast(e.message); } finally { btn.disabled = false; }
        },
      }),
      el("button", {
        type: "button", class: "danger", text: "Delete", onclick: async () => {
          if (!confirm(`Delete ${a.label}? The monitor will stop watching it.`)) return;
          try {
            render(await api("DELETE", `/api/accounts/${key}`));
            toast(`Deleted ${a.label}`);
          } catch (e) { toast(e.message); }
        },
      }),
    );

    return el("div", { class: "card" },
      el("div", { class: "row" }, el("div", { class: "name", text: a.label }), toggle),
      meta, bal, err, actions);
  }

  function openEditor(a) {
    editingKey = a ? a.customer_id : null;
    $("editTitle").textContent = a ? `Edit ${a.label}` : "Add account";
    $("fLabel").value = a ? a.label : "";
    $("fCid").value = a ? a.customer_id : "";
    $("fUser").value = a ? a.username : "";
    $("fPass").value = "";
    $("fPass").placeholder = a && a.has_password
      ? "Saved. Leave blank to keep it."
      : "Leave blank to log in by hand";
    $("fClearWrap").hidden = !(a && a.has_password);
    $("fClear").checked = false;
    $("fPort").value = a ? a.cdp_port : state.next_port;
    $("fWatch").checked = a ? a.watch : true;
    $("editErr").textContent = "";
    $("editor").showModal();
    $("fLabel").focus();
  }

  $("editForm").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const body = {
      label: $("fLabel").value,
      customer_id: $("fCid").value.trim(),
      username: $("fUser").value,
      cdp_port: $("fPort").value,
      watch: $("fWatch").checked,
      clear_password: $("fClear").checked,
    };
    if ($("fPass").value) body.password = $("fPass").value;
    const adding = editingKey === null;
    try {
      const s = adding
        ? await api("POST", "/api/accounts", body)
        : await api("PUT", `/api/accounts/${encodeURIComponent(editingKey)}`, body);
      $("fPass").value = "";
      $("editor").close();
      render(s);
      const started = state.server
        ? "Account added. Its window opens within a minute."
        : "Account added. Tap Open window on Mac to start it.";
      toast(adding ? started : "Saved");
    } catch (e) {
      $("editErr").textContent = e.message;
    }
  });
  $("cancelBtn").addEventListener("click", () => { $("fPass").value = ""; $("editor").close(); });
  $("addBtn").addEventListener("click", () => openEditor(null));

  for (const id of ["sToken", "sChat", "sPoll"]) {
    $(id).addEventListener("input", () => { settingsDirty = true; });
  }
  $("settingsForm").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const body = { chat_id: $("sChat").value.trim(), poll_seconds: $("sPoll").value };
    if ($("sToken").value.trim()) body.telegram_token = $("sToken").value.trim();
    try {
      settingsDirty = false;
      render(await api("PUT", "/api/settings", body));
      $("settingsErr").textContent = "";
      toast("Settings saved");
    } catch (e) {
      settingsDirty = true;
      $("settingsErr").textContent = e.message;
    }
  });
  $("testBtn").addEventListener("click", async (ev) => {
    if (settingsDirty) { toast("Save the settings first, then send the test."); return; }
    const btn = ev.currentTarget;
    btn.disabled = true;
    try {
      await api("POST", "/api/settings/test");
      toast("Test message sent. Check Telegram.");
    } catch (e) { $("settingsErr").textContent = e.message; } finally { btn.disabled = false; }
  });

  async function control(action, btn) {
    if (action === "stop" &&
        !confirm("Stop the monitor? No checks or alerts until you press Start, even after a reboot.")) return;
    btn.disabled = true;
    toast(action === "stop" ? "Stopping…" : action === "start" ? "Starting…" : "Restarting…");
    try {
      render(await api("POST", `/api/monitor/${action}`));
      toast(action === "stop" ? "Monitor stopped" : action === "start" ? "Monitor started" : "Monitor restarted");
    } catch (e) {
      toast(e.message);
      btn.disabled = false;
    }
  }
  $("startBtn").addEventListener("click", (ev) => control("start", ev.currentTarget));
  $("stopBtn").addEventListener("click", (ev) => control("stop", ev.currentTarget));
  $("restartBtn").addEventListener("click", (ev) => control("restart", ev.currentTarget));

  async function showLog() {
    const box = $("logBox");
    try {
      const data = await api("GET", "/api/logs");
      box.textContent = data.lines.length ? data.lines.join("\n") : "(no log lines yet)";
      box.hidden = false;
      $("logBtn").textContent = "Refresh log";
      box.scrollTop = box.scrollHeight;
    } catch (e) { toast(e.message); }
  }
  $("logBtn").addEventListener("click", showLog);

  async function refresh() {
    try {
      render(await api("GET", "/api/state"));
    } catch (e) {
      toast(e.message);
    }
  }

  // ---- tabs: XtraPower here; Tank stock is its own page (/ts/), framed ----
  let tab = "xp";
  let framed = false;
  const remember = (t) => { try { localStorage.setItem("vf-tab", t); } catch (e) { /* private mode */ } };
  function measure() {
    document.documentElement.style.setProperty("--top", `${$("top").getBoundingClientRect().height}px`);
  }
  async function loadTank() {
    $("tsDown").hidden = true;
    try {
      // reachable? (the tank stock service runs in its own login session)
      const res = await fetch("ts/api/state", { credentials: "same-origin" });
      if (!res.ok) {
        let why = `It answered ${res.status}.`;
        try { why = (await res.json()).error || why; } catch (e) { /* not JSON */ }
        throw new Error(why);
      }
      $("tsFrame").hidden = false;
      if (!framed) { $("tsFrame").src = "ts/"; framed = true; }
    } catch (e) {
      $("tsFrame").hidden = true;
      $("tsDownWhy").textContent = e.message;
      $("tsDown").hidden = false;
    }
  }
  function show(t) {
    tab = t;
    for (const b of document.querySelectorAll(".tab")) b.setAttribute("aria-selected", String(b.dataset.tab === t));
    $("xpPane").hidden = t !== "xp";
    $("tsPane").hidden = t !== "ts";
    document.body.classList.toggle("framed", t === "ts");
    $("where").textContent = t === "ts" ? "Tank stock · IOCL automation PC" : "XtraPower CCMS monitor";
    $("monitor").hidden = t === "ts";            // (the XtraPower monitor's; the tank page shows its own)
    if (location.hash !== `#${t}`) history.replaceState(null, "", `#${t}`);
    remember(t);
    measure();
    if (t === "ts") loadTank();
    window.scrollTo(0, 0);
  }
  for (const b of document.querySelectorAll(".tab")) b.addEventListener("click", () => show(b.dataset.tab));
  $("tsRetry").addEventListener("click", loadTank);
  window.addEventListener("resize", measure);
  let first = location.hash.slice(1);
  if (!["xp", "ts"].includes(first)) {
    try { first = localStorage.getItem("vf-tab") || "xp"; } catch (e) { first = "xp"; }
  }
  show(first === "ts" ? "ts" : "xp");

  // Keep balances and the monitor status fresh while the page is open.
  setInterval(() => {
    if (!document.hidden && !$("editor").open && tab === "xp") refresh();
  }, 30000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refresh();
  });
  refresh();
})();
