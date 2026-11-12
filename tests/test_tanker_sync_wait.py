"""The tanker-billing sync waits for the Mac's copy to reach Google Drive (by its MD5)."""
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "tanker"))
from sync_tanker_billing import wait_for_copy  # noqa: E402


def test_waits_until_drive_has_the_macs_copy():
    seen = iter(["old", "old", "ABC123"])
    clock = [0.0]
    slept = []
    meta = wait_for_copy(lambda: {"name": "Tanker Billing.xlsm", "md5Checksum": next(seen)}, "abc123",
                         timeout=100, every=20, sleep=lambda s: (slept.append(s), clock.__setitem__(0, clock[0] + s)),
                         now=lambda: clock[0])
    assert meta["md5Checksum"] == "ABC123" and slept == [20, 20]


def test_gives_up_with_a_clear_message():
    clock = [0.0]
    with pytest.raises(SystemExit, match="still has an older copy"):
        wait_for_copy(lambda: {"name": "Tanker Billing.xlsm", "md5Checksum": "old"}, "new", timeout=50, every=20,
                      sleep=lambda s: clock.__setitem__(0, clock[0] + s), now=lambda: clock[0])
