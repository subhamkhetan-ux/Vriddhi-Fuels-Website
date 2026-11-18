"""The decanting result picture, made on the server when the tank stock agent
finishes a decantation: to send on Telegram and to download from the Tank
stock page.

It is the decant app's own picture: the figures are laid out here as the
app's Result screen has them (decant/js/wizard.js resultModel, its words and
number formats), then drawn by the app's own code (decant/js/shareimg.js
resultImage) in a headless Chromium, with each tank's stock before / after
proof pictures under them.

The drawing runs in a process of its own (``python -m tank_stock.resultimg``,
JSON in, PNG out) that ends with it: its Chromium's memory (some 200 MB, for
a few seconds) goes back at once.
"""
from __future__ import annotations

import base64
import json
import math
import os
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DECANT_JS = ROOT / "decant" / "js"
RENDER_TIMEOUT_S = 120
IST = timezone(timedelta(hours=5, minutes=30))
MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
PRODUCT_COLOR = {"HSD": "#3987e5", "MS": "#d95926", "XG": "#199e70"}
NBSP = " "


# ---- the app's number and time formats (decant/js/ui.js, core.js) ----------------
def _group_in(int_digits: str) -> str:
    """Indian grouping: 1,00,000."""
    if len(int_digits) <= 3:
        return int_digits
    head, tail = int_digits[:-3], int_digits[-3:]
    parts = []
    while len(head) > 2:
        parts.insert(0, head[-2:])
        head = head[:-2]
    if head:
        parts.insert(0, head)
    return ",".join(parts + [tail])


def _num(n: float, digits: int = 0) -> str:
    s = f"{abs(n):.{digits}f}"
    whole, _, frac = s.partition(".")
    return _group_in(whole) + (f".{frac}" if frac else "")


def _ok(n) -> bool:
    return isinstance(n, (int, float)) and math.isfinite(n)


def fmt_l(l, digits: int = 0) -> str:
    return f"{'-' if _ok(l) and l < 0 else ''}{_num(l, digits)}{NBSP}L" if _ok(l) else "—"


def fmt_kl(l) -> str:
    if not _ok(l):
        return "—"
    kl = f"{l / 1000:.3f}".rstrip("0").rstrip(".")
    whole, _, frac = kl.partition(".")
    return f"{_group_in(whole)}{'.' + frac if frac else ''} KL"


def fmt_signed(l, unit: str = " L", digits: int = 0) -> str:
    if not _ok(l):
        return "—"
    return f"{'+' if l > 0 else '−' if l < 0 else '±'}{_num(l, digits)}{unit}"


def fmt_pct(p) -> str:
    if not _ok(p):
        return "—"
    return f"{'+' if p > 0 else '−' if p < 0 else '±'}{abs(p):.2f}%"


def fmt_dip(cm) -> str:
    return f"{cm:.1f}{NBSP}cm" if _ok(cm) else "—"


def fmt_money(n) -> str:
    if not _ok(n):
        return "—"
    return f"{'−' if n < 0 else ''}₹{_group_in(str(int(math.floor(abs(n) + 0.5))))}"


def _when(t) -> datetime | None:
    if t is None or t == "":
        return None
    try:
        if isinstance(t, (int, float)):
            return datetime.fromtimestamp(t, IST)
        return datetime.fromisoformat(str(t).replace("Z", "+00:00")).astimezone(IST)
    except (ValueError, OSError):
        return None


def fmt_time(t) -> str:
    d = _when(t)
    return f"{d.hour:02d}:{d.minute:02d}" if d else "—"


def fmt_date(t, with_year: bool = False) -> str:
    d = _when(t)
    return f"{d.day} {MON[d.month - 1]}{f' {d.year}' if with_year else ''}" if d else "—"


def fmt_duration(start, end) -> str:
    """fmtDuration: "21 min", "1 h 06 min", "under 1 min"; '' if unknown."""
    a, b = _when(start), _when(end)
    if not a or not b or b < a:
        return ""
    mins = math.floor((b - a).total_seconds() / 60 + 0.5)
    if mins < 1:
        return "under 1 min"
    if mins < 60:
        return f"{mins} min"
    return f"{mins // 60} h {mins % 60:02d} min"


def compact_nos(nos) -> str:
    """compactNos: [3, 4, 5] -> "3–5", [1, 2] -> "1,2"."""
    s = sorted(nos or [])
    out, i = [], 0
    while i < len(s):
        j = i
        while j + 1 < len(s) and s[j + 1] == s[j] + 1:
            j += 1
        out.append(f"{s[i]}–{s[j]}" if j > i + 1 else f"{s[i]},{s[j]}" if j == i + 1 else f"{s[i]}")
        i = j + 1
    return ",".join(out)


def dip_at_litres(chart: dict | None, l):
    """core.js dipAtLitres."""
    if not chart or not chart.get("litres") or not _ok(l) or l < 0:
        return None
    start, step, litres = chart["startCm"], chart["stepCm"], chart["litres"]
    if l <= litres[0]:
        return start * l / litres[0]
    for i in range(1, len(litres)):
        if litres[i] >= l:
            a, b = min(litres[i - 1], l), litres[i]
            return start + (i - 1 + ((l - a) / (b - a) if b > a else 1)) * step
    return None


def band_view(band: str, direction: str) -> dict:
    """ui.js bandView."""
    if direction == "excess":
        return {"cls": "ok", "icon": "✓" if band == "ok" else "▲",
                "label": {"ok": "OK", "watch": "Excess", "high": "High excess"}.get(band, "")}
    return {"cls": band, "icon": {"ok": "✓", "watch": "!", "high": "✕"}.get(band, ""),
            "label": {"ok": "OK", "watch": "Watch", "high": "High short"}.get(band, "")}


def stock_proof(r: dict | None) -> dict | None:
    """core.js stockProof, as far as the picture needs it: {proof, live, short}."""
    src = (r or {}).get("source")
    server = (r or {}).get("via") in ("server", "anydesk")
    if src == "photo":
        if server and r.get("picture") is False:
            return {"proof": False, "live": True, "short": "FuelTrans live figure, no screenshot"}
        return {"proof": True, "short": "automation screen (server)" if server else "screenshot"}
    if src == "photo-edited":
        return {"proof": True, "short": "screenshot, corrected"}
    if src == "dip":
        cm = f"{r['dip']} cm" if _ok(r.get("dip")) else ""
        return {"proof": True, "short": f"dip {cm}" if cm else "dip"}
    if src == "litres":
        return {"proof": False, "short": "typed, no proof"}
    return None


# ---- the result's figures, as the app's Result screen has them --------------------
def model(s: dict, tank_names: dict, chart: dict | None = None, made_at=None) -> dict:
    """wizard.js resultModel for a finished decantation `s` (its cloud row).
    tank_names: {tank id: "Tank 2"}."""
    d = s.get("data") or {}
    inv = d.get("invoice") or {}
    rows = d.get("tanks") or []
    name = lambda tid: tank_names.get(tid) or str(tid)          # noqa: E731
    dip = lambda r: (r.get("dip") if _ok((r or {}).get("dip"))     # noqa: E731
                     else dip_at_litres(chart, (r or {}).get("volume"))) if r else None

    def proof_note(r):
        p = stock_proof(r)
        return f" · {p['short']}" if p else ""

    tot_l = sum(t.get("litres") or 0 for t in rows)
    tot_v = round(sum(((t.get("result") or {}).get("variation") or 0) for t in rows), 2)
    prices = d.get("prices") or {}
    money = sum((t["result"]["variation"] * prices[t.get("product")])
                for t in rows if t.get("result") and prices.get(t.get("product")))
    direction = "short" if tot_v < 0 else "excess" if tot_v > 0 else "exact"
    day = d.get("decantedAt") or d.get("startedAt") or s.get("created_at")
    tanks = []
    for t in rows:
        r = t.get("result")
        start = t.get("startedAt") or d.get("startedAt")
        done = t.get("doneAt") or d.get("decantedAt")
        bv = band_view(r["band"], r["direction"]) if r else None
        price = prices.get(t.get("product"))
        before, after = t.get("before") or {}, t.get("after") or {}
        lines = [
            [f"Stock before · {fmt_time(before.get('readingAt'))}{proof_note(before)}", fmt_l(before.get("volume"), 2), fmt_dip(dip(before))],
            [f"Stock after · {fmt_time(after.get('readingAt'))}{proof_note(after)}", fmt_l(after.get("volume"), 2), fmt_dip(dip(after))],
            ["Tank gained", fmt_l(r["gain"], 2) if r else "—", ""],
            [f"Chambers {compact_nos(t.get('chambers'))} (invoice)", fmt_l(t.get("litres")), ""],
        ]
        if t.get("salesL"):
            lines.append(["Sold while decanting", fmt_l(t["salesL"]), ""])
        lines.append(["Variation", fmt_signed(r["variation"], " L", 2) if r else "—",
                      fmt_money(r["variation"] * price) if r and price else "", True, (r or {}).get("direction")])
        tanks.append({
            "name": name(t.get("tank")),
            "product": t.get("product") or "—",
            "color": PRODUCT_COLOR.get(t.get("product"), "#898781"),
            "band": bv["cls"] if bv else None,
            "bandLabel": f"{bv['icon']} {bv['label']}" if bv else "",
            "direction": (r or {}).get("direction") or "exact",
            "variation": fmt_signed(r["variation"], " L", 2) if r else "—",
            "pctLine": f"{fmt_pct(r['pct'])} · OK within ±{fmt_l(r['tol'])}" if r else "",
            "meta": f"C{compact_nos(t.get('chambers'))} · {fmt_kl(t.get('litres'))} · {fmt_time(start)}–{fmt_time(done)}",
            "took": fmt_duration(start, done),
            "rows": lines,
        })
    summary = ("exact" if direction == "exact" else f"{direction} overall") \
        + f" · {fmt_pct(tot_v / tot_l * 100 if tot_l else 0)}" \
        + (f" · ≈ {fmt_money(money)} at invoice price" if money else "")
    made = made_at if made_at is not None else time.time()
    return {
        "title": s.get("tt_no") or "",
        "sub": f"Invoice {s.get('invoice_no') or '—'}"
               + (f" · {inv['invoice_date']} {inv.get('invoice_time') or ''}".rstrip() if inv.get("invoice_date") else ""),
        "total": fmt_kl(tot_l),
        "when": f"{fmt_date(day, True)} · {fmt_time(d.get('startedAt'))}–{fmt_time(d.get('decantedAt'))}",
        "took": fmt_duration(d.get("startedAt"), d.get("decantedAt")),
        "variation": fmt_signed(tot_v, " L", 2),
        "direction": direction,
        "summary": summary,
        "tanks": tanks,
        "notes": d.get("notes") or "",
        "footer": f"By {d['operator']}" if d.get("operator") else "",
        "audit": audit_line(rows, name),
        "made": f"Vriddhi Fuels tank stock agent · {fmt_date(made, True)} {fmt_time(made)}",
    }


def audit_line(rows: list, name) -> dict | None:
    """wizard.js auditLine: every stock here proven, or which aren't."""
    rows = [t for t in rows if t.get("before") and t.get("after")]
    if not any(stock_proof(t["before"]) or stock_proof(t["after"]) for t in rows):
        return None
    none = [(t, w, bool((stock_proof(t[w]) or {}).get("live"))) for t in rows for w in ("before", "after")
            if stock_proof(t[w]) and not stock_proof(t[w])["proof"]]
    if not none:
        return {"ok": True, "text": "✓ Audit: every stock here is from a screenshot or a dip — proof held."}
    lst = lambda xs: ", ".join(f"{name(t.get('tank'))} stock {w}" for t, w, _ in xs)   # noqa: E731
    typed = [x for x in none if not x[2]]
    live = [x for x in none if x[2]]
    parts = [f"{lst(typed)} typed in litres" if typed else "",
             f"{lst(live)} from FuelTrans' live figure (exact) with no screenshot" if live else ""]
    return {"ok": False, "text": f"⚠ Audit: {'; '.join(p for p in parts if p)} — no solid proof."}


def proofs(s: dict, tank_names: dict, picture_of) -> list:
    """The stock before / after pictures under the figures, tank by tank:
    [{png (bytes), label, sub}] or a blank cell {blank, label, sub}.
    picture_of(tank id, "before" | "after") -> JPEG bytes or b""."""
    out = []
    for t in (s.get("data") or {}).get("tanks") or []:
        for which in ("before", "after"):
            label = f"{tank_names.get(t.get('tank')) or t.get('tank')} · Stock {which}"
            pic = b""
            try:
                pic = picture_of(t.get("tank"), which) or b""
            except Exception:  # noqa: BLE001 - a picture missing is a blank cell, nothing more
                pic = b""
            if pic:
                out.append({"png": pic, "label": label, "sub": f"Screen time {fmt_time((t.get(which) or {}).get('readingAt'))}"})
            else:
                out.append({"blank": True, "label": label, "sub": "No screenshot of it"})
    return out


# ---- drawing it: the app's own code, in a Chromium of its own ---------------------
_PAGE = """<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Sora:wght@600;700;800&display=swap">
</head><body></body></html>"""

_DRAW_JS = """async (args) => {
  const { resultImage } = await import('/js/shareimg.js');
  const m = args.model;
  m.proofs = (args.proofs || []).map((p) => p.blank ? { blank: true, label: p.label, sub: p.sub }
    : { blob: new Blob([Uint8Array.from(atob(p.b64), (c) => c.charCodeAt(0))], { type: p.type }), label: p.label, sub: p.sub });
  const canvas = await resultImage(m);
  const blob = await new Promise((ok) => canvas.toBlob(ok, 'image/png'));
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}"""


def _draw(job: dict) -> bytes:
    """In this process: the picture, by decant/js/shareimg.js in a headless Chromium."""
    from playwright.sync_api import sync_playwright

    def serve(route):
        path = route.request.url.split("://", 1)[1].split("/", 1)[1].split("?")[0]
        if path in ("", "index.html"):
            return route.fulfill(status=200, body=_PAGE, content_type="text/html")
        f = (DECANT_JS / path[3:]).resolve() if path.startswith("js/") else None
        if f and f.parent == DECANT_JS.resolve() and f.suffix == ".js" and f.exists():
            return route.fulfill(status=200, body=f.read_text(encoding="utf-8"), content_type="text/javascript")
        return route.fulfill(status=404, body="")

    with sync_playwright() as p:
        # (RESULTIMG_CHROMIUM: a Chromium of its own, where Playwright's isn't installed: tests)
        browser = p.chromium.launch(executable_path=os.environ.get("RESULTIMG_CHROMIUM") or None,
                                    args=["--no-sandbox", "--disable-dev-shm-usage"])
        try:
            page = browser.new_page()
            page.route("https://result.invalid/**", serve)
            page.goto("https://result.invalid/index.html", wait_until="domcontentloaded", timeout=30000)
            b64 = page.evaluate(_DRAW_JS, job)
            return base64.b64decode(b64)
        finally:
            browser.close()


def render(m: dict, pics: list | None = None, timeout: float = RENDER_TIMEOUT_S) -> bytes:
    """The result picture (PNG bytes) for model `m` and proof pictures `pics`,
    drawn in a process of its own. Raises RuntimeError if it couldn't be."""
    job = {"model": m, "proofs": [
        {"blank": True, "label": p["label"], "sub": p["sub"]} if p.get("blank")
        else {"b64": base64.b64encode(p["png"]).decode(), "type": "image/png" if p["png"][:4] == b"\x89PNG" else "image/jpeg",
              "label": p["label"], "sub": p["sub"]}
        for p in (pics or [])]}
    try:
        done = subprocess.run([sys.executable, "-m", "tank_stock.resultimg"], input=json.dumps(job).encode(),
                              capture_output=True, timeout=timeout, cwd=str(ROOT))
    except subprocess.TimeoutExpired:
        raise RuntimeError(f"drawing it took over {timeout:.0f} s") from None
    if done.returncode != 0 or not done.stdout.startswith(b"\x89PNG"):
        raise RuntimeError((done.stderr.decode("utf-8", "replace").strip().splitlines() or ["it didn't draw"])[-1][:300])
    return done.stdout


if __name__ == "__main__":
    sys.stdout.buffer.write(_draw(json.loads(sys.stdin.buffer.read())))
