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
    if (res.status === 401 && path !== "/api/login") showLogin();
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

  function showLogin() {
    $("app").hidden = true;
    $("login").hidden = false;
    $("monitor").textContent = "Locked";
    $("monitor").classList.remove("on");
    $("pin").focus();
  }

  function render(s) {
    state = s;
    const mon = $("monitor");
    mon.textContent = s.monitor.running ? "Monitor running" : "Monitor stopped";
    mon.classList.toggle("on", s.monitor.running);

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
    $("pinCard").hidden = !s.is_local;
    $("pinNote").textContent = s.settings.pin_set
      ? "A phone PIN is set. Saving a new one changes it and signs out any phone."
      : "Set a PIN to use this page from your phone over Tailscale.";
    $("logoutBtn").hidden = s.is_local;
    $("login").hidden = true;
    $("app").hidden = false;
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
      ? el("div", { class: "bal", text: `CCMS ${a.last_ccms} · ${ago(a.updated_at)}` })
      : el("div", { class: "bal note", text: "No balance read yet" });
    const err = a.last_error
      ? el("div", { class: "err", text: `⚠ ${ERRORS[a.last_error] || a.last_error} · ${ago(a.last_error_at)}` })
      : null;

    const actions = el("div", { class: "actions" },
      el("button", { type: "button", text: "Edit", onclick: () => openEditor(a) }),
      el("button", {
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
      toast(adding ? "Account added. Tap Open window on Mac to start it." : "Saved");
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

  $("pinForm").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    try {
      render(await api("POST", "/api/pin", { pin: $("newPin").value }));
      $("newPin").value = "";
      $("pinErr").textContent = "";
      toast("PIN saved");
    } catch (e) { $("pinErr").textContent = e.message; }
  });

  $("loginForm").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    try {
      await api("POST", "/api/login", { pin: $("pin").value });
      $("pin").value = "";
      $("loginErr").textContent = "";
      await refresh();
    } catch (e) { $("loginErr").textContent = e.message; }
  });
  $("logoutBtn").addEventListener("click", async () => {
    try { await api("POST", "/api/logout"); } catch (e) { /* signed out anyway */ }
    showLogin();
  });

  async function refresh() {
    try {
      render(await api("GET", "/api/state"));
    } catch (e) {
      if ($("login").hidden) toast(e.message);
    }
  }

  // Keep balances and the monitor status fresh while the page is open.
  setInterval(() => {
    if (!document.hidden && !$("editor").open && $("login").hidden) refresh();
  }, 30000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && $("login").hidden) refresh();
  });
  refresh();
})();
