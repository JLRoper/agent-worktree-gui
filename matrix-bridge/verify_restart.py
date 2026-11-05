#!/usr/bin/env python3
"""Detached witness: after the restart, record what the new bridge did."""
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE / "restart_verify.txt"

time.sleep(120)

lines = [f"checked at {time.strftime('%Y-%m-%d %H:%M:%S')}"]
pidfile = Path.home() / ".hermes-matrix-store2" / "bridge.pid"
lines.append("pidfile: " + (pidfile.read_text(encoding="utf-8").strip()
                            if pidfile.exists() else "MISSING"))
lines.append("outbox.txt still present: " + str((HERE / "outbox.txt").exists()))
try:
    log = (HERE / "bridge_live.log").read_text(encoding="utf-8", errors="replace")
except OSError as exc:
    log = f"(log unreadable: {exc})"
lines.append("--- bridge_live.log tail ---")
lines.extend(log.splitlines()[-25:])
OUT.write_text("\n".join(lines) + "\n", encoding="utf-8")
print("\n".join(lines))
