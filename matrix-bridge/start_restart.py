#!/usr/bin/env python3
"""Fire restart_bridge.py fully detached, then exit immediately."""
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
PY = str(HERE / ".venv" / "Scripts" / "python.exe")
DETACHED = 0x00000008 | 0x00000200

delay = sys.argv[1] if len(sys.argv) > 1 else "30"
out = HERE / "restart_launcher.log"
with out.open("a", encoding="utf-8") as fh:
    p = subprocess.Popen(
        [PY, str(HERE / "restart_bridge.py"), delay],
        cwd=str(HERE),
        stdin=subprocess.DEVNULL,
        stdout=fh,
        stderr=subprocess.STDOUT,
        creationflags=DETACHED,
        close_fds=True,
    )
print("restart helper launched:", p.pid)
