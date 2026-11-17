Attribute VB_Name = "SSFCRecon"
Option Explicit

'==================================================================
'  SSFC RECONCILIATION ENGINE  v9  (MAC SAFE)
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
'  Checks and lists in the "SSFC Check" sheet, what SSFC owes you first:
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
    hsdL As Double            ' HSD Data: SSFC's fills tagged to the matched trip
    hsdRs As Double
    hsdN As Long
    regL As Double            ' Trip Register P / Q of the matched trip
    regRs As Double
    dRs As Double             ' SSFC's Rs - yours
    dStatus As String         ' "", more, less, moved, register
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
    paired As Boolean
End Type
Private Type SLd
    veh As String
    inv As Date
    days As Double
    wt As Double
    amount As Double
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
    ch = InputBox("SSFC RECONCILIATION  v9" & vbLf & vbLf & _
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
                 "CANCEL = stop", vbYesNoCancel + vbQuestion, "SSFC v9")
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
    Dim claim As Double, nClaim As Long, nCheck As Long
    For i = 1 To nF
        If F(i).level = "CLAIM" Then claim = claim + F(i).amount: nClaim = nClaim + 1
        If F(i).level = "CHECK" Then nCheck = nCheck + 1
    Next i
    ThisWorkbook.Worksheets(RPT_SHEET).Activate
    MsgBox "Done - " & Format(gMonth, "mmmm yyyy") & IIf(ans = vbYes, " posted and checked.", " checked (nothing posted).") & vbLf & vbLf & _
           "To claim from SSFC: Rs " & Format(claim, "#,##0") & "  (" & nClaim & " findings)" & vbLf & _
           "To check / ask for proof: " & nCheck & vbLf & vbLf & _
           "See the '" & RPT_SHEET & "' sheet.", vbInformation, "SSFC v9"
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
            If nH > UBound(heads) Then ReDim Preserve heads(1 To nH * 2)
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
        Dim gQty(1 To 6) As Long, gRate(1 To 6) As Long, gAmt(1 To 6) As Long, gCash(1 To 6) As Long, nG As Long
        Dim dates(1 To 40) As Long, nDates As Long
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
                If nT > UBound(T) Then ReDim Preserve T(1 To nT * 2)
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
        If nV > UBound(V) Then ReDim Preserve V(1 To nV * 2)
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
                                    If nD > UBound(D) Then ReDim Preserve D(1 To nD * 2)
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
                If nB > UBound(B) Then ReDim Preserve B(1 To nB * 2)
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
                    .paired = False
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
            If nL > UBound(L) Then ReDim Preserve L(1 To nL * 2)
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
                c = ColNumFromLetter(D(i).col)
                If D(i).col = "AA" Then c = cAA
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
    Dim i As Long, j As Long, k As Long, r As Long, dv As Double, s As String
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
            Dim base As Double, ded As Double
            If V(i).hasSub Then base = V(i).subtotal Else base = rowSum
            ded = DedSum(V(i).veh, "")
            dv = Round(base - ded - V(i).net, 2)
            If Abs(dv) > 1 Then AddFind IIf(dv > 0, "CLAIM", "NOTE"), "math", V(i).veh, IIf(dv > 0, dv, 0), Short(V(i).veh) & ": " & Rs(base) & " - deductions " & Rs(ded) & " = " & Rs(base - ded) & ", but SSFC's NET AMOUNT is " & Rs(V(i).net)
        End If
    Next i

    ' ---- trips: paid right, missing, not in the register ----
    Dim nFixed As Long
    For i = 1 To nT
        With T(i)
            If .dateFixed Then nFixed = nFixed + 1
            If .trRow = 0 Then
                AddFind "CHECK", "trip", .veh, 0, Short(.veh) & ": SSFC paid a trip loaded " & DM(.loadDate) & " (" & .loadWt & " T" & IIf(.lr <> "", ", LR " & .lr, "") & ") that isn't in your Trip Register - enter it, or ask SSFC whose trip it is"
            Else
                r = .trRow
                Dim ourRate As Double, ourW As Double, ourU As Double, tripNo As String
                ourRate = NZ(wsTR.Cells(r, cRate)): ourW = NZ(wsTR.Cells(r, cLW)): ourU = NZ(wsTR.Cells(r, cUW))
                tripNo = CStr(wsTR.Cells(r, cTrip).Value)
                If ourRate > 0 And .rate > 0 And Abs(ourRate - .rate) > 0.5 Then
                    dv = Round((ourRate - .rate) * .loadWt, 2)
                    s = OtherRouteOfRate(.rate, CStr(wsTR.Cells(r, cPort).Value), CStr(wsTR.Cells(r, cDest).Value))
                    AddFind IIf(dv > 0, "CLAIM", "NOTE"), "rate", .veh, IIf(dv > 0, dv, 0), Short(.veh) & " " & tripNo & " (" & wsTR.Cells(r, cPort).Value & " -> " & wsTR.Cells(r, cDest).Value & "): SSFC paid Rs " & Format(.rate, "#,##0") & "/T, your rate is Rs " & Format(ourRate, "#,##0") & "/T on " & .loadWt & " T" & IIf(s <> "", " - Rs " & Format(.rate, "#,##0") & " is your " & s & " rate: is the route right?", "")
                End If
                If Abs(ourW - .loadWt) > 0.011 Then
                    dv = Round((ourW - .loadWt) * IIf(.rate > 0, .rate, ourRate), 2)
                    AddFind IIf(dv > 0, "CLAIM", "NOTE"), "trip", .veh, IIf(dv > 0, dv, 0), Short(.veh) & " " & tripNo & ": SSFC paid on " & .loadWt & " T, your register has " & ourW & " T loaded"
                End If
                If .hasUnload And ourU > 0 And .unloadWt < ourU - 0.011 Then
                    AddFind "CHECK", "trip", .veh, 0, Short(.veh) & " " & tripNo & ": SSFC has " & .unloadWt & " T unloaded, your register " & ourU & " T - a shortage SSFC could charge you"
                End If
            End If
        End With
    Next i
    If nFixed > 0 Then AddFind "NOTE", "trip", "", 0, nFixed & " of SSFC's dates were typed month-first or saved day/month swapped - read the right way round"
    ' register trips this month SSFC didn't pay
    Dim rw As Variant, paid As Boolean
    For Each rw In monthRows
        paid = False
        For i = 1 To nT
            If T(i).trRow = CLng(rw) Then paid = True: Exit For
        Next i
        If Not paid And NZ(wsTR.Cells(rw, cLW)) > 0 Then
            AddFind "CHECK", "trip", NormVeh(wsTR.Cells(rw, cVeh).Value), 0, Short(NormVeh(wsTR.Cells(rw, cVeh).Value)) & " " & wsTR.Cells(rw, cTrip).Value & " (loaded " & DM(CDateOr0(wsTR.Cells(rw, cLoadDate).Value)) & ", " & wsTR.Cells(rw, cLW).Value & " T, freight " & Rs(NZ(wsTR.Cells(rw, cBhada))) & ") isn't in this statement - check it is in next month's"
        End If
    Next rw

    ' ---- diesel, trip by trip: SSFC's Rs (fills + cash diesel) on each trip against the fills from
    '      SSFC tagged to that trip in HSD Data (else the register's P / Q). A fill on the next / last
    '      trip shows as one line: the fill to retag.
    Dim wsH As Worksheet
    On Error Resume Next
    Set wsH = ThisWorkbook.Worksheets("HSD Data")
    On Error GoTo 0
    Dim hVeh As Long, hQty As Long, hAmt As Long, hSrc As Long, hTrip As Long, hLast As Long
    Dim hv As Variant, hq As Variant, ha As Variant, hs As Variant, ht As Variant
    If Not wsH Is Nothing Then
        For k = 1 To 30
            Select Case KeyOf(wsH.Cells(1, k).Value)
                Case "vehicle", "vehicleno": If hVeh = 0 Then hVeh = k
                Case "quantity", "qty": If hQty = 0 Then hQty = k
                Case "amount": If hAmt = 0 Then hAmt = k
                Case "roname": If hSrc = 0 Then hSrc = k
                Case "tripid": If hTrip = 0 Then hTrip = k
            End Select
        Next k
        If hVeh > 0 And hQty > 0 And hAmt > 0 And hSrc > 0 And hTrip > 0 Then
            hLast = wsH.Cells(wsH.Rows.Count, hVeh).End(xlUp).Row
            If hLast > 2 Then
                hv = wsH.Range(wsH.Cells(2, hVeh), wsH.Cells(hLast, hVeh)).Value
                hq = wsH.Range(wsH.Cells(2, hQty), wsH.Cells(hLast, hQty)).Value
                ha = wsH.Range(wsH.Cells(2, hAmt), wsH.Cells(hLast, hAmt)).Value
                hs = wsH.Range(wsH.Cells(2, hSrc), wsH.Cells(hLast, hSrc)).Value
                ht = wsH.Range(wsH.Cells(2, hTrip), wsH.Cells(hLast, hTrip)).Value
            Else
                hLast = 0
            End If
        End If
    End If
    For i = 1 To nV
        Dim useHsd As Boolean, tripId As String, tolR As Double, head As String, refName As String
        useHsd = False
        For j = V(i).t0 To V(i).t0 + V(i).nT - 1
            With T(j)
                .hsdL = 0: .hsdRs = 0: .hsdN = 0: .regL = 0: .regRs = 0: .dRs = 0: .dStatus = ""
                If .trRow > 0 Then
                    .regL = NZ(wsTR.Cells(.trRow, cDslL)): .regRs = NZ(wsTR.Cells(.trRow, cDslAmt))
                    tripId = UCase(Trim(CStr(wsTR.Cells(.trRow, cTrip).Value)))
                    If hLast > 0 And tripId <> "" Then
                        For r = 1 To hLast - 1
                            If UCase(Trim(CStr(ht(r, 1)))) = tripId Then
                                If NormVeh(hv(r, 1)) = .veh And InStr(UCase(CStr(hs(r, 1))), "SSFC") > 0 Then
                                    .hsdL = .hsdL + Num(hq(r, 1)): .hsdRs = .hsdRs + Num(ha(r, 1)): .hsdN = .hsdN + 1
                                End If
                            End If
                        Next r
                    End If
                    If .hsdN > 0 Then useHsd = True
                End If
            End With
        Next j
        If useHsd Then refName = "HSD Data" Else refName = "Trip Register"
        Dim prevJ As Long: prevJ = 0
        For j = V(i).t0 To V(i).t0 + V(i).nT - 1
            If T(j).trRow > 0 Then
                If useHsd Then T(j).dRs = Round(T(j).diesel - T(j).hsdRs, 2) Else T(j).dRs = Round(T(j).diesel - T(j).regRs, 2)
                ' a fill on the neighbouring trip: one over, the other under by the same Rs
                If prevJ > 0 Then
                    If DieselOff(prevJ) And DieselOff(j) And T(prevJ).dStatus = "" And Abs(T(prevJ).dRs + T(j).dRs) <= 100 Then
                        Dim inS As Long, inY As Long
                        If T(prevJ).dRs > 0 Then inS = prevJ: inY = j Else inS = j: inY = prevJ
                        T(prevJ).dStatus = "moved": T(j).dStatus = "moved"
                        AddFind "CHECK", "diesel", V(i).veh, 0, Short(V(i).veh) & ": diesel worth " & Rs(Abs(T(j).dRs)) & " is on " & wsTR.Cells(T(inS).trRow, cTrip).Value & " in SSFC's statement but on " & wsTR.Cells(T(inY).trRow, cTrip).Value & " in your " & refName & " - retag the fill; the two trips together agree"
                    End If
                End If
                prevJ = j
            End If
        Next j
        For j = V(i).t0 To V(i).t0 + V(i).nT - 1
            With T(j)
                If .trRow > 0 And .dStatus = "" Then
                    head = Short(.veh) & " " & wsTR.Cells(.trRow, cTrip).Value & " (row " & .trRow & ", loaded " & DM(.loadDate) & ", " & .loadWt & " T): SSFC charged " & Format(.litres, "#,##0") & " L" & IIf(.cash > 0, " + " & Rs(.cash) & " cash diesel", "") & " (" & Rs(.diesel) & "); your " & _
                           IIf(useHsd, "HSD Data has " & Format(.hsdL, "#,##0") & " L (" & Rs(.hsdRs) & ") from SSFC tagged to it", "Trip Register has " & Format(.regL, "#,##0") & " L (" & Rs(.regRs) & ") in SSFC Diesel")
                    If DieselOff(j) Then
                        If .dRs > 0 Then
                            .dStatus = "more"
                            AddFind "CLAIM", "diesel", .veh, .dRs, head & " - " & Rs(.dRs) & " more charged than you have"
                        Else
                            .dStatus = "less"
                            AddFind "CHECK", "diesel", .veh, 0, head & " - " & Rs(-.dRs) & " more in yours than SSFC charged: a fill entered twice or on the wrong trip, or SSFC will charge it later"
                        End If
                    ElseIf useHsd Then
                        tolR = 100: If Abs(.diesel) * 0.002 > tolR Then tolR = Abs(.diesel) * 0.002
                        If Abs(.diesel - .regRs) > tolR Then
                            .dStatus = "register"
                            AddFind "CHECK", "register", .veh, Abs(.diesel - .regRs), Short(.veh) & " " & wsTR.Cells(.trRow, cTrip).Value & " (row " & .trRow & "): your SSFC Diesel is " & Format(.regL, "#,##0") & " L / " & Rs(.regRs) & "; SSFC charged " & Format(.litres, "#,##0") & " L" & IIf(.cash > 0, " + " & Rs(.cash) & " cash diesel", "") & " (" & Rs(.diesel) & ") and your HSD Data agrees - correct " & ColLetter(cDslL) & " / " & ColLetter(cDslAmt) & " on this trip"
                        End If
                    End If
                End If
            End With
        Next j
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
        CheckDef
    End If

    ' ---- LD: SSFC's days against the register's dates ----
    For i = 1 To nL
        If L(i).amount > 0 Then
            Dim bestR As Long, bestG As Double, g2 As Double: bestR = 0: bestG = 1E+30
            For r = TR_HDR_ROWS + 1 To lastRowTR
                If NormVeh(wsTR.Cells(r, cVeh).Value) = L(i).veh And L(i).inv > 0 Then
                    g2 = DayGap(wsTR.Cells(r, cLoadDate).Value, L(i).inv)
                    If g2 <= 7 And (L(i).wt = 0 Or Abs(NZ(wsTR.Cells(r, cLW)) - L(i).wt) < 0.6) And g2 < bestG Then bestG = g2: bestR = r
                End If
            Next r
            Dim ours As Double: ours = -1
            If bestR > 0 Then
                If CDateOr0(wsTR.Cells(bestR, cLoadDate).Value) > 0 And CDateOr0(wsTR.Cells(bestR, cUnloadDate).Value) > 0 Then ours = CDateOr0(wsTR.Cells(bestR, cUnloadDate).Value) - CDateOr0(wsTR.Cells(bestR, cLoadDate).Value)
            End If
            If ours >= 0 And L(i).days > ours And L(i).days > 0 Then
                AddFind "CLAIM", "ld", L(i).veh, Round(L(i).amount / L(i).days * (L(i).days - ours), 2), Short(L(i).veh) & " " & wsTR.Cells(bestR, cTrip).Value & ": LD " & Rs(L(i).amount) & " for " & L(i).days & " days - your register has it loaded " & DM(CDateOr0(wsTR.Cells(bestR, cLoadDate).Value)) & " and unloaded " & DM(CDateOr0(wsTR.Cells(bestR, cUnloadDate).Value)) & ", " & ours & " days"
            Else
                AddFind "NOTE", "ld", L(i).veh, 0, Short(L(i).veh) & ": late-delivery (LD) penalty " & Rs(L(i).amount) & " - " & L(i).days & " days" & IIf(ours >= 0, " (your dates: " & ours & " days)", "")
            End If
        End If
    Next i

    ' ---- after posting: the register's SSFC Net against SSFC's NET AMOUNT ----
    If posted Then
        For i = 1 To nV
            If V(i).hasNet Then
                Dim regNet As Double: regNet = 0
                For Each rw In monthRows
                    If NormVeh(wsTR.Cells(rw, cVeh).Value) = V(i).veh Then regNet = regNet + NZ(wsTR.Cells(rw, cAL))
                Next rw
                If Abs(regNet - V(i).net) > 100 Then AddFind "CHECK", "register", V(i).veh, Abs(regNet - V(i).net), Short(V(i).veh) & ": SSFC's NET AMOUNT is " & Rs(V(i).net) & ", your SSFC Net (" & ColLetter(cAL) & ") for the month adds up to " & Rs(regNet) & " - see the rate / weight / diesel lines above, or a trip in another month"
            End If
        Next i
    End If
End Sub

' DEF: each DEF bill against the Urea DEF sheet's refills bought from SSFC (same vehicle, 3 days)
Private Sub CheckDef()
    Dim ws As Worksheet
    On Error Resume Next
    Set ws = ThisWorkbook.Worksheets("Urea DEF")
    If ws Is Nothing Then Set ws = ThisWorkbook.Worksheets("Urea")
    On Error GoTo 0
    If ws Is Nothing Then Exit Sub
    Dim k As Long, uDate As Long, uVeh As Long, uQty As Long, uAmt As Long, uFrom As Long, last As Long
    For k = 1 To 30
        Select Case KeyOf(ws.Cells(1, k).Value)
            Case "date": If uDate = 0 Then uDate = k
            Case "vehicle", "vehicleno": If uVeh = 0 Then uVeh = k
            Case "quantity", "qty": If uQty = 0 Then uQty = k
            Case "amount": If uAmt = 0 Then uAmt = k
            Case "purchasedfrom": If uFrom = 0 Then uFrom = k
        End Select
    Next k
    If uDate = 0 Or uVeh = 0 Or uFrom = 0 Then Exit Sub
    last = ws.Cells(ws.Rows.Count, uVeh).End(xlUp).Row
    Dim usedU As SDict: Set usedU = New SDict
    Dim i As Long, r As Long, best As Long, bestG As Double, g As Double, frm As String
    Dim diffBy As SDict: Set diffBy = New SDict
    For i = 1 To nB
        If B(i).isDef And B(i).amount > 0 Then
            best = 0: bestG = 1E+30
            For r = 2 To last
                If Not usedU.Exists(r) Then
                    frm = UCase(CStr(ws.Cells(r, uFrom).Value))
                    If IsFromSsfc(frm) And NormVeh(ws.Cells(r, uVeh).Value) = B(i).veh And B(i).dt > 0 Then
                        g = DayGap(ws.Cells(r, uDate).Value, B(i).dt)
                        If g <= 3 Then
                            g = g + Abs(NZ(ws.Cells(r, uAmt)) - B(i).amount) / 1000000#
                            If g < bestG Then bestG = g: best = r
                        End If
                    End If
                End If
            Next r
            If best > 0 Then
                usedU.Add best, True
                B(i).paired = True
                Dim dd As Double: dd = B(i).amount - NZ(ws.Cells(best, uAmt))
                If Abs(dd) > 1 Then diffBy.SetItem B(i).veh, NZd(diffBy.Item(B(i).veh)) + dd
            Else
                ' bought elsewhere that day - and SSFC charged it too?
                Dim note As String: note = ""
                For r = 2 To last
                    If NormVeh(ws.Cells(r, uVeh).Value) = B(i).veh And Not IsFromSsfc(UCase(CStr(ws.Cells(r, uFrom).Value))) And B(i).dt > 0 Then
                        If DayGap(ws.Cells(r, uDate).Value, B(i).dt) <= 1 Then note = " (your sheet has " & ws.Cells(r, uQty).Value & " L on " & DM(CDateOr0(ws.Cells(r, uDate).Value)) & " bought from " & ws.Cells(r, uFrom).Value & " - charged by SSFC too?)": Exit For
                    End If
                Next r
                AddFind "CLAIM", "def", B(i).veh, B(i).amount, Short(B(i).veh) & ": SSFC charged DEF """ & B(i).desc & """ " & Rs(B(i).amount) & " on " & DM(B(i).dt) & " - no DEF refill from SSFC in your Urea DEF sheet within 3 days of it" & note
            End If
        End If
    Next i
    Dim key As Variant
    For Each key In diffBy.Keys
        If diffBy.Item(key) > 1 Then AddFind "CLAIM", "def", CStr(key), diffBy.Item(key), Short(CStr(key)) & ": for the DEF refills that pair up, SSFC charged " & Rs(diffBy.Item(key)) & " more than your Urea DEF sheet's amounts"
    Next key
End Sub

'==================================================================
'  THE REPORT SHEET
'==================================================================
Private Sub BuildCheckSheet(wsTR As Worksheet, monthRows As Collection, posted As Boolean)
    Dim ws As Worksheet
    On Error Resume Next
    Set ws = ThisWorkbook.Worksheets(RPT_SHEET)
    On Error GoTo 0
    If ws Is Nothing Then
        Set ws = ThisWorkbook.Worksheets.Add(After:=ThisWorkbook.Worksheets(ThisWorkbook.Worksheets.Count))
        ws.Name = RPT_SHEET
    Else
        ws.Cells.Clear
    End If
    Dim r As Long, i As Long, j As Long
    Dim claim As Double, nClaim As Long, nCheck As Long
    For i = 1 To nF
        If F(i).level = "CLAIM" Then claim = claim + F(i).amount: nClaim = nClaim + 1
        If F(i).level = "CHECK" Then nCheck = nCheck + 1
    Next i
    ws.Range("A1").Value = "SSFC STATEMENT CHECK - " & UCase(Format(gMonth, "mmmm yyyy"))
    ws.Range("A1").Font.Bold = True: ws.Range("A1").Font.Size = 15
    ws.Range("A2").Value = gFile & "   |   run " & Format(Now, "dd-mmm-yyyy hh:mm") & "   |   " & IIf(posted, "posted into the Trip Register (backup in '" & BAK_SHEET & "')", "checked only - nothing posted")
    ws.Range("A2").Font.Italic = True
    ' the summary
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
    r = 4
    ws.Cells(r, 1).Resize(1, 8).Value = Array("To claim from SSFC", "Findings to claim", "To check", "Trips", "Freight", "Diesel", "Cash office", "Deductions")
    ws.Cells(r + 1, 1).Resize(1, 8).Value = Array(claim, nClaim, nCheck, nT, fr, ds, co, dd)
    ws.Cells(r, 9).Value = "SSFC net": ws.Cells(r + 1, 9).Value = netSum
    Hdr ws.Range(ws.Cells(r, 1), ws.Cells(r, 9))
    ws.Range(ws.Cells(r + 1, 1), ws.Cells(r + 1, 9)).Font.Bold = True
    ws.Cells(r + 1, 1).Font.Color = RGB(192, 0, 0)
    ws.Range(ws.Cells(r + 1, 5), ws.Cells(r + 1, 9)).NumberFormat = "#,##0": ws.Cells(r + 1, 1).NumberFormat = "#,##0"

    ' the findings, what SSFC owes first
    r = r + 3
    ws.Cells(r, 1).Value = "FINDINGS": ws.Cells(r, 1).Font.Bold = True: ws.Cells(r, 1).Font.Size = 12
    r = r + 1
    ws.Cells(r, 1).Resize(1, 5).Value = Array("Level", "Area", "Vehicle", "Rs", "Finding")
    Hdr ws.Range(ws.Cells(r, 1), ws.Cells(r, 5))
    Dim lv As Variant, n As Long
    For Each lv In Array("CLAIM", "CHECK", "NOTE")
        ' amounts largest first
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
                ws.Range(ws.Cells(r, 1), ws.Cells(r, 5)).Interior.Color = RGB(253, 226, 222)
            ElseIf lv = "CHECK" Then
                ws.Range(ws.Cells(r, 1), ws.Cells(r, 5)).Interior.Color = RGB(255, 242, 204)
            Else
                ws.Range(ws.Cells(r, 1), ws.Cells(r, 5)).Font.Color = RGB(110, 110, 110)
            End If
        Next j
    Next lv
    If n = 0 Then r = r + 1: ws.Cells(r, 1).Value = "Everything checks out.": ws.Cells(r, 1).Font.Color = RGB(0, 128, 0)

    ' each vehicle
    r = r + 2
    ws.Cells(r, 1).Value = "EACH VEHICLE": ws.Cells(r, 1).Font.Bold = True: ws.Cells(r, 1).Font.Size = 12
    r = r + 1
    ws.Cells(r, 1).Resize(1, 9).Value = Array("Vehicle", "SSFC trips", "Freight", "Diesel Rs", "Diesel L", "Cash office", "Deductions", "SSFC net", "Your SSFC Net (" & ColLetter(cAL) & ")")
    Hdr ws.Range(ws.Cells(r, 1), ws.Cells(r, 9))
    For i = 1 To nV
        r = r + 1
        Dim f1 As Double, d1 As Double, l1 As Double, c1 As Double, rn As Double, rw As Variant
        f1 = 0: d1 = 0: l1 = 0: c1 = 0: rn = 0
        For j = V(i).t0 To V(i).t0 + V(i).nT - 1
            f1 = f1 + T(j).loadWt * T(j).rate: d1 = d1 + T(j).diesel: l1 = l1 + T(j).litres: c1 = c1 + T(j).cashOffice
        Next j
        For Each rw In monthRows
            If NormVeh(wsTR.Cells(rw, cVeh).Value) = V(i).veh Then rn = rn + NZ(wsTR.Cells(rw, cAL))
        Next rw
        ws.Cells(r, 1).Resize(1, 9).Value = Array(V(i).veh, V(i).nT, f1, d1, l1, c1, DedSum(V(i).veh, ""), IIf(V(i).hasNet, V(i).net, ""), rn)
        If V(i).hasNet And Abs(rn - V(i).net) > 100 Then ws.Cells(r, 9).Interior.Color = RGB(255, 242, 204)
    Next i
    ws.Range(ws.Cells(r - nV + 1, 3), ws.Cells(r, 9)).NumberFormat = "#,##0"

    ' each trip
    r = r + 2
    ws.Cells(r, 1).Value = "EACH TRIP (SSFC -> your register)": ws.Cells(r, 1).Font.Bold = True: ws.Cells(r, 1).Font.Size = 12
    r = r + 1
    ws.Cells(r, 1).Resize(1, 18).Value = Array("Vehicle", "LR", "Loaded", "Load T", "Unload T", "Rate", "Diesel Rs", "Diesel L", "Cash office", "SSFC total", "Your trip", "Matched by", _
        "of it cash diesel", "HSD Data L (SSFC fills)", "HSD Data Rs", "Your P (L)", "Your Q (Rs)", "Diesel: SSFC - yours")
    Hdr ws.Range(ws.Cells(r, 1), ws.Cells(r, 18))
    For i = 1 To nT
        r = r + 1
        With T(i)
            ws.Cells(r, 1).Resize(1, 10).Value = Array(.veh, .lr, IIf(.loadDate > 0, .loadDate, ""), .loadWt, IIf(.hasUnload, .unloadWt, ""), .rate, .diesel, .litres, .cashOffice, IIf(.hasTotal, .total, ""))
            If .trRow > 0 Then
                ws.Cells(r, 11).Value = wsTR.Cells(.trRow, cTrip).Value & "  (row " & .trRow & ")"
                ws.Cells(r, 12).Value = .how & IIf(.dateFixed, ", date read swapped", "")
                ws.Cells(r, 13).Resize(1, 6).Value = Array(IIf(.cash > 0, .cash, ""), IIf(.hsdN > 0, .hsdL, ""), IIf(.hsdN > 0, .hsdRs, ""), .regL, .regRs, _
                    DieselLabel(.dStatus, .dRs))
                If .dStatus = "more" Then ws.Cells(r, 18).Font.Color = RGB(192, 0, 0)
                If .dStatus = "less" Or .dStatus = "moved" Or .dStatus = "register" Then ws.Cells(r, 18).Font.Color = RGB(191, 120, 0)
            Else
                ws.Cells(r, 11).Value = "NOT IN REGISTER": ws.Cells(r, 11).Font.Color = RGB(192, 0, 0)
            End If
            ws.Cells(r, 3).NumberFormat = "dd-mmm-yy"
        End With
    Next i

    ' each deduction line, as SSFC wrote it, and where it went
    r = r + 2
    ws.Cells(r, 1).Value = "DEDUCTIONS (as SSFC wrote them)": ws.Cells(r, 1).Font.Bold = True: ws.Cells(r, 1).Font.Size = 12
    r = r + 1
    ws.Cells(r, 1).Resize(1, 5).Value = Array("Vehicle", "SSFC's label", "Read as", "Posted to", "Rs")
    Hdr ws.Range(ws.Cells(r, 1), ws.Cells(r, 5))
    For i = 1 To nD
        r = r + 1
        ws.Cells(r, 1).Resize(1, 5).Value = Array(D(i).veh, D(i).label, KindName(D(i).kind), IIf(D(i).col = "", "not posted", D(i).col), D(i).amount)
        If D(i).col = "" Then ws.Cells(r, 4).Font.Color = RGB(192, 0, 0)
    Next i

    ' the bills, DEF marked
    If nB > 0 Then
        r = r + 2
        ws.Cells(r, 1).Value = "BILLS (SSFC's expense sheet)": ws.Cells(r, 1).Font.Bold = True: ws.Cells(r, 1).Font.Size = 12
        r = r + 1
        ws.Cells(r, 1).Resize(1, 7).Value = Array("Vehicle", "Date", "What (as SSFC wrote it)", "Head", "Read as", "Rs", "DEF")
        Hdr ws.Range(ws.Cells(r, 1), ws.Cells(r, 7))
        For i = 1 To nB
            r = r + 1
            With B(i)
                ws.Cells(r, 1).Resize(1, 7).Value = Array(.veh, IIf(.dt > 0, .dt, ""), .desc, .cat, KindName(.kind), .amount, IIf(.isDef, IIf(.paired, "DEF - in your sheet", "DEF - NOT in your sheet"), ""))
                ws.Cells(r, 2).NumberFormat = "dd-mmm-yy"
                If .isDef And Not .paired Then ws.Cells(r, 7).Font.Color = RGB(192, 0, 0)
            End With
        Next i
    End If

    ws.Columns("A:R").AutoFit
    ws.Columns("E").ColumnWidth = 110
    ws.Columns("E").WrapText = False
    ws.Range("A4:I5").Columns.AutoFit
End Sub

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
    If nF > UBound(F) Then ReDim Preserve F(1 To nF * 2)
    F(nF).level = level: F(nF).area = area: F(nF).veh = veh: F(nF).amount = Round(amount, 2): F(nF).text = text
End Sub

Private Function DieselLabel(ByVal st As String, ByVal dRs As Double) As String
    Select Case st
        Case "": DieselLabel = "ok"
        Case "more": DieselLabel = Format(dRs, "#,##0") & "  SSFC more"
        Case "less": DieselLabel = Format(dRs, "#,##0") & "  yours more"
        Case "moved": DieselLabel = Format(dRs, "#,##0") & "  fill on the next / last trip"
        Case "register": DieselLabel = "correct P / Q"
        Case Else: DieselLabel = st
    End Select
End Function

' a trip's diesel off by more than rounding (SSFC more: Rs 50 / 0.1%; yours more: Rs 100 / 0.2%)
Private Function DieselOff(j As Long) As Boolean
    Dim tl As Double
    If T(j).dRs > 0 Then
        tl = 50: If Abs(T(j).diesel) * 0.001 > tl Then tl = Abs(T(j).diesel) * 0.001
    Else
        tl = 100: If Abs(T(j).diesel) * 0.002 > tl Then tl = Abs(T(j).diesel) * 0.002
    End If
    DieselOff = Abs(T(j).dRs) > tl
End Function

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
