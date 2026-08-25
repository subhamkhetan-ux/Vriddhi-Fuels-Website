#!/usr/bin/env python3
"""Mint a Gmail read-only refresh token for one mailbox (one-time, on the Mac).

Run this ONCE per Gmail account. It opens a browser for Google consent, then
prints (and optionally saves) an authorized-user JSON blob. Paste that blob into
the matching GitHub Actions secret:

    account 1 (HDFC)  ->  GMAIL_TOKEN_BANK1
    account 2 (ICICI) ->  GMAIL_TOKEN_BANK2

The blob is NOT a password — it is a revocable, read-only refresh token
(scope: gmail.readonly). Google blocks datacenter password logins; a refresh
token is what the cloud runner exchanges for short-lived access at runtime.

Prerequisites:
  1. In Google Cloud Console: create a project, enable the Gmail API, and create
     an OAuth client of type "Desktop app". Download its credentials.json.
  2. Add your Gmail address as a Test user on the OAuth consent screen (or
     publish the app) so consent succeeds.

Usage (sign in as the bank-1 Gmail account in the browser it opens):
    python3 mint_token.py --credentials credentials.json --out token_bank1.json
Then repeat for bank 2, signing in as the other account:
    python3 mint_token.py --credentials credentials.json --out token_bank2.json

token_*.json is git-ignored — never commit it. Copy its contents into the
GitHub secret, then you can delete the local file.
"""

from __future__ import annotations

import argparse
import sys

SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"]


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Mint a Gmail read-only refresh token")
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
              "Download it from Google Cloud Console (OAuth client, Desktop app).",
              file=sys.stderr)
        return 2

    if args.no_browser:
        creds = flow.run_console()
    else:
        # Opens a browser, captures the redirect on a localhost port.
        creds = flow.run_local_server(port=0, prompt="consent")

    if not creds.refresh_token:
        print("No refresh token was returned. Re-run and make sure you grant "
              "consent (delete any prior grant at myaccount.google.com/permissions "
              "and try again with prompt=consent).", file=sys.stderr)
        return 1

    blob = creds.to_json()
    print("\n===== authorized-user JSON (paste into the GitHub secret) =====\n")
    print(blob)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as fh:
            fh.write(blob)
        print(f"\nAlso written to {args.out} (git-ignored; delete after copying).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
