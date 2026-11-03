#!/usr/bin/env python3
"""Write ledger/js/sheet-layouts.js from the Tanker Billing workbook.

The ledger app (/ledger/) prints quotations and proforma invoices laid out
like the workbook's **Quotation Maker** and **Proforma Invoice** sheets. This
reads each sheet's print area once — column widths, row heights, merged
cells, fonts, fills, borders, alignment, the letterhead / stamp positions and
the fixed wording — and writes it as a JavaScript module the app draws from.

Only the sheet's *design* is copied: input cells (the customer, PI number,
quantity …) and formula cells are left empty here; the app fills them. So no
customer data ends up in the file. The fixed wording is also read again from
the workbook every time it is imported in the app (Quotes → Import), so
changing a term or a note in Excel only needs an import, not this script.
Run this again only when the *layout* changes (rows / columns moved,
widths, fonts):

    python3 tanker/sheet_layouts.py "Tanker Billing.xlsm"
"""

from __future__ import annotations

import json
import os
import re
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "ledger", "js", "sheet-layouts.js")

# Mac Excel: one width unit of the default font (Aptos Narrow 12) is 8 px =
# 6 pt. Checked against the letterhead anchors: Proforma A:H = 189.64 units,
# the picture spanning them is 1,139 pt wide.
PT_PER_UNIT = 6.0
EMU_PER_PT = 12700

# Cells the user fills in (or that hold a customer's name): never copied.
SHEETS = {
    "quotation": {"sheet": "Quotation Maker", "inputs": {"A5"}},
    "proforma": {"sheet": "Proforma Invoice", "inputs": {"A12", "G4", "G5", "G7", "G8", "E19"}},
}

THEME = {0: "#FFFFFF", 1: "#000000", 2: "#0E2841", 3: "#E8E8E8", 4: "#156082", 5: "#E97132"}


def color(c, default="#000000"):
    if c is None:
        return default
    if c.type == "rgb" and isinstance(c.rgb, str) and len(c.rgb) == 8:
        return "#" + c.rgb[2:].upper()
    if c.type == "theme":
        return THEME.get(c.theme, default)
    return default


def col_letter(i):
    s = ""
    i += 1
    while i:
        i, r = divmod(i - 1, 26)
        s = chr(65 + r) + s
    return s


def sheet_defaults(xml):
    fmt = re.search(r"<sheetFormatPr([^>]*)>", xml)
    attrs = dict(re.findall(r'(\w+)="([^"]*)"', fmt.group(1))) if fmt else {}
    width = float(attrs.get("defaultColWidth") or (float(attrs.get("baseColWidth", 8)) + 0.83))
    height = float(attrs.get("defaultRowHeight", 15))
    return width, height


def drawing_pictures(z, sheet_path):
    """[{name, col, colOff, row, rowOff, toCol, toColOff, toRow, toRowOff}] of the sheet's pictures."""
    rels_path = sheet_path.replace("worksheets/", "worksheets/_rels/") + ".rels"
    if rels_path not in z.namelist():
        return []
    rels = z.read(rels_path).decode()
    m = re.search(r'Target="\.\./drawings/(drawing\d+\.xml)"', rels)
    if not m:
        return []
    xml = z.read("xl/drawings/" + m.group(1)).decode()
    out = []
    for a in re.findall(r"<xdr:twoCellAnchor.*?</xdr:twoCellAnchor>", xml, re.S):
        if "<xdr:pic>" not in a:
            continue
        nums = lambda tag: [int(x) for x in re.findall(r"<xdr:\w+>(\d+)</xdr:\w+>", re.search(f"<xdr:{tag}>(.*?)</xdr:{tag}>", a, re.S).group(1))]
        f, t = nums("from"), nums("to")
        name = re.search(r'<xdr:cNvPr [^>]*name="([^"]*)"', a).group(1)
        out.append({"name": name, "from": f, "to": t})
    return out


def extract(path):
    import openpyxl

    wb = openpyxl.load_workbook(path, data_only=False)
    z = zipfile.ZipFile(path)
    wbxml = z.read("xl/workbook.xml").decode()
    rels = z.read("xl/_rels/workbook.xml.rels").decode()
    sheet_files = {}
    for name, rid in re.findall(r'<sheet name="([^"]+)" sheetId="\d+" r:id="(rId\d+)"', wbxml):
        target = re.search(rf'Id="{rid}"[^>]*Target="([^"]+)"', rels) or re.search(rf'Target="([^"]+)"[^>]*Id="{rid}"', rels)
        sheet_files[name] = "xl/" + target.group(1)

    layouts = {}
    for key, cfg in SHEETS.items():
        ws = wb[cfg["sheet"]]
        xml = z.read(sheet_files[cfg["sheet"]]).decode()
        def_w, def_h = sheet_defaults(xml)
        area = ws.print_area[0] if isinstance(ws.print_area, list) else ws.print_area
        m = re.search(r"\$?([A-Z]+)\$?(\d+):\$?([A-Z]+)\$?(\d+)", area)
        from openpyxl.utils import column_index_from_string
        c0, r0 = column_index_from_string(m.group(1)), int(m.group(2))
        c1, r1 = column_index_from_string(m.group(3)), int(m.group(4))
        assert c0 == 1 and r0 == 1, "print area must start at A1"

        widths = [def_w] * c1
        for dim in ws.column_dimensions.values():
            if dim.width:
                for c in range(dim.min, min(dim.max, c1) + 1):
                    widths[c - 1] = dim.width
        heights = []
        for r in range(1, r1 + 1):
            d = ws.row_dimensions.get(r)
            heights.append(d.height if d is not None and d.height else def_h)

        styles, style_ix = [], {}
        cells = {}
        inputs = cfg["inputs"]
        for row in ws.iter_rows(min_row=1, max_row=r1, max_col=c1):
            for c in row:
                f, a, b = c.font, c.alignment, c.border
                fill = c.fill.fgColor if c.fill and c.fill.fill_type == "solid" else None
                st = {
                    "f": f.name or "Aptos Narrow", "s": float(f.sz or 12),
                    "c": color(f.color),
                }
                if f.b:
                    st["b"] = 1
                if f.i:
                    st["i"] = 1
                if fill is not None:
                    st["bg"] = color(fill, "#FFFFFF")
                if a.horizontal:
                    st["h"] = a.horizontal
                if a.vertical:
                    st["v"] = a.vertical
                if a.wrap_text:
                    st["w"] = 1
                edges = []
                for side in ("left", "right", "top", "bottom"):
                    s = getattr(b, side)
                    edges.append({"thin": 1, "medium": 2, "thick": 3, "hair": 1}.get(s.style, 0) if s is not None and s.style else 0)
                if any(edges):
                    st["bd"] = edges
                sig = json.dumps(st, sort_keys=True)
                if sig not in style_ix:
                    style_ix[sig] = len(styles)
                    styles.append(st)
                entry = {"s": style_ix[sig]}
                v = c.value
                if c.coordinate in inputs:
                    entry["in"] = 1
                elif isinstance(v, str) and v.startswith("="):
                    entry["fx"] = 1
                elif v is not None and not isinstance(v, str):
                    entry["fx"] = 1          # numbers / dates on the layout are filled by the app
                elif isinstance(v, str) and v.strip():
                    entry["t"] = v
                plain = {k: x for k, x in entry.items() if k != "s"}
                if plain or styles[entry["s"]] != {"f": "Aptos Narrow", "s": 12.0, "c": "#000000"}:
                    cells[c.coordinate] = entry

        merges = [str(r) for r in ws.merged_cells.ranges
                  if r.min_row <= r1 and r.min_col <= c1]

        col_pt = [round(w * PT_PER_UNIT, 2) for w in widths]
        xs = [0.0]
        for w in col_pt:
            xs.append(xs[-1] + w)
        ys = [0.0]
        for h in heights:
            ys.append(ys[-1] + h)

        def pos(col, off, row, roff):
            x = xs[min(col, len(xs) - 1)] + off / EMU_PER_PT
            y = ys[min(row, len(ys) - 1)] + roff / EMU_PER_PT
            return round(x, 2), round(y, 2)

        images = []
        for p in drawing_pictures(z, sheet_files[cfg["sheet"]]):
            fc, fco, fr, fro = p["from"]
            tc, tco, tr, tro = p["to"]
            if fc >= c1 or fr >= r1:
                continue                          # buttons and helpers outside the print area
            x0, y0 = pos(fc, fco, fr, fro)
            x1, y1 = pos(tc, tco, tr, tro)
            images.append({"key": "letterhead" if fr == 0 else "stamp", "x": x0, "y": y0,
                           "w": round(x1 - x0, 2), "h": round(y1 - y0, 2)})

        pm = ws.page_margins
        layouts[key] = {
            "sheet": cfg["sheet"], "cols": col_pt, "rows": heights,
            "margins": {k: round(getattr(pm, k) * 72, 2) for k in ("left", "right", "top", "bottom")},
            "center": bool(ws.print_options.horizontalCentered),
            "merges": merges, "styles": styles, "cells": cells, "images": images,
        }
    return layouts


def main(argv):
    if len(argv) != 2:
        print(__doc__)
        return 2
    layouts = extract(argv[1])
    body = json.dumps(layouts, ensure_ascii=False, separators=(",", ":"))
    with open(OUT, "w", encoding="utf-8") as fh:
        fh.write("// Made by tanker/sheet_layouts.py from the Tanker Billing workbook — don't edit by hand.\n")
        fh.write("// The Quotation Maker and Proforma Invoice sheets' print areas: column widths and row\n")
        fh.write("// heights in points, merged cells, cell styles, fixed wording and picture positions.\n")
        fh.write(f"export const LAYOUTS = {body};\n")
    print(f"wrote {OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
