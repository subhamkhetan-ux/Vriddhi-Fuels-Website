import argparse
import json
import sys
from pathlib import Path

from . import __version__
from .store import Store
from .tally import Tally
from .transport import Cloud, LocalTally
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
        recovery = Recovery(tally, c.get("tally_startup", {}), store, windows.tally_processes, windows.launch_tally,
                            show=windows.set_tally_visible)
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
    from . import windows
    from .app import run
    from .packaging import package_root, verify_package
    verify_package(package_root())
    run(windows, uninstall)


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
        root = tk.Tk(); root.withdraw(); root.update()
        # The window listing behind Show/Hide Tally, on this process's own (Tk) windows.
        assert any(cls for _, _, _, cls in windows._top_windows({__import__("os").getpid()})), "EnumWindows found no windows"
        assert windows.set_tally_visible(True, pids=[]) == 0
        root.destroy()
        if install_smoke:
            import os, winreg
            from .packaging import package_root, verify_package
            if os.environ.get("CI") != "true":
                raise RuntimeError("Installation smoke test is restricted to CI")
            verify_package(package_root())
            installed = windows.install()
            assert installed.exists()
            start_menu = Path(os.environ["APPDATA"]) / "Microsoft/Windows/Start Menu/Programs" / windows.SHORTCUT
            assert start_menu.is_file(), "Start-menu shortcut was not created"
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows\CurrentVersion\Run") as key:
                assert winreg.QueryValueEx(key, windows.APP)[0] == __import__('subprocess').list2cmdline(windows.command(installed, "--supervise"))
            startup = json.loads((windows.data_dir() / "startup.json").read_text())
            assert startup["scheduled_task"], "Windows task registration failed on CI"
            # Auto-revive off removes both the sign-in entry and the task; on brings them back.
            windows.set_autostart(False)
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows\CurrentVersion\Run") as key:
                try: winreg.QueryValueEx(key, windows.APP)
                except FileNotFoundError: pass
                else: raise AssertionError("Auto-revive off left the sign-in entry")
            assert windows.task_command("/Query", "/TN", windows.APP).returncode != 0, "Auto-revive off left the task"
            assert windows.startup_problems() == ["Auto-revive is off: the bridge starts only with Start."]
            assert windows.set_autostart(True, installed), "Task registration failed when turning auto-revive on"
            assert not windows.startup_problems(), windows.startup_problems()
            assert windows.boot_time() < __import__("time").time()
            lock = windows.SingleInstance("SmokeTest")
            try:
                try: windows.SingleInstance("SmokeTest")
                except windows.AlreadyRunning: pass
                else: raise AssertionError("Second worker lock was allowed")
            finally: lock.close()
            windows.uninstall()
            assert not start_menu.exists(), "Uninstall left the Start-menu shortcut"


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
