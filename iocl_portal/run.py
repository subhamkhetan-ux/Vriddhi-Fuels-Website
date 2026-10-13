"""python -m iocl_portal.run --probe | --captcha-sample | --dry-run | --sync | --opening"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys

from .browser import PortalBrowser, launch_options, selectors_from_env
from .captcha import ocr_reads
from .statement import PortalError
from .sync import payments_config, save_balance, save_opening


def sample_captchas(portal, out: Path, *, length: int, count: int = 6) -> int:
    """Diagnostics: the login page once, then ``count`` fresh CAPTCHAs (page
    reloads) with every OCR read. The page is captured before anything is typed."""
    out.mkdir(parents=True, exist_ok=True)
    portal.page.screenshot(path=str(out / "login-page.png"), full_page=True)
    describe = """el => Object.fromEntries(['tagName','id','name','alt','type','maxLength','placeholder',
        'width','height','naturalWidth','naturalHeight','autocomplete']
        .filter(k => el[k] !== undefined && el[k] !== '').map(k => [k, String(el[k])])
        .concat([['src', (el.getAttribute('src') || '').slice(0, 120)]]))"""
    report = {"captcha_image": portal.captcha_image().evaluate(describe),
              "captcha_input": portal.captcha_input().evaluate(describe), "samples": []}
    for i in range(1, count + 1):
        if i > 1:
            portal.page.reload(wait_until="domcontentloaded", timeout=45000)
        png = portal.captcha_image().screenshot()
        (out / f"captcha-{i}.png").write_bytes(png)
        reads = []
        for r in ocr_reads(png, length=length):
            words = [line.split("\t")[-2:] for line in r["tsv"].splitlines()[1:]
                     if line.count("\t") >= 11 and line.split("\t")[-1].strip()]
            reads.append({"psm": r["psm"], "answer": r["answer"],
                          "words": [{"conf": c, "text": t} for c, t in words]})
        report["samples"].append({"file": f"captcha-{i}.png", "reads": reads})
    (out / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    return count


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Read IOCL e-Mitra PAD and update Payments.")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--probe", action="store_true", help="Only open the login page; no credentials needed.")
    mode.add_argument("--captcha-sample", action="store_true",
                      help="Save a few CAPTCHA images and OCR reads for tuning; never types or submits anything.")
    mode.add_argument("--dry-run", action="store_true", help="Log in and validate the report; never write to Payments.")
    mode.add_argument("--sync", action="store_true", help="Save the verified company-code balance, excluding open deliveries, to Payments.")
    mode.add_argument("--opening", action="store_true", help="At 00:30 IST, record today's opening and sync any changed balance.")
    args = parser.parse_args(argv)
    try:
        username = os.environ.get("IOCL_EMITRA_USERNAME", "").strip()
        password = os.environ.get("IOCL_EMITRA_PASSWORD", "")
        customer = os.environ.get("IOCL_CUSTOMER_CODE", "").strip() or username
        sampling = args.probe or args.captcha_sample
        if not sampling and (not username or not password):
            raise PortalError("Set IOCL_EMITRA_USERNAME and IOCL_EMITRA_PASSWORD securely; no login was attempted.")
        if not sampling and not customer:
            raise PortalError("IOCL_CUSTOMER_CODE is required to verify the statement belongs to your account.")
        cfg = payments_config() if args.sync or args.opening else None
        options = launch_options()
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
                try:
                    length = int(os.environ.get("IOCL_CAPTCHA_LENGTH", "6"))
                except ValueError:
                    raise PortalError("IOCL_CAPTCHA_LENGTH must be a whole number.") from None
                if args.captcha_sample:
                    try:
                        wanted = min(30, max(1, int(os.environ.get("IOCL_SAMPLE_COUNT") or 6)))
                    except ValueError:
                        raise PortalError("IOCL_SAMPLE_COUNT must be a whole number.") from None
                    count = sample_captchas(portal, Path(os.environ.get("IOCL_SAMPLE_DIR") or "captcha-samples"),
                                            length=length, count=wanted)
                    print(f"PASS: saved {count} CAPTCHA samples with OCR reads. No credentials were typed "
                          "and no login was submitted.")
                    return 0
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
