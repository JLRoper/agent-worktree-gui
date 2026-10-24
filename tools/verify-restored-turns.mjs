// What a restarted panel says about the turn it lost.
//
// `load()` stamps every turn that was running as `interrupted` because the panel can no longer steer it — not because
// the agent stopped. The run lives in the gateway, so the panel has to ask before that verdict stands, and it has to
// stop the dead turn's clocks: live on 7473 a deploy turn the panel gave up on at 03:11 finished at 03:18, and at
// 04:17 the card still read "interrupted · 79m22s … may still be live", its last tool burst ticking "running 77m16s".
//
//   node tools/verify-restored-turns.mjs
//
// No gateway needed: a stub on an ephemeral port answers /v1/runs/{id} with the status each case is about.
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const { Jobs } = await import("../lib/jobs.js");

let failed = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}: ${JSON.stringify(got)}${ok ? "" : `  (wanted ${JSON.stringify(want)})`}`);
};

// ── a gateway that answers per run id ───────────────────────────────────────────────────────────
const answers = {
  run_done: { status: "completed", output: "Deployed to both nodes and tested end-to-end.", usage: { total_tokens: 1200, input_tokens: 1000, output_tokens: 200 } },
  run_live: { status: "running" },
  run_lost: null, // 404: the gateway has no record
};
const server = createServer((req, res) => {
  const id = String(req.url || "").split("/").pop();
  if (!(id in answers) || answers[id] === null) {
    res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: { message: "Run not found", code: "run_not_found" } }));
    return;
  }
  res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ run_id: id, ...answers[id] }));
});
await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
const url = `http://127.0.0.1:${server.address().port}`;

// ── the store a restart left behind ─────────────────────────────────────────────────────────────
// Three turns were running when the panel died. Each kept the last line it saw, and no endedAt.
const START = "2026-10-24T02:56:46.400Z";
const LAST = Date.parse("2026-10-24T03:09:19.351Z");
const dir = mkdtempSync(path.join(tmpdir(), "wtgui-restored-"));
const storePath = path.join(dir, "jobs.json");
const job = (id, runId, over = {}) => ({
  id,
  thread: "wtgui-restored",
  turn: 1,
  prompt: "deploy it",
  cwd: "C:/tmp",
  sessionId: "wtgui-restored",
  status: "running",
  exitCode: null,
  startedAt: START,
  endedAt: null,
  runId,
  lines: [
    { kind: "tool", lid: 1, at: LAST - 60_000, text: "💻 terminal · build the war" },
    { kind: "tool-out", lid: 2, at: LAST - 50_000, text: "  ↳ terminal" },
    { kind: "tool", lid: 3, at: LAST, text: "💻 terminal · KEY=… + 2 commands" },
  ],
  ...over,
});
writeFileSync(
  storePath,
  JSON.stringify({
    savedAt: START,
    jobs: [job("j-done", "run_done", { turn: 8 }), job("j-live", "run_live", { turn: 7 }), job("j-lost", "run_lost", { turn: 6 }), job("j-none", null, { turn: 5 })],
  }),
);

const logs = [];
const jobs = new Jobs({ config: { jobsFile: storePath, apiServer: { url, key: "test-key" } }, onLog: (l) => logs.push(String(l)) });
const byId = (id) => jobs.jobs.get(id);

// ── the restart verdict, before anything is asked ───────────────────────────────────────────────
console.log("a restart cut the panel off mid-turn");
check("every running turn is interrupted", ["j-done", "j-live", "j-lost", "j-none"].map((id) => byId(id).status), ["interrupted", "interrupted", "interrupted", "interrupted"]);
check(
  "its clock stops at the last line the panel saw",
  ["j-done", "j-live", "j-lost", "j-none"].map((id) => byId(id).endedAt),
  [new Date(LAST).toISOString(), new Date(LAST).toISOString(), new Date(LAST).toISOString(), new Date(LAST).toISOString()],
);
check("an interrupted turn still says the run may be live", /may still be live in the gateway/.test(byId("j-done").error), true);

// ── asking the run ──────────────────────────────────────────────────────────────────────────────
console.log("the run's own answer decides the verdict");
const settled = await jobs.reconcileRestored();
// j-lost is not in here: a 404 is the gateway saying it has nothing to say, so the verdict stands untouched.
check("the turns the gateway answered for were reconciled", settled, ["j-done", "j-live"]);

const done = byId("j-done");
check("a run that finished reads done", done.status, "done");
check("its exit code is zero", done.exitCode, 0);
check("the restart's error is gone", done.error, "");
check("the clock still stops where the panel last saw it", done.endedAt, new Date(LAST).toISOString());
check("the gateway's tokens come back", done.tokens, { total: 1200, input: 1000, output: 200 });
check("the console says who finished it", done.lines.at(-2).kind, "result");
check("...and that the stream was lost", /run completed in the gateway/.test(done.lines.at(-2).text), true);
check("the answer the gateway kept is put back", done.lines.at(-1).text, "Deployed to both nodes and tested end-to-end.");
check("a reconciled turn is not asked again", [...jobs.jobs.values()].filter((j) => j.status === "interrupted" && j.runId && !j.reconciled).map((j) => j.id), ["j-live", "j-lost"]);

const live = byId("j-live");
check("a run the gateway still holds stays interrupted", live.status, "interrupted");
check("...and says what that means", /the gateway still has run run_live/.test(live.error), true);
check("...without claiming the panel can steer it", /cannot steer it/.test(live.error), true);
check("...and it is not adopted", live.reconciled, undefined);

const lost = byId("j-lost");
check("a run the gateway has no record of keeps its verdict", lost.status, "interrupted");
check("...and its original reason", /may still be live in the gateway/.test(lost.error), true);

const none = byId("j-none");
check("a turn with no run id is never asked", none.status, "interrupted");

// The reconciled turn is what the store now holds: a second restart must not resurrect the interrupted verdict.
await new Promise((ok) => setTimeout(ok, 900)); // persistence is debounced by 700ms
const saved = JSON.parse(readFileSync(storePath, "utf8"));
check("the store keeps the reconciled status", saved.jobs.find((j) => j.id === "j-done").status, "done");

server.close();
console.log(failed ? `RESULT: ${failed} FAILED` : "RESULT: ALL PASS");
process.exit(failed ? 1 : 0);
