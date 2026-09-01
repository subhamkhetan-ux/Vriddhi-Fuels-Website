"""Playwright ⇄ Chrome-over-CDP glue.

The user launches Chrome themselves with ``--remote-debugging-port`` (see
``launch.py``), logs in by hand, and leaves the tab on the Balance Info screen.
This module *attaches* to that already-open browser over the Chrome DevTools
Protocol — it never launches its own browser and never touches credentials —
then, each cycle, clicks Search and scrapes the CCMS table.

Only Chrome/Chromium is supported, which matches the portal (it does not work
in Safari).

All the fiddly DOM work funnels through a handful of resilient selectors and a
single ``page.evaluate`` table scrape, so the pure logic in ``parse.py`` stays
browser-free and unit-tested.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Optional

from playwright.async_api import Browser, Page, TimeoutError as PWTimeout, async_playwright

log = logging.getLogger("xtrapower.browser")

# Substrings that identify a real portal tab among whatever else is open.
PORTAL_HINT = "iocxtrapower"
PORTAL_URL = "https://beta.iocxtrapower.com"

# Default menu path to the balance table, clicked label by label after a
# re-login. Overridable per account via config ("nav_labels").
DEFAULT_NAV_LABELS = ["Financials", "Balance Info"]

# Login result codes returned by do_login().
LOGIN_OK = "ok"            # logged in
LOGIN_CAPTCHA = "captcha"  # a reCAPTCHA challenge blocked us — needs a human
LOGIN_FORM = "form"        # couldn't find the ID/password fields
LOGIN_FAILED = "failed"    # submitted but still on the login page

# Resilient selector lists for the login form (first that resolves wins).
# The XTRAPOWER form uses id/formcontrolname "email" + "password"; note the
# password field can be type=text when the show/hide toggle reveals it, so we
# must NOT rely on input[type=password].
_USER_SELECTORS = (
    "#email",
    "[formcontrolname='email']",
    "input[autocomplete='username']",
    "input[name*='user' i]",
    "input[id*='user' i]",
    "input[placeholder*='user' i]",
    "input[placeholder*='customer' i]",
    "input[type='text']:visible",
)
_PASS_SELECTORS = (
    "#password",
    "[formcontrolname='password']",
    "input[autocomplete='current-password']",
    "input[type='password']",
)
_SUBMIT_SELECTORS = (
    "button#normal",
    "button:has-text('Sign In')",
    "button:has-text('Sign in')",
    "button[type='submit']",
    "input[type='submit']",
    "button:has-text('Login')",
    "button:has-text('Log In')",
    "text=/^\\s*(sign ?in|log ?in)\\s*$/i",
)
# The "keep me signed in" checkbox — ticking it may lengthen the session.
_REMEMBER_SELECTORS = ("#remember-check", "input[type='checkbox']")
# Visible "I'm not a robot" reCAPTCHA checkbox lives in this iframe.
_RECAPTCHA_ANCHOR = "iframe[src*='recaptcha/api2/anchor'][src*='size=normal']"

# Set #email / #password via the native value setter and fire input/change so
# Angular's reactive form registers them (plain .value assignment doesn't, and
# Playwright fill() stalls on these inputs). Also ticks the remember-me box.
_FILL_LOGIN_JS = r"""
(args) => {
  const setVal = (sel, val) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    const proto = el.tagName === 'TEXTAREA'
      ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, val);
    el.dispatchEvent(new Event('input', {bubbles: true}));
    el.dispatchEvent(new Event('change', {bubbles: true}));
    el.dispatchEvent(new Event('blur', {bubbles: true}));
    return true;
  };
  const u = setVal('#email', args.user);
  const p = setVal('#password', args.pw);
  const cb = document.querySelector('#remember-check');
  if (cb && !cb.checked) { try { cb.click(); } catch (e) {} }
  return u && p;
}
"""

# Buttons that dismiss the post-login popups (the "67th IndianOil Day"
# announcement and the "Welcome to the brand new XTRAPOWER … Skip" modal), plus
# generic close (×) affordances. All best-effort. NB: never match "Start Guided
# Tour" — we want Skip, not the tour.
_POPUP_CLOSE_SELECTORS = (
    "button:has-text('Skip')",
    "button:has-text('No Thanks')",
    "button:has-text('Maybe Later')",
    "button:has-text('Got it')",
    "button:has-text('Dismiss')",
    "button:has-text('Close')",
    "button[aria-label*='close' i]",
    "[aria-label='Close']",
    "button.close, button.btn-close",
    ".modal .close, .modal-header button, [role='dialog'] button[aria-label*='close' i]",
    "mat-icon:has-text('close')",
)

# JS that extracts the results table as {headers, rows}. Picks the first table
# containing a CCMS header; falls back to the widest table so a header-wording
# change still yields data for the regex fallback in the caller.
_SCRAPE_TABLES_JS = r"""
() => {
  const norm = s => (s || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
  const tables = Array.from(document.querySelectorAll('table'));
  const parse = (t) => {
    let headers = Array.from(t.querySelectorAll('thead th, thead td')).map(c => c.innerText.trim());
    const bodyRows = Array.from(t.querySelectorAll('tbody tr'));
    let rows = bodyRows.map(tr => Array.from(tr.querySelectorAll('td, th')).map(c => c.innerText.trim()));
    if (!headers.length) {
      const all = Array.from(t.querySelectorAll('tr'));
      if (all.length) {
        headers = Array.from(all[0].querySelectorAll('th, td')).map(c => c.innerText.trim());
        rows = all.slice(1).map(tr => Array.from(tr.querySelectorAll('td, th')).map(c => c.innerText.trim()));
      }
    }
    return { headers, rows };
  };
  const parsed = tables.map(parse).filter(p => p.headers.length || p.rows.length);
  const withCcms = parsed.find(p => p.headers.some(h => norm(h).includes('ccms')));
  if (withCcms) return withCcms;
  parsed.sort((a, b) => b.headers.length - a.headers.length);
  return parsed[0] || { headers: [], rows: [] };
}
"""

# Ordered selector strategies for the Search button — first that resolves wins.
_SEARCH_SELECTORS = (
    "role=button[name=/^\\s*search\\s*$/i]",
    "button:has-text('Search')",
    "input[type='submit'][value='Search' i]",
    "input[type='button'][value='Search' i]",
    "a:has-text('Search')",
    "text=/^\\s*Search\\s*$/",
)


@dataclass
class Reading:
    """Result of one scrape of a portal page."""

    url: str
    text: str
    headers: list[str]
    rows: list[list[str]]


class BrowserPool:
    """Holds the Playwright driver and per-port CDP connections.

    Connections are cached and reused across cycles; a dropped connection (the
    user closed Chrome) is detected and reconnected on the next cycle.
    """

    def __init__(self) -> None:
        self._pw = None
        self._browsers: dict[int, Browser] = {}

    async def __aenter__(self) -> "BrowserPool":
        self._pw = await async_playwright().start()
        return self

    async def __aexit__(self, *exc) -> None:
        for b in self._browsers.values():
            try:
                await b.close()
            except Exception:  # noqa: BLE001
                pass
        if self._pw is not None:
            await self._pw.stop()

    async def _browser_for(self, port: int) -> Browser:
        b = self._browsers.get(port)
        if b is not None and b.is_connected():
            return b
        endpoint = f"http://127.0.0.1:{port}"
        b = await self._pw.chromium.connect_over_cdp(endpoint)
        self._browsers[port] = b
        return b

    async def find_portal_page(self, port: int) -> Optional[Page]:
        """Return the open tab on the portal for this Chrome, or ``None``."""
        browser = await self._browser_for(port)
        for ctx in browser.contexts:
            for page in ctx.pages:
                try:
                    if PORTAL_HINT in (page.url or "").lower():
                        return page
                except Exception:  # noqa: BLE001 — page may be mid-navigation
                    continue
        # No portal tab matched: fall back to the first visible page so the
        # caller can still read its text (e.g. a WAF block or a stray tab).
        for ctx in browser.contexts:
            if ctx.pages:
                return ctx.pages[0]
        return None

    def drop(self, port: int) -> None:
        """Forget a cached connection so the next cycle reconnects cleanly.

        The underlying CDP connection is almost always already dead (the user
        closed Chrome), so we don't try to close it here — awaiting a close on
        a broken pipe can hang. Dropping the reference is enough; any still-live
        connection is cleaned up in ``__aexit__``.
        """
        self._browsers.pop(port, None)


async def click_search(page: Page, timeout_ms: int = 8000) -> bool:
    """Click the Search button. Returns True if a strategy connected."""
    for sel in _SEARCH_SELECTORS:
        loc = page.locator(sel).first
        try:
            await loc.wait_for(state="visible", timeout=timeout_ms // len(_SEARCH_SELECTORS) + 500)
            await loc.click(timeout=timeout_ms)
            return True
        except PWTimeout:
            continue
        except Exception as exc:  # noqa: BLE001
            log.debug("search selector %s failed: %s", sel, exc)
            continue
    return False


async def read_page(page: Page, settle_ms: int = 1500) -> Reading:
    """Scrape the portal page after a Search click.

    Waits briefly for the results to re-render (SPA tables rarely fire a clean
    ``networkidle``, so we combine a bounded idle-wait with a fixed settle).
    """
    try:
        await page.wait_for_load_state("networkidle", timeout=5000)
    except PWTimeout:
        pass
    await page.wait_for_timeout(settle_ms)
    text = ""
    try:
        text = await page.inner_text("body")
    except Exception:  # noqa: BLE001
        try:
            text = await page.content()
        except Exception:  # noqa: BLE001
            text = ""
    try:
        table = await page.evaluate(_SCRAPE_TABLES_JS)
    except Exception as exc:  # noqa: BLE001
        log.debug("table scrape failed: %s", exc)
        table = {"headers": [], "rows": []}
    return Reading(
        url=page.url or "",
        text=text or "",
        headers=list(table.get("headers") or []),
        rows=[list(r) for r in (table.get("rows") or [])],
    )


# ---- auto re-login --------------------------------------------------------
# The portal expires the session on a fixed ~30-45 min schedule regardless of
# activity, so to run unattended for hours the monitor must log itself back in.
# Only reached when credentials are configured and login is username+password
# (no OTP / captcha). All steps are best-effort with resilient selectors.

def _app_frames(page: Page):
    """Main frame + same-origin app frames (skip Google reCAPTCHA frames)."""
    frames = [page.main_frame]
    for fr in page.frames:
        if fr is page.main_frame:
            continue
        u = (fr.url or "").lower()
        if (not u) or u == "about:blank" or PORTAL_HINT in u:
            frames.append(fr)
    return frames


async def _fill_first(page: Page, selectors, value: str, timeout_ms: int = 1500) -> bool:
    for fr in _app_frames(page):
        for sel in selectors:
            loc = fr.locator(sel).first
            try:
                await loc.wait_for(state="visible", timeout=timeout_ms)
                await loc.fill(value, timeout=3000)
                return True
            except Exception:  # noqa: BLE001
                continue
    return False


async def _click_first(page: Page, selectors, timeout_ms: int = 3000) -> bool:
    for fr in _app_frames(page):
        for sel in selectors:
            loc = fr.locator(sel).first
            try:
                await loc.wait_for(state="visible", timeout=timeout_ms)
                await loc.click(timeout=timeout_ms)
                return True
            except Exception:  # noqa: BLE001
                continue
    return False


async def _log_login_diagnostic(page: Page) -> None:
    """Log what Playwright actually sees, to pin down a stubborn login form."""
    try:
        log.info("login diagnostic: attached page url = %s", page.url)
        data = await page.evaluate(
            "() => Array.from(document.querySelectorAll('input,textarea')).map(e => ({"
            "id: e.id||null, name: e.getAttribute('name'), "
            "fcn: e.getAttribute('formcontrolname'), type: e.getAttribute('type'), "
            "vis: !!(e.offsetWidth||e.offsetHeight||e.getClientRects().length)}))"
        )
        log.info("login diagnostic: main-frame inputs = %s", data)
        log.info("login diagnostic: %d frame(s) total", len(page.frames))
        for i, fr in enumerate(page.frames):
            try:
                n = await fr.evaluate("() => document.querySelectorAll('input,textarea').length")
                log.info("  frame[%d] inputs=%s url=%s", i, n, (fr.url or "")[:70])
            except Exception:  # noqa: BLE001
                pass
    except Exception as exc:  # noqa: BLE001
        log.info("login diagnostic failed: %s", exc)


async def dismiss_popup(page: Page) -> None:
    """Clear the post-login popups. Handles several stacked modals; never raises.

    Loops a few rounds because there can be two at once (announcement + welcome
    tour); each round clicks any visible Skip/close button and presses Escape,
    stopping early once a round finds nothing left to close.
    """
    for _ in range(4):
        acted = False
        for sel in _POPUP_CLOSE_SELECTORS:
            try:
                loc = page.locator(sel).first
                if await loc.count() and await loc.is_visible():
                    await loc.click(timeout=1500)
                    acted = True
                    await page.wait_for_timeout(400)
            except Exception:  # noqa: BLE001
                continue
        try:
            await page.keyboard.press("Escape")
        except Exception:  # noqa: BLE001
            pass
        await page.wait_for_timeout(300)
        if not acted:
            break


async def is_logged_in(page: Page) -> bool:
    """True when we're off the login screen.

    URL-based (the login route contains ``login``) plus a check that no
    ID/password field is showing — the password field can be ``type=text``
    behind a show/hide toggle, so a type-based check alone is unreliable.
    """
    url = (page.url or "").lower()
    if "login" in url:
        return False
    try:
        if (await page.locator("#password, [formcontrolname='password']").count()) > 0:
            return False
    except Exception:  # noqa: BLE001
        pass
    return True


async def _handle_recaptcha(page: Page) -> tuple[bool, bool]:
    """Best-effort tick of the visible "I'm not a robot" box.

    Returns (present, satisfied). On a trusted, daily-use profile the checkbox
    usually passes with a single click and no image challenge; if a challenge
    appears instead, we do NOT try to solve it — we report it unsatisfied so
    the caller can hand off to a human. Returns (False, True) when there is no
    visible checkbox reCAPTCHA at all.
    """
    try:
        if (await page.locator(_RECAPTCHA_ANCHOR).count()) == 0:
            return (False, True)
    except Exception:  # noqa: BLE001
        return (False, True)
    box = page.frame_locator(_RECAPTCHA_ANCHOR).first.locator("#recaptcha-anchor")
    try:
        await box.wait_for(state="visible", timeout=4000)
        if (await box.get_attribute("aria-checked")) == "true":
            return (True, True)
        await box.click(timeout=4000)
    except Exception:  # noqa: BLE001
        return (True, False)
    for _ in range(16):  # up to ~8s for it to turn green (or a challenge to pop)
        await page.wait_for_timeout(500)
        try:
            if (await box.get_attribute("aria-checked")) == "true":
                return (True, True)
        except Exception:  # noqa: BLE001
            pass
    return (True, False)


async def do_login(page: Page, username: str, password: str) -> str:
    """Fill and submit the login form. Returns one of the LOGIN_* codes.

    Assumes the caller already determined the page is on the login screen.
    """
    try:
        if PORTAL_HINT not in (page.url or "").lower():
            await page.goto(PORTAL_URL, wait_until="domcontentloaded", timeout=20000)
    except Exception:  # noqa: BLE001
        pass
    await dismiss_popup(page)
    # Wait for the form to exist, then find the frame that actually holds it.
    try:
        await page.wait_for_selector("#email", state="attached", timeout=15000)
    except Exception:  # noqa: BLE001
        await _log_login_diagnostic(page)
        return LOGIN_FORM
    frame = None
    for fr in page.frames:
        try:
            if await fr.query_selector("#email"):
                frame = fr
                break
        except Exception:  # noqa: BLE001
            continue
    if frame is None:
        await _log_login_diagnostic(page)
        return LOGIN_FORM

    # Set the values via the native setter + input/change events. Playwright's
    # fill() stalls on these Angular reactive-form inputs, but driving the value
    # this way updates the FormControl reliably. Also ticks "remember me".
    filled = await frame.evaluate(_FILL_LOGIN_JS, {"user": username, "pw": password})
    if not filled:
        log.warning("login: could not set User ID / password fields")
        await _log_login_diagnostic(page)
        return LOGIN_FORM

    # NB: do NOT touch the reCAPTCHA. This login uses the *invisible* reCAPTCHA
    # (bottom-right badge) which runs automatically on submit; poking the stray
    # checkbox element only produced false "captcha" verdicts while the browser
    # actually logged in fine.

    # Submit: try a normal click, then fall back to a direct JS click on the
    # Sign In button (id="normal").
    if not await _click_first(page, _SUBMIT_SELECTORS):
        try:
            await frame.evaluate(
                "() => { const b = document.querySelector('#normal') || "
                "Array.from(document.querySelectorAll('button'))"
                ".find(x => /sign ?in/i.test(x.innerText||'')); if (b) b.click(); }"
            )
        except Exception:  # noqa: BLE001
            log.warning("login: could not click Sign In")
            return LOGIN_FAILED
    # Poll for the navigation away from the login page (it takes a moment).
    for _ in range(15):
        await page.wait_for_timeout(1000)
        if await is_logged_in(page):
            await dismiss_popup(page)
            return LOGIN_OK
    await dismiss_popup(page)
    return LOGIN_OK if await is_logged_in(page) else LOGIN_FAILED


async def navigate_to_balance(page: Page, labels) -> None:
    """Click through the menu path (e.g. Financials → Balance Info). Best-effort.

    Dismisses popups first (they land on the page right after login) and again
    at the end (a promo can re-open), and clicks each label by whatever it turns
    out to be — link, button, menu item, or a plain accordion row (text=…).
    """
    await dismiss_popup(page)
    for label in labels:
        await _click_first(page, [
            f"role=link[name=/{label}/i]",
            f"role=button[name=/{label}/i]",
            f"role=menuitem[name=/{label}/i]",
            f"a:has-text(\"{label}\")",
            f"button:has-text(\"{label}\")",
            f"text=/^\\s*{label}\\s*$/i",
            f"text=/{label}/i",
        ], timeout_ms=5000)
        await page.wait_for_timeout(1000)
    await dismiss_popup(page)
