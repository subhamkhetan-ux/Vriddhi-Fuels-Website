import argparse
import json
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
    guard = windows.SingleInstance("Worker")
    store = None
    try:
        c = windows.load_config()
        store = Store(windows.data_dir() / "journal.sqlite3")
        service = Worker(Cloud(c["url"], c["key"], c["token"]),
                         Tally(LocalTally(c["port"]), c["company"], c["guid"]), store)
        service.run(windows.StopFlag())
    finally:
        if store:
            store.close()
        guard.close()


def gui(uninstall=False):
    import tkinter as tk
    from tkinter import messagebox, ttk
    from . import windows
    root = tk.Tk()
    root.title("Vriddhi Fuels • Tally Bridge")
    root.geometry("630x570")
    root.minsize(550, 500)
    root.configure(bg="#fff7ef")
    if uninstall:
        if messagebox.askyesno("Uninstall bridge", "Stop automatic sync and remove the bridge?\n\nThe recovery journal is kept. Revoke this PC in the web app if it will no longer be used."):
            windows.uninstall()
        root.destroy()
        return
    panel = ttk.Frame(root, padding=24)
    panel.pack(fill="both", expand=True, padx=16, pady=16)
    ttk.Label(panel, text="Your Tally. Connected.", font=("Segoe UI", 23, "bold")).pack(anchor="w")
    ttk.Label(panel, text="Vriddhi Fuels  ·  Bridge " + __version__, font=("Segoe UI", 11)).pack(anchor="w", pady=(4, 18))
    ttk.Label(panel, text="1. Open Vriddhi Fuels in Tally Prime. Enable its XML server.\n2. In the web app, open Tally connection → Pair Windows PC.\n3. Paste the pairing package below (valid for 10 minutes).", wraplength=540).pack(anchor="w")
    pairing = tk.Text(panel, height=5, wrap="word", font=("Segoe UI", 10))
    pairing.pack(fill="x", pady=12)
    row = ttk.Frame(panel)
    row.pack(fill="x")
    ttk.Label(row, text="Local Tally port").pack(side="left")
    port = tk.StringVar(value="9000")
    ttk.Entry(row, textvariable=port, width=10).pack(side="left", padx=10)
    status = tk.StringVar(value="No connection has been tested yet.")
    ttk.Label(panel, textvariable=status, wraplength=530).pack(anchor="w", pady=18)
    buttons = ttk.Frame(panel)
    buttons.pack(fill="x")
    busy = False

    def background(fn):
        nonlocal busy
        if busy:
            return
        busy = True
        values = pairing.get("1.0", "end").strip(), port.get()
        status.set("Checking…")
        def task():
            try:
                result = fn(*values)
            except (TallyProblem, RuntimeError) as e:
                result = str(e)
            except (ValueError, KeyError, ConnectionProblem, OSError):
                result = "Could not complete setup. Check Tally's company/port, Internet access, the database migration and pairing code. Your journal is retained."
            def complete():
                nonlocal busy
                busy = False
                status.set(result)
            root.after(0, complete)
        threading.Thread(target=task, daemon=True).start()

    def test(raw, p):
        companies = Tally(LocalTally(p), "").companies()
        return "Tally is reachable. Open companies: " + ", ".join(c["name"] for c in companies)

    def pair(raw, p):
        package = json.loads(raw)
        if package.get("protocol") != 1:
            raise ValueError("Unsupported pairing package")
        tally = Tally(LocalTally(p), package["company"])
        company = tally.verify()
        token = secrets.token_hex(32)
        config = dict(url=package["url"], key=package["key"], company=company["name"], guid=company["guid"], token=token, port=int(p))
        cloud = Cloud(config["url"], config["key"])
        windows.stop_before_pairing()
        # Keep the candidate token before the request so a lost pair response is recoverable.
        windows.save_config(config)
        cloud.rpc("tally_bridge_pair", p_code=package["code"], p_token=token,
                  p_company=company["name"], p_guid=company["guid"], p_label=__import__("socket").gethostname())
        exe = windows.install()
        windows.start(exe)
        root.after(0, lambda: pairing.delete("1.0", "end"))
        return "Paired to " + company["name"] + ". The first sync is running. New web vouchers post after that sync completes. You may close this window."

    ttk.Button(buttons, text="Test Tally", command=lambda: background(test)).pack(side="left", padx=(0, 8))
    ttk.Button(buttons, text="Install & pair", command=lambda: background(pair)).pack(side="left")

    def restart():
        try:
            windows.load_config()
            windows.start(Path(sys.executable))
            status.set("Bridge started. Keep Tally Prime open and this Windows user signed in.")
        except (OSError, RuntimeError):
            status.set("Pair this PC first.")

    def show_status():
        try:
            db = Store(windows.data_dir() / "journal.sqlite3")
            s = db.get("status", {})
            db.close()
            status.set(s.get("detail", "Waiting for the first sync."))
        except (OSError, RuntimeError):
            status.set("Pair this PC first.")
    row = ttk.Frame(panel)
    row.pack(fill="x", pady=12)
    ttk.Button(row, text="Status", command=show_status).pack(side="left")
    ttk.Button(row, text="Start", command=restart).pack(side="left", padx=8)
    ttk.Button(row, text="Stop", command=lambda: (windows.stop(), status.set("Stopping after the current request; queued work stays safe."))).pack(side="left")
    ttk.Label(panel, text="Starts automatically after Windows sign-in. Tally must be open.\nInternet or PC offline? The cloud retains pending vouchers; the PC journal resumes uploads when connected.", wraplength=530).pack(anchor="w", pady=10)
    root.mainloop()


def main():
    parser = argparse.ArgumentParser(description="Vriddhi Fuels Tally Prime bridge")
    parser.add_argument("--worker", action="store_true")
    parser.add_argument("--supervise", action="store_true")
    parser.add_argument("--uninstall", action="store_true")
    parser.add_argument("--self-test", action="store_true", help="Offline package integrity smoke test; no live accounting writes")
    parser.add_argument("--install-smoke-test", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--version", action="version", version=__version__)
    args = parser.parse_args()
    if args.self_test:
        import tempfile
        from .tally import parse, sanitize_report
        assert parse("<ENVELOPE/>").find("ENVELOPE") is not None
        assert "<script" not in sanitize_report("<html><table><tr><td>OK</td></tr></table><script>x()</script></html>")
        with tempfile.TemporaryDirectory() as tmp:
            db = Store(Path(tmp) / "test.sqlite3")
            db.set("test", "ok")
            assert db.get("test") == "ok"
            db.close()
        if sys.platform == "win32":
            from .windows import crypt
            assert crypt(crypt(b"test-only"), decrypt=True) == b"test-only"
            if args.install_smoke_test:
                import os
                if os.environ.get("CI") != "true" or not getattr(sys,"frozen",False):
                    raise RuntimeError("Installation smoke test is restricted to packaged CI builds")
                import winreg
                from .windows import APP, install, uninstall, SingleInstance
                installed = install()
                assert installed.exists()
                with winreg.OpenKey(winreg.HKEY_CURRENT_USER,r"Software\Microsoft\Windows\CurrentVersion\Run") as key:
                    assert winreg.QueryValueEx(key,APP)[0] == f'"{installed}" --supervise'
                lock = SingleInstance("SmokeTest")
                try:
                    try:
                        SingleInstance("SmokeTest")
                    except RuntimeError:
                        pass
                    else:
                        raise AssertionError("Second worker lock was allowed")
                finally:
                    lock.close()
                uninstall()
        return
    if args.worker:
        worker()
    elif args.supervise:
        from .windows import supervise
        supervise()
    else:
        gui(args.uninstall)


if __name__ == "__main__":
    main()
