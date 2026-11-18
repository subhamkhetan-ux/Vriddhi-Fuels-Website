Attribute VB_Name = "SSFCRecon"
Option Explicit

'==================================================================
'  SSFC RECONCILIATION ENGINE  v9.1  (MAC SAFE)
'  Run SSFC_Menu.   Subs: ReconcileSSFC, RestoreLastRun, OpenMapping
'
'  Reads SSFC's monthly account WITHOUT trusting its layout:
'   - every sheet is looked at; the trip tables are found by their
'     heading row (VEHICLE + LOADING / LR), wherever it is (row 3, 4 ...)
'   - every column is found by its heading text, not its letter
'     (an extra column, a moved column, a 33-column June: all fine)
'   - deduction lines are found by their label, in any column, with
'     the amount in the TOTAL column or the first number to its right
'   - dates typed as text, saved day/month swapped, or month-first
'     ("11/12/25" for 12 Nov) are read the right way round
'   - the expense (bill) sheet is read by what is IN each column
'     (vehicle no., head, amount ...), with or without a header row
'   - DEF / AdBlue lines are found however SSFC spells them
'     (AD BLUE, URIA, CLEARLUE, DEF BUCKET, TATA TARINI ...)
'   - the LD (late delivery) sheet, when there is one
'
'  Posts into the Trip Register (backup first, Restore undoes it):
'   - Cash Office of each trip -> Y on that trip's row
'   - deductions -> AD Fastag, AE Maint., AF Tyre, AG Over/Unload,
'     AH RTO Entry, AI RTO Challan, AJ Shortage, AK Doc. Exp.;
'     anything else (union, GPS, fooding, LD, a new label) -> AA SSFC
'     Misc (it is in the SSFC Net formula) - never lost, never asked
'   - SSFC INSTALMENT / EMI lines are NOT posted (you pay the bank)
'     and are flagged. Column AM is never touched. AL is never written.
'   - the SSFC Config sheet (keyword -> column) still wins over the
'     built-in reading, so your own mappings are kept.
'
'  The "SSFC Check" sheet is LIVE (v9.1): SSFC's figures are written as values, yours as
'  formulas into the Trip Register, HSD Data and Urea DEF - and so are the differences, the
'  flags (Status columns) and the Rs to claim. Correct the register and the sheet follows,
'  as the v8 recon sheet did. Run the macro again only after adding or deleting trips.
'
'  Checks, what SSFC owes you first:
'   their arithmetic (fills, row totals, subtotal, net); trips paid /
'   missing / not in the register; rate (and if it is another route's);
'   loading weight; unloading weight (shortage risk); diesel litres and
'   price against HSD Data (SSFC pump fills on those trips); every
'   deduction against the bills behind it; EMI deducted; new labels to
'   prove; RTO entry above what the others pay; bills twice; DEF bills
'   against the Urea DEF sheet's refills bought from SSFC; LD days
'   against the register's dates; SSFC Net against the statement.
'
'  Needs the SDict class module (already in the workbook since v8).
'==================================================================

Private Const TR_SHEET As String = "Trip Register"
Private Const CFG_SHEET As String = "SSFC Config"
Private Const BAK_SHEET As String = "SSFC Backup"
Private Const RPT_SHEET As String = "SSFC Check"
Private Const TR_HDR_ROWS As Long = 2

' ---- what is read -----------------------------------------------------------------------
Private Type STrip
    veh As String
    lr As String
    rawLoad As Variant
    rawUnload As Variant
    loadDate As Date
    unloadDate As Date
    dateFixed As Boolean
    loadWt As Double
    unloadWt As Double
    hasUnload As Boolean
    rate As Double
    total As Double
    hasTotal As Boolean
    diesel As Double          ' charged: fill amounts + pump cash
    cash As Double            ' the pump cash: diesel bought for cash (its litres aren't on the statement)
    litres As Double          ' litres with an amount (Vriddhi litres at Rs 0 are not charged)
    cashOffice As Double
    fillNote As String
    srcRow As Long
    srcSheet As String
    trRow As Long             ' the Trip Register row it is (0 = none)
    how As String
End Type
Private Type SVeh
    veh As String
    t0 As Long
    nT As Long
    subtotal As Double
    hasSub As Boolean
    net As Double
    hasNet As Boolean
End Type
Private Type SDed
    veh As String
    label As String
    kind As String
    col As String             ' AD..AK, AA, or "" (EMI: not posted)
    amount As Double
End Type
Private Type SBill
    veh As String
    dt As Date
    desc As String
    cat As String
    kind As String
    isDef As Boolean
    amount As Double
    billNo As String
    others As String
    srcSheet As String
    srcRow As Long
End Type
Private Type SLd
    veh As String
    inv As Date
    days As Double
    wt As Double
    amount As Double
    trRow As Long             ' the Trip Register row of its trip (0 = none found)
End Type
Private Type SFind
    level As String           ' CLAIM / CHECK / NOTE
    area As String
    veh As String
    amount As Double
    text As String
End Type

Private T() As STrip, nT As Long
Private V() As SVeh, nV As Long
Private D() As SDed, nD As Long
Private B() As SBill, nB As Long
Private L() As SLd, nL As Long
Private F() As SFind, nF As Long
Private gMonth As Date            ' first of the statement month
Private gTitle As String
Private gFile As String

' Trip Register columns (found by their headings in row 2; these are the defaults)
Private cVeh As Long, cTrip As Long, cLoadDate As Long, cLW As Long, cUnloadDate As Long, cUW As Long
Private cPort As Long, cDest As Long, cRate As Long, cBhada As Long, cDslL As Long, cDslAmt As Long
Private cY As Long, cAA As Long, cAD As Long, cAK As Long, cAL As Long, cMonth As Long

'------------------------------------------------------------------
Sub SSFC_Menu()
    Dim ch As String
    ch = InputBox("SSFC RECONCILIATION  v9.1" & vbLf & vbLf & _
                  "1 = Check + post a month (open SSFC's file first)" & vbLf & _
                  "2 = Restore last run (undo)" & vbLf & _
                  "3 = Edit deduction mapping (optional)" & vbLf & vbLf & _
                  "Enter 1, 2 or 3:", "SSFC Engine")
    Select Case Trim(ch)
        Case "1": ReconcileSSFC
        Case "2": RestoreLastRun
        Case "3": OpenMapping
        Case "": Exit Sub
        Case Else: MsgBox "Invalid choice.", vbExclamation
    End Select
End Sub

Sub OpenMapping()
    EnsureConfig
    ThisWorkbook.Worksheets(CFG_SHEET).Activate
    MsgBox "Optional: the macro already knows SSFC's labels." & vbLf & _
           "Add a row here only to override it." & vbLf & vbLf & _
           "Column A = keyword (found anywhere in SSFC's label, UPPER CASE)" & vbLf & _
           "Column B = Trip Register column: AD AE AF AG AH AI AJ AK AA, or SKIP" & vbLf & _
           "Rows are checked top-down; the first keyword found wins." & vbLf & _
           "INSTALMENT / EMI lines are never posted.", vbInformation
End Sub

'------------------------------------------------------------------
' MAC-SAFE file choice: SSFC's statement from the OPEN workbooks
'------------------------------------------------------------------
Private Function PickSSFCWorkbook() As Workbook
    Dim cands As Collection: Set cands = New Collection
    Dim wb As Workbook
    For Each wb In Application.Workbooks
        If Not (wb Is ThisWorkbook) Then
            If LCase(wb.Name) <> "personal.xlsb" Then cands.Add wb
        End If
    Next wb
    If cands.Count = 0 Then
        MsgBox "Open SSFC's statement file in Excel first, then run this again." & vbLf & _
               "(No other workbook is open.)", vbExclamation, "SSFC file"
        Exit Function
    ElseIf cands.Count = 1 Then
        Set PickSSFCWorkbook = cands.Item(1)
        Exit Function
    End If
    Dim msg As String, i As Long, ans As String
    msg = "Which open workbook is SSFC's statement?" & vbLf & vbLf
    For i = 1 To cands.Count
        msg = msg & i & " = " & cands.Item(i).Name & vbLf
    Next i
    ans = InputBox(msg & vbLf & "Enter the number:", "SSFC file")
    If Trim(ans) = "" Then Exit Function
    If Not IsNumeric(ans) Then MsgBox "Not a number.", vbExclamation: Exit Function
    i = CLng(ans)
    If i < 1 Or i > cands.Count Then MsgBox "Out of range.", vbExclamation: Exit Function
    Set PickSSFCWorkbook = cands.Item(i)
End Function

'==================================================================
Sub ReconcileSSFC()
    Dim wsTR As Worksheet, wbS As Workbook
    Dim calcSave As XlCalculation
    Dim vRow As Variant, cc As Long
    calcSave = Application.Calculation
    On Error GoTo Fail

    On Error Resume Next
    Set wsTR = ThisWorkbook.Worksheets(TR_SHEET)
    On Error GoTo Fail
    If wsTR Is Nothing Then MsgBox "Sheet '" & TR_SHEET & "' not found.", vbExclamation: Exit Sub
    EnsureConfig
    FindRegisterColumns wsTR

    Set wbS = PickSSFCWorkbook()
    If wbS Is Nothing Then Exit Sub
    gFile = wbS.Name

    Application.ScreenUpdating = False
    Application.Calculation = xlCalculationManual
    Application.StatusBar = "Reading SSFC's statement..."

    ' ---- 1. read every sheet ----
    nT = 0: nV = 0: nD = 0: nB = 0: nL = 0: nF = 0: gTitle = "": gMonth = 0
    ReDim T(1 To 64): ReDim V(1 To 16): ReDim D(1 To 64): ReDim B(1 To 64): ReDim L(1 To 16): ReDim F(1 To 64)
    Dim ws As Worksheet, mains As String, expSheets As String
    For Each ws In wbS.Worksheets
        If IsLdSheet(ws) Then
            ReadLd ws
        ElseIf ReadTrips(ws) Then
            mains = mains & ws.Name & ", "
        End If
    Next ws
    If nT = 0 And nV = 0 Then
        MsgBox "No vehicle-wise trip table found in " & gFile & "." & vbLf & _
               "(Looked for a heading row with VEHICLE and LOADING / LR NO on every sheet.)", vbExclamation
        GoTo Cleanup
    End If
    For Each ws In wbS.Worksheets
        If InStr(", " & mains, ", " & ws.Name & ",") = 0 And Not IsLdSheet(ws) Then
            If ReadBills(ws) Then expSheets = expSheets & ws.Name & ", "
        End If
    Next ws
    Set wbS = Nothing                     ' the user opened it: not closed

    ' ---- 2. the month: the title, else the file name, else the loading dates ----
    gMonth = MonthOfText(gTitle)
    If gMonth = 0 Then gMonth = MonthOfText(gFile)
    If gMonth = 0 Then gMonth = DominantMonth()
    If gMonth = 0 Then
        Dim mStr As String, p() As String
        mStr = InputBox("Couldn't tell the statement's month. Enter it as MM/YYYY:", "SSFC - Month")
        If Trim(mStr) = "" Then GoTo Cleanup
        p = Split(mStr, "/")
        If UBound(p) < 1 Then MsgBox "Use MM/YYYY.", vbExclamation: GoTo Cleanup
        gMonth = DateSerial(CInt(p(1)), CInt(p(0)), 1)
    End If
    ResolveDates

    ' ---- 3. deductions: your Config keywords first, then the built-in reading ----
    Dim gMap As Collection: Set gMap = LoadMap()
    Dim i As Long, lt As String
    For i = 1 To nD
        lt = ResolveLabel(UCase(D(i).label), gMap)
        If lt = "" Then lt = ColOfKind(D(i).kind)
        If lt = "SKIP" Then lt = ""
        If D(i).kind = "emi" Then lt = ""
        D(i).col = lt
    Next i

    ' ---- 4. the Trip Register's rows for the month, and the match ----
    Dim lastRowTR As Long: lastRowTR = wsTR.Cells(wsTR.Rows.Count, cVeh).End(xlUp).Row
    MatchTrips wsTR, lastRowTR

    Dim monthRows As Collection: Set monthRows = New Collection
    Dim r As Long, vs As String
    For r = TR_HDR_ROWS + 1 To lastRowTR
        If MonthOfCell(wsTR.Cells(r, cMonth).Value, wsTR.Cells(r, cLoadDate).Value) = gMonth Then
            vs = NormVeh(wsTR.Cells(r, cVeh).Value)
            If vs <> "" And VehIndex(vs) > 0 Then monthRows.Add r
        End If
    Next r
    If monthRows.Count = 0 Then
        Application.ScreenUpdating = True
        MsgBox "The statement is for " & Format(gMonth, "mmm yyyy") & ", but the Trip Register has no trips that month" & vbLf & _
               "for its vehicles (column " & ColLetter(cMonth) & "). Enter that month's trips first.", vbExclamation
        GoTo Cleanup
    End If

    ' ---- 5. confirm ----
    Application.StatusBar = False
    Application.ScreenUpdating = True
    Dim matched As Long, posted As Boolean
    For i = 1 To nT
        If T(i).trRow > 0 Then matched = matched + 1
    Next i
    For Each vRow In monthRows
        If NZ(wsTR.Cells(vRow, cY)) <> 0 Then posted = True: Exit For
    Next vRow
    Dim ans As VbMsgBoxResult
    ans = MsgBox("SSFC statement: " & Format(gMonth, "mmmm yyyy") & "   (" & gFile & ")" & vbLf & _
                 "Vehicles: " & nV & "   SSFC trips: " & nT & "   found in your register: " & matched & vbLf & _
                 "Deduction lines: " & nD & "   Bills: " & nB & "   LD lines: " & nL & vbLf & _
                 IIf(posted, vbLf & "This month already has values posted - they will be replaced (a backup is saved first)." & vbLf, "") & vbLf & _
                 "YES = post Cash Office + deductions into the Trip Register, then check" & vbLf & _
                 "NO  = only check (the Trip Register is not changed)" & vbLf & _
                 "CANCEL = stop", vbYesNoCancel + vbQuestion, "SSFC v9.1")
    If ans = vbCancel Then GoTo Cleanup
    Application.ScreenUpdating = False

    ' ---- 6. post ----
    If ans = vbYes Then
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
        Application.Calculation = xlCalculationAutomatic
        Application.Calculate
    End If

    ' ---- 7. check, and the report ----
    Application.StatusBar = "Checking..."
    RunChecks wsTR, lastRowTR, monthRows, (ans = vbYes)
    BuildCheckSheet wsTR, monthRows, (ans = vbYes)

    Application.StatusBar = False
    Application.ScreenUpdating = True
    Application.Calculation = calcSave
    ' the totals, from the (live) sheet
    Dim wsC As Worksheet: Set wsC = ThisWorkbook.Worksheets(RPT_SHEET)
    Application.Calculate
    Dim claim As Double, nCheck As Long
    claim = Num(wsC.Range("A5").Value)
    nCheck = Num(wsC.Range("B5").Value) + Num(wsC.Range("C5").Value) + Num(wsC.Range("D5").Value) + Num(wsC.Range("E5").Value) + Num(wsC.Range("F5").Value)
    wsC.Activate
    MsgBox "Done - " & Format(gMonth, "mmmm yyyy") & IIf(ans = vbYes, " posted and checked.", " checked (nothing posted).") & vbLf & vbLf & _
           "To claim from SSFC: Rs " & Format(claim, "#,##0") & vbLf & _
           "To check / ask for proof: " & nCheck & vbLf & vbLf & _
           "The '" & RPT_SHEET & "' sheet is live: correct the Trip Register, HSD Data or Urea DEF" & vbLf & _
           "and its flags and totals update. Run this again only after adding or deleting trips.", vbInformation, "SSFC v9.1"
    Exit Sub

Cleanup:
    On Error Resume Next
    Application.StatusBar = False
    Application.ScreenUpdating = True
    Application.Calculation = calcSave
    Exit Sub
Fail:
    MsgBox "Error " & Err.Number & ": " & Err.Description, vbCritical, "SSFC Reconciliation"
    Resume Cleanup
End Sub

'==================================================================
'  READING THE STATEMENT
'==================================================================
' a sheet's values from A1, as a 2-D array (1-based)
Private Function SheetValues(ws As Worksheet, ByRef nR As Long, ByRef nC As Long) As Variant
    Dim ur As Range
    Set ur = ws.UsedRange
    nR = ur.Row + ur.Rows.Count - 1
    nC = ur.Column + ur.Columns.Count - 1
    If nR < 1 Or nC < 1 Or (nR = 1 And nC = 1 And IsEmpty(ws.Range("A1").Value)) Then nR = 0: nC = 0: Exit Function
    If nR = 1 And nC = 1 Then
        Dim one(1 To 1, 1 To 1) As Variant
        one(1, 1) = ws.Range("A1").Value
        SheetValues = one
    Else
        SheetValues = ws.Range(ws.Cells(1, 1), ws.Cells(nR, nC)).Value
    End If
End Function

Private Function IsLdSheet(ws As Worksheet) As Boolean
    Dim n As String: n = " " & UCase(ws.Name) & " "
    If InStr(n, " LD ") > 0 Or InStr(n, "LD SHEET") > 0 Or InStr(n, "LATE DEL") > 0 Then IsLdSheet = True: Exit Function
    Dim r As Long, c As Long, s As String
    For r = 1 To 4
        For c = 1 To 30
            s = UCase(CStr(ws.Cells(r, c).Value))
            If InStr(s, "LD AMOUNT") > 0 Or InStr(s, "L D AMOUNT") > 0 Then IsLdSheet = True: Exit Function
        Next c
    Next r
End Function

' a heading row of a trip table: a vehicle heading and a loading / LR heading
Private Function IsHeaderRow(a As Variant, r As Long, nC As Long) As Boolean
    Dim c As Long, s As String, hasV As Boolean, hasL As Boolean
    For c = 1 To nC
        s = Up(a(r, c))
        If s <> "" Then
            If InStr(s, "VEHICLE") > 0 Or InStr(s, "TRUCK") > 0 Or InStr(s, "LORRY") > 0 Then hasV = True
            If InStr(s, "LOADING") > 0 Or InStr(s, "LOAD WT") > 0 Or InStr(s, "LR NO") > 0 Or InStr(s, "L.R") > 0 Then hasL = True
        End If
    Next c
    IsHeaderRow = hasV And hasL
End Function

' the trip tables on a sheet; True when it has one
Private Function ReadTrips(ws As Worksheet) As Boolean
    Dim a As Variant, nR As Long, nC As Long
    a = SheetValues(ws, nR, nC)
    If nR < 3 Then Exit Function
    Dim r As Long, c As Long, k As Long
    Dim gQty(1 To 6) As Long, gRate(1 To 6) As Long, gAmt(1 To 6) As Long, gCash(1 To 6) As Long, nG As Long
    Dim dates(1 To 40) As Long, nDates As Long
    ' the title (month)
    For r = 1 To IIf(nR < 6, nR, 6)
        For c = 1 To nC
            If gTitle = "" And VarType(a(r, c)) = vbString Then
                If MonthOfText(CStr(a(r, c))) > 0 Then gTitle = Trim(CStr(a(r, c)))
            End If
        Next c
    Next r
    Dim heads() As Long, nH As Long: ReDim heads(1 To 64)
    For r = 1 To nR
        If IsHeaderRow(a, r, nC) Then
            nH = nH + 1
            If nH > UBound(heads) Then
                ReDim Preserve heads(1 To nH * 2)
            End If
            heads(nH) = r
        End If
    Next r
    If nH = 0 Then Exit Function
    ReadTrips = True

    For k = 1 To nH
        Dim h As Long, lastR As Long: h = heads(k)
        If k < nH Then lastR = heads(k + 1) - 1 Else lastR = nR
        ' the sub-heading row under it (DIESEL QTY., FUEL/LTR, AMOUNT, CASH ...)
        Dim subIsHead As Boolean: subIsHead = False
        If h + 1 <= nR Then
            Dim anyVeh As Boolean: anyVeh = False
            For c = 1 To nC
                If NormVeh(a(h + 1, c)) <> "" Then anyVeh = True
                Dim s2 As String: s2 = Up(a(h + 1, c))
                If InStr(s2, "QTY") > 0 Or InStr(s2, "AMOUNT") > 0 Or InStr(s2, "FUEL") > 0 Or InStr(s2, "CASH") > 0 Or InStr(s2, "DATE") > 0 Then subIsHead = True
            Next c
            If anyVeh Then subIsHead = False
        End If
        ' ---- the columns, by their headings ----
        Dim colVeh As Long, colLr As Long, colLW As Long, colUW As Long, colRate As Long, colTotal As Long, colCO As Long
        Dim colLD As Long, colUD As Long
        colVeh = 0: colLr = 0: colLW = 0: colUW = 0: colRate = 0: colTotal = 0: colCO = 0: colLD = 0: colUD = 0
        nG = 0: nDates = 0
        For c = 1 To 6: gQty(c) = 0: gRate(c) = 0: gAmt(c) = 0: gCash(c) = 0: Next c
        For c = 1 To nC
            Dim s1 As String, sb As String, both As String
            s1 = Up(a(h, c))
            If subIsHead Then sb = Up(a(h + 1, c)) Else sb = ""
            both = Trim(s1 & " " & sb)
            If both <> "" Then
                If s1 <> "" And (InStr(s1, "DIESEL") > 0 Or InStr(s1, "FUEL") > 0 Or InStr(s1, "HSD") > 0 Or InStr(s1, "PUMP") > 0 Or InStr(s1, "RAYAGADA") > 0 Or InStr(s1, "DASPALLA") > 0 Or InStr(s1, "VRID") > 0 Or InStr(s1, "MUNIGUDA") > 0 Or InStr(s1, "KORBA") > 0) _
                   And InStr(s1, "DATE") = 0 And InStr(s1, "QTY") = 0 And InStr(s1, "AMOUNT") = 0 And InStr(s1, "LTR") = 0 Then
                    If nG < 6 Then nG = nG + 1
                End If
                Dim x As String: If sb <> "" Then x = sb Else x = s1
                If colLr = 0 And (InStr(both, "LR NO") > 0 Or InStr(both, "L.R") > 0 Or both = "LR" Or InStr(both, "BILTY") > 0) Then
                    colLr = c
                ElseIf colVeh = 0 And (InStr(both, "VEHICLE") > 0 Or InStr(both, "TRUCK") > 0 Or InStr(both, "LORRY") > 0) Then
                    colVeh = c
                ElseIf (InStr(both, "UNL") > 0 Or InStr(both, "UNLOAD") > 0) And (InStr(both, "WT") > 0 Or InStr(both, "WEIGHT") > 0) Then
                    colUW = c
                ElseIf InStr(both, "LOAD") > 0 And (InStr(both, "WT") > 0 Or InStr(both, "WEIGHT") > 0) Then
                    colLW = c
                ElseIf InStr(both, "SHORT") > 0 Or InStr(both, "EXCESS") > 0 Then
                    ' shortage / excess: worked out, not read
                ElseIf InStr(both, "FRIEGHT") > 0 Or InStr(both, "FREIGHT") > 0 Or InStr(both, "BHADA") > 0 Or both = "RATE" Then
                    colRate = c
                ElseIf colTotal = 0 And (both = "TOTAL" Or InStr(" " & both & " ", " TOTAL ") > 0) Then
                    colTotal = c
                ElseIf InStr(both, "CASH") > 0 And InStr(both, "DATE") > 0 Then
                    ' the cash office date
                ElseIf InStr(both, "CASH OFFICE") > 0 Or InStr(both, "OFFICE CASH") > 0 Or InStr(both, "OFFICE") > 0 Then
                    colCO = c
                ElseIf nG > 0 And (InStr(x, "/LTR") > 0 Or InStr(x, "/ LTR") > 0 Or InStr(x, "PER LTR") > 0 Or InStr(x, "RATE") > 0 Or InStr(x, "RSP") > 0 Or InStr(x, "PRICE") > 0) Then
                    gRate(nG) = c
                ElseIf nG > 0 And (InStr(x, "QTY") > 0 Or InStr(x, "QUANTITY") > 0 Or InStr(x, "LTR") > 0 Or InStr(x, "LITRE") > 0) Then
                    gQty(nG) = c
                ElseIf nG > 0 And (InStr(x, "AMOUNT") > 0 Or InStr(x, "AMT") > 0) Then
                    gAmt(nG) = c
                ElseIf nG > 0 And InStr(" " & x & " ", " CASH ") > 0 Then
                    gCash(nG) = c
                ElseIf InStr(both, "DATE") > 0 Then
                    If nDates < 40 Then nDates = nDates + 1: dates(nDates) = c
                End If
            End If
        Next c
        ' loading / unloading date: the DATE just left of each weight
        For c = 1 To nDates
            If dates(c) < colLW Then colLD = dates(c)
            If colUW > 0 And dates(c) < colUW Then colUD = dates(c)
        Next c
        If colUD = colLD Then colUD = 0
        If colVeh = 0 Or colLW = 0 Then GoTo NextBlock

        ' the vehicle named above the table
        Dim named As String: named = ""
        For r = h - 1 To IIf(h - 3 < 1, 1, h - 3) Step -1
            For c = 1 To nC
                If named = "" Then named = NormVeh(a(r, c))
            Next c
            If named <> "" Then Exit For
        Next r
        ' ---- the trips ----
        Dim startR As Long, lastTrip As Long, firstT As Long, vehOfBlock As String
        If subIsHead Then startR = h + 2 Else startR = h + 1
        lastTrip = startR - 1: firstT = nT + 1: vehOfBlock = ""
        For r = startR To lastR
            Dim vv As String, wt As Double
            vv = NormVeh(a(r, colVeh))
            wt = Num(a(r, colLW))
            If vv <> "" And wt > 0 Then
                lastTrip = r
                nT = nT + 1
                If nT > UBound(T) Then
                    ReDim Preserve T(1 To nT * 2)
                End If
                With T(nT)
                    .veh = vv: .loadWt = wt: .srcRow = r: .srcSheet = ws.Name
                    If colLr > 0 Then .lr = Trim(CStr(a(r, colLr))) Else .lr = ""
                    If colLD > 0 Then .rawLoad = a(r, colLD) Else .rawLoad = Empty
                    If colUD > 0 Then .rawUnload = a(r, colUD) Else .rawUnload = Empty
                    If colUW > 0 Then
                        If IsNumeric(a(r, colUW)) And Not IsEmpty(a(r, colUW)) Then .unloadWt = Num(a(r, colUW)): .hasUnload = (.unloadWt > 0)
                    End If
                    If colRate > 0 Then .rate = Num(a(r, colRate))
                    If colTotal > 0 Then
                        If IsNumeric(a(r, colTotal)) And Not IsEmpty(a(r, colTotal)) Then .total = Num(a(r, colTotal)): .hasTotal = True
                    End If
                    If colCO > 0 Then .cashOffice = Num(a(r, colCO))
                    Dim g As Long, q As Double, pr As Double, am As Double, cs As Double
                    .diesel = 0: .litres = 0: .cash = 0: .fillNote = ""
                    For g = 1 To nG
                        q = 0: pr = 0: am = 0: cs = 0
                        If gQty(g) > 0 Then q = Num(a(r, gQty(g)))
                        If gRate(g) > 0 Then pr = Num(a(r, gRate(g)))
                        If gAmt(g) > 0 Then am = Num(a(r, gAmt(g)))
                        If gCash(g) > 0 Then cs = Num(a(r, gCash(g)))
                        .diesel = .diesel + am + cs: .cash = .cash + cs
                        If am > 0 Then .litres = .litres + q
                        If q > 0 And pr > 0 And am > 0 Then
                            If Abs(q * pr - am) > 1 Then .fillNote = .fillNote & Format(q, "0.##") & " L x " & Format(pr, "0.00") & " = " & Format(q * pr, "#,##0") & " but SSFC wrote " & Format(am, "#,##0") & "; "
                        End If
                    Next g
                End With
                If vehOfBlock = "" Then vehOfBlock = vv
            End If
        Next r
        If vehOfBlock = "" Then vehOfBlock = named
        If vehOfBlock = "" Then GoTo NextBlock
        nV = nV + 1
        If nV > UBound(V) Then
            ReDim Preserve V(1 To nV * 2)
        End If
        V(nV).veh = vehOfBlock: V(nV).t0 = firstT: V(nV).nT = nT - firstT + 1
        V(nV).hasSub = False: V(nV).hasNet = False
        ' the subtotal row: a number in TOTAL just under the trips, with no words on the row
        For r = lastTrip + 1 To IIf(lastTrip + 2 < lastR, lastTrip + 2, lastR)
            If colTotal > 0 Then
                If IsNumeric(a(r, colTotal)) And Not IsEmpty(a(r, colTotal)) And Not RowHasWords(a, r, nC) Then
                    V(nV).subtotal = Num(a(r, colTotal)): V(nV).hasSub = True: Exit For
                End If
            End If
        Next r
        ' the deduction lines and NET AMOUNT: a label, and its number
        For r = lastTrip + 1 To lastR
            For c = 1 To nC
                If VarType(a(r, c)) = vbString Then
                    Dim lab As String, kind As String, amt As Double, found As Boolean
                    lab = Trim(CStr(a(r, c)))
                    If HasAlpha(lab) And NormVeh(lab) = "" Then
                        kind = KindOf(lab)
                        If kind <> "" And kind <> "total" Then
                            found = False
                            If colTotal > c Then
                                If IsNumeric(a(r, colTotal)) And Not IsEmpty(a(r, colTotal)) Then amt = Num(a(r, colTotal)): found = True
                            End If
                            If Not found Then
                                Dim c2 As Long
                                For c2 = c + 1 To nC
                                    If IsNumeric(a(r, c2)) And Not IsEmpty(a(r, c2)) And VarType(a(r, c2)) <> vbString Then amt = Num(a(r, c2)): found = True: Exit For
                                    If VarType(a(r, c2)) = vbString Then
                                        If IsNumeric(Replace(a(r, c2), ",", "")) Then amt = CDbl(Replace(a(r, c2), ",", "")): found = True: Exit For
                                    End If
                                Next c2
                            End If
                            If found Then
                                If kind = "net" Then
                                    V(nV).net = amt: V(nV).hasNet = True
                                Else
                                    nD = nD + 1
                                    If nD > UBound(D) Then
                                        ReDim Preserve D(1 To nD * 2)
                                    End If
                                    D(nD).veh = vehOfBlock: D(nD).label = lab: D(nD).kind = kind: D(nD).amount = Round(amt, 2)
                                End If
                                Exit For
                            End If
                        End If
                    End If
                End If
            Next c
        Next r
NextBlock:
    Next k
End Function

' the expense (bill) sheet: True when it had bills
Private Function ReadBills(ws As Worksheet) As Boolean
    Dim a As Variant, nR As Long, nC As Long
    a = SheetValues(ws, nR, nC)
    If nR < 2 Then Exit Function
    Dim r As Long, c As Long, nBill As Long, firstBill As Long
    Dim isBill() As Boolean: ReDim isBill(1 To nR)
    For r = 1 To nR
        For c = 1 To nC
            If NormVeh(a(r, c)) <> "" Then isBill(r) = True: Exit For
        Next c
        If isBill(r) Then
            nBill = nBill + 1
            If firstBill = 0 Then firstBill = r
        End If
    Next r
    If nBill < 2 Then Exit Function
    ' what is in each column
    Dim sVeh() As Long, sCat() As Long, sNum() As Long, sDate() As Long, sText() As Long, sInt() As Long, sSum() As Double
    ReDim sVeh(1 To nC): ReDim sCat(1 To nC): ReDim sNum(1 To nC): ReDim sDate(1 To nC): ReDim sText(1 To nC): ReDim sInt(1 To nC): ReDim sSum(1 To nC)
    For r = 1 To nR
        If isBill(r) Then
            For c = 1 To nC
                Dim v As Variant: v = a(r, c)
                If Not IsEmpty(v) And CStr(v) <> "" Then
                    If NormVeh(v) <> "" Then sVeh(c) = sVeh(c) + 1
                    If VarType(v) = vbString Then
                        If IsCat(CStr(v)) Then sCat(c) = sCat(c) + 1
                        If HasAlpha(CStr(v)) And NormVeh(v) = "" Then sText(c) = sText(c) + Len(Trim(CStr(v)))
                    End If
                    If IsNumeric(v) And VarType(v) <> vbString Then
                        sNum(c) = sNum(c) + 1
                        If Num(v) > 0 Then sSum(c) = sSum(c) + Num(v)
                        If Num(v) = Int(Num(v)) Then sInt(c) = sInt(c) + 1
                    ElseIf VarType(v) = vbString Then
                        If IsNumeric(Replace(CStr(v), ",", "")) Then sNum(c) = sNum(c) + 1: sSum(c) = sSum(c) + Abs(CDbl(Replace(CStr(v), ",", "")))
                    End If
                    If LooksDate(v) Then sDate(c) = sDate(c) + 1
                End If
            Next c
        End If
    Next r
    ' a header row, when there is one, settles it
    Dim hVeh As Long, hAmt As Long, hCat As Long, hDesc As Long, hDate As Long, hBill As Long
    For r = 1 To firstBill - 1
        For c = 1 To nC
            Dim t As String: t = Up(a(r, c))
            If t <> "" Then
                If InStr(t, "VEHICLE") > 0 Or InStr(t, "TRUCK") > 0 Then
                    hVeh = c
                ElseIf InStr(t, "PAYMENT") > 0 Or InStr(t, "AMOUNT") > 0 Or InStr(t, "TOTAL") > 0 Or InStr(t, "AMT") > 0 Then
                    hAmt = c
                ElseIf InStr(t, "EXPENSE") > 0 Or InStr(t, "HEAD") > 0 Or InStr(t, "TYPE") > 0 Or InStr(t, "CATEG") > 0 Then
                    hCat = c
                ElseIf InStr(t, "REMARK") > 0 Or InStr(t, "PARTIC") > 0 Or InStr(t, "DESC") > 0 Or InStr(t, "ITEM") > 0 Or InStr(t, "DETAIL") > 0 Then
                    hDesc = c
                ElseIf InStr(t, "DATE") > 0 Then
                    hDate = c
                ElseIf InStr(t, "BILL") > 0 Or InStr(t, "VOUCH") > 0 Then
                    hBill = c
                End If
            End If
        Next c
    Next r
    Dim colVeh As Long, colCat As Long, colDate As Long, colAmt As Long, colDesc As Long, best As Long
    colVeh = hVeh
    If colVeh = 0 Then
        For c = 1 To nC
            If sVeh(c) > best Then best = sVeh(c): colVeh = c
        Next c
    End If
    colCat = hCat
    If colCat = 0 Then
        best = 0
        For c = 1 To nC
            If c <> colVeh And sCat(c) >= nBill * 0.5 And sCat(c) > best Then best = sCat(c): colCat = c
        Next c
    End If
    colDate = hDate
    If colDate = 0 Then
        best = 0
        For c = 1 To nC
            If c <> colVeh And c <> colCat And sDate(c) >= nBill * 0.4 And sDate(c) > best Then best = sDate(c): colDate = c
        Next c
    End If
    colAmt = hAmt
    If colAmt = 0 Then
        ' right of the vehicle, a number on most bills - the one adding up to most
        For c = colVeh + 1 To nC
            If c <> colCat And c <> colDate And sNum(c) >= nBill * 0.5 Then
                If colAmt = 0 Then
                    colAmt = c
                ElseIf sSum(c) > sSum(colAmt) Then
                    colAmt = c
                End If
            End If
        Next c
    End If
    colDesc = hDesc
    If colDesc = 0 Then
        best = 0
        For c = 1 To nC
            If c <> colVeh And c <> colCat And c <> colDate And c <> colAmt And sText(c) > best Then best = sText(c): colDesc = c
        Next c
    End If
    If colVeh = 0 Or colAmt = 0 Then
        AddFind "CHECK", "bill", "", 0, "Sheet '" & ws.Name & "': couldn't tell its vehicle / amount columns - its bills weren't read."
        Exit Function
    End If
    For r = 1 To nR
        If isBill(r) Then
            Dim vv As String: vv = NormVeh(a(r, colVeh))
            If vv = "" Then
                For c = 1 To nC
                    If vv = "" Then vv = NormVeh(a(r, c))
                Next c
            End If
            Dim amtV As Variant: amtV = a(r, colAmt)
            If vv <> "" And IsNumeric(Replace(CStr(amtV), ",", "")) And CStr(amtV) <> "" Then
                nB = nB + 1
                If nB > UBound(B) Then
                    ReDim Preserve B(1 To nB * 2)
                End If
                With B(nB)
                    .veh = vv: .amount = Round(CDbl(Replace(CStr(amtV), ",", "")), 2): .srcSheet = ws.Name: .srcRow = r
                    If colDesc > 0 Then .desc = Squeeze(CStr(a(r, colDesc))) Else .desc = ""
                    If colCat > 0 Then .cat = Squeeze(CStr(a(r, colCat))) Else .cat = ""
                    If hBill > 0 Then .billNo = Trim(CStr(a(r, hBill))) Else .billNo = ""
                    If .cat <> "" Then .kind = KindOf(.cat) Else .kind = KindOf(.desc)
                    If .kind = "" Or .kind = "net" Or .kind = "total" Then .kind = "other"
                    .isDef = IsDef(.desc) Or IsDef(.cat)
                    If .isDef And (.kind = "maint" Or .kind = "other") Then .kind = "maint"
                    .dt = 0
                    If colDate > 0 Then .dt = DateNear(a(r, colDate), gMonth)
                    .others = OtherVehicles(.desc, vv)
                End With
            End If
        End If
    Next r
    ReadBills = True
End Function

Private Sub ReadLd(ws As Worksheet)
    Dim a As Variant, nR As Long, nC As Long
    a = SheetValues(ws, nR, nC)
    If nR < 2 Then Exit Sub
    Dim r As Long, c As Long, t As String
    Dim hAmt As Long, hVeh As Long, hDays As Long, hInv As Long, hWt As Long
    For r = 1 To IIf(nR < 4, nR, 4)
        For c = 1 To nC
            t = Up(a(r, c))
            If InStr(t, "LD AMOUNT") > 0 Or InStr(t, "L D AMOUNT") > 0 Then
                hAmt = c
            ElseIf InStr(t, "TRUCK") > 0 Or InStr(t, "VEHICLE") > 0 Then
                hVeh = c
            ElseIf Left(t, 4) = "DAYS" Then
                hDays = c
            ElseIf InStr(t, "INV") > 0 And InStr(t, "DATE") > 0 Then
                hInv = c
            ElseIf InStr(t, "NET W") > 0 Then
                hWt = c
            End If
        Next c
    Next r
    If hAmt = 0 Then Exit Sub
    For r = 1 To nR
        Dim vv As String: vv = ""
        If hVeh > 0 Then vv = NormVeh(a(r, hVeh))
        If vv <> "" Then
            nL = nL + 1
            If nL > UBound(L) Then
                ReDim Preserve L(1 To nL * 2)
            End If
            L(nL).veh = vv
            L(nL).amount = Num(a(r, hAmt))
            If hDays > 0 Then L(nL).days = Num(a(r, hDays))
            If hWt > 0 Then L(nL).wt = Num(a(r, hWt))
            If hInv > 0 Then L(nL).inv = DateNear(a(r, hInv), 0)
        End If
    Next r
End Sub

' dates, read against the month: each trip's loading and unloading date together
Private Sub ResolveDates()
    Dim i As Long, j As Long
    For i = 1 To nT
        TripDates T(i).rawLoad, T(i).rawUnload, T(i).loadDate, T(i).unloadDate, T(i).dateFixed
    Next i
    For j = 1 To nL
        If L(j).inv > 0 Then L(j).inv = SwapNear(L(j).inv, gMonth)
    Next j
End Sub

'==================================================================
'  MATCHING AND POSTING
'==================================================================
Private Sub FindRegisterColumns(wsTR As Worksheet)
    ' the defaults (Trip Register as it is), then each found by its row-2 heading
    cVeh = 3: cTrip = 2: cLoadDate = 5: cLW = 6: cUnloadDate = 7: cUW = 8: cPort = 10: cDest = 11
    cRate = 14: cBhada = 15: cDslL = 16: cDslAmt = 17: cY = 25: cAA = 27: cAD = 30: cAK = 37: cAL = 38: cMonth = 43
    Dim c As Long, k As String
    For c = 1 To 60
        k = KeyOf(wsTR.Cells(TR_HDR_ROWS, c).Value)
        Select Case k
            Case "vehicleno": cVeh = c
            Case "tripno": cTrip = c
            Case "loadingdate": cLoadDate = c
            Case "loadweight": cLW = c
            Case "unloaddate": cUnloadDate = c
            Case "unloadweight": cUW = c
            Case "loadingport": cPort = c
            Case "destination": cDest = c
            Case "priceton": cRate = c
            Case "tripbhada": cBhada = c
            Case "ssfcdieselltr": cDslL = c
            Case "ssfcdieselamount": cDslAmt = c
            Case "driverssfcpayment": cY = c
            Case "ssfcmisc": cAA = c
            Case "fastag": cAD = c
            Case "documentexpense": cAK = c
            Case "ssfcnetamount": cAL = c
            Case "month": cMonth = c
        End Select
    Next c
End Sub

' each SSFC trip -> the register row: the same weight within a week; else the nearest date
' within 3 days (weight within 1 T); else the same weight, any date
Private Sub MatchTrips(wsTR As Worksheet, lastRowTR As Long)
    Dim used As SDict: Set used = New SDict
    Dim i As Long, r As Long, best As Long, bestGap As Double, gap As Double, w As Double, pass As Long
    If lastRowTR <= TR_HDR_ROWS + 1 Then Exit Sub
    ' the register's vehicle, weight and loading date, read once
    Dim n As Long: n = lastRowTR - TR_HDR_ROWS
    Dim rv() As String, rw() As Double, rd() As Date: ReDim rv(1 To n): ReDim rw(1 To n): ReDim rd(1 To n)
    Dim av As Variant, aw As Variant, ad As Variant
    av = wsTR.Range(wsTR.Cells(TR_HDR_ROWS + 1, cVeh), wsTR.Cells(lastRowTR, cVeh)).Value
    aw = wsTR.Range(wsTR.Cells(TR_HDR_ROWS + 1, cLW), wsTR.Cells(lastRowTR, cLW)).Value
    ad = wsTR.Range(wsTR.Cells(TR_HDR_ROWS + 1, cLoadDate), wsTR.Cells(lastRowTR, cLoadDate)).Value
    For r = 1 To n
        rv(r) = NormVeh(av(r, 1)): rw(r) = Num(aw(r, 1)): rd(r) = CDateOr0(ad(r, 1))
    Next r
    For i = 1 To nT
        T(i).trRow = 0: T(i).how = ""
        For pass = 1 To 3
            best = 0: bestGap = 1E+30
            For r = 1 To n
                If rv(r) = T(i).veh And rw(r) > 0 Then
                    If Not used.Exists(r) Then
                        w = rw(r)
                        If rd(r) = 0 Or T(i).loadDate = 0 Then gap = 99 Else gap = Abs(rd(r) - T(i).loadDate)
                        Select Case pass
                            Case 1
                                If Abs(w - T(i).loadWt) < 0.011 And gap <= 7 Then
                                    If gap < bestGap Then bestGap = gap: best = r
                                End If
                            Case 2
                                If gap <= 3 And Abs(w - T(i).loadWt) <= 1 Then
                                    If gap + Abs(w - T(i).loadWt) / 100 < bestGap Then bestGap = gap + Abs(w - T(i).loadWt) / 100: best = r
                                End If
                            Case 3
                                If Abs(w - T(i).loadWt) < 0.011 Then
                                    If gap < bestGap Then bestGap = gap: best = r
                                End If
                        End Select
                    End If
                End If
            Next r
            If best > 0 Then
                T(i).trRow = best + TR_HDR_ROWS
                T(i).how = Choose(pass, "weight", "date", "weight (another month)")
                used.Add best, True
                Exit For
            End If
        Next pass
    Next i
End Sub

' deductions on each vehicle's last trip row of the month (as before)
Private Sub PostDeductions(wsTR As Worksheet, monthRows As Collection)
    Dim i As Long, rw As Variant, lastRw As Long, c As Long
    For i = 1 To nD
        If D(i).col <> "" Then
            lastRw = 0
            For Each rw In monthRows
                If NormVeh(wsTR.Cells(rw, cVeh).Value) = D(i).veh And CLng(rw) > lastRw Then lastRw = CLng(rw)
            Next rw
            If lastRw > 0 Then
                c = ColOfLetter(D(i).col)
                If c > 0 Then wsTR.Cells(lastRw, c).Value = NZ(wsTR.Cells(lastRw, c)) + D(i).amount
            Else
                AddFind "CHECK", "register", D(i).veh, D(i).amount, D(i).veh & ": """ & D(i).label & """ Rs " & Format(D(i).amount, "#,##0") & " not posted - the vehicle has no trip in the Trip Register this month"
            End If
        End If
    Next i
End Sub

'==================================================================
'  THE CHECKS
'==================================================================
Private Sub RunChecks(wsTR As Worksheet, lastRowTR As Long, monthRows As Collection, posted As Boolean)
    Dim i As Long, j As Long, k As Long, r As Long, dv As Double
    ' ---- their arithmetic ----
    For i = 1 To nV
        Dim rowSum As Double: rowSum = 0
        For j = V(i).t0 To V(i).t0 + V(i).nT - 1
            With T(j)
                If .fillNote <> "" Then AddFind "CHECK", "math", .veh, 0, Short(.veh) & " trip loaded " & DM(.loadDate) & ": " & .fillNote
                If .hasTotal Then
                    rowSum = rowSum + .total
                    dv = Round(.loadWt * .rate - .diesel - .cashOffice - .total, 2)
                    If Abs(dv) > 1 Then AddFind IIf(dv > 0, "CLAIM", "NOTE"), "math", .veh, IIf(dv > 0, dv, 0), Short(.veh) & " trip loaded " & DM(.loadDate) & " (" & .loadWt & " T): freight " & Rs(.loadWt * .rate) & " - diesel " & Rs(.diesel) & " - cash office " & Rs(.cashOffice) & " = " & Rs(.loadWt * .rate - .diesel - .cashOffice) & ", but SSFC's total is " & Rs(.total)
                End If
            End With
        Next j
        If V(i).hasSub And V(i).nT > 0 Then
            dv = Round(rowSum - V(i).subtotal, 2)
            If Abs(dv) > 1 Then AddFind IIf(dv > 0, "CLAIM", "NOTE"), "math", V(i).veh, IIf(dv > 0, dv, 0), Short(V(i).veh) & ": its trips' totals add up to " & Rs(rowSum) & ", but SSFC's subtotal is " & Rs(V(i).subtotal)
        End If
        If V(i).hasNet Then
            Dim baseAmt As Double, ded As Double
            If V(i).hasSub Then baseAmt = V(i).subtotal Else baseAmt = rowSum
            ded = DedSum(V(i).veh, "")
            dv = Round(baseAmt - ded - V(i).net, 2)
            If Abs(dv) > 1 Then AddFind IIf(dv > 0, "CLAIM", "NOTE"), "math", V(i).veh, IIf(dv > 0, dv, 0), Short(V(i).veh) & ": " & Rs(baseAmt) & " - deductions " & Rs(ded) & " = " & Rs(baseAmt - ded) & ", but SSFC's NET AMOUNT is " & Rs(V(i).net)
        End If
    Next i

    ' (trips, rate, weights, diesel, DEF, LD and the register's figures are checked live, by
    '  formulas in the SSFC Check sheet: they follow your corrections to the Trip Register)
    Dim nFixed As Long
    For i = 1 To nT
        If T(i).dateFixed Then nFixed = nFixed + 1
    Next i
    If nFixed > 0 Then AddFind "NOTE", "trip", "", 0, nFixed & " of SSFC's dates were typed month-first or saved day/month swapped - read the right way round"
    ' a rate SSFC paid that is another route's rate (the rate gap itself is in the live trip table)
    Dim seen As String, other As String, key As String
    For i = 1 To nT
        If T(i).trRow > 0 Then
            If Abs(NZ(wsTR.Cells(T(i).trRow, cRate)) - T(i).rate) > 0.5 Then
                other = OtherRouteOfRate(T(i).rate, CStr(wsTR.Cells(T(i).trRow, cPort).Value), CStr(wsTR.Cells(T(i).trRow, cDest).Value))
                key = "|" & wsTR.Cells(T(i).trRow, cPort).Value & ">" & wsTR.Cells(T(i).trRow, cDest).Value & ">" & T(i).rate & "|"
                If other <> "" And InStr(seen, key) = 0 Then
                    seen = seen & key
                    AddFind "NOTE", "rate", "", 0, "SSFC paid Rs " & Format(T(i).rate, "#,##0") & "/T on " & wsTR.Cells(T(i).trRow, cPort).Value & " -> " & wsTR.Cells(T(i).trRow, cDest).Value & " trips (e.g. " & Short(T(i).veh) & " " & wsTR.Cells(T(i).trRow, cTrip).Value & "): that is your " & other & " rate - is the route right in the register, or did SSFC pay the wrong route?"
                End If
            End If
        End If
    Next i

    ' ---- deductions that need a paper; RTO entry against the others ----
    For i = 1 To nD
        If D(i).kind = "emi" And D(i).amount > 0 Then AddFind "CLAIM", "deduction", D(i).veh, D(i).amount, Short(D(i).veh) & ": SSFC deducted an instalment / EMI """ & D(i).label & """ " & Rs(D(i).amount) & " - you pay your EMIs to the bank yourself (not posted)"
        If (D(i).kind = "other" Or D(i).kind = "gps" Or D(i).kind = "penalty" Or D(i).kind = "union") And D(i).amount > 0 Then
            AddFind "CHECK", "deduction", D(i).veh, D(i).amount, Short(D(i).veh) & ": SSFC deducted """ & D(i).label & """ " & Rs(D(i).amount) & IIf(D(i).kind = "other", " - a line not in its usual list;", " -") & " ask for the bill / proof (posted to SSFC Misc)"
        End If
    Next i
    Dim ents() As Double, nE As Long, usual As Double, x As Double: ReDim ents(1 To nV + 1)
    For i = 1 To nV
        x = DedSum(V(i).veh, "rtoEntry")
        If x > 0 Then nE = nE + 1: ents(nE) = x
    Next i
    If nE > 0 Then
        SortD ents, nE
        ' what most vehicles pay: the most common amount (a tie goes to the lower)
        Dim bestN As Long, runN As Long, q As Long
        usual = ents(1): bestN = 0
        For q = 1 To nE
            runN = 1
            If q > 1 Then
                If ents(q) = ents(q - 1) Then runN = runN + 1
            End If
            If runN > bestN Then bestN = runN: usual = ents(q)
        Next q
        For i = 1 To nV
            x = DedSum(V(i).veh, "rtoEntry")
            If x > usual + 1 Then
                ' one or two charged more is a flag; as many on the higher amount as the lower is a question
                Dim sameN As Long: sameN = 0
                For q = 1 To nE
                    If ents(q) = x Then sameN = sameN + 1
                Next q
                If sameN >= nE * 0.4 Then
                    AddFind "CHECK", "deduction", V(i).veh, x - usual, Short(V(i).veh) & ": RTO entry " & Rs(x) & " - " & sameN & " vehicles were charged that, the others " & Rs(usual) & ": ask SSFC why"
                Else
                    AddFind "CLAIM", "deduction", V(i).veh, x - usual, Short(V(i).veh) & ": RTO entry " & Rs(x) & " - the other vehicles pay " & Rs(usual)
                End If
            End If
            If x > 0 And V(i).nT = 0 Then AddFind "CHECK", "deduction", V(i).veh, x, Short(V(i).veh) & ": RTO entry " & Rs(x) & " in a month it ran no trip"
        Next i
    End If

    ' ---- the bills behind the deductions, head by head ----
    If nB > 0 Then
        Dim grp As Variant, gName As Variant, kinds As Variant
        grp = Array("maint", "over", "tyre", "rto")
        gName = Array("maintenance (incl. DEF, documents, GPS)", "over / unload (incl. driver fooding)", "tyre", "RTO challan")
        kinds = Array("|maint|docExp|other|gps|", "|lessOver|fooding|", "|tyre|", "|rtoChallan|")
        For i = 1 To nV
            For k = 0 To 3
                Dim dS As Double, bS As Double: dS = 0: bS = 0
                For j = 1 To nD
                    If D(j).veh = V(i).veh And InStr(kinds(k), "|" & D(j).kind & "|") > 0 Then dS = dS + D(j).amount
                Next j
                For j = 1 To nB
                    If B(j).veh = V(i).veh And InStr(kinds(k), "|" & B(j).kind & "|") > 0 Then bS = bS + B(j).amount
                Next j
                dv = Round(dS - bS, 2)
                If dv > 1 Then AddFind "CLAIM", "bill", V(i).veh, dv, Short(V(i).veh) & " - " & gName(k) & ": SSFC deducted " & Rs(dS) & ", its bills add up to " & Rs(bS) & " - " & Rs(dv) & " with no bill behind it"
                If dv < -1 Then AddFind "NOTE", "bill", V(i).veh, 0, Short(V(i).veh) & " - " & gName(k) & ": bills of " & Rs(bS) & ", SSFC deducted only " & Rs(dS)
            Next k
        Next i
        ' twice in the bills (RTO challans pass the same place on each trip: only past 2 a trip)
        For i = 1 To nB
            Dim same As Long: same = 0
            For j = 1 To i - 1
                If B(j).veh = B(i).veh And B(j).dt = B(i).dt And Abs(B(j).amount - B(i).amount) < 0.5 And UCase(B(j).desc) = UCase(B(i).desc) Then same = same + 1
            Next j
            If B(i).kind = "rtoChallan" Then
                Dim nTr As Long: nTr = TripsOf(B(i).veh)
                If same + 1 = nTr * 2 + 1 Then AddFind "CHECK", "bill", B(i).veh, B(i).amount, Short(B(i).veh) & ": """ & B(i).desc & """ " & Rs(B(i).amount) & " is charged " & (same + 1) & " times - more than twice for each of its " & nTr & " trips"
            ElseIf same = 1 And Not B(i).isDef Then
                AddFind "CHECK", "bill", B(i).veh, B(i).amount, Short(B(i).veh) & ": """ & B(i).desc & """ " & Rs(B(i).amount) & " on " & DM(B(i).dt) & " is in the bills twice (" & B(i).srcSheet & " row " & B(i).srcRow & ")"
            End If
            If B(i).billNo <> "" And B(i).billNo <> "0" Then
                For j = 1 To i - 1
                    If B(j).billNo = B(i).billNo And B(j).veh = B(i).veh And Abs(B(j).amount - B(i).amount) < 0.5 Then AddFind "CLAIM", "bill", B(i).veh, B(i).amount, Short(B(i).veh) & ": bill no. " & B(i).billNo & " (""" & B(i).desc & """, " & Rs(B(i).amount) & ") is charged twice": Exit For
                Next j
            End If
            If B(i).others <> "" Then AddFind "CHECK", "bill", B(i).veh, B(i).amount, Short(B(i).veh) & ": one bill """ & B(i).desc & """ (" & Rs(B(i).amount) & ") names " & B(i).others & " too, but is charged to " & Short(B(i).veh) & " alone - check it isn't charged to them as well"
        Next i
    End If

    ' ---- LD: each penalty's trip (the days are compared live) ----
    Dim bestG As Double, g2 As Double
    For i = 1 To nL
        L(i).trRow = 0: bestG = 1E+30
        If L(i).inv > 0 Then
            For r = TR_HDR_ROWS + 1 To lastRowTR
                If NormVeh(wsTR.Cells(r, cVeh).Value) = L(i).veh Then
                    g2 = DayGap(wsTR.Cells(r, cLoadDate).Value, L(i).inv)
                    If g2 <= 7 And (L(i).wt = 0 Or Abs(NZ(wsTR.Cells(r, cLW)) - L(i).wt) < 0.6) And g2 < bestG Then bestG = g2: L(i).trRow = r
                End If
            Next r
        End If
    Next i
End Sub

'==================================================================
'  THE REPORT SHEET
'==================================================================
' The SSFC Check sheet. SSFC's figures are written as values (what SSFC billed); yours are
' FORMULAS into the Trip Register, HSD Data and Urea DEF, and so are the differences, the
' flags and the Rs to claim - correct the register and the sheet follows. Which register row
' each SSFC trip is (and each LD penalty's trip) is set when the macro runs: run it again only
' after adding or deleting trips.
Private Sub BuildCheckSheet(wsTR As Worksheet, monthRows As Collection, posted As Boolean)
    Dim ws As Worksheet
    On Error Resume Next
    Set ws = ThisWorkbook.Worksheets(RPT_SHEET)
    On Error GoTo 0
    If ws Is Nothing Then
        Set ws = ThisWorkbook.Worksheets.Add(After:=ThisWorkbook.Worksheets(ThisWorkbook.Worksheets.Count))
        ws.Name = RPT_SHEET
    Else
        ws.Cells.FormatConditions.Delete
        ws.Cells.Clear
        ws.Columns.Hidden = False
    End If
    Dim i As Long, j As Long, r As Long, k As Long, fx As String
    Dim ms As String: ms = Trim(Str(CLng(gMonth)))
    ' HSD Data and Urea DEF columns, found by their headings
    Dim hV As String, hQ As String, hA As String, hS As String, hT As String
    hV = ColRef("HSD Data", "vehicle|vehicleno"): hQ = ColRef("HSD Data", "quantity|qty"): hA = ColRef("HSD Data", "amount")
    hS = ColRef("HSD Data", "roname"): hT = ColRef("HSD Data", "tripid")
    Dim hasH As Boolean: hasH = (hV <> "" And hQ <> "" And hA <> "" And hS <> "" And hT <> "")
    Dim uName As String: uName = "Urea DEF"
    If ColRef(uName, "date") = "" Then uName = "Urea"
    Dim uD As String, uV As String, uA As String, uF As String
    uD = ColRef(uName, "date"): uV = ColRef(uName, "vehicle|vehicleno"): uA = ColRef(uName, "amount"): uF = ColRef(uName, "purchasedfrom")
    Dim hasU As Boolean: hasU = (uD <> "" And uV <> "" And uA <> "" And uF <> "")

    ws.Range("A1").Value = "SSFC STATEMENT CHECK - " & UCase(Format(gMonth, "mmmm yyyy"))
    ws.Range("A1").Font.Bold = True: ws.Range("A1").Font.Size = 15
    ws.Range("A2").Value = gFile & "   |   run " & Format(Now, "dd-mmm-yyyy hh:mm") & "   |   " & IIf(posted, "posted into the Trip Register (backup in '" & BAK_SHEET & "')", "checked only - nothing posted")
    ws.Range("A2").Font.Italic = True
    ws.Range("A3").Value = "LIVE: SSFC's figures are fixed; yours, the differences, the flags and the Rs to claim are formulas - correct the Trip Register / HSD Data / Urea DEF and they update. Run the macro again only after adding or deleting trips."
    ws.Range("A3").Font.Color = RGB(0, 112, 192)

    ' ---- each trip ----
    r = 7
    Section ws, r, "EACH TRIP - SSFC's figures (fixed) against your Trip Register and HSD Data (live)"
    r = r + 1
    ws.Cells(r, 1).Resize(1, 28).Value = Array("Vehicle", "LR", "Loaded", "SSFC load T", "SSFC unload T", "SSFC rate", "SSFC diesel Rs", "SSFC litres", "of it cash diesel", "SSFC cash office", _
        "Register row", "Your trip", "Your load T", "Your unload T", "Your rate", "HSD Data Rs (SSFC fills)", "HSD Data L", "Your P (L)", "Your Q (Rs)", "Your cash office (Y)", _
        "Rate: short Rs", "Weight: short Rs", "Diesel: SSFC - yours", "P/Q to correct", "Cash office: SSFC - yours", "Fill on next/last trip", "To claim", "Status")
    Hdr ws.Range(ws.Cells(r, 1), ws.Cells(r, 28))
    Dim t0 As Long, tN As Long: t0 = r + 1
    For i = 1 To nT
        r = r + 1
        With T(i)
            ws.Cells(r, 1).Resize(1, 10).Value = Array(.veh, .lr, IIf(.loadDate > 0, .loadDate, ""), .loadWt, IIf(.hasUnload, .unloadWt, ""), .rate, .diesel, .litres, IIf(.cash > 0, .cash, ""), .cashOffice)
            If .trRow > 0 Then
                ws.Cells(r, 11).Value = .trRow
                ws.Cells(r, 12).Formula = "=" & TRCell(cTrip, .trRow)
                ws.Cells(r, 13).Formula = "=" & TRCell(cLW, .trRow)
                ws.Cells(r, 14).Formula = "=" & TRCell(cUW, .trRow)
                ws.Cells(r, 15).Formula = "=" & TRCell(cRate, .trRow)
                If hasH Then
                    ws.Cells(r, 16).Formula = "=SUMIFS(" & hA & "," & hT & ",L" & r & "," & hV & ",A" & r & "," & hS & ",""*SSFC*"")"
                    ws.Cells(r, 17).Formula = "=SUMIFS(" & hQ & "," & hT & ",L" & r & "," & hV & ",A" & r & "," & hS & ",""*SSFC*"")"
                Else
                    ws.Cells(r, 16).Value = 0: ws.Cells(r, 17).Value = 0
                End If
                ws.Cells(r, 18).Formula = "=" & TRCell(cDslL, .trRow)
                ws.Cells(r, 19).Formula = "=" & TRCell(cDslAmt, .trRow)
                ws.Cells(r, 20).Formula = "=" & TRCell(cY, .trRow)
                ws.Cells(r, 21).Formula = "=ROUND((N(O" & r & ")-F" & r & ")*D" & r & ",2)"
                ws.Cells(r, 22).Formula = "=ROUND((N(M" & r & ")-D" & r & ")*F" & r & ",2)"
                ' diesel: against HSD Data's SSFC fills on the trip, else the register's Q
                ws.Cells(r, 23).Formula = "=ROUND(G" & r & "-IF(Q" & r & ">0,P" & r & ",N(S" & r & ")),2)"
                ws.Cells(r, 24).Formula = "=IF(AND(Q" & r & ">0,ABS(G" & r & "-N(S" & r & "))>MAX(100,G" & r & "*0.002)),ROUND(G" & r & "-N(S" & r & "),2),0)"
                ws.Cells(r, 25).Formula = "=ROUND(J" & r & "-N(T" & r & "),2)"
                ' the same Rs over on this trip and under on the trip before / after it: a fill to retag
                ws.Cells(r, 26).Formula = "=IF(ABS(W" & r & ")<=MAX(50,G" & r & "*0.001),0,MIN(1," & _
                    "IF(AND($A" & (r - 1) & "=$A" & r & ",N($K" & (r - 1) & ")>0),IF(ABS(N(W" & (r - 1) & ")+W" & r & ")<=100,1,0),0)+" & _
                    "IF(AND($A" & (r + 1) & "=$A" & r & ",N($K" & (r + 1) & ")>0),IF(ABS(N(W" & (r + 1) & ")+W" & r & ")<=100,1,0),0)))"
                ws.Cells(r, 27).Formula = "=IF(U" & r & ">0.5,U" & r & ",0)+IF(V" & r & ">0.5,V" & r & ",0)+IF(AND(Z" & r & "=0,W" & r & ">MAX(50,G" & r & "*0.001)),W" & r & ",0)"
                fx = "IF(U" & r & ">0.5,""RATE SHORT; "","""")&IF(U" & r & "<-0.5,""your rate is lower; "","""")&IF(V" & r & ">0.5,""WEIGHT SHORT; "","""")" & _
                    "&IF(AND(N(E" & r & ")>0,N(N" & r & ")>0,N(E" & r & ")<N(N" & r & ")-0.011),""UNLOAD SHORTAGE RISK; "","""")" & _
                    "&IF(Z" & r & "=1,""DIESEL ON NEXT/LAST TRIP - RETAG; "",IF(W" & r & ">MAX(50,G" & r & "*0.001),""DIESEL: SSFC MORE; "",IF(W" & r & "<-MAX(100,G" & r & "*0.002),""DIESEL: YOURS MORE; "","""")))" & _
                    "&IF(X" & r & "<>0,""CORRECT P/Q; "","""")&IF(ABS(Y" & r & ")>1,""CASH OFFICE (Y) DIFFERS; "","""")"
                ws.Cells(r, 29).Formula = "=" & fx
                ws.Cells(r, 28).Formula = "=IF(AC" & r & "="""",""OK"",LEFT(AC" & r & ",LEN(AC" & r & ")-2))"
            Else
                ws.Cells(r, 27).Value = 0
                ws.Cells(r, 28).Value = "NOT IN REGISTER - enter it, or ask SSFC whose trip it is"
            End If
        End With
    Next i
    tN = r
    ws.Columns(29).Hidden = True
    If tN >= t0 Then
        ws.Range(ws.Cells(t0, 3), ws.Cells(tN, 3)).NumberFormat = "dd-mmm-yy"
        ws.Range(ws.Cells(t0, 7), ws.Cells(tN, 7)).NumberFormat = "#,##0"
        ws.Range(ws.Cells(t0, 16), ws.Cells(tN, 16)).NumberFormat = "#,##0"
        ws.Range(ws.Cells(t0, 19), ws.Cells(tN, 27)).NumberFormat = "#,##0"
        StatusColours ws.Range(ws.Cells(t0, 28), ws.Cells(tN, 28))
        ClaimColours ws.Range(ws.Cells(t0, 27), ws.Cells(tN, 27))
    End If

    ' ---- register trips this month not in the statement ----
    Dim rw As Variant, paid As Boolean, u0 As Long, uN As Long
    r = r + 2
    Section ws, r, "YOUR TRIPS THIS MONTH NOT IN THE STATEMENT (check they are in next month's)"
    r = r + 1
    ws.Cells(r, 1).Resize(1, 7).Value = Array("Register row", "Trip", "Vehicle", "Loaded", "Load T", "Trip Bhada", "Status")
    Hdr ws.Range(ws.Cells(r, 1), ws.Cells(r, 7))
    u0 = r + 1
    For Each rw In monthRows
        paid = False
        For i = 1 To nT
            If T(i).trRow = CLng(rw) Then paid = True: Exit For
        Next i
        If Not paid And NZ(wsTR.Cells(rw, cLW)) > 0 Then
            r = r + 1
            ws.Cells(r, 1).Value = CLng(rw)
            ws.Cells(r, 2).Formula = "=" & TRCell(cTrip, CLng(rw))
            ws.Cells(r, 3).Formula = "=" & TRCell(cVeh, CLng(rw))
            ws.Cells(r, 4).Formula = "=" & TRCell(cLoadDate, CLng(rw))
            ws.Cells(r, 5).Formula = "=" & TRCell(cLW, CLng(rw))
            ws.Cells(r, 6).Formula = "=" & TRCell(cBhada, CLng(rw))
            ws.Cells(r, 7).Value = "NOT IN THIS STATEMENT"
            ws.Cells(r, 4).NumberFormat = "dd-mmm-yy": ws.Cells(r, 6).NumberFormat = "#,##0"
        End If
    Next rw
    uN = r
    If uN < u0 Then r = r + 1: ws.Cells(r, 1).Value = "None - every trip of the month is paid in this statement."

    ' ---- each vehicle: deductions and SSFC Net against the register (live) ----
    r = r + 2
    Section ws, r, "EACH VEHICLE - SSFC's deductions and NET (fixed) against your Trip Register for " & Format(gMonth, "mmm yyyy") & " (live)"
    r = r + 1
    ws.Cells(r, 1).Resize(1, 10).Value = Array("Vehicle", "SSFC trips", "Your trips", "SSFC deductions (posted heads)", "Yours (" & ColLetter(cAA) & ", " & ColLetter(cAD) & ":" & ColLetter(cAK) & ")", "Yours - SSFC", "SSFC NET", "Your SSFC Net (" & ColLetter(cAL) & ")", "Yours - SSFC", "Status")
    Hdr ws.Range(ws.Cells(r, 1), ws.Cells(r, 10))
    Dim v0 As Long, vN As Long: v0 = r + 1
    Dim crit As String
    For i = 1 To nV
        r = r + 1
        crit = TRCol(cVeh) & ",$A" & r & "," & TRCol(cMonth) & "," & ms
        ws.Cells(r, 1).Value = V(i).veh
        ws.Cells(r, 2).Value = V(i).nT
        ws.Cells(r, 3).Formula = "=COUNTIFS(" & crit & "," & TRCol(cLW) & ","">0"")"
        ws.Cells(r, 4).Value = DedSum(V(i).veh, "") - DedSum(V(i).veh, "emi")
        fx = "=SUMIFS(" & TRCol(cAA) & "," & crit & ")"
        For k = cAD To cAK
            fx = fx & "+SUMIFS(" & TRCol(k) & "," & crit & ")"
        Next k
        ws.Cells(r, 5).Formula = fx
        ws.Cells(r, 6).Formula = "=ROUND(E" & r & "-D" & r & ",2)"
        If V(i).hasNet Then
            ws.Cells(r, 7).Value = V(i).net
            ws.Cells(r, 9).Formula = "=ROUND(H" & r & "-G" & r & ",2)"
        End If
        ws.Cells(r, 8).Formula = "=SUMIFS(" & TRCol(cAL) & "," & crit & ")"
        ws.Cells(r, 11).Formula = "=IF(C" & r & "<>B" & r & ",""TRIPS DIFFER; "","""")&IF(ABS(F" & r & ")>1,""DEDUCTIONS DIFFER; "","""")&IF(ABS(N(I" & r & "))>100,""NET DIFFERS; "","""")"
        ws.Cells(r, 10).Formula = "=IF(K" & r & "="""",""OK"",LEFT(K" & r & ",LEN(K" & r & ")-2))"
    Next i
    vN = r
    ws.Columns(11).Hidden = True
    If vN >= v0 Then
        ws.Range(ws.Cells(v0, 4), ws.Cells(vN, 9)).NumberFormat = "#,##0"
        StatusColours ws.Range(ws.Cells(v0, 10), ws.Cells(vN, 10))
    End If

    ' ---- each deduction head (live) ----
    r = r + 2
    Section ws, r, "DEDUCTIONS BY HEAD - SSFC (fixed) against your Trip Register column (live)"
    r = r + 1
    ws.Cells(r, 1).Resize(1, 7).Value = Array("Vehicle", "Head", "Column", "SSFC Rs", "Yours", "Yours - SSFC", "Status")
    Hdr ws.Range(ws.Cells(r, 1), ws.Cells(r, 7))
    Dim d0 As Long, dN As Long: d0 = r + 1
    Dim heads As Variant, hc As Long, ssfcAmt As Double, regAmt As Double
    heads = Array("Fastag", "Maintenance", "Tyre", "Over / unload", "RTO entry", "RTO challan", "Shortage", "Document exp.", "SSFC Misc (other labels)")
    For i = 1 To nV
        For k = 0 To 8
            If k < 8 Then hc = cAD + k Else hc = cAA
            ssfcAmt = 0
            For j = 1 To nD
                If D(j).veh = V(i).veh And D(j).col <> "" Then
                    If ColOfLetter(D(j).col) = hc Then ssfcAmt = ssfcAmt + D(j).amount
                End If
            Next j
            regAmt = 0
            For Each rw In monthRows
                If NormVeh(wsTR.Cells(rw, cVeh).Value) = V(i).veh Then regAmt = regAmt + NZ(wsTR.Cells(rw, hc))
            Next rw
            If ssfcAmt <> 0 Or regAmt <> 0 Then
                r = r + 1
                ws.Cells(r, 1).Resize(1, 4).Value = Array(V(i).veh, heads(k), ColLetter(hc), ssfcAmt)
                ws.Cells(r, 5).Formula = "=SUMIFS(" & TRCol(hc) & "," & TRCol(cVeh) & ",$A" & r & "," & TRCol(cMonth) & "," & ms & ")"
                ws.Cells(r, 6).Formula = "=ROUND(E" & r & "-D" & r & ",2)"
                ws.Cells(r, 7).Formula = "=IF(ABS(F" & r & ")<=1,""OK"",IF(F" & r & "<0,""LESS IN YOURS - POST IT"",""MORE IN YOURS""))"
            End If
        Next k
    Next i
    dN = r
    If dN >= d0 Then
        ws.Range(ws.Cells(d0, 4), ws.Cells(dN, 6)).NumberFormat = "#,##0"
        StatusColours ws.Range(ws.Cells(d0, 7), ws.Cells(dN, 7))
    End If

    ' ---- DEF bills against your Urea DEF sheet (live) ----
    Dim e0 As Long, eN As Long: e0 = 0: eN = -1
    If hasU Then
        r = r + 2
        Section ws, r, "DEF / ADBLUE - SSFC's bills (fixed) against refills bought from SSFC in your " & uName & " sheet, same vehicle, 3 days either side (live)"
        r = r + 1
        ws.Cells(r, 1).Resize(1, 8).Value = Array("Vehicle", "Bill date", "What (as SSFC wrote it)", "SSFC Rs", "Your SSFC refills those days", "Their Rs", "To claim", "Status")
        Hdr ws.Range(ws.Cells(r, 1), ws.Cells(r, 8))
        e0 = r + 1
        Dim win As String
        For i = 1 To nB
            If B(i).isDef And B(i).amount > 0 Then
                r = r + 1
                ws.Cells(r, 1).Resize(1, 4).Value = Array(B(i).veh, IIf(B(i).dt > 0, B(i).dt, ""), B(i).desc, B(i).amount)
                ws.Cells(r, 2).NumberFormat = "dd-mmm-yy"
                If B(i).dt > 0 Then
                    win = uV & ",$A" & r & "," & uD & ","">=""&($B" & r & "-3)," & uD & ",""<=""&($B" & r & "+3)," & uF & ","
                    ws.Cells(r, 5).Formula = "=COUNTIFS(" & win & """*FREIGHT*"")+COUNTIFS(" & win & """*SSFC*"")-COUNTIFS(" & win & """*SSFC*FREIGHT*"")"
                    ws.Cells(r, 6).Formula = "=SUMIFS(" & uA & "," & win & """*FREIGHT*"")+SUMIFS(" & uA & "," & win & """*SSFC*"")-SUMIFS(" & uA & "," & win & """*SSFC*FREIGHT*"")"
                    ws.Cells(r, 7).Formula = "=IF(E" & r & "=0,D" & r & ",IF(AND(E" & r & "=1,D" & r & "-F" & r & ">1),D" & r & "-F" & r & ",0))"
                    ws.Cells(r, 8).Formula = "=IF(E" & r & "=0,""NO REFILL OF YOURS FROM SSFC"",IF(AND(E" & r & "=1,D" & r & "-F" & r & ">1),""SSFC CHARGED MORE"",""OK""))"
                Else
                    ws.Cells(r, 7).Value = 0
                    ws.Cells(r, 8).Value = "NO DATE ON THE BILL - check by hand"
                End If
            End If
        Next i
        eN = r
        If eN >= e0 Then
            ws.Range(ws.Cells(e0, 4), ws.Cells(eN, 7)).NumberFormat = "#,##0"
            StatusColours ws.Range(ws.Cells(e0, 8), ws.Cells(eN, 8))
            ClaimColours ws.Range(ws.Cells(e0, 7), ws.Cells(eN, 7))
        Else
            r = r + 1: ws.Cells(r, 1).Value = "No DEF bill in this statement."
        End If
    End If

    ' ---- LD: SSFC's days against your loading / unloading dates (live) ----
    Dim l0 As Long, lN As Long: l0 = 0: lN = -1
    If nL > 0 Then
        r = r + 2
        Section ws, r, "LATE DELIVERY (LD) - SSFC's days (fixed) against your loading / unloading dates (live)"
        r = r + 1
        ws.Cells(r, 1).Resize(1, 11).Value = Array("Vehicle", "Invoice", "SSFC days", "LD Rs", "Register row", "Your loaded", "Your unloaded", "Your days", "Days over", "To claim", "Status")
        Hdr ws.Range(ws.Cells(r, 1), ws.Cells(r, 11))
        l0 = r + 1
        For i = 1 To nL
            If L(i).amount > 0 Then
                r = r + 1
                ws.Cells(r, 1).Resize(1, 4).Value = Array(L(i).veh, IIf(L(i).inv > 0, L(i).inv, ""), L(i).days, L(i).amount)
                If L(i).trRow > 0 Then
                    ws.Cells(r, 5).Value = L(i).trRow
                    ws.Cells(r, 6).Formula = "=" & TRCell(cLoadDate, L(i).trRow)
                    ws.Cells(r, 7).Formula = "=" & TRCell(cUnloadDate, L(i).trRow)
                    ws.Cells(r, 8).Formula = "=IF(AND(N(F" & r & ")>0,N(G" & r & ")>0),G" & r & "-F" & r & ","""")"
                    ws.Cells(r, 9).Formula = "=IF(H" & r & "="""",0,MAX(0,C" & r & "-H" & r & "))"
                    ws.Cells(r, 10).Formula = "=IF(N(C" & r & ")>0,ROUND(D" & r & "/C" & r & "*I" & r & ",2),0)"
                    ws.Cells(r, 11).Formula = "=IF(H" & r & "="""",""YOUR DATES MISSING"",IF(I" & r & ">0,""SSFC COUNTS MORE DAYS"",""OK""))"
                Else
                    ws.Cells(r, 10).Value = 0
                    ws.Cells(r, 11).Value = "NO TRIP OF YOURS NEAR THE INVOICE DATE"
                End If
                ws.Range(ws.Cells(r, 2), ws.Cells(r, 2)).NumberFormat = "dd-mmm-yy"
                ws.Range(ws.Cells(r, 6), ws.Cells(r, 7)).NumberFormat = "dd-mmm-yy"
            End If
        Next i
        lN = r
        If lN >= l0 Then
            StatusColours ws.Range(ws.Cells(l0, 11), ws.Cells(lN, 11))
            ClaimColours ws.Range(ws.Cells(l0, 10), ws.Cells(lN, 10))
        End If
    End If

    ' ---- from SSFC's statement alone (fixed: their arithmetic, EMI, new labels, RTO entry, bills) ----
    Dim fixedClaim As Double, nFixedCheck As Long
    r = r + 2
    Section ws, r, "FROM SSFC's STATEMENT ITSELF (fixed - these don't depend on your books)"
    r = r + 1
    ws.Cells(r, 1).Resize(1, 5).Value = Array("Level", "Area", "Vehicle", "Rs", "Finding")
    Hdr ws.Range(ws.Cells(r, 1), ws.Cells(r, 5))
    Dim lv As Variant, n As Long
    For Each lv In Array("CLAIM", "CHECK", "NOTE")
        Dim idx() As Long, m As Long: ReDim idx(1 To nF + 1): m = 0
        For i = 1 To nF
            If F(i).level = lv Then m = m + 1: idx(m) = i
        Next i
        SortByAmount idx, m
        For j = 1 To m
            i = idx(j)
            r = r + 1: n = n + 1
            ws.Cells(r, 1).Value = Choose(IIf(lv = "CLAIM", 1, IIf(lv = "CHECK", 2, 3)), "SSFC owes / explain", "Check / proof", "Note")
            ws.Cells(r, 2).Value = F(i).area
            ws.Cells(r, 3).Value = F(i).veh
            If F(i).amount <> 0 Then ws.Cells(r, 4).Value = F(i).amount
            ws.Cells(r, 5).Value = F(i).text
            If lv = "CLAIM" Then
                fixedClaim = fixedClaim + F(i).amount
                ws.Range(ws.Cells(r, 1), ws.Cells(r, 5)).Interior.Color = RGB(253, 226, 222)
            ElseIf lv = "CHECK" Then
                nFixedCheck = nFixedCheck + 1
                ws.Range(ws.Cells(r, 1), ws.Cells(r, 5)).Interior.Color = RGB(255, 242, 204)
            Else
                ws.Range(ws.Cells(r, 1), ws.Cells(r, 5)).Font.Color = RGB(110, 110, 110)
            End If
        Next j
    Next lv
    If n = 0 Then r = r + 1: ws.Cells(r, 1).Value = "Nothing - their arithmetic, deductions and bills add up.": ws.Cells(r, 1).Font.Color = RGB(0, 128, 0)

    ' ---- each deduction line and each bill, as SSFC wrote them ----
    r = r + 2
    Section ws, r, "DEDUCTIONS (as SSFC wrote them)"
    r = r + 1
    ws.Cells(r, 1).Resize(1, 5).Value = Array("Vehicle", "SSFC's label", "Read as", "Posted to", "Rs")
    Hdr ws.Range(ws.Cells(r, 1), ws.Cells(r, 5))
    For i = 1 To nD
        r = r + 1
        ws.Cells(r, 1).Resize(1, 5).Value = Array(D(i).veh, D(i).label, KindName(D(i).kind), IIf(D(i).col = "", "not posted", D(i).col), D(i).amount)
        If D(i).col = "" Then ws.Cells(r, 4).Font.Color = RGB(192, 0, 0)
    Next i
    If nB > 0 Then
        r = r + 2
        Section ws, r, "BILLS (SSFC's expense sheet)"
        r = r + 1
        ws.Cells(r, 1).Resize(1, 7).Value = Array("Vehicle", "Date", "What (as SSFC wrote it)", "Head", "Read as", "Rs", "DEF")
        Hdr ws.Range(ws.Cells(r, 1), ws.Cells(r, 7))
        For i = 1 To nB
            r = r + 1
            With B(i)
                ws.Cells(r, 1).Resize(1, 7).Value = Array(.veh, IIf(.dt > 0, .dt, ""), .desc, .cat, KindName(.kind), .amount, IIf(.isDef, "DEF", ""))
                ws.Cells(r, 2).NumberFormat = "dd-mmm-yy"
            End With
        Next i
    End If

    ' ---- the summary on top (live) ----
    Dim fr As Double, ds As Double, co As Double, dd As Double, netSum As Double
    For i = 1 To nT
        fr = fr + T(i).loadWt * T(i).rate: ds = ds + T(i).diesel: co = co + T(i).cashOffice
    Next i
    For i = 1 To nD
        dd = dd + D(i).amount
    Next i
    For i = 1 To nV
        netSum = netSum + V(i).net
    Next i
    ws.Range("A4").Resize(1, 12).Value = Array("To claim from SSFC", "Trips to check", "Vehicles to check", "Deduction heads to check", "DEF bills to check", "Statement findings to check", _
        "Trips", "Freight", "Diesel", "Cash office", "Deductions", "SSFC net")
    Hdr ws.Range("A4:L4")
    fx = "=" & Trim(Str(Round(fixedClaim, 2)))
    If tN >= t0 Then fx = fx & "+SUM(AA" & t0 & ":AA" & tN & ")"
    If eN >= e0 And e0 > 0 Then fx = fx & "+SUM(G" & e0 & ":G" & eN & ")"
    If lN >= l0 And l0 > 0 Then fx = fx & "+SUM(J" & l0 & ":J" & lN & ")"
    ws.Range("A5").Formula = fx
    ws.Range("B5").Formula = IIf(tN >= t0, "=COUNTIF(AB" & t0 & ":AB" & tN & ",""<>OK"")+" & (uN - u0 + 1), "=" & (uN - u0 + 1))
    ws.Range("C5").Formula = IIf(vN >= v0, "=COUNTIF(J" & v0 & ":J" & vN & ",""<>OK"")", "=0")
    ws.Range("D5").Formula = IIf(dN >= d0, "=COUNTIF(G" & d0 & ":G" & dN & ",""<>OK"")", "=0")
    ws.Range("E5").Formula = IIf(eN >= e0 And e0 > 0, "=COUNTIF(H" & e0 & ":H" & eN & ",""<>OK"")", "=0")
    ws.Range("F5").Value = nFixedCheck
    ws.Range("G5").Resize(1, 6).Value = Array(nT, fr, ds, co, dd, netSum)
    ws.Range("A5:L5").Font.Bold = True
    ws.Range("A5").NumberFormat = "#,##0": ws.Range("H5:L5").NumberFormat = "#,##0"
    ClaimColours ws.Range("A5")

    ws.Columns("A:AB").AutoFit
    ws.Columns("E").ColumnWidth = 22
    ws.Columns("AB").ColumnWidth = 60
    ws.Range("A1:A3").WrapText = False
End Sub

Private Sub Section(ws As Worksheet, ByVal r As Long, ByVal title As String)
    ws.Cells(r, 1).Value = title
    ws.Cells(r, 1).Font.Bold = True
    ws.Cells(r, 1).Font.Size = 12
End Sub

' a status column: OK green, anything else amber
Private Sub StatusColours(rg As Range)
    On Error Resume Next                 ' colours only: never stop a run over them
    With rg.FormatConditions.Add(Type:=xlCellValue, Operator:=xlEqual, Formula1:="=""OK""")
        .Font.Color = RGB(0, 128, 0)
    End With
    With rg.FormatConditions.Add(Type:=xlCellValue, Operator:=xlNotEqual, Formula1:="=""OK""")
        .Interior.Color = RGB(255, 242, 204)
    End With
End Sub

' a "to claim" column: red when there is something to claim
Private Sub ClaimColours(rg As Range)
    On Error Resume Next                 ' colours only: never stop a run over them
    With rg.FormatConditions.Add(Type:=xlCellValue, Operator:=xlGreater, Formula1:="=0.5")
        .Font.Color = RGB(192, 0, 0)
        .Font.Bold = True
    End With
End Sub

' a whole column of another sheet, found by its heading in row 1: "'HSD Data'!$J:$J" ("" if not there)
Private Function ColRef(ByVal sheetName As String, ByVal keys As String) As String
    Dim ws As Worksheet, k As Long, key As String
    On Error Resume Next
    Set ws = ThisWorkbook.Worksheets(sheetName)
    On Error GoTo 0
    If ws Is Nothing Then Exit Function
    For k = 1 To 40
        key = KeyOf(ws.Cells(1, k).Value)
        If key <> "" And InStr("|" & keys & "|", "|" & key & "|") > 0 Then
            ColRef = "'" & ws.Name & "'!$" & ColLetter(k) & ":$" & ColLetter(k)
            Exit Function
        End If
    Next k
End Function

Private Function TRCol(ByVal c As Long) As String
    TRCol = "'" & TR_SHEET & "'!$" & ColLetter(c) & ":$" & ColLetter(c)
End Function

Private Function TRCell(ByVal c As Long, ByVal r As Long) As String
    TRCell = "'" & TR_SHEET & "'!$" & ColLetter(c) & "$" & r
End Function

' a posting column letter -> the Trip Register column it is (AA is the SSFC Misc column, wherever it is)
Private Function ColOfLetter(ByVal letter As String) As Long
    If UCase(letter) = "AA" Then ColOfLetter = cAA Else ColOfLetter = ColNumFromLetter(letter)
End Function

Private Sub Hdr(rg As Range)
    rg.Font.Bold = True
    rg.Interior.Color = RGB(244, 81, 30)
    rg.Font.Color = RGB(255, 255, 255)
End Sub

'==================================================================
'  BACKUP / RESTORE  (Y, AA and AD:AK of the month's rows)
'==================================================================
Private Sub BackupRows(wsTR As Worksheet, monthRows As Collection)
    Dim ws As Worksheet
    On Error Resume Next
    Set ws = ThisWorkbook.Worksheets(BAK_SHEET)
    On Error GoTo 0
    If ws Is Nothing Then
        Set ws = ThisWorkbook.Worksheets.Add(After:=ThisWorkbook.Worksheets(ThisWorkbook.Worksheets.Count))
        ws.Name = BAK_SHEET
    Else
        ws.Cells.Clear
    End If
    ws.Range("A1").Value = "Backup of " & Format(gMonth, "mmm yyyy") & " taken " & Format(Now, "dd-mmm-yy hh:mm") & " (v9)"
    ws.Range("A2:L2").Value = Array("TRrow", "Y", "AD", "AE", "AF", "AG", "AH", "AI", "AJ", "AK", "MonthSerial", "AA")
    Dim rowB As Long, rw As Variant, cc As Long
    rowB = 3
    For Each rw In monthRows
        ws.Cells(rowB, 1).Value = CLng(rw)
        ws.Cells(rowB, 2).Value = wsTR.Cells(rw, cY).Value
        For cc = 0 To 7
            ws.Cells(rowB, 3 + cc).Value = wsTR.Cells(rw, cAD + cc).Value
        Next cc
        ws.Cells(rowB, 11).Value = CLng(gMonth)
        ws.Cells(rowB, 12).Value = wsTR.Cells(rw, cAA).Value
        rowB = rowB + 1
    Next rw
    ' matched trips outside the month (Y is posted on them too)
    Dim i As Long, inMonth As Boolean
    For i = 1 To nT
        If T(i).trRow > 0 Then
            inMonth = False
            For Each rw In monthRows
                If CLng(rw) = T(i).trRow Then inMonth = True: Exit For
            Next rw
            If Not inMonth Then
                ws.Cells(rowB, 1).Value = T(i).trRow
                ws.Cells(rowB, 2).Value = wsTR.Cells(T(i).trRow, cY).Value
                For cc = 0 To 7
                    ws.Cells(rowB, 3 + cc).Value = wsTR.Cells(T(i).trRow, cAD + cc).Value
                Next cc
                ws.Cells(rowB, 11).Value = CLng(gMonth)
                ws.Cells(rowB, 12).Value = wsTR.Cells(T(i).trRow, cAA).Value
                rowB = rowB + 1
            End If
        End If
    Next i
End Sub

Sub RestoreLastRun()
    Dim wsTR As Worksheet, ws As Worksheet
    On Error Resume Next
    Set wsTR = ThisWorkbook.Worksheets(TR_SHEET)
    Set ws = ThisWorkbook.Worksheets(BAK_SHEET)
    On Error GoTo 0
    If ws Is Nothing Or wsTR Is Nothing Then MsgBox "No backup found.", vbExclamation: Exit Sub
    If MsgBox("Restore the Trip Register to the backup?" & vbLf & ws.Range("A1").Value, vbYesNo + vbQuestion, "Restore") <> vbYes Then Exit Sub
    FindRegisterColumns wsTR
    Dim last As Long, r As Long, rw As Long, cc As Long, hasAA As Boolean
    hasAA = (UCase(Trim(CStr(ws.Range("L2").Value))) = "AA")
    last = ws.Cells(ws.Rows.Count, 1).End(xlUp).Row
    Application.Calculation = xlCalculationManual
    ' a trip row backed up twice keeps its first (older) values
    For r = last To 3 Step -1
        rw = CLng(ws.Cells(r, 1).Value)
        If rw > TR_HDR_ROWS Then
            wsTR.Cells(rw, cY).Value = ws.Cells(r, 2).Value
            For cc = 0 To 7
                wsTR.Cells(rw, cAD + cc).Value = ws.Cells(r, 3 + cc).Value
            Next cc
            If hasAA Then wsTR.Cells(rw, cAA).Value = ws.Cells(r, 12).Value
        End If
    Next r
    Application.Calculation = xlCalculationAutomatic
    Application.Calculate
    MsgBox "Restored " & (last - 2) & " rows.", vbInformation
End Sub

'==================================================================
'  CONFIG (optional keyword -> column overrides)
'==================================================================
Private Sub EnsureConfig()
    Dim ws As Worksheet
    On Error Resume Next
    Set ws = ThisWorkbook.Worksheets(CFG_SHEET)
    On Error GoTo 0
    If Not ws Is Nothing Then Exit Sub
    Set ws = ThisWorkbook.Worksheets.Add(After:=ThisWorkbook.Worksheets(ThisWorkbook.Worksheets.Count))
    ws.Name = CFG_SHEET
    ws.Range("A1:C1").Value = Array("Keyword (contains)", "Post To", "Description")
    ws.Range("A1:C1").Font.Bold = True
    ws.Range("E1").Value = "Optional. The macro reads SSFC's labels itself (fastag, maint., tyre, over/unload, RTO entry / challan, shortage, documents);"
    ws.Range("E2").Value = "anything else goes to AA SSFC Misc and is listed to check. Add a keyword here only to send a label somewhere else (or SKIP it)."
    ws.Columns("A:C").AutoFit
End Sub

Private Function LoadMap() As Collection
    Dim ws As Worksheet, c As New Collection, r As Long, last As Long
    Set ws = ThisWorkbook.Worksheets(CFG_SHEET)
    last = ws.Cells(ws.Rows.Count, 1).End(xlUp).Row
    For r = 2 To last
        If Trim(CStr(ws.Cells(r, 1).Value)) <> "" Then
            c.Add Array(UCase(Trim(CStr(ws.Cells(r, 1).Value))), UCase(Trim(CStr(ws.Cells(r, 2).Value))))
        End If
    Next r
    Set LoadMap = c
End Function

Private Function ResolveLabel(ByVal lab As String, gMap As Collection) As String
    Dim e As Variant
    For Each e In gMap
        If InStr(lab, e(0)) > 0 Then ResolveLabel = e(1): Exit Function
    Next e
End Function

'==================================================================
'  WHAT A LABEL / A BILL IS
'==================================================================
Private Function KindOf(ByVal label As String) As String
    Dim s As String: s = " " & AlnumOnly(UCase(label)) & " "
    If Trim(s) = "" Then Exit Function
    If InStr(s, " NET ") > 0 Then KindOf = "net": Exit Function
    If InStr(s, " TOTAL ") > 0 Then KindOf = "total": Exit Function
    Dim rto As Boolean: rto = (InStr(s, "RTO") > 0 Or InStr(s, "R T O") > 0)
    If rto And (InStr(s, "CHAL") > 0 Or InStr(s, "FINE") > 0) Then KindOf = "rtoChallan": Exit Function
    If rto And (InStr(s, "ENT") > 0 Or InStr(s, "TAX") > 0 Or InStr(s, "PERMIT") > 0) Then KindOf = "rtoEntry": Exit Function
    If rto Then KindOf = "rtoChallan": Exit Function
    If InStr(s, "FAST") > 0 Or InStr(s, "TOLL") > 0 Then KindOf = "fastag": Exit Function
    If InStr(s, "INSTAL") > 0 Or InStr(s, "INSTL") > 0 Or InStr(s, " EMI ") > 0 Or InStr(s, "LOAN") > 0 Then KindOf = "emi": Exit Function
    If InStr(s, "TYRE") > 0 Or InStr(s, "TIRE") > 0 Or InStr(s, "TYER") > 0 Then KindOf = "tyre": Exit Function
    If InStr(s, "OVER") > 0 Or InStr(s, "UNLOAD") > 0 Or InStr(s, "OVLD") > 0 Then KindOf = "lessOver": Exit Function
    If InStr(s, "DOC") > 0 Then KindOf = "docExp": Exit Function
    If InStr(s, "UNION") > 0 Then KindOf = "union": Exit Function
    If InStr(s, "GPS") > 0 Then KindOf = "gps": Exit Function
    If InStr(s, "SHORT") > 0 Then KindOf = "shortage": Exit Function
    If InStr(s, " LD ") > 0 Or InStr(s, " L D ") > 0 Or InStr(s, "LATE") > 0 Or InStr(s, "DELAY") > 0 Or InStr(s, "DETENTION") > 0 Then KindOf = "ld": Exit Function
    If InStr(s, "PENAL") > 0 Or InStr(s, "FINE") > 0 Then KindOf = "penalty": Exit Function
    If InStr(s, "FOOD") > 0 Or InStr(s, "KHANA") > 0 Or InStr(s, "MEAL") > 0 Then KindOf = "fooding": Exit Function
    If InStr(s, "MAINT") > 0 Or InStr(s, "MANT") > 0 Or InStr(s, "REPAIR") > 0 Or InStr(s, "DEEP") > 0 Or InStr(s, "SERVICE") > 0 Or InStr(s, "WORKSHOP") > 0 Then KindOf = "maint": Exit Function
    KindOf = "other"
End Function

Private Function ColOfKind(ByVal kind As String) As String
    Select Case kind
        Case "fastag": ColOfKind = "AD"
        Case "maint": ColOfKind = "AE"
        Case "tyre": ColOfKind = "AF"
        Case "lessOver": ColOfKind = "AG"
        Case "rtoEntry": ColOfKind = "AH"
        Case "rtoChallan": ColOfKind = "AI"
        Case "shortage": ColOfKind = "AJ"
        Case "docExp": ColOfKind = "AK"
        Case "emi": ColOfKind = ""
        Case Else: ColOfKind = "AA"          ' union, GPS, fooding, LD, penalty, a new label
    End Select
End Function

Private Function KindName(ByVal kind As String) As String
    Select Case kind
        Case "fastag": KindName = "Fastag"
        Case "maint": KindName = "Maintenance"
        Case "tyre": KindName = "Tyre"
        Case "lessOver": KindName = "Over / unload"
        Case "rtoEntry": KindName = "RTO entry"
        Case "rtoChallan": KindName = "RTO challan"
        Case "shortage": KindName = "Shortage"
        Case "docExp": KindName = "Document exp."
        Case "emi": KindName = "Instalment (EMI)"
        Case "union": KindName = "Union"
        Case "gps": KindName = "GPS"
        Case "fooding": KindName = "Driver fooding"
        Case "ld": KindName = "Late delivery (LD)"
        Case "penalty": KindName = "Penalty"
        Case Else: KindName = "Other"
    End Select
End Function

' DEF / AdBlue / urea, however it's spelt
Private Function IsDef(ByVal s As String) As Boolean
    Dim u As String: u = " " & AlnumOnly(UCase(s)) & " "
    Dim nos As String: nos = Replace(u, " ", "")
    IsDef = InStr(nos, "ADBLUE") > 0 Or InStr(nos, "ABLUE") > 0 Or InStr(u, "UREA") > 0 Or InStr(u, "URIA") > 0 Or InStr(u, "URIYA") > 0 _
         Or InStr(u, "YURIA") > 0 Or InStr(u, " DEF ") > 0 Or InStr(nos, "CLEARBLUE") > 0 Or InStr(nos, "CLEARLUE") > 0
End Function

Private Function IsFromSsfc(ByVal frm As String) As Boolean
    Dim n As String: n = Replace(Replace(UCase(frm), ".", ""), " ", "")
    IsFromSsfc = InStr(n, "SSFREIGHT") > 0 Or InStr(n, "SSFC") > 0
End Function

Private Function IsCat(ByVal s As String) As Boolean
    Dim u As String: u = UCase(Trim(s))
    If Len(u) > 16 Or u = "" Then Exit Function
    IsCat = Left(u, 5) = "MAINT" Or Left(u, 4) = "TYRE" Or Left(u, 4) = "TIRE" Or Left(u, 5) = "OVERL" Or Left(u, 9) = "OVER LOAD" Or Left(u, 3) = "RTO" _
         Or Left(u, 3) = "DRI" Or Left(u, 4) = "FOOD" Or Left(u, 3) = "DOC" Or Left(u, 3) = "GPS" Or Left(u, 4) = "FAST" Or Left(u, 4) = "DEEP" _
         Or Left(u, 5) = "OTHER" Or Left(u, 5) = "SHORT" Or Left(u, 5) = "UNION" Or Left(u, 2) = "LD" Or Left(u, 5) = "PENAL"
End Function

' the other vehicles a bill names: "XX01AB1001,1002 & 1003 DEF" -> XX01AB1002, XX01AB1003
Private Function OtherVehicles(ByVal desc As String, ByVal veh As String) As String
    Dim u As String: u = UCase(desc)
    If Len(veh) < 5 Then Exit Function
    Dim pre As String: pre = Left(veh, Len(veh) - 4)
    Dim p As Long: p = InStr(Replace(u, " ", ""), pre)
    If p = 0 Then Exit Function
    Dim tail As String: tail = Mid(Replace(u, " ", ""), p + Len(pre) + 4)
    Dim i As Long, num As String, out As String, ch As String
    For i = 1 To Len(tail) + 1
        If i <= Len(tail) Then ch = Mid(tail, i, 1) Else ch = " "
        If ch >= "0" And ch <= "9" Then
            num = num & ch
        Else
            If Len(num) = 4 Then
                If pre & num <> veh Then out = out & IIf(out = "", "", ", ") & num
            End If
            num = ""
            If Not (ch = "," Or ch = "&" Or ch = "/" Or ch = "A" Or ch = "N" Or ch = "D") Then Exit For
        End If
    Next i
    OtherVehicles = out
End Function

'==================================================================
'  DATES
'==================================================================
' y / m / d of a cell as typed: a date, a serial, "11/12/25", "08.11.25", "5-Sep-2026"
Private Function SplitDate(v As Variant, ByRef y As Long, ByRef m As Long, ByRef d As Long) As Boolean
    On Error GoTo No
    If IsEmpty(v) Then Exit Function
    If VarType(v) = vbDate Then
        y = Year(v): m = Month(v): d = Day(v): SplitDate = True: Exit Function
    End If
    If VarType(v) <> vbString Then
        If IsNumeric(v) Then
            If CDbl(v) > 20000 And CDbl(v) < 80000 Then
                Dim dt As Date: dt = CDate(CDbl(v))
                y = Year(dt): m = Month(dt): d = Day(dt): SplitDate = True
            End If
        End If
        Exit Function
    End If
    Dim s As String: s = UCase(Trim(CStr(v)))
    s = Replace(Replace(Replace(s, ".", "/"), "-", "/"), " ", "/")
    Do While InStr(s, "//") > 0: s = Replace(s, "//", "/"): Loop
    Dim p() As String: p = Split(s, "/")
    If UBound(p) <> 2 Then Exit Function
    If Not IsNumeric(p(0)) Or Not IsNumeric(p(2)) Then Exit Function
    d = CLng(p(0))
    If IsNumeric(p(1)) Then
        m = CLng(p(1))
    Else
        m = MonthOfWord(p(1))
        If m = 0 Then Exit Function
    End If
    y = CLng(p(2))
    If y < 100 Then y = 2000 + y
    SplitDate = True
    Exit Function
No:
    SplitDate = False
End Function

Private Function ValidDate(ByVal y As Long, ByVal m As Long, ByVal d As Long) As Date
    If m < 1 Or m > 12 Or d < 1 Or d > 31 Or y < 2000 Or y > 2100 Then Exit Function
    Dim dt As Date: dt = DateSerial(y, m, d)
    If Day(dt) = d Then ValidDate = dt
End Function

Private Function MonthsApart(ByVal a As Date, ByVal b As Date) As Long
    MonthsApart = Abs((Year(a) * 12 + Month(a)) - (Year(b) * 12 + Month(b)))
End Function

' a date read against the statement month: as typed, else day/month swapped, else the year fixed
Private Function DateNear(ByVal v As Variant, ByVal mon As Date) As Date
    Dim y As Long, m As Long, d As Long, a As Date
    If Not SplitDate(v, y, m, d) Then Exit Function
    a = ValidDate(y, m, d)
    If mon = 0 Then DateNear = a: Exit Function
    If a > 0 Then
        If MonthsApart(a, mon) <= 1 Then DateNear = a: Exit Function
    End If
    a = ValidDate(y, d, m)
    If a > 0 Then
        If MonthsApart(a, mon) <= 1 Then DateNear = a: Exit Function
    End If
    Dim yy As Variant
    For Each yy In Array(Year(mon), Year(mon) - 1, Year(mon) + 1)
        a = ValidDate(CLng(yy), m, d)
        If a > 0 Then
            If MonthsApart(a, mon) <= 1 Then DateNear = a: Exit Function
        End If
        a = ValidDate(CLng(yy), d, m)
        If a > 0 Then
            If MonthsApart(a, mon) <= 1 Then DateNear = a: Exit Function
        End If
    Next yy
    DateNear = ValidDate(y, m, d)
End Function

Private Function SwapOf(ByVal dt As Date) As Date
    If Day(dt) > 12 Or Day(dt) = Month(dt) Then Exit Function
    SwapOf = ValidDate(Year(dt), Day(dt), Month(dt))
End Function

Private Function SwapNear(ByVal dt As Date, ByVal mon As Date) As Date
    SwapNear = dt
    If MonthsApart(dt, mon) > 1 And SwapOf(dt) > 0 Then
        If MonthsApart(SwapOf(dt), mon) <= 1 Then SwapNear = SwapOf(dt)
    End If
End Function

' a trip's loading and unloading dates read together: the reading where it unloads 0-20 days after loading
Private Sub TripDates(rawL As Variant, rawU As Variant, ByRef ld As Date, ByRef ud As Date, ByRef fixed As Boolean)
    Dim l0 As Date, u0 As Date
    l0 = DateNear(rawL, gMonth): u0 = DateNear(rawU, gMonth)
    ld = l0: ud = u0: fixed = False
    Dim y As Long, m As Long, d As Long
    If SplitDate(rawL, y, m, d) Then
        If l0 > 0 And ValidDate(y, m, d) <> l0 Then fixed = True
    End If
    If l0 = 0 Or u0 = 0 Then Exit Sub
    Dim cands(1 To 2, 1 To 2) As Date, i As Long, j As Long, best As Double, sc As Double, g As Double
    cands(1, 1) = l0: cands(1, 2) = SwapOf(l0)
    cands(2, 1) = u0: cands(2, 2) = SwapOf(u0)
    g = u0 - l0
    If g >= 0 And g <= 20 Then best = g Else best = 1000 + Abs(g)
    For i = 1 To 2
        For j = 1 To 2
            If cands(1, i) > 0 And cands(2, j) > 0 Then
                g = cands(2, j) - cands(1, i)
                If g >= 0 And g <= 20 Then sc = g Else sc = 1000 + Abs(g)
                sc = sc + IIf(i = 2, 0.5, 0) + IIf(j = 2, 0.5, 0)
                If sc < best Then best = sc: ld = cands(1, i): ud = cands(2, j): fixed = fixed Or i = 2
            End If
        Next j
    Next i
End Sub

Private Function DayGap(ByVal v As Variant, ByVal dt As Date) As Double
    Dim a As Date: a = CDateOr0(v)
    If a = 0 Or dt = 0 Then DayGap = 99 Else DayGap = Abs(a - dt)
End Function

Private Function CDateOr0(ByVal v As Variant) As Date
    On Error Resume Next
    If VarType(v) = vbDate Then
        CDateOr0 = v
    ElseIf IsNumeric(v) And VarType(v) <> vbString Then
        If CDbl(v) > 20000 And CDbl(v) < 80000 Then CDateOr0 = CDate(CDbl(v))
    End If
End Function

Private Function LooksDate(ByVal v As Variant) As Boolean
    Dim y As Long, m As Long, d As Long
    If VarType(v) = vbDate Then LooksDate = True: Exit Function
    If VarType(v) = vbString Then LooksDate = SplitDate(v, y, m, d)
    If IsNumeric(v) And VarType(v) <> vbString Then LooksDate = (CDbl(v) > 40000 And CDbl(v) < 80000)
End Function

Private Function MonthOfWord(ByVal w As String) As Long
    Dim m As Variant, i As Long
    m = Array("JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC")
    For i = 0 To 11
        If Left(UCase(w), 3) = m(i) Then MonthOfWord = i + 1: Exit Function
    Next i
End Function

' "SHREE SHYAM LOGISTIC SEP- 2026", "June 2026 SSL Accounts.xlsx", "JAN -26" -> first of that month
Private Function MonthOfText(ByVal s As String) As Date
    Dim u As String: u = " " & AlnumOnly(UCase(s)) & " "
    Dim m As Variant, i As Long, p As Long, rest As String, y As Long, k As Long
    m = Array("JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC")
    For i = 0 To 11
        p = InStr(u, " " & m(i))
        If p > 0 Then
            rest = Mid(u, p + 4)
            ' skip the rest of the month's word
            Do While Len(rest) > 0 And Left(rest, 1) >= "A" And Left(rest, 1) <= "Z": rest = Mid(rest, 2): Loop
            rest = LTrim(rest)
            y = 0
            For k = 1 To Len(rest)
                If Mid(rest, k, 1) < "0" Or Mid(rest, k, 1) > "9" Then Exit For
            Next k
            If k - 1 = 4 Then
                y = CLng(Left(rest, 4))
            ElseIf k - 1 = 2 Then
                y = 2000 + CLng(Left(rest, 2))
            End If
            If y > 2000 And y < 2100 Then MonthOfText = DateSerial(y, i + 1, 1): Exit Function
        End If
    Next i
End Function

Private Function DominantMonth() As Date
    Dim c As SDict: Set c = New SDict
    Dim i As Long, y As Long, m As Long, d As Long, a As Date, key As Variant, best As Long
    For i = 1 To nT
        If SplitDate(T(i).rawLoad, y, m, d) Then
            a = ValidDate(y, m, d)
            If a > 0 Then c.SetItem CLng(DateSerial(Year(a), Month(a), 1)), NZd(c.Item(CLng(DateSerial(Year(a), Month(a), 1)))) + 1
        End If
    Next i
    For Each key In c.Keys
        If c.Item(key) > best Then best = c.Item(key): DominantMonth = CDate(CLng(key))
    Next key
End Function

Private Function MonthOfCell(ByVal mv As Variant, ByVal ld As Variant) As Date
    Dim a As Date: a = CDateOr0(mv)
    If a = 0 Then a = CDateOr0(ld)
    If a > 0 Then MonthOfCell = DateSerial(Year(a), Month(a), 1)
End Function

'==================================================================
'  SMALL HELPERS
'==================================================================
Private Sub AddFind(ByVal level As String, ByVal area As String, ByVal veh As String, ByVal amount As Double, ByVal text As String)
    nF = nF + 1
    If nF > UBound(F) Then
        ReDim Preserve F(1 To nF * 2)
    End If
    F(nF).level = level: F(nF).area = area: F(nF).veh = veh: F(nF).amount = Round(amount, 2): F(nF).text = text
End Sub

Private Function DedSum(ByVal veh As String, ByVal kind As String) As Double
    Dim i As Long
    For i = 1 To nD
        If D(i).veh = veh And (kind = "" Or D(i).kind = kind) Then DedSum = DedSum + D(i).amount
    Next i
End Function

Private Function VehIndex(ByVal veh As String) As Long
    Dim i As Long
    For i = 1 To nV
        If V(i).veh = veh Then VehIndex = i: Exit Function
    Next i
End Function

Private Function TripsOf(ByVal veh As String) As Long
    Dim i As Long
    For i = 1 To nV
        If V(i).veh = veh Then TripsOf = TripsOf + V(i).nT
    Next i
End Function

' your Rates sheet's route paying this rate (when it isn't the trip's own route)
Private Function OtherRouteOfRate(ByVal rate As Double, ByVal port As String, ByVal dest As String) As String
    Dim ws As Worksheet
    On Error Resume Next
    Set ws = ThisWorkbook.Worksheets("Rates")
    On Error GoTo 0
    If ws Is Nothing Then Exit Function
    Dim r As Long, last As Long
    last = ws.Cells(ws.Rows.Count, 1).End(xlUp).Row
    For r = 2 To last
        If Abs(NZ(ws.Cells(r, 3)) - rate) < 0.5 Then
            If Not (UCase(Trim(CStr(ws.Cells(r, 1).Value))) = UCase(Trim(port)) And UCase(Trim(CStr(ws.Cells(r, 2).Value))) = UCase(Trim(dest))) Then
                OtherRouteOfRate = ws.Cells(r, 1).Value & " -> " & ws.Cells(r, 2).Value: Exit Function
            End If
        End If
    Next r
End Function

' a vehicle no. as kept (XX01AB1001), or "" when it isn't one: 2 letters, 1-2 digits, 0-3 letters, 3-4 digits
Private Function NormVeh(ByVal v As Variant) As String
    If IsEmpty(v) Or IsError(v) Then Exit Function
    If VarType(v) <> vbString Then Exit Function
    Dim s As String: s = UCase(CStr(v))
    s = Replace(Replace(Replace(Replace(s, " ", ""), ".", ""), "-", ""), vbTab, "")
    Dim n As Long, i As Long, st As Long, cnt As Long, ch As String
    n = Len(s)
    If n < 6 Or n > 11 Then Exit Function
    i = 1
    For cnt = 1 To 2
        ch = Mid(s, i, 1): If ch < "A" Or ch > "Z" Then Exit Function
        i = i + 1
    Next cnt
    st = i
    Do While i <= n
        ch = Mid(s, i, 1): If ch < "0" Or ch > "9" Then Exit Do
        i = i + 1
    Loop
    If i - st < 1 Or i - st > 2 Then Exit Function
    st = i
    Do While i <= n
        ch = Mid(s, i, 1): If ch < "A" Or ch > "Z" Then Exit Do
        i = i + 1
    Loop
    If i - st > 3 Then Exit Function
    st = i
    Do While i <= n
        ch = Mid(s, i, 1): If ch < "0" Or ch > "9" Then Exit Do
        i = i + 1
    Loop
    If i - st < 3 Or i - st > 4 Or i <= n Then Exit Function
    NormVeh = s
End Function

Private Function Up(ByVal v As Variant) As String
    If IsError(v) Then Exit Function
    Up = Squeeze(UCase(CStr(v)))
End Function

Private Function Squeeze(ByVal s As String) As String
    s = Replace(Replace(Replace(s, vbLf, " "), vbCr, " "), vbTab, " ")
    Do While InStr(s, "  ") > 0: s = Replace(s, "  ", " "): Loop
    Squeeze = Trim(s)
End Function

Private Function AlnumOnly(ByVal s As String) As String
    Dim i As Long, ch As String, out As String
    For i = 1 To Len(s)
        ch = Mid(s, i, 1)
        If (ch >= "A" And ch <= "Z") Or (ch >= "0" And ch <= "9") Then out = out & ch Else out = out & " "
    Next i
    AlnumOnly = Squeeze(out)
End Function

' a heading as a key: "Price/Ton" -> "priceton", "SSFC Diesel Ltr " -> "ssfcdieselltr"
Private Function KeyOf(ByVal v As Variant) As String
    KeyOf = LCase(Replace(AlnumOnly(UCase(CStr(v))), " ", ""))
End Function

Private Function RowHasWords(a As Variant, r As Long, nC As Long) As Boolean
    Dim c As Long
    For c = 1 To nC
        If VarType(a(r, c)) = vbString Then
            If HasAlpha(CStr(a(r, c))) Then RowHasWords = True: Exit Function
        End If
    Next c
End Function

Private Function HasAlpha(ByVal s As String) As Boolean
    Dim i As Long, ch As String
    For i = 1 To Len(s)
        ch = UCase(Mid(s, i, 1))
        If ch >= "A" And ch <= "Z" Then HasAlpha = True: Exit Function
    Next i
End Function

Private Function Num(ByVal v As Variant) As Double
    On Error Resume Next
    If IsEmpty(v) Or IsError(v) Then Exit Function
    If VarType(v) = vbString Then
        Dim s As String: s = Replace(Replace(Trim(CStr(v)), ",", ""), ChrW(8377), "")
        If IsNumeric(s) And s <> "" Then Num = CDbl(s)
    ElseIf IsNumeric(v) Then
        Num = CDbl(v)
    End If
End Function

Private Function NZ(c As Range) As Double
    NZ = Num(c.Value)
End Function

Private Function NZd(ByVal v As Variant) As Double
    If IsEmpty(v) Then NZd = 0 Else NZd = CDbl(v)
End Function

Private Function Short(ByVal veh As String) As String
    Short = Right(veh, 4)
End Function

Private Function DM(ByVal dt As Date) As String
    If dt = 0 Then DM = "-" Else DM = Format(dt, "d mmm")
End Function

Private Function Rs(ByVal x As Double) As String
    Rs = "Rs " & Format(Round(x, 0), "#,##0")
End Function

Private Sub SortD(a() As Double, n As Long)
    Dim i As Long, j As Long, t As Double
    For i = 2 To n
        t = a(i): j = i - 1
        Do While j >= 1
            If a(j) <= t Then Exit Do
            a(j + 1) = a(j): j = j - 1
        Loop
        a(j + 1) = t
    Next i
End Sub

Private Sub SortByAmount(idx() As Long, n As Long)
    Dim i As Long, j As Long, t As Long
    For i = 2 To n
        t = idx(i): j = i - 1
        Do While j >= 1
            If F(idx(j)).amount >= F(t).amount Then Exit Do
            idx(j + 1) = idx(j): j = j - 1
        Loop
        idx(j + 1) = t
    Next i
End Sub

Private Function ColLetter(ByVal nCol As Long) As String
    Dim s As String
    Do While nCol > 0
        s = Chr(65 + ((nCol - 1) Mod 26)) & s
        nCol = (nCol - 1) \ 26
    Loop
    ColLetter = s
End Function

Private Function ColNumFromLetter(ByVal s As String) As Long
    Dim i As Long, n As Long
    s = UCase(Trim(s))
    If s = "" Then Exit Function
    For i = 1 To Len(s)
        If Mid(s, i, 1) < "A" Or Mid(s, i, 1) > "Z" Then Exit Function
        n = n * 26 + (Asc(Mid(s, i, 1)) - 64)
    Next i
    ColNumFromLetter = n
End Function
