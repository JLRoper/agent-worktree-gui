// What a restarted panel says about the turn it lost — and what it does with the run that outlived it.
//
// `load()` stamps every turn that was running as `interrupted` because the panel can no longer steer it — not because
// the agent stopped. The run lives in the gateway, so the panel has to ask before that verdict stands, and it has to
// stop the dead turn's clocks: live on 7473 a deploy turn the panel gave up on at 03:11 finished at 03:18, and at
// 04:17 the card still read "interrupted · 79m22s … may still be live", its last tool burst ticking "running 77m16s".
//
// Asking is not enough, though, and this is what the script now pins: the write-off it landed on for a run the gateway
// still HAD ("… so it will finish on its own, but this card cannot steer it") was a dead end in both directions.
//   * A run still going in the gateway is not a lost turn: the panel lost the STREAM, so the card is re-attached —
//     back to `running`, steerable, with its stream and its status poll again — and its outcome is adopted from the
//     terminal event that arrives when the run actually finishes.
//   * A run that has since LEFT the gateway (404) makes that write-off's promise false, and a card carrying it never
//     resolves: the promise is cleared and the card reads interrupted-by-restart, saying only what is known.
//   * A gateway that cannot answer for a run (a 5xx) is not an answer: the verdict stands, untouched, and is asked
//     again later. That is the control for the two above.
//
//   node tools/verify-restored-turns.mjs
//
// WHAT IS DRIVEN: the shipped `Jobs` store itself — `load()`, `reconcileRestored()` and the re-attached card's own
// event stream — against a stub gateway on an ephemeral port. No panel process is spawned, so nothing here touches
// :7331 or :8642.
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { renderCompletionNotice } from "../lib/completion.js";

const { Jobs } = await import("../lib/jobs.js");

let failed = 0;
let checks = 0;
const check = (name, got, want) => {
  checks += 1;
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}: ${JSON.stringify(got)}${ok ? "" : `  (wanted ${JSON.stringify(want)})`}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, { timeoutMs = 8000, stepMs = 100 } = {}) => {
  const until = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() > until) return false;
    await sleep(stepMs);
  }
};

// ── a gateway that answers per run id ───────────────────────────────────────────────────────────
// `null` is the gateway saying Run not found; "error" is it failing to answer at all; and a run whose status reads
// `running` is HELD — its event stream stays open until the answer changes, the way the real gateway holds one.
const answers = {
  run_done: { status: "completed", output: "Deployed to both nodes and tested end-to-end.", usage: { total_tokens: 1200, input_tokens: 1000, output_tokens: 200 } },
  run_live: { status: "running" },
  run_gone: null,
  run_promise: null,
  run_unknown: "error",
};
const hits = {};
const server = createServer((req, res) => {
  const parts = String(req.url || "").split("/").filter(Boolean);
  const id = parts[2] ? decodeURIComponent(parts[2]) : "";
  const sub = parts[3] || "";
  hits[id] = (hits[id] || 0) + 1;
  if (sub === "events") {
    // SSE frames separated by a blank line, then the stream ends the way the gateway ends one: with the run's own
    // terminal event, which is exactly what a re-attached card is waiting for.
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    const timer = setInterval(() => {
      const a = answers[id];
      if (!a || a === "error" || a.status === "running") return;
      clearInterval(timer);
      const evt = { event: `run.${a.status}`, output: a.output, usage: a.usage, exit_code: a.exit_code };
      res.write(`event: run.${a.status}\ndata: ${JSON.stringify(evt)}\n\n`);
      res.end();
    }, 120);
    req.on("close", () => clearInterval(timer));
    return;
  }
  if (answers[id] === "error") {
    res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ error: { message: "internal error" } }));
    return;
  }
  if (!(id in answers) || answers[id] === null) {
    res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: { message: "Run not found", code: "run_not_found" } }));
    return;
  }
  res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ run_id: id, ...answers[id] }));
});
await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
const url = `http://127.0.0.1:${server.address().port}`;

// ── the store a restart left behind ─────────────────────────────────────────────────────────────
// Five turns were running when the panel died, each keeping the last line it saw and no endedAt — and one card was
// already written off by the OLD code, promise and measured outcome included, which is the state the reader's own
// store is in.
const START = "2026-10-24T02:56:46.400Z";
const LAST = Date.parse("2026-10-24T03:09:19.351Z");
const PROMISE = "the panel restarted while this was running — the gateway still has run run_promise, so it will finish on its own, but this card cannot steer it";
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
    jobs: [
      job("j-done", "run_done", { turn: 8 }),
      job("j-live", "run_live", { turn: 7 }),
      job("j-gone", "run_gone", { turn: 6 }),
      // Written off by the old code: interrupted, the promise in its error, an endedAt, and the outcome that promise
      // was measured into (the completion notice is rebuilt from it on load).
      job("j-promise", "run_promise", {
        turn: 5,
        status: "interrupted",
        endedAt: new Date(LAST).toISOString(),
        error: PROMISE,
        outcome: { word: "interrupted", exitCode: null, source: null, reason: PROMISE },
      }),
      job("j-unknown", "run_unknown", { turn: 4 }),
      job("j-none", null, { turn: 3 }),
    ],
  }),
);

const logs = [];
const jobs = new Jobs({ config: { jobsFile: storePath, apiServer: { url, key: "test-key" } }, onLog: (l) => logs.push(String(l)) });
const byId = (id) => jobs.jobs.get(id);
const textOf = (j) => (j.lines || []).map((l) => String(l.text || "")).join("\n");

// ── the restart verdict, before anything is asked ───────────────────────────────────────────────
console.log("a restart cut the panel off mid-turn");
check(
  "every running turn is interrupted",
  ["j-done", "j-live", "j-gone", "j-unknown", "j-none"].map((id) => byId(id).status),
  ["interrupted", "interrupted", "interrupted", "interrupted", "interrupted"],
);
check(
  "its clock stops at the last line the panel saw",
  ["j-done", "j-live", "j-gone", "j-unknown", "j-none"].map((id) => byId(id).endedAt),
  Array(5).fill(new Date(LAST).toISOString()),
);
check("an interrupted turn still says the run may be live", /may still be live in the gateway/.test(byId("j-done").error), true);
check("a card the old code wrote off keeps its promise at this point", byId("j-promise").error, PROMISE);
check("...and the outcome its notice is built from carries the same sentence", byId("j-promise").outcome.reason, PROMISE);

// ── asking the run ──────────────────────────────────────────────────────────────────────────────
console.log("the run's own answer decides the verdict");
const settled = await jobs.reconcileRestored();
// j-unknown (a 5xx) and j-none (no run id) are not in here: neither is an answer this panel can act on.
check("the turns the gateway answered for were reconciled", settled, ["j-done", "j-live", "j-gone", "j-promise"]);

const done = byId("j-done");
check("a run that finished reads done", done.status, "done");
check("its exit code is zero", done.exitCode, 0);
check("the restart's error is gone", done.error, "");
check("the clock still stops where the panel last saw it", done.endedAt, new Date(LAST).toISOString());
check("the gateway's tokens come back", done.tokens, { total: 1200, input: 1000, output: 200 });
check("the console says who finished it", done.lines.at(-2).kind, "result");
check("...and that the stream was lost", /run completed in the gateway/.test(done.lines.at(-2).text), true);
check("the answer the gateway kept is put back", done.lines.at(-1).text, "Deployed to both nodes and tested end-to-end.");

// ── the run that outlived the panel: re-attached, not written off ───────────────────────────────
console.log("a run the gateway still has is re-attached rather than written off");
const live = byId("j-live");
check("the card is running again", live.status, "running");
check("the restart's error is cleared", live.error, "");
check("it is marked re-attached, once", live.reattached, true);
check("the stopped clock is handed back to the live run", live.endedAt, null);
check("no stale completion rides a running card", live.completion, null);
check("nothing on the card claims it cannot be steered", /cannot steer it/.test(textOf(live)), false);
check("the console says what the panel did", /re-attached to it and can steer it again/.test(textOf(live)), true);
check("the card holds the run's stream again", await waitFor(() => live.streamOpen === true, { timeoutMs: 3000 }), true);
check("it asked for that stream itself", hits.run_live >= 1, true);

// ...and its outcome is adopted when the run actually finishes, through that stream.
answers.run_live = { status: "completed", output: "Finished after the panel came back.", usage: { total_tokens: 900, input_tokens: 700, output_tokens: 200 }, exit_code: 0 };
check("the re-attached run settles on its own terminal event", await waitFor(() => byId("j-live").status !== "running", { timeoutMs: 8000 }), true);
check("...as done", live.status, "done");
check("...with the answer the run finished on", live.finalMessage, "Finished after the panel came back.");
check("...a duration measured across the whole run", live.durationMs > 0, true);
check("...and the restart's error off the card for good", live.error, "");
check("the console carries the run's own result line", /run completed · tokens 900/.test(textOf(live)), true);

// ── a run the gateway no longer has: the promise is cleared ─────────────────────────────────────
console.log("a run that has left the gateway drops the promise it was written off with");
const gone = byId("j-gone");
check("the verdict is still interrupted", gone.status, "interrupted");
check("...with the restart's wording and the run id", /^the panel restarted while this was running — the gateway no longer has run run_gone/.test(gone.error), true);
check("...and no promise that it will finish", /will finish on its own/.test(gone.error), false);
check("...and no claim about steering", /cannot steer it/.test(gone.error), false);
check("the console records what the gateway said", /no record of run run_gone/.test(textOf(gone)), true);
check("...and that no outcome was ever seen", /never saw its outcome/.test(textOf(gone)), true);
check("the outcome is the panel's own reading of the restart", [gone.outcome.word, gone.outcome.exitCode, gone.outcome.reason], ["interrupted", null, gone.error]);
check("its clock still stops where the panel last saw it", gone.endedAt, new Date(LAST).toISOString());

const promise = byId("j-promise");
check("the card the old code wrote off is repaired too", promise.status, "interrupted");
check("...its promise replaced by what the gateway said", /^the panel restarted while this was running — the gateway no longer has run run_promise/.test(promise.error), true);
check("...the sentence it was written off with gone from the error", /will finish on its own/.test(promise.error), false);
check("...gone from the outcome the notice is built from", /will finish on its own/.test(String(promise.outcome.reason)), false);
check("...so its outcome now says what its error says", promise.outcome.reason, promise.error);
check("...and the completion notice promises nothing", /will finish on its own/.test(renderCompletionNotice(promise.completion)), false);
check("...while still naming the run and the way it stopped", /run_promise/.test(renderCompletionNotice(promise.completion)), true);
check("the console says what happened to it", /no record of run run_promise/.test(textOf(promise)), true);

// ── the control: no answer is not an answer ─────────────────────────────────────────────────────
console.log("a gateway that cannot answer for a run leaves the verdict alone");
const unknown = byId("j-unknown");
check("the 5xx case keeps the restart's verdict", unknown.status, "interrupted");
check("...with its original wording", /may still be live in the gateway/.test(unknown.error), true);
check("...and nothing was written to its console", /gateway has no record/.test(textOf(unknown)), false);
const askedOnce = hits.run_unknown;
await jobs.reconcileRestored();
check("...and it is asked again on the next pass, not settled", hits.run_unknown > askedOnce, true);
// The repaired cards are asked again too, and that second ask changes nothing: the wording is already final.
check("...while the repaired cards are left as they are", [byId("j-gone").error, byId("j-promise").error], [gone.error, promise.error]);
check("a second pass has nothing left to reconcile", await jobs.reconcileRestored(), []);

const none = byId("j-none");
check("a turn with no run id is never asked", none.status, "interrupted");

// The reconciled turns are what the store now holds: a second restart must not resurrect the old verdicts.
await new Promise((ok) => setTimeout(ok, 900)); // persistence is debounced by 700ms
const saved = JSON.parse(readFileSync(storePath, "utf8"));
const savedJob = (id) => saved.jobs.find((j) => j.id === id);
check("the store keeps the adopted status", savedJob("j-done").status, "done");
check("the store keeps the outcome the re-attached run ended on", savedJob("j-live").status, "done");
check("the store keeps the repair to the written-off card", /no longer has run run_promise/.test(savedJob("j-promise").error), true);
check("the store no longer carries the promise anywhere", /will finish on its own/.test(readFileSync(storePath, "utf8")), false);

server.close();
// The scratch store goes with the run: this script left one behind per invocation (12 of them had piled up in
// %TEMP%), which is noise a reader has to clear by hand for no gain.
rmSync(dir, { recursive: true, force: true });
console.log(failed ? `RESULT: ${failed} FAILED of ${checks}` : `RESULT: ALL PASS (${checks} checks)`);
process.exit(failed ? 1 : 0);
