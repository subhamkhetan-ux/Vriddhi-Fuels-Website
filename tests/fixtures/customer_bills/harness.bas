
' ---- test harness (appended to the macro by tests/test_customer_bills_macro.py, never shipped) ----
' CustomerBills without its dialogs: Demo Logistics split by tag (Oct 2026), the bill sheet copied
' to "Bill1"; then the same customer as one page with HSD and MS, left on "Customer Bill".
Public Sub HarnessRun()
    On Error GoTo Fail
    Dim h As Worksheet: Set h = ThisWorkbook.Worksheets.Add
    h.Name = "Harness"
    Dim ws As Worksheet: Set ws = CB_SetupSheet()
    ws.Range("A5:D5").Value = Array("Demo Logistics", "Tag", "Month", "HSD")
    ws.Range("J4:L4").Value = Array("Demo Logistics", "OD99ZZ1001", "JSW")
    ws.Range("J5:L5").Value = Array("demo logistics", "od 99 yy 2002", "700 Acre")
    ws.Range("J6:L6").Value = Array("Someone Else", "OD99XX3003", "Wrong customer")
    Dim sr As Long: sr = CB_SetupRow(ws, " Demo  Logistics ")
    Dim f As Date, t As Date
    CB_DefaultPeriod False, DateSerial(2026, 11, 18), f, t
    h.Range("A1").Value = Format(f, "yyyy-mm-dd") & "|" & Format(t, "yyyy-mm-dd")
    CB_Collect ws, "Demo Logistics", sr, f, t
    h.Range("A2").Value = nRow & "|" & nPage & "|" & nUn
    h.Range("A3").Value = CB_ListUntagged(ws, "Demo Logistics") & "|" & CB_ListUntagged(ws, "Demo Logistics")
    Dim out As Worksheet: Set out = CB_Build(ws, "Demo Logistics", sr, f, t)
    h.Range("A4").Value = CB_FileName("Demo Logistics", f, t) & "|" & CB_FileName("A/B Co", DateSerial(2026, 11, 1), DateSerial(2026, 11, 10)) & "|" & CB_FileName("X", DateSerial(2026, 10, 25), DateSerial(2026, 11, 5))
    h.Range("A5").Value = CB_Indian(2523100) & "|" & CB_Indian(108369.44) & "|" & CB_Indian(999) & "|" & CB_Indian(1234567.5)
    h.Range("A6").Value = CB_IsVehicleNo("OD15AF5510") & "|" & CB_IsVehicleNo("od 23 u 755") & "|" & CB_IsVehicleNo("22BH1234AA") & "|" & CB_IsVehicleNo("JSW") & "|" & CB_IsVehicleNo("700 Acre") & "|" & CB_IsVehicleNo("Transporting")
    CB_DefaultPeriod True, DateSerial(2026, 11, 15), f, t
    h.Range("A7").Value = Format(f, "yyyy-mm-dd") & "|" & Format(t, "yyyy-mm-dd")
    CB_DefaultPeriod True, DateSerial(2026, 12, 3), f, t
    h.Range("A8").Value = Format(f, "yyyy-mm-dd") & "|" & Format(t, "yyyy-mm-dd")
    ' the first bill, kept as values
    Dim b1 As Worksheet: Set b1 = ThisWorkbook.Worksheets.Add
    b1.Name = "Bill1"
    Dim last As Long: last = CLng(out.Range("Z1").Value)
    out.Range("A1:G" & last).Copy b1.Range("A1")                 ' with formats, as the bill shows
    h.Range("A9").Value = last
    ' one page, HSD + MS, Bill To typed over the sheet's
    ws.Range("B5").Value = "One page": ws.Range("D5").Value = "HSD, MS": ws.Range("G5").Value = "21zzzzz9999z1z9"
    CB_Collect ws, "Demo Logistics", sr, DateSerial(2026, 10, 1), DateSerial(2026, 10, 31)
    h.Range("A10").Value = nRow & "|" & nPage & "|" & nUn
    Set out = CB_Build(ws, "Demo Logistics", sr, DateSerial(2026, 10, 1), DateSerial(2026, 10, 31))
    h.Range("A11").Value = out.Range("Z1").Value
    h.Range("A12").Value = "done"
    Exit Sub
Fail:
    ThisWorkbook.Worksheets("Harness").Range("A12").Value = "ERROR " & Err.Number & ": " & Err.Description & " (line " & Erl & ")"
End Sub
