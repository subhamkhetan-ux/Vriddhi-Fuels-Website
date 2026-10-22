"""What the bridge app does, without any window code: check Tally, pair, save settings,
start/stop and report status. The app (app.py) runs these off the UI thread."""
import datetime as dt
import json
import re
import secrets
import socket

from . import __version__
from .store import Store
from .tally import Tally, TallyProblem
from .transport import Cloud, ConnectionProblem, LocalTally

WEB_APP = "https://subhamkhetan-ux.github.io/Vriddhi-Fuels-Website/tally/"
HEALTH = {"online": ("Running", "good"), "syncing": ("Running", "good"),
          "tally_closed": ("Running · waiting for Tally", "good"), "paused": ("Running · paused for the Tally export", "good"), "internet_offline": ("Internet offline", "warn"),
          "starting_tally": ("Starting Tally", "warn"), "needs_attention": ("Needs attention", "bad"),
          "off": ("Sync switched off in the web app", "idle")}


class Problem(RuntimeError):
    """A message written for the person using the app."""


def friendly(error):
    if isinstance(error, (Problem, TallyProblem)):
        return str(error)
    if isinstance(error, ConnectionProblem):
        return str(error) if str(error) and "HTTP" not in str(error) else "The internet or Tally did not answer. Check both and try again."
    if isinstance(error, RuntimeError) and str(error):
        return str(error)
    return "That did not finish. Nothing was lost; check Tally and the internet, then try again."


def valid_port(port):
    try:
        port = int(port)
    except (TypeError, ValueError):
        port = 0
    if not 1024 <= port <= 65535:
        raise Problem("The Tally port is a number between 1024 and 65535, usually 9000.")
    return port


class Controller:
    def __init__(self, windows):
        self.win = windows

    # ---- what is set up -------------------------------------------------
    def config(self):
        try:
            return self.win.load_config()
        except (OSError, RuntimeError, ValueError):
            return {}

    def snapshot(self):
        """Everything the home screen shows, read fresh each time."""
        config = self.config()
        state, count = {}, 0
        try:
            db = Store(self.win.data_dir() / "journal.sqlite3")
            try:
                state, count = db.get("status", {}) or {}, db.count("Voucher")
            finally:
                db.close()
        except Exception:
            pass
        running = self.win.worker_running()
        writer = state.get("version") or ""
        if not config:
            title, tone = "Not set up yet", "idle"
        elif not running:
            title, tone = "Stopped", "bad"
        else:
            title, tone = HEALTH.get(state.get("health"), ("Starting", "warn"))
        if running and writer and writer != __version__:
            title, tone = "Running an older version", "warn"
        startup = self.win.startup_state()
        return {
            "configured": bool(config), "running": running, "title": title, "tone": tone,
            "detail": state.get("detail", "") if running else ("" if not config else "Choose Start to run the bridge."),
            "at": dt.datetime.fromtimestamp(state["at"]).strftime("%d %b, %I:%M %p") if state.get("at") else "",
            "company": config.get("company", ""), "vouchers": count,
            "autostart": startup["autostart"], "problems": self.win.startup_problems() if config else [],
            "installed": self.win.installed_version(), "version": __version__,
            "keep_awake": config.get("keep_awake", True), "port": config.get("port", 9000),
            "tally": config.get("tally_startup", {}) or {}, "log": self.win.recent_log(40),
        }

    # ---- Tally --------------------------------------------------------------
    def check_tally(self, port, company=None, guid=None):
        """Reachability, the company, voucher access and the details auto-start needs."""
        port = valid_port(port)
        tally = Tally(LocalTally(port), company or "", guid)
        try:
            companies = [c for c in tally.companies() if c["name"]]
        except ConnectionProblem:
            raise Problem(f"Tally is not answering on port {port}. Open Tally Prime with your company, and turn on "
                          "its XML server (F1 Help → Settings → Connectivity → TallyPrime acts as: Server, port 9000).") from None
        if not companies:
            raise Problem("Tally is open but no company is loaded. Open your company in Tally Prime.")
        target = next((c for c in companies if c["name"] == company), companies[0] if len(companies) == 1 else None)
        result = {"companies": [c["name"] for c in companies], "company": target["name"] if target else "",
                  "vouchers": None, "voucher_error": "", "number": None, "exe": None}
        if target:
            tally.company, tally.guid = target["name"], target["guid"]
            try:
                result["number"] = tally.startup_number()
            except (TallyProblem, ConnectionProblem):
                pass  # optional discovery; never invent a company number
            try:
                result["vouchers"] = len(tally.metadata())
            except TallyProblem as e:
                result["voucher_error"] = str(e)
        try:
            paths = {p["exe"] for p in self.win.tally_processes() if p.get("exe")}
            result["exe"] = next(iter(paths)) if len(paths) == 1 else None
        except (OSError, RuntimeError):
            pass
        return result

    # ---- pairing ------------------------------------------------------------
    @staticmethod
    def read_pairing(text):
        """The pairing package copied from the web app (the JSON text, or text around it)."""
        found = re.search(r"\{.*\}", text or "", re.S)
        try:
            package = json.loads(found[0]) if found else None
        except ValueError:
            package = None
        if not isinstance(package, dict) or package.get("protocol") != 1 or not all(
                isinstance(package.get(k), str) and package[k] for k in ("url", "key", "company", "code")):
            raise Problem("That is not a pairing code. In the web app open Tally connection → Connect PC → "
                          "Create pairing package, choose Copy, then Paste here.")
        return package

    def startup(self, auto_tally, exe, number, hidden=False):
        from .recovery import startup_settings
        return startup_settings(exe, number, hidden) if auto_tally else {"enabled": False}

    def pair(self, text, port, auto_tally, exe, number, keep_awake, autostart, hidden=False, single=False):
        package = self.read_pairing(text)
        port = valid_port(port)
        startup = self.startup(auto_tally, exe, number, hidden)
        tally = Tally(LocalTally(port), package["company"])
        try:
            company = tally.verify()
        except ConnectionProblem:
            raise Problem(f"Tally is not answering on port {port}. Open {package['company']} in Tally Prime first.") from None
        except TallyProblem:
            raise Problem(f"Open “{package['company']}” in Tally Prime — that is the company the web app expects.") from None
        token = secrets.token_hex(32)
        config = dict(url=package["url"], key=package["key"], company=company["name"], guid=company["guid"], token=token,
                      port=port, tally_startup=startup, keep_awake=keep_awake, single_tally=single)
        cloud = Cloud(config["url"], config["key"])
        self.win.stop_before_pairing()
        # Retain the candidate token before the request so a lost response is recoverable.
        self.win.save_config(config)
        cloud.rpc("tally_bridge_pair", p_code=package["code"], p_token=token,
                  p_company=company["name"], p_guid=company["guid"], p_label=socket.gethostname())
        return self.install(config, autostart)

    def save(self, port, auto_tally, exe, number, keep_awake, autostart, hidden=False, single=False):
        """Save settings and (re)install this version; the pairing is kept."""
        config = self.config()
        if not config:
            raise Problem("Connect this PC first.")
        port = valid_port(port)
        startup = self.startup(auto_tally, exe, number, hidden)
        try:
            Tally(LocalTally(port), config["company"], config["guid"]).verify()
        except ConnectionProblem:
            raise Problem(f"Tally is not answering on port {port}. Open {config['company']} in Tally Prime, then save again.") from None
        self.win.stop_before_pairing()
        config.update(port=port, tally_startup=startup, keep_awake=keep_awake, single_tally=single)
        return self.install(config, autostart)

    def install(self, config, autostart):
        self.win.save_config(config)
        installed = self.win.install(autostart=autostart)
        self.win.start(installed)
        state = self.win.startup_state()
        note = ("It starts by itself whenever Windows restarts." if state["autostart"]
                else "Auto-revive is off: after a restart, open this app and choose Start.")
        if state["autostart"] and not state["scheduled_task"]:
            note += " (Windows refused the scheduled task; the sign-in entry starts it instead.)"
        return "Connected to " + config["company"] + ". The bridge is running in the background. " + note

    # ---- running ------------------------------------------------------------
    def start(self):
        if not self.config():
            raise Problem("Connect this PC first.")
        self.win.start()
        return "Started. It runs in the background; you can close this window."

    def show_tally(self, visible):
        """Bring Tally's window up for someone to use it, or put it back in the background."""
        if not self.win.tally_processes():
            raise Problem("Tally is not running." + (" The bridge opens it by itself." if
                          (self.config().get("tally_startup") or {}).get("enabled") else ""))
        try:
            changed = self.win.set_tally_visible(visible)
        except (OSError, RuntimeError):
            raise Problem("Windows did not let the bridge change Tally's window.") from None
        if visible:
            return "Tally is on screen." if changed else "Tally is already on screen."
        return ("Tally is running in the background. Use Show Tally here to work in it — opening it again "
                "from its own icon would start a second copy.") if changed else "Tally has no window on screen to hide."

    def stop(self):
        self.win.stop()
        return ("Stopping after the current step. " + ("It starts again after the next Windows restart."
                if self.win.startup_state()["autostart"] else "It stays stopped until you choose Start."))

    def set_autostart(self, on):
        self.win.set_autostart(on)
        return ("Auto-revive on: the bridge starts by itself after every Windows restart." if on
                else "Auto-revive off: after a restart the bridge waits for you to choose Start.")

    def support_text(self, snap):
        lines = [f"Vriddhi Tally Bridge {__version__} (background: {snap['installed'] or 'not installed'})",
                 f"Status: {snap['title']} — {snap['detail']} ({snap['at']})",
                 f"Company: {snap['company'] or '—'} · vouchers watched: {snap['vouchers']} · auto-revive: {'on' if snap['autostart'] else 'off'}"]
        lines += snap["problems"] + ["", "Recent activity:"] + snap["log"][-20:]
        return "\n".join(lines)
