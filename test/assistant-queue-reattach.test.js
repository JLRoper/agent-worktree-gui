// The Queue row's stopped chip: the EXITED pill (and the not-running one) is the re-attach CONTROL, and what a press
// does with the route's answer.
//
// The renderer and the press are the page's own code, sliced out of public/queue-cards.js and driven against stubs — the
// same style as assistant-queue-ui.test.js. What this pins:
//
//   1. the markup: the stopped chip is a real <button> carrying `data-as-qreattach` (the thread), `data-as-qown` (the
//      assistant whose queue it is) and `data-as-qid` (the task), with the ↻ glyph the board's own stopped pill has —
//      a native button is the role, the Tab stop and Enter/Space in one element, which is why no span gained role= or
//      tabindex= here. A LIVE run's chip is still a word and nothing else: a press there could only start a second run;
//   2. the press: POST /api/assistants/<this card's assistant>/reset {dryRun:false, reason} and ONLY that with nothing
//      cleared — a healthy card says "nothing was wedged" and starts no run;
//   3. the wake: one /api/assistant/say on the SAME assistant with the short re-attach sentence, and the card's
//      sentence names the run it became;
//   4. the answers that are not a success: a refusal is printed verbatim, a 200 that is `ok:false` is the incomplete
//      verdict and starts nothing, and a wake refused after a clear never claims a run;
//   5. one press, one reset: a second press while the first is out sends nothing.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { configureRepo, git as runGit, post as postJson, slash as sl, sliceRegion, startPanel as boot, waitForRow as waitRow } from "../tools/panel-testkit.mjs";

const cards = readFileSync(new URL("../public/queue-cards.js", import.meta.url), "utf8");
const region = sliceRegion(cards, "the queue sub-tab");

const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

// `answers` are consumed one per asPost call: a plain value is resolved, a function is CALLED (so it can throw a
// refusal, or hand back a promise this test releases when it wants the press to still be in flight). `apiFetch` and
// `hostFor` are stubs too, because the press's repaint runs the region's REAL `loadQueueJobs`/`renderAssistantQueue`
// and only their edges need a page: the /api/jobs read is recorded, and the pane's host is absent.
const build = ({ answers = [] } = {}) => {
  const posts = [];
  const fetches = [];
  const paints = [];
  const frames = answers.slice();
  const asPost = async (route, body) => {
    posts.push({ route, body });
    const next = frames.length ? frames.shift() : { ok: true, cleared: { admissions: [], wakes: [], watches: [] } };
    return typeof next === "function" ? await next(route, body) : next;
  };
  const apiFetch = async (route) => {
    fetches.push(route);
    return { ok: true, status: 200, json: async () => ({ jobs: [] }) };
  };
  const api = new Function(
    "esc",
    "assistantIds",
    "sessionById",
    "assistantThreadName",
    "asPost",
    "apiFetch",
    "state",
    "isAssistant",
    "hostFor",
    "showBanner",
    "document",
    `${region}
return { queueAgentChip, queueAgentHtml, queueTaskHtml, queueReattach, queueReattachNoteHtml, REATTACH_TEXT };`,
  )(
    esc,
    () => ["assistant-1", "assistant-2"],
    (id) => ({ id, name: `Assistant ${id}` }),
    (t) => t,
    asPost,
    apiFetch,
    { assistantView: null },
    () => false,
    (id, sub) => {
      paints.push(`${id}:${sub}`);
      return null;
    },
    () => {},
    { getElementById: () => null },
  );
  return { api, posts, fetches, paints };
};

const jobs = (pairs) => new Map(pairs);
const row = (threads, extra = {}) => ({ id: 7, title: "re-attach me", state: "queued", files: [], threads, ...extra });

test("the stopped chip is a real button carrying the thread, the assistant and the task", () => {
  const { api } = build({ jobs: jobs([["T-failed", { status: "failed", runId: "run_1" }]]) });
  const html = api.queueTaskHtml("assistant-2", row(["T-failed"]), jobs([["T-failed", { status: "failed", runId: "run_1" }]]));
  const m = /<button type="button" class="[^"]*pill-reattach[^"]*"[^>]*>exited<span class="pill-again"[^>]*>↻<\/span><\/button>/.exec(html);
  assert.ok(m, "the exited chip is a <button> carrying the ↻ glyph");
  const tag = m[0].slice(0, m[0].indexOf(">exited"));
  assert.ok(tag.includes('data-as-qreattach="T-failed"'), "the press names the thread it re-attaches");
  assert.ok(tag.includes('data-as-qown="assistant-2"'), "…the assistant whose queue this card is in");
  assert.ok(tag.includes('data-as-qid="7"'), "…and the task it sits on");
  assert.ok(/title="exited — re-attach this assistant: /.test(tag), "the hover text says what the press does");
  assert.ok(tag.includes('aria-label="exited — re-attach this assistant on T-failed"'), "the label names the thread");
  assert.ok(tag.includes("pill-notrunning") && tag.includes("is-failed"), "…and it is still the card's own red chip");
});

test("not-running is the same control; a live run and a finished one are not", () => {
  const { api } = build();
  const stopped = api.queueTaskHtml(
    "assistant-1",
    row(["T-gone", "T-live", "T-done"]),
    jobs([
      ["T-gone", { status: "cancelled" }],
      ["T-live", { status: "running" }],
      ["T-done", { status: "done" }],
    ]),
  );
  assert.ok(/<button type="button" class="pill pill-notrunning pill-reattach"[^>]*data-as-qreattach="T-gone"/.test(stopped), "a stopped run is the press");
  assert.ok(!/data-as-qreattach="T-live"/.test(stopped), "a LIVE run is a word, not a control — nothing to re-attach");
  assert.ok(/<span class="pill pill-running" title="[^"]*">running<\/span>/.test(stopped), "…and it is drawn as the plain pill");
  assert.ok(/<button type="button" class="pill pill-complete"[^>]*data-as-qopen="T-done"/.test(stopped), "COMPLETE still opens the card");
  assert.ok(!/data-as-qreattach="T-done"/.test(stopped), "…and is not the re-attach press");
});

test("the press clears the fence, starts ONE short turn, and the card names that run", async () => {
  const { api, posts, fetches, paints } = build({
    answers: [
      { ok: true, assistant: { id: "assistant-2" }, cleared: { admissions: [{ runId: "run_1" }, { runId: "run_3" }], wakes: [], watches: [] } },
      { job: { id: "job_9", runId: "run_new" }, assistant: { id: "assistant-2" } },
    ],
  });
  await api.queueReattach("assistant-2", "7");
  assert.deepEqual(posts.map((p) => p.route), ["/api/assistants/assistant-2/reset", "/api/assistant/say"], "the reset, then one turn");
  assert.deepEqual(posts[0].body, { dryRun: false, reason: "the reader pressed EXITED" }, "the call that worked tonight, verbatim");
  assert.deepEqual(posts[1].body, { text: "you were re-attached after an exit; continue", assistantId: "assistant-2" }, "the short turn, on the same assistant");
  assert.equal(api.REATTACH_TEXT, "you were re-attached after an exit; continue");
  assert.equal(
    api.queueReattachNoteHtml("assistant-2", "7"),
    '<div class="as-task-note is-good" role="status" title="cleared 2 wedged run(s), run run_new started">cleared 2 wedged run(s), run run_new started</div>',
    "the card says what happened, and which run it became",
  );
  assert.ok(fetches.includes("/api/jobs"), "the chip's word is re-read from /api/jobs");
  assert.ok(paints.includes("assistant-2:queue"), "…and the pane is repainted from it");
  assert.ok(!posts.some((p) => /restart/i.test(p.route)), "nothing restarts the panel or the gateway");
});

test("a healthy card says nothing was wedged and starts NO run", async () => {
  const { api, posts } = build({ answers: [{ ok: true, cleared: { admissions: [], wakes: [{ reason: "sweep" }], watches: [] } }] });
  await api.queueReattach("assistant-1", "3");
  assert.deepEqual(posts.map((p) => p.route), ["/api/assistants/assistant-1/reset"], "one reset — and no /say at all");
  const note = api.queueReattachNoteHtml("assistant-1", "3");
  assert.ok(note.includes("nothing was wedged"), "the no-op is said out loud");
  assert.ok(note.includes("no run was started"), "…including the part the reader needs: nothing started");
  assert.ok(note.includes("1 queued wake(s)"), "what the reset DID drop is said too, not hidden behind the headline");
  assert.ok(note.includes("is-info"), "…painted as the honest no-op, not as a failure");
});

test("a refusal is printed verbatim, and nothing is started", async () => {
  const refusal =
    "not reset — Assistant #1 has a run still executing (run_1 · started 2m ago). Wait for it or stop it on its card; a reset never touches an executing turn.";
  const { api, posts } = build({
    answers: [
      () => {
        const e = new Error(refusal);
        e.status = 409;
        throw e;
      },
    ],
  });
  await api.queueReattach("assistant-1", "4");
  assert.deepEqual(posts.map((p) => p.route), ["/api/assistants/assistant-1/reset"], "the wake is never reached");
  assert.equal(
    api.queueReattachNoteHtml("assistant-1", "4"),
    `<div class="as-task-note is-bad" role="status" title="${esc(refusal)}">${esc(refusal)}</div>`,
    "the route's own sentence, not a paraphrase",
  );
});

test("a 200 that is not ok is the incomplete verdict, and starts nothing", async () => {
  const error = "reset INCOMPLETE — 1 of 2 admission(s) cleared; the session is still fenced, so nothing local was cleared";
  const { api, posts } = build({ answers: [{ ok: false, verdict: "incomplete", cleared: { admissions: [{ runId: "run_1" }] }, error }] });
  await api.queueReattach("assistant-1", "5");
  assert.deepEqual(posts.map((p) => p.route), ["/api/assistants/assistant-1/reset"], "no wake after an incomplete reset");
  assert.ok(api.queueReattachNoteHtml("assistant-1", "5").includes(error), "the incomplete verdict is the answer");
});

test("a cleared fence with a refused wake never claims a run", async () => {
  const { api, posts } = build({
    answers: [
      { ok: true, cleared: { admissions: [{ runId: "run_1" }] } },
      () => {
        throw new Error("the assistant is switched off in settings");
      },
    ],
  });
  await api.queueReattach("assistant-1", "8");
  assert.equal(posts.length, 2, "the wake was attempted");
  const note = api.queueReattachNoteHtml("assistant-1", "8");
  assert.ok(note.includes("cleared 1 wedged run(s)"), "what happened is still said");
  assert.ok(note.includes("but the wake was refused — the assistant is switched off in settings"), "…and why nothing started");
  assert.ok(!note.includes("run  started") && !/run \S+ started/.test(note), "no run is claimed");
});

test("a second press while the first is out is ONE reset", async () => {
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  const { api, posts } = build({ answers: [() => gate, { job: { runId: "run_new" } }] });
  const first = api.queueReattach("assistant-1", "6");
  await api.queueReattach("assistant-1", "6");
  assert.equal(posts.length, 1, "one reset on the wire — the second press sent nothing");
  assert.ok(api.queueReattachNoteHtml("assistant-1", "6").includes("one reset is already running"), "…and it says so");
  release({ ok: true, cleared: { admissions: [{ runId: "run_1" }] } });
  await first;
  assert.deepEqual(posts.map((p) => p.route), ["/api/assistants/assistant-1/reset", "/api/assistant/say"], "one reset, one wake");
  assert.ok(api.queueReattachNoteHtml("assistant-1", "6").includes("run run_new started"), "the flight's own answer is the card's");
});

test("another assistant is never touched", async () => {
  const { api, posts } = build({
    answers: [{ ok: true, cleared: { admissions: [{ runId: "run_9" }] } }, { job: { runId: "run_a2" } }],
  });
  await api.queueReattach("assistant-2", "1");
  assert.equal(posts[0].route, "/api/assistants/assistant-2/reset", "the card's own assistant is the only one reset");
  assert.equal(posts[1].body.assistantId, "assistant-2", "…and the only one woken");
  assert.ok(!posts.some((p) => p.route.includes("assistant-1") || p.body?.assistantId === "assistant-1"), "calls never reach #1");
});

// ---- the ATTACH control's own fallback: a run in a worktree is never filed on the checkout above it --------------
//
// Job 24695761: ownerPath was the project's own checkout, cwd `.../.worktrees/take-the-surface-...`. The
// board had no row for the tree, and the page's `matchWorktree()` matched the CHECKOUT — the tree's own directory is
// inside it — so one press filed the card on the main row with no picker and no question. These are the two halves
// of that rule: the page's match (sliced out of public/app.js, so the shipped function is what runs) and the server's
// answer to the press (the real panel, over HTTP).
// The page's own matcher, sliced out of the shipped file (no copy), driven against a board of rows.
const appSource = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const filing = sliceRegion(appSource, "job tree filing");
const pageNorm = (p) => String(p || "").replace(/\\/g, "/").replace(/\/+$/, "");
// A repo-relative placeholder, not a folder on the machine that wrote this test: the matcher keys on the string, and
// naming a drive letter here would trip the absolute-paths gate on a fixture nothing opens.
const checkout = "tree-fixture/checkout";
const tree = `${checkout}/.worktrees/take-the-surface-the-task-brief-names-856f1f`;

function filingFor(rows) {
  const board = { rows: new Map(rows.map((p) => [`proj::${p}`, { path: p, project: "proj", name: p.split("/").pop() }])) };
  return new Function("normPath", "state", `${filing}\nreturn { worktreeRootOf, matchWorktree };`)(pageNorm, board);
}

test("the page's match never takes the checkout that CONTAINS a run's worktree", () => {
  // The checkout's row is present (it always is), and it is a prefix of the tree's path. The old deepest-prefix match
  // answered with it; the tree's own row did not exist, which is exactly the incident's shape.
  const withoutRow = filingFor([checkout]);
  assert.equal(withoutRow.matchWorktree(`${tree}/lib`), null, "no row at the tree means NO match — never the parent");
  assert.equal(withoutRow.worktreeRootOf(`${tree}/lib`), tree, "the .worktrees directory names the tree itself");

  // With the tree's row there, the deepest match is the tree — not the checkout and not the subdirectory.
  const withRow = filingFor([checkout, tree]);
  assert.equal(withRow.matchWorktree(`${tree}/lib`)?.path, tree);
  assert.equal(withRow.matchWorktree(tree)?.path, tree);
  // A directory OUTSIDE `.worktrees` keeps the old rule: the deepest containing row, so a run in the checkout's own
  // `lib/` is still the checkout's.
  assert.equal(withRow.matchWorktree(`${checkout}/lib`)?.path, checkout);
});

test("a press naming the checkout above a run's worktree is answered with the REAL tree, and its row is created", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wag-attach-parent-"));
  const repos = path.join(dir, "repos");
  const proj = path.join(repos, "proj");
  mkdirSync(proj, { recursive: true });
  runGit(proj, ["init", "-q", "-b", "main"]);
  configureRepo(proj);
  writeFileSync(path.join(proj, "README.md"), "# proj\n", "utf8");
  runGit(proj, ["add", "-A"]);
  runGit(proj, ["commit", "-q", "-m", "base"]);

  const treePath = path.join(proj, ".worktrees", "take-the-surface-856f1f");
  const thread = "T-24695761";
  // The card the panel comes back to: its run was in the tree, the tree has no row, and the recorded owner is the
  // checkout — the state the old attach fallback left behind.
  mkdirSync(path.join(dir, "logs"), { recursive: true });
  writeFileSync(
    path.join(dir, "logs", "jobs.json"),
    JSON.stringify({
      savedAt: new Date().toISOString(),
      jobs: [
        {
          id: "job_24695761",
          thread,
          turn: 1,
          status: "done",
          prompt: "work in the tree",
          cwd: sl(treePath),
          ownerPath: sl(proj),
          projectPath: sl(proj),
          startedAt: new Date(Date.now() - 60_000).toISOString(),
          endedAt: new Date(Date.now() - 30_000).toISOString(),
          lines: [],
        },
      ],
    }),
    "utf8",
  );

  const panel = await boot({
    dir,
    config: {
      scanRoots: [sl(repos)],
      projects: [{ name: "proj", path: sl(proj), mainBranch: "main", remote: null }],
      // Nothing but the job-tree pass may read this project: the slow clock is an hour away and so is every row
      // cadence, so a row for the tree can only come from the attach press itself.
      slowSeconds: 3600,
      worktreeSeconds: 3600,
      midSeconds: 3600,
      dormantSeconds: 3600,
      registrySeconds: 3600,
      fetchSeconds: -1,
      threads: 1,
      assistant: { enabled: false },
    },
  });
  t.after(() => panel.stop());

  await waitRow(panel.base, "proj", proj, { what: "the project's own row" });
  // The tree is cut AFTER boot, so the board has no row for it — the incident's shape.
  runGit(proj, ["worktree", "add", "-q", "-b", "wtgui/take-the-surface-856f1f", treePath]);

  // The press the reader made: the checkout, because that is what the picker/default offered.
  const answer = await postJson(panel.base, "/api/jobs/attach", { body: { thread, path: sl(proj) } });
  assert.equal(answer.status, 200, `the press is accepted and answered with the real tree: ${answer.text}`);
  assert.equal(sl(answer.json.ownerPath), sl(treePath), "the card is filed on the worktree its run is in");
  assert.equal(sl(answer.json.redirectedFrom), sl(proj), "…and the answer says which path it refused to use");
  // The row is created/claimed by that press, so the card has somewhere to live.
  const row = await waitRow(panel.base, "proj", treePath, { what: "the row the press created for the tree" });
  assert.equal(sl(row.path), sl(treePath));

  // …and the card reads as that tree's, not the checkout's: the same field the page files cards by.
  const state = await fetch(`${panel.base}/api/state`).then((r) => r.json());
  const card = state.jobs.find((j) => j.thread === thread);
  assert.ok(card, "the card is in the snapshot");
  assert.equal(sl(card.ownerPath), sl(treePath), "the card is filed where its run is — never on the parent row");
  assert.equal(sl(card.cwd), sl(treePath));
});

test("a press naming the checkout is REFUSED when git does not know the run's tree — the row is missing, said so", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wag-attach-missing-"));
  const repos = path.join(dir, "repos");
  const proj = path.join(repos, "proj");
  mkdirSync(proj, { recursive: true });
  runGit(proj, ["init", "-q", "-b", "main"]);
  configureRepo(proj);
  writeFileSync(path.join(proj, "README.md"), "# proj\n", "utf8");
  runGit(proj, ["add", "-A"]);
  runGit(proj, ["commit", "-q", "-m", "base"]);

  // A leftover folder where a tree used to be: it exists, and `git worktree list` does NOT name it.
  const husk = path.join(proj, ".worktrees", "gone-1a2b3c");
  mkdirSync(husk, { recursive: true });
  const thread = "T-99999999";
  mkdirSync(path.join(dir, "logs"), { recursive: true });
  writeFileSync(
    path.join(dir, "logs", "jobs.json"),
    JSON.stringify({
      savedAt: new Date().toISOString(),
      jobs: [
        {
          id: "job_gone",
          thread,
          turn: 1,
          status: "done",
          prompt: "work in the tree",
          cwd: sl(husk),
          ownerPath: null,
          projectPath: sl(proj),
          startedAt: new Date(Date.now() - 60_000).toISOString(),
          endedAt: new Date(Date.now() - 30_000).toISOString(),
          lines: [],
        },
      ],
    }),
    "utf8",
  );

  const panel = await boot({
    dir,
    config: {
      scanRoots: [sl(repos)],
      projects: [{ name: "proj", path: sl(proj), mainBranch: "main", remote: null }],
      slowSeconds: 3600,
      worktreeSeconds: 3600,
      midSeconds: 3600,
      dormantSeconds: 3600,
      registrySeconds: 3600,
      fetchSeconds: -1,
      threads: 1,
      assistant: { enabled: false },
    },
  });
  t.after(() => panel.stop());
  await waitRow(panel.base, "proj", proj, { what: "the project's own row" });

  const answer = await postJson(panel.base, "/api/jobs/attach", { body: { thread, path: sl(proj) } });
  assert.equal(answer.status, 409, `the press is refused rather than filed on the checkout: ${answer.text}`);
  assert.equal(answer.json.rowMissing, true, "the answer carries the verdict the page paints");
  assert.match(answer.json.error, /row for .*gone-1a2b3c is missing/i, "the sentence names the tree whose row is missing");
  assert.match(answer.json.error, /only the checkout that contains it/i, "…and why the checkout is not the answer");
  assert.equal(answer.json.ownerPath, undefined, "nothing was filed");

  // And the card is still on the unattached list rather than on the checkout's row.
  const state = await fetch(`${panel.base}/api/state`).then((r) => r.json());
  const card = state.jobs.find((j) => j.thread === thread);
  assert.equal(card.ownerPath, null, "the card was not moved anywhere");
  rmSync(husk, { recursive: true, force: true });
});

test("a card whose tree has no row is attached by git's own worktree list — a tree cut after boot, no manual step", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wag-attach-auto-"));
  const repos = path.join(dir, "repos");
  const proj = path.join(repos, "proj");
  mkdirSync(proj, { recursive: true });
  runGit(proj, ["init", "-q", "-b", "main"]);
  configureRepo(proj);
  writeFileSync(path.join(proj, "README.md"), "# proj\n", "utf8");
  runGit(proj, ["add", "-A"]);
  runGit(proj, ["commit", "-q", "-m", "base"]);

  const treePath = path.join(proj, ".worktrees", "cut-after-boot-9f9f9f");
  const thread = "T-AUTO-1";
  // The run's card is restored by the panel; its directory does not exist yet — a spawn whose tree is still being
  // cut, or a card that came back before the scan caught up. Nothing here names the tree to the panel but its own
  // record: no attach press, no refresh, no page.
  mkdirSync(path.join(dir, "logs"), { recursive: true });
  writeFileSync(
    path.join(dir, "logs", "jobs.json"),
    JSON.stringify({
      savedAt: new Date().toISOString(),
      jobs: [
        {
          id: "job_auto",
          thread,
          turn: 1,
          status: "done",
          prompt: "work in the tree",
          cwd: sl(treePath),
          ownerPath: null,
          projectPath: sl(proj),
          startedAt: new Date(Date.now() - 60_000).toISOString(),
          endedAt: new Date(Date.now() - 30_000).toISOString(),
          lines: [],
        },
      ],
    }),
    "utf8",
  );

  const panel = await boot({
    dir,
    config: {
      scanRoots: [sl(repos)],
      projects: [{ name: "proj", path: sl(proj), mainBranch: "main", remote: null }],
      // The scan cannot be what attaches this card: the slow clock is an hour away and so is every row cadence, so
      // the row and the owner can only have come from the job-tree pass.
      slowSeconds: 3600,
      worktreeSeconds: 3600,
      midSeconds: 3600,
      dormantSeconds: 3600,
      registrySeconds: 3600,
      fetchSeconds: -1,
      threads: 1,
      assistant: { enabled: false },
    },
  });
  t.after(() => panel.stop());
  await waitRow(panel.base, "proj", proj, { what: "the project's own row" });

  // The tree is cut now, the way any spawn or a hand-run `git worktree add` cuts one.
  runGit(proj, ["worktree", "add", "-q", "-b", "wtgui/cut-after-boot-9f9f9f", treePath]);

  // The row appears AND the card is filed on it, with no attach press anywhere in this test.
  const row = await waitRow(panel.base, "proj", treePath, { timeout: 40_000, what: "the row the job-tree pass created" });
  assert.equal(sl(row.path), sl(treePath));
  const until = Date.now() + 40_000;
  let card = null;
  for (;;) {
    const state = await fetch(`${panel.base}/api/state`).then((r) => r.json());
    card = state.jobs.find((j) => j.thread === thread) || null;
    if (card && sl(card.ownerPath) === sl(treePath)) break;
    if (Date.now() > until) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  assert.ok(card, "the card is in the snapshot");
  assert.equal(sl(card.ownerPath), sl(treePath), "the card attached itself to the tree git lists — no manual step");
});

// ---- every guard that asks "which tree is this card in" reads the run's cwd --------------------------------------
//
// The second half of job 24695761: a card whose ownerPath was the checkout made every such guard answer the READER's
// checkout — the collage of the board's own rules (two agents in one tree, the worktree-removal holder, a release's
// busy check, the leftover sweep, a TODO list, a report path) all read the parent. They are one function now
// (lib/job-trees.js `jobTreePath`), and these are the shipped readers, not copies.
test("the tree guards read the run's cwd — a mis-attached card is never working in the checkout", async () => {
  const { treeOfJob, liveJobsInTree } = await import("../lib/jobs.js");
  const { jobHoldingTree } = await import("../lib/worktrees.js");
  const { treeTail } = await import("../lib/assistant/read.js");
  const { reportRepos } = await import("../lib/completion.js");
  const { filedOwnerPath, jobTreePath } = await import("../lib/job-trees.js");

  // The incident's card: cwd is a subdirectory of the tree, ownerPath is the checkout that CONTAINS the tree.
  const job = { id: "job_24695761", thread: "T-1", status: "running", cwd: `${tree}/lib`, ownerPath: checkout };
  assert.equal(jobTreePath(job), tree, "the run is in the tree, not in the checkout");
  assert.equal(filedOwnerPath(job), tree, "…and the card is filed there, not on the parent row");
  assert.equal(treeOfJob(job), tree.toLowerCase(), "the ownership key is the tree");

  // One worker per tree: the checkout has nobody in it, the tree has this run.
  assert.deepEqual(liveJobsInTree([job], checkout), [], "no live agent is counted in the main checkout");
  assert.deepEqual(liveJobsInTree([job], tree).map((j) => j.id), ["job_24695761"]);

  // A removed worktree is refused only when a run really is in it.
  assert.equal(jobHoldingTree([job], checkout), null, "the checkout is not held by this run");
  assert.equal(jobHoldingTree([job], tree)?.id, "job_24695761", "the tree it is in IS held");

  // A report may sit in the tree (lib/completion.js `reportRepos`) and the digest names the tree (treeTail).
  assert.deepEqual(reportRepos(job), [tree, `${tree}/lib`], "the report's repo list is the run's tree, never the checkout");
  assert.equal(treeTail(job), ".worktrees/take-the-surface-the-task-brief-names-856f1f", "the digest names the worktree, not the checkout");
});
