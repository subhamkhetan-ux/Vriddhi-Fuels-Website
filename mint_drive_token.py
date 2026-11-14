#!/usr/bin/env python3
"""Mint the Google Drive token for IOCL Challan (one-time, on the Mac).

The payment agent saves every IndianOil invoice PDF to Google Drive, in
"IOCL Challan / <year> / <month>" (agent/drive_archive.py). It needs a refresh
token for the Google account whose Drive should hold the folder.

Either way the agent makes the year and month folders inside "IOCL Challan" by
itself. Which "IOCL Challan":

* default — scope ``drive.file``, the narrowest that can upload: the agent sees
  and changes ONLY the folders and files it creates itself, nothing else in that
  Drive. So it makes its own "IOCL Challan" folder in My Drive.
* ``--existing-folder`` — scope ``drive`` (full Drive access): for an
  "IOCL Challan" folder you've already made. The agent finds it at the top of
  My Drive (or set the repo variable DRIVE_ARCHIVE_FOLDER_ID to its id, from its
  link …/folders/<id>, if it's inside another folder) and fills that one.

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
or, to fill the "IOCL Challan" folder you already have:
    python3 mint_drive_token.py --existing-folder --credentials credentials.json --out gdrive_upload_token.json

Then copy the printed blob into the GDRIVE_UPLOAD_TOKEN secret and delete the
file (it's git-ignored). To revoke later: myaccount.google.com/permissions.
"""

from __future__ import annotations

import argparse
import sys

SCOPES = ["https://www.googleapis.com/auth/drive.file"]          # only what the agent creates
FULL_SCOPES = ["https://www.googleapis.com/auth/drive"]          # --existing-folder


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Mint the IOCL Challan Google Drive refresh token")
    ap.add_argument("--credentials", default="credentials.json",
                    help="OAuth client (Desktop app) file from Google Cloud Console")
    ap.add_argument("--out", default=None,
                    help="write the token JSON here as well as printing it")
    ap.add_argument("--existing-folder", action="store_true",
                    help="full Drive access, to fill an \"IOCL Challan\" folder you already made")
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
            args.credentials, FULL_SCOPES if args.existing_folder else SCOPES)
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
