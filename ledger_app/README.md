# Master Ledger structure report (`ledger_app/`)

The first step toward running the Master Ledger as a cloud web app. Porting the
ledger's macros to code needs an exact picture of every sheet and every macro.
This tool reads `Master Ledger.xlsm` on the Mac and writes a **masked structure
report**. With `--push` it sends that report to a **separate private GitHub
repo**:

```
Master Ledger.xlsm (Mac / iCloud)  ──►  ledger_app/report.sh  ──►  ledger_app/out/master-ledger.md + .json
   (only read, never changed)                                        │  --push
                                                                     ▼
                                              <your account>/vriddhi-ledger-private  (PRIVATE repo)
```

## Safety: what this does and doesn't touch

- **Nothing in this repo changes.** It only adds the `ledger_app/` folder and one
  test file. None of the existing apps, workflows or agents use it, and
  `requirements.txt` is unchanged.
- **The workbook is only read.** Excel isn't started and the file isn't written.
- **Nothing is committed here, ever.** This repo is public and serves the live
  apps. The report goes to `ledger_app/out/`, which git ignores.
- **`--push` only sends to a private repo.** It checks that the repo is private
  first, and refuses if it's public. It works in a temporary folder, so your
  branches, staged changes and files in this repo are never touched.

## One-time setup: a private repo for the report

Create an empty repository on GitHub named **`vriddhi-ledger-private`** and set
it to **Private** (https://github.com/new). To use a different name, run the
script with `LEDGER_REPORT_REPO=owner/name` in front of it.

## Run it (on the Mac)

```bash
cd /path/to/Vriddhi-Fuels-Website
git pull
bash ledger_app/report.sh --push
```

The script:

1. finds the ledger: `$MASTER_LEDGER_PATH`, else the path the payment agent
   uses (from its launchd plist), else `iCloud Drive/Vriddhi Fuels/`, else a
   Spotlight search. It makes sure iCloud has downloaded the file;
2. installs `openpyxl` and `oletools` for your user if they're missing;
3. writes `ledger_app/out/master-ledger.md` and `.json`;
4. with `--push`, checks that `vriddhi-ledger-private` is private, then pushes
   just those two files to it.

To point it at a different file:
`bash ledger_app/report.sh "/path/to/Master Ledger.xlsm" --push`. Leave off
`--push` to look at `ledger_app/out/master-ledger.md` before sending it.

- **Save the workbook in Excel first.** The report reads the last saved version,
  including the values Excel cached for each formula.
- **Re-run it whenever you change a macro or a sheet's layout.**
- It works even if the VBA project is password-locked for viewing.

## What's in the report

| Section | What it covers |
|---|---|
| **Sheets** | Every sheet: code name, visible/hidden, used range, formula count, Excel tables, buttons, and which sheets share a layout |
| **Defined names / links** | Every named range, and any other workbooks the formulas point at |
| **Macros you can run** | Every public macro with no required inputs (what Alt+F8 or a button runs): which button runs it, what it does (from its comments), and how many MsgBox / InputBox dialogs it shows, counted through everything it calls. It also lists the InputBox prompts, which become form fields once a macro is ported |
| **Event macros** | Macros Excel runs by itself (`Workbook_Open`, `Worksheet_Change`, a button's `_Click` …), with the sheet they belong to |
| **Helper procedures** | Every other procedure, with its parameters and what it calls |
| **Per sheet** | Freeze panes, protection and the **unlocked input cells**, tables (with calculated columns), merged cells, drop-down lists, conditional formats, print area and titles, hidden rows/columns, comments, charts/images/pivots, and header rows. Small sheets (forms, dashboards) are listed **cell by cell**; big ones get their top rows, a profile of every column (header, types, number format, formulas) and sample rows |
| **Formulas** | **Every distinct formula** on each sheet. A formula filled down a column counts once, shown with the range it covers |
| **VBA source** | The full code of every module |

Sheets that share a layout (one ledger per customer) are described in full once.
The others say "same layout as …" and list only the formulas that differ.

## What's masked

By default:

- numbers show as `#`;
- phone, GSTIN, PAN and account numbers inside text are blurred to `9`s;
- e-mail addresses become `s***@gmail.com`;
- on VBA lines that look like passwords (`PROT_PWD = "…"`, `.Unprotect "…"`),
  string values become `"***"`.

Formulas, headers, labels, number formats, dates and sheet names (customer
names) stay as they are, because that *is* the structure. That's also why the
report goes to a private repo. `--full-values` turns off the value masking; the
password redaction always stays on.

## Options

```bash
python3 -m ledger_app.inspect_workbook [WORKBOOK ...] [--out DIR] [--full-values] [--max-rows N]
```

With no workbook given, it finds the Master Ledger as described above. It
works on any `.xlsm` / `.xlsx`, for example `"Tanker Billing.xlsm"`.

| Environment variable | What it changes |
|---|---|
| `LEDGER_REPORT_REPO` | Private repo to push to (`owner/name`, default `<your account>/vriddhi-ledger-private`) |
| `LEDGER_REPORT_OUT` | Local folder for the report (default `ledger_app/out/`) |
| `PYTHON` | Python to use (default `python3`) |

## Files

| File | What |
|---|---|
| `report.sh` | The one-command wrapper: install deps, run, push to the private repo |
| `inspect_workbook.py` | Reads the workbook (openpyxl) and writes the `.md` / `.json` report |
| `vba.py` | Pulls the VBA out of the file (oletools) and parses it: procedures, entry points, events, dialogs, calls, password redaction |
| `grid.py` | A sheet as 2-D lists, plus small cell helpers |
| `.gitignore` | Keeps `out/` (the local reports) out of git |

## Tests

```bash
python -m pytest tests/test_ledger_app.py -q
```

The tests build workbooks with openpyxl, parse VBA from source strings and a
hand-made package for the buttons, and run `report.sh --push` against a
throwaway local repo. That last test checks that the report arrives there and
nothing in this repo changes. Test data is made up.
