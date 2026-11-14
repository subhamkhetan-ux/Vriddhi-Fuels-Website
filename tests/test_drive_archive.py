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
    def __init__(self, fail_on=None, layout=True):
        self.items = []                 # {id, name, parents, mime, props, data, trashed}
        self.fail_on = fail_on          # file name whose upload raises (a Drive outage)
        if layout:                      # the firm's Drive: My Drive / Vriddhi Fuels / OLD Data / IOCL Challan
            self.put_folder("Vriddhi Fuels", "OLD Data", "IOCL Challan")
            self.put_folder("Vriddhi Fuels", "OLD Data", "Shyam Metalics")

    def files(self):
        return self

    def list(self, q, **kw):
        m = re.search(r"name = '(.*?)' and mimeType = '(.*?)' and '(.*?)' in parents", q)
        n = re.search(r"name contains '(.*?)' and mimeType != '(.*?)'", q)
        if m:
            hit = [i for i in self.items if i["name"] == m.group(1) and i["mime"] == m.group(2)
                   and m.group(3) in i["parents"] and not i["trashed"]]
        elif n:   # Drive matches a name by word prefix; invoice numbers start the name
            hit = [i for i in self.items if any(w.startswith(n.group(1)) for w in re.split(r"[\s_.()-]+", i["name"]))
                   and i["mime"] != n.group(2) and not i["trashed"]]
            return _Exec({"files": [{"id": i["id"], "name": i["name"], "parents": i["parents"]} for i in hit]})
        else:
            key = re.search(r"value='(.*?)'", q).group(1)
            hit = [i for i in self.items if i["props"].get(DA.PROP) == key and not i["trashed"]]
        return _Exec({"files": [{"id": i["id"]} for i in hit[:1]]})

    def get(self, fileId, fields=None):
        item = next((i for i in self.items if i["id"] == fileId), None)
        return _Exec({"parents": item["parents"] if item else []})

    def put_folder(self, *path):
        parent = "root"
        for folder in path:
            got = next((i for i in self.items if i["name"] == folder and parent in i["parents"]
                        and i["mime"] == DA.FOLDER_MIME), None)
            if not got:
                got = {"id": f"h{len(self.items)}", "name": folder, "parents": [parent], "mime": DA.FOLDER_MIME,
                       "props": {}, "data": None, "trashed": False}
                self.items.append(got)
            parent = got["id"]
        return parent

    def put_by_hand(self, name, *path):
        """A PDF someone put in Drive themselves, in folder path (made as needed)."""
        parent = "root"
        for folder in path:
            got = next((i for i in self.items if i["name"] == folder and parent in i["parents"]
                        and i["mime"] == DA.FOLDER_MIME), None)
            if not got:
                got = {"id": f"h{len(self.items)}", "name": folder, "parents": [parent], "mime": DA.FOLDER_MIME,
                       "props": {}, "data": None, "trashed": False}
                self.items.append(got)
            parent = got["id"]
        self.items.append({"id": f"h{len(self.items)}", "name": name, "parents": [parent], "mime": "application/pdf",
                           "props": {}, "data": None, "trashed": False})

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


CH = "Vriddhi Fuels/OLD Data/IOCL Challan"
CHP = ("Vriddhi Fuels", "OLD Data", "IOCL Challan")


def go(drive, mails, seen=None, log=None):
    return DA.run({} if seen is None else seen, drive=DA.Drive(drive), mail_conn=object(),
                  fetch=fetcher(mails, log), pdf_to_text=ptt)


def test_where_an_invoice_goes():
    assert DA.place("26/08/2026") == ("2026", "August 2026")        # as the folders in Drive are named
    assert DA.place("05/01/2027") == ("2027", "January 2027")
    ms = int(dt.datetime(2026, 11, 30, 20, 0, tzinfo=dt.timezone.utc).timestamp() * 1000)
    assert DA.place(None, ms) == ("2026", "December 2026")         # the mail's date, in IST
    assert DA.file_name("7013019147", "12/11/2026", "OD23U8210") == "7013019147.pdf"   # named by invoice no.


def test_every_invoice_filed_by_its_date_in_the_existing_folder():
    drive = FakeDrive()
    mails = [Mail("m1", 1000, [b"own", b"transport", b"other"], ["7010195291.pdf", "7010199999.pdf", "stmt.pdf"]),
             Mail("m2", 2000, [b"own"], ["7010195291.pdf"])]               # IOCL resends invoice 1
    log = []
    assert go(drive, mails, log=log) == (2, [])
    assert drive.pdf_paths() == [
        f"{CH}/2026/August 2026/7010195291.pdf",        # our TT
        f"{CH}/2027/January 2027/7010199999.pdf",       # a transport TT
    ]
    folders = sorted(drive.path(i) for i in drive.items if i["mime"] == DA.FOLDER_MIME)
    assert folders == sorted(["Vriddhi Fuels", "Vriddhi Fuels/OLD Data", CH, "Vriddhi Fuels/OLD Data/Shyam Metalics",
                              f"{CH}/2026", f"{CH}/2026/August 2026", f"{CH}/2027", f"{CH}/2027/January 2027"])
    assert log[0][1:] == (DA.PER_RUN, True)                              # oldest first, in batches


def test_existing_year_and_month_folders_are_used():
    drive = FakeDrive()
    drive.put_by_hand("7010000001.pdf", *CHP, "2026", "August 2026")    # what's there already
    go(drive, [Mail("m1", 1000, [b"own"], ["7010195291.pdf"])])
    assert drive.pdf_paths() == [f"{CH}/2026/August 2026/7010000001.pdf", f"{CH}/2026/August 2026/7010195291.pdf"]
    assert sum(1 for i in drive.items if i["name"] == "August 2026") == 1


def test_a_missing_iocl_challan_folder_is_reported_not_made():
    drive = FakeDrive(layout=False)
    drive.put_folder("Vriddhi Fuels", "OLD Data")                       # moved / renamed away
    seen = {}
    up, errs = go(drive, [Mail("m1", 1000, [b"own"], ["7010195291.pdf"])], seen)
    assert up == 0 and errs and 'folder "IOCL Challan" not found' in errs[0]
    assert drive.pdf_paths() == [] and not any(i["name"] == "IOCL Challan" for i in drive.items)
    assert not seen[DA.SEEN_KEY].get("high_water")                      # waits for the folder


def test_the_folder_can_be_given_by_path_or_id(monkeypatch):
    drive = FakeDrive()
    other = drive.put_folder("Accounts", "Challans")
    monkeypatch.setenv(DA.PATH_ENV, "Accounts/Challans")
    go(drive, [Mail("m1", 1000, [b"own"], ["7010195291.pdf"])])
    assert drive.pdf_paths() == ["Accounts/Challans/2026/August 2026/7010195291.pdf"]
    monkeypatch.delenv(DA.PATH_ENV)
    monkeypatch.setenv(DA.FOLDER_ID_ENV, other)
    go(drive, [Mail("m2", 2000, [b"transport"], ["7010199999.pdf"])])
    assert "Accounts/Challans/2027/January 2027/7010199999.pdf" in drive.pdf_paths()


def test_already_archived_is_skipped_across_runs():
    drive = FakeDrive()
    seen = {}
    m1 = Mail("m1", 1000, [b"own"], ["7010195291.pdf"])
    go(drive, [m1], seen)
    m2 = Mail("m2", 2000, [b"own"], ["7010195291.pdf"])                  # a resend, a later run
    up, _ = go(drive, [m1, m2], seen)
    assert up == 0 and len(drive.pdf_paths()) == 1
    assert seen[DA.SEEN_KEY]["high_water"] == NOW + 2000


def test_a_drive_failure_leaves_the_mail_for_next_run():
    seen = {}
    m1 = Mail("m1", 1000, [b"own"], ["7010195291.pdf"])
    m2 = Mail("m2", 2000, [b"transport"], ["7010199999.pdf"])
    bad = FakeDrive(fail_on="7010199999.pdf")
    up, errs = go(bad, [m1, m2], seen)
    assert up == 1 and errs and "Drive is down" in errs[0]
    assert seen[DA.SEEN_KEY]["high_water"] == NOW + 1000                 # m2 not marked done
    bad.fail_on = None                                                   # Drive is back
    assert go(bad, [m1, m2], seen) == (1, []) and len(bad.pdf_paths()) == 2


def test_a_binned_copy_is_saved_again():
    drive = FakeDrive()
    m1 = Mail("m1", 1000, [b"own"], ["7010195291.pdf"])
    go(drive, [m1])
    for i in drive.items:
        if i["mime"] == "application/pdf":
            i["trashed"] = True                                          # someone put it in the bin
    assert go(drive, [m1])[0] == 1


# ---- a late challan downloaded and put in by hand is not saved again ----
@pytest.mark.parametrize("name,sub", [
    ("7010195291.pdf", ("2026", "August 2026")),       # where the job would put it
    ("7010195291.pdf", ()),                            # at the top of IOCL Challan
    ("7010195291.pdf", ("2026", "September 2026")),    # in another month
    ("7010195291 (1).pdf", ("2026", "August 2026")),   # a browser's "(1)" copy name
])
def test_a_challan_put_in_by_hand_is_skipped(name, sub):
    drive = FakeDrive()
    drive.put_by_hand(name, *CHP, *sub)
    assert go(drive, [Mail("m1", 1000, [b"own"], ["7010195291.pdf"])]) == (0, [])
    assert drive.pdf_paths() == ["/".join(CHP + sub + (name,))]


def test_the_same_number_outside_iocl_challan_doesnt_count():
    drive = FakeDrive()
    drive.put_by_hand("7010195291.pdf", "Vriddhi Fuels", "OLD Data", "Shyam Metalics")
    up, _ = go(drive, [Mail("m1", 1000, [b"own"], ["7010195291.pdf"])])
    assert up == 1 and f"{CH}/2026/August 2026/7010195291.pdf" in drive.pdf_paths()


def test_another_invoice_number_starting_the_same_doesnt_count():
    drive = FakeDrive()
    drive.put_by_hand("70101952910.pdf", *CHP)                          # not the same number
    assert go(drive, [Mail("m1", 1000, [b"own"], ["7010195291.pdf"])])[0] == 1


def test_skipped_without_the_token(monkeypatch):
    monkeypatch.delenv(DA.TOKEN_ENV, raising=False)
    assert DA.run({}) == (0, [])


def test_first_run_back_fills_from_the_set_date(monkeypatch):
    monkeypatch.setenv(DA.SINCE_ENV, "2026-04-01")
    log = []
    go(FakeDrive(), [], log=log)
    assert log[0][0] == int(dt.datetime(2026, 4, 1, tzinfo=DA.IST).timestamp() * 1000)


def test_telegram_at_most_once_a_day():
    seen = {}
    t = dt.datetime(2026, 11, 14, 8, 0, tzinfo=dt.timezone.utc)
    assert DA.should_alert(seen, t) is True
    assert DA.should_alert(seen, t + dt.timedelta(hours=5)) is False
    assert DA.should_alert(seen, t + dt.timedelta(hours=25)) is True


def test_real_upload_call_shape():
    """The real Drive.upload builds a MediaInMemoryUpload and tags the invoice."""
    drive = FakeDrive(layout=False)
    DA.Drive(drive).upload("x.pdf", "root", b"%PDF-1.4", "7010195291")
    item = drive.items[0]
    assert item["props"] == {"iocl_invoice": "7010195291"} and item["data"].mimetype() == "application/pdf"


def test_the_354_challans_already_in_drive_are_all_recognised():
    """The folder as it is (Nov 2026): 2026 / <Month> 2026 / <invoice no>.pdf —
    a mail for any of them adds nothing."""
    drive = FakeDrive()
    for inv, month in [("7004940718", "April 2026"), ("7010195291", "August 2026"),
                       ("7012920176", "November 2026"), ("7013088371", "November 2026")]:
        drive.put_by_hand(f"{inv}.pdf", *CHP, "2026", month)
    before = drive.pdf_paths()
    assert go(drive, [Mail("m1", 1000, [b"own"], ["7010195291.pdf"])]) == (0, [])
    assert drive.pdf_paths() == before
