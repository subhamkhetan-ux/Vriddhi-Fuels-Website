"""IOCL PAD statement -> Tally import XML.

Turns the monthly IndianOil Periodic Account of Dealer (PAD) statement into
Tally vouchers against the ``M/s Indian Oil Corporation Limited`` ledger, by
parsing the PDF and cloning real exported voucher templates. See ``run.py`` for
the CLI and ``pad_parser`` / ``xml_generator`` for the two halves.
"""
