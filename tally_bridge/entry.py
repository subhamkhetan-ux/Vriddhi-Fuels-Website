"""PyInstaller entry point (absolute import also works in a frozen bundle)."""
from tally_bridge.cli import main

if __name__ == "__main__":
    try:
        main()
    except Exception:
        # A windowed background worker must not open a blocking traceback dialog.
        # Do not persist exception text: request/driver exceptions may contain business data.
        import sys
        try:
            from tally_bridge.windows import data_dir
            from tally_bridge.store import Store
            import time
            db = Store(data_dir() / "journal.sqlite3")
            db.set("status", {"health":"needs_attention", "at":time.time(),
                              "detail":"Bridge could not start. Open the installer, check its configuration and pair again if necessary. The journal is retained."})
            db.close()
        except Exception:
            pass
        if not any(arg in sys.argv for arg in ("--worker","--supervise","--self-test")):
            from tkinter import messagebox
            messagebox.showerror("Vriddhi Tally Bridge", "Could not start the bridge. Check the Windows account and installer version; existing recovery data is retained.")
        raise SystemExit(1)
