# The Excel workbook: message for Claude in Excel

The decanting app gives one **monthly log file** per month (Log tab → 📥 Monthly
log files). Paste the message below into Claude in Excel. It builds a
macro workbook that imports those files month after month, and rebuilds the
app's Log, Reports and Result screens from them: the same figures, rounding
and charts. If the app's rules change, update this message too (it mirrors
`js/core.js`, `js/report.js`, `js/views.js`, `js/wizard.js` and
`js/archive.js`).

---

**Build me a macro workbook (.xlsm): "Vriddhi Fuels — Decanting reports".**

We run a fuel station with four underground tanks, 20,000 L each:

| Tank | Product |
|---|---|
| T1 | MS (petrol) |
| T2 | HSD (diesel) |
| T3 | HSD (diesel) |
| T4 | XG (XtraGreen) |

IOCL tank trucks ("TT") bring fuel in chambers, and each chamber is emptied
("decanted") into one tank. A phone app records every decantation: which
chambers went into which tank, the tank's stock before and after, and the
**variation**, which is what the tank gained against what the chambers held.
Every month the app gives an Excel **monthly log file**. The workbook must
import these files one month after another, keep them all, and rebuild the
app's Log, Reports and Result screens exactly: the same numbers, rounding,
labels and charts. It must work offline, with no add-ins. Use VBA for
importing and rebuilding. Put all data in Excel Tables.

## 1. The monthly log files (what you import)

The files are named `Vriddhi decanting log YYYY-MM.xlsx`.

- **Layout:** each sheet is one table, with headers in row 1 and one record
  per row.
- **Dates:** date and time cells are real Excel dates, in India time.
- **Blanks:** an empty cell means there is no value.

**Info** has two columns, `Item` and `Value`. Its rows are:
- `File`, `Month` (YYYY-MM) and `Month name`;
- `Format`, which is 1 (refuse any other);
- `Whole month`: `Yes`, or `No — so far` for a file taken before the month
  ended (the whole month's file replaces it later: it has the same Month);
- `Made at` and `Made by`;
- the counts of decantations (finished, cancelled, still open), tank fills and invoices;
- `Variation OK within (%)`, `… or within (L), whichever is more` and
  `Truck density vs invoice OK within (± kg/m³)`: the settings the file's results used;
- one row per tank.

**Fills**: one row per tank filled in a finished decantation. This is the
basis of the Log and the Reports.

| Column | Meaning |
|---|---|
| Fill ID | Decantation ID + ":" + tank (unique) |
| Decantation ID | |
| Decanted at | date-time the decantation was finished decanting |
| Day | date of *Decanted at* (India time); reports go by this |
| Truck, Invoice | |
| Product | MS / HSD / XG |
| Tank, Tank no | T2, 2 |
| Chambers | e.g. `1+2+3` |
| Decanted (L) | what the chambers held, from the invoice |
| Sold while decanting (L) | 0 except in very old records |
| Stock before (L), Before dip (cm), Before read at, Before from, Before, screen said (L) | the tank's stock before, and where it came from |
| Stock after (L), After dip (cm), After read at, After from, After, screen said (L) | the same for after |
| Tank gain (L), Expected (L), Variation (L), Variation (%), Tolerance (L), Band, Direction | the app's result (recompute them: §4) |
| Price (₹/L), Value (₹) | invoice price per litre; value of the variation |
| Proof | `Yes` / `No — typed litres` / blank |
| Tank started at, Tank done at | when that tank's decanting started and finished |

*Before from* and *After from* are one of these:
- `Screenshot`;
- `Screenshot, corrected by hand (the screen said 12,091.45 L)`;
- `Dip 49.6 cm`;
- `Typed litres — no solid proof`.

**Decantations**: one row per decantation, of any status.

| Column | Meaning |
|---|---|
| Decantation ID | |
| Status | `done` / `cancelled` / `draft` / `decanting` / `settling` |
| Invoice, Invoice date, Invoice time, Truck | |
| Entered at, Started at, Decanted at, Finished at | |
| By | the operator |
| Tanks | e.g. `T2 + T3` |
| Decanted (L), Net variation (L), Variation (%), Value (₹) | |
| Audit | the proof line |
| Density check | e.g. `HSD 831.2 (+0.2 vs invoice 831)` |
| Notes, Cancelled because | |

**Chambers**: one row per chamber of a decantation.

| Column | Meaning |
|---|---|
| Decantation ID, Invoice, Truck | |
| Chamber, Product, Litres | |
| Into tank | the tank it went into |
| Truck dip (cm) | |

**Density**: one row per product density check.

| Column | Meaning |
|---|---|
| Decantation ID, Invoice, Truck, Product | |
| Reading (kg/m³), Temperature (°C) | |
| Density at 15 °C | the app's result (recompute: §9) |
| Invoice density at 15 °C, Difference, OK | |

**Invoices**: one row per invoice product line.

| Column | Meaning |
|---|---|
| Invoice, Invoice date, Invoice time, Truck | |
| Line | 1, 2 … |
| Product, Product as invoiced | |
| Quantity (L), Compartments, Density at 15 °C, Terminal tank | |
| Line value (₹), Invoice amount (₹) | |
| Origin, Seals, Source | |
| Hidden, Hidden because | `decanted outside the app` / `not ours` / `deleted` |
| Note, Entered at | |
| Decanted in the app (L), Still on the truck (L) | as the app knew it when the file was made |

**Invoice chambers**: `Invoice, Truck, Chamber, Quantity (KL), PL (cm), Dip (cm)`.

**App totals**: the app's own sums over this file's fills, for checking.
Columns: `Group` (Month / Day / Truck / Product / Tank), `Key`, `Tank fills`,
`Decantations`, `Decanted (L)`, `Net variation (L)`, `Variation (%)`,
`Short (L)`, `Excess (L)`, `Outside tolerance`, `Value (₹)`.

A record's month is the India-time month it was *entered*. So a decantation
entered on 31 Aug at 23:50 and decanted on 1 Sep is in the August file, but
its Day is 1 Sep. Reports always go by Day (or by invoice date for purchases).
An invoice can also be in one month's file while its decantation is in the
next month's file, so always join on the invoice number across all imported
months.

## 2. Import

A button, **Import monthly files…**, opens a file picker that takes one or
more files. For each file:

1. Read Info → Month and Format.
2. Delete every row of every data table whose `Source month` equals that
   month.
3. Append the file's rows, adding `Source month` and `Imported at`.

Re-importing a month therefore replaces it. The app offers "download it
again" when a month changed after its file.

- **Tables:** tblFills, tblDecantations, tblChambers, tblDensity,
  tblInvoices, tblInvoiceChambers and tblAppTotals, each with the file's
  columns plus Source month and Imported at.
- **Duplicates:** after importing, also drop duplicates by key and keep the
  newest import:
  - Fill ID;
  - Decantation ID;
  - Invoice + Line;
  - Decantation ID + Chamber;
  - Invoice + Chamber.
- **Imports sheet:** Month, file name, imported at, Made at, and the rows per
  sheet.
- **Afterwards:** recalculate and rebuild every report.

## 3. Settings sheet (the app's defaults)

| Setting | Default |
|---|---|
| Variation OK within (%) | 0.25 |
| … or within (L), whichever is more | 25 |
| Truck density OK within (± kg/m³) | 3 |
| Undecanted invoices are old after (days) | 3 |

- **Tanks:** T1/1/MS, T2/2/HSD, T3/3/HSD, T4/4/XG.
- **Product names:** MS "Petrol (MS)", HSD "Diesel (HSD)", XG "XtraGreen".
- **Colours:**

  | Use | Colour |
  |---|---|
  | MS | #D95926 |
  | HSD | #3987E5 |
  | XG | #199E70 |
  | short (tank got less) | #E66767 |
  | excess (tank got more) | #22A06B |
  | Watch | amber #E0A030 |

## 4. A fill's result (recompute exactly like the app)

The app rounds like JavaScript's `Math.round`, where halves go up (toward
+∞). Write a VBA function `JSRound(x, d) = Int(x * 10 ^ d + 0.5) / 10 ^ d`
and use it everywhere below. Do **not** use Excel's ROUND, which sends halves
away from zero.

For each fill:

- **Gain** = JSRound(After − Before, 2)
- **Expected** = JSRound(Decanted − Sold while decanting, 2)
- **Variation** = JSRound(Gain − Expected, 2). Negative means short (the tank
  got less than the chambers held); positive means excess.
- **Variation %** = 0 if Decanted = 0, else JSRound(Variation / Decanted × 100000, 0) / 1000. That is 3 decimals.
- **Tolerance (L)** = MAX(MinL, Decanted × Tol% / 100). Show it with 2 decimals.
- **Band**:
  - |Variation| ≤ Tolerance → `OK`;
  - |Variation| ≤ 2 × Tolerance → `Watch`;
  - otherwise `High`.
- **Direction** = `short` if Variation < 0, `excess` if > 0, `exact` if 0.
- **Value (₹)** = JSRound(Variation × Price, 2), or blank when there is no
  price.
- **Badge** (the label the app shows):
  - excess: OK → "✓ OK", Watch → "▲ Excess", High → "▲ High excess", all
    green;
  - short or exact: OK → "✓ OK" (green), Watch → "! Watch" (amber),
    High → "✕ High short" (red).
- **Proof**:
  - "No — typed litres" if Before from or After from starts with "Typed";
  - "Yes" if both come from a screenshot or a dip;
  - blank if neither has a source.

With Settings equal to a file's Info tolerance, your values must equal the
file's own columns.

## 5. Summaries and groups (as the app sums them)

For any set of fills:

| Figure | Rule |
|---|---|
| Tank fills | count |
| Decantations | distinct Decantation ID |
| Decanted | JSRound(Σ Decanted, 2) |
| Net variation | JSRound(Σ Variation, 2) |
| % | Net ÷ Decanted as above, 3 decimals |
| Short | JSRound(Σ MIN(0, Variation), 2) |
| Excess | JSRound(Σ MAX(0, Variation), 2) |
| Outside tolerance | count of Band ≠ OK |
| Value | JSRound(Σ Value of the fills that have a price, 2); blank if none have one |
| Worst | the fill with the lowest Variation % |

Value adds the fills' already-rounded values.

Groups:

| Group | Order | Notes |
|---|---|---|
| Day | newest first | each day also split by product |
| Invoice | newest first | one card per invoice in the Log |
| Truck | by Decanted, largest first | add the Last day |
| Product | MS, HSD, XG | |
| Tank | T1 → T4 | |
| Month | newest first | |

## 6. Log sheet (the app's Log tab)

**Filters:**
- Period: `Today`, `7 days` (today and the 6 days before), `This month` or
  `Last month`;
- Truck;
- Product;
- a search box that matches the truck or the invoice number.

**Top line:** "N decantations · X KL — Net variation ±V L (±P%) · F outside
tolerance".

**Days:** for each day, newest first, a heading like "26 Sep 2026 — 3
decants · 44 KL · −120 L". Under it, one card per invoice, newest first:
- the time, truck and invoice;
- a line per tank: product, "Tank 2", chambers (see below), litres,
  variation (1 decimal), % and the badge;
- when the card has more than one tank, the card's total.

**Chambers** are written short: a run of 3 or more is joined with "–", a
run of 2 with ",". For example, 1,2,3 → "1–3"; 4,5 → "4,5"; 1,2,3,5 → "1–3,5".

**Also:** list the cancelled decantations underneath, folded away. Add an
**Export** button that writes the filtered Fills.

## 7. Reports sheet (the app's Reports tab)

**Filters:**
- Period:
  - `This month`: the 1st to today;
  - `Last month`;
  - `This FY`: 1 April to today;
  - `All`: everything imported;
  - `Custom`: from–to.
- Truck;
- Product.

**a) A card per product.** Show a card for MS, HSD and XG if a tank holds
that product or it has any figures.

- **Decanted:** by Day in the period: KL, fills, distinct trucks, and the net
  variation (L and %).
- **Purchased:** by *invoice date* in the period. It is the sum of the invoice
  lines' Quantity for that product. Skip invoices hidden because "not ours" or
  "deleted".
- **Split of what was purchased:**
  - Decanted in the app = MIN(line quantity, the litres of that product in
    this invoice's *finished* decantations, from all imported months);
  - Decanted outside the app = the lines of invoices hidden because "decanted
    outside the app";
  - In transit = the rest.

  Draw it as a stacked bar with a legend.
- **In transit list:** invoice, truck, date and time, litres left, and the
  chambers still on the truck. Its status is one of:
  - "Decanting now": a decantation of that invoice is `decanting` or
    `settling`;
  - "Rest of a part-decanted load": some of it is already decanted;
  - "N days old", in red: older than the Settings days;
  - otherwise "On the way".

**b) KPIs:**
- Decanted: KL, decantations and fills;
- Net variation: L, and % of decanted;
- Short / excess: L;
- Outside tolerance: "n of fills", with "±tol% or ±minL L" under it;
- At invoice price: net ₹;
- Worst: its %, truck, day and tank.

**c) Chart "Net variation per day".**
- One column per day from the period's first day to its last. A day without
  decanting shows 0 and no column.
- Height is the day's net variation in litres. Negative columns are #E66767
  (short); positive ones #22A06B (excess).
- The y axis is in litres, with a zero line.
- If the period spans more than 62 days, show one column per month instead,
  titled "Net variation per month".
- The tooltip or label for each column: the day, "±V L short/excess (±P%)",
  the litres decanted and the number of tanks.
- Under the chart, a day-by-day (or month-by-month) table: Day, Tanks,
  Decanted, Variation, %, and Products (e.g. "HSD −70 L · MS +5 L").

**d) Chart "Every decantation".**
- An XY scatter: X = Decanted at, Y = Variation %.
- One series per product, in its colour, with round dots.
- A shaded band from −Tol% to +Tol%, labelled "±tol% tolerance".
- The y axis is symmetric: ±MAX(2.2 × Tol%, the largest |%|).
- Note under it: "Each dot is one tank filled; below the line = short."

**e) Tables:**
- **By truck:** Truck, Trips, Decanted, Net, %, Short, Flagged, Last. Clicking
  a truck filters the report to it.
- **By product, By tank, By month:** Fills, Decanted, Net, %, Short, Flagged.
  By month appears only when the period covers more than one month.
- Put a small in-cell bar on % (red to the left for negative, green to the
  right for positive).

## 8. Result sheet (one decantation, as the app's Result screen)

Pick a Decantation ID from a drop-down, newest first.

**Header:**
- "Decanted X KL from TRUCK · HH:MM–HH:MM" (Started at – Decanted at);
- the total variation as a big "±V L" with 2 decimals, red if short and green
  if excess;
- then "short/excess overall · P% · ≈ ₹M at invoice price". Here
  P = total V / total litres × 100 with 2 decimals, and
  M = Σ (Variation × Price) rounded to the rupee.

**Audit line**, one of:
- "✓ Audit: every stock here is from a screenshot or a dip — proof held.";
- "⚠ Audit: Tank 3 stock before typed in litres — no solid proof."

**A block per tank:**
- "Tank n", the product and the badge;
- "C1–3 · 14 KL · decanted HH:MM–HH:MM" (the tank's started and done times);
- the variation (2 decimals), its %, and "OK within ±tol L";
- a table:

  | Row | Litres | Dip / ₹ |
  |---|---|---|
  | Stock before · time · source | L (2 decimals) | dip in cm |
  | Stock after · time · source | L (2 decimals) | dip in cm |
  | Tank gained | L | |
  | Chambers 1–3 (invoice) | L | |
  | Sold while decanting (only when not 0) | L | |
  | Variation | ±L | ₹ value |

**Footer:** "By NAME · HSD density 831.2 (+0.2 vs invoice)", then the Notes.
For a cancelled decantation, show "Cancelled" and the reason.

## 9. Density at 15 °C (ASTM D1250 Table 53B)

This turns a hydrometer reading R (kg/m³) at T °C into the density at 15 °C.
It applies only when 500 < R < 1200.

1. dt = T − 15.
2. rhoT = R × (1 − 0.000023 × dt − 0.00000002 × dt²).
3. Start with rho = rhoT.
4. Repeat up to 50 times:
   - alpha:
     - rho < 770.5: 346.4228/rho² + 0.4388/rho;
     - rho < 787.5: −0.00336312 + 2680.3206/rho²;
     - rho < 839: 594.5418/rho²;
     - otherwise: 186.9696/rho² + 0.4862/rho.
   - vcf = EXP(−alpha × dt × (1 + 0.8 × alpha × dt)).
   - next = rhoT / vcf.
   - Stop when |next − rho| < 1e−7. Then rho = next.
5. d15 = JSRound(rho, 1).
6. diff = JSRound(d15 − invoice density, 1). OK if |diff| ≤ the Settings limit.

## 10. How numbers are written

- **Litres:** Indian digit grouping plus " L", e.g. 14,000 L or 1,23,456 L.
  KL = litres / 1000 with up to 3 decimals plus " KL".
- **Signed figures:** "+", "−" (a true minus sign) or "±" for zero, e.g.
  −70.22 L.
- **%:** a sign and 2 decimals, e.g. −0.50%.
- **₹:** rounded to the rupee, with Indian grouping and the minus sign in
  front, e.g. −₹6,892.
- **Dates and times:** "26 Sep 2026" and "11:18" (24-hour).

## 11. Checks sheet

For every imported month, recompute from its fills the Month, Day, Truck,
Product and Tank sums, and compare them with that file's App totals. Show ✓ or
✗ per row, and a count at the top. Everything should be ✓ when Settings match
the file's Info tolerance. If a ✗ shows, the formulas are off.

## 12. Excel on a Mac

This is built and used in **Excel for Mac** (Microsoft 365). VBA runs there,
but keep to what works on a Mac:

- **No Windows-only objects.** Don't use `Application.FileDialog`, ActiveX
  controls, or `CreateObject(…)` (no `Scripting.Dictionary` and no
  `FileSystemObject`). Use Collections, arrays and `Dir` instead.
- **Picking files.** Use `Application.GetOpenFilename`. If choosing several
  files at once doesn't work, pick one at a time and ask "Import another?".
  Also offer **Import open files**: it imports every open workbook whose Info
  sheet says it is a Vriddhi decanting log.
- **File access.** The Mac asks once to allow access to a file or folder.
  That's expected; `GrantAccessToMultipleFiles` can ask for several at once.
- **Buttons** are shapes with a macro assigned, not ActiveX buttons.
- **Charts** are made with `ChartObjects` from VBA, which works on a Mac.
- **Don't rely on Power Query.**

**Deliver** an .xlsm with:
- sheets: Settings, Imports, Log, Reports, Result, Checks and the data tables;
- VBA modules: ImportMonthlyFiles, Recalculate, BuildLog, BuildReports,
  BuildResult, JSRound, Density15;
- buttons for Import, Refresh and Export.

Test it by importing two months, then re-importing one of them, and check that
nothing doubles.
