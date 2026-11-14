"""IOCL Challan: invoice PDFs filed in Google Drive by invoice date.

Drive and the mailbox are stand-ins (no network). The stand-in Drive answers the
three queries the archive makes — a folder by name under a parent, a file by
its invoice number (appProperties), and creates — like Drive v3 does.
"""
import datetime as dt
import re
import time

import pytest

from agent import drive_archive as DA
from tests.test_invoice import INVOICE_TEXT     # IOCL invoice 7010195291, 26-Aug-26, OD23U8210


class FakeDrive:
    def __init__(self, fail_on=None):
        self.items = []                 # {id, name, parents, mime, props, data, trashed}
        self.fail_on = fail_on          # file name whose upload raises (a Drive outage)

    def files(self):
        return self

    def list(self, q, **kw):
        m = re.search(r"name = '(.*?)' and mimeType = '(.*?)' and '(.*?)' in parents", q)
        if m:
            hit = [i for i in self.items if i["name"] == m.group(1) and i["mime"] == m.group(2)
                   and m.group(3) in i["parents"] and not i["trashed"]]
        else:
            key = re.search(r"value='(.*?)'", q).group(1)
            hit = [i for i in self.items if i["props"].get(DA.PROP) == key and not i["trashed"]]
        return _Exec({"files": [{"id": i["id"]} for i in hit[:1]]})

    def create(self, body, media_body=None, fields=None):
        if self.fail_on and body["name"] == self.fail_on:
            raise RuntimeError("Drive is down")
        item = {"id": f"id{len(self.items)}", "name": body["name"], "parents": body["parents"],
                "mime": body.get("mimeType", "application/pdf"), "props": body.get("appProperties", {}),
                "data": media_body, "trashed": False}
        self.items.append(item)
        return _Exec({"id": item["id"]})

    def path(self, item):
        parts, cur = [item["name"]], item
        while cur["parents"][0] != "root":
            cur = next(i for i in self.items if i["id"] == cur["parents"][0])
            parts.insert(0, cur["name"])
        return "/".join(parts)

    def pdf_paths(self):
        return sorted(self.path(i) for i in self.items if i["mime"] == "application/pdf")


class _Exec:
    def __init__(self, v):
        self.v = v

    def execute(self):
        return self.v


NOW = int(time.time() * 1000)     # mails from just now (inside the agent's look-back)


class Mail:
    def __init__(self, msg_id, ms, pdfs, names):
        self.msg_id, self.internal_ms, self.pdfs, self.pdf_names = msg_id, NOW + ms, pdfs, names


TRANSPORT = INVOICE_TEXT.replace("OD23U8210", "OD156815").replace("26-Aug-26", "05-Jan-27")
TEXTS = {b"own": INVOICE_TEXT, b"transport": TRANSPORT, b"other": "Account statement, no invoice"}
ptt = TEXTS.__getitem__


def fetcher(mails, log=None):
    def fetch(conn, query, after_ms, seen_ids, max_results=25, oldest=False):
        if log is not None:
            log.append((after_ms, max_results, oldest))
        return [m for m in mails if m.internal_ms > (after_ms or 0) and m.msg_id not in seen_ids]
    return fetch


def test_where_an_invoice_goes():
    assert DA.place("26/08/2026") == ("2026", "08 - August")
    assert DA.place("05/01/2027") == ("2027", "01 - January")
    ms = int(dt.datetime(2026, 11, 30, 20, 0, tzinfo=dt.timezone.utc).timestamp() * 1000)
    assert DA.place(None, ms) == ("2026", "12 - December")          # the mail's date, in IST
    assert DA.file_name("7013019147", "12/11/2026", "OD23U8210") == "7013019147 - 12-11-2026 - OD23U8210.pdf"
    assert DA.file_name("7013019147", None, None) == "7013019147.pdf"


def test_every_invoice_filed_by_its_date_once(monkeypatch):
    drive = FakeDrive()
    mails = [Mail("m1", 1000, [b"own", b"transport", b"other"], ["7010195291.pdf", "7010199999.pdf", "stmt.pdf"]),
             Mail("m2", 2000, [b"own"], ["7010195291.pdf"])]               # IOCL resends invoice 1
    log = []
    up, errs = DA.run({}, drive=DA.Drive(drive), mail_conn=object(), fetch=fetcher(mails, log), pdf_to_text=ptt)
    assert (up, errs) == (2, [])
    assert drive.pdf_paths() == [
        "IOCL Challan/2026/08 - August/7010195291 - 26-08-2026 - OD23U8210.pdf",      # our TT
        "IOCL Challan/2027/01 - January/7010199999 - 05-01-2027 - OD156815.pdf",      # a transport TT
    ]
    assert [i["props"] for i in drive.items if i["mime"] == "application/pdf"] == [
        {"iocl_invoice": "7010195291"}, {"iocl_invoice": "7010199999"}]
    # one "IOCL Challan" folder, one per year / month
    folders = [drive.path(i) for i in drive.items if i["mime"] == DA.FOLDER_MIME]
    assert sorted(folders) == ["IOCL Challan", "IOCL Challan/2026", "IOCL Challan/2026/08 - August",
                               "IOCL Challan/2027", "IOCL Challan/2027/01 - January"]
    assert log[0][1:] == (DA.PER_RUN, True)                              # oldest first, in batches


def test_already_archived_is_skipped_across_runs():
    drive = FakeDrive()
    seen = {}
    m1 = Mail("m1", 1000, [b"own"], ["7010195291.pdf"])
    DA.run(seen, drive=DA.Drive(drive), mail_conn=object(), fetch=fetcher([m1]), pdf_to_text=ptt)
    m2 = Mail("m2", 2000, [b"own"], ["7010195291.pdf"])                  # a resend, a later run
    up, _ = DA.run(seen, drive=DA.Drive(drive), mail_conn=object(), fetch=fetcher([m1, m2]), pdf_to_text=ptt)
    assert up == 0 and len(drive.pdf_paths()) == 1
    assert seen[DA.SEEN_KEY]["high_water"] == NOW + 2000


def test_a_drive_failure_leaves_the_mail_for_next_run():
    seen = {}
    m1 = Mail("m1", 1000, [b"own"], ["7010195291.pdf"])
    m2 = Mail("m2", 2000, [b"transport"], ["7010199999.pdf"])
    bad = FakeDrive(fail_on="7010199999 - 05-01-2027 - OD156815.pdf")
    up, errs = DA.run(seen, drive=DA.Drive(bad), mail_conn=object(), fetch=fetcher([m1, m2]), pdf_to_text=ptt)
    assert up == 1 and errs and "Drive is down" in errs[0]
    assert seen[DA.SEEN_KEY]["high_water"] == NOW + 1000                 # m2 not marked done
    bad.fail_on = None                                                   # Drive is back
    up, errs = DA.run(seen, drive=DA.Drive(bad), mail_conn=object(), fetch=fetcher([m1, m2]), pdf_to_text=ptt)
    assert (up, errs) == (1, []) and len(bad.pdf_paths()) == 2


def test_a_binned_copy_is_saved_again():
    drive = FakeDrive()
    m1 = Mail("m1", 1000, [b"own"], ["7010195291.pdf"])
    DA.run({}, drive=DA.Drive(drive), mail_conn=object(), fetch=fetcher([m1]), pdf_to_text=ptt)
    for i in drive.items:
        i["trashed"] = True                                              # someone emptied it into the bin
    up, _ = DA.run({}, drive=DA.Drive(drive), mail_conn=object(), fetch=fetcher([m1]), pdf_to_text=ptt)
    assert up == 1


def test_skipped_without_the_token(monkeypatch):
    monkeypatch.delenv(DA.TOKEN_ENV, raising=False)
    assert DA.run({}) == (0, [])


def test_first_run_back_fills_from_the_set_date(monkeypatch):
    monkeypatch.setenv(DA.SINCE_ENV, "2026-04-01")
    log = []
    DA.run({}, drive=DA.Drive(FakeDrive()), mail_conn=object(), fetch=fetcher([], log), pdf_to_text=ptt)
    start = dt.datetime(2026, 4, 1, tzinfo=DA.IST)
    assert log[0][0] == int(start.timestamp() * 1000)


def test_telegram_at_most_once_a_day():
    seen = {}
    t = dt.datetime(2026, 11, 14, 8, 0, tzinfo=dt.timezone.utc)
    assert DA.should_alert(seen, t) is True
    assert DA.should_alert(seen, t + dt.timedelta(hours=5)) is False
    assert DA.should_alert(seen, t + dt.timedelta(hours=25)) is True


def test_real_upload_call_shape():
    """The real Drive.upload builds a MediaInMemoryUpload and tags the invoice."""
    drive = FakeDrive()
    DA.Drive(drive).upload("x.pdf", "root", b"%PDF-1.4", "7010195291")
    item = drive.items[0]
    assert item["props"] == {"iocl_invoice": "7010195291"} and item["data"].mimetype() == "application/pdf"


def test_subfolders_go_inside_an_existing_iocl_challan_folder(monkeypatch):
    # a full-drive token sees the folder the user made at the top of My Drive
    drive = FakeDrive()
    drive.items.append({"id": "mine", "name": "IOCL Challan", "parents": ["root"], "mime": DA.FOLDER_MIME,
                        "props": {}, "data": None, "trashed": False})
    m1 = Mail("m1", 1000, [b"own"], ["7010195291.pdf"])
    DA.run({}, drive=DA.Drive(drive), mail_conn=object(), fetch=fetcher([m1]), pdf_to_text=ptt)
    assert [i["name"] for i in drive.items if i["name"] == "IOCL Challan"] == ["IOCL Challan"]   # no second one
    assert drive.pdf_paths() == ["IOCL Challan/2026/08 - August/7010195291 - 26-08-2026 - OD23U8210.pdf"]


def test_or_inside_the_folder_whose_id_is_set(monkeypatch):
    drive = FakeDrive()
    drive.items.append({"id": "deep", "name": "IOCL Challan", "parents": ["accounts"], "mime": DA.FOLDER_MIME,
                        "props": {}, "data": None, "trashed": False})
    drive.items.append({"id": "accounts", "name": "Accounts", "parents": ["root"], "mime": DA.FOLDER_MIME,
                        "props": {}, "data": None, "trashed": False})
    monkeypatch.setenv(DA.FOLDER_ID_ENV, "deep")
    m1 = Mail("m1", 1000, [b"own"], ["7010195291.pdf"])
    DA.run({}, drive=DA.Drive(drive), mail_conn=object(), fetch=fetcher([m1]), pdf_to_text=ptt)
    assert drive.pdf_paths() == ["Accounts/IOCL Challan/2026/08 - August/7010195291 - 26-08-2026 - OD23U8210.pdf"]
