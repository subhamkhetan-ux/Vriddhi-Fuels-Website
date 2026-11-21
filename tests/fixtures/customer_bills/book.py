"""A made-up Master Ledger for tests/test_customer_bills_macro.py: the HSD / MS / XG Sale sheets
(Date, Bill No., Vehicle, Quantity, RSP, Amount, Customer) and one customer's ledger sheet with its
bill header (K3 name, Q10 address, Q11 GSTIN). Made-up vehicles, GSTINs and money only."""
import datetime as dt

import openpyxl

C = 'Demo Logistics'
HEAD = ['Date', 'Bill No.', 'Vehicle', 'Quantity', 'RSP', 'Amount', 'Customer', 'Month']


def build(path):
    wb = openpyxl.Workbook()
    led = wb.active; led.title = 'Demo Ledger'
    led['A1'] = 'DEMO LOGISTICS'; led['K3'] = C; led['Q10'] = 'Sample Depot, Testpur.'; led['Q11'] = 'GSTIN:21AAAFD0000L1Z5'
    d = lambda dd, mm=10: dt.datetime(2026, mm, dd)
    sheets = {'HSD Sale': [
        (d(2), '33', 'OD99ZZ1001', 1500, 100.24, 150360),
        (d(5), '63', 'od 99 zz-1001', 1500, 100.24, 150360),       # the same vehicle, typed differently
        (d(5), '9', 'OD99YY2002', 2000, 100.24, 200480),            # 9 before 33/63 on its day
        (d(4), '50', 'OD99YY2002', 2000, 100.24, 200480),
        (d(9), '117', 'OD99XX3003', 800.5, 100.24, 80242.12),       # not tagged
        (d(11), '136', None, 1999.89, 100.24, 200468.97),           # no vehicle no.
        (d(12), '140', 'Plant Yard', 600, 100.24, 60144),           # a word: its own tag
        (d(2, 11), '200', 'OD99ZZ1001', 1000, 101.0, 101000),        # next month
        (d(6), '77', 'OD99ZZ1001', 999, 100.24, 100139.76),
    ], 'MS Sale': [
        (d(7), 'MS5', 'OD99ZZ1001', 40, 105.5, 4220),
    ], 'XG Sale': []}
    for name, rows in sheets.items():
        ws = wb.create_sheet(name)
        for i, h in enumerate(HEAD, 1): ws.cell(1, i, h)
        for r, row in enumerate(rows, 2):
            for c, v in enumerate(row, 1): ws.cell(r, c, v)
        # another customer's bill in the same period
        ws.cell(len(rows) + 2, 1, d(8)); ws.cell(len(rows) + 2, 2, 'X1'); ws.cell(len(rows) + 2, 3, 'OD99ZZ1001')
        ws.cell(len(rows) + 2, 4, 50); ws.cell(len(rows) + 2, 5, 100); ws.cell(len(rows) + 2, 6, 5000); ws.cell(len(rows) + 2, 7, 'Someone Else')
        # the bill rows' customer
        for r in range(2, len(rows) + 2): ws.cell(r, 7, C)
    wb.save(path)
