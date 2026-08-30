"""Standalone consignment-note app (iCloud folder -> printable notes).

A Mac-local tool, independent of the /payments web app and its Supabase +
Gmail pipeline. It reads IndianOil tax-invoice PDFs from an iCloud Drive folder
you choose, reuses the verified invoice parser in ``agent/invoice.py``, assigns
consignment-note serial numbers locally, and renders each note (same letterhead
and layout as /payments) for Print / Save-as-PDF in the browser.

Nothing here touches the /payments app: it has its own state file and its own
serial counter, so run whichever you like.
"""
