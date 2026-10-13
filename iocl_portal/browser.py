"""Menu-driven e-Mitra reader. Live selectors still require portal verification.

No guessed report URL, cached session, hidden API or account-changing menu is
used. CSS overrides let an operator adapt identifiers after inspecting the real
page without rewriting the workflow.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta
import json
import os
import re
import time
from urllib.parse import urlsplit

from .captcha import solve_text_captcha
from .statement import IST, PortalError, parse_statement

PORTAL_ORIGIN = "https://utkarsh.indianoil.co.in"
LOGIN_URL = PORTAL_ORIGIN + "/ioconline/iocExStart.jsp"
OVERRIDE_KEYS = {"username", "password", "captcha_image", "captcha_input", "login",
                 "account_menu", "pad_menu", "from_date", "to_date", "view"}


def selectors_from_env() -> dict:
    try:
        value = json.loads(os.environ.get("IOCL_SELECTORS_JSON") or "{}")
    except ValueError:
        raise PortalError("IOCL_SELECTORS_JSON is not valid JSON.") from None
    if not isinstance(value, dict) or set(value) - OVERRIDE_KEYS:
        raise PortalError("IOCL_SELECTORS_JSON contains unsupported controls.")
    if any(not isinstance(v, str) or not v or len(v) > 500 for v in value.values()):
        raise PortalError("Each selector override must be a nonempty CSS selector.")
    return value


def launch_options() -> dict:
    options = {"headless": True}
    executable = os.environ.get("IOCL_CHROMIUM_EXECUTABLE")
    if executable:
        options["executable_path"] = executable
    proxy = os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy")
    if proxy:
        p = urlsplit(proxy)
        if p.scheme not in ("http", "https") or not p.hostname:
            raise PortalError("The supplied HTTPS proxy configuration is invalid.")
        options["proxy"] = {"server": f"{p.scheme}://{p.hostname}:{p.port or 8080}"}
        if p.username or p.password:
            raise PortalError("An authenticated browser proxy needs explicit supported configuration.")
    return options


class PortalBrowser:
    def __init__(self, page, *, selectors=None, origin=PORTAL_ORIGIN,
                 captcha_solver=solve_text_captcha, timeout=20):
        self.page = page
        self.origin = origin
        self.selectors = selectors or {}
        self.solve_captcha = captcha_solver
        self.timeout = timeout

    def frames(self):
        expected = urlsplit(self.origin)
        return [f for f in self.page.frames
                if (urlsplit(f.url).scheme, urlsplit(f.url).netloc) == (expected.scheme, expected.netloc)]

    def locate(self, key, candidates, *, timeout=None):
        """A unique visible control is required; never click an arbitrary match."""
        end = time.monotonic() + (self.timeout if timeout is None else timeout)
        while True:
            frames = self.frames()
            strategies = ([lambda f: f.locator(self.selectors[key])]
                          if key in self.selectors else candidates)
            for strategy in strategies:
                matches = []
                for frame in frames:
                    try:
                        locator = strategy(frame)
                        for i in range(min(locator.count(), 20)):
                            item = locator.nth(i)
                            if item.is_visible():
                                matches.append(item)
                    except Exception:
                        continue  # a frame can detach while a menu navigates
                if len(matches) == 1:
                    return matches[0]
                if len(matches) > 1:
                    raise PortalError(f"More than one {key} control is visible. Configure its exact CSS selector.")
            if time.monotonic() >= end:
                raise PortalError(f"The {key} control was not found. Verify the portal layout before enabling the schedule.")
            self.page.wait_for_timeout(200)

    def _label(self, label):
        return lambda f: f.get_by_label(re.compile(label, re.I))

    def _css(self, css):
        return lambda f: f.locator(css)

    def text_control(self, key, pattern, *, timeout=None):
        name = re.compile(pattern, re.I)
        return self.locate(key, [lambda f: f.get_by_role("link", name=name),
                                 lambda f: f.get_by_role("button", name=name),
                                 lambda f: f.get_by_text(name, exact=True)], timeout=timeout)

    def follow_click(self, control):
        before = set(self.page.context.pages)
        control.click(timeout=int(self.timeout * 1000))
        self.page.wait_for_timeout(400)
        opened = [p for p in self.page.context.pages if p not in before]
        if opened:
            if len(opened) != 1:
                raise PortalError("The portal opened multiple windows; navigation needs verification.")
            self.page = opened[0]
            self.page.wait_for_load_state("domcontentloaded", timeout=int(self.timeout * 1000))
            if not self.frames():
                raise PortalError("The portal navigated to an unconfigured host. Login details were not forwarded.")

    def open(self):
        try:
            response = self.page.goto(self.origin + "/ioconline/iocExStart.jsp", wait_until="domcontentloaded", timeout=45000)
        except Exception:
            raise PortalError("Could not reach e-Mitra over verified HTTPS. Check network access, DNS and TLS trust.") from None
        if response and response.status >= 400:
            raise PortalError(f"The e-Mitra entry page returned HTTP {response.status}.")
        if not self.frames():
            raise PortalError("The entry page redirected to an unconfigured host.")
        return self.locate("password", [self._css("input[type=password]")])

    def login(self, username: str, password: str, *, captcha_length=6):
        password_field = self.locate("password", [self._css("input[type=password]")])
        username_field = self.locate("username", [self._label(r"^(user(?:name|\s*id)?|dealer\s*(?:code|id)|customer\s*(?:code|id))\s*:?$"),
            self._css("input[autocomplete=username]"),
            self._css("input[name*=user i], input[id*=user i]"),
            self._css("input[name*=dealer i], input[id*=dealer i]"),
            self._css("input[type=text]:not([id*=captcha i]):not([name*=captcha i]):not([id*=captext i])")])
        captcha = self.locate("captcha_image", [self._css("img[src*=captcha i]"),
            self._css("img[id*=captcha i], img[alt*=captcha i]"),
            self._css("canvas[id*=captcha i]")])
        field = self.locate("captcha_input", [self._label(r"captcha|verification\s*code"),
            self._css("input[name*=captcha i], input[id*=captcha i]"),
            self._css("input[name*=captext i], input[id*=captext i]")])
        # Read the displayed challenge before entering credentials; do not save
        # a browser profile, screenshot, trace or password to any artifact.
        answer = self.solve_captcha(captcha.screenshot(), length=captcha_length)
        username_field.fill(username)
        password_field.fill(password)
        field.fill(answer)
        button = self.locate("login", [lambda f: f.get_by_role("button", name=re.compile(r"^\s*log\s*in\s*$", re.I)),
            self._css("input[type=submit][value*=login i]"),
            lambda f: f.get_by_role("link", name=re.compile(r"^\s*login\s*$", re.I))])
        self.follow_click(button)
        try:
            self.account_menu()
        except PortalError:
            raise PortalError("Login was not confirmed (credentials, CAPTCHA or portal challenge). Only one login was submitted; nothing was saved.") from None

    def account_menu(self, *, timeout=None):
        return self.text_control("account_menu", r"^[\s▾▸+*^»\-]*Account\s+Information\s*$", timeout=timeout)

    def navigate_pad(self):
        self.follow_click(self.account_menu())
        try:
            link = self.text_control("pad_menu", r"^\s*PAD\s+Statement\s*$", timeout=3)
        except PortalError:
            self.account_menu().hover()
            link = self.text_control("pad_menu", r"^\s*PAD\s+Statement\s*$")
        self.follow_click(link)
        self.text_control("pad_title", r"^\s*Customer\s+PAD\s+Balance\s*$")

    def set_date(self, key: str, day: date):
        prefix = "from" if key == "from_date" else "to"
        control = self.locate(key, [self._label(r"^" + prefix + r"\s*date\s*:?$"),
            self._css(f"input[id*='{prefix}date' i],input[name*='{prefix}date' i]"),
            self._css(f"input[id*='{prefix}_date' i],input[name*='{prefix}_date' i]")])
        value = day.isoformat() if control.get_attribute("type") == "date" else day.strftime("%d-%m-%Y")
        if control.get_attribute("readonly") is not None:
            # Datepickers often expose a readonly text field. Trigger the same
            # change events their picker uses, then verify the displayed value.
            control.evaluate("(el,value)=>{el.value=value;el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));}", value)
        else:
            control.fill(value)
            control.dispatch_event("change")
        if control.input_value() != value:
            raise PortalError("The portal did not accept the requested statement date.")

    def read_balance(self, *, customer: str, now=None):
        now = now or datetime.now(IST)
        self.set_date("from_date", now.date() - timedelta(days=1))
        self.set_date("to_date", now.date())
        view = self.locate("view", [lambda f: f.get_by_role("button", name=re.compile(r"^\s*View\s*$", re.I)),
            self._css("input[type=submit][value='View' i]"),
            lambda f: f.get_by_role("link", name=re.compile(r"^\s*View\s*$", re.I))])
        self.follow_click(view)
        end = time.monotonic() + self.timeout
        last_error = "The PAD report did not appear."
        while time.monotonic() < end:
            for frame in self.frames():
                try:
                    text = frame.locator("body").inner_text(timeout=3000)
                    if not re.search(r"CL\.?\s*BAL\.?\s*in\s+Comp", text, re.I):
                        continue
                    rows = frame.locator("tr").evaluate_all("""rows => rows
                      .filter(row => row.getBoundingClientRect().height > 0)
                      .map(row => Array.from(row.children)
                        .filter(cell => /^(TD|TH)$/.test(cell.tagName))
                        .map(cell => cell.innerText))""")
                    balance = parse_statement(text, table_rows=rows, customer=customer, today=now.date(), now=now)
                    if balance.generated_at < now - timedelta(minutes=2):
                        raise PortalError("The portal returned an older report instead of a fresh observation.")
                    return balance
                except PortalError as exc:
                    last_error = str(exc)
                except Exception:
                    continue
            self.page.wait_for_timeout(250)
        raise PortalError(last_error)
