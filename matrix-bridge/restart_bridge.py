#!/usr/bin/env python3
"""Restart the Matrix bridge from inside a bridge turn.

A Hermes turn spawned by the bridge cannot kill its own parent without losing
its reply, so this helper waits `delay` seconds (long enough for the answer to
be delivered), stops the old process, and starts a fresh one detached.

Run it with start_restart.py; it writes results to restart_report.txt.
"""
from __future__ import annotations

import os
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
PY = str(HERE / ".venv" / "Scripts" / "python.exe")
SCRIPT = str(HERE / "hermes_matrix_bridge.py")
LOG = HERE / "bridge_live.log"
REPORT = HERE / "restart_report.txt"
PIDFILE = Path(os.path.expanduser("~")) / ".hermes-matrix-store2" / "bridge.pid"
DETACHED = 0x00000008 | 0x00000200        # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP


def log(msg: str) -> None:
    line = f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}"
    print(line)
    with REPORT.open("a", encoding="utf-8") as fh:
        fh.write(line + "\n")


def pids_for(pattern: str) -> list[int]:
    ps = ("Get-CimInstance Win32_Process -Filter \"Name='python.exe'\" | "
          "Where-Object { $_.CommandLine -like '" + pattern + "' } | "
          "Select-Object -ExpandProperty ProcessId")
    out = subprocess.run(["powershell", "-NoProfile", "-Command", ps],
                         capture_output=True, text=True).stdout
    me = os.getpid()
    return [int(x) for x in out.split() if x.isdigit() and int(x) != me]


def main() -> int:
    delay = float(sys.argv[1]) if len(sys.argv) > 1 else 30.0
    PIDFILE.parent.mkdir(parents=True, exist_ok=True)
    old = 0
    try:
        old = int(PIDFILE.read_text(encoding="utf-8").strip() or 0)
    except (OSError, ValueError):
        pass
    log(f"restart queued: waiting {delay:.0f}s before stopping pid {old or '?'}")
    time.sleep(delay)

    targets = {p for p in pids_for("*hermes_matrix_bridge.py*")}
    if old:
        targets.add(old)
    log(f"stopping: {sorted(targets) or 'none'}")
    for pid in sorted(targets):
        r = subprocess.run(["taskkill", "/F", "/PID", str(pid)],
                           capture_output=True, text=True)
        log(f"  taskkill {pid} -> rc={r.returncode} {r.stdout.strip() or r.stderr.strip()}")
    time.sleep(2)

    PIDFILE.unlink(missing_ok=True)
    with LOG.open("a", encoding="utf-8") as fh:
        fh.write(f"\n===== restart {time.strftime('%Y-%m-%d %H:%M:%S')} =====\n")
        fh.flush()
        proc = subprocess.Popen(
            [PY, SCRIPT],
            cwd=str(HERE),
            stdin=subprocess.DEVNULL,
            stdout=fh,
            stderr=subprocess.STDOUT,
            creationflags=DETACHED,
            close_fds=True,
        )
    log(f"new bridge started: pid {proc.pid}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
