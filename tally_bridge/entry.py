"""Readable entry point used by the signed, bundled Python runtime."""
import sys
from .cli import main


def run():
    try:
        main()
    except Exception as e:
        from .windows import AlreadyRunning
        if isinstance(e, AlreadyRunning):
            return  # Registry/task recovery racing an existing supervisor is harmless.
        if "--self-test" in sys.argv:
            raise  # Offline CI diagnostics contain no live credentials or financial requests.
        try:
            from .windows import data_dir
            from .store import Store
            import time
            db = Store(data_dir() / "journal.sqlite3")
            db.set("status", {"health": "needs_attention", "at": time.time(),
                              "detail": "Bridge could not start. Check setup, package verification and Windows Security. The journal is retained."})
            db.close()
        except Exception:
            pass
        if not any(arg in sys.argv for arg in ("--worker", "--supervise", "--self-test")):
            from tkinter import messagebox
            messagebox.showerror("Vriddhi Tally Bridge", "Could not start the bridge. Use a fresh official ZIP, check Windows Security and the Windows account. Do not disable Defender. Existing recovery data is retained.")
        raise SystemExit(1)


if __name__ == "__main__":
    run()
