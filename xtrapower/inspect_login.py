"""Dump the login page's real form fields and buttons.

Auto re-login needs selectors that match the live portal. Rather than guess,
run this while a window is showing the **login screen**; it attaches over CDP
and prints every input/button with its name/id/placeholder/type, so the exact
selectors can be set in browser.py.

    python -m xtrapower.inspect_login --config xtrapower/config.json          # first watched account
    python -m xtrapower.inspect_login --config xtrapower/config.json --port 9222
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os

from playwright.async_api import async_playwright

_DUMP_JS = r"""
() => {
  const vis = el => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  };
  const attrs = el => ({
    tag: el.tagName.toLowerCase(),
    type: el.getAttribute('type'),
    name: el.getAttribute('name'),
    id: el.id || null,
    placeholder: el.getAttribute('placeholder'),
    ariaLabel: el.getAttribute('aria-label'),
    formcontrolname: el.getAttribute('formcontrolname'),
    autocomplete: el.getAttribute('autocomplete'),
    visible: vis(el),
    // Buttons: show their label. Inputs: never print the VALUE (could be a
    // password) — just note whether it's filled.
    text: el.tagName.toLowerCase() === 'button'
      ? (el.innerText || '').trim().slice(0, 40) || null
      : (el.value ? '(filled)' : null),
  });
  const inputs = Array.from(document.querySelectorAll('input, textarea, select')).map(attrs);
  const buttons = Array.from(document.querySelectorAll(
    "button, input[type=submit], input[type=button], a[role=button], [role=button]")).map(attrs);
  const links = Array.from(document.querySelectorAll('a[href]')).map(a => ({
    text: (a.innerText || '').trim().slice(0, 40) || null,
    href: a.getAttribute('href'), id: a.id || null, visible: vis(a),
  })).filter(l => l.text);
  // Anything clickable whose label mentions the nav path / popup controls, so
  // menu selectors can be tuned even when they're plain divs/rows.
  const KW = ['financial', 'balance', 'skip', 'close', 'search', 'guided tour'];
  const menuish = Array.from(document.querySelectorAll('a, button, [role], li, .nav-link, .accordion-button, span'))
    .filter(el => vis(el) && KW.some(k => (el.innerText || '').trim().toLowerCase().includes(k)))
    .slice(0, 40)
    .map(el => ({
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role'),
      id: el.id || null,
      cls: (el.getAttribute('class') || '').slice(0, 60) || null,
      text: (el.innerText || '').trim().slice(0, 40),
    }));
  const dialogs = document.querySelectorAll("[role=dialog], .modal, .mat-dialog-container, .cdk-overlay-container > *").length;
  const iframes = Array.from(document.querySelectorAll('iframe')).map(f => ({
    src: f.getAttribute('src'), id: f.id || null, name: f.getAttribute('name'),
  }));
  return {
    url: location.href,
    title: document.title,
    passwordFields: document.querySelectorAll("input[type=password]").length,
    dialogs, inputs, buttons, links, menuish, iframes,
  };
}
"""


def _pick_port(cfg: dict, port: int | None) -> int:
    if port:
        return port
    watched = [a for a in cfg.get("accounts", []) if a.get("watch", True)]
    if not watched:
        raise SystemExit("No watched accounts in config.")
    return int(watched[0]["cdp_port"])


async def main_async(args) -> None:
    with open(args.config, encoding="utf-8") as f:
        cfg = json.load(f)
    port = _pick_port(cfg, args.port)
    endpoint = f"http://127.0.0.1:{port}"
    async with async_playwright() as p:
        browser = await p.chromium.connect_over_cdp(endpoint)
        page = None
        for ctx in browser.contexts:
            for pg in ctx.pages:
                if "iocxtrapower" in (pg.url or "").lower():
                    page = pg
                    break
        if page is None and browser.contexts and browser.contexts[0].pages:
            page = browser.contexts[0].pages[0]
        if page is None:
            raise SystemExit(f"No page found on port {port}. Is the window open?")

        data = await page.evaluate(_DUMP_JS)
        print("\n===== PAGE INSPECTION =====")
        print(f"URL:   {data['url']}")
        print(f"Title: {data['title']}")
        print(f"Password fields: {data['passwordFields']}   Open dialogs/overlays: {data['dialogs']}")
        if data["iframes"]:
            print("\n⚠️  IFRAMES present:")
            for f in data["iframes"]:
                print(f"    {f}")
        print("\n--- INPUTS ---")
        for i in data["inputs"]:
            print(f"    {i}")
        print("\n--- BUTTONS ---")
        for b in data["buttons"]:
            print(f"    {b}")
        print("\n--- MENU / POPUP ELEMENTS (Financials / Balance / Skip / Close / Search) ---")
        for m in data["menuish"]:
            print(f"    {m}")
        print("\n--- LINKS ---")
        for l in data["links"][:40]:
            print(f"    {l}")
        print("\n===== END =====\n")
        print("Copy everything from PAGE INSPECTION to END and paste it back.")


def main() -> None:
    ap = argparse.ArgumentParser(description="Dump the portal login form for selector tuning")
    ap.add_argument("--config", default=os.path.join(os.path.dirname(__file__), "config.json"))
    ap.add_argument("--port", type=int, default=None, help="CDP port of the window to inspect")
    main_async_args = ap.parse_args()
    asyncio.run(main_async(main_async_args))


if __name__ == "__main__":
    main()
