# Build the proof home: a copy of the reader's state, and a config that leaves the reader's panel alone.
# The project list is copied from the source config, so no project path is written into this file (test/absolute-paths.test.js
# refuses a folder on this machine anywhere in the tree). Set WAG_SOURCE_HOME to the panel state you want to copy
# (default: ~/.wag) and WAG_PROOF_HOME to where the copy should live (default: a folder under the OS temp dir).
import json, os, shutil, socket, tempfile

SRC = os.environ.get("WAG_SOURCE_HOME") or os.path.expanduser(os.path.join("~", ".wag"))
HOME = os.environ.get("WAG_PROOF_HOME") or os.path.join(tempfile.gettempdir(), "wag-proof-home")


def free_port(start=7332):
    for port in range(start, start + 40):
        with socket.socket() as s:
            try:
                s.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    raise SystemExit("no free port")


shutil.rmtree(HOME, ignore_errors=True)
os.makedirs(HOME, exist_ok=True)
shutil.copytree(os.path.join(SRC, "state"), os.path.join(HOME, "state"))
os.makedirs(os.path.join(HOME, "logs"), exist_ok=True)
os.makedirs(os.path.join(HOME, "attachments"), exist_ok=True)

# THE READER'S OWN PROJECT LIST, copied rather than restated: the copy should answer the same rows the reader sees.
source = json.load(open(os.path.join(SRC, "config.json"), encoding="utf-8"))
projects = []
for p in source.get("projects") or []:
    projects.append(
        {
            "name": p.get("name"),
            "path": p.get("path"),
            "remote": p.get("remote") or "origin",
            "mainBranch": p.get("mainBranch") or "main",
            "prRepo": p.get("prRepo"),
            "remoteBranchPolicy": p.get("remoteBranchPolicy") or "allow",
            "worktrees": None,
        }
    )

port = free_port()
config = {
    "host": "127.0.0.1",
    "port": port,
    "dataDir": HOME.replace("\\", "/"),
    "scanRoots": [],
    "scanMode": "all",
    "projects": projects,
    "refreshSeconds": 30,
    "worktreeSeconds": 30,
    "midSeconds": 90,
    "dormantSeconds": 180,
    "liveSeconds": 5,
    "slowSeconds": 600,
    "fetchSeconds": 86400,
    "threads": 3,
    "initiativePermissions": "own",
    # NO ASSISTANT and a dead apiServer: the proof panel must never reach the reader's panel or spawn a run.
    "assistant": {"enabled": False, "autonomy": "draft", "seconds": 3600, "maxWakesPerHour": 0},
    "apiServer": {"url": "http://127.0.0.1:9", "key": "proof"},
}
with open(os.path.join(HOME, "config.json"), "w", encoding="utf-8") as fh:
    json.dump(config, fh, indent=1)
print("home", HOME)
print("port", port)
print("projects", len(projects))
