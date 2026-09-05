#!/usr/bin/env python3
"""Mint a read-only Google Drive refresh token (one-time, on the Mac).

Same idea as the Gmail agent's ``mint_token.py`` — reuse the OAuth flow you
already use, just with the Drive scope. Sign in as the Google account whose
Drive holds ``Tanker Billing.xlsm``. Because the token is your own account, the
sync can read the file directly — no service account and no file-sharing.

The result is an *authorized-user* JSON blob (a revocable refresh token, scope
``drive.readonly``). Paste it into the GitHub Actions secret ``GDRIVE_TOKEN``.
It is NOT a password; Google blocks datacenter password logins, and App
Passwords do not work for the Drive API — a refresh token is what the cloud
runner exchanges for short-lived access.

Prerequisites (you can reuse the OAuth client from the Gmail agent):
  1. Google Cloud Console: in the project, enable the **Google Drive API**.
  2. Use the existing "Desktop app" OAuth client's ``credentials.json`` (the
     same file mint_token.py uses), or create one.
  3. Keep the OAuth consent screen "In production" so the refresh token does not
     expire after ~7 days. (While "Testing", add your Gmail as a Test user.)

Usage (sign in as the Drive owner in the browser it opens):
    python3 tanker/mint_drive_token.py --credentials credentials.json --out gdrive_token.json

Then copy the printed blob into the GDRIVE_TOKEN secret. gdrive_token.json is
git-ignored — delete it after copying.
"""

from __future__ import annotations

import argparse
import sys

SCOPES = ["https://www.googleapis.com/auth/drive.readonly"]


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Mint a Drive read-only refresh token")
    ap.add_argument("--credentials", default="credentials.json",
                    help="OAuth client (Desktop app) file from Google Cloud Console")
    ap.add_argument("--out", default=None,
                    help="write the token JSON here as well as printing it")
    ap.add_argument("--no-browser", action="store_true",
                    help="use console flow instead of a local browser server")
    args = ap.parse_args(argv)

    try:
        from google_auth_oauthlib.flow import InstalledAppFlow
    except ImportError:
        print("Missing dependency. Run:  pip install -r requirements.txt", file=sys.stderr)
        return 2

    try:
        flow = InstalledAppFlow.from_client_secrets_file(args.credentials, SCOPES)
    except FileNotFoundError:
        print(f"Credentials file not found: {args.credentials}\n"
              "Download it from Google Cloud Console (OAuth client, Desktop app), "
              "or reuse the one the Gmail agent uses.", file=sys.stderr)
        return 2

    if args.no_browser:
        creds = flow.run_console()
    else:
        creds = flow.run_local_server(port=0, prompt="consent")

    if not creds.refresh_token:
        print("No refresh token returned. Delete any prior grant at "
              "myaccount.google.com/permissions and re-run with consent.",
              file=sys.stderr)
        return 1

    blob = creds.to_json()
    print("\n===== authorized-user JSON (paste into the GDRIVE_TOKEN secret) =====\n")
    print(blob)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as fh:
            fh.write(blob)
        print(f"\nAlso written to {args.out} (git-ignored; delete after copying).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
