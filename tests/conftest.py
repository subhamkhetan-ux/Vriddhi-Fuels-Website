"""Make the repo root importable so ``import agent`` and ``import materialize``
work when pytest is run from anywhere."""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
