"""python -m iocl_portal.run --probe | --dry-run | --sync | --opening"""
from __future__ import annotations

import argparse
import os
from pathlib import Path
import sys

from .browser import PortalBrowser, launch_options, selectors_from_env
from .statement import PortalError
from .sync import payments_config, save_balance, save_opening


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Read IOCL e-Mitra PAD and update Payments.")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--probe", action="store_true", help="Only open the login page; no credentials needed.")
    mode.add_argument("--dry-run", action="store_true", help="Log in and validate the report; never write to Payments.")
    mode.add_argument("--sync", action="store_true", help="Save the verified company-code balance, excluding open deliveries, to Payments.")
    mode.add_argument("--opening", action="store_true", help="At 00:30 IST, record today's opening and sync any changed balance.")
    parser.add_argument("--manual-login", action="store_true", help="On a local desktop, complete login yourself in the opened browser.")
    args = parser.parse_args(argv)
    try:
        username = os.environ.get("IOCL_EMITRA_USERNAME", "").strip()
        password = os.environ.get("IOCL_EMITRA_PASSWORD", "")
        customer = os.environ.get("IOCL_CUSTOMER_CODE", "").strip() or username
        if not args.probe and not args.manual_login and (not username or not password):
            raise PortalError("Set IOCL_EMITRA_USERNAME and IOCL_EMITRA_PASSWORD securely; no login was attempted.")
        if not args.probe and not customer:
            raise PortalError("IOCL_CUSTOMER_CODE is required to verify the statement belongs to your account.")
        cfg = payments_config() if args.sync or args.opening else None
        options = launch_options()
        if args.manual_login:
            options["headless"] = False
        from playwright.sync_api import sync_playwright
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(**options)
            # Never ignore certificate errors, persist auth cookies, or record
            # traces/screenshots containing account details on the Actions runner.
            context = browser.new_context(viewport={"width": 1440, "height": 1000}, locale="en-IN", timezone_id="Asia/Kolkata")
            try:
                portal = PortalBrowser(context.new_page(), selectors=selectors_from_env())
                portal.open()
                if args.probe:
                    print("PASS: the portal login form is reachable. Login and PAD access were not tested.")
                    return 0
                if args.manual_login:
                    print("Complete sign-in and CAPTCHA in the opened browser within 3 minutes.")
                    portal.account_menu(timeout=180)
                else:
                    try:
                        length = int(os.environ.get("IOCL_CAPTCHA_LENGTH", "6"))
                    except ValueError:
                        raise PortalError("IOCL_CAPTCHA_LENGTH must be a whole number.") from None
                    portal.login(username, password, captcha_length=length)
                portal.navigate_pad()
                balance = portal.read_balance(customer=customer)
                if args.dry_run:
                    print("PASS: login, Account Information > PAD Statement, dates, account and CL.BAL.in Comp Code verified (open deliveries excluded). Dry run: nothing saved.")
                    result = "dry_run_verified"
                else:
                    opening = save_opening(balance, config=cfg) if args.opening else None
                    result = save_balance(balance, config=cfg)
                    if opening:
                        result = opening + "; balance_" + result
                    print("PASS: IOCL PAD check completed: " + result.replace("_", " ") + ".")
                summary = os.environ.get("GITHUB_STEP_SUMMARY")
                if summary:
                    with Path(summary).open("a", encoding="utf-8") as f:
                        f.write(f"IOCL PAD: **{result}**. Report observed {balance.generated_at.isoformat()}.\n")
            finally:
                context.close()
                browser.close()
        return 0
    except PortalError as exc:
        print("IOCL PAD stopped: " + str(exc), file=sys.stderr)
        return 1
    except Exception as exc:
        # Browser/HTTP exceptions can contain request URLs or entered values.
        print("IOCL PAD stopped: " + type(exc).__name__ + ". No successful sync was confirmed. Check configuration and portal access.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
