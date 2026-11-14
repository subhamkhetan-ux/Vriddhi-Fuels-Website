#!/usr/bin/env python3
"""Mint the Google Drive token for IOCL Challan (one-time, on the Mac).

The payment agent saves every IndianOil invoice PDF to Google Drive, in
"IOCL Challan / <year> / <month>" (agent/drive_archive.py). It needs a refresh
token for the Google account whose Drive should hold the folder.

Either way the agent makes the year and month folders inside "IOCL Challan" by
itself, and skips an invoice that is already there.

* default — scope ``drive`` (full Drive access): the agent uses your existing
  "IOCL Challan" folder at the top of My Drive (or the one whose id is in the
  repo variable DRIVE_ARCHIVE_FOLDER_ID, from its link …/folders/<id>), and it
  sees challans you put in by hand ("7013019147.pdf") so it doesn't save those
  invoices again.
* ``--narrow`` — scope ``drive.file``, the narrowest that can upload: the agent
  sees and changes ONLY what it creates itself — so it makes its own
  "IOCL Challan", and can't see challans put in by hand.

The result is an *authorized-user* JSON blob — a revocable refresh token, NOT a
password. Paste it into the GitHub Actions secret ``GDRIVE_UPLOAD_TOKEN``.

Prerequisites (the same Google Cloud project / OAuth client as mint_token.py):
  1. Google Cloud Console → APIs & Services → Library: enable **Google Drive API**.
  2. Use the "Desktop app" OAuth client's ``credentials.json`` (the one
     mint_token.py uses), or create one.
  3. Keep the OAuth consent screen "In production" so the token doesn't expire
     after ~7 days (while "Testing", add the Google account as a Test user).

Usage (sign in, in the browser it opens, as the account whose Drive gets the folder):
    python3 mint_drive_token.py --credentials credentials.json --out gdrive_upload_token.json
or, with access to only what the agent creates (it then can't see challans put in by hand):
    python3 mint_drive_token.py --narrow --credentials credentials.json --out gdrive_upload_token.json

Then copy the printed blob into the GDRIVE_UPLOAD_TOKEN secret and delete the
file (it's git-ignored). To revoke later: myaccount.google.com/permissions.
"""

from __future__ import annotations

import argparse
import sys

SCOPES = ["https://www.googleapis.com/auth/drive"]               # default: sees hand-put challans
NARROW_SCOPES = ["https://www.googleapis.com/auth/drive.file"]   # --narrow: only what it creates


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Mint the IOCL Challan Google Drive refresh token")
    ap.add_argument("--credentials", default="credentials.json",
                    help="OAuth client (Desktop app) file from Google Cloud Console")
    ap.add_argument("--out", default=None,
                    help="write the token JSON here as well as printing it")
    ap.add_argument("--narrow", action="store_true",
                    help="access only to what the agent creates (can't see challans put in by hand)")
    ap.add_argument("--no-browser", action="store_true",
                    help="use console flow instead of a local browser server")
    args = ap.parse_args(argv)

    try:
        from google_auth_oauthlib.flow import InstalledAppFlow
    except ImportError:
        print("Missing dependency. Run:  pip install -r requirements.txt", file=sys.stderr)
        return 2

    try:
        flow = InstalledAppFlow.from_client_secrets_file(
            args.credentials, NARROW_SCOPES if args.narrow else SCOPES)
    except FileNotFoundError:
        print(f"Credentials file not found: {args.credentials}\n"
              "Download it from Google Cloud Console (OAuth client, Desktop app), "
              "or reuse the one mint_token.py uses.", file=sys.stderr)
        return 2

    creds = flow.run_console() if args.no_browser else flow.run_local_server(port=0, prompt="consent")
    if not creds.refresh_token:
        print("No refresh token returned. Remove the app's earlier access at "
              "myaccount.google.com/permissions and run this again.", file=sys.stderr)
        return 1

    blob = creds.to_json()
    print("\n===== authorized-user JSON (paste into the GDRIVE_UPLOAD_TOKEN secret) =====\n")
    print(blob)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as fh:
            fh.write(blob)
        print(f"\nAlso written to {args.out} (git-ignored; delete it after copying).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
