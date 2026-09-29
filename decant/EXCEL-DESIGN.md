# The Excel workbook's look: design brief for Claude in Excel

This is a separate message from [`EXCEL-WORKBOOK.md`](EXCEL-WORKBOOK.md): that
one says *what* the workbook calculates, this one how it should *look*, which
is like the decanting app. Paste it into Claude in Excel after the first
message, once the data, calculations and macros work. The values below come
from the app's own stylesheet (`decant/index.html`); if the app's look changes,
update them here.

---

**Style the workbook like our decanting app: dark, "glass" cards on an
orange-lit black background.** It's built and used in **Excel for Mac**
(Microsoft 365), so keep to what VBA and shapes can do there.

## 1. The idea, and what Excel can do

The app is **glassmorphism**:
- a near-black background, lit by a soft orange glow at the top right;
- content on translucent white "glass" cards with a hairline light border, a
  soft shadow and rounded corners;
- one warm accent: orange;
- three product colours: petrol, diesel and XtraGreen;
- green for good, amber for watch, red for bad.

Excel can't blur what's behind a shape, and shapes always float **above**
cells. So build it in two layers:

- **Dashboard sheets (Reports, Result, Home):** a canvas made of shapes and
  charts. There is a dark background, then glow shapes, then glass card
  shapes, then text boxes and charts on the cards. VBA refreshes the text and
  numbers. Nobody types on these sheets.
- **List and data sheets (Log, the tables, Checks, Imports):** cells styled
  dark with the *solid* equivalents of the glass colours (§2), so they look the
  same without shapes.

On every sheet: turn gridlines and headings off, set the whole sheet's fill to
the background colour, use a 110% zoom, and freeze the header rows.

## 2. Colours (use exactly these)

| Token | App value | In Excel | Used for |
|---|---|---|---|
| Background | `#0A0706` | fill `#0A0706` | every sheet's cells, the canvas |
| Glow, orange | `#F4511E` at 24% | radial-gradient shape: `#F4511E` at 24% → transparent (solid look `#42190C`) | top right of the canvas |
| Glow, amber | `#FF9E42` at 13% | radial shape, top left (solid `#2A1B0E`) | |
| Glow, blue | `#285AB4` at 12% | radial shape, bottom centre (solid `#0E111B`) | |
| Glass card | white at 5.5% | shape fill white, **transparency 94.5%**; in cells `#171514` | cards, KPI tiles, table blocks |
| Glass 2 | white at 9% | shape fill white, transparency 91%; cells `#201D1C` | buttons, chips, hover rows |
| Glass line | white at 14% | shape line white, transparency 86%, 0.75 pt; cells `#2C2A29` | card borders |
| Glass line, soft | white at 8% | cells `#1E1B1A` | row separators inside cards |
| Line | `#2C2E36` | | table header underline |
| Text | `#F5F0EB` | | main text and numbers |
| Muted | `#B4ABA2` | | secondary text |
| Faint | `#8A8178` | | captions, labels, times |
| Accent | `#FF7A1A` | | active tab, links, focus |
| Accent 2 | `#F4511E` | | the gradient's start |
| CTA gradient | `#F4511E` → `#FF8A2B` at 135° | two-stop linear gradient | the main button (Import) |
| Accent soft | `#FF7A1A` at 14% | on a card: `#382315` | highlighted card, selected row |
| Good | `#2FD08A`; its badge background on a card `#1B3327` | | OK, excess, proof held |
| Warn | `#FFB23E`; badge background `#3A2C1A` | | Watch, old invoices, audit warning |
| Bad | `#FF6B5E`; badge background `#3A221F` | | High short, errors |
| Short (charts) | `#E66767` | | negative variation |
| Excess (charts) | `#22A06B` | | positive variation |
| Petrol (MS) | `#D95926` | | |
| Diesel (HSD) | `#3987E5` | | |
| XtraGreen (XG) | `#199E70` | | |
| Chart grid | `#2C2C2A` | | |
| Chart zero line | `#56524D` | | |
| Chart ticks | `#9A938B` | | |

- **Product colours never mean anything else.** Status colours
  (good/warn/bad) are never used for products.
- **Colour is never alone:** every status also has its icon and word (§5).
- Don't use Office theme colours or Excel's default chart styles.

## 3. Type

| Role | Font (install on the Mac from Google Fonts) | Fallback | Size / weight |
|---|---|---|---|
| Display: titles, big numbers, KPI values | **Sora** | Avenir Next | titles 17 pt 800, section titles 15 pt 700, big numbers 27–30 pt 800, KPI values 21 pt 800 |
| Body | the Mac system font (Helvetica Neue / SF Pro) | Arial | 11 pt, secondary 9.5 pt |
| Numbers | body font; align right | | tables 10 pt |
| Times, IDs | **IBM Plex Mono** | Menlo | 9 pt, faint |
| Labels | body font, UPPER CASE, letter-spaced | | 8.5 pt, 600, faint |

Text is always `#F5F0EB` on dark, never pure white, except white on the
orange header and buttons.

## 4. Canvas pieces (shapes, drawn by VBA)

- **Background:** one rectangle covering the used area: fill `#0A0706`, no
  line, sent to the back.
- **Glow:** three ovals with a radial ("from centre") gradient:
  - orange, 600 × 300 pt, at the top right;
  - amber, 480 × 320 pt, at the top left;
  - blue, 540 × 380 pt, at the bottom centre.

  Each goes from its colour at the opacity above to fully transparent, with
  no line, just above the background.
- **Header band**, the full width at the top, 44 pt tall:
  - a rectangle with a linear gradient from `#CA441A` to `#A24E12` (what the
    app's translucent orange header looks like over black);
  - a thin line under it, white at 16%;
  - a soft orange shadow below (`#F4511E`, blur 20 pt, 60% transparent).
  - Text "⛽ Vriddhi Fuels — Decanting" in Sora 17 pt 800, white, with a faint
    dark text shadow.
  - At the right, a **status pill** for the latest import:
    - a rounded pill with white 18% fill and a white 38% line;
    - a 7 pt dot: green `#8DFFCF` for "imported", amber `#FFE08A` for "old";
    - text 8.5 pt 700 white, e.g. "Sep 2026 · so far".
- **Tab bar** under the header, a strip of pills that link to the sheets:
  - pills: **Log · Reports · Result · Checks · Import**;
  - the strip is `#0B0807` with a soft white 8% line under it;
  - inactive tabs: text `#B4ABA2`, no fill;
  - the active tab: fill `#45230B`, line `#FF7A1A` at 40%, text white, and a
    soft orange shadow;
  - rounded 8 pt, Sora 10.5 pt 700;
  - **badges** on tabs, as in the app: a small gradient pill (`#F4511E` →
    `#FF8A2B`) with the count in white 8 pt 800, e.g. on Checks when a ✗
    exists.
  - Use a hyperlink to the sheet (or a macro) for each pill.
- **Glass card:**
  - a rounded rectangle, with corners about 12 pt (the adjustment set so the
    radius is ~12 pt);
  - fill white at 94.5% transparency, and a white line at 86%, 0.75 pt;
  - an outer shadow: black, 90% opaque, offset 0 / 8 pt, blur 20 pt,
    size −4%;
  - optionally, a 0.5 pt white line at 90% transparency just inside the top
    edge, for the glass highlight;
  - 10 pt padding inside, and 9 pt gaps between cards.
- **Accent card** (the Result header and highlighted cards): the same, but
  with a linear gradient from `#FF7A1A` at 14% to white at 5.5% (150°), and a
  `#FF7A1A` line at 45%.
- **Warn card:** a line in `#FFB23E` and a 1 pt amber glow.

## 5. Components

- **Badge**, the result of a fill, a pill 8.5 pt 700 with the icon first:

  | Result | Badge | Colours |
  |---|---|---|
  | OK (short, exact or excess) | ✓ OK | `#2FD08A` on `#1B3327` |
  | Watch, short | ! Watch | `#FFB23E` on `#3A2C1A` |
  | High, short | ✕ High short | `#FF6B5E` on `#3A221F` |
  | Watch, excess | ▲ Excess | green (the tank got more: good for us) |
  | High, excess | ▲ High excess | green |
  | Info (e.g. "On the way") | | `#B4ABA2` on `#201D1C`, with a soft line |

  In cells, use conditional formatting with the same text colour, fill and
  icon.
- **Product chip:** a pill with a `#201D1C` fill and a soft line, a 7 pt dot in
  the product colour, then "MS" / "HSD" / "XG" in 9 pt 700.
- **KPI tile:**
  - a glass card, 3 across by 2 down;
  - a label in caps, 8.5 pt, faint;
  - the value in Sora 21 pt 800 (green `#2FD08A` if it's a positive
    variation);
  - a sub line in 9 pt muted.
  - The six tiles: **Decanted**, **Net variation**, **Short / excess**,
    **Outside tolerance**, **At invoice price**, **Worst**.
- **Product card**, 3 across (MS, HSD, XG), each a glass card:
  - a chip, with "n trucks · n tank fills" at the right;
  - the decanted KL as a big number (Sora 27 pt 800);
  - "decanted · net variation −70 L (−0.50%)" in 10 pt muted;
  - a soft divider, then "Purchased *by invoice date*" and its KL (Sora
    17 pt 800) at the right;
  - the **split bar** (a 100% stacked bar, 8 pt tall, rounded ends, 2 pt gaps):
    decanted in the app in the product colour, decanted outside it in the
    same colour at 45%, and in transit as diagonal stripes of the product
    colour with an outline;
  - the legend with each part's KL;
  - the **in-transit rows**: truck (bold) · KL · chambers (faint) and a status
    badge at the right, one of:
    - ● Decanting now (amber);
    - ◐ Rest of a part-decanted load (amber);
    - ! N days old (red);
    - On the way (info);
  - under each row: "Invoice … · date time" in faint.
- **Buttons:**
  - **main** (Import): the CTA gradient, rounded 10 pt, white Sora 11.5 pt
    800, and an orange glow shadow (`#F4511E`, blur 18 pt, 50%);
  - **secondary:** a `#201D1C` fill with a `#2C2A29` line, rounded 8 pt, text
    `#F5F0EB` in 10 pt 600;
  - **danger:** text `#FF6B5E` with a red line at 40%.
- **Section heading** (above a group of cards): caps, 10 pt 700, muted,
  letter-spaced, with a faint count next to it, e.g.
  "VARIATION  tank gain vs the chambers".
- **Table** (on a card, or in cells):
  - header row: caps, 8.5 pt, faint, with a `#2C2E36` underline;
  - rows: 10 pt, with soft separators (`#1E1B1A`) and no zebra stripes;
  - numbers right-aligned;
  - a clickable truck row turns `#201D1C` when selected (`#382315`);
  - a **minibar** after each %: a 48 pt × 6 pt track (`#282524`, rounded)
    with a centre line in `#56524D`. The bar grows left in `#E66767` for
    negative values and right in `#22A06B` for positive ones, scaled to the
    largest |%| in the table.
- **Day heading** (Log): left, the day in caps, letter-spaced 9 pt 700 muted,
  e.g. "SAT 26 SEP 2026"; right, "3 decants · 44 KL · −120 L" in normal case,
  faint.
- **Log card**, one per invoice:
  - a glass row, rounded 10 pt;
  - the head line: the time (IBM Plex Mono, faint), the truck (bold) and the
    invoice number (faint);
  - one line per tank: chip · "Tank 2 · C1–3 · 14,000 L" · at the right, the
    variation in bold (green if +), the % in faint, and the badge;
  - typed stock with no proof gets an amber "✎ typed stock, no proof";
  - a card with several tanks shows its total at the right of the head line.
- **Empty state:** a dashed-line (white 14%) rounded box, with centred text
  in faint 10.5 pt.
- **Banner** (a message across the top):
  - warn: a `#FFB23E` line with a `#3A2C1A` fill;
  - bad: `#FF6B5E` with `#3A221F`;
  - good: `#2FD08A` with `#1B3327`.

## 6. Charts (chart objects placed on glass cards)

For both charts:
- chart area and plot area: **no fill, no border** (so the card shows
  through);
- font: body font, ticks 8.5 pt `#9A938B`;
- gridlines `#2C2C2A` at 0.5 pt; the zero line `#56524D` at 0.75 pt;
- no chart title (the card's section title names it);
- the legend is a row of small keys under the card's title, not Excel's
  legend box;
- no 3D, no shadows, no gradients on the data.

**Net variation per day** (or per month):
- clustered columns with **two series**: *Short* = MIN(0, v) in `#E66767`
  and *Excess* = MAX(0, v) in `#22A06B`;
- overlap 100%, gap width 35%;
- about 180 pt tall;
- the y axis in litres with a real minus "−";
- x labels thinned so they don't overlap (e.g. every 3rd day);
- data labels off; the value shows in a tooltip or a hover comment if
  possible;
- the day-by-day table sits in a fold-out under it.

**Every decantation:**
- an XY scatter, one series per product in its colour;
- round markers of 6 pt with a 1 pt `#171514` outline (so overlaps stay
  apart), and no lines;
- the tolerance band: two dashed lines at +tol% and −tol% (`#9A938B` at 60%,
  0.75 pt), with the space between shaded `#FFFFFF` at 4% (an area on a
  secondary axis, or a rectangle behind the plot);
- the y axis symmetric, with "%" and signs;
- about 190 pt tall;
- a note under it: "Each dot is one tank filled; below the line = short."

**Purchased split bar:** see Product card (§5).

## 7. Layout of each sheet

The canvas is one column of cards, 720 pt wide, in reading order like the app
on a wide phone. Cards sit 12 pt apart, with 18 pt margins.

- **Reports:**
  - header and tabs;
  - the filter row: Period, Truck and Product (data-validation drop-downs in
    dark cells with an orange `#FF7A1A` border when focused), plus the ⬇ Excel
    button;
  - a faint line with the date range;
  - 3 product cards;
  - the heading "VARIATION";
  - the KPI grid, 3 × 2;
  - the "Net variation per day" card;
  - the "Every decantation" card;
  - "By truck", "By product" and "By tank" cards, then "By month" when there
    is more than one month.
- **Log:**
  - header and tabs;
  - the period segmented control: four pills, with the active one as the
    active tab;
  - Truck, Product and a search box;
  - the summary card: "**5** decantations · **110 KL**", then "Net variation
    **−187 L** (−0.17%) · 3 outside tolerance", with the ⬇ Excel and CSV
    buttons at the right;
  - the days (headings, then Log cards);
  - "▸ Cancelled n", folded.
- **Result:**
  - header and tabs;
  - the decantation picker;
  - an **accent card**:
    - "Decanted 22 KL from OD23U8210 · 11:07–11:18" (faint);
    - the variation big (Sora 30 pt 800): `#FF9A90` if short, `#2FD08A` if
      excess, `#F5F0EB` if exact;
    - "short overall · −0.85% · ≈ −₹18,391 at invoice price" (faint);
    - the audit line, green "✓ Audit …" or amber "⚠ Audit …", 10 pt;
  - one glass card per tank:
    - the name "Tank 2" (Sora 700), chip and badge;
    - "C1–3 · 14 KL · decanted 11:07–11:12";
    - the variation (Sora 22 pt 800, coloured as above), with the % and
      "OK within ±35 L" at the right;
    - the comparison table (header caps, faint); its last "Variation" row is
      bold, and green if +;
  - the notes card, and "By … · HSD density …" in faint;
  - a "Save as picture" button, which copies the Result area as a picture.
- **Checks:** the count as a banner at the top (good or bad), then the table
  with a ✓ (green) or ✗ (red) per row.
- **Import:** a card with the main **Import monthly files…** button and a
  secondary **Import open files** button, then the Imports table.

## 8. Numbers as the app writes them

| What | Custom number format | Shows |
|---|---|---|
| Litres, positive, Indian grouping | `[>=10000000]##\,##\,##\,##0" L";[>=100000]##\,##\,##0" L";##,##0" L"` | 14,000 L · 1,23,456 L |
| Litres, 2 decimals | the same with `.00` | 17,376.58 L |
| KL | `0.###" KL"` (value = L ÷ 1000; drop a trailing ".") | 22 KL · 4.5 KL |
| Signed litres | `+#,##0.00" L";−#,##0.00" L";±0.00" L"` | −70.22 L |
| % (the value is already in %) | `+0.00"%";−0.00"%";±0.00"%"` | −0.50% |
| ₹ | `"₹"#,##0;−"₹"#,##0;"₹"0` | −₹6,892 |
| Date | `d mmm yyyy` | 26 Sep 2026 |
| Time | `hh:mm` | 11:18 |

Use the true minus sign "−" (U+2212), not a hyphen, and "±" for zero. Set the
numbers in text boxes on the canvas with VBA in the same way.

## 9. Finish

- Protect the dashboard sheets, so nothing moves by accident; the filter
  cells stay unlocked.
- Keep every shape named by what it is (`card_kpi_decanted`,
  `txt_kpi_decanted_value`…), so the refresh macro finds it. Group each card's
  shapes.
- Redraw only the numbers, bars and charts on refresh; don't rebuild the
  canvas each time, which is slow on a Mac.
- Check it at 100% and 125% zoom on the Mac screen: nothing clipped, no
  overlapping labels.

Build the look sheet by sheet: Reports first, then Log, then Result, then
Checks and Import.
