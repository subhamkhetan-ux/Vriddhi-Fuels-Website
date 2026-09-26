"""Runs the /ledger/ app's JavaScript tests (tests/ledger_web) with Node.

Skipped when Node.js 20+ isn't installed.
"""
import glob
import os
import shutil
import subprocess

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _node():
    node = shutil.which("node")
    if not node:
        return None
    out = subprocess.run([node, "--version"], capture_output=True, text=True).stdout.strip()
    try:
        major = int(out.lstrip("v").split(".")[0])
    except ValueError:
        return None
    return node if major >= 20 else None


def test_ledger_web_js():
    node = _node()
    if not node:
        pytest.skip("Node.js 20+ is not installed")
    files = sorted(glob.glob(os.path.join(ROOT, "tests", "ledger_web", "*.test.mjs")))
    assert files, "no JavaScript tests found"
    proc = subprocess.run([node, "--test", *files], cwd=ROOT, capture_output=True, text=True)
    assert proc.returncode == 0, proc.stdout[-4000:] + proc.stderr[-2000:]
