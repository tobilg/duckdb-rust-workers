#!/usr/bin/env python3
"""Fail builds on source drift; never reset a checkout."""
import json
import subprocess
from pathlib import Path
from vendor_patches import verify_sources
root = Path(__file__).resolve().parent.parent
lock = json.loads((root / 'toolchain-lock.json').read_text())
verify_sources(lock)
assert subprocess.check_output(['node', '--version'], text=True).strip() == 'v' + lock['node'], 'Node version mismatch'
