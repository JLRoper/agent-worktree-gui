# Remove the throwaway: the four queue tasks through the queue's own delete action, the wave records by removing the
# store file this seed created (there is no wave write route at all), and the initiative record from the copy's store
# (lib/initiatives.js has create/update/move and no delete). Then re-read and prove the copy is back to seven
# initiatives with zero waves, and that the reader's own panel never moved.
import json, os, urllib.request, urllib.error, datetime

BASE = os.environ.get("BASE", "http://127.0.0.1:7332")
LIVE = os.environ.get("LIVE", "http://127.0.0.1:7331")
HOME = os.environ.get("WAG_PROOF_HOME") or os.path.expanduser("~/wag-proof-home")
OUT = os.environ.get("WAG_PROOF_OUT") or os.path.expanduser("~")
TITLE = "Sketch proof: Menu SSO migration"


def call(base, method, path, body=None):
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(base + path, data=data, method=method, headers={"content-type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status, json.load(r)
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode("utf-8") or "{}")


def get(base, path):
    with urllib.request.urlopen(base + path, timeout=20) as r:
        return json.load(r)


def snapshot(base):
    doc = get(base, "/api/initiatives")
    rows = [(i["id"], i["title"], len(i.get("waves") or [])) for i in doc["initiatives"]]
    return doc, rows


# ---- what is there now -------------------------------------------------------------------------------------------
doc, rows = snapshot(BASE)
mine = [r for r in rows if r[1] == TITLE]
print("copy before:", len(rows), "initiatives;", "throwaway", mine)
if not mine:
    raise SystemExit("the throwaway is already gone - nothing to remove")
IID = mine[0][0]

# ---- 1. the queue tasks, through the queue's delete action --------------------------------------------------------
roster = get(BASE, "/api/assistant")
aids = [a.get("id") for a in (roster.get("assistants") or []) if a.get("id")]
removed = 0
for aid in aids:
    q = get(BASE, "/api/assistant/queue?assistantId=" + aid)
    for t in q.get("queue", {}).get("tasks", []):
        if t.get("waveId") in ("w.callback", "w.second", "w.flip"):
            status, res = call(BASE, "POST", "/api/assistant/queue", {"assistantId": aid, "action": "delete", "id": t["id"], "by": "assistant-3"})
            removed += 1
            print("task deleted:", status, "#" + str(t["id"]), t["title"][:44], json.dumps(res)[:60])

# ---- 2. the wave store: the file this seed wrote is removed whole -------------------------------------------------
waves_file = os.path.join(HOME, "state", "waves.json")
if os.path.exists(waves_file):
    os.remove(waves_file)
    print("waves.json removed:", waves_file)

# ---- 3. the initiative record: no delete route exists, so the copy's store is edited and the panel re-reads it ----
store = os.path.join(HOME, "state", "initiatives.json")
raw = json.load(open(store, encoding="utf-8"))
before = len(raw.get("initiatives") or [])
kept = [rec for rec in (raw.get("initiatives") or []) if rec.get("title") != TITLE]
raw["initiatives"] = kept
print("record removed:", before - len(kept))
# the tree rows attached for the throwaway go with it
for key in list((raw.get("trees") or {}).keys()):
    if (raw["trees"][key] or {}).get("initiative") == IID:
        del raw["trees"][key]
raw["savedAt"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
raw["updatedBy"] = "assistant-3"
json.dump(raw, open(store, "w", encoding="utf-8"), indent=1)
print("store records:", before, "->", len(raw.get("initiatives") or []))

# ---- 4. prove it gone, on the copy and on the reader's panel ------------------------------------------------------
doc, rows = snapshot(BASE)
print("copy after:", len(rows), "initiatives")
for r in rows:
    print("  -", r[1][:56], "waves", r[2])
print("waveStatus:", doc.get("waveStatus"))
print("throwaway present:", any(r[0] == IID for r in rows))
print("tasks left on any wave:", sum(1 for aid in aids for t in (get(BASE, "/api/assistant/queue?assistantId=" + aid).get("queue", {}).get("tasks", [])) if t.get("waveId")))

live, lrows = snapshot(LIVE)
print("live panel:", len(lrows), "initiatives, waves per initiative:", [r[2] for r in lrows], "waveStatus.found:", live.get("waveStatus", {}).get("found"))
json.dump({"copy": doc, "live": live}, open(OUT + "/proof-cleaned.json", "w"), indent=1)
print("saved", OUT + "/proof-cleaned.json")
