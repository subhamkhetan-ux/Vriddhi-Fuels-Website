# SSFC reconciliation macro (v9.1)

`SSFC_Recon_v9.bas` replaces the SSFC engine (v8.1, `Module1`) in the Trip
Register workbook. It does the same job (it posts Cash Office and the
deductions into the Trip Register, and you can undo it), but it no longer
depends on SSFC's layout:

- **It finds the trip tables by their heading rows.** The heading can be on
  row 3 or row 4, on any sheet. Each column is found by its heading text, so
  an extra or moved column doesn't break it.
- **It finds deduction lines by their label, in any column.** The amount comes
  from the TOTAL column, or else from the first number to the right of the
  label.
- **It reads dates the right way round.** This covers dates typed as text,
  dates saved with the day and month swapped, and month-first dates
  (`11/12/25` for 12 Nov).
- **It reads the expense (bill) sheet by what's in each column.** This works
  with or without a header row. DEF / AdBlue lines are recognised however
  they're spelt.
- **It reads the LD (late delivery) sheet** when there is one.
- **New labels can't stop a run.** A label it doesn't know goes to **AA SSFC
  Misc**, which is already part of the SSFC Net formula, and is listed to
  check.
- **EMI lines are never posted.** They're flagged instead. Columns AM and AL
  are never written.

After each run, the **SSFC Check** sheet is **live**, like the v8 recon sheet. SSFC's figures
are written as fixed values, because they're what SSFC billed. Your figures are formulas into the
Trip Register, HSD Data and Urea DEF, and so are the differences, the **Status** columns and the
**₹ to claim**. Correct a mistake in the register (a rate, a weight, P / Q, a deduction, a DEF
refill, a trip's dates) and the flags and totals update at once, with no re-run. Run the macro
again only after **adding or deleting trips**, because which register row each SSFC trip is gets
decided when it runs.

The sheet, top to bottom:

- **Summary:** ₹ to claim, and how many trips, vehicles, deduction heads, DEF bills and
  statement findings need a look. All live.
- **Each trip:** SSFC's load and unload weights, rate, diesel (with cash diesel) and cash office,
  beside yours: the register's weights, rate, P / Q and Y, and the SSFC fills tagged to the trip
  in HSD Data. Then the rate and weight shortfall, diesel SSFC − yours, P / Q to correct, cash
  office, *fill on the next / last trip*, ₹ to claim and a **Status**:
  - RATE SHORT;
  - WEIGHT SHORT;
  - UNLOAD SHORTAGE RISK;
  - DIESEL: SSFC MORE / YOURS MORE;
  - DIESEL ON NEXT/LAST TRIP - RETAG;
  - CORRECT P/Q;
  - CASH OFFICE (Y) DIFFERS;
  - OK.
- **Your trips this month not in the statement.**
- **Each vehicle:** your trips that month, SSFC's posted deductions against yours (AA, AD:AK),
  and SSFC's NET against your SSFC Net (AL).
- **Deductions by head:** each column, SSFC against yours.
- **DEF / AdBlue:** each DEF bill against the refills bought from SSFC in your Urea DEF sheet
  (same vehicle, 3 days either side). The status is NO REFILL OF YOURS FROM SSFC, SSFC CHARGED
  MORE, or OK.
- **Late delivery (LD):** SSFC's days against your loading and unloading dates.
- **From SSFC's statement itself** (fixed, since it doesn't depend on your books): their
  arithmetic, an EMI deducted, new labels to prove, RTO entry above what most pay, deductions with
  no bill behind them, bills twice, one bill naming several vehicles, and a rate that is another
  route's.
- **Every deduction line and bill**, as SSFC wrote them.

The app does the same checks in **SSFC → Check SSFC's monthly statement**,
across all months at once. That catches a trip paid a month late and a bill
charged in two months.

## Install (once)

1. Open `Trip_Register.xlsm` and press **⌥F11** (Mac) or **Alt+F11**
   (Windows) to open the VBA editor.
2. In the Project pane, right-click **Module1** (the old SSFC engine v8.1),
   choose **Export File…** to keep a copy, then **Remove Module1** and
   answer **No** to exporting again.
3. **File → Import File…** and pick `SSFC_Recon_v9.bas`. It appears as
   module **SSFCRecon**.
4. **SDict** (the Mac-safe dictionary) is already in the workbook. If it
   ever goes missing, import `SDict.cls` the same way.
5. Save the workbook (`.xlsm`).

The `SSFC Config` and `SSFC Backup` sheets from v8 keep working. Your own
Config keywords still take priority over the macro's own reading.

**Updating from v9 to v9.1:** in the VBA editor, right-click **SSFCRecon** → **Remove
SSFCRecon…** → **No**, then **File → Import File…** the new `SSFC_Recon_v9.bas`, then
**Debug → Compile VBAProject**, then save. SDict, SSFC Config and SSFC Backup stay as they are.
Run the macro once for the month you're working on; from then on its SSFC Check sheet is live.

## Each month

1. Open SSFC's statement file (`.xlsx`) in Excel, next to the Trip Register.
2. In the Trip Register, run **SSFC_Menu** and choose **1**. You can also
   run **ReconcileSSFC** directly.
3. It shows the month it found, the trips it matched and the lines it read.
   - **Yes** posts and then checks.
   - **No** only checks, without changing anything.
   - **Cancel** stops.
4. Read the **SSFC Check** sheet. If anything looks wrong, use **SSFC_Menu →
   2** (Restore last run) to put the month back exactly as it was.

## Testing changes to the macro

`tests/test_ssfc_macro.py` runs the macro for real in LibreOffice's VBA mode on a made-up
workbook. It posts a statement, builds the SSFC Check sheet, then corrects the register and
checks that the flags and the ₹ to claim follow. Run it with `python3 -m pytest
tests/test_ssfc_macro.py -q`; it's skipped where LibreOffice isn't installed. LibreOffice has no
conditional formatting in its VBA layer, so the colours are only seen in Excel.
