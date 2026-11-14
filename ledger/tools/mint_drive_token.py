#!/usr/bin/env python3
"""Mint the Google Drive token the monthly register PDFs job uses (one-time, on the Mac).

GitHub can't sign in to Google with a password, so the job uses a refresh
token for your Google account (the one whose Drive has "Vriddhi Fuels"),
with the Drive scope so it can find that folder and make
"Registers/FY yyyy-yy" inside it. The result is an authorized-user JSON blob
— paste it into the GitHub secret GDRIVE_TOKEN. It's revocable at
myaccount.google.com/permissions; it is not your password.

Prerequisites (the same OAuth client the Gmail agent uses works):
  1. Google Cloud Console, in that project: APIs & Services -> Library ->
     "Google Drive API" -> Enable (already on if the old tanker sync used it).
  2. The OAuth client's credentials.json ("Desktop app" type).
  3. OAuth consent screen "In production" (else the token stops after 7 days).

Usage (sign in as the Drive's owner in the browser it opens):
    pip3 install google-auth-oauthlib
    python3 ledger/tools/mint_drive_token.py --credentials credentials.json

Copy everything printed between the lines into the GDRIVE_TOKEN secret.
"""

from __future__ import annotations

import argparse
import sys

SCOPES = ["https://www.googleapis.com/auth/drive"]


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Mint a Google Drive refresh token for the register PDFs job")
    ap.add_argument("--credentials", default="credentials.json", help="OAuth client (Desktop app) file")
    ap.add_argument("--out", default=None, help="also write the token JSON here (git-ignored: gdrive_token.json)")
    args = ap.parse_args(argv)
    try:
        from google_auth_oauthlib.flow import InstalledAppFlow
    except ImportError:
        print("Missing dependency. Run:  pip3 install google-auth-oauthlib", file=sys.stderr)
        return 2
    try:
        flow = InstalledAppFlow.from_client_secrets_file(args.credentials, SCOPES)
    except FileNotFoundError:
        print(f"Credentials file not found: {args.credentials}\n"
              "Download it from Google Cloud Console (OAuth client, Desktop app) — or reuse the Gmail agent's.",
              file=sys.stderr)
        return 2
    creds = flow.run_local_server(port=0, prompt="consent", access_type="offline")
    if not creds.refresh_token:
        print("No refresh token came back. Remove the app at myaccount.google.com/permissions and run this again.",
              file=sys.stderr)
        return 1
    blob = creds.to_json()
    print("\n===== copy everything below into the GitHub secret GDRIVE_TOKEN =====\n")
    print(blob)
    print("\n===== end =====")
    if args.out:
        with open(args.out, "w", encoding="utf-8") as fh:
            fh.write(blob)
        print(f"Also written to {args.out} (delete it once copied).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
