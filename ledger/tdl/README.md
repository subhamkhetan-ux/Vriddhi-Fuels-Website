# Fuel slip TDL for Tally (`VriddhiFuelSlip.tdl`)

This TDL brings the ledger app's **fuel slip** (the HSD Bill sheet's A5 credit
memo, drawn by `slipSvg()` in [`../js/render.js`](../js/render.js)) into Tally:

1. **Vehicle No. beside the party.** When you create (or alter) a voucher of
   one of the slip voucher types, a **Vehicle No :** field sits on the same
   line as **Party A/c name**, at the right. Enter the party, press Enter, and
   the cursor goes to Vehicle No. The number is saved in the company's
   existing Vehicle No UDF (`EiVehNo`, index 120). The [/tally/ app](../../tally/)
   exports into that same UDF, and the DayBook import reads it, so the
   vehicle shows up on the ledger app's slip as well.
2. **The slip as the invoice print.** Printing a voucher of those types
   (Alt+P, or Print from the voucher) gives the slip instead of Tally's
   invoice:

   | Slip | From Tally |
   |---|---|
   | **CREDIT MEMO** (white on a black box) | `VFSlipTitle` in the TDL |
   | **Mob :** at the top right | `VFSlipMobileNo` in the TDL, or else the company's Phone No. |
   | Firm name (bold, Times New Roman), centred | the company name, e.g. *VRIDDHI FUELS (2026-27)* |
   | Address lines | the company's address |
   | GSTIN/UIN, State Name / Code, E-Mail | the voucher's company GSTIN and state (or the company's), and the company e-mail |
   | **No. :** / **Date :** | voucher number, date as d-m-yyyy (`5-9-2026`) |
   | **M/s :** | the party ledger |
   | **Vehicle No. :** | the Vehicle No field above |
   | Particulars / Quantity / Rate / Amount | each stock item: name, quantity (`1000.00 LTR`), rate, amount |
   | (only if there is one) R/off | any other ledger on the invoice, so the column adds up |
   | Thank You / Total / ₹ amount | the voucher total |
   | Stamp space, *Customer's Sign.*, *Sign.of Salesman* | as on the slip |

   The column widths, box lines, fonts (Arial, Times New Roman for the firm
   name and mobile) and sizes follow the slip's measurements. The page is
   A5 (148 × 210 mm). Set the printer's paper to A5, or the slip prints at
   the top of an A4 sheet. The slip leaves the stamp space empty, to be
   stamped by hand. Other voucher types keep printing Tally's normal invoice.

## Choosing the voucher types

At the top of the file:

```
VFSlipType1     : "HSD CREDIT"
VFSlipType2     : "MS CREDIT"
VFSlipType3     : "XG CREDIT"
```

Put the names of the sales voucher types that should get the slip and the
Vehicle No field (any case). Set a line to `""` if you need fewer. A voucher
type is used only if it is a **Sales** type. `VFSlipTitle` and
`VFSlipMobileNo` are just below. After changing the file, restart Tally, or
reload the TDL from F1 > TDLs & Add-Ons.

## Loading it

1. Copy `VriddhiFuelSlip.tdl` to the Tally computer, e.g. into the Tally
   folder.
2. In Tally go to **F1 (Help) > TDLs & Add-Ons > F4 (Manage Local TDLs)**.
   Set *Load selected TDL files on startup* to **Yes** and add the file's
   full path.
3. Check that its status reads **Loaded**. Open a new voucher of one of the
   slip types: **Vehicle No :** should be beside Party A/c name. Print it to
   see the slip.

**If an older TDL already shows a Vehicle No field** (the one that created
the `EiVehNo` UDF), remove it from the list of TDLs. Otherwise Vehicle No
appears twice on the voucher screen. Your existing vehicle numbers stay
safe: this TDL uses the same UDF.

## If Tally reports an error

Tally shows TDL errors on the TDL screen, with a line number. The parts of
this file that use names from Tally's own screens are:

| Error mentions | What to do |
|---|---|
| `Line: EI Party` | Your Tally release names the invoice's party line differently. Change `[#Line: EI Party]` to that release's name for it. |
| `Form: Comprehensive Invoice` | In F12 / Print configuration, pick the default (*Comprehensive*) invoice format, not *Simple*. |
| `Print FG` / `Print BG` | Delete those two lines in `VF Slip Title`. The title then prints in black text, without the black box. |
| `Decimals` in a `Format` | Change the format to `"NoComma"`. |

A wrong name like these stops the whole file from loading, but it changes
nothing in your company's data.
