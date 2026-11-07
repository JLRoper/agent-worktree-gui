// A park written through POST /api/assistant/queue must carry its HOLD, not just its reason.
//
// The defect: `setTaskState` has accepted `{kind, value, since}` and the tab has drawn it since the hold landed, but
// the route's `state` case handed over `by` and `reason` and nothing else. So a park posted with
// `hold: {kind: "thread", …}` was written as a park with NO hold — the field was dropped between the request and the
// file — and the row then read `parked (manual)` to every reader, which means `settleTasks` had nothing to test and
// nothing could release it. The unit tests could not see it: `setTaskState` was right the whole time, and only the
// WIRE was wrong.
//
// What this file drives, against a real panel on a spare port and its real queue file:
//   1. a park with a `task` hold is stored, stamped with `since`, and read back by the route the tab calls — the raw
//      JSON, `readQueueFile`, and the route's own view must agree on the kind and the value;
//   2. a `path` hold on a directory that exists travels the same way (the second kind that needs nothing from the job
//      store, so the round trip is proved without a live run);
//   3. a hold that names nothing is a 400 whose sentence lists the kinds — never a park silently stored with no hold;
//   4. a hold that is ALREADY FALSE (the row it names is done) is refused at write time and the file is untouched;
//   5. the two-step park stays working: a hold written by `edit` and then claimed by `state` with no hold on the
//      payload (`undefined` means "the row's own", which is what that path depends on);
//   6. a plain `state` press with no hold still writes exactly what it wrote before.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { readQueueFile } from "../lib/assistant/queue.js";
import { startPanel } from "../tools/panel-testkit.mjs";

const TOKEN = "queue-hold-token";
const sha = (text) => createHash("sha256").update(text).digest("hex");
const slash = (p) => String(p).replace(/\\/g, "/");

const get = async (base, route) => {
  const res = await fetch(`${base}${route}`);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* an error page is read as text by the assertion that failed */
  }
  return { status: res.status, json, text };
};

const post = async (base, body, { token = TOKEN } = {}) => {
  const headers = { "Content-Type": "application/json" };
  if (token) headers["x-panel-token"] = token;
  const res = await fetch(`${base}/api/assistant/queue`, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* the assertion prints the body */
  }
  return { status: res.status, json, text };
};

test("a park posted with a hold is stored with it and read back through the route", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wtgui-queuehold-"));
  const logs = path.join(dir, "logs");
  await mkdir(path.join(logs, "assistants", "assistant-1"), { recursive: true });
  const queueFile = path.join(logs, "assistants", "assistant-1", "queue.json");
  // A directory a `path` hold can name and still be TRUE when it is written: the sandbox's own repos folder.
  const present = slash(path.join(dir, "repos"));
  await mkdir(present, { recursive: true });

  await writeFile(
    queueFile,
    JSON.stringify(
      {
        version: 3,
        nextId: 6,
        tasks: [
          { id: 1, title: "park me on a row", state: "queued", files: [], hold: null },
          { id: 2, title: "the blocker still open", state: "queued", files: [] },
          { id: 3, title: "park me on a path", state: "queued", files: [] },
          { id: 4, title: "the blocker already done", state: "done", files: [], doneAt: "2026-11-01T09:00:00.000Z", doneBy: "reader" },
          { id: 5, title: "the two-step park", state: "queued", files: [] },
        ],
      },
      null,
      1,
    ),
    "utf8",
  );

  const panel = await startPanel({
    dir,
    keep: true,
    token: TOKEN,
    config: {
      refreshSeconds: 3600,
      worktreeSeconds: 3600,
      midSeconds: 3600,
      dormantSeconds: 3600,
      slowSeconds: 3600,
      fetchSeconds: -1,
      assistant: { enabled: false },
      apiServer: { url: "http://127.0.0.1:9", key: "sandbox-key" },
    },
  });
  t.after(async () => {
    await panel.stop();
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  // ---- 1. a task hold: POST → file → route ---------------------------------------------------------
  const before = Date.now();
  const parked = await post(panel.base, {
    assistantId: "assistant-1",
    action: "state",
    id: 1,
    state: "parked",
    reason: "waiting on the blocker",
    hold: { kind: "task", value: "#2" },
  });
  assert.equal(parked.status, 200, parked.text.slice(0, 400));
  assert.equal(parked.json.ok, true, "the park was accepted");

  const onDisk = JSON.parse(await readFile(queueFile, "utf8"));
  const raw = onDisk.tasks.find((x) => x.id === 1);
  assert.equal(raw.state, "parked");
  assert.ok(raw.hold, `the hold survived the route, not just the reason: ${JSON.stringify(raw.hold)}`);
  assert.equal(raw.hold.kind, "task");
  assert.equal(raw.hold.value, "#2");
  const stamped = Date.parse(raw.hold.since);
  assert.ok(Number.isFinite(stamped), `the park stamps \`since\`: ${raw.hold.since}`);
  assert.ok(stamped >= before - 1_000 && stamped <= Date.now() + 1_000, `\`since\` is the write's own clock: ${raw.hold.since}`);
  assert.equal(raw.reason, "waiting on the blocker", "the reason travels beside the hold");

  // The queue's own schema carries it back (the same read the digest and the settle do).
  const { tasks: picked } = readQueueFile(queueFile);
  assert.deepEqual(picked.find((x) => x.id === 1).hold, raw.hold);

  // And the tab's own read carries it, with the hold judged against this queue: #2 is open, so the park is held.
  const view = await get(panel.base, "/api/assistant/queue?assistantId=assistant-1");
  assert.equal(view.status, 200, view.text.slice(0, 300));
  const seen = view.json.queue.tasks.find((x) => x.id === 1);
  assert.equal(seen.state, "parked");
  assert.deepEqual({ kind: seen.hold.kind, value: seen.hold.value, since: seen.hold.since }, raw.hold);
  assert.equal(seen.holdState.kind, "task");
  assert.equal(seen.holdState.held, true, "the view judges the stored hold, not a missing one");
  assert.match(seen.holdState.short, /#2/);

  // ---- 2. a path hold travels the same way ---------------------------------------------------------
  const pathPark = await post(panel.base, {
    assistantId: "assistant-1",
    action: "state",
    id: 3,
    state: "parked",
    reason: "until the tree is there",
    hold: { kind: "path", value: present },
  });
  assert.equal(pathPark.status, 200, pathPark.text.slice(0, 400));
  const atPath = JSON.parse(await readFile(queueFile, "utf8")).tasks.find((x) => x.id === 3);
  assert.equal(atPath.hold.kind, "path");
  assert.equal(atPath.hold.value, present);
  const pathView = (await get(panel.base, "/api/assistant/queue?assistantId=assistant-1")).json.queue.tasks.find((x) => x.id === 3);
  assert.equal(pathView.holdState.held, true, "the directory exists, so the hold is true");

  // ---- 3. a hold that names nothing is refused, and nothing is written -------------------------------
  const hashBefore = sha(await readFile(queueFile, "utf8"));
  for (const bad of [{ kind: "thread", value: "" }, { kind: "nonsense", value: "x" }, { value: "#2" }, "thread:#2"]) {
    const refused = await post(panel.base, { assistantId: "assistant-1", action: "state", id: 2, state: "parked", hold: bad });
    assert.equal(refused.status, 400, `a hold of ${JSON.stringify(bad)} is not a park: ${refused.text.slice(0, 300)}`);
    assert.match(refused.json.error, /hold/);
    assert.match(refused.json.error, /thread, job, task, path, manual/, "the refusal names every kind a hold may be");
  }
  assert.equal(sha(await readFile(queueFile, "utf8")), hashBefore, "every refused park wrote nothing");

  // ---- 4. a hold that is already false is refused at write time -------------------------------------
  const stale = await post(panel.base, {
    assistantId: "assistant-1",
    action: "state",
    id: 2,
    state: "parked",
    hold: { kind: "task", value: "#4" },
  });
  assert.equal(stale.status, 400, stale.text.slice(0, 300));
  assert.match(stale.json.error, /#4 is done/, "the refusal names the part of the hold that is false");
  assert.equal(sha(await readFile(queueFile, "utf8")), hashBefore, "a refused park leaves the file alone");
  assert.equal(JSON.parse(await readFile(queueFile, "utf8")).tasks.find((x) => x.id === 2).state, "queued");

  // ---- 5. the two-step park: `edit` writes the hold, `state` claims it with none on the payload ------
  const edited = await post(panel.base, { assistantId: "assistant-1", action: "edit", id: 5, hold: { kind: "task", value: "#2" } });
  assert.equal(edited.status, 200, edited.text.slice(0, 300));
  const claimed = await post(panel.base, { assistantId: "assistant-1", action: "state", id: 5, state: "parked", reason: "step two" });
  assert.equal(claimed.status, 200, claimed.text.slice(0, 300));
  const twoStep = JSON.parse(await readFile(queueFile, "utf8")).tasks.find((x) => x.id === 5);
  assert.equal(twoStep.state, "parked");
  assert.equal(twoStep.hold.kind, "task", "absent on the payload means the row's own hold, not a cleared one");
  assert.equal(twoStep.hold.value, "#2");

  // ---- 6. an explicit null clears, and a plain press still writes what it always did ----------------
  const cleared = await post(panel.base, { assistantId: "assistant-1", action: "state", id: 5, state: "queued" });
  assert.equal(cleared.status, 200, cleared.text.slice(0, 300));
  const requeued = JSON.parse(await readFile(queueFile, "utf8")).tasks.find((x) => x.id === 5);
  assert.equal(requeued.state, "queued");
  assert.equal(requeued.hold, null, "a requeue leaves no hold behind");

  const plain = await post(panel.base, { assistantId: "assistant-1", action: "state", id: 2, state: "running" });
  assert.equal(plain.status, 200, plain.text.slice(0, 300));
  const running = JSON.parse(await readFile(queueFile, "utf8")).tasks.find((x) => x.id === 2);
  assert.equal(running.state, "running");
  assert.equal(running.hold, null);
  assert.ok(running.startedAt, "the plain transition still stamps its own clock");
  assert.equal(running.reason, "", "running clears the reason as it always did");
});
