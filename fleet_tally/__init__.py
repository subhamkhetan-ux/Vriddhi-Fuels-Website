"""Fleet-card (XtraPower) settlement journals -> Tally import XML.

Customers who pay through IndianOil XtraPower are settled by a Journal that moves
the amount out of the "Fleet Card Posting" ledger into the customer's ledger
(Dr Fleet Card Posting / Cr Customer). This package turns a simple Excel of
Date + Customer Name + Amount into those journals, cloning a real exported
voucher so the structure matches exactly what Tally already holds.
"""
