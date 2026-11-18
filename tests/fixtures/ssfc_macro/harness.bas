
' ---- test harness (appended to the macro by tests/test_ssfc_macro.py, never shipped) ----
' The steps of ReconcileSSFC without its dialogs: the statement is read from this workbook's
' STMT / EXPENSES sheets, posted (as "Yes"), checked and the SSFC Check sheet built.
Public Sub HarnessRun()
    On Error GoTo Fail
    Dim wsTR As Worksheet
    Set wsTR = ThisWorkbook.Worksheets(TR_SHEET)
    FindRegisterColumns wsTR
    gFile = "harness"
    nT = 0: nV = 0: nD = 0: nB = 0: nL = 0: nF = 0: gTitle = "": gMonth = 0
    ReDim T(1 To 64): ReDim V(1 To 16): ReDim D(1 To 64): ReDim B(1 To 64): ReDim L(1 To 16): ReDim F(1 To 64)
    Dim ok As Boolean
    ok = ReadTrips(ThisWorkbook.Worksheets("STMT"))
    ok = ReadBills(ThisWorkbook.Worksheets("EXPENSES"))
    gMonth = MonthOfText(gTitle)
    ResolveDates
    Dim i As Long
    For i = 1 To nD
        D(i).col = ColOfKind(D(i).kind)
    Next i
    Dim lastRowTR As Long: lastRowTR = wsTR.Cells(wsTR.Rows.Count, cVeh).End(xlUp).Row
    MatchTrips wsTR, lastRowTR
    Dim monthRows As Collection: Set monthRows = New Collection
    Dim r As Long
    For r = TR_HDR_ROWS + 1 To lastRowTR
        If MonthOfCell(wsTR.Cells(r, cMonth).Value, wsTR.Cells(r, cLoadDate).Value) = gMonth Then
            If VehIndex(NormVeh(wsTR.Cells(r, cVeh).Value)) > 0 Then monthRows.Add r
        End If
    Next r
    Dim vRow As Variant, cc As Long
    BackupRows wsTR, monthRows
    For Each vRow In monthRows
        wsTR.Cells(vRow, cY).ClearContents
        wsTR.Cells(vRow, cAA).ClearContents
        For cc = cAD To cAK
            wsTR.Cells(vRow, cc).ClearContents
        Next cc
    Next vRow
    For i = 1 To nT
        If T(i).trRow > 0 Then wsTR.Cells(T(i).trRow, cY).Value = NZ(wsTR.Cells(T(i).trRow, cY)) + T(i).cashOffice
    Next i
    PostDeductions wsTR, monthRows
    Application.Calculate
    RunChecks wsTR, lastRowTR, monthRows, True
    BuildCheckSheet wsTR, monthRows, True
    Application.Calculate
    ThisWorkbook.Worksheets("Rates").Range("H1").Value = "done " & nT & " trips, month " & Format(gMonth, "yyyy-mm")
    Exit Sub
Fail:
    ThisWorkbook.Worksheets("Rates").Range("H1").Value = "ERROR " & Err.Number & ": " & Err.Description
End Sub
