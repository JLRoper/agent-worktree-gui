#!/usr/bin/env sh
# First-run checks for the worktree panel (macOS/Linux). Nothing is installed; this only
# verifies the prerequisites. Safe to re-run.
set -eu
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "[x]    node not found on PATH -- install Node 18 or newer"
  exit 1
fi
major=$(node -p 'process.versions.node.split(".")[0]')
if [ "$major" -lt 18 ]; then
  echo "[x]    node $major is too old -- the panel needs Node 18 or newer"
  exit 1
fi
echo "[ok]   node $major"

if ! command -v git >/dev/null 2>&1; then
  echo "[x]    git not found on PATH -- the panel reads every worktree with it"
  exit 1
fi
echo "[ok]   git"

if command -v hermes >/dev/null 2>&1; then
  echo "[ok]   hermes"
else
  echo "[warn] hermes not on PATH -- monitoring works, spawning agents will not"
fi

if [ -f config.json ]; then
  echo "[ok]   config.json present -- check \"scanRoots\" points at where your repos live"
else
  echo "[info] no config.json -- the panel will start on defaults (scanRoots = the parent folder)"
fi

echo
echo "Ready.  Run:  node server.js   then open  http://127.0.0.1:7331"
echo "Docs:   README.md  and  SETUP.md"
