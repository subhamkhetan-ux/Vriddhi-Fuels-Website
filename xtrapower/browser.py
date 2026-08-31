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
