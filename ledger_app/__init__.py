"""Master Ledger structure report — the first step to a cloud Master Ledger app.

``inspect_workbook`` reads ``Master Ledger.xlsm`` (no Excel needed) and writes a
masked report of every sheet, formula and VBA macro to ``ledger_app/out/``.
``report.sh --push`` sends that report to a separate private repo, so the
ledger's layout and macro logic can be read for porting while the workbook,
with its customer and payment data, stays on the Mac. See ``README.md``.
"""
