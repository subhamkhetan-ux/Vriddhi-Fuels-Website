"""Vriddhi Tally Bridge — the Windows app. Home shows the bridge live; Connect walks
through the three setup steps; Settings and Activity hold the rest. Every action runs
off the UI thread (control.py), so the window never freezes while Tally is busy."""
import queue
import threading
import time
import webbrowser
from pathlib import Path

from . import __version__
from .control import WEB_APP, Controller, Problem, friendly

ASSETS = Path(__file__).resolve().parent / "assets"
C = {"bg": "#f7f3ef", "card": "#ffffff", "ink": "#211b17", "muted": "#6d635c", "line": "#e8dfd7", "soft": "#fbf1e9",
     "brand": "#d9560f", "brand_dark": "#b8460b", "brand_ink": "#ffffff", "nav": "#fffaf6",
     "good": "#1d8a57", "good_soft": "#e4f4ec", "warn": "#a8660a", "warn_soft": "#fdf1dc",
     "bad": "#c0392b", "bad_soft": "#fbe6e3", "idle": "#7c736c", "idle_soft": "#efebe7"}
FONT = "Segoe UI"


def windows_niceties():
    """Sharp text on high-DPI screens and the app's own taskbar icon (Windows only)."""
    try:
        import ctypes
        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID("VriddhiFuels.TallyBridge")
        ctypes.windll.shcore.SetProcessDpiAwareness(1)
    except (AttributeError, OSError):
        pass


class App:
    def __init__(self, root, controller):
        import tkinter as tk
        self.tk, self.root, self.ctl = tk, root, controller
        self.busy, self.updates, self.snap, self.page, self.refreshing = False, queue.Queue(), None, None, False
        self.buttons = []
        root.title("Vriddhi Tally Bridge")
        root.geometry("980x700")
        root.minsize(860, 620)
        root.configure(bg=C["bg"])
        try:
            root.iconbitmap(default=str(ASSETS / "bridge.ico"))
        except tk.TclError:
            pass
        self.logo = self.image("logo-56.png")
        self.vars()
        self.layout()
        self.root.protocol("WM_DELETE_WINDOW", self.close)
        self.root.after(80, self.pump)
        self.refresh()
        self.show("home")

    # ---- small widget kit -------------------------------------------------
    def image(self, name):
        try:
            return self.tk.PhotoImage(file=str(ASSETS / name))
        except self.tk.TclError:
            return None

    def label(self, parent, text="", size=10, weight="normal", color="ink", bg="card", **kw):
        return self.tk.Label(parent, text=text, font=(FONT, size, weight), fg=C[color], bg=C[bg], anchor="w",
                             justify="left", **kw)

    def button(self, parent, text, command, kind="primary", bg="card"):
        colors = {"primary": (C["brand"], C["brand_ink"], C["brand_dark"]),
                  "ghost": (C["card"], C["ink"], C["soft"]), "quiet": (C[bg], C["brand"], C[bg])}[kind]
        b = self.tk.Button(parent, text=text, command=command, font=(FONT, 10, "bold"), bg=colors[0], fg=colors[1],
                           activebackground=colors[2], activeforeground=colors[1], relief="flat", bd=0, cursor="hand2",
                           padx=16, pady=8, highlightthickness=1 if kind == "ghost" else 0,
                           highlightbackground=C["line"], disabledforeground=C["idle"])
        b.colors = colors
        b.bind("<Enter>", lambda e: b.configure(bg=colors[2]) if str(b["state"]) != "disabled" else None)
        b.bind("<Leave>", lambda e: b.configure(bg=colors[0] if str(b["state"]) != "disabled" else C["line"]))
        self.buttons.append(b)
        return b

    @staticmethod
    def enable(b, on):
        """A disabled button looks disabled, whatever its colour."""
        b.configure(state="normal" if on else "disabled", bg=b.colors[0] if on else (C["line"] if b.colors[0] == C["brand"] else b.colors[0]))

    def card(self, parent, pady=(0, 14)):
        f = self.tk.Frame(parent, bg=C["card"], highlightthickness=1, highlightbackground=C["line"], padx=22, pady=18)
        f.pack(fill="x", pady=pady)
        return f

    def entry(self, parent, var, width=12):
        return self.tk.Entry(parent, textvariable=var, width=width, font=(FONT, 10), relief="flat", bg=C["soft"],
                             fg=C["ink"], insertbackground=C["ink"], highlightthickness=1, highlightbackground=C["line"],
                             highlightcolor=C["brand"])

    def checkbox(self, parent, text, var, command=None):
        return self.tk.Checkbutton(parent, text=text, variable=var, command=command, font=(FONT, 10), bg=C["card"],
                                   fg=C["ink"], activebackground=C["card"], selectcolor=C["card"], anchor="w",
                                   justify="left", wraplength=620, cursor="hand2", highlightthickness=0, bd=0)

    # ---- state ---------------------------------------------------------------
    def vars(self):
        tk = self.tk
        config = self.ctl.config()
        tally = config.get("tally_startup", {}) or {}
        self.v = {"port": tk.StringVar(value=str(config.get("port", 9000))),
                  "auto_tally": tk.BooleanVar(value=tally.get("enabled", True)),
                  "hidden": tk.BooleanVar(value=tally.get("hidden", True)),
                  "exe": tk.StringVar(value=tally.get("exe", "")), "number": tk.StringVar(value=tally.get("number", "")),
                  "awake": tk.BooleanVar(value=config.get("keep_awake", True)), "revive": tk.BooleanVar(value=True)}
        try:
            self.v["revive"].set(self.ctl.win.startup_state()["autostart"])
        except (OSError, RuntimeError):
            pass

    def settings(self):
        try:
            port = int(self.v["port"].get())
        except ValueError:
            raise Problem("The Tally port is a number, usually 9000.") from None
        return dict(port=port, auto_tally=self.v["auto_tally"].get(), exe=self.v["exe"].get().strip(),
                    number=self.v["number"].get().strip(), keep_awake=self.v["awake"].get(), autostart=self.v["revive"].get(),
                    hidden=self.v["hidden"].get())

    # ---- layout ----------------------------------------------------------------
    def layout(self):
        tk = self.tk
        head = tk.Frame(self.root, bg=C["brand"], height=72)
        head.pack(fill="x")
        head.pack_propagate(False)
        if self.logo:
            tk.Label(head, image=self.logo, bg=C["brand"]).pack(side="left", padx=(22, 12))
        titles = tk.Frame(head, bg=C["brand"])
        titles.pack(side="left")
        tk.Label(titles, text="VRIDDHI FUELS", font=(FONT, 8, "bold"), fg="#ffe3d1", bg=C["brand"]).pack(anchor="w")
        tk.Label(titles, text="Tally Bridge", font=(FONT, 17, "bold"), fg="white", bg=C["brand"]).pack(anchor="w")
        tk.Label(head, text="Version " + __version__, font=(FONT, 9), fg="#ffe3d1", bg=C["brand"]).pack(side="right", padx=22)

        body = tk.Frame(self.root, bg=C["bg"])
        body.pack(fill="both", expand=True)
        nav = tk.Frame(body, bg=C["nav"], width=196, highlightthickness=1, highlightbackground=C["line"])
        nav.pack(side="left", fill="y")
        nav.pack_propagate(False)
        self.nav = {}
        tk.Frame(nav, bg=C["nav"], height=14).pack()
        for key, text in (("home", "Home"), ("connect", "Connect"), ("settings", "Settings"), ("activity", "Activity")):
            item = tk.Label(nav, text="   " + text, font=(FONT, 11), anchor="w", bg=C["nav"], fg=C["ink"], padx=14, pady=10,
                            cursor="hand2")
            item.pack(fill="x", padx=10, pady=2)
            item.bind("<Button-1>", lambda e, k=key: self.show(k))
            self.nav[key] = item
        tk.Label(nav, text="Closing this window does not stop the bridge.", font=(FONT, 9), fg=C["muted"], bg=C["nav"],
                 justify="left", wraplength=150, anchor="w").pack(side="bottom", fill="x", padx=22, pady=18)

        right = tk.Frame(body, bg=C["bg"])
        right.pack(side="left", fill="both", expand=True)
        self.message = tk.Label(right, text="", font=(FONT, 10), anchor="w", justify="left", wraplength=700, padx=16, pady=10)
        # The pages scroll: Connect is taller than a laptop screen.
        self.viewport = tk.Canvas(right, bg=C["bg"], highlightthickness=0)
        bar = tk.Scrollbar(right, orient="vertical", command=self.viewport.yview)
        self.viewport.configure(yscrollcommand=bar.set)
        bar.pack(side="right", fill="y")
        self.viewport.pack(fill="both", expand=True)
        self.content = tk.Frame(self.viewport, bg=C["bg"], padx=28, pady=22)
        window = self.viewport.create_window((0, 0), window=self.content, anchor="nw")
        self.content.bind("<Configure>", lambda e: self.viewport.configure(scrollregion=self.viewport.bbox("all")))
        self.viewport.bind("<Configure>", lambda e: self.viewport.itemconfigure(window, width=e.width))
        self.root.bind_all("<MouseWheel>", lambda e: self.viewport.yview_scroll(-int(e.delta / 120), "units"))
        self.pages = {k: tk.Frame(self.content, bg=C["bg"]) for k in self.nav}
        self.build_home(self.pages["home"])
        self.build_connect(self.pages["connect"])
        self.build_settings(self.pages["settings"])
        self.build_activity(self.pages["activity"])

    def show(self, key):
        self.page = key
        for k, item in self.nav.items():
            on = k == key
            item.configure(bg=C["soft"] if on else C["nav"], fg=C["brand"] if on else C["ink"],
                           font=(FONT, 11, "bold" if on else "normal"))
        for k, frame in self.pages.items():
            frame.pack_forget()
        self.pages[key].pack(fill="both", expand=True)
        self.viewport.yview_moveto(0)

    def say(self, text, tone="good"):
        if not text:
            self.message.pack_forget()
            return
        self.message.configure(text=text, bg=C[tone + "_soft"], fg=C[tone])
        self.message.pack(fill="x", padx=28, pady=(16, 0), before=self.viewport)
        stamp = time.monotonic()
        self.message_at = stamp
        self.root.after(15000, lambda: self.say("") if getattr(self, "message_at", None) == stamp else None)

    # ---- Home --------------------------------------------------------------------
    def build_home(self, page):
        tk = self.tk
        self.banner = tk.Frame(page, bg=C["warn_soft"], padx=18, pady=12)
        self.banner_text = tk.Label(self.banner, font=(FONT, 10), bg=C["warn_soft"], fg=C["warn"], justify="left",
                                    wraplength=560, anchor="w")
        self.banner_text.pack(side="left", fill="x", expand=True)
        self.button(self.banner, "Update now", lambda: self.run(self.update_now, "Updating…")).pack(side="right")

        self.welcome = self.card(page)
        self.label(self.welcome, "Connect this PC to your books", 15, "bold").pack(anchor="w")
        self.label(self.welcome, "Three quick steps: open Tally, paste the pairing code from the web app, choose your "
                   "options. The bridge then posts vouchers to Tally and brings Tally's changes back, in the background.",
                   10, color="muted", wraplength=640).pack(anchor="w", pady=(6, 14))
        self.button(self.welcome, "Get started", lambda: self.show("connect")).pack(anchor="w")

        status = self.status_card = self.card(page)
        top = tk.Frame(status, bg=C["card"])
        top.pack(fill="x")
        self.dot = tk.Canvas(top, width=16, height=16, bg=C["card"], highlightthickness=0)
        self.dot.pack(side="left", padx=(0, 10))
        self.status_title = self.label(top, "Checking…", 18, "bold")
        self.status_title.pack(side="left")
        self.toggle = self.button(top, "Start", self.toggle_running)
        self.toggle.pack(side="right")
        self.button(top, "Open web app", lambda: webbrowser.open(WEB_APP), "ghost").pack(side="right", padx=8)
        self.status_detail = self.label(status, "", 10, color="muted", wraplength=640)
        self.status_detail.pack(anchor="w", pady=(10, 0))
        self.status_time = self.label(status, "", 9, color="idle")
        self.status_time.pack(anchor="w", pady=(4, 0))
        tally = tk.Frame(status, bg=C["card"])
        tally.pack(fill="x", pady=(14, 0))
        self.label(tally, "Tally Prime", 10, "bold").pack(side="left")
        self.button(tally, "Hide Tally", lambda: self.run(lambda: self.ctl.show_tally(False), "Hiding Tally…"),
                    "ghost").pack(side="right")
        self.button(tally, "Show Tally", lambda: self.run(lambda: self.ctl.show_tally(True), "Showing Tally…"),
                    "ghost").pack(side="right", padx=8)

        tiles = self.tiles_row = tk.Frame(page, bg=C["bg"])
        tiles.pack(fill="x")
        self.tiles = {}
        for i, (key, title) in enumerate((("company", "TALLY COMPANY"), ("vouchers", "FUEL VOUCHERS WATCHED"),
                                          ("revive", "AFTER A RESTART"))):
            t = tk.Frame(tiles, bg=C["card"], highlightthickness=1, highlightbackground=C["line"], padx=18, pady=14)
            t.grid(row=0, column=i, sticky="nsew", padx=(0 if i == 0 else 7, 0 if i == 2 else 7))
            tiles.columnconfigure(i, weight=1, uniform="tile")
            self.label(t, title, 8, "bold", "muted").pack(anchor="w")
            value = self.label(t, "—", 13, "bold", wraplength=200)
            value.pack(anchor="w", pady=(6, 0))
            self.tiles[key] = value
        self.problems = self.label(page, "", 10, color="warn", bg="bg", wraplength=680)
        self.problems.pack(anchor="w", pady=(14, 0))

    def paint_home(self, s):
        tone = C[s["tone"]]
        self.dot.delete("all")
        self.dot.create_oval(2, 2, 14, 14, fill=tone, outline=tone)
        self.status_title.configure(text=s["title"], fg=C["ink"])
        self.status_detail.configure(text=s["detail"] or ("Not connected yet." if not s["configured"] else ""))
        self.status_time.configure(text=("Last update " + s["at"]) if s["at"] and s["running"] else "")
        self.toggle.configure(text="Stop" if s["running"] else "Start")
        self.enable(self.toggle, s["configured"] and not self.busy)
        self.tiles["company"].configure(text=s["company"] or "Not connected")
        self.tiles["vouchers"].configure(text=f"{s['vouchers']:,}" if s["configured"] else "—")
        self.tiles["revive"].configure(text="Starts by itself" if s["autostart"] else "Waits for Start",
                                       fg=C["good"] if s["autostart"] else C["warn"])
        # Before setup only the welcome card shows; afterwards the live status and tiles.
        if s["configured"]:
            self.welcome.pack_forget()
            if not self.status_card.winfo_ismapped():
                self.status_card.pack(fill="x", pady=(0, 14), before=self.problems)
                self.tiles_row.pack(fill="x", before=self.problems)
        else:
            self.status_card.pack_forget()
            self.tiles_row.pack_forget()
            self.welcome.pack(fill="x", pady=(0, 14), before=self.problems)
        older = s["configured"] and s["installed"] and s["installed"] != s["version"]
        if older:
            self.banner_text.configure(text=f"This app is version {s['version']}, but Windows still runs bridge "
                                            f"{s['installed']} in the background. Update to switch it; the pairing and "
                                            "queued work are kept.")
            self.banner.pack(fill="x", pady=(0, 14), before=self.status_card if s["configured"] else self.welcome)
        else:
            self.banner.pack_forget()
        self.problems.configure(text="\n".join("• " + p for p in s["problems"]))

    def toggle_running(self):
        if self.snap and self.snap["running"]:
            self.run(self.ctl.stop, "Stopping…")
        else:
            self.run(self.ctl.start, "Starting…")

    def update_now(self):
        return self.ctl.save(**self.settings())

    # ---- Connect -----------------------------------------------------------------
    def build_connect(self, page):
        tk = self.tk
        self.label(page, "Connect this PC", 18, "bold", bg="bg").pack(anchor="w")
        self.connected_note = self.label(page, "", 10, color="muted", bg="bg", wraplength=680)
        self.connected_note.pack(anchor="w", pady=(4, 14))

        one = self.step(page, "1", "Open Tally Prime",
                        "Open your company in Tally Prime with its XML server on (Help → Settings → Connectivity → "
                        "Client/Server configuration: TallyPrime acts as Server, port 9000).")
        row = tk.Frame(one, bg=C["card"])
        row.pack(anchor="w", pady=(10, 0))
        self.label(row, "Port").pack(side="left")
        self.entry(row, self.v["port"], 8).pack(side="left", padx=(8, 12), ipady=5)
        self.button(row, "Check Tally", lambda: self.run(self.check_tally, "Checking Tally…"), "ghost").pack(side="left")
        self.check_result = self.label(one, "", 10, color="muted", wraplength=620)
        self.check_result.pack(anchor="w", pady=(10, 0))

        two = self.step(page, "2", "Paste the pairing code",
                        "In the web app open Tally connection → Connect PC → Create pairing package → Copy. "
                        "The code works once and for ten minutes.")
        row = tk.Frame(two, bg=C["card"])
        row.pack(fill="x", pady=(10, 0))
        self.button(row, "Paste from clipboard", self.paste, "ghost").pack(side="left")
        self.pair_state = self.label(row, "", 10, color="muted")
        self.pair_state.pack(side="left", padx=12)
        self.pair_text = tk.Text(two, height=3, font=("Consolas", 9), relief="flat", bg=C["soft"], fg=C["ink"],
                                 highlightthickness=1, highlightbackground=C["line"], wrap="char")
        self.pair_text.pack(fill="x", pady=(10, 0))
        self.pair_text.bind("<<Modified>>", self.pairing_changed)

        three = self.step(page, "3", "Choose how it runs", "")
        self.options(three)
        self.connect_button = self.button(page, "Connect and start", lambda: self.run(self.connect, "Connecting…"))
        self.connect_button.pack(anchor="w", pady=(4, 0))

    def step(self, page, number, title, text):
        tk = self.tk
        c = self.card(page, pady=(0, 12))
        head = tk.Frame(c, bg=C["card"])
        head.pack(fill="x")
        badge = tk.Canvas(head, width=26, height=26, bg=C["card"], highlightthickness=0)
        badge.create_oval(1, 1, 25, 25, fill=C["brand"], outline=C["brand"])
        badge.create_text(13, 13, text=number, fill="white", font=(FONT, 10, "bold"))
        badge.pack(side="left", padx=(0, 10))
        self.label(head, title, 12, "bold").pack(side="left")
        if text:
            self.label(c, text, 10, color="muted", wraplength=640).pack(anchor="w", pady=(6, 0))
        return c

    def options(self, parent):
        tk = self.tk
        self.checkbox(parent, "Open Tally by itself, with your company, if it is closed", self.v["auto_tally"],
                      self.paint_tally_fields).pack(anchor="w", pady=(8, 0))
        fields = tk.Frame(parent, bg=C["card"], padx=26)
        fields.pack(fill="x")
        row = tk.Frame(fields, bg=C["card"])
        row.pack(fill="x", pady=(6, 0))
        self.label(row, "Tally program").pack(side="left")
        exe = self.entry(row, self.v["exe"], 44)
        exe.pack(side="left", padx=8, ipady=4, fill="x", expand=True)
        browse = self.button(row, "Browse…", self.browse, "ghost")
        browse.pack(side="left")
        row = tk.Frame(fields, bg=C["card"])
        row.pack(fill="x", pady=(6, 0))
        self.label(row, "Company number").pack(side="left")
        number = self.entry(row, self.v["number"], 12)
        number.pack(side="left", padx=8, ipady=4)
        self.label(row, "Check Tally fills both when it can.", 9, color="idle").pack(side="left")
        hidden = self.checkbox(fields, "Keep that Tally hidden in the background (use Show Tally on Home to work in it; "
                               "shown by itself if a prompt needs attention)", self.v["hidden"])
        hidden.pack(anchor="w", pady=(6, 0))
        self.tally_widgets = getattr(self, "tally_widgets", []) + [exe, browse, number, hidden]
        self.checkbox(parent, "Keep this PC awake while the bridge runs (the screen can still lock)",
                      self.v["awake"]).pack(anchor="w", pady=(10, 0))
        self.checkbox(parent, "Auto-revive: start the bridge again by itself after Windows restarts",
                      self.v["revive"]).pack(anchor="w", pady=(4, 0))
        self.paint_tally_fields()

    def paint_tally_fields(self):
        for w in getattr(self, "tally_widgets", []):
            w.configure(state="normal" if self.v["auto_tally"].get() and not self.busy else "disabled")

    def browse(self):
        from tkinter import filedialog
        path = filedialog.askopenfilename(title="Select Tally Prime", filetypes=[("Tally Prime", "*.exe")])
        if path:
            self.v["exe"].set(path)

    def paste(self):
        try:
            text = self.root.clipboard_get()
        except self.tk.TclError:
            text = ""
        self.pair_text.delete("1.0", "end")
        self.pair_text.insert("1.0", text)
        self.pairing_changed()

    def pairing_changed(self, event=None):
        self.pair_text.edit_modified(False)
        text = self.pair_text.get("1.0", "end").strip()
        if not text:
            self.pair_state.configure(text="", fg=C["muted"])
            return
        try:
            package = Controller.read_pairing(text)
            self.pair_state.configure(text="✓ Pairing code for " + package["company"], fg=C["good"])
        except Problem:
            self.pair_state.configure(text="This is not a pairing code yet", fg=C["bad"])

    def check_tally(self):
        config = self.ctl.config()
        result = self.ctl.check_tally(self.settings()["port"], config.get("company"), config.get("guid"))
        lines = ["✓ Tally is answering. Open: " + ", ".join(result["companies"]) + "."]
        if result["vouchers"] is not None:
            lines.append(f"✓ {result['vouchers']:,} fuel vouchers readable in {result['company']}.")
        elif result["voucher_error"]:
            lines.append("✕ Vouchers could not be read: " + result["voucher_error"])
        result["text"] = "\n".join(lines)
        self.updates.put(("detected", result))
        return lines[0] if len(lines) == 1 else "Tally checked — see step 1."

    def connect(self):
        result = self.ctl.pair(self.pair_text_value, **self.settings())
        self.updates.put(("paired", None))
        return result

    # ---- Settings --------------------------------------------------------------------
    def build_settings(self, page):
        tk = self.tk
        self.label(page, "Settings", 18, "bold", bg="bg").pack(anchor="w", pady=(0, 14))
        c = self.card(page)
        row = tk.Frame(c, bg=C["card"])
        row.pack(anchor="w")
        self.label(row, "Tally port").pack(side="left")
        self.entry(row, self.v["port"], 8).pack(side="left", padx=8, ipady=4)
        self.options(c)
        self.label(c, "Saving checks Tally, then restarts the bridge with these settings. The pairing is kept.",
                   9, color="idle").pack(anchor="w", pady=(12, 0))
        row = tk.Frame(page, bg=C["bg"])
        row.pack(anchor="w")
        self.button(row, "Save settings", lambda: self.run(self.update_now, "Saving…")).pack(side="left")
        self.button(row, "Apply auto-revive only", lambda: self.run(lambda: self.ctl.set_autostart(self.v["revive"].get()),
                    "Applying…"), "ghost").pack(side="left", padx=8)
        self.label(page, "“Apply auto-revive only” works even while Tally is closed.", 9, color="idle", bg="bg").pack(
            anchor="w", pady=(8, 0))

    # ---- Activity ----------------------------------------------------------------------
    def build_activity(self, page):
        tk = self.tk
        head = tk.Frame(page, bg=C["bg"])
        head.pack(fill="x", pady=(0, 14))
        self.label(head, "Activity", 18, "bold", bg="bg").pack(side="left")
        self.button(head, "Copy for support", self.copy_support, "ghost").pack(side="right")
        c = self.card(page)
        self.activity_status = self.label(c, "", 10, wraplength=660)
        self.activity_status.pack(anchor="w")
        self.log = tk.Text(page, font=("Consolas", 9), relief="flat", bg=C["card"], fg=C["ink"], height=16,
                           highlightthickness=1, highlightbackground=C["line"], padx=14, pady=12, state="disabled")
        self.log.pack(fill="both", expand=True)

    def paint_activity(self, s):
        self.activity_status.configure(text=f"{s['title']}. {s['detail']}" + (f"  ·  {s['at']}" if s["at"] else ""))
        self.log.configure(state="normal")
        self.log.delete("1.0", "end")
        self.log.insert("1.0", "\n".join(reversed(s["log"])) or "Nothing yet. Starts, stops and restarts appear here.")
        self.log.configure(state="disabled")

    def copy_support(self):
        if self.snap:
            self.root.clipboard_clear()
            self.root.clipboard_append(self.ctl.support_text(self.snap))
            self.say("Copied. Paste it into a message for help; it holds no financial data.")

    # ---- background work ------------------------------------------------------------------
    def run(self, fn, working):
        if self.busy:
            return
        self.busy = True
        self.pair_text_value = self.pair_text.get("1.0", "end").strip()
        for b in self.buttons:
            self.enable(b, False)
        self.say(working, "idle")

        def task():
            try:
                result, tone = fn(), "good"
            except Exception as e:  # shown to the person, never a traceback
                result, tone = friendly(e), "bad"
            self.updates.put(("done", (result, tone)))
        threading.Thread(target=task, daemon=True).start()

    def refresh(self):
        if self.refreshing:
            return
        self.refreshing = True

        def task():
            try:
                self.updates.put(("snap", self.ctl.snapshot()))
            except Exception:
                self.updates.put(("snap", None))
        threading.Thread(target=task, daemon=True).start()

    def pump(self):
        try:
            while True:
                kind, value = self.updates.get_nowait()
                if kind == "done":
                    self.busy = False
                    for b in self.buttons:
                        self.enable(b, True)
                    self.paint_tally_fields()
                    self.say(*value)
                    self.refresh()
                elif kind == "snap":
                    self.refreshing = False
                    if value:
                        self.snap = value
                        self.paint_home(value)
                        self.paint_activity(value)
                        self.connected_note.configure(text=("Connected to " + value["company"] + ". Pair again only "
                                                            "for a new PC or company.") if value["configured"] else "")
                elif kind == "detected":
                    self.check_result.configure(text=value["text"], fg=C["good"] if "✕" not in value["text"] else C["bad"])
                    if value.get("exe") and not self.v["exe"].get():
                        self.v["exe"].set(value["exe"])
                    if value.get("number") and not self.v["number"].get():
                        self.v["number"].set(value["number"])
                elif kind == "paired":
                    self.pair_text.delete("1.0", "end")
                    self.show("home")
        except queue.Empty:
            pass
        if not hasattr(self, "next_refresh") or time.monotonic() >= self.next_refresh:
            self.next_refresh = time.monotonic() + 4
            self.refresh()
        self.root.after(150, self.pump)

    def close(self):
        if self.busy:
            self.say("Finishing the current step; close in a moment.", "warn")
            return
        self.root.destroy()




def run(windows, uninstall=False):
    import tkinter as tk
    from tkinter import messagebox
    windows_niceties()
    root = tk.Tk()
    if uninstall:
        root.withdraw()
        if messagebox.askyesno("Uninstall Vriddhi Tally Bridge",
                               "Stop the bridge and remove it from Windows startup? Its recovery data is kept."):
            folder = windows.uninstall()
            messagebox.showinfo("Vriddhi Tally Bridge removed",
                                "The bridge no longer starts with Windows. You can delete its folder after closing:\n"
                                + str(folder) + "\n\nDisconnect this PC in the web app if it will not be used again.")
        root.destroy()
        return
    App(root, Controller(windows))
    root.mainloop()
