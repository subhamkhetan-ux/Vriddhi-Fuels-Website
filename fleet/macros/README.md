# SSFC reconciliation macro (v9)

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

After each run, the **SSFC Check** sheet lists what SSFC owes you or must
explain first, then what to check:

- their arithmetic;
- trips that are missing or not in your register;
- the rate (and whether it's another route's rate);
- loading and unloading weights;
- **diesel, trip by trip**: on each trip (paired with your trip by its loaded
  weight), SSFC's diesel in ₹ (cash diesel included) against the fills from
  SSFC tagged to that trip in HSD Data, or your SSFC Diesel P / Q. It flags
  SSFC charging more, yours being more, a fill sitting on the next or last
  trip (one line: retag it) and P / Q to correct;
- every deduction against the bills behind it;
- RTO entry above what the others pay;
- bills that appear twice;
- DEF bills against your Urea DEF sheet;
- LD days against your dates;
- SSFC Net against the statement.

Below the findings are tables of each vehicle, each trip (matched to its
register row, with its diesel: SSFC's, HSD Data's, your P / Q and the
difference), each deduction (and the column it was posted to) and each bill.

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
