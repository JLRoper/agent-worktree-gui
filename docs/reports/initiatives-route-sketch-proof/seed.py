# Seed the throwaway initiative through the proof panel's own HTTP routes.
# POST /api/initiatives -> attach two real trees -> file four tasks on two waves' lanes
# -> move them to done/running through the queue's state action -> write the wave store document
# (there is no wave write route: routes/waves.js answers 405 "this slice reads waves and writes none").
import json, os, urllib.request, urllib.error, datetime

BASE = os.environ.get("BASE", "http://127.0.0.1:7332")
# A MACHINE FOLDER MAY NOT ENTER THE TREE: the home and the two worktrees are passed in (test/absolute-paths.test.js).
# The run that produced this report used WAG_PROOF_HOME=~/AppData/Local/Temp/wag/73596cb0/home and the two worktrees
# named in the report, both under the agent-worktree-gui projects.
HOME = os.environ.get("WAG_PROOF_HOME") or os.path.expanduser("~/wag-proof-home")
OUT = os.environ.get("WAG_PROOF_OUT") or os.path.expanduser("~")
TITLE = "Sketch proof: Menu SSO migration"
OAUTH_TREE = os.environ.get("TREE_A") or ""
MENU_TREE = os.environ.get("TREE_B") or ""
if not OAUTH_TREE or not MENU_TREE:
    raise SystemExit("set TREE_A and TREE_B to two real worktree paths to attach (see the report, section 2)")


def call(method, path, body=None):
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(BASE + path, data=data, method=method,
                                 headers={"content-type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status, json.load(r)
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode("utf-8") or "{}")


def get(path):
    with urllib.request.urlopen(BASE + path, timeout=20) as r:
        return json.load(r)


# ---- 0. who is on the roster -------------------------------------------------------------------------------------
roster = get("/api/assistant")
assistants = [a.get("id") for a in (roster.get("assistants") or []) if a.get("id")]
print("roster:", assistants)
AID = "assistant-1" if "assistant-1" in assistants else assistants[0]

# ---- 1. create ---------------------------------------------------------------------------------------------------
status, res = call("POST", "/api/initiatives", {"title": TITLE, "description": DESC, "by": "assistant-3"})
print("create:", status, json.dumps(res)[:200])
doc = get("/api/initiatives")
mine = [i for i in doc["initiatives"] if i["title"] == TITLE]
if not mine:
    raise SystemExit("the create did not land (tier may have parked a question)")
init = mine[0]
IID = init["id"]
print("initiative:", IID)

# ---- 2. two real worktrees, so the card's PROJECTS column and the lanes name trees --------------------------------
for tree in (OAUTH_TREE, MENU_TREE):
    status, res = call("POST", "/api/initiatives/move",
                       {"tree": tree, "initiative": IID, "action": "add", "by": "assistant-3"})
    print("attach:", status, tree.split("/")[-1], json.dumps(res)[:120])

# ---- 3. the four task cards, filed through the queue route -------------------------------------------------------
TASKS = [
    # (waveId, lane, title, tree, project, final state)
    ("w.callback", None, "Prove the Okta callback on the VIP", OAUTH_TREE, "oauth2-multi", "done"),
    ("w.second", None, "Second pass over the callback", OAUTH_TREE, "oauth2-multi", "done"),
    ("w.flip", "callback", "Validate the Okta callback against the VIP", OAUTH_TREE, "oauth2-multi", "running"),
    ("w.flip", "login", "Cut the login page over", MENU_TREE, "Menu", "running"),
]
ids = []
for wave, lane, title, tree, project, state in TASKS:
    body = {"assistantId": AID, "action": "add", "title": title, "detail": "", "worktree": tree,
            "project": project, "waveId": wave, "files": [], "by": "assistant-3"}
    if lane:
        body["lane"] = lane
    status, res = call("POST", "/api/assistant/queue", body)
    task = res.get("task") or {}
    tid = task.get("id")
    if not tid:
        q = get("/api/assistant/queue?assistantId=" + AID)
        tid = [t["id"] for t in q["queue"]["tasks"] if t["title"] == title][-1]
    ids.append(tid)
    print("task:", status, "#" + str(tid), title, "wave", wave, "lane", lane)
    if state != "queued":
        status, res = call("POST", "/api/assistant/queue",
                           {"assistantId": AID, "action": "state", "id": tid, "state": state, "by": "assistant-3"})
        print("  state ->", status, state, json.dumps(res)[:100])

# ---- 4. the wave store: three ordered waves, gates on each, one switch, two lanes on the third --------------------
now = datetime.datetime.now(datetime.timezone.utc).isoformat()
waves = {
    "version": 1,
    "savedAt": now,
    "byInitiative": {
        IID: [
            {"id": "w.callback", "initiativeId": IID, "position": 1,
             "title": "Prove the Okta callback on the VIP",
             "entryGate": {"check": "clean"}, "exitGate": {"check": "clean"}, "template": None, "auto": True},
            {"id": "w.second", "initiativeId": IID, "position": 2,
             "title": "One real two-factor login",
             "entryGate": {"check": "clean"}, "exitGate": {"check": "clean"}, "template": None, "auto": False},
            {"id": "w.flip", "initiativeId": IID, "position": 3,
             "title": "Cut the login page over behind the switch",
             "entryGate": {"check": "clean"}, "exitGate": {"check": "clean"}, "template": "sefl-review-loop", "auto": False},
        ]
    },
}
with open(os.path.join(HOME, "state", "waves.json"), "w", encoding="utf-8") as fh:
    json.dump(waves, fh, indent=1)
print("waves.json written")

# ---- 5. read it back: the renderer's own fold ---------------------------------------------------------------
doc = get("/api/initiatives")
init = [i for i in doc["initiatives"] if i["id"] == IID][0]
print("waveStatus:", doc.get("waveStatus"))
print("currentId:", init.get("waveCurrentId"))
for w in init["waves"]:
    print(" wave", w["position"], w["id"], "state", w["state"], "(", w.get("stateWord"), ")",
          "| gates", w["gates"]["entry"]["state"], "/", w["gates"]["exit"]["state"],
          "| lanes", w.get("laneCount"), "joinOwed", w.get("laneJoinOwed"),
          "| autoOpen", (w.get("autoOpen") or {}).get("open"), "from", (w.get("autoOpen") or {}).get("from"))
    for lane in w.get("lanes") or []:
        print("    lane", lane["label"], lane["state"], "read", lane["read"].get("ok"), "trees", len(lane["read"].get("trees") or []))
    for m in w.get("members") or []:
        print("    member #%s %s [%s] %s lane=%s" % (m["id"], m["title"][:40], m["state"], m["project"], m.get("lane")))
json.dump(doc, open(OUT + "/proof-seeded.json", "w"), indent=1)
print("throwaway id:", IID, "tasks:", ids)
