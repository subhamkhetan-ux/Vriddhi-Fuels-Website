"""Runs the /decant/ app's JavaScript tests (tests/decant_web) with Node.

Skipped when Node.js 20+ isn't installed.
"""
import glob
import os
import subprocess

import pytest

from tests.test_ledger_web import ROOT, _node


def test_decant_web_js():
    node = _node()
    if not node:
        pytest.skip("Node.js 20+ is not installed")
    files = sorted(glob.glob(os.path.join(ROOT, "tests", "decant_web", "*.test.mjs")))
    assert files, "no JavaScript tests found"
    proc = subprocess.run([node, "--test", *files], cwd=ROOT, capture_output=True, text=True)
    assert proc.returncode == 0, proc.stdout[-4000:] + proc.stderr[-2000:]
