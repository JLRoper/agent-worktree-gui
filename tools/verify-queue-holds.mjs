// Does a park carry a release condition the PANEL can test — and does a lane order two rows that share a file?
//
//   node tools/verify-queue-holds.mjs                     # this checkout, one sandbox panel
//   node tools/verify-queue-holds.mjs --root <dir>        # serve a `git archive` export of another build (RED PROOF)
//   node tools/verify-queue-holds.mjs --keep              # leave the sandbox on disk
//
// THE CLAIM. A parked row used to be prose: `reason`, clipped to 100 characters in the digest at
// lib/assistant/queue.js:583, and never re-examined — `settleTasks` returned early for every state that was not
// `running` (:614). Three rows on the reader's board were parked for hours on conditions that had already stopped
// being true. This build gives the park a field, {kind, value, since}, and makes the field do work:
//
//   (1) a park stores the hold, and the park's own clock stamps `since`;
//   (2) a hold that names nothing, or one that is ALREADY FALSE when the park is written, is REFUSED by the write with
//       a 400 naming the part that is false — not written and released on the next tick;
//   (3) a hold on a thread whose run has ended is released to `queued` by the panel's own sweep, with
//       `hold ended: <kind> <value> — <evidence>` as the reason, read back through the API;
//   (4) a path that is gone releases the row the same way;
//   (5) a park with NO hold is a manual park: the digest says `parked (manual)` and it is STILL parked after several
//       sweeps with every job in the store terminal. There is no TTL and nothing here invents one;
//   (5b) a manual park whose REASON names a task id that is already done is never released either — but the digest
//       says the reason is stale (`parked (manual, stale reason: #N is done)`), so the board does not leave a later
//       turn to remember that the row it waits for has landed. A reason naming an OPEN row keeps the plain `(manual)`;
//   (6) the digest puts the hold FIRST, before the 90-character title and the 100-character reason, so a 200-character
//       title and reason cannot clip the only part a reader can act on;
//   (7) two rows that claim the same file are ONE lane, ordered by id, the head marked `(head)` and the row behind it
//       naming the head — and nothing is started by any of it.
//
// RED PROOF. Everything above is asserted through the real `/api/assistant/queue` of a panel booted from `--root`.
// Run this file against a `git archive origin/main` export at 0.75.0 and it fails at (5b): that build reports every
// hold-less park as `parked (manual)`, whatever its reason says, so a row parked on a task that already reads done
// stays parked with nothing on the board saying why the sentence is no longer true. (The export has no
// tools/verify-queue-holds.mjs of its own; run THIS file with --root pointing at it.)
//
// Everything runs in a sandbox of its own: `tools/panel-testkit.mjs` gives it a throwaway data directory, a scanned
// repo and a free port, `assistant.enabled` is false and `apiServer` is a dead port, so nothing can spawn a run. The
// live board on 7331 is never touched and its listener count is compared before and after.
//
// The one thing a sandbox cannot have is a LIVE run: the boot reconcile flips a seeded `running` job to `interrupted`
// (there is no gateway to re-attach to), so the "a live thread holds the row" half is pinned in test/queue-holds.test.js
// against the handler itself. Everything the SWEEP does is proved here, from the store and the filesystem.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (name, dflt = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : dflt;
};
const TREE = path.resolve(opt("--root", path.resolve(HERE, "..")));
const KEEP = argv.includes("--keep");

let checks = 0;
let failures = 0;
const ok = (name, cond, extra = "") => {
  checks += 1;
  if (cond) console.log(`PASS  ${name}${extra ? `: ${extra}` : ""}`);
  else {
    failures += 1;
    console.log(`FAIL  ${name}${extra ? ` — ${extra}` : ""}`);
  }
};
const check = (name, got, want) => {
  checks += 1;
  const pass = JSON.stringify(got) === JSON.stringify(want);
  if (!pass) failures += 1;
  console.log(
    `${pass ? "PASS" : "FAIL"}  ${name}${pass ? `: ${JSON.stringify(got)}` : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`,
  );
};
const note = (text) => console.log(`      ${text}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const slash = (p) => String(p || "").replace(/\\/g, "/");
// The same listener probe the other gates use: this run must not add a listener to the reader's board.
const listenersOn = (port) => {
  let out = "";
  try {
    out = execSync("netstat -ano", { encoding: "utf8", windowsHide: true });
  } catch (e) {
    out = String((e && e.stdout) || "");
  }
  return out.split(/\r?\n/).filter((l) => l.includes(`:${port} `) && l.includes("LISTENING")).length;
};

const DEAD_THREAD = "wtgui-a-run-that-ended-bbbb22";
const DEAD_JOB = "bbbb2222";

let panel = null;
try {
  const { startPanel } = await import(pathToFileURL(path.join(TREE, "tools", "panel-testkit.mjs")).href);
  const dir = mkdtempSync(path.join(tmpdir(), "wtgui-holds-"));
  mkdirSync(path.join(dir, "logs"), { recursive: true });
  // A job store with one run that has already ENDED. This is the fact the sweep will read: the thread a park names has
  // no live run and its last run is terminal, so the hold is over. (`lines: []` is what a loaded card needs to draw.)
  const jobs = [
    {
      id: DEAD_JOB,
      thread: DEAD_THREAD,
      status: "done",
      startedAt: "2026-11-02T21:40:00.000Z",
      endedAt: "2026-11-02T22:43:01.664Z",
      prompt: "probe: a run that ended",
      cwd: dir,
      lines: [],
      artifacts: [],
      attachments: [],
    },
  ];
  writeFileSync(path.join(dir, "logs", "jobs.json"), JSON.stringify({ savedAt: new Date().toISOString(), jobs }), "utf8");

  const liveBefore = listenersOn(7331);
  panel = await startPanel({
    dir,
    keep: KEEP,
    config: {
      jobsFile: path.join(dir, "logs", "jobs.json"),
      scanRoots: [dir],
      refreshSeconds: 60,
      worktreeSeconds: 60,
      midSeconds: 60,
      // The sentry's own clock, and the sweep rides it: 2 s is the fastest tick the panel allows (`Math.max(2, …)`).
      // No gateway, no keys, no spawn: this gate is about a store and a digest.
      assistant: { enabled: false, seconds: 2, maxWakesPerHour: 0 },
      apiServer: { url: "http://127.0.0.1:9", key: "sandbox" },
    },
    env: { API_SERVER_KEY: "", PANEL_TOKEN: "" },
  });
  note(`tree  ${TREE}`);
  note(`panel ${panel.base} (own data dir; live board 7331 untouched: ${liveBefore} listener(s) before)`);
  ok("the sandbox is not the reader's board", panel.port !== 7331, `port ${panel.port}`);
  ok("the sandbox is bound on its own port", listenersOn(panel.port) >= 1, `${listenersOn(panel.port)} listener(s)`);

  const GET = async (p) => {
    const r = await fetch(`${panel.base}${p}`);
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  const POST = async (body) => {
    const r = await fetch(`${panel.base}/api/assistant/queue`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ assistantId: "assistant-1", ...body }),
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  const queue = async () => (await GET("/api/assistant/queue?assistantId=assistant-1")).body.queue || { tasks: [], digest: [] };
  const task = async (id) => (await queue()).tasks.find((t) => t.id === id) || null;
  const lineFor = async (id) => (await queue()).digest.find((l) => new RegExp(`^- [⏸●○✓] #${id} `).test(l)) || "";
  const add = (payload) => POST({ action: "add", ...payload });
  // The sweep is the sentry's, so a change lands within one tick; polling keeps the gate honest about WHEN.
  const waitState = async (id, want, timeoutMs = 20_000) => {
    const until = Date.now() + timeoutMs;
    for (;;) {
      const t = await task(id);
      if (t && t.state === want) return t;
      if (Date.now() > until) return t;
      await sleep(250);
    }
  };

  // ---- 1. the store ----------------------------------------------------------------------------------
  console.log("\n== the queue store, through the route ==");
  const first = await GET("/api/assistant/queue?assistantId=assistant-1");
  ok("GET one assistant's queue answers 200", first.status === 200);
  ok("the queue file is found at boot", first.body.queue?.found === true, slash(first.body.queue?.file));
  ok("…and it is really on disk", Boolean(first.body.queue?.file) && existsSync(first.body.queue.file));

  console.log("\n== the tasks this gate drives ==");
  const t1 = await add({ title: "the target that is finished" });
  const t2 = await add({ title: "the row that waits on it", files: ["lib/assistant/queue.js"] });
  const t3 = await add({ title: "parked by hand, no hold", files: ["lib/assistant/queue.js"] });
  const t4 = await add({ title: "held on a thread that ended" });
  check("four tasks, ids 1..4, all queued", [t1, t2, t3, t4].map((r) => [r.status, r.body.task?.id, r.body.task?.state]), [
    [200, 1, "queued"],
    [200, 2, "queued"],
    [200, 3, "queued"],
    [200, 4, "queued"],
  ]);
  const done1 = await POST({ action: "state", id: 1, state: "done", by: "reader" });
  ok("#1 is finished (it is what a refused park will point at)", done1.body.task?.state === "done");

  // ---- 2. the write-time refusal ----------------------------------------------------------------------
  console.log("\n== a park whose hold is already false is refused AT THE WRITE ==");
  const badShape = await POST({ action: "edit", id: 2, hold: { kind: "moon", value: "x" } });
  ok(
    "a hold of an unknown kind is refused, not stored",
    badShape.status === 400 && /needs a kind/.test(badShape.body.error || ""),
    `${badShape.status} ${badShape.body.error || ""}`,
  );

  const onDone = await POST({ action: "edit", id: 2, hold: { kind: "task", value: "#1" } });
  ok("a valid hold can be put on the row first (the two-step the route needs)", onDone.status === 200 && onDone.body.task?.hold?.kind === "task", JSON.stringify(onDone.body.task?.hold));
  const refuseDone = await POST({ action: "state", id: 2, state: "parked", reason: "wait for #1" });
  check("…and the PARK is refused", refuseDone.status, 400);
  ok(
    "…naming the part that is false",
    /cannot park #2 on task #1: #1 is done/.test(refuseDone.body.error || ""),
    refuseDone.body.error,
  );
  ok("…and the row was not parked", (await task(2))?.state === "queued", JSON.stringify((await task(2))?.state));

  const gonePath = path.join(dir, "a-file-that-was-already-deleted.txt");
  await POST({ action: "edit", id: 2, hold: { kind: "path", value: gonePath } });
  const refusePath = await POST({ action: "state", id: 2, state: "parked", reason: "wait for a file" });
  check("a park on a path that is already gone is refused too", refusePath.status, 400);
  ok("…with the path in the sentence", /cannot park #2 on path .*is gone/.test(refusePath.body.error || ""), refusePath.body.error);

  // ---- 3. a valid park, and what the digest says about it ----------------------------------------------
  console.log("\n== a real park: the hold is stored, stamped, and rendered FIRST ==");
  const holdOnOpen = await POST({ action: "edit", id: 2, hold: { kind: "task", value: 3 } });
  ok("the hold names the open row #3", holdOnOpen.body.task?.hold?.value === 3 || holdOnOpen.body.task?.hold?.value === "3", JSON.stringify(holdOnOpen.body.task?.hold));
  const parked2 = await POST({ action: "state", id: 2, state: "parked", reason: "waiting on #3 to land" });
  ok("#2 parks", parked2.status === 200 && parked2.body.task?.state === "parked", JSON.stringify({ state: parked2.body.task?.state }));
  check("…storing {kind, value}", [parked2.body.task?.hold?.kind, String(parked2.body.task?.hold?.value)], ["task", "3"]);
  ok("…and stamping `since`", Number.isFinite(Date.parse(parked2.body.task?.hold?.since || "")), parked2.body.task?.hold?.since);

  const onDisk = JSON.parse(readFileSync(parked2.body.queue.file, "utf8")).tasks.find((t) => t.id === 2);
  check("the file on disk carries the hold, not just the answer", [onDisk?.hold?.kind, String(onDisk?.hold?.value)], ["task", "3"]);

  const line2 = await lineFor(2);
  ok("the digest says `parked held by #3 since HH:MM`", /^- ⏸ #2 parked held by #3 since \d{2}:\d{2} · /.test(line2), line2);
  ok("…FIRST: ahead of the title", line2.indexOf("parked held by #3") < line2.indexOf("the row that waits on it"), line2.slice(0, 90));
  ok("…and the reason is still last on the line", /· PARKED: waiting on #3 to land$/.test(line2), line2.slice(-60));

  // ---- 4. the sweep releases a hold whose thread has ended ---------------------------------------------
  console.log("\n== the sweep releases a hold whose thread has ended ==");
  const onDead = await POST({ action: "edit", id: 4, hold: { kind: "thread", value: DEAD_THREAD } });
  ok("the hold names a thread the job store has a run for", onDead.body.task?.hold?.value === DEAD_THREAD, JSON.stringify(onDead.body.task?.hold));
  const parked4 = await POST({ action: "state", id: 4, state: "parked", reason: "the resume run is still going" });
  ok("#4 parks on it (the route has no job store, so it cannot refuse this one)", parked4.status === 200 && parked4.body.task?.state === "parked", JSON.stringify({ status: parked4.status, state: parked4.body.task?.state }));
  const held = await lineFor(4);
  ok(
    "…and the digest says the thread it waits on (or the release has already landed and says so)",
    /^- ⏸ #4 parked on thread bbbb22 /.test(held) || /^hold ended: thread bbbb22 /.test((await task(4))?.reason || ""),
    held || (await task(4))?.reason,
  );

  const released = await waitState(4, "queued");
  check("the panel's own sweep puts it back in the queue", released?.state, "queued");
  check(
    "…with `hold ended: thread <value> — ended <status> HH:MM` as its reason",
    released?.reason,
    `hold ended: thread ${DEAD_THREAD} — ended done 22:43`,
  );
  ok("…and the hold is gone with the park", released?.hold === null, JSON.stringify(released?.hold));

  // ---- 5. a manual park is never released ---------------------------------------------------------------
  console.log("\n== a park with no hold is manual, and NEVER releases ==");
  const manual = await POST({ action: "state", id: 3, state: "parked", reason: "needs a decision plus an offline gradle run" });
  ok("#3 parks with no hold at all", manual.body.task?.state === "parked" && manual.body.task?.hold === null, JSON.stringify({ state: manual.body.task?.state, hold: manual.body.task?.hold }));
  const manualLine = await lineFor(3);
  ok("the digest renders `parked (manual)`", /^- ⏸ #3 parked \(manual\) · /.test(manualLine), manualLine);
  // Three full sweeps on the panel's own 2 s clock, with every job in the store terminal.
  await sleep(7000);
  const stillParked = await task(3);
  check("…and it is STILL parked three sweeps later", [stillParked?.state, stillParked?.hold], ["parked", null]);
  ok("…with its reason the reader's own", stillParked?.reason === "needs a decision plus an offline gradle run", stillParked?.reason);

  // ---- 5b. a manual park whose reason names a DONE row: the board says the reason is stale -----------------
  console.log("\n== a hold-less park whose reason names a done row says the reason is STALE ==");
  // The row that started this: parked on `#38` in prose (no hold at all), still parked twenty minutes after #38 landed.
  // #1 is this gate's done row, and the sentence names it the way a reader writes one — a task id, then a PR number.
  const stale = await add({ title: "parked on prose that named a row since finished" });
  const staleParked = await POST({ action: "state", id: stale.body.task.id, state: "parked", reason: "blocked on #1 landing as PR #276" });
  ok("it parks with no hold at all (a prose park, like the ones already on disk)", staleParked.status === 200 && staleParked.body.task?.hold === null, JSON.stringify({ status: staleParked.status, hold: staleParked.body.task?.hold }));
  const staleLine = await lineFor(stale.body.task.id);
  ok(
    "the digest says the reason is stale, naming the row that ended it",
    /^- ⏸ #\d+ parked \(manual, stale reason: #1 is done\) · /.test(staleLine),
    staleLine,
  );
  ok("…with the reader's own sentence still last on the line", /· PARKED: blocked on #1 landing as PR #276$/.test(staleLine), staleLine.slice(-70));

  // A reason naming a row that is still OPEN says nothing is stale: the marker is about a fact that has ENDED.
  const open = await add({ title: "parked on prose naming a row still queued" });
  const openParked = await POST({ action: "state", id: open.body.task.id, state: "parked", reason: "waiting on #2, which is still queued" });
  ok("a prose park naming an OPEN row keeps the plain `(manual)`", /^- ⏸ #\d+ parked \(manual\) · /m.test(await lineFor(openParked.body.task.id)), await lineFor(openParked.body.task.id));

  // It is never released: the marker is a read, and this row rides the same three-sweep wait as #3 above.
  await sleep(7000);
  const staleStill = await task(stale.body.task.id);
  check("…and it is STILL parked after three more sweeps", [staleStill?.state, staleStill?.hold], ["parked", null]);
  ok("…with its reason untouched — nothing here writes a hold out of prose", staleStill?.reason === "blocked on #1 landing as PR #276", staleStill?.reason);
  const staleAgain = await lineFor(stale.body.task.id);
  ok("…and the digest says the same thing on the next sweep (idempotent)", staleAgain === staleLine, `${staleAgain === staleLine ? "same line" : "the line moved"}`);

  // ---- 6. a path hold releases when the path goes ------------------------------------------------------
  console.log("\n== a path hold releases when the path is gone ==");
  const watched = path.join(dir, "watched-file.txt");
  writeFileSync(watched, "here\n", "utf8");
  const held5 = await add({ title: "held on a file that will be deleted" });
  await POST({ action: "edit", id: held5.body.task.id, hold: { kind: "path", value: watched } });
  const parked5 = await POST({ action: "state", id: held5.body.task.id, state: "parked", reason: "wait for the file" });
  ok("a path that EXISTS parks fine (the refusal is about the fact, not the kind)", parked5.status === 200 && parked5.body.task?.state === "parked", JSON.stringify({ status: parked5.status, state: parked5.body.task?.state }));
  ok("…and the digest names the path", /parked on path .*watched-file\.txt \(exists\)/.test(await lineFor(held5.body.task.id)), await lineFor(held5.body.task.id));
  rmSync(watched, { force: true });
  const releasedPath = await waitState(held5.body.task.id, "queued");
  check("deleting the file releases the row", releasedPath?.state, "queued");
  ok("…with the path and the fact in the reason", /^hold ended: path .*watched-file\.txt — .* is gone$/.test(releasedPath?.reason || ""), releasedPath?.reason);

  // ---- 7. the lane ------------------------------------------------------------------------------------
  console.log("\n== a lane orders two rows that share a file ==");
  const a = await add({ title: "first in the shared file", files: ["lib/assistant/queue.js"] });
  const b = await add({ title: "second in the shared file", files: ["lib/assistant/queue.js", "test/queue-holds.test.js"] });
  const lines = (await queue()).digest;
  const lineA = lines.find((l) => l.includes(`#${a.body.task.id} queued`)) || "";
  const lineB = lines.find((l) => l.includes(`#${b.body.task.id} queued`)) || "";
  ok("the lower id is the lane head", /· lane lib\/assistant\/queue\.js \(head\)$/.test(lineA), lineA);
  ok(
    "…and the row behind it names the head and the lane",
    new RegExp(`(· waiting on #${a.body.task.id} \\(lane lib/assistant/queue\\.js\\)|· lane lib/assistant/queue\\.js after #${a.body.task.id})$`).test(lineB),
    lineB,
  );
  ok(
    "…in id order, on lines that already exist",
    lines.indexOf(lineA) >= 0 && lines.indexOf(lineB) > lines.indexOf(lineA),
    `#${a.body.task.id} at ${lines.indexOf(lineA)}, #${b.body.task.id} at ${lines.indexOf(lineB)}`,
  );
  const stray = lines.find((l) => l.includes("parked by hand, no hold")) || "";
  ok("a row that shares no file carries no lane", !/· lane /.test(stray), stray);

  // ---- 8. the clip cannot eat the hold -----------------------------------------------------------------
  console.log("\n== the hold survives a 200-character title and reason ==");
  const longTitle = `T${"t".repeat(199)}`;
  const longReason = `R${"r".repeat(199)} waiting for the shared file`;
  const long = await add({ title: longTitle, detail: "x" });
  await POST({ action: "edit", id: long.body.task.id, hold: { kind: "task", value: a.body.task.id } });
  const longParked = await POST({ action: "state", id: long.body.task.id, state: "parked", reason: longReason });
  ok("the row parks on the open lane head", longParked.body.task?.state === "parked", JSON.stringify({ status: longParked.status, error: longParked.body.error }));
  const longLine = await lineFor(long.body.task.id);
  ok("the hold is first, intact", new RegExp(`^- ⏸ #${long.body.task.id} parked held by #${a.body.task.id} since \\d{2}:\\d{2} · `).test(longLine), longLine.slice(0, 110));
  ok("…the title is clipped after it", longLine.indexOf("parked held by") < longLine.indexOf("Ttt"), `hold at ${longLine.indexOf("parked held by")}, title at ${longLine.indexOf("Ttt")}`);
  const reasonPart = longLine.slice(longLine.indexOf("PARKED: ") + 8);
  ok("…and the reason is clipped to its 100 characters, at the end", reasonPart.length <= 100 && reasonPart.startsWith("Rr"), `${reasonPart.length} chars`);

  console.log(`\nsandbox ${panel.dir}${KEEP ? " (kept)" : ""}`);
  check("the live board's listener count is unchanged by this run", listenersOn(7331), liveBefore);
} catch (err) {
  failures += 1;
  console.log(`\nFAIL  the run threw: ${String((err && err.stack) || err)}`);
  if (panel) console.log(`--- panel log (tail)\n${String(panel.log()).split(/\r?\n/).slice(-25).join("\n")}`);
} finally {
  if (panel && !KEEP) {
    try {
      await panel.stop();
    } catch {
      /* the verdict does not depend on the cleanup */
    }
  }
}

console.log("\n== summary ==");
console.log(`${checks - failures}/${checks} checks held`);
console.log("WHAT WAS DRIVEN: a panel booted from the checkout under test over its own data directory and a job store with");
console.log("one ENDED run — its queue route (add / edit / state), the write-time refusal of a hold that is already false, a");
console.log("hold released by the sentry's own sweep, a manual park that stayed parked across three sweeps, a prose park whose");
console.log("reason names a done row reading `stale reason` and staying parked too, a path hold released when the file was");
console.log("deleted, and the digest: the hold first, the reason last, the lane head named.");
if (!failures) console.log("QUEUE-HOLDS-OK");
process.exitCode = failures ? 1 : 0;
