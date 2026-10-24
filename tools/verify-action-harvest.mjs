// A finished assistant turn's actions are read from the WHOLE reply, and each one is carried out on its own.
//
// Measured on the live panel: a SPAWN written in one turn produced no job, no alert and no journal line at all,
// while the NOTE under it applied normally — and the same for a TO. The actions were being read, and then the
// reply started arriving as one text line per paragraph instead of as one text line carrying the whole answer:
// `harvest` read the turn's prose with `lastProse`, which returns the LAST paragraph, so the only line it ever
// saw was the one the turn ended on. Whatever the assistant wrote last was carried out; everything above it was
// dropped silently. Every assistant turn up to 16:43Z on that box had exactly one text line and worked; from
// 18:52Z the same turns arrived as 5-8 lines and the run-creating actions above the final paragraph vanished.
//
//   node tools/verify-action-harvest.mjs
//
// This drives three REAL assistant turns through a stub gateway whose stream carries the reply the way the live
// one does — one paragraph per fragment, each opening with the blank line that starts a new paragraph — and then
// asks the panel what happened to them:
//
//   1. one turn carrying SPAWN, SPAWN IN, TO, WATCH, NOTE and RULE, with the NOTE last, exactly the shape that
//      used to lose the two spawns and the reply: one job per run-creating action, a note, a rule and a watch;
//   2. a turn carrying actions that cannot be carried out (a project that does not exist, a thread that is not
//      on the board) followed by a spawn that can: each drop is journaled with its reason and the last line still
//      starts its worker;
//   3. a turn whose thread lookup throws inside the injected job store: the two lines that touched it are
//      journaled with that reason and the spawn written after them still runs.
//
// No gateway, no git repo and no browser: the spawner is injected the way server.js injects `assistantSpawnRun`,
// and it creates its run through the same `jobs.create` the real one uses.
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const { Jobs } = await import("../lib/jobs.js");
const { Assistant, ASSISTANT_THREAD, parseActions, turnProse } = await import("../lib/assistant.js");

let failed = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}: ${JSON.stringify(got)}${ok ? "" : `  (wanted ${JSON.stringify(want)})`}`);
};
const ok = (name, got) => check(name, Boolean(got), true);

const dir = mkdtempSync(path.join(tmpdir(), "wtgui-action-harvest-"));
const existing = path.join(dir, "existing-tree").replace(/\\/g, "/");
mkdirSync(existing, { recursive: true });

// ---- the reply, in the shape the live stream carries it ------------------------------------------------------
// The first fragment opens the turn's first text line; every fragment after it begins with a blank line, which
// is the paragraph break `push()` in lib/jobs.js uses to open a NEW text line. That is what split a real reply
// into one line per paragraph, and it is what left the harvest reading only the last one.
const REQUEST = "Land the release, answer the worker and note what you did.";
const REPLY_PARAGRAPHS = [
  "On it — one worker in a new tree, one in the tree that already exists, a reply and a watch.",
  "SPAWN alpha | write the release notes for the alpha module and commit them",
  `SPAWN IN ${existing} | tidy the leftover files in that tree and say what you found`,
  "TO wtgui-worker-a: the gate fails on the fixture — rebuild and re-run it before reporting.",
  "WATCH wtgui-worker-a: finishes with the gate green or says what blocked it | 30",
  "RULE: A worker whose gate goes red re-runs it once after a rebuild before reporting a failure.",
  "NOTE: kept the harness reply short on purpose.",
];

// ---- a stub gateway -----------------------------------------------------------------------------------------
// POST /v1/runs answers with a run id; GET /v1/runs/{id}/events streams the reply for that session and ends the
// run. Any other route the panel uses is answered with something harmless.
const runs = new Map();
let runSeq = 0;
const replyFor = (thread) => (thread === ASSISTANT_THREAD ? REPLY_PARAGRAPHS : ["Acknowledged — I'll do that and report back."]);
// What the next assistant turn will answer with. Set before the turn is asked, because the stub hands the reply
// to whichever stream asks for it.
const setReply = (lines) => {
  REPLY_PARAGRAPHS.length = 0;
  REPLY_PARAGRAPHS.push(...lines);
};

const server = createServer((req, res) => {
  const url = String(req.url || "");
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") : {};
    if (req.method === "POST" && url === "/v1/runs") {
      const id = `run_${++runSeq}`;
      runs.set(id, { thread: body.session_id || "", input: body.input || "" });
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ run_id: id, session_id: body.session_id }));
      return;
    }
    if (req.method === "GET" && /^\/v1\/runs\/[^/]+\/events$/.test(url)) {
      const id = url.split("/")[3];
      const run = runs.get(id) || { thread: "" };
      const paragraphs = replyFor(run.thread);
      const frames = paragraphs.map((p, i) => ({ event: "message.delta", delta: i === 0 ? p : `\n\n${p}` }));
      const said = paragraphs.join("\n\n");
      frames.push({ event: "run.completed", output: said, usage: { total_tokens: 900, input_tokens: 800, output_tokens: 100 } });
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      let i = 0;
      const timer = setInterval(() => {
        if (i >= frames.length) {
          clearInterval(timer);
          res.end();
          return;
        }
        res.write(`data: ${JSON.stringify(frames[i++])}\n\n`);
      }, 4);
      return;
    }
    if (req.method === "GET" && /^\/v1\/runs\/[^/]+$/.test(url)) {
      const id = url.split("/")[3];
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ run_id: id, status: "completed", output: "" }));
      return;
    }
    if (req.method === "POST" && /\/v1\/runs\/[^/]+\/(steer|stop|approval|clarify)$/.test(url)) {
      res.writeHead(200, { "Content-Type": "application/json" }).end("{}");
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: { message: "no such route", code: "not_found" } }));
  });
});
await new Promise((open) => server.listen(0, "127.0.0.1", open));
const url = `http://127.0.0.1:${server.address().port}`;

// ---- the panel: a real job store, a real assistant, an injected spawner --------------------------------------
const projects = [
  { name: "alpha", path: path.join(dir, "alpha").replace(/\\/g, "/"), mainBranch: "main" },
  { name: "beta", path: path.join(dir, "beta").replace(/\\/g, "/"), mainBranch: "main" },
];
const spawns = [];
const events = [];
// Declared before the store that feeds it, the way server.js declares it: a job event arrives on the same tick
// as construction, and the observer is optional until the assistant exists.
let assistant = null;
const jobs = new Jobs({
  config: { jobsFile: path.join(dir, "jobs.json"), apiServer: { url, key: "stub" }, defaultCwd: dir },
  // The server's own wiring: every job event is handed to the assistant's observer, which is what reads a
  // finished turn's actions. Nothing in this script calls `harvest` directly.
  onEvent: (evt) => {
    events.push(evt);
    if (process.env.DEBUG_EVENTS && evt.type === "job") console.log(`    event ${evt.type} ${evt.job?.thread || ""} ${evt.job?.status || ""}`);
    try {
      assistant?.observe(evt);
    } catch (err) {
      console.log(`FAIL  an event threw into the store: ${String((err && err.message) || err)}`);
      failed++;
    }
  },
  onLog: () => {},
});

assistant = new Assistant({
  config: { jobsFile: path.join(dir, "jobs.json"), assistantFile: path.join(dir, "assistant.json"), defaultCwd: dir },
  jobs,
  getProjects: () => projects,
  getRows: () => [],
  getChildren: () => ({}),
  // The server's own spawner in miniature: the same `jobs.create` under the same kind of origin, so a job in the
  // store is the evidence that the action was carried out.
  spawner: async (spec) => {
    spawns.push(spec);
    const project = projects.find((p) => p.name === spec.project) || null;
    const cwd = spec.existing ? spec.target : project?.path || dir;
    return jobs.create({
      prompt: spec.prompt,
      cwd,
      existing: Boolean(spec.existing),
      worktree: false,
      ownerPath: cwd,
      origin: { kind: "assistant-spawn", project: spec.project || null },
    });
  },
  onEvent: () => {},
  onLog: () => {},
});
assistant.settings.autonomy = "auto";
assistant.settings.spawn = "auto";

// The store's own event stream is what harvests a finished turn, so nothing here calls harvest directly.
const waitFor = async (fn, seconds = 10) => {
  const until = Date.now() + seconds * 1000;
  for (;;) {
    const got = fn();
    if (got) return got;
    if (Date.now() > until) return null;
    await new Promise((r) => setTimeout(r, 40));
  }
};
const settled = (id) => waitFor(() => {
  const j = jobs.jobs.get(id);
  return j && j.status !== "running" && j.status !== "starting" ? j : null;
});
const jobsIn = (thread) => [...jobs.jobs.values()].filter((j) => j.thread === thread);
const journal = (kind) => assistant.journal.filter((e) => e.kind === kind);

// A worker thread already on the board: a TO and a WATCH need one to land on.
const seeded = await jobs.create({ prompt: "do the thing", thread: "wtgui-worker-a", cwd: existing, worktree: false, ownerPath: existing });
await settled(seeded.id);

try {
  // ---- 1. one turn, one line per paragraph, every action carried out ----------------------------------------
  console.log("a turn whose reply arrives as one paragraph per text line");
  const turn = await assistant.say(REQUEST);
  const finished = await settled(turn.id);
  ok("the assistant's own turn ran and finished", finished && finished.status === "done");
  await waitFor(() => spawns.length >= 2 && jobsIn("wtgui-worker-a").length >= 2, 6);

  const texts = (finished?.lines || []).filter((l) => l.kind === "text" && String(l.text || "").trim());
  check("the reply is stored as one text line per paragraph", texts.length, REPLY_PARAGRAPHS.length);
  const lastLine = String(texts.at(-1)?.text || "");
  ok("the line the turn ended on is the NOTE", lastLine.startsWith("NOTE:"));
  ok("…and no SPAWN or TO is in it — the shape that used to drop them", !/^\s*(SPAWN|TO)\b/m.test(lastLine));
  ok("the whole reply still carries them", /^\s*SPAWN alpha \|/m.test(turnProse(finished.lines)) && /^\s*TO wtgui-worker-a:/m.test(turnProse(finished.lines)));

  // One job per run-creating action: two spawns (one new tree, one existing) and one reply.
  check("the SPAWN line started one worker", spawns.filter((s) => !s.existing).length, 1);
  check("…in the project it named", spawns.find((s) => !s.existing)?.project, "alpha");
  check("the SPAWN IN line started one worker", spawns.filter((s) => s.existing).length, 1);
  check("…in the tree that already exists", spawns.find((s) => s.existing)?.target, existing);
  const spawnedThreads = [...jobs.jobs.values()].filter((j) => j.origin?.kind === "assistant-spawn").map((j) => j.thread).sort();
  check("two jobs exist for the two spawn lines", spawnedThreads.length, 2);
  const repl = jobsIn("wtgui-worker-a").filter((j) => j.reply);
  check("the TO line became one run in that thread", repl.length, 1);
  check("…carrying what the assistant wrote", /rebuild and re-run it/.test(repl[0]?.prompt || ""), true);
  check("every run-creating action is one job and nothing else was started", jobsIn(ASSISTANT_THREAD).length, 1);

  check("the NOTE applied", /kept the harness reply short/.test(assistant.state().notes), true);
  check("the RULE applied", assistant.state().rules.some((r) => /gate goes red/.test(r.text)), true);
  check("the WATCH applied", assistant.state().watches.some((w) => w.thread === "wtgui-worker-a" && w.minutes === 30), true);
  await waitFor(() => journal("sent").length >= 1 && journal("spawned").length >= 2, 6);
  check("and the journal says the reply went out", journal("sent").length, 1);
  check("…and that each worker was started, by the assistant", journal("spawned").filter((e) => /\(assistant\)$/.test(e.text)).length, 2);

  // ---- 2. lines that cannot be carried out are journaled, and the rest still run -----------------------------
  console.log("a dropped action is journaled with its reason, and does not stop the ones after it");
  setReply([
    "Taking the three lines in order.",
    "SPAWN no-such-project | do the impossible and report",
    "TO ghost-thread-9e: nobody is listening.",
    "WATCH ghost-thread-9e: nothing to watch here.",
    "SPAWN beta | the line after the failures still starts a worker",
  ]);
  const badTurn = await assistant.say("Two things I cannot do, then one I can.");
  const badDone = await settled(badTurn.id);
  ok("the second turn finished too", badDone && badDone.status === "done");
  await waitFor(() => spawns.some((s) => s.project === "beta"), 6);

  const dropped = journal("spawn-failed");
  check("the SPAWN naming an unknown project was journaled", dropped.length, 1);
  ok("…with the line and the reason", /SPAWN no-such-project/.test(dropped[0]?.text || "") && /unknown project: no-such-project/.test(dropped[0]?.text || ""));
  check("the TO with no thread was journaled", journal("draft-skipped").length, 1);
  check("…saying there is no such thread", journal("draft-skipped")[0]?.text, "no such thread on the board");
  check("the WATCH with no thread was journaled", journal("watch-skipped").length, 1);
  ok("…with the same reason", /no such thread on the board/.test(journal("watch-skipped")[0]?.text || ""));
  check("the line after the three failures still started its worker", spawns.filter((s) => s.project === "beta").length, 1);
  ok("…and a job exists for it", [...jobs.jobs.values()].some((j) => j.origin?.project === "beta"));

  // ---- 3. an injected handler that throws is one line's failure, not the harvest's ---------------------------
  console.log("a thread lookup that throws is one line's failure");
  const realFirst = jobs.firstOfThread.bind(jobs);
  jobs.firstOfThread = (thread) => {
    if (thread === "wtgui-explodes") throw new Error("the job store is unreachable");
    return realFirst(thread);
  };
  setReply([
    "One thread blows up when I look at it.",
    "TO wtgui-explodes: this one will trip the injected store.",
    "WATCH wtgui-explodes: so will this one | 15",
    "SPAWN alpha | written after two handlers threw, and it still has to run",
  ]);
  const boom = await assistant.say("Try the thread that explodes.");
  await settled(boom.id);
  await waitFor(() => spawns.some((s) => /after two handlers threw/.test(s.prompt)), 6);
  check("the TO that threw is journaled", journal("send-failed").length, 1);
  ok("…naming the line and the handler's own words", /TO wtgui-explodes/.test(journal("send-failed")[0]?.text || "") && /the job store is unreachable/.test(journal("send-failed")[0]?.text || ""));
  check("the WATCH that threw is journaled", journal("watch-failed").length, 1);
  ok("…with the same reason", /the job store is unreachable/.test(journal("watch-failed")[0]?.text || ""));
  check("the spawn written after both of them still ran", spawns.filter((s) => /after two handlers threw/.test(s.prompt)).length, 1);
  ok("…and no turn was ever left half-done: the harvest never threw into the store", !journal("harvest-failed").length);

  // ---- 4. the pieces on their own ---------------------------------------------------------------------------
  console.log("the reply is read whole, and a resent paragraph is not read twice");
  check(
    "three paragraphs are joined, so a SPAWN above the last one is seen",
    parseActions(turnProse([{ kind: "text", text: "prose" }, { kind: "text", text: "SPAWN alpha | one" }, { kind: "text", text: "NOTE: last" }])).spawn.length,
    1,
  );
  const resent = turnProse([
    { kind: "text", text: "prose\n\nSPAWN alpha | one" },
    { kind: "text", text: "prose\n\nSPAWN alpha | one\n\nNOTE: last" },
  ]);
  check("a block resent in full replaces the earlier one", resent.split("prose").length - 1, 1);
  check("…so its spawn is counted once", parseActions(resent).spawn.length, 1);
  check("tool lines are not prose", turnProse([{ kind: "tool", text: "SPAWN alpha | not prose" }, { kind: "text", text: "the answer" }]), "the answer");

  // A turn is harvested once: the same finished job through the store again starts nothing.
  const before = spawns.length;
  assistant.observe({ type: "job", job: jobs.summary(jobs.jobs.get(turn.id)) });
  await new Promise((r) => setTimeout(r, 120));
  check("re-reading a finished turn starts nothing a second time", spawns.length, before);

  // ---- 5. the branches the harvest guards, still behaving ------------------------------------------------------
  console.log("draft autonomy offers the reply instead of sending it");
  assistant.settings.autonomy = "draft";
  setReply(["One reply, held for the reader.", "TO wtgui-worker-a: hold this until the reader says go."]);
  const draft = await assistant.say("Draft one for me.");
  await settled(draft.id);
  const card = await waitFor(() => assistant.state().alerts.find((a) => a.rule === "question" && a.draft?.thread === "wtgui-worker-a"), 6);
  ok("draft mode files one card", card && /drafted a reply/.test(card.title));
  check("…and sends nothing", jobsIn("wtgui-worker-a").filter((j) => /hold this until/.test(j.prompt)).length, 0);
  check("…with the draft journaled", journal("draft").length, 1);

  console.log("spawn off is journaled, not dropped");
  assistant.settings.autonomy = "auto";
  assistant.settings.spawn = "off";
  setReply(["SPAWN alpha | this one is switched off"]);
  const off = await assistant.say("Try a spawn with it switched off.");
  await settled(off.id);
  await waitFor(() => journal("spawn-skipped").length >= 1, 6);
  check("off mode journals the reason", journal("spawn-skipped").length, 1);
  ok("…and starts nothing", !spawns.some((s) => /switched off/.test(s.prompt)));

  console.log("spawn ask still drafts instead of starting");
  assistant.settings.spawn = "ask";
  setReply(["SPAWN alpha | offered as a card, not started"]);
  const ask = await assistant.say("Offer that one.");
  await settled(ask.id);
  await waitFor(() => assistant.state().alerts.some((a) => a.rule === "spawn"), 6);
  check("ask mode files one card", assistant.state().alerts.filter((a) => a.rule === "spawn").length, 1);
  check("…and starts nothing", spawns.filter((s) => /offered as a card/.test(s.prompt)).length, 0);
  check("…with the draft journaled", journal("spawn-draft").length, 1);
} finally {
  console.log("");
  console.log("journal, oldest first:");
  for (const e of assistant.journal) console.log(`  ${e.kind.padEnd(15)} ${e.thread || "-"} — ${String(e.text).slice(0, 96)}`);
  server.close();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* the temp tree is the OS's problem */
  }
}

console.log(failed ? `RESULT: ${failed} FAILED` : "RESULT: ALL PASS");
process.exit(failed ? 1 : 0);
