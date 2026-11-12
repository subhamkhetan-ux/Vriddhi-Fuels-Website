# tanker/ — bill assets shared by the Tally app

The standalone tanker-bill app that used to live here, and the GitHub job that
copied `Tanker Billing.xlsm`'s customers and rates into `state/tanker_billing.json`
for it, have been removed: nothing used them any more. Customer bills are made
in the **Tally app** (`/tally/`, from a voucher), with customer details from
the Master Ledger's Tanker Master sheet in the Ledger app; the Tanker Billing
workbook itself goes to the **Ledger app** (Quotes, PI Log, credit notes),
uploaded by the Mac's sync script.

What is left here is used by the Tally app's bill, and is referenced from
there rather than copied:

| File | Used for |
|---|---|
| `assets/letterhead.png`, `assets/letterhead_grey.png` | The bill's letterhead (customer copy / greyscale receiving copy) |
| `assets/stamp.png`, `assets/stamp_grey.png` | The stamp, the same two ways |
| `assets/fonts/` | Times New Roman and BillSerif for the bill (see its README) |
| `docx-export.js` | **Export Word (.docx)** of a bill |

The Ledger app's demo workbook is made by
[`ledger/tools/demo_workbook.mjs`](../ledger/tools/demo_workbook.mjs).
