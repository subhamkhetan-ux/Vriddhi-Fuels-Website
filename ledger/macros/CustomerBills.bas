Attribute VB_Name = "modCustomerBills"
'==========================================================
' modCustomerBills - SCPL-style bills for ANY customer, one PDF with a
' page per vehicle tag (Shivaay Logistics: JSW, 700 Acre, ...).
' The same as the ledger app's Statements -> Customer bills.
'
'  Run: CustomerBills            (Option+F8 / Alt+F8, or a button)
'
'  Set each customer up once on the "Bill Setup" sheet (made on the
'  first run):
'    A Customer      - exactly as in the Customer column of HSD Sale
'    B Split         - Tag (a page per vehicle tag) or One page
'    C Period        - Month or 10 days (1-10, 11-20, 21-end, as SCPL)
'    D Products      - HSD, or e.g. HSD, MS, XG (a page per tag and product)
'    E/F/G Bill To   - name / address / GSTIN; blank = from the customer's
'                      ledger sheet (K3 name, A1 title, Q10 address, Q11 GSTIN)
'    J:L Vehicle tags - Customer | Vehicle No. | Tag. A word typed in the
'                      Vehicle column instead of a vehicle no. ("JSW",
'                      "Transporting") is its own tag without a row here.
'    N4:N7           - the payment details printed on every bill
'  A vehicle with no tag is added to J:L for you to fill in.
'  CustomerBills_Pictures saves the letterhead and stamp pictures in the
'  workbook (asked once); without them the heading is typed text.
'  The PDF goes to the Desktop: "Shivaay Logistics Bill Oct 2026.pdf".
'==========================================================
Option Explicit

Private Const CB_SETUP As String = "Bill Setup"
Private Const CB_OUT As String = "Customer Bill"
Private Const CB_FIRST As Long = 4               ' first data row on Bill Setup
Private Const CB_FONT As String = "Times New Roman"
Private Const CB_PIC_HEAD As String = "CB_Letterhead"
Private Const CB_PIC_STAMP As String = "CB_Stamp"
Private Const CB_ACROSS As Long = 7                 ' xlCenterAcrossSelection

' the period's bills (filled by CB_Collect)
Private nRow As Long
Private rDate() As Date, rBill() As String, rVeh() As String, rQty() As Double, rRate() As Double, rAmt() As Double, rPage() As Long
Private nPage As Long
Private pTag() As String, pProd() As String
Private nUn As Long
Private uDate() As Date, uBill() As String, uVeh() As String, uKey() As String

'==========================================================
Public Sub CustomerBills()
    Dim ws As Worksheet: Set ws = CB_SetupSheet()
    Dim cust As String: cust = CB_AskCustomer(ws)
    If Len(cust) = 0 Then Exit Sub
    Dim sr As Long: sr = CB_SetupRow(ws, cust)
    If sr = 0 Then
        If MsgBox("'" & cust & "' has no bill setup yet." & vbCrLf & vbCrLf & _
                  "Add it with a page per vehicle tag, monthly, HSD? (You can change it on the Bill Setup sheet.)", _
                  vbYesNo + vbQuestion, "Customer bills") = vbNo Then Exit Sub
        sr = CB_AddSetup(ws, cust)
    End If
    ws.Range("B2").Value = cust                   ' remembered for next time

    Dim fromD As Date, toD As Date
    If Not CB_AskPeriod(ws, sr, fromD, toD) Then Exit Sub

    ' the vehicles with no tag: listed on Bill Setup to fill in
    CB_Collect ws, cust, sr, fromD, toD
    If nRow = 0 And nUn = 0 Then
        MsgBox "No bills for " & cust & " from " & Format(fromD, "dd-mm-yyyy") & " to " & Format(toD, "dd-mm-yyyy") & ".", vbInformation, "Customer bills"
        Exit Sub
    End If
    If nUn > 0 Then
        Dim added As Long: added = CB_ListUntagged(ws, cust)
        Dim ans As VbMsgBoxResult
        ans = MsgBox(nUn & " bill(s) have a vehicle with no tag" & IIf(added > 0, " - " & added & " vehicle(s) added to the tag list on Bill Setup (highlighted)", "") & "." & vbCrLf & vbCrLf & _
                     "YES = stop, so I can fill in the tags" & vbCrLf & _
                     "NO  = make the bill without those bills" & vbCrLf & "CANCEL = stop", vbYesNoCancel + vbExclamation, "Customer bills")
        If ans <> vbNo Then
            If ans = vbYes Then ws.Activate
            Exit Sub
        End If
        If nRow = 0 Then MsgBox "Nothing left to bill.", vbInformation, "Customer bills": Exit Sub
    End If

    CB_AskPictures ws
    Dim out As Worksheet: Set out = CB_Build(ws, cust, sr, fromD, toD)
    Dim pdf As String: pdf = CB_Desktop() & CB_FileName(cust, fromD, toD) & ".pdf"
    If CB_Export(out, pdf) Then
        MsgBox "Saved on the Desktop:" & vbCrLf & CB_FileName(cust, fromD, toD) & ".pdf" & vbCrLf & vbCrLf & _
               nPage & " page(s) - the '" & CB_OUT & "' sheet has it too.", vbInformation, "Customer bills"
    Else
        MsgBox "The bill is on the '" & CB_OUT & "' sheet, but Excel could not save the PDF." & vbCrLf & _
               "Use File > Save As > PDF.", vbExclamation, "Customer bills"
    End If
End Sub

' (Re)pick the letterhead and stamp pictures kept in the workbook
Public Sub CustomerBills_Pictures()
    Dim ws As Worksheet: Set ws = CB_SetupSheet()
    CB_PickPicture ws, CB_PIC_HEAD, "Select the LETTERHEAD picture (Cancel to keep / skip)"
    CB_PickPicture ws, CB_PIC_STAMP, "Select the STAMP / signature picture (Cancel to keep / skip)"
    ws.Range("P2").Value = "asked"
End Sub

'==========================================================
' The Bill Setup sheet: made with headings and an example row the first time
Private Function CB_SetupSheet() As Worksheet
    Dim ws As Worksheet
    On Error Resume Next
    Set ws = ThisWorkbook.Worksheets(CB_SETUP)
    On Error GoTo 0
    If Not ws Is Nothing Then Set CB_SetupSheet = ws: Exit Function
    Set ws = ThisWorkbook.Worksheets.Add(After:=ThisWorkbook.Worksheets(ThisWorkbook.Worksheets.Count))
    ws.Name = CB_SETUP
    ws.Range("A1").Value = "Customer bills - setup (run the CustomerBills macro)"
    ws.Range("A1").Font.Bold = True: ws.Range("A1").Font.Size = 14
    ws.Range("A2").Value = "Last customer:"
    ws.Range("A3:G3").Value = Array("Customer", "Split (Tag / One page)", "Period (Month / 10 days)", "Products (HSD, MS, XG)", "Bill To name", "Bill To address", "GSTIN")
    ws.Range("J3:L3").Value = Array("Customer", "Vehicle No.", "Tag")
    ws.Range("N3").Value = "Payment details (on every bill)"
    ws.Range("A3:G3,J3:L3,N3").Font.Bold = True
    ws.Range("A4:D4").Value = Array("Shivaay Logistics", "Tag", "Month", "HSD")
    ws.Range("N4").Value = "Account No. " & ChrW(8211) & " 046805004716"
    ws.Range("N5").Value = "IFSC Code " & ChrW(8211) & " ICIC0000468"
    ws.Range("N6").Value = "Branch Name " & ChrW(8211) & " ICICI BANK Ltd, Jharsuguda Main Branch, Kalimandir Road"
    ws.Range("N7").Value = "Name on account " & ChrW(8211) & " VRIDDHI FUELS"
    ws.Range("K:K").NumberFormat = "@"
    ws.Columns("A").ColumnWidth = 30: ws.Columns("B:D").ColumnWidth = 14
    ws.Columns("E:G").ColumnWidth = 22: ws.Columns("J").ColumnWidth = 26
    ws.Columns("K:L").ColumnWidth = 14: ws.Columns("N").ColumnWidth = 60
    Set CB_SetupSheet = ws
End Function

Private Function CB_Norm(ByVal s As String) As String
    s = LCase$(Trim$(s))
    Do While InStr(s, "  ") > 0: s = Replace(s, "  ", " "): Loop
    CB_Norm = s
End Function

' trimmed, single spaces (case kept)
Private Function CB_Squeeze(ByVal s As String) As String
    s = Trim$(s)
    Do While InStr(s, "  ") > 0: s = Replace(s, "  ", " "): Loop
    CB_Squeeze = s
End Function

Private Function CB_SetupRow(ws As Worksheet, ByVal cust As String) As Long
    Dim r As Long
    For r = CB_FIRST To ws.Cells(ws.Rows.Count, 1).End(xlUp).Row
        If CB_Norm(CStr(ws.Cells(r, 1).Value)) = CB_Norm(cust) And Len(Trim$(CStr(ws.Cells(r, 1).Value))) > 0 Then CB_SetupRow = r: Exit Function
    Next r
End Function

Private Function CB_AddSetup(ws As Worksheet, ByVal cust As String) As Long
    Dim r As Long: r = ws.Cells(ws.Rows.Count, 1).End(xlUp).Row + 1
    If r < CB_FIRST Then r = CB_FIRST
    ws.Cells(r, 1).Value = cust: ws.Cells(r, 2).Value = "Tag": ws.Cells(r, 3).Value = "Month": ws.Cells(r, 4).Value = "HSD"
    CB_AddSetup = r
End Function

Private Function CB_AskCustomer(ws As Worksheet) As String
    Dim r As Long, lst As String, n As Long, names() As String
    ReDim names(1 To 1)
    For r = CB_FIRST To ws.Cells(ws.Rows.Count, 1).End(xlUp).Row
        If Len(Trim$(CStr(ws.Cells(r, 1).Value))) > 0 Then
            n = n + 1: ReDim Preserve names(1 To n): names(n) = Trim$(CStr(ws.Cells(r, 1).Value))
            lst = lst & n & ". " & names(n) & vbCrLf
        End If
    Next r
    Dim ans As String
    ans = InputBox("Customer - its number, or a name as in the sale sheets:" & vbCrLf & vbCrLf & lst, "Customer bills", CStr(ws.Range("B2").Value))
    ans = Trim$(ans)
    If Len(ans) = 0 Then Exit Function
    If IsNumeric(ans) Then
        If CLng(ans) >= 1 And CLng(ans) <= n Then ans = names(CLng(ans))
    End If
    CB_AskCustomer = ans
End Function

' the period: the last whole month, or the 10 days just gone
Private Function CB_AskPeriod(ws As Worksheet, ByVal sr As Long, ByRef fromD As Date, ByRef toD As Date) As Boolean
    CB_DefaultPeriod CB_IsTenDays(ws, sr), Date, fromD, toD
    Dim sF As String, sT As String
    sF = InputBox("FROM date (dd/mm/yyyy):", "Customer bills - period", Format(fromD, "dd/mm/yyyy"))
    If sF = "" Then Exit Function
    sT = InputBox("TO date (dd/mm/yyyy):", "Customer bills - period", Format(toD, "dd/mm/yyyy"))
    If sT = "" Then Exit Function
    On Error GoTo Bad
    fromD = DateSerial(CInt(Split(sF, "/")(2)), CInt(Split(sF, "/")(1)), CInt(Split(sF, "/")(0)))
    toD = DateSerial(CInt(Split(sT, "/")(2)), CInt(Split(sT, "/")(1)), CInt(Split(sT, "/")(0)))
    On Error GoTo 0
    If toD < fromD Then MsgBox "TO is before FROM.", vbExclamation: Exit Function
    CB_AskPeriod = True
    Exit Function
Bad:
    MsgBox "Could not read the dates. Use dd/mm/yyyy.", vbExclamation
End Function

Private Function CB_IsTenDays(ws As Worksheet, ByVal sr As Long) As Boolean
    CB_IsTenDays = (InStr(1, LCase$(CStr(ws.Cells(sr, 3).Value)), "10") > 0)
End Function

Public Sub CB_DefaultPeriod(ByVal tenDays As Boolean, ByVal today As Date, ByRef fromD As Date, ByRef toD As Date)
    If Not tenDays Then
        fromD = DateSerial(Year(today), Month(today) - 1, 1)
        toD = DateSerial(Year(today), Month(today), 0)
    ElseIf Day(today) <= 10 Then
        toD = DateSerial(Year(today), Month(today), 0)
        fromD = DateSerial(Year(toD), Month(toD), 21)
    ElseIf Day(today) <= 20 Then
        fromD = DateSerial(Year(today), Month(today), 1): toD = DateSerial(Year(today), Month(today), 10)
    Else
        fromD = DateSerial(Year(today), Month(today), 11): toD = DateSerial(Year(today), Month(today), 20)
    End If
End Sub

'==========================================================
' a vehicle no. as a key: capitals and digits only
Public Function CB_Key(ByVal v As String) As String
    Dim i As Long, ch As String, out As String
    v = UCase$(v)
    For i = 1 To Len(v)
        ch = Mid$(v, i, 1)
        If (ch >= "A" And ch <= "Z") Or (ch >= "0" And ch <= "9") Then out = out & ch
    Next i
    CB_Key = out
End Function

' an Indian vehicle no. (OD15AF5510, OD23U755, 22BH1234AA) rather than a word
Public Function CB_IsVehicleNo(ByVal v As String) As Boolean
    Dim k As String: k = CB_Key(v)
    If k Like "##BH####[A-Z]*" Then CB_IsVehicleNo = True: Exit Function
    Dim i As Long, run As Long
    If Len(k) < 4 Then Exit Function
    If Not (Mid$(k, 1, 1) Like "[A-Z]" And Mid$(k, 2, 1) Like "[A-Z]") Then Exit Function
    i = 3: run = 0
    Do While i <= Len(k) And Mid$(k, i, 1) Like "#": i = i + 1: run = run + 1: Loop
    If run < 1 Or run > 2 Then Exit Function
    run = 0
    Do While i <= Len(k) And Mid$(k, i, 1) Like "[A-Z]": i = i + 1: run = run + 1: Loop
    If run > 3 Then Exit Function
    run = 0
    Do While i <= Len(k) And Mid$(k, i, 1) Like "#": i = i + 1: run = run + 1: Loop
    CB_IsVehicleNo = (run >= 1 And run <= 4 And i > Len(k))
End Function

Private Function CB_TagOf(ws As Worksheet, ByVal cust As String, ByVal key As String) As String
    Dim r As Long
    For r = CB_FIRST To ws.Cells(ws.Rows.Count, 10).End(xlUp).Row
        If CB_Norm(CStr(ws.Cells(r, 10).Value)) = CB_Norm(cust) Then
            If CB_Key(CStr(ws.Cells(r, 11).Value)) = key Then CB_TagOf = Trim$(CStr(ws.Cells(r, 12).Value)): Exit Function
        End If
    Next r
End Function

Private Function CB_ProductSheet(ByVal p As String) As String
    Select Case UCase$(Trim$(p))
        Case "HSD": CB_ProductSheet = "HSD Sale"
        Case "MS": CB_ProductSheet = "MS Sale"
        Case "XG": CB_ProductSheet = "XG Sale"
    End Select
End Function

Private Function CB_ProductTitle(ByVal p As String) As String
    If UCase$(Trim$(p)) = "XG" Then CB_ProductTitle = "XtraGreen" Else CB_ProductTitle = UCase$(Trim$(p))
End Function

' The period's bills of the customer, each on its page (tag + product);
' a bill with no tag goes to the untagged list
Public Sub CB_Collect(ws As Worksheet, ByVal cust As String, ByVal sr As Long, ByVal fromD As Date, ByVal toD As Date)
    nRow = 0: nPage = 0: nUn = 0
    ReDim rDate(1 To 1): ReDim rBill(1 To 1): ReDim rVeh(1 To 1): ReDim rQty(1 To 1): ReDim rRate(1 To 1): ReDim rAmt(1 To 1): ReDim rPage(1 To 1)
    ReDim pTag(1 To 1): ReDim pProd(1 To 1)
    ReDim uDate(1 To 1): ReDim uBill(1 To 1): ReDim uVeh(1 To 1): ReDim uKey(1 To 1)
    Dim oneSplit As Boolean: oneSplit = (InStr(1, LCase$(CStr(ws.Cells(sr, 2).Value)), "one") > 0)
    Dim prods() As String: prods = Split(Replace(UCase$(CStr(ws.Cells(sr, 4).Value)), " ", ""), ",")
    If UBound(prods) < 0 Then prods = Split("HSD", ",")
    Dim multi As Boolean: multi = (UBound(prods) > 0)
    Dim pk As Long, src As Worksheet, data As Variant, lastR As Long, i As Long
    For pk = 0 To UBound(prods)
        Set src = Nothing
        On Error Resume Next
        Set src = ThisWorkbook.Worksheets(CB_ProductSheet(prods(pk)))
        On Error GoTo 0
        If Not src Is Nothing Then
            lastR = src.Cells(src.Rows.Count, 1).End(xlUp).Row
            If lastR >= 2 Then
                data = src.Range(src.Cells(2, 1), src.Cells(lastR, 7)).Value
                For i = 1 To UBound(data, 1)
                    If CB_Norm(CStr(data(i, 7))) = CB_Norm(cust) And IsDate(data(i, 1)) Then
                        If CDate(data(i, 1)) >= fromD And CDate(data(i, 1)) <= toD Then
                            CB_AddBill ws, cust, oneSplit, CB_ProductTitle(prods(pk)), data, i
                        End If
                    End If
                Next i
            End If
        End If
    Next pk
End Sub

Private Sub CB_AddBill(ws As Worksheet, ByVal cust As String, ByVal oneSplit As Boolean, ByVal prodTitle As String, data As Variant, ByVal i As Long)
    Dim veh As String: veh = Trim$(CStr(data(i, 3)))
    Dim key As String: key = CB_Key(veh)
    Dim tag As String
    If oneSplit Then
        tag = " "
    ElseIf Len(key) > 0 Then
        tag = CB_TagOf(ws, cust, key)
        If Len(tag) = 0 And Not CB_IsVehicleNo(veh) Then tag = CB_Squeeze(veh)   ' a word: its own tag
    End If
    If Len(tag) = 0 Then
        nUn = nUn + 1
        ReDim Preserve uDate(1 To nUn): ReDim Preserve uBill(1 To nUn): ReDim Preserve uVeh(1 To nUn): ReDim Preserve uKey(1 To nUn)
        uDate(nUn) = CDate(data(i, 1)): uBill(nUn) = CStr(data(i, 2)): uVeh(nUn) = veh: uKey(nUn) = key
        Exit Sub
    End If
    ' the page: tag + product
    Dim p As Long, k As Long
    For k = 1 To nPage
        If pTag(k) = tag And pProd(k) = prodTitle Then p = k: Exit For
    Next k
    If p = 0 Then
        nPage = nPage + 1: ReDim Preserve pTag(1 To nPage): ReDim Preserve pProd(1 To nPage)
        pTag(nPage) = tag: pProd(nPage) = prodTitle: p = nPage
    End If
    nRow = nRow + 1
    ReDim Preserve rDate(1 To nRow): ReDim Preserve rBill(1 To nRow): ReDim Preserve rVeh(1 To nRow)
    ReDim Preserve rQty(1 To nRow): ReDim Preserve rRate(1 To nRow): ReDim Preserve rAmt(1 To nRow): ReDim Preserve rPage(1 To nRow)
    rDate(nRow) = CDate(data(i, 1)): rBill(nRow) = CStr(data(i, 2)): rVeh(nRow) = veh
    rQty(nRow) = CB_Num(data(i, 4)): rRate(nRow) = CB_Num(data(i, 5)): rAmt(nRow) = CB_Num(data(i, 6)): rPage(nRow) = p
End Sub

Private Function CB_Num(ByVal v As Variant) As Double
    If IsNumeric(v) Then CB_Num = CDbl(v)
End Function

' new untagged vehicles go to the tag list (blank tag, highlighted)
Private Function CB_ListUntagged(ws As Worksheet, ByVal cust As String) As Long
    Dim i As Long, r As Long, found As Boolean, nxt As Long
    nxt = ws.Cells(ws.Rows.Count, 10).End(xlUp).Row + 1
    If nxt < CB_FIRST Then nxt = CB_FIRST
    For i = 1 To nUn
        If Len(uKey(i)) > 0 Then
            found = False
            For r = CB_FIRST To nxt - 1
                If CB_Norm(CStr(ws.Cells(r, 10).Value)) = CB_Norm(cust) And CB_Key(CStr(ws.Cells(r, 11).Value)) = uKey(i) Then found = True: Exit For
            Next r
            If Not found Then
                ws.Cells(nxt, 10).Value = cust: ws.Cells(nxt, 11).Value = uVeh(i)
                ws.Range(ws.Cells(nxt, 10), ws.Cells(nxt, 12)).Interior.Color = RGB(255, 235, 156)
                nxt = nxt + 1: CB_ListUntagged = CB_ListUntagged + 1
            End If
        End If
    Next i
End Function

'==========================================================
' The bill sheet: a page per tag (A-Z, then product), in the SCPL bill's layout
Public Function CB_Build(ws As Worksheet, ByVal cust As String, ByVal sr As Long, ByVal fromD As Date, ByVal toD As Date) As Worksheet
    If nRow = 0 And nPage = 0 Then CB_Collect ws, cust, sr, fromD, toD
    Dim out As Worksheet
    Application.DisplayAlerts = False
    On Error Resume Next
    ThisWorkbook.Worksheets(CB_OUT).Delete
    On Error GoTo 0
    Application.DisplayAlerts = True
    Set out = ThisWorkbook.Worksheets.Add(After:=ThisWorkbook.Worksheets(ThisWorkbook.Worksheets.Count))
    out.Name = CB_OUT
    out.Cells.Font.Name = CB_FONT: out.Cells.Font.Size = 12
    out.Columns("A").ColumnWidth = 2
    ' wide enough for the bank's branch line and "Signature of Customer"; the
    ' PDF is fitted to the page's width
    out.Columns("B").ColumnWidth = 12: out.Columns("C").ColumnWidth = 10: out.Columns("D").ColumnWidth = 19
    out.Columns("E").ColumnWidth = 12: out.Columns("F").ColumnWidth = 13: out.Columns("G").ColumnWidth = 19
    out.Range("B:G").NumberFormat = "@"

    Dim bName As String, bAddr As String, bGst As String
    CB_BillTo ws, cust, sr, bName, bAddr, bGst
    Dim order As Variant: order = CB_PageOrder()
    Dim r As Long: r = 1
    Dim k As Long
    For k = 1 To nPage
        r = CB_Page(out, ws, order(k), r, bName, bAddr, bGst, fromD, toD)
        If k < nPage Then
            On Error Resume Next
            out.HPageBreaks.Add Before:=out.Cells(r, 1)
            On Error GoTo 0
        End If
    Next k
    out.Range("Z1").Value = r - 1                 ' the last row (for the print area)
    Set CB_Build = out
End Function

' the pages A-Z by tag, then by product
Private Function CB_PageOrder() As Variant
    Dim o() As Long, i As Long, j As Long, t As Long
    ReDim o(1 To IIf(nPage > 0, nPage, 1))
    For i = 1 To nPage: o(i) = i: Next i
    For i = 1 To nPage - 1
        For j = i + 1 To nPage
            If StrComp(pTag(o(j)), pTag(o(i)), vbTextCompare) < 0 Or (pTag(o(j)) = pTag(o(i)) And CB_ProdRank(pProd(o(j))) < CB_ProdRank(pProd(o(i)))) Then
                t = o(i): o(i) = o(j): o(j) = t
            End If
        Next j
    Next i
    CB_PageOrder = o
End Function

Private Function CB_ProdRank(ByVal p As String) As Long
    Select Case p
        Case "HSD": CB_ProdRank = 1
        Case "MS": CB_ProdRank = 2
        Case Else: CB_ProdRank = 3
    End Select
End Function

' Bill To: as typed on Bill Setup, else from the customer's ledger sheet
Private Sub CB_BillTo(ws As Worksheet, ByVal cust As String, ByVal sr As Long, ByRef bName As String, ByRef bAddr As String, ByRef bGst As String)
    Dim sh As Worksheet
    For Each sh In ThisWorkbook.Worksheets
        If CB_Norm(CStr(sh.Range("K3").Value)) = CB_Norm(cust) Then
            bName = Trim$(CStr(sh.Range("K3").Value))
            bAddr = Trim$(CStr(sh.Range("Q10").Value))
            bGst = Trim$(CStr(sh.Range("Q11").Value))
            If InStr(1, bGst, "GSTIN", vbTextCompare) > 0 Then bGst = Trim$(Mid$(bGst, InStr(1, bGst, ":") + 1))
            Exit For
        End If
    Next sh
    If Len(bName) = 0 Then bName = cust
    If Len(Trim$(CStr(ws.Cells(sr, 5).Value))) > 0 Then bName = Trim$(CStr(ws.Cells(sr, 5).Value))
    If Len(Trim$(CStr(ws.Cells(sr, 6).Value))) > 0 Then bAddr = Trim$(CStr(ws.Cells(sr, 6).Value))
    If Len(Trim$(CStr(ws.Cells(sr, 7).Value))) > 0 Then bGst = UCase$(Trim$(CStr(ws.Cells(sr, 7).Value)))
End Sub

' one page; returns the row after it
Private Function CB_Page(out As Worksheet, ws As Worksheet, ByVal p As Long, ByVal r As Long, ByVal bName As String, ByVal bAddr As String, _
                         ByVal bGst As String, ByVal fromD As Date, ByVal toD As Date) As Long
    Dim orange As Long: orange = RGB(196, 89, 17)
    ' the letterhead: the saved picture, else typed
    If Not CB_PastePicture(ws, CB_PIC_HEAD, out, r, 7) Then
        CB_Line out, r, "B", "VRIDDHI FUELS", 24, True, False, RGB(244, 121, 32), xlCenter, True: r = r + 1
        CB_Line out, r, "B", "Dealer: Indian Oil Corporation Limited", 12, False, False, 0, xlCenter, True: r = r + 1
        CB_Line out, r, "B", "At Kherual Post Badmal, Jharsuguda, ODISHA 768202", 12, False, False, 0, xlCenter, True: r = r + 1
        CB_Line out, r, "B", "Contact " & ChrW(8211) & " 9937344411, 7008540577", 12, False, False, 0, xlCenter, True: r = r + 1
        CB_Line out, r, "B", "GSTIN " & ChrW(8211) & " 21AATFV8250A1Z8", 12, True, False, RGB(192, 0, 0), xlCenter, True
        out.Range(out.Cells(r, 2), out.Cells(r, 7)).Borders(xlEdgeBottom).Weight = xlMedium
        r = r + 1
    End If
    r = r + 1
    ' Bill To / Date: from To to
    CB_Line out, r, "B", "Bill To", 16, True, False, orange
    CB_Line out, r, "F", "Date:", 16, True, False, orange, xlRight
    CB_Line out, r, "G", Format(fromD, "dd-mm-yyyy"), 16, True, False, 0, xlCenter
    r = r + 1
    CB_Line out, r, "B", bName, 14, True
    CB_Line out, r, "G", "To", 16, True, False, 0, xlCenter
    r = r + 1
    Dim addr() As String, a As Long, first As Boolean: first = True
    addr = Split(Replace(bAddr, vbCr, ""), vbLf)
    If Len(bAddr) = 0 Then
        CB_Line out, r, "G", Format(toD, "dd-mm-yyyy"), 16, True, False, 0, xlCenter: r = r + 1: first = False
    End If
    For a = 0 To UBound(addr)
        CB_Line out, r, "B", Trim$(addr(a)), 14
        If first Then CB_Line out, r, "G", Format(toD, "dd-mm-yyyy"), 16, True, False, 0, xlCenter: first = False
        r = r + 1
    Next a
    If Len(bGst) > 0 Then CB_Line out, r, "B", "GSTIN: " & bGst, 14, False, True: r = r + 1
    ' Vehicles: tag / Product: HSD
    If Len(Trim$(pTag(p))) > 0 Then CB_Label out, r, "B", "Vehicles: ", Trim$(pTag(p)), orange
    CB_Label out, r, "F", "Product: ", IIf(Len(pProd(p)) > 0, pProd(p), "HSD"), orange
    r = r + 2
    ' the table
    Dim top As Long: top = r
    out.Range(out.Cells(r, 2), out.Cells(r, 7)).Value = Array("Date", "Bill No", "Vehicle", "Quantity", "Rate/Ltr", "Amount")
    out.Range(out.Cells(r, 2), out.Cells(r, 7)).Font.Bold = True
    out.Range(out.Cells(r, 2), out.Cells(r, 7)).HorizontalAlignment = xlCenter
    r = r + 1
    Dim idx As Variant, n As Long, i As Long, qty As Double, amt As Double
    idx = CB_RowsOf(p, n)
    For i = 1 To n
        out.Cells(r, 2).Value = Format(rDate(idx(i)), "dd/mm/yy")
        out.Cells(r, 3).Value = rBill(idx(i))
        out.Cells(r, 4).Value = rVeh(idx(i))
        CB_Number out.Cells(r, 5), Round(rQty(idx(i)), 2), "General"     ' 1500, 2891.6
        CB_Number out.Cells(r, 6), rRate(idx(i)), "0.00"
        out.Cells(r, 7).Value = CB_Indian(rAmt(idx(i))): out.Cells(r, 7).HorizontalAlignment = xlRight
        qty = qty + rQty(idx(i)): amt = amt + rAmt(idx(i))
        r = r + 1
    Next i
    ' TOTAL: red, bold
    out.Cells(r, 4).Value = "TOTAL": out.Cells(r, 4).HorizontalAlignment = xlCenter
    CB_Number out.Cells(r, 5), Round(qty, 2), "0.00"
    out.Cells(r, 7).Value = ChrW(8377) & CB_Indian(amt): out.Cells(r, 7).HorizontalAlignment = xlRight
    With out.Range(out.Cells(r, 2), out.Cells(r, 7)).Font
        .Bold = True: .Size = 14: .Color = RGB(255, 0, 0)
    End With
    With out.Range(out.Cells(top, 2), out.Cells(r, 7)).Borders
        .LineStyle = xlContinuous: .Weight = xlThin
    End With
    r = r + 3
    ' the payment details
    CB_Line out, r, "B", "Payment Details:", 16, True: r = r + 1
    For i = 4 To 7
        If Len(Trim$(CStr(ws.Cells(i, 14).Value))) > 0 Then CB_Line out, r, "B", Trim$(CStr(ws.Cells(i, 14).Value)), 14: r = r + 1
    Next i
    r = r + 2
    ' the stamp, then the footer line
    If Not CB_PastePicture(ws, CB_PIC_STAMP, out, r, 3) Then r = r + 3
    CB_Line out, r, "B", "For VRIDDHI FUELS", 16
    CB_Line out, r, "F", "Signature of Customer", 16, False, True
    CB_Page = r + 1
End Function

' a page's bills by date, then bill no. (numbers in number order)
Private Function CB_RowsOf(ByVal p As Long, ByRef n As Long) As Variant
    Dim o() As Long, i As Long, j As Long, t As Long
    ReDim o(1 To IIf(nRow > 0, nRow, 1))
    n = 0
    For i = 1 To nRow
        If rPage(i) = p Then n = n + 1: o(n) = i
    Next i
    For i = 1 To n - 1
        For j = i + 1 To n
            If rDate(o(j)) < rDate(o(i)) Or (rDate(o(j)) = rDate(o(i)) And CB_BillKey(rBill(o(j))) < CB_BillKey(rBill(o(i)))) Then
                t = o(i): o(i) = o(j): o(j) = t
            End If
        Next j
    Next i
    CB_RowsOf = o
End Function

Private Function CB_BillKey(ByVal v As String) As String
    If IsNumeric(v) Then CB_BillKey = "0" & Format(CDbl(v), "000000000000.00") Else CB_BillKey = "1" & LCase$(v)
End Function

Private Sub CB_Line(out As Worksheet, ByVal r As Long, ByVal col As String, ByVal txt As String, ByVal sz As Long, _
                    Optional ByVal bold As Boolean = False, Optional ByVal italic As Boolean = False, Optional ByVal colr As Long = 0, _
                    Optional ByVal align As Long = -4131, Optional ByVal across As Boolean = False)   ' -4131 = xlLeft
    Dim c As Range
    If across Then
        Set c = out.Range(out.Cells(r, 2), out.Cells(r, 7))
        c.HorizontalAlignment = CB_ACROSS
        Set c = out.Cells(r, 2)
    Else
        Set c = out.Range(col & r)
        c.HorizontalAlignment = align
    End If
    c.Value = txt
    With c.Font
        .Size = sz: .Bold = bold: .Italic = italic: .Color = colr
    End With
End Sub

' "Vehicles: JSW" - the label in orange, the value in black (all bold, 16)
Private Sub CB_Label(out As Worksheet, ByVal r As Long, ByVal col As String, ByVal label As String, ByVal value As String, ByVal colr As Long)
    CB_Line out, r, col, label & value, 16, True
    On Error Resume Next
    out.Range(col & r).Characters(1, Len(label)).Font.Color = colr
    On Error GoTo 0
End Sub

' a saved picture onto the bill; True when there is one
Private Function CB_PastePicture(ws As Worksheet, ByVal nm As String, out As Worksheet, ByRef r As Long, ByVal rowsTall As Long) As Boolean
    Dim shp As Object
    On Error Resume Next
    Set shp = ws.Shapes(nm)
    On Error GoTo 0
    If shp Is Nothing Then Exit Function
    On Error GoTo Nope
    Dim wide As Double: wide = out.Range("B1:G1").Width
    shp.Copy
    out.Activate
    out.Cells(r, 2).Select
    out.Paste
    Dim pic As Object: Set pic = out.Shapes(out.Shapes.Count)
    pic.LockAspectRatio = True
    If nm = CB_PIC_HEAD Then pic.Width = wide Else pic.Height = out.Rows(r).Height * rowsTall
    pic.Left = out.Cells(r, 2).Left: pic.Top = out.Cells(r, 2).Top
    Do While out.Cells(r, 1).Top < pic.Top + pic.Height: r = r + 1: Loop
    CB_PastePicture = True
    Exit Function
Nope:
End Function

Private Sub CB_PickPicture(ws As Worksheet, ByVal nm As String, ByVal prompt As String)
    Dim f As String, v As Variant
    If CB_OnMac() Then
        On Error Resume Next
        f = MacScript("try" & vbCr & "set theFile to choose file with prompt """ & prompt & """ of type {""public.image""}" & vbCr & _
                      "return POSIX path of theFile" & vbCr & "on error" & vbCr & "return """"" & vbCr & "end try")
        On Error GoTo 0
    Else
        v = Application.GetOpenFilename("Pictures (*.png;*.jpg;*.jpeg),*.png;*.jpg;*.jpeg", , prompt)
        If VarType(v) <> vbBoolean Then f = CStr(v)
    End If
    If Len(f) = 0 Then Exit Sub
    On Error Resume Next
    ws.Shapes(nm).Delete
    On Error GoTo 0
    Dim shp As Object
    Set shp = ws.Shapes.AddPicture(f, False, True, ws.Range("P4").Left, ws.Range("P4").Top, -1, -1)
    shp.Name = nm
    shp.LockAspectRatio = True
    shp.Width = 200
End Sub

' asked once: the letterhead and stamp pictures (P2 remembers it was asked)
Private Sub CB_AskPictures(ws As Worksheet)
    Dim has As Object
    On Error Resume Next
    Set has = ws.Shapes(CB_PIC_HEAD)
    On Error GoTo 0
    If Not has Is Nothing Or LCase$(CStr(ws.Range("P2").Value)) = "asked" Then Exit Sub
    If MsgBox("Save the letterhead and stamp pictures in this workbook for the bills? (Asked once; run CustomerBills_Pictures to change them.)" & vbCrLf & _
              "NO = a typed heading and no stamp.", vbYesNo + vbQuestion, "Customer bills") = vbYes Then
        CustomerBills_Pictures
    Else
        ws.Range("P2").Value = "asked"
    End If
End Sub

'==========================================================
Private Function CB_Export(out As Worksheet, ByVal pdf As String) As Boolean
    On Error GoTo Fail
    CB_PageSetup out
    out.ExportAsFixedFormat Type:=xlTypePDF, Filename:=pdf, Quality:=xlQualityStandard, OpenAfterPublish:=False
    CB_Export = True
    Exit Function
Fail:
End Function

' A4 portrait, the bill's columns fitted to the width, a page per tag
Public Sub CB_PageSetup(out As Worksheet)
    out.PageSetup.PrintArea = out.Range("B1:G" & CLng(out.Range("Z1").Value)).Address
    On Error Resume Next
    Application.PrintCommunication = False
    On Error GoTo 0
    With out.PageSetup
        .Orientation = xlPortrait
        .Zoom = False
        .FitToPagesWide = 1
        .FitToPagesTall = False
        .CenterHorizontally = True
        .LeftMargin = Application.InchesToPoints(0.5): .RightMargin = Application.InchesToPoints(0.5)
        .TopMargin = Application.InchesToPoints(0.4): .BottomMargin = Application.InchesToPoints(0.4)
    End With
    On Error Resume Next
    Application.PrintCommunication = True
    On Error GoTo 0
End Sub

Private Function CB_Desktop() As String
    If CB_OnMac() Then
        CB_Desktop = MacScript("return POSIX path of (path to desktop folder)")
    Else
        CB_Desktop = Environ$("USERPROFILE") & "\Desktop\"
    End If
End Function

Private Function CB_OnMac() As Boolean
    CB_OnMac = (InStr(1, Application.OperatingSystem, "Mac", vbTextCompare) > 0)
End Function

' "Shivaay Logistics Bill Oct 2026", or "... Bill 1-10 Nov 2026" for part of a month
Public Function CB_FileName(ByVal cust As String, ByVal fromD As Date, ByVal toD As Date) As String
    Dim span As String
    If Day(fromD) = 1 And toD = DateSerial(Year(toD), Month(toD) + 1, 0) And Month(fromD) = Month(toD) And Year(fromD) = Year(toD) Then
        span = Format(toD, "mmm yyyy")
    ElseIf Month(fromD) = Month(toD) And Year(fromD) = Year(toD) Then
        span = Day(fromD) & "-" & Day(toD) & " " & Format(toD, "mmm yyyy")
    Else
        span = Day(fromD) & " " & Format(fromD, "mmm") & "-" & Day(toD) & " " & Format(toD, "mmm yyyy")
    End If
    Dim bad As Variant, ch As Variant
    bad = Array("/", "\", ":", "*", "?", """", "<", ">", "|")
    For Each ch In bad: cust = Replace(cust, ch, " "): Next ch
    CB_FileName = Trim$(cust) & " Bill " & span
End Function

' Indian grouping (1,23,45,678) with paise when there are any
Public Function CB_Indian(ByVal n As Double) As String
    Dim neg As Boolean, x As String, dec As String, rest As String, r As String
    n = Round(n, 2)
    If n < 0 Then neg = True: n = -n
    x = Format(Int(n), "0")
    If Round(n - Int(n), 2) > 0 Then dec = "." & Format(Round((n - Int(n)) * 100, 0), "00")
    If Len(x) > 3 Then
        rest = Left$(x, Len(x) - 3)
        Do While Len(rest) > 2
            r = "," & Right$(rest, 2) & r
            rest = Left$(rest, Len(rest) - 2)
        Loop
        x = rest & r & "," & Right$(x, 3)
    End If
    CB_Indian = IIf(neg, "-", "") & x & dec
End Function

' a number in a centred cell, shown as fmt (the bill's columns are text otherwise)
Private Sub CB_Number(c As Range, ByVal v As Double, ByVal fmt As String)
    c.NumberFormat = fmt
    c.Value = v
    c.HorizontalAlignment = xlCenter
End Sub
