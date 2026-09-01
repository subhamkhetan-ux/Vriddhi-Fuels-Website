"""XtraPower CCMS balance monitor — attach-and-watch edition.

You log into each account by hand in its own Chrome window (launched by
``launch.py`` with a remote-debugging port) and leave it on the
**Financials → Balance Info** screen. This script attaches to those windows
over CDP and, every ``poll_seconds`` (default 120s):

  1. clicks **Search** to refresh the balance,
  2. reads the **CCMS** value from the results table,
  3. sends a Telegram message the moment CCMS changes, and
  4. sends a Telegram alert on any trouble — session timeout / logout, the
     Chrome window being closed, the Search button vanishing (a site change),
     or the F5 firewall blocking the connection.

Multiple accounts are watched at once — one Chrome window (one port) each.

Run:  python -m xtrapower.monitor --config xtrapower/config.json
Test: python -m xtrapower.monitor --config xtrapower/config.json --once
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import time
from datetime import datetime, timezone
from typing import Any

from . import browser, parse, state
from .notify import Telegram

log = logging.getLogger("xtrapower.monitor")

# Re-alert the same persistent error at most this often (default 30 min), so a
# closed browser or an expired session doesn't spam the phone every cycle.
ERROR_COOLDOWN_SECONDS = 30 * 60


def _now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def load_config(path: str) -> dict[str, Any]:
    with open(path, encoding="utf-8") as f:
        cfg = json.load(f)
    cfg.setdefault("poll_seconds", 120)
    cfg.setdefault("accounts", [])
    cfg.setdefault("telegram", {})
    return cfg


async def check_account(
    pool: browser.BrowserPool,
    acct_cfg: dict[str, Any],
    st: dict[str, Any],
    tg: Telegram,
    ready: dict[str, bool],
) -> None:
    """Run one check for one account and fire any Telegram messages.

    All failure modes are caught and turned into (de-duplicated) alerts — a
    single bad account must never take down the loop or the other accounts.

    ``ready`` is per-run (in-memory) hand-over state, keyed by customer id. An
    account starts *not ready* every run, so the monitor waits **quietly** while
    you log in — a not-yet-logged-in window is "awaiting hand-over", not an
    error. The first clean CCMS read flips it to ready and sends a ✅ "now
    watching" confirmation; only after that do logout / closed-window / site
    problems on that account turn into ⚠️ alerts. A problem then flips it back
    to not-ready, so it goes quiet again until you log back in (and re-confirms
    when you do). This makes "log in one account, hand it over, log in the next"
    work without false alerts, and survives relaunching Chrome each session.
    """
    label = acct_cfg.get("label") or acct_cfg.get("customer_id") or "account"
    cid = str(acct_cfg.get("customer_id") or label)
    port = int(acct_cfg["cdp_port"])
    acct_state = state.account(st, cid)
    now = time.time()

    def alert_error(signature: str, message: str) -> None:
        if state.should_alert_error(acct_state, signature, now, ERROR_COOLDOWN_SECONDS):
            tg.send(f"⚠️ <b>{label}</b> ({cid})\n{message}")
        state.record_error(acct_state, signature, now, _now_iso())
        log.warning("[%s] %s", label, message)

    def not_usable(signature: str, message: str, waiting_log: str) -> None:
        """The window can't be watched right now (not logged in, closed, …).

        Before the account has been handed over this run, that's expected — you
        just haven't logged in yet — so it stays quiet (log only). Once it *was*
        being watched, the same condition is a real ⚠️ alert; we then flip it
        back to not-ready so it waits quietly until you log in again (and
        re-confirms with a ✅ when you do), instead of alerting every cycle.
        """
        if ready.get(cid):
            alert_error(signature, message)
            ready[cid] = False
        else:
            log.info("[%s] awaiting hand-over: %s", label, waiting_log)

    def confirm_watching(old: str | None, new: str, when: str) -> None:
        """✅ First clean read this run — hand-over confirmed."""
        ready[cid] = True
        state.clear_error(acct_state)
        if old is not None and parse.ccms_increased(old, new):
            tg.send(
                f"✅ <b>{label}</b> ({cid}) — now watching.\n"
                f"🟢 CCMS credited since last check: {old} → <b>{new}</b>\n"
                f"<i>{when}</i>"
            )
        else:
            tg.send(
                f"✅ <b>{label}</b> ({cid}) — now watching. Current CCMS <b>{new}</b>.\n"
                "You'll get a 🟢 alert on the next credit."
            )
        log.info("[%s] handed over, watching (CCMS=%s)", label, new)

    # Optional stored credentials → the monitor can log itself back in when the
    # portal's fixed session timeout (~30-45 min) kicks it out, so it runs
    # unattended for hours. Only used when both are set (login is user+password,
    # no OTP/captcha). Without them, behaviour is manual hand-over as before.
    creds_user = acct_cfg.get("username")
    creds_pass = acct_cfg.get("password")
    has_creds = bool(creds_user and creds_pass)
    nav_labels = acct_cfg.get("nav_labels") or browser.DEFAULT_NAV_LABELS

    async def try_relogin(pg) -> str:
        # Back off after a reCAPTCHA wall so we don't re-tick the box every
        # cycle (which could get the account/IP flagged) — wait for a human.
        if acct_state.get("captcha_until_epoch", 0) > now:
            return browser.LOGIN_CAPTCHA
        log.info("[%s] session expired — attempting auto re-login", label)
        status = await browser.do_login(pg, creds_user, creds_pass)
        if status == browser.LOGIN_OK:
            acct_state.pop("captcha_until_epoch", None)
            await browser.navigate_to_balance(pg, nav_labels)
            log.info("[%s] auto re-login succeeded", label)
        elif status == browser.LOGIN_CAPTCHA:
            acct_state["captcha_until_epoch"] = now + 600  # 10-min back-off
        return status

    def relogin_failed_alert(status: str) -> None:
        if status == browser.LOGIN_CAPTCHA:
            alert_error(
                "login-captcha",
                "The portal login is showing a reCAPTCHA (\"I'm not a robot\") that "
                "I can't clear on my own. Please sign in by hand in this account's "
                "Chrome window and open Balance Info — I'll take over automatically "
                "once you're there. (I'll pause auto-login attempts for 10 min.)",
            )
        else:
            alert_error(
                "auto-login-failed",
                "Auto re-login didn't go through. Check the saved username/password "
                "for this account, or log in by hand — I'll keep trying.",
            )
        ready[cid] = False

    try:
        page = await pool.find_portal_page(port)
    except Exception as exc:  # noqa: BLE001 — Chrome closed / port not listening
        pool.drop(port)
        not_usable(
            "chrome-unreachable",
            f"Can't reach Chrome on debug port {port}. Is that window still "
            f"open? Re-run launch.py and log in again.\n<code>{exc}</code>",
            f"Chrome window on port {port} not open yet",
        )
        return

    if page is None:
        not_usable(
            "no-page",
            f"Chrome on port {port} has no open tab. Open {browser.PORTAL_HINT} "
            "and log in to the Balance Info screen.",
            f"no tab open on port {port} yet",
        )
        return

    # Read current state before clicking, to catch WAF / logout screens.
    try:
        pre = await browser.read_page(page, settle_ms=0)
    except Exception as exc:  # noqa: BLE001
        not_usable("read-failed", f"Couldn't read the page.\n<code>{exc}</code>",
                   "page not readable yet")
        return

    # A firewall block is a real network problem worth surfacing even during
    # hand-over, so it always alerts (and drops the account back to waiting).
    if parse.detect_waf_block(pre.text):
        alert_error(
            "waf-block",
            "The site firewall (F5) is rejecting this connection. Scripted "
            "refresh won't work from this network right now.",
        )
        ready[cid] = False
        return

    just_logged_in = False
    if parse.detect_logout(pre.text, pre.url):
        if not has_creds:
            not_usable(
                "logged-out",
                "Looks logged out / session expired. Please log back in and return "
                "to the Balance Info screen.",
                "not logged in yet",
            )
            return
        status = await try_relogin(page)
        if status != browser.LOGIN_OK:
            relogin_failed_alert(status)
            return
        just_logged_in = True

    clicked = await browser.click_search(page)
    if not clicked:
        # We may be logged in but not on Balance Info (just landed on Quick
        # Links, a tab drifted, or a popup is covering Search). Clear popups,
        # walk the menu, and retry once.
        await browser.navigate_to_balance(page, nav_labels)
        clicked = await browser.click_search(page)
    if not clicked:
        if just_logged_in or ready.get(cid):
            alert_error(
                "nav-failed",
                "Couldn't reach Balance Info / find the <b>Search</b> button after "
                "navigating (Financials → Balance Info). The menu path may differ on "
                "your build — send me the exact menu names and I'll set "
                "<code>nav_labels</code>.",
            )
            ready[cid] = False
        else:
            not_usable(
                "no-search-button",
                "Couldn't find the <b>Search</b> button on the Balance Info screen. "
                "The portal layout may have changed, or the tab isn't on Balance Info.",
                "Search button not present yet (not on Balance Info?)",
            )
        return

    reading = await browser.read_page(page)

    # A logout can also surface only after the click. Try one in-cycle re-login.
    if parse.detect_logout(reading.text, reading.url):
        status = await try_relogin(page) if has_creds else browser.LOGIN_FAILED
        if status == browser.LOGIN_OK:
            await browser.click_search(page)
            reading = await browser.read_page(page)
        if parse.detect_logout(reading.text, reading.url):
            if has_creds:
                relogin_failed_alert(status)
            else:
                not_usable(
                    "logged-out",
                    "Session dropped during refresh. Please log back in and return "
                    "to the Balance Info screen.",
                    "not logged in yet",
                )
            return

    ccms = parse.find_ccms(reading.headers, reading.rows)
    if ccms is None:
        not_usable(
            "no-ccms",
            "Refreshed, but couldn't read a CCMS value from the results table. "
            "The table layout may have changed.",
            "CCMS table not present yet (not on Balance Info?)",
        )
        return

    # Clean read. Clear any standing error, refresh the stored value.
    state.clear_error(acct_state)
    old = acct_state.get("ccms")
    acct_state["ccms"] = ccms
    acct_state["updated_at"] = _now_iso()

    # First clean read this run → hand-over confirmed (a ✅, not a credit alert).
    if not ready.get(cid):
        confirm_watching(old, ccms, acct_state["updated_at"])
        return

    # Already watching → increase-only credit alerts. The stored value is always
    # refreshed above, so the next comparison is against the current balance.
    if parse.ccms_increased(old, ccms):
        tg.send(
            f"🟢 <b>{label}</b> ({cid}) CCMS credited\n"
            f"{old} → <b>{ccms}</b>\n"
            f"<i>{acct_state['updated_at']}</i>"
        )
        log.info("[%s] CCMS credited: %s -> %s", label, old, ccms)
    elif parse.ccms_changed(old, ccms):
        log.info("[%s] CCMS decreased (no alert): %s -> %s", label, old, ccms)
    else:
        log.info("[%s] CCMS unchanged (%s)", label, ccms)


async def run_cycle(
    pool: browser.BrowserPool,
    cfg: dict[str, Any],
    state_path: str,
    tg: Telegram,
    ready: dict[str, bool],
) -> None:
    st = state.load(state_path)
    watched = [a for a in cfg["accounts"] if a.get("watch", True)]
    for acct_cfg in watched:
        try:
            await check_account(pool, acct_cfg, st, tg, ready)
        except Exception as exc:  # noqa: BLE001 — never let one account kill the cycle
            log.exception("unexpected error for %s", acct_cfg.get("label"))
            tg.send(f"⚠️ <b>{acct_cfg.get('label')}</b> unexpected error: <code>{exc}</code>")
    state.save(state_path, st)


async def main_async(args: argparse.Namespace) -> None:
    cfg = load_config(args.config)
    state_path = args.state or os.path.join(os.path.dirname(os.path.abspath(args.config)), "state.json")
    tg = Telegram(cfg.get("telegram", {}).get("token"), cfg.get("telegram", {}).get("chat_id"))
    poll = int(cfg["poll_seconds"])

    watched = [a for a in cfg["accounts"] if a.get("watch", True)]
    log.info("Monitoring %d account(s) every %ds: %s",
             len(watched), poll, ", ".join(a.get("label", "?") for a in watched))
    if not tg.configured:
        log.warning("Telegram is not configured — changes will be logged but not pushed.")

    # Per-run hand-over state: every account starts "awaiting log-in" and goes
    # quiet until you hand it over, then confirms with a ✅ (see check_account).
    ready: dict[str, bool] = {}

    async with browser.BrowserPool() as pool:
        if args.once:
            await run_cycle(pool, cfg, state_path, tg, ready)
            return
        if args.announce and tg.configured:
            tg.send(
                f"▶️ XtraPower monitor started — waiting for you to log in to "
                f"{len(watched)} account(s). You'll get a ✅ as each is handed "
                f"over, then a 🟢 on every credit (checking every {poll//60}m)."
            )
        while True:
            started = time.time()
            await run_cycle(pool, cfg, state_path, tg, ready)
            elapsed = time.time() - started
            await asyncio.sleep(max(1.0, poll - elapsed))


def main() -> None:
    ap = argparse.ArgumentParser(description="XtraPower CCMS balance monitor")
    ap.add_argument("--config", default=os.path.join(os.path.dirname(__file__), "config.json"))
    ap.add_argument("--state", default=None, help="state file (default: state.json next to config)")
    ap.add_argument("--once", action="store_true", help="run a single cycle and exit")
    ap.add_argument("--announce", action="store_true", help="send a Telegram note on startup")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    try:
        asyncio.run(main_async(args))
    except KeyboardInterrupt:
        log.info("stopped")


if __name__ == "__main__":
    main()
