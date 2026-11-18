"""A made-up Trip Register workbook (Trip Register, HSD Data, Urea DEF, Rates) with an SSFC
statement and its expense sheet as extra sheets, for tests/test_ssfc_macro.py. Made-up vehicles
and money only."""
import datetime as dt

import openpyxl


def build(path):
    from openpyxl.utils import get_column_letter as L
    wb = openpyxl.Workbook()
    tr = wb.active; tr.title = 'Trip Register'
    hdr = ['S.No','TRIP No','Vehicle No','Trip Start Date','Loading Date','Load Weight','Unload Date','Unload Weight','Excess/Short','Loading Port','Destination','Tare Weight','Gross Weight','Price/Ton','Trip Bhada','SSFC Diesel Ltr ','SSFC Diesel Amount','Extra HSD Ltr','Extar HSD Amt','Trip Diesel Ltr','Trip Diesel Amount','Own Urea','Extra Own Driver Pay','Trip Driver Payment','Driver SSFC Payment','Own Document Exp.','SSFC Misc','Own Misc Kharcha','SSFC Receivable','Fastag','Maintainance','Tyre','Less Over/Unload','RTO Entry','RTO Challan','Shortage','Document Expense','SSFC Net Amount','Installment','Income/Trip','Driver Debit','Remarks','Month']
    tr.cell(1, 5, 'LOADING'); tr.cell(1, 16, 'SSFC DIESEL')
    for i, h in enumerate(hdr, 1): tr.cell(2, i, h)
    A, B = 'XX01AB1001', 'XX01AB1002'
    d = lambda dd, mm=9: dt.datetime(2026, mm, dd)
    trips = [  # trip, veh, load, wt, unload, uwt, P, Q
        ('T001', A, d(3), 40.0, d(5), 39.9, 300, 28200),
        ('T002', A, d(12), 41.5, d(14), 41.5, 410, 38340),
        ('T003', A, d(20), 40.2, d(22), 40.1, 0, 0),          # not in the statement
        ('T001', B, d(8), 42.0, d(10), 42.0, 305, 28670),
    ]
    for k, (t, v, ld, w, ud, uw, p, q) in enumerate(trips):
        r = 3 + k
        vals = {1: k + 1, 2: t, 3: v, 4: ld, 5: ld, 6: w, 7: ud, 8: uw, 10: 'Portx', 11: 'PlantY', 14: 1800, 16: p, 17: q}
        for c, x in vals.items(): tr.cell(r, c, x)
        tr.cell(r, 15, f'=IF(F{r}<>"",F{r}*N{r},"")')
        tr.cell(r, 38, f'=IF(O{r}<>"", O{r}-Q{r}-Y{r}-AA{r}-AD{r}-AE{r}-AF{r}-AG{r}-AH{r}-AI{r}-AJ{r}-AK{r},"")')
        tr.cell(r, 43, f'=IF(E{r}<>"", EOMONTH(E{r}, -1) + 1, "")')
    h = wb.create_sheet('HSD Data')
    for i, x in enumerate(['Date','Bill No.','Vehicle','Quantity','RSP','Amount','RO Name','Location','Month','Trip ID'], 1): h.cell(1, i, x)
    hsd = [(d(3), A, 300, 94, 'SSFC Pumpx', 'T001'), (d(12), A, 310, 94, 'SSFC Pumpx', 'T002'), (d(13), A, 100, 92, 'SSFC Vriddhi', 'T002'), (d(8), B, 300, 94, 'SSFC Pumpx', 'T001')]
    for k, (dd, v, q, rsp, ro, t) in enumerate(hsd):
        r = 2 + k
        for c, x in {1: dd, 2: str(100 + k), 3: v, 4: q, 5: rsp, 7: ro, 10: t}.items(): h.cell(r, c, x)
        h.cell(r, 6, f'=IF(D{r}<>"",TRUNC(D{r}*E{r},2),"")')
    u = wb.create_sheet('Urea DEF')
    for i, x in enumerate(['Date','Particulars','Vehicle','Quantity','Price','Amount','Location','Month','Trip ID','Purchased By','Purchased From'], 1): u.cell(1, i, x)
    for k, (dd, v, q, pr, frm) in enumerate([(d(4), A, 20, 65, 'SS Freight Carrier'), (d(10), B, 20, 65, 'SS Freight Carrier'), (d(15), A, 20, 60, 'Some Pump')]):
        r = 2 + k
        for c, x in {1: dd, 2: f'DEF/{k}', 3: v, 4: q, 5: pr, 11: frm}.items(): u.cell(r, c, x)
        u.cell(r, 6, f'=IF(D{r}<>"",TRUNC(D{r}*E{r},2),"")')
    ra = wb.create_sheet('Rates')
    for i, x in enumerate(['Location','Company','Rate','Diesel'], 1): ra.cell(1, i, x)
    ra.append(['Portx', 'PlantY', 1800, 600]); ra.append(['Portz', 'PlantY', 1700, 600])
    # SSFC's statement, as its own sheets (the harness reads them like the statement workbook)
    s = wb.create_sheet('STMT')
    s.cell(1, 1, 'DEMO LOGISTIC SEP- 2026')
    def block(r, veh, rows, lines):
        s.cell(r, 3, veh); r += 1
        h1 = {1:'SL NO',2:'LR NO',3:'VEHICLE NO',4:'DATE',5:'LOADING WT',6:'DATE',7:'UNLDNG WT',8:'SHORTAGE/EXCESS',9:'DATE',10:'RAYAGADA DIESEL/DASPALLA',14:'DATE',15:'VRIDHHI FUEL',20:'FRIEGHT',21:'TOTAL'}
        h2 = {10:'DIESEL QTY.',11:'FUEL/LTR',12:'FUEL AMOUNT',13:'CASH',15:'DIESEL QTY.',16:'FUEL/LTR',17:'AMOUNT',18:'OFF CASH DATE',19:'CASH OFFICE'}
        for c, x in h1.items(): s.cell(r, c, x)
        for c, x in h2.items(): s.cell(r + 1, c, x)
        r += 2; sub = 0
        for k, t in enumerate(rows):
            pump = round(t['qty'] * 94, 2); vr = round(t.get('vqty', 0) * 92, 2)
            total = round(t['wt'] * 1800 - pump - vr - t['office'], 2); sub += total
            vals = {1: k + 1, 2: t['lr'], 3: veh, 4: t['load'], 5: t['wt'], 6: t['unload'], 7: t['uwt'], 8: round(t['uwt'] - t['wt'], 2), 9: t['load'], 10: t['qty'], 11: 94, 12: pump, 13: 0,
                    14: t['load'] if vr else None, 15: t.get('vqty', 0), 16: 92 if vr else 0, 17: vr, 18: t['load'], 19: t['office'], 20: 1800, 21: total}
            for c, x in vals.items(): s.cell(r, c, x)
            r += 1
        s.cell(r, 21, round(sub, 2)); r += 1; ded = 0
        for lab, amt in lines:
            s.cell(r, 20, lab); s.cell(r, 21, amt); ded += amt; r += 1
        s.cell(r, 17, 'NET AMOUNT'); s.cell(r, 21, round(sub - ded, 2)); return r + 2
    r = 3
    r = block(r, A, [dict(lr='LR101', load='03/09/2026', wt=40, unload='05/09/2026', uwt=39.9, qty=300, office=5000),
                     dict(lr='LR102', load='12/09/2026', wt=41.5, unload='14/09/2026', uwt=41.5, qty=310, vqty=100, office=5000)],
              [('LESS FASTAG', 4000), ('LESS MAINT.', 3300), ('LESS OVER./UNLOAD.', 500), ('LESS RTO ENTRY', 9000)])
    r = block(r, B, [dict(lr='LR201', load='08/09/2026', wt=42, unload='10/09/2026', uwt=41.8, qty=305, office=6000)],
              [('LESS FASTAG', 2000), ('LESS MAINT.', 2000), ('LESS RTO ENTRY', 12000), ('LESS HYDRA', 3000)])
    e = wb.create_sheet('EXPENSES')
    e.append(['SL', 'DATE', 'VEHICLE NO', 'PARTICULARS', 'EXPENSE HEAD', 'QTY', 'RATE', 'AMOUNT'])
    for row in [(1, '04/09/2026', A, 'AD BLUE 20 LTR', 'MAINT.', 20, 65, 1300), (2, '15/09/2026', A, 'URIA AD ABLUE TARA TRINI', 'MAINT.', 1, 2000, 2000),
                (3, '09/09/2026', A, 'DRIVER FOODING', 'DRI. FOODING', None, None, 500), (4, '10/09/2026', B, 'CLEARLUE 20 LTR', 'MAINT.', 20, 70, 1400),
                (5, '11/09/2026', B, 'AIR CHECK', 'MAINT.', None, None, 300), (6, '11/09/2026', B, 'AIR CHECK', 'MAINT.', None, None, 300)]:
        e.append(list(row))
    wb.save(path)
