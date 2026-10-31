// The TODO list on a worktree: one list per tree, written by the assistant, kept current by every agent in it, read
// by the row.
//
//   node tools/verify-todo-section.mjs
//
// What it proves, in the order the brief asks for it:
//
//   (a) the folded line reads the OLDEST item still open — the LOWEST id whose status is todo or doing — even when a
//       LATER item was completed first, with a done/total count beside it, and the unfolded section lists every item
//       with its status, owner and age (quoted from the live DOM, over a real sandbox panel)
//   (a2) each item's owner/by/age bullets are a disclosure of their own: FOLDED until that item's control is opened,
//       opened by click or by Enter/Space, folded again without touching the row, remembered per worktree + item
//       across a repaint AND a reload, and never allowed to take the caret out of the item's own edit box
//   (b) a list seeded by the assistant's own `TODO` line, then a worker's `TODO DONE <id>` and `TODO ADD <text>` read
//       out of its FINAL message and applied to that same list, with the journal entries quoted
//   (c) the block a worker's brief carries — the list WITH its ids and the standing instruction to reconcile against
//       its own commits — read out of the run body the gateway actually received, and the same block on a revive
//   (d) the reconcile prompt on a card whose run left commits and claimed nothing (with the commits it saw, and a
//       PROPOSAL — never a completion)
//   (e) the reader adding, completing and reopening an item, and the list surviving a panel restart
//   (f) a `TODO DONE 99` for an id that does not exist: said on the card, not silently dropped
//
// Three phases, and each says which parts it DROVE and which it only read:
//   * the store and its rules, driven directly (lib/todos.js)
//   * the Jobs level, driven against a stub Runs API over a real git worktree: a real `jobs.create`, a real run body,
//     a real settle and a real harvest
//   * a real sandbox panel over HTTP (its own PANEL_CONFIG, port, logs and store), and headless Chromium over it
//
// The browser half needs a Playwright install. Point the script at one with PANEL_PLAYWRIGHT_ROOT (a directory holding
// node_modules/playwright, or the package itself); without one the script says BROWSER-HALF-NOT-RUN and exits non-zero
// rather than passing on a half that never ran.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPlaywright } from "./browser.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");

const { TodoLists, oldestOpen, parseTodoLines, todoBlock, proposeClosed, todoKey } = await import("../lib/todos.js");
const { Jobs } = await import("../lib/jobs.js");
const { parseActions } = await import("../lib/assistant/actions.js");
const { lastWords } = await import("../lib/completion.js");

let checks = 0;
let failures = 0;
const check = (name, got, want) => {
  checks += 1;
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? `: ${JSON.stringify(got)}` : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
};
const ok = (name, cond, extra = "") => {
  checks += 1;
  if (cond) console.log(`PASS  ${name}${extra ? `: ${extra}` : ""}`);
  else {
    failures += 1;
    console.log(`FAIL  ${name}${extra ? ` — ${extra}` : ""}`);
  }
};
const note = (text) => console.log(`      ${text}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, { timeoutMs = 60_000, stepMs = 500, what = "condition" } = {}) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    let got = false;
    try {
      got = await fn();
    } catch {
      got = false;
    }
    if (got) return true;
    if (Date.now() > until) {
      console.log(`      (timed out after ${timeoutMs}ms waiting for ${what})`);
      return false;
    }
    await sleep(stepMs);
  }
}
const git = (dir, args) => {
  try {
    return { ok: true, out: execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", windowsHide: true }).trim() };
  } catch (e) {
    return { ok: false, out: String((e && e.stdout) || "").trim(), err: String((e && e.message) || e) };
  }
};
const norm = (p) => String(p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
// The store's own path form: slashes, no trailing slash, CASE KEPT — a tree's path is part of the key it is filed
// under, and a lowercased key is a key that never matches.
const slash = (p) => String(p || "").replace(/\\/g, "/").replace(/\/+$/, "");
const freePort = () =>
  new Promise((resolve, reject) => {
    const s = createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

// ---- a stub gateway ----------------------------------------------------------------------------------------------
// Exactly what lib/jobs.js asks of a real one, plus one thing this test needs: the OUTPUT a run ends with, so a
// worker's FINAL message (the channel the harvest reads) can be driven end to end. `queue` holds the next outputs.
function makeStub() {
  const state = { runs: new Map(), bodies: [], queue: [], seq: 0 };
  const timers = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const json = (code, body) => res.writeHead(code, { "Content-Type": "application/json" }).end(JSON.stringify(body));
    if (url.pathname === "/v1/capabilities") {
      return json(200, {
        version: "0.22.2-stub",
        features: { run_submission: true, run_events_sse: true, run_steer: true, run_stop: true, run_approval_response: true, run_cwd: true },
      });
    }
    if (url.pathname === "/v1/runs" && req.method === "POST") {
      let raw = "";
      req.on("data", (d) => (raw += d));
      req.on("end", () => {
        const body = JSON.parse(raw || "{}");
        state.seq += 1;
        const id = `run-${state.seq}`;
        state.bodies.push(body);
        const output = state.queue.length ? state.queue.shift() : "sandbox stub: done";
        state.runs.set(id, { id, status: "running", output, session: body.session_id || null });
        json(200, { run_id: id });
      });
      return;
    }
    const one = /^\/v1\/runs\/([^/]+)$/.exec(url.pathname);
    if (one && req.method === "GET") {
      const rec = state.runs.get(one[1]);
      if (!rec) return json(404, { error: { message: "Run not found", code: "run_not_found" } });
      return json(200, { run_id: rec.id, status: rec.status, output: rec.output, exit_code: 0 });
    }
    if (/^\/v1\/runs\/[^/]+\/events$/.test(url.pathname)) {
      const id = url.pathname.split("/")[3];
      const rec = state.runs.get(id);
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      if (!rec) return res.end();
      // The run stays RUNNING for as long as the test wants it to: the settle is driven by hand (that is how a
      // worker's final message is chosen), so this stream only ends when the run itself does.
      let ticks = 0;
      const timer = setInterval(() => {
        ticks += 1;
        if (rec.status !== "running") {
          clearInterval(timer);
          const payload = JSON.stringify({ event: `run.${rec.status}`, output: rec.output, exit_code: 0 });
          res.write(`event: run.${rec.status}\ndata: ${payload}\n\n`);
          res.end();
        } else if (ticks > 400) {
          clearInterval(timer);
          res.end();
        }
      }, 200);
      timers.push(timer);
      req.on("close", () => clearInterval(timer));
      return;
    }
    if (/^\/v1\/runs\/[^/]+\/steer$/.test(url.pathname) && req.method === "POST") {
      let raw = "";
      req.on("data", (d) => (raw += d));
      req.on("end", () => {
        state.bodies.push({ steer: true, ...JSON.parse(raw || "{}") });
        json(200, { accepted: true });
      });
      return;
    }
    if (/^\/v1\/runs\/[^/]+\/stop$/.test(url.pathname) && req.method === "POST") {
      const id = url.pathname.split("/")[3];
      const rec = state.runs.get(id);
      if (rec) rec.status = "cancelled";
      return json(200, { ok: true });
    }
    json(404, {});
  });
  const close = () =>
    new Promise((r) => {
      for (const t of timers) clearTimeout(t);
      server.closeAllConnections?.();
      server.close(() => r());
    });
  return { state, server, close };
}

// ---- the sandbox -------------------------------------------------------------------------------------------------
const dir = mkdtempSync(path.join(tmpdir(), "wtgui-todos-"));
const rootDir = path.join(dir, "scan-root");
const repo = path.join(rootDir, "sandbox-repo");
const home = path.join(dir, "hermes-home");
const configDir = path.join(dir, "panel");
const cwdDir = path.join(dir, "panel-cwd");
const logsDir = path.join(configDir, "logs");
const PROJECT = "sandbox-repo";
const TAG_MIX = "a1b2c3";
const TAG_WORK = "d4e5f6";
const TAG_FRESH = "0f0f0f";
const TREE_MIX = path.join(repo, ".worktrees", `the-mixed-list-${TAG_MIX}`);
const TREE_WORK = path.join(repo, ".worktrees", `the-workers-tree-${TAG_WORK}`);
const TREE_FRESH = path.join(repo, ".worktrees", `the-fresh-tree-${TAG_FRESH}`);

for (const d of [repo, path.join(repo, ".worktrees"), home, configDir, cwdDir, logsDir]) mkdirSync(d, { recursive: true });
git(repo, ["init", "-q", "-b", "main"]);
writeFileSync(path.join(repo, "README.md"), "# sandbox repo\n", "utf8");
git(repo, ["add", "."]);
git(repo, ["-c", "user.name=verify", "-c", "user.email=verify@localhost", "commit", "-q", "-m", "first"]);
for (const [tree, branch] of [
  [TREE_MIX, `wtgui/the-mixed-list-${TAG_MIX}`],
  [TREE_WORK, `wtgui/the-workers-tree-${TAG_WORK}`],
  [TREE_FRESH, `wtgui/the-fresh-tree-${TAG_FRESH}`],
]) {
  const added = git(repo, ["worktree", "add", "-q", "-b", branch, tree]);
  if (!added.ok) {
    console.log(`FAIL  the sandbox worktree ${path.basename(tree)} could not be cut — ${added.err || added.out}`);
    failures += 1;
  }
}
// The tree the worker phase runs in carries ONE commit of its own: that is what "left commits and claimed nothing"
// is measured against, and what a `git log --oneline <base>..HEAD` in the brief would show.
writeFileSync(path.join(TREE_WORK, "work.txt"), "work\n", "utf8");
git(TREE_WORK, ["add", "."]);
git(TREE_WORK, ["-c", "user.name=verify", "-c", "user.email=verify@localhost", "commit", "-q", "-m", "Seed the list from the assistant line"]);

// The mixed list, written into the panel's own store BEFORE it boots: item 2 was completed FIRST and item 1 is the
// OLDEST still open, which is the case the reader named ("assuming some get completed out of order").
const MIX_ITEMS = [
  { id: 1, text: "seed the list from the assistant line", status: "todo", owner: null, claimedAt: null, files: [], note: "", at: "2026-01-01T00:00:00.000Z", by: "assistant" },
  { id: 2, text: "harvest a worker's TODO lines", status: "done", owner: "wtgui-the-mixed-list-a1b2c3", claimedAt: null, files: [], note: "", at: "2026-01-02T00:00:00.000Z", by: "worker:wtgui-the-mixed-list-a1b2c3" },
  { id: 3, text: "show the oldest item when folded", status: "doing", owner: "wtgui-the-mixed-list-a1b2c3", claimedAt: "2026-01-03T00:00:00.000Z", files: ["public/app.js"], note: "", at: "2026-01-03T00:00:00.000Z", by: "worker:wtgui-the-mixed-list-a1b2c3" },
  { id: 4, text: "a thing that no longer applies", status: "dropped", owner: null, claimedAt: null, files: [], note: "not needed after all", at: "2026-01-04T00:00:00.000Z", by: "reader" },
];
const MIX_KEY = todoKey(PROJECT, TREE_MIX);
const todosPath = path.join(logsDir, "todos.json");
writeFileSync(
  todosPath,
  `${JSON.stringify(
    {
      version: 1,
      savedAt: new Date().toISOString(),
      lists: {
        [MIX_KEY]: { key: MIX_KEY, project: PROJECT, path: slash(TREE_MIX), nextId: 5, items: MIX_ITEMS, journal: [{ at: "2026-01-02T00:00:00.000Z", by: "worker:wtgui-the-mixed-list-a1b2c3", op: "status", id: 2, text: "harvest a worker's TODO lines", from: "worker" }] },
      },
    },
    null,
    2,
  )}\n`,
  "utf8",
);

const stub = makeStub();
await new Promise((r) => stub.server.listen(0, "127.0.0.1", r));
const stubUrl = `http://127.0.0.1:${stub.server.address().port}`;
const port = await freePort();
const configPath = path.join(configDir, "config.json");
writeFileSync(
  configPath,
  `${JSON.stringify(
    {
      port,
      host: "127.0.0.1",
      scanRoots: [rootDir],
      refreshSeconds: 4,
      worktreeSeconds: 2,
      midSeconds: 8,
      dormantSeconds: 15,
      slowSeconds: 20,
      fetchSeconds: 3600,
      threads: 1,
      scanMode: "all",
      defaultCwd: cwdDir,
      projectsCacheFile: path.join(logsDir, "projects.json"),
      apiServer: { url: stubUrl, key: "sandbox-key" },
      assistant: { enabled: false, autonomy: "draft", seconds: 3600, maxWakesPerHour: 0 },
    },
    null,
    2,
  )}\n`,
  "utf8",
);

// ---- phase 1: the store's own rules, driven directly -------------------------------------------------------------
console.log("== the store and its rules (lib/todos.js, driven directly) ==");
{
  const file = path.join(dir, "unit-todos.json");
  const trees = [
    { project: PROJECT, path: slash(TREE_MIX), branch: `wtgui/the-mixed-list-${TAG_MIX}` },
    { project: PROJECT, path: slash(TREE_WORK), branch: `wtgui/the-workers-tree-${TAG_WORK}` },
  ];
  const store = new TodoLists({ file, log: (m) => note(m), trees: () => trees, jobs: () => null });

  // (a) the rule itself: the LOWEST id that is still todo/doing, whatever order things were finished in.
  const seeded = store.seed({ project: PROJECT, path: TREE_MIX, texts: ["seed the resolver edge", "harvest the worker lines", "show the oldest item"], by: "assistant", from: "spawn" });
  check("ids are handed out in order from 1", seeded.map((i) => i.id), [1, 2, 3]);
  store.setStatus({ project: PROJECT, path: TREE_MIX, op: "done", id: 2, by: "worker:wtgui-x" });
  check("a LATER item completed first leaves the oldest open one alone", oldestOpen(store.items(MIX_KEY))?.id, 1);
  check("…and the summary the row carries names it", store.forRow(PROJECT, TREE_MIX).oldest.id, 1);
  check("…with the done/total count beside it", [store.forRow(PROJECT, TREE_MIX).done, store.forRow(PROJECT, TREE_MIX).total], [1, 3]);
  store.setStatus({ project: PROJECT, path: TREE_MIX, op: "done", id: 1, by: "worker:wtgui-x" });
  check("with the oldest closed, the next one is what folds down", store.forRow(PROJECT, TREE_MIX).oldest.id, 3);

  // (f) an id that does not exist: refused WITH a reason, and the list untouched.
  const before = JSON.stringify(store.items(MIX_KEY));
  const bad = store.setStatus({ project: PROJECT, path: TREE_MIX, op: "done", id: 99, by: "worker:wtgui-x" });
  check("TODO DONE 99 is refused, with the ids it could have meant", bad.ok, false);
  ok("…and the reason says so", /no item 99 in this list/.test(String(bad.error)), bad.error);
  check("…and nothing in the list moved", JSON.stringify(store.items(MIX_KEY)), before);
  const malformed = store.applyLines({ project: PROJECT, path: TREE_MIX, lines: parseTodoLines("TODO DONE abc"), by: "worker:wtgui-x" });
  check("a malformed line is a refusal with a reason too", [malformed[0].ok, /needs an item id/.test(String(malformed[0].error))], [false, true]);

  // The journal: every change with who claimed it.
  const j = store.list(MIX_KEY).journal;
  ok("the journal records who claimed each change", j.some((e) => e.by === "worker:wtgui-x" && e.op === "status" && e.id === 2), JSON.stringify(j.at(-1)));

  // The seed is a list an agent is handed: ids, statuses, and the reconcile instruction.
  const block = todoBlock(store.items(MIX_KEY), { where: slash(TREE_MIX), project: PROJECT });
  ok("the block a brief carries lists the items WITH their ids", /1\.\s+\[done\s*\] seed the resolver edge/.test(block), block.split("\n").slice(1, 4).join(" | "));
  ok("…and the reconcile instruction", /RECONCILE THIS LIST AGAINST WHAT YOU ACTUALLY COMMITTED/.test(block));
  ok("…and says the panel never marks anything done on its own", /never marks an item done on its own/.test(block));

  // The proposal a reconcile may show: it never writes anything.
  const proposals = proposeClosed(store.items(MIX_KEY), ["3f2a1b9 Show the oldest item when folded"]);
  check("a commit that shares words with an open item is PROPOSED", proposals.map((p) => p.id), [3]);
  check("…and the proposal changed nothing", store.forRow(PROJECT, TREE_MIX).open, 1);
}

// ---- phase 2: the Jobs level — a real create, a real run body, a real settle -------------------------------------
console.log("\n== the Jobs level (a real jobs.create against the stub, a real settle and harvest) ==");
{
  const trees = () => [
    { project: PROJECT, path: slash(TREE_MIX), branch: `wtgui/the-mixed-list-${TAG_MIX}` },
    { project: PROJECT, path: slash(TREE_WORK), branch: `wtgui/the-workers-tree-${TAG_WORK}` },
    { project: PROJECT, path: slash(TREE_FRESH), branch: `wtgui/the-fresh-tree-${TAG_FRESH}` },
  ];
  const todos = new TodoLists({ file: path.join(logsDir, "todos.json"), log: (m) => note(m), trees, jobs: () => jobs });
  const jobs = new Jobs({ config: { jobsFile: path.join(dir, "jobs.json"), apiServer: { url: stubUrl, key: "k" }, defaultCwd: repo }, onLog: () => {} });
  jobs.todos = todos;

  // (c) the assistant seeds a list with its own TODO lines, under a SPAWN IN line — the acceptance items of a card.
  const reply = [
    "Starting the work in the existing tree.",
    `SPAWN IN ${slash(TREE_FRESH)} | prove the TODO section on the worktree`,
    "TODO the folded line names the OLDEST item still open",
    "TODO a worker's final message is harvested into the same list",
  ].join("\n");
  const actions = parseActions(reply);
  check("the assistant's reply parses into two TODO adds, bound to the SPAWN above them", actions.todo.map((t) => [t.op, t.spawn]), [["add", 0], ["add", 0]]);

  const before = stub.state.bodies.length;
  const job = await jobs.create({
    prompt: "prove the TODO section on the worktree",
    cwd: TREE_FRESH,
    existing: true,
    ownerPath: TREE_FRESH,
    project: PROJECT,
    todoSeed: actions.todo.filter((t) => t.op === "add").map((t) => t.text),
  });
  const live = jobs.jobs.get(job.id);
  ok("a real run was posted", stub.state.bodies.length > before, `${stub.state.bodies.length - before} body(ies)`);
  const body = stub.state.bodies.at(-1);
  // (c) the block the worker actually receives, quoted out of the run body the gateway was handed.
  const input = String(body.input || "");
  ok("the run body carries the tree's list WITH its ids", /1\.\s+\[todo\s*\] the folded line names the OLDEST item still open/.test(input), input.split("\n").filter((l) => /^\s+\d+\.\s+\[/.test(l)).join(" | "));
  ok("…and the reconcile instruction", /RECONCILE THIS LIST AGAINST WHAT YOU ACTUALLY COMMITTED/.test(input));
  ok("…and it rides AFTER the 'Work in …' sentence, so the branch's description is not polluted", input.indexOf("Work in ") < input.indexOf("TODO — the list for this worktree"), `Work in at ${input.indexOf("Work in ")}, block at ${input.indexOf("TODO — the list for this worktree")}`);
  check("the seeded list is the tree's own, keyed on the row", todos.forRow(PROJECT, TREE_FRESH).items.map((i) => i.text), ["the folded line names the OLDEST item still open", "a worker's final message is harvested into the same list"]);
  check("the card says the list was seeded from the brief", live.lines.filter((l) => /seeded this tree's TODO list/.test(l.text)).length, 1);

  // (b) the worker's FINAL message, harvested: one DONE, one ADD, one DONE for an id that does not exist.
  live.finalMessage = [
    "Both items are done and I found one more thing.",
    "TODO DONE 1",
    "TODO ADD the journal has to show who claimed it",
    "TODO DONE 99",
  ].join("\n");
  const parsed = lastWords({ finalMessage: live.finalMessage });
  check("lastWords hands the lines on as data", parsed.todo.map((t) => [t.op, t.id ?? null]), [["done", 1], ["add", null], ["done", 99]]);
  await jobs.settle(live, "completed", { output: live.finalMessage, exit_code: 0 });
  const harvested = await waitFor(() => (todos.forRow(PROJECT, TREE_FRESH)?.items || []).length === 3, { timeoutMs: 20_000, what: "the worker's TODO lines to be harvested at the settle" });
  ok("the harvest ran when the run settled (measureTree, not the reader)", harvested);
  const list = todos.forRow(PROJECT, TREE_FRESH);
  check("the worker's TODO DONE 1 landed in the same list", list.items.map((i) => [i.id, i.status]), [[1, "done"], [2, "todo"], [3, "todo"]]);
  check("…and its TODO ADD became item 3, so ids never repeat", list.items[2].text, "the journal has to show who claimed it");
  check("…and the oldest item still open is now 2", list.oldest.id, 2);
  check("the count the row carries", [list.done, list.total], [1, 3]);
  const cardLines = live.lines.map((l) => l.text);
  ok("the card SAYS what it applied", cardLines.some((t) => /TODO #1 done/.test(t)), cardLines.filter((t) => /TODO/.test(t)).join(" || "));
  ok("…and SAYS the unknown id instead of dropping it", cardLines.some((t) => /TODO done 99 was NOT applied — no item 99 in this list/.test(t)), cardLines.find((t) => /NOT applied/.test(t)) || "(nothing said)");
  const journal = todos.list(todos.keyFor({ project: PROJECT, path: TREE_FRESH })).journal;
  ok("the journal names the worker that claimed it", journal.some((e) => e.by === `worker:${live.thread}` && e.op === "status" && e.id === 1), JSON.stringify(journal.map((e) => `${e.by} ${e.op}${e.id ? ` #${e.id}` : ""}`)));
  ok("…and the assistant's own seeding", journal.some((e) => e.by === "assistant" && e.op === "add"), JSON.stringify(journal[0]));

  // (c, second half) a revive carries the same block, and a steer carries it too.
  const revived = jobs.revive({ thread: "sandbox-revived-thread", ownerPath: TREE_WORK, projectPath: repo, cwd: TREE_WORK, title: "the worker's tree" });
  ok("a revive is accepted", revived.ok, JSON.stringify(revived.error || ""));
  const revivedJob = jobs.jobs.get(revived.job.id);
  const revivedLine = (revivedJob.lines || []).find((l) => /TODO list, handed to this thread/.test(String(l.text))) || null;
  ok("the revived card carries the same block", Boolean(revivedLine), revivedLine ? "the card line is there" : "no block line");
  ok("…with the standing instruction in it", /RECONCILE THIS LIST AGAINST WHAT YOU ACTUALLY COMMITTED/.test(String(revivedLine?.text || "")));

  // A steer into a live run: the text the gateway receives carries the list as it stands now.
  stub.state.queue.push("nothing to say");
  const steerJob = await jobs.create({ prompt: "stay live for the steer", cwd: TREE_WORK, existing: true, ownerPath: TREE_WORK, project: PROJECT });
  const steerLive = jobs.jobs.get(steerJob.id);
  const steered = await jobs.steer(steerLive.id, "change of plan");
  const steerBody = stub.state.bodies.at(-1);
  ok("the steer was accepted by the gateway", steered.ok, JSON.stringify(steered.error || ""));
  ok("…and carried the tree's TODO list with it", /TODO — the list for this worktree/.test(String(steerBody.input || "")), String(steerBody.input || "").slice(0, 120));

  // (d) a run that left commits and claimed NOTHING: the card says so, and PROPOSES rather than completes.
  //     Driven in the tree that HAS a list, so the proposal has something to be about: the commit is made AFTER
  //     `create` (which is when the panel records the base commit), so the run really does leave work behind.
  const quiet = await jobs.create({ prompt: "reconcile the list with what I committed", cwd: TREE_MIX, existing: true, ownerPath: TREE_MIX, project: PROJECT });
  const quietLive = jobs.jobs.get(quiet.id);
  writeFileSync(path.join(TREE_MIX, "oldest.txt"), "work\n", "utf8");
  git(TREE_MIX, ["add", "."]);
  git(TREE_MIX, ["-c", "user.name=verify", "-c", "user.email=verify@localhost", "commit", "-q", "-m", "Show the oldest item when folded"]);
  quietLive.finalMessage = "I did the work; nothing to add.";
  await jobs.settle(quietLive, "completed", { output: quietLive.finalMessage, exit_code: 0 });
  await waitFor(() => quietLive.lines.some((l) => /claimed no TODO item/.test(l.text)), { timeoutMs: 30_000, what: "the reconcile prompt on the card" });
  const reconcile = quietLive.lines.map((l) => l.text).find((t) => /claimed no TODO item/.test(t)) || "";
  ok("the card says the run left commits and claimed nothing", Boolean(reconcile), reconcile);
  ok("…and names the commit it saw", /Show the oldest item when folded/.test(reconcile), reconcile);
  ok("…and PROPOSES which item looks closed", /#3 looks closed by/.test(reconcile), reconcile);
  ok("…and says nothing was marked done on its own", /Nothing was marked done on its own/.test(reconcile), reconcile);
  const mixAfter = todos.forRow(PROJECT, TREE_MIX);
  check("…and the proposed item is STILL open — a proposal is not a completion", mixAfter.items.find((i) => i.id === 3).status, "doing");
  check("…and the folded line is unchanged by that prompt", mixAfter.oldest.id, 1);

  // Leave nothing running: a job's stats clock is a real interval, and a test that leaves one live never exits.
  jobs.settle(steerLive, "cancelled", {});
  jobs.settle(quietLive, "cancelled", {});
  await sleep(500);
}

// ---- phase 3: a real sandbox panel over HTTP, then a real browser ------------------------------------------------
const base = `http://127.0.0.1:${port}`;
const panelLog = [];
let panel = null;
const startPanel = async () => {
  panel = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: { ...process.env, PANEL_CONFIG: configPath, HERMES_HOME: home, PANEL_TOKEN: "" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  panel.stdout.on("data", (d) => panelLog.push(...String(d).split(/\r?\n/).filter(Boolean)));
  panel.stderr.on("data", (d) => panelLog.push(...String(d).split(/\r?\n/).filter(Boolean)));
  const up = await waitFor(async () => (await fetch(`${base}/api/state`)).ok, { timeoutMs: 40_000, what: "the sandbox panel to answer /api/state" });
  if (!up) throw new Error(`the sandbox panel never came up on ${base}\n${panelLog.slice(-15).join("\n")}`);
};
const stopPanel = async () => {
  if (!panel) return;
  const p = panel;
  panel = null;
  p.kill();
  await waitFor(() => p.exitCode !== null || p.signalCode !== null, { timeoutMs: 15_000, what: "the panel to exit" });
  await sleep(300);
};
const api = async (route, body, method) => {
  const res = await fetch(`${base}${route}`, {
    method: method || (body ? "POST" : "GET"),
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
const state = () => api("/api/state").then((r) => r.body);
const rowFor = async (treePath) => {
  const s = await state();
  return s.projects?.find((p) => p.name === PROJECT)?.worktrees?.find((w) => norm(w.path) === norm(treePath)) || null;
};
const storedLists = () => {
  try {
    return JSON.parse(readFileSync(todosPath, "utf8")).lists || {};
  } catch {
    return {};
  }
};

async function browserPhase(pw) {
  const pageErrors = [];
  const browser = await pw.chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  // Harness setup, not part of what is asserted: a fresh browser has no remembered layout, so the sandbox project
  // would open collapsed and none of its rows would be on the page.
  await context.addInitScript((o) => localStorage.setItem("wm.expandedProjects", JSON.stringify([o.project])), { project: PROJECT });
  const page = await context.newPage();
  page.on("pageerror", (e) => pageErrors.push(`pageerror: ${String((e && e.message) || e)}`));
  page.on("console", (m) => {
    if (m.type() === "error") pageErrors.push(`console.error: ${m.text()}`);
  });
  const openRow = async (treePath) => {
    const s = await state();
    const row = s.projects?.find((p) => p.name === PROJECT)?.worktrees?.find((w) => norm(w.path) === norm(treePath));
    if (!row) throw new Error(`no row for ${treePath} in /api/state`);
    const key = `${PROJECT}::${row.path}`;
    const rowSel = `tr.row[data-key="${key}"]`;
    await page.waitForSelector(rowSel, { timeout: 20_000 });
    if (!(await page.locator(`tr.detail[data-detail="${key}"]`).count())) await page.locator(`${rowSel} td.branch`).click();
    await page.waitForSelector(`tr.detail[data-detail="${key}"]`, { timeout: 20_000 });
    return key;
  };

  await page.goto(base, { waitUntil: "domcontentloaded" });
  const key = await openRow(TREE_MIX);
  const sel = `tr.detail[data-detail="${key}"]`;
  const todoSel = `${sel} .todo-block`;
  ok("browser: the row's detail carries a TODO section", (await page.locator(todoSel).count()) === 1);
  check("browser: the section's heading", await page.locator(`${todoSel} .todo-head .todo-title`).textContent(), "TODO");
  // (a) FOLDED: the count, then the OLDEST incomplete item — NOT item 2, which was the one completed first.
  const folded = await page.locator(`${todoSel} .todo-head`).textContent();
  console.log(`      (a) the folded line, quoted from the live DOM:\n        ${folded.replace(/\s+/g, " ").trim()}`);
  ok("browser: folded by default", (await page.locator(todoSel).getAttribute("class")).includes("collapsed"));
  check("browser: the count beside it is done/total", await page.locator(`${todoSel} .todo-count`).textContent(), "1/5");
  const peek = await page.locator(`${todoSel} .todo-first`).textContent();
  ok("browser: the folded line names the OLDEST incomplete item (#1), not the one completed first (#2)", /^#1\b/.test(peek) && /seed the list from the assistant line/.test(peek), peek);
  ok("browser: …and does not name the completed item", !/harvest a worker's TODO lines/.test(peek), peek);
  ok("browser: the section does not grow the row while folded", !(await page.locator(`${todoSel} .todo-body`).isVisible()));
  // Keyboard reachable: the head is a real button, and Enter unfolds it.
  check("browser: the head is a <button> (keyboard reachable)", await page.locator(`${todoSel} .todo-head`).evaluate((el) => el.tagName), "BUTTON");
  await page.locator(`${todoSel} .todo-head`).focus();
  check("browser: the head takes focus", await page.evaluate(() => document.activeElement?.classList?.contains("todo-head")), true);
  await page.keyboard.press("Enter");
  ok("browser: Enter unfolds it", !(await page.locator(todoSel).getAttribute("class")).includes("collapsed"));
  check("browser: and the unfold is remembered", String(await page.evaluate(() => localStorage.getItem("wm.openTodos"))).includes(key), true);
  // Each item's FACTS are a disclosure of their own and start FOLDED: the item's line is what the reader scans, and
  // three bullets of the same worker string under every item of a twelve-item list is the repetition the fold removes.
  const itemState = () =>
    page.locator(`${todoSel} .todo-item`).evaluateAll((els) =>
      els.map((el) => {
        const meta = el.querySelector(".todo-meta");
        const line = el.querySelector(".todo-line");
        const btn = el.querySelector("[data-toggle-todo-facts]");
        const shown = (node) => {
          if (!node) return false;
          if (getComputedStyle(node).display === "none") return false;
          const r = node.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        };
        return {
          id: el.dataset.todoItem,
          collapsed: el.classList.contains("collapsed"),
          factsShown: shown(meta),
          lineShown: shown(line),
          bullets: meta ? meta.querySelectorAll(":scope > li").length : 0,
          tag: btn ? btn.tagName : null,
          expanded: btn ? btn.getAttribute("aria-expanded") : null,
          chev: btn ? (btn.querySelector(".chev") || {}).textContent : null,
        };
      }),
    );
  const atItem = async (id) => (await itemState()).find((i) => i.id === id);
  const factsBtn = (id) => page.locator(`${todoSel} .todo-item[data-todo-item="${id}"] .todo-facts-btn`);
  const foldedItems = await itemState();
  check("browser: every item's facts start FOLDED — an item nobody opened is never expanded on their behalf", foldedItems.map((i) => i.factsShown), [false, false, false, false, false]);
  ok("browser: …the bullets are still in the markup, one per fact, simply not shown", foldedItems.map((i) => i.bullets).join(",") === "2,3,4,3,2", foldedItems.map((i) => `#${i.id}:${i.bullets}`).join(" "));
  ok("browser: …the item's own line and its text stay visible", foldedItems.every((i) => i.lineShown), foldedItems.map((i) => `#${i.id}:${i.lineShown}`).join(" "));
  ok("browser: …and every item carries its own disclosure control", foldedItems.every((i) => i.tag === "BUTTON" && i.expanded === "false" && i.chev === "\u25b8"), JSON.stringify(foldedItems.map((i) => [i.tag, i.expanded, i.chev])));
  // Keyboard: a real <button>, so Tab reaches it and both Enter and Space toggle it.
  await factsBtn("2").focus();
  check("browser: a fact disclosure takes focus", await page.evaluate(() => document.activeElement?.classList?.contains("todo-facts-btn")), true);
  await page.keyboard.press("Enter");
  check("browser: Enter opens that item's facts", (await atItem("2")).factsShown, true);
  await page.keyboard.press("Space");
  check("browser: Space folds them again", (await atItem("2")).factsShown, false);
  await page.keyboard.press("Enter");
  check("browser: …and Enter re-opens them", (await atItem("2")).factsShown, true);
  // A click opens ONE item and nothing else: the detail is still open, and the row's own fold never fired.
  await factsBtn("1").click();
  check("browser: a click opens that one item", (await atItem("1")).factsShown, true);
  check("browser: …and leaves the row and its detail open", await page.evaluate((k) => Boolean(state.expanded.has(k)) && Boolean(document.querySelector(`tr.detail[data-detail="${CSS.escape(k)}"]`)), key), true);
  check("browser: …with no second fold from the row's own click", await page.locator(`tr.row[data-key="${key}"].expanded`).count(), 1);
  for (const id of ["3", "4", "5"]) await factsBtn(id).click();
  check("browser: each item opens on its own control", (await itemState()).map((i) => i.factsShown), [true, true, true, true, true]);
  // (a) UNFOLDED: every item, with its status, owner and age.
  const items = await page.locator(`${todoSel} .todo-item`).evaluateAll((els) =>
    els.map((el) => ({ id: el.dataset.todoItem, status: el.querySelector(".todo-glyph")?.getAttribute("title"), text: el.querySelector(".todo-text")?.textContent, meta: el.querySelector(".todo-meta")?.textContent })),
  );
  console.log("      (a) the unfolded section, quoted from the live DOM:");
  for (const i of items) console.log(`        #${i.id} [${i.status}] ${i.text}  — ${i.meta}`);
  check("browser: every item is listed, in id order", items.map((i) => i.id), ["1", "2", "3", "4", "5"]);
  check("browser: with its status", items.map((i) => i.status), ["todo", "done", "doing", "dropped", "todo"]);
  ok("browser: and its owner and age", items.some((i) => /wtgui-the-mixed-list-a1b2c3/.test(String(i.meta)) && /ago/.test(String(i.meta))), items[2].meta);
  // The facts hang UNDER the item's own line as a nested bullet list. They used to be one string pushed to the far
  // right of a full-width flex row (`margin-left:auto`), which put a short item and its owner a screen apart on a wide
  // board and made the reader zoom out to read one row. Geometry, not markup alone: the list must start near the item's
  // left edge and below its line, whatever the viewport.
  const facts = await page.locator(`${todoSel} .todo-item`).evaluateAll((els) =>
    els
      .map((el) => {
        const meta = el.querySelector(".todo-meta");
        const line = el.querySelector(".todo-line");
        if (!meta) return null;
        const m = meta.getBoundingClientRect();
        return {
          id: el.dataset.todoItem,
          tag: meta.tagName,
          bullets: meta.querySelectorAll(":scope > li").length,
          indent: Math.round(m.left - el.getBoundingClientRect().left),
          under: line ? m.top >= line.getBoundingClientRect().bottom - 1 : false,
        };
      })
      .filter(Boolean),
  );
  // #1 by+updated, #2 owner+by+updated, #3 owner+by+updated+files, #4 by+updated+note, #5 by+updated.
  check("browser: every item's facts are a <ul>, one bullet per fact", facts.map((f) => [f.tag, f.bullets]), [
    ["UL", 2],
    ["UL", 3],
    ["UL", 4],
    ["UL", 3],
    ["UL", 2],
  ]);
  ok("browser: the fact list is indented under the item, not pushed to the row's right edge", facts.every((f) => f.indent > 0 && f.indent < 60), facts.map((f) => `#${f.id}:${f.indent}px`).join(" "));
  ok("browser: and it sits below the item's line, never beside it", facts.every((f) => f.under), facts.map((f) => `#${f.id}:${f.under}`).join(" "));
  // The control must not take the caret: the item's own edit box opens on the line above its facts, so a reader
  // half-way through rewording an item has to be able to fold a neighbour's bullets without losing the sentence.
  await page.locator(`${todoSel} .todo-item[data-todo-item="1"] [data-todo-op="edit-start"]`).click();
  const caretBox = page.locator(`${todoSel} .todo-edit`);
  await caretBox.focus();
  await page.keyboard.press("End");
  await page.keyboard.type("-zq-");
  await factsBtn("2").click();
  check("browser: pressing a disclosure keeps the caret in the item's edit box", await page.evaluate(() => document.activeElement?.classList?.contains("todo-edit")), true);
  check("browser: …and the half-typed text is still in it", (await caretBox.inputValue()).endsWith("-zq-"), true);
  check("browser: …and the item it toggled folded in place", (await atItem("2")).factsShown, false);
  await factsBtn("2").click();
  await page.locator(`${todoSel} .todo-item[data-todo-item="1"] [data-todo-op="edit-cancel"]`).click();
  check("browser: the block's own repaint keeps every item's fold", (await itemState()).map((i) => i.factsShown), [true, true, true, true, true]);
  // …and it replaces the detail with another `tr.detail`, not with the `<div>` inside one: a `<tr>` parsed in a <div>
  // holder is dropped by the HTML parser, and the row's detail then stops being findable by every path that follows it.
  check("browser: …and leaves the detail a tr.detail[data-detail] the rest of the panel can find", await page.evaluate((k) => document.querySelectorAll(`tr.detail[data-detail="${CSS.escape(k)}"]`).length, key), 1);
  // One item left folded: the remembered set holds what the reader OPENED, so a folded item must not be in it.
  await factsBtn("4").click();
  check("browser: folding one item hides its bullets again", (await atItem("4")).factsShown, false);
  const storedFacts = JSON.parse(await page.evaluate(() => localStorage.getItem("wm.openTodoFacts") || "[]"));
  check("browser: the open items are remembered per worktree and per item", [...storedFacts].sort(), [`${key}::1`, `${key}::2`, `${key}::3`, `${key}::5`].sort());
  ok("browser: …and the folded one is not in that set", !storedFacts.includes(`${key}::4`), JSON.stringify(storedFacts));
  // A full repaint (the snapshot path) must not re-expand them, and neither must a reload.
  await page.evaluate(() => renderAll());
  await page.waitForSelector(`${todoSel} .todo-item[data-todo-item="4"]`, { timeout: 10_000 });
  check("browser: a repaint keeps each item's fold (the open stay open, the folded one stays folded)", (await itemState()).map((i) => [i.id, i.factsShown]), [["1", true], ["2", true], ["3", true], ["4", false], ["5", true]]);
  await page.reload({ waitUntil: "domcontentloaded" });
  await openRow(TREE_MIX);
  ok("browser: the section's unfold survived the reload", !(await page.locator(todoSel).getAttribute("class")).includes("collapsed"));
  check("browser: …and so did each item's own fold", (await itemState()).map((i) => [i.id, i.factsShown]), [["1", true], ["2", true], ["3", true], ["4", false], ["5", true]]);
  ok("browser: …with the item nobody ever opened still folded, not re-expanded for the reader", (await atItem("4")).factsShown === false && (await atItem("4")).collapsed === true, JSON.stringify(await atItem("4")));
  const shot = process.env.PANEL_VERIFY_ARTIFACTS;
  if (shot) {
    try {
      mkdirSync(shot, { recursive: true });
      await page.screenshot({ path: path.join(shot, "todo-section.png"), fullPage: false });
      // The block itself, big enough to read: the per-item folds are what this change is about, and a viewport shot
      // puts half the list under the fold.
      await page.locator(todoSel).screenshot({ path: path.join(shot, "todo-block.png") });
      note(`screenshot: ${path.join(shot, "todo-section.png")} · ${path.join(shot, "todo-block.png")}`);
    } catch {
      /* a screenshot is a courtesy */
    }
  }
  // A long item's glyph, words and buttons must share one inline wrapping context. A wrapping flex row treats the
  // entire text span as one item: status on one line, the words below it, then a third line just for the buttons.
  const wrappingText = "Keep the status beside the beginning of this longer TODO while its words wrap naturally across the available width and the action buttons follow the final words on the same line.";
  for (const id of [1, 2, 3, 4]) {
    const text = id === 3 ? `Check C:/${"LongTodoIdentifier".repeat(14)}` : wrappingText;
    const edited = await api("/api/todos", { project: PROJECT, path: slash(TREE_MIX), op: "edit", id, text });
    check(`browser: seed the wrapping fixture for #${id}`, [edited.status, edited.body.ok], [200, true]);
  }
  await page.reload({ waitUntil: "domcontentloaded" });
  await openRow(TREE_MIX);
  await page.locator(`${todoSel} .todo-text`).first().waitFor();
  await page.evaluate(() => document.fonts.ready);
  let sharedTails = 0;
  // The panel can repaint the detail between samples. A fixture width in the stylesheet survives that repaint.
  await page.addStyleTag({ content: `${todoSel} { width: var(--todo-wrap-width); }` });
  for (const width of [360, 720, 1100]) {
    await page.evaluate((w) => document.documentElement.style.setProperty("--todo-wrap-width", `${w}px`), width);
    const geometry = await page.locator(`${todoSel} .todo-item`).evaluateAll((els) => els.map((el) => {
      const line = el.querySelector(".todo-line");
      const text = el.querySelector(".todo-text");
      const range = document.createRange();
      range.selectNodeContents(text);
      const rects = [...range.getClientRects()].filter((r) => r.width > 0);
      const center = (r) => r.top + r.height / 2;
      const bounds = line.getBoundingClientRect();
      const buttons = [...line.querySelectorAll(".todo-btn")].map((b) => b.getBoundingClientRect());
      const first = rects[0];
      const last = rects.at(-1);
      return {
        id: el.dataset.todoItem,
        lines: rects.length,
        statusY: center(el.querySelector(".todo-glyph").getBoundingClientRect()),
        firstTextY: center(first),
        lastTextY: center(last),
        buttonsY: buttons.map(center),
        fits: rects.every((r) => r.left >= bounds.left - 1 && r.right <= bounds.right + 1)
          && line.scrollWidth <= line.clientWidth + 1,
        roomForButtons: last.right + buttons.reduce((sum, r) => sum + r.width, 0) + 8 * (buttons.length + 1) <= bounds.right,
      };
    }));
    note(`wrapping at ${width}px: ${JSON.stringify(geometry)}`);
    for (const g of geometry) {
      ok(`browser: ${width}px #${g.id} starts its text beside its status`, Math.abs(g.statusY - g.firstTextY) <= 2);
      ok(`browser: ${width}px #${g.id} stays within the line width, even for an unbroken identifier`, g.fits);
      if (g.id !== "5") ok(`browser: ${width}px #${g.id} really wraps its long text`, g.lines > 1);
      if (g.roomForButtons) {
        if (g.id !== "5") sharedTails += 1;
        ok(`browser: ${width}px #${g.id} keeps every action beside the final words when they fit`, g.buttonsY.every((y) => Math.abs(y - g.lastTextY) <= 2));
      }
      if (g.id === "5") check(`browser: ${width}px the short item still occupies one text line`, g.lines, 1);
    }
    if (width === 720 && shot) {
      // Fit the whole block inside the viewport before capturing it: Chromium can leave an off-screen clip unpainted.
      try {
        await page.setViewportSize({ width: 1400, height: 2200 });
        await page.locator(todoSel).screenshot({ path: path.join(shot, "todo-wrapping.png"), animations: "disabled" });
        note(`wrapping screenshot: ${path.join(shot, "todo-wrapping.png")}`);
      } catch (err) {
        note(`wrapping screenshot not captured (the geometry checks still ran): ${String(err.message || err)}`);
      } finally {
        await page.setViewportSize({ width: 1400, height: 1000 });
      }
    }
  }
  ok("browser: the fixtures exercise actions sharing the final text line", sharedTails > 0, String(sharedTails));
  check("browser: no page errors", pageErrors, []);
  await browser.close();
}

let shots = null;
try {
  console.log("\n== a real sandbox panel over HTTP ==");
  note(`temp root ${dir}`);
  note(`stub gateway ${stubUrl} · panel ${base}`);
  await startPanel();
  const discovered = await waitFor(async () => {
    const s = await state();
    return (s.projects?.find((p) => p.name === PROJECT)?.worktrees || []).length >= 3;
  }, { timeoutMs: 45_000, what: "the sandbox repo and its worktrees to be scanned as rows" });
  ok("the sandbox panel scanned the project and its worktrees", discovered);

  // The list the store was seeded with travels on the row: counts, the oldest item, the items, the journal.
  const mixRow = await rowFor(TREE_MIX);
  check("the row carries the list's done/total", [mixRow?.todo?.done, mixRow?.todo?.total], [1, 4]);
  check("…and names the OLDEST incomplete item", [mixRow?.todo?.oldest?.id, mixRow?.todo?.oldest?.text], [1, "seed the list from the assistant line"]);
  check("…and carries every item with its owner", (mixRow?.todo?.items || []).map((i) => i.id), [1, 2, 3, 4]);
  ok("a tree with no list carries no todo field at all", !("todo" in ((await rowFor(TREE_WORK)) || {})), String("todo" in ((await rowFor(TREE_WORK)) || {})));

  // (b) the assistant's own action line, seeded onto a tree by the assistant's harvest path.
  const freshKey = todoKey(PROJECT, TREE_FRESH);
  const assistantSeed = await api("/api/todos", { project: PROJECT, path: slash(TREE_FRESH), op: "add", text: "seeded by an assistant TODO line" });
  check("a list can be seeded for a tree that had none", [assistantSeed.status, assistantSeed.body.ok], [200, true]);

  // (e) the reader adds, completes and reopens — every write stamped `by: reader`.
  const added = await api("/api/todos", { project: PROJECT, path: slash(TREE_MIX), op: "add", text: "the reader's own item" });
  check("the reader's add landed", [added.status, added.body.ok, added.body.summary.total], [200, true, 5]);
  check("…and it is stamped by: reader", added.body.journal.at(-1).by, "reader");
  const newId = added.body.summary.nextId - 1;
  const done = await api("/api/todos", { project: PROJECT, path: slash(TREE_MIX), op: "done", id: newId });
  check("the reader's complete landed", [done.body.ok, done.body.summary.done], [true, 2]);
  ok("…and the folded line still names the OLDEST incomplete item", done.body.summary.oldest.id === 1, `oldest #${done.body.summary.oldest.id}`);
  const reopened = await api("/api/todos", { project: PROJECT, path: slash(TREE_MIX), op: "reopen", id: newId });
  check("the reader's reopen landed", [reopened.body.ok, reopened.body.summary.done], [true, 1]);
  check("…and says what it did", reopened.body.message, `#${newId} reopened`);

  // (f) over HTTP: an id that does not exist is a refusal with a reason, and the page is told.
  const bad = await api("/api/todos", { project: PROJECT, path: slash(TREE_MIX), op: "done", id: 99 });
  check("TODO DONE 99 over HTTP is a 400 with the reason", [bad.status, bad.body.ok], [400, false]);
  ok("…naming the ids that do exist", /no item 99 in this list/.test(String(bad.body.error)), bad.body.error);

  // (e) the list survives a panel restart: the same rows, from the file beside jobs.json.
  const beforeRestart = JSON.stringify((storedLists()[MIX_KEY] || {}).items || []);
  await stopPanel();
  await startPanel();
  await waitFor(async () => Boolean(await rowFor(TREE_MIX)), { timeoutMs: 45_000, what: "the board to come back after the restart" });
  const afterRow = await rowFor(TREE_MIX);
  check("after a restart the list is the same list", JSON.stringify((afterRow?.todo?.items || []).map((i) => [i.id, i.status, i.text])), JSON.stringify(JSON.parse(beforeRestart).map((i) => [i.id, i.status, i.text])));
  check("…and the oldest incomplete item is still the oldest", afterRow?.todo?.oldest?.id, 1);
  // The fresh tree is the one the JOBS phase worked in (seeded from the brief, harvested from a final message) and
  // the one the panel phase added to, so its list is all four — which is also the proof that two writers landed in
  // ONE list keyed on the row, in id order.
  check("…and the tree two writers share kept every item, in order", JSON.stringify(storedLists()[freshKey]?.items?.map((i) => [i.id, i.status])), JSON.stringify([[1, "done"], [2, "todo"], [3, "todo"], [4, "todo"]]));
  check("…with the panel's own add last", storedLists()[freshKey]?.items?.at(-1)?.text, "seeded by an assistant TODO line");

  console.log("\n== the browser: the folded line and the unfolded section, over the running panel ==");
  const pw = loadPlaywright();
  if (!pw) {
    console.log("BROWSER-HALF-NOT-RUN  the client half of this change was not exercised in a browser.");
    note("re-run with a Playwright install, e.g. PANEL_PLAYWRIGHT_ROOT=<dir with node_modules/playwright> node tools/verify-todo-section.mjs");
    failures += 1;
  } else {
    await browserPhase(pw);
  }

  console.log("\n== summary ==");
  console.log(`${checks} checks, ${failures} failed`);
  console.log("\nWHAT WAS DRIVEN: lib/todos.js directly (the oldest-open rule, the refusals, the journal, the proposal);");
  console.log("lib/jobs.js against a stub Runs API over a real git worktree (a real create, the run body the gateway was");
  console.log("handed, a real settle, the harvest of a worker's FINAL message, the reconcile prompt, a revive and a steer);");
  console.log("a real sandbox panel over HTTP (the row payload, the reader's add/complete/reopen, an unknown id, a restart);");
  console.log("and headless Chromium over it (the folded line, the unfolded list, the keyboard, no page errors).");
  console.log("WHAT WAS INSPECTED, NOT DRIVEN: nothing here drives a real model — the worker's final message is written by");
  console.log("the test, so what is proved is the PANEL's reading of it, not a model's willingness to write it.");
  if (!failures) console.log("TODO-VERIFY-OK");
} catch (err) {
  failures += 1;
  console.log(`\nFAIL  the run threw: ${String((err && err.stack) || err)}`);
  if (panelLog.length) console.log(`--- panel log (tail)\n${panelLog.slice(-25).join("\n")}`);
} finally {
  if (process.env.VERIFY_KEEP === "1") {
    console.log(`VERIFY_KEEP=1 — leaving ${dir} in place`);
  } else {
    await stopPanel();
    await stub.close();
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    } catch (e) {
      console.log(`      (could not remove ${dir}: ${String((e && e.message) || e)})`);
    }
  }
}
process.exitCode = failures ? 1 : 0;
