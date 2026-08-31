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
) -> None:
    """Run one check for one account and fire any Telegram messages.

    All failure modes are caught and turned into (de-duplicated) alerts — a
    single bad account must never take down the loop or the other accounts.
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

    try:
        page = await pool.find_portal_page(port)
    except Exception as exc:  # noqa: BLE001 — Chrome closed / port not listening
        pool.drop(port)
        alert_error(
            "chrome-unreachable",
            f"Can't reach Chrome on debug port {port}. Is that window still "
            f"open? Re-run launch.py and log in again.\n<code>{exc}</code>",
        )
        return

    if page is None:
        alert_error(
            "no-page",
            f"Chrome on port {port} has no open tab. Open {browser.PORTAL_HINT} "
            "and log in to the Balance Info screen.",
        )
        return

    # Read current state before clicking, to catch WAF / logout screens.
    try:
        pre = await browser.read_page(page, settle_ms=0)
    except Exception as exc:  # noqa: BLE001
        alert_error("read-failed", f"Couldn't read the page.\n<code>{exc}</code>")
        return

    if parse.detect_waf_block(pre.text):
        alert_error(
            "waf-block",
            "The site firewall (F5) is rejecting this connection. Scripted "
            "refresh won't work from this network right now.",
        )
        return

    if parse.detect_logout(pre.text, pre.url):
        alert_error(
            "logged-out",
            "Looks logged out / session expired. Please log back in and return "
            "to the Balance Info screen.",
        )
        return

    clicked = await browser.click_search(page)
    if not clicked:
        alert_error(
            "no-search-button",
            "Couldn't find the <b>Search</b> button on the Balance Info screen. "
            "The portal layout may have changed, or the tab isn't on Balance Info.",
        )
        return

    reading = await browser.read_page(page)

    # A logout can also surface only after the click.
    if parse.detect_logout(reading.text, reading.url):
        alert_error(
            "logged-out",
            "Session dropped during refresh. Please log back in and return to "
            "the Balance Info screen.",
        )
        return

    ccms = parse.find_ccms(reading.headers, reading.rows)
    if ccms is None:
        alert_error(
            "no-ccms",
            "Refreshed, but couldn't read a CCMS value from the results table. "
            "The table layout may have changed.",
        )
        return

    # Success — clear any standing error so the next fault alerts immediately.
    state.clear_error(acct_state)
    old = acct_state.get("ccms")
    acct_state["ccms"] = ccms
    acct_state["updated_at"] = _now_iso()

    if old is None:
        log.info("[%s] baseline CCMS = %s", label, ccms)
        return

    # Increase-only: alert on credits, stay quiet on debits and no-change. The
    # stored value is always refreshed above, so the next comparison is against
    # the current balance either way.
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
) -> None:
    st = state.load(state_path)
    watched = [a for a in cfg["accounts"] if a.get("watch", True)]
    for acct_cfg in watched:
        try:
            await check_account(pool, acct_cfg, st, tg)
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

    async with browser.BrowserPool() as pool:
        if args.once:
            await run_cycle(pool, cfg, state_path, tg)
            return
        if args.announce and tg.configured:
            tg.send(f"▶️ XtraPower monitor started — {len(watched)} account(s), every {poll//60}m.")
        while True:
            started = time.time()
            await run_cycle(pool, cfg, state_path, tg)
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
