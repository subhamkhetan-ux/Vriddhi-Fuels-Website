import argparse
import json
import queue
import secrets
import sys
import threading
from pathlib import Path

from . import __version__
from .store import Store
from .tally import Tally, TallyProblem
from .transport import Cloud, ConnectionProblem, LocalTally
from .worker import Worker


def worker():
    from . import windows
    from .recovery import Recovery
    guard = windows.SingleInstance("Worker")
    store = None
    awake = False
    try:
        c = windows.load_config()
        store = Store(windows.data_dir() / "journal.sqlite3")
        tally = Tally(LocalTally(c["port"]), c["company"], c["guid"])
        recovery = Recovery(tally, c.get("tally_startup", {}), store, windows.tally_processes, windows.launch_tally)
        if c.get("keep_awake", False):
            windows.keep_awake(True)
            awake = True
        service = Worker(Cloud(c["url"], c["key"], c["token"]), tally, store, recovery=recovery)
        service.run(windows.StopFlag())
    finally:
        if awake:
            try:
                windows.keep_awake(False)
            except RuntimeError:
                pass
        if store:
            store.close()
        guard.close()


def gui(uninstall=False):
    import tkinter as tk
    from tkinter import filedialog, messagebox, ttk
    from . import windows
    from .recovery import startup_settings
    from .packaging import package_root, verify_package
    verify_package(package_root())
    root = tk.Tk()
    root.title("Vriddhi Fuels • Tally Bridge")
    root.geometry("690x790")
    root.minsize(620, 600)
    root.configure(bg="#fff7ef")
    if uninstall:
        if messagebox.askyesno("Uninstall bridge", "Stop background sync and remove automatic startup? The recovery journal is kept."):
            folder = windows.uninstall()
            messagebox.showinfo("Background sync removed", "Startup is removed. After closing this window you can delete the program folder:\n" + str(folder) + "\n\nThe recovery journal is retained. Revoke this PC in the web app if it will no longer be used.")
        root.destroy()
        return
    try:
        existing = windows.load_config()
    except (OSError, RuntimeError, ValueError):
        existing = {}
    outer = ttk.Frame(root); outer.pack(fill="both", expand=True)
    canvas = tk.Canvas(outer, highlightthickness=0)
    scrollbar = ttk.Scrollbar(outer, orient="vertical", command=canvas.yview)
    scrollbar.pack(side="right", fill="y"); canvas.pack(side="left", fill="both", expand=True)
    canvas.configure(yscrollcommand=scrollbar.set)
    panel = ttk.Frame(canvas, padding=22)
    window = canvas.create_window((0, 0), window=panel, anchor="nw")
    panel.bind("<Configure>", lambda event: canvas.configure(scrollregion=canvas.bbox("all")))
    canvas.bind("<Configure>", lambda event: canvas.itemconfigure(window, width=event.width))
    root.bind_all("<MouseWheel>", lambda event: canvas.yview_scroll(-int(event.delta / 120), "units"))
    ttk.Label(panel, text="Your Tally. Connected.", font=("Segoe UI", 22, "bold")).pack(anchor="w")
    ttk.Label(panel, text="Vriddhi Fuels · Bridge " + __version__, font=("Segoe UI", 11)).pack(anchor="w", pady=(2, 10))
    ttk.Label(panel, text="Open your company in Tally and enable its XML server once. Test the connection, then pair using Tally connection & reports → Connect PC in the web app.", wraplength=590).pack(anchor="w")
    pairing = tk.Text(panel, height=4, wrap="word", font=("Segoe UI", 10))
    pairing.pack(fill="x", pady=10)
    row = ttk.Frame(panel); row.pack(fill="x")
    ttk.Label(row, text="Local Tally port").pack(side="left")
    port = tk.StringVar(value=str(existing.get("port", 9000)))
    ttk.Entry(row, textvariable=port, width=10).pack(side="left", padx=10)
    saved_startup = existing.get("tally_startup", {})
    automatic = tk.BooleanVar(value=saved_startup.get("enabled", True))
    awake = tk.BooleanVar(value=existing.get("keep_awake", True))
    ttk.Checkbutton(panel, text="Start Tally minimized and reopen it if employees close it", variable=automatic).pack(anchor="w", pady=(12, 5))
    exe = tk.StringVar(value=saved_startup.get("exe", ""))
    number = tk.StringVar(value=saved_startup.get("number", ""))
    ttk.Label(panel, text="Installed Tally executable").pack(anchor="w")
    row = ttk.Frame(panel); row.pack(fill="x", pady=(3, 7))
    ttk.Entry(row, textvariable=exe).pack(side="left", fill="x", expand=True)
    ttk.Button(row, text="Browse…", command=lambda: exe.set(filedialog.askopenfilename(title="Select installed Tally", filetypes=[("Tally application", "*.exe")]) or exe.get())).pack(side="left", padx=(8, 0))
    row = ttk.Frame(panel); row.pack(fill="x")
    ttk.Label(row, text="Company folder number").pack(side="left")
    ttk.Entry(row, textvariable=number, width=14).pack(side="left", padx=10)
    ttk.Label(panel, text="Test Tally tries to detect these fields. If the number is blank, enter the numeric data-folder number shown in Tally's company selection, for example 10000.", wraplength=590).pack(anchor="w", pady=(4, 5))
    ttk.Checkbutton(panel, text="Keep this PC awake while syncing (the screen may still lock)", variable=awake).pack(anchor="w", pady=5)
    status = tk.StringVar(value="Paired configuration found. Use Upgrade / save settings to keep the current pairing." if existing else "No connection has been tested yet.")
    ttk.Label(panel, textvariable=status, wraplength=590).pack(anchor="w", pady=12)
    buttons = ttk.Frame(panel); buttons.pack(fill="x")
    busy = False
    updates = queue.Queue()

    def upgrade_note():
        # Opening a new Setup does not replace the worker Windows already starts.
        try:
            installed = windows.installed_version()
        except OSError:
            return None
        if installed and installed != __version__:
            return ("Background sync is still bridge " + installed + ". Click Upgrade / save settings to switch it to "
                    + __version__ + "; pairing and queued work are kept.")
        return None

    def read_settings(values):
        raw, p, path, num, enabled, keep = values
        startup = startup_settings(path, num) if enabled else {"enabled": False}
        return raw, int(p), startup, keep

    def background(fn):
        nonlocal busy
        if busy:
            return
        busy = True
        # Read Tk values on the UI thread; workers communicate only through the queue.
        values = pairing.get("1.0", "end").strip(), port.get(), exe.get(), number.get(), automatic.get(), awake.get()
        status.set("Checking…")
        def task():
            try:
                result = fn(values)
            except (TallyProblem, RuntimeError) as e:
                result = str(e)
            except (ValueError, KeyError, ConnectionProblem, OSError):
                result = "Could not complete setup. Check Tally, the package, Windows Security, Internet access and the pairing code. Your journal is retained."
            except Exception:
                result = "Setup could not finish. Check Status and try again; your pairing data and recovery journal have not been erased."
            updates.put(("result", result))
        threading.Thread(target=task, daemon=True).start()

    def tick():
        nonlocal busy
        try:
            while True:
                action, value = updates.get_nowait()
                if action == "result":
                    busy = False; status.set(value)
                elif action == "detected":
                    path, num = value
                    if path and not exe.get(): exe.set(path)
                    if num and not number.get(): number.set(num)
                elif action == "clear_pair":
                    pairing.delete("1.0", "end")
        except queue.Empty:
            pass
        root.after(100, tick)
    root.after(100, tick)
    root.protocol("WM_DELETE_WINDOW", lambda: status.set("Finishing setup; please wait before closing.") if busy else root.destroy())

    def test(values):
        raw, p, path, num, enabled, keep = values
        tally = Tally(LocalTally(p), existing.get("company", ""), existing.get("guid"))
        companies = tally.companies()
        target = next((c for c in companies if c["name"] == existing.get("company")), companies[0] if len(companies) == 1 else None)
        found_number, vouchers = None, ""
        if target:
            tally.company, tally.guid = target["name"], target["guid"]
            try:
                found_number = tally.startup_number()
            except (TallyProblem, ConnectionProblem):
                pass  # Optional discovery; never invent a company number.
            # The same read the background sync makes, so a problem shows here first.
            try:
                count = len(tally.metadata())
                vouchers = f" {count:,} HSD/MS/XG CREDIT vouchers can be watched in {target['name']}."
            except TallyProblem as e:
                vouchers = " Voucher read failed: " + str(e)
        paths = {p["exe"] for p in windows.tally_processes() if p.get("exe")}
        updates.put(("detected", (next(iter(paths)) if len(paths) == 1 else None, found_number)))
        return "Tally is reachable. Open companies: " + ", ".join(c["name"] for c in companies if c["name"]) + "." + vouchers + (" Confirm the startup path and company number below." if enabled else "")

    def finish_install(config):
        windows.save_config(config)
        installed = windows.install()
        windows.start(installed)
        startup = json.loads((windows.data_dir() / "startup.json").read_text())
        fallback = " Windows policy did not allow the recovery task; sign-in startup is registered instead." if not startup["scheduled_task"] else ""
        return "Background sync is running. You may close this window. Windows must remain signed in; locking the screen is fine." + fallback

    def pair(values):
        raw, p, startup, keep = read_settings(values)
        package = json.loads(raw)
        if package.get("protocol") != 1:
            raise ValueError("Unsupported pairing package")
        tally = Tally(LocalTally(p), package["company"])
        company = tally.verify()
        token = secrets.token_hex(32)
        config = dict(url=package["url"], key=package["key"], company=company["name"], guid=company["guid"], token=token,
                      port=p, tally_startup=startup, keep_awake=keep)
        cloud = Cloud(config["url"], config["key"])
        windows.stop_before_pairing()
        # Retain the candidate token before the request so a lost response is recoverable.
        windows.save_config(config)
        cloud.rpc("tally_bridge_pair", p_code=package["code"], p_token=token,
                  p_company=company["name"], p_guid=company["guid"], p_label=__import__("socket").gethostname())
        result = finish_install(config)
        updates.put(("clear_pair", None))
        return result

    def upgrade(values):
        raw, p, startup, keep = read_settings(values)
        config = windows.load_config()
        # Verify identity while Tally is open; no need to revoke/re-pair this device.
        Tally(LocalTally(p), config["company"], config["guid"]).verify()
        windows.stop_before_pairing()
        config.update(port=p, tally_startup=startup, keep_awake=keep)
        return finish_install(config)

    ttk.Button(buttons, text="Test Tally", command=lambda: background(test)).pack(side="left", padx=(0, 8))
    ttk.Button(buttons, text="Install & pair", command=lambda: background(pair)).pack(side="left", padx=(0, 8))
    ttk.Button(buttons, text="Upgrade / save settings", command=lambda: background(upgrade)).pack(side="left")

    def restart(values):
        windows.load_config()
        windows.start()
        return "Bridge started. Automatic Tally recovery uses your saved settings."

    def show_status(values):
        db = Store(windows.data_dir() / "journal.sqlite3")
        try:
            state = db.get("status", {})
        finally:
            db.close()
        labels = {"online": "Syncing", "syncing": "Syncing", "internet_offline": "Internet offline",
                  "starting_tally": "Starting Tally", "needs_attention": "Needs attention",
                  "off": "Bridge off"}
        notes = [n for n in (upgrade_note(), None if windows.worker_running() else
                             "Background sync is not running. Click Start (or Upgrade / save settings).") if n]
        if not state:
            return " ".join(notes + ["Waiting for the first sync."])
        when = __import__("datetime").datetime.fromtimestamp(state.get("at", 0)).strftime("%d %b %H:%M:%S")
        writer = state.get("version") or "1.0.x"
        line = (labels.get(state.get("health"), "Status") + " (" + when + ", bridge " + writer + "): "
                + state.get("detail", ""))
        if writer != __version__:
            line += "  [This message is from an older bridge and is out of date.]"
        return " ".join(notes + [line])

    row = ttk.Frame(panel); row.pack(fill="x", pady=10)
    if existing and (note := upgrade_note()):
        status.set(note)
    ttk.Button(row, text="Status", command=lambda: background(show_status)).pack(side="left")
    ttk.Button(row, text="Start", command=lambda: background(restart)).pack(side="left", padx=8)
    ttk.Button(row, text="Stop", command=lambda: (windows.stop(), status.set("Stopping after the current request. Queued work stays safe.")) if not busy else None).pack(side="left")
    ttk.Label(panel, text="Tally must still run as the data engine; the bridge can start it minimized. It never closes a running Tally session. A password, licence prompt or repair dialog may require attention. Keep Defender enabled.", wraplength=590).pack(anchor="w", pady=4)
    root.mainloop()


def self_test(install_smoke=False):
    import tempfile
    from .tally import parse, sanitize_report
    assert parse("<ENVELOPE/>").find("ENVELOPE") is not None
    assert "<script" not in sanitize_report("<table><tr><td>OK</td></tr></table><script>x()</script>")
    with tempfile.TemporaryDirectory() as tmp:
        db = Store(Path(tmp) / "test.sqlite3")
        db.set("test", "ok"); assert db.get("test") == "ok"; db.close()
    if sys.platform == "win32":
        from . import windows
        assert windows.crypt(windows.crypt(b"test-only"), decrypt=True) == b"test-only"
        assert windows.user_sid().startswith("S-1-")
        windows.tally_processes()
        windows.keep_awake(True); windows.keep_awake(False)
        import tkinter as tk
        root = tk.Tk(); root.withdraw(); root.update(); root.destroy()
        if install_smoke:
            import os, winreg
            from .packaging import package_root, verify_package
            if os.environ.get("CI") != "true":
                raise RuntimeError("Installation smoke test is restricted to CI")
            verify_package(package_root())
            installed = windows.install()
            assert installed.exists()
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows\CurrentVersion\Run") as key:
                assert winreg.QueryValueEx(key, windows.APP)[0] == __import__('subprocess').list2cmdline(windows.command(installed, "--supervise"))
            startup = json.loads((windows.data_dir() / "startup.json").read_text())
            assert startup["scheduled_task"], "Windows task registration failed on CI"
            lock = windows.SingleInstance("SmokeTest")
            try:
                try: windows.SingleInstance("SmokeTest")
                except windows.AlreadyRunning: pass
                else: raise AssertionError("Second worker lock was allowed")
            finally: lock.close()
            windows.uninstall()


def main():
    parser = argparse.ArgumentParser(description="Vriddhi Fuels Tally Prime bridge")
    parser.add_argument("--worker", action="store_true")
    parser.add_argument("--supervise", action="store_true")
    parser.add_argument("--uninstall", action="store_true")
    parser.add_argument("--self-test", action="store_true", help="Offline package integrity test; no live accounting writes")
    parser.add_argument("--install-smoke-test", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--version", action="version", version=__version__)
    args = parser.parse_args()
    if args.self_test:
        self_test(args.install_smoke_test)
    elif args.worker:
        worker()
    elif args.supervise:
        from .windows import supervise
        supervise()
    else:
        gui(args.uninstall)


if __name__ == "__main__":
    main()
