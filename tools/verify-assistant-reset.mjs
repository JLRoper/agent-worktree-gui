// The assistant reset route, proved against a REAL panel and a real HTTP request — one section per copy state.
//
//   node tools/verify-assistant-reset.mjs
//
// The unit test (test/assistant-reset.test.js) drives the route factory with stubs. This file boots the panel through
// `startPanel` (tools/panel-testkit.mjs), seeds the panel's own job store and the durable `session_admissions` file
// under the sandbox's HERMES_HOME, points `apiServer.url` at the stub gateway from tools/reset-harness.mjs, and then
// presses `POST /api/assistants/assistant-2/reset` over HTTP with a real token — so the dispatcher, the path-param
// match, the body validation, the refusals, the resolve body and the store re-read are all the shipped ones.
//
// The five states the Settings control paints, each a REAL request:
//
//   1. dry run     200 ok, dryRun true, verdict clearable  — one row per admission and per watch, no POST of any kind
//   B. blocked     409 assistant_live                      — a run of the assistant's is still executing; nothing mutated
//   C. refused     409 fence_unclearable                   — every unknown row is unnameable; the copy names the resume path
//   D. success     200 ok, dryRun false                    — both ids from a fresh GET, the store's row settles, the
//                                                            watches are dropped and the projection reads `cancelled`
//   E. incomplete  200 ok false, verdict incomplete        — a failed resolve leaves the store fenced, so nothing local
//                                                            is cleared and the watches survive
//   F. fallback    200 ok, verdict clean                   — a row NO card names, named by the store's own `request_id`
//                                                            and verified by a GET, then resolved on that run id
//
// No real gateway is asked to settle a real admission, and the store the reset reads is the sandbox's own file — not
// the box's live ~/.hermes/state.db.
import {
  ASSISTANT,
  THREAD,
  bootResetSandbox,
  createAssistantTwo,
  insertRows,
  setRow,
  unknownRows,
} from "./reset-harness.mjs";
import { post, createVerifier } from "./panel-testkit.mjs";

const v = createVerifier();
const answer = (name, got, want) => v.check(name, got, want);
const ok = (name, cond, extra = "") => v.ok(name, cond, extra);

const box = await bootResetSandbox({ keep: true });
const { panel, gateway, stateDb, token } = box;

try {
  // ---- assistant #2, through the panel's own route -------------------------------------------------------
  const { response: created, rec: two } = await createAssistantTwo(panel, token);
  ok("POST /api/assistant/assistants creates Assistant #2", created.status === 201, created.text.slice(0, 200));
  answer("its thread id", two?.threadId, THREAD);
  const roster = (created.json?.assistant?.assistants || []).map((a) => a.id);
  answer("the roster the control's select is drawn from", roster, ["assistant-1", ASSISTANT]);

  // A watch it owns, and one on its own turn — both appear row by row in the dry run and are dropped by success.
  const w1 = await post(panel.base, "/api/assistant/watch", { token, body: { thread: "wtgui-a-worker-1a2b3c", title: "the queue fix is pushed", assistantId: ASSISTANT } });
  ok("a watch on a worker's thread is stamped with Assistant #2", w1.status === 201 && Boolean(w1.json?.watch), w1.text.slice(0, 200));
  const w2 = await post(panel.base, "/api/assistant/watch", { token, body: { thread: THREAD, title: "its own turn finished", assistantId: ASSISTANT } });
  ok("a watch on its own thread is stamped too", w2.status === 201 && Boolean(w2.json?.watch), w2.text.slice(0, 200));

  const resetRoute = `/api/assistants/${ASSISTANT}/reset`;
  const watchesNow = async () => {
    const state = await (await fetch(`${panel.base}/api/assistant`)).json();
    return (state.watches || []).filter((w) => w.assistantId === ASSISTANT).map((w) => w.id);
  };
  answer("the two watches are on Assistant #2 before any press", (await watchesNow()).length, 2);

  // ---- 1. dry run: the rows, and no POST of any kind -------------------------------------------------------
  const before = gateway.posts();
  const dry = await post(panel.base, resetRoute, { token, body: { dryRun: true, reason: "prove: dry run" } });
  answer("dry run: status", dry.status, 200);
  answer("dry run: ok", dry.json?.ok, true);
  answer("dry run: dryRun", dry.json?.dryRun, true);
  answer("dry run: verdict", dry.json?.verdict, "clearable");
  answer("dry run: stillFenced is today's store truth", dry.json?.stillFenced, true);
  answer("dry run: the assistant it names", dry.json?.assistant, { id: ASSISTANT, name: "Assistant #2", threadId: THREAD });
  answer("dry run: one ROW per admission", dry.json?.clear?.admissions?.length, 1);
  const row = dry.json?.clear?.admissions?.[0] || {};
  answer("dry run: the row names the run", row.runId, "run_1");
  answer("dry run: the row names the admission", row.admissionId, "adm_1");
  answer("dry run: the row names the generation the fresh GET returned", row.executionGeneration, 1);
  answer("dry run: the row names the card", row.card?.id, "card_1");
  answer("dry run: the row's action", row.action, "resolve-unknown");
  answer("dry run: one ROW per watch it would drop", dry.json?.clear?.watches?.length, 2);
  answer("dry run: the keeps line's queue count", dry.json?.keep?.queue?.rows, 0);
  answer("dry run: charter chars is a number", typeof dry.json?.keep?.charter?.chars, "number");
  answer("dry run: the gateway was asked NOTHING to settle", gateway.posts() - before, 0);

  // ---- B. blocked: 409 assistant_live --------------------------------------------------------------------
  gateway.state.runs.run_2.status = "started";
  const live = await post(panel.base, resetRoute, { token, body: { dryRun: true } });
  answer("blocked: status", live.status, 409);
  answer("blocked: code", live.json?.code, "assistant_live");
  answer("blocked: it names the executing run", live.json?.runId, "run_2");
  ok("blocked: the sentence says the run is still executing", /still executing/.test(String(live.json?.error || "")), live.json?.error);
  ok("blocked: it says how long it has been going", /started \d+m ago/.test(String(live.json?.error || "")), live.json?.error);
  answer("blocked: nothing was sent to the gateway", gateway.posts(), before);
  gateway.state.runs.run_2.status = "cancelled";

  // ---- C. refused: 409 fence_unclearable -----------------------------------------------------------------
  // A store row with NO card naming its run — the live shape from the design (§1.1) — and no nameable row beside it:
  // the refusal is for a session whose EVERY unknown row is unnameable, so the one clearable row settles first.
  setRow(stateDb, "adm_1");
  insertRows(stateDb, [{ admissionId: "adm_gone", requestId: "run_gone", threadId: THREAD, generation: 63, ownerEpoch: 18 }]);
  const refused = await post(panel.base, resetRoute, { token, body: {} });
  answer("refused: status", refused.status, 409);
  answer("refused: code", refused.json?.code, "fence_unclearable");
  answer("refused: it carries the admission it could not name", refused.json?.admissions?.[0]?.admissionId, "adm_gone");
  answer("refused: and its generation", refused.json?.admissions?.[0]?.generation, 63);
  ok("refused: the copy says no card here names it", /no card here names/.test(String(refused.json?.error || "")), refused.json?.error);
  ok("refused: the copy names the resume command with the real thread", String(refused.json?.error || "").includes(`hermes --resume ${THREAD}`), refused.json?.error);
  answer("refused: nothing was sent to the gateway", gateway.posts(), before);
  answer("refused: no watch was dropped", (await watchesNow()).length, 2);
  setRow(stateDb, "adm_gone");
  setRow(stateDb, "adm_1", { status: "unknown", outcome: null });

  // ---- D. success: the resolve, the store re-read, the local drop -----------------------------------------
  const success = await post(panel.base, resetRoute, { token, body: { reason: "prove: success" } });
  answer("success: status", success.status, 200);
  answer("success: ok", success.json?.ok, true);
  answer("success: dryRun", success.json?.dryRun, false);
  answer("success: verdict", success.json?.verdict, "clean");
  answer("success: stillFenced (from the store re-read)", success.json?.stillFenced, false);
  answer("success: one receipt", success.json?.receipts?.length, 1);
  answer("success: the receipt's outcome is the gateway's word", success.json?.receipts?.[0]?.receipt?.outcome, "interrupted");
  answer("success: the receipt's status", success.json?.receipts?.[0]?.receipt?.status, "terminal");
  answer("success: one admission cleared", success.json?.cleared?.admissions?.length, 1);
  answer("success: both watches dropped", success.json?.cleared?.watches?.length, 2);
  answer("success: no wake was queued to drop", success.json?.cleared?.wakes?.length, 0);
  answer("success: the resolve body carried both ids from the fresh GET", gateway.state.resolveCalls.at(-1)?.body, { admission_id: "adm_1", execution_generation: 1 });
  answer("success: the body is exactly the two keys the gateway accepts", gateway.state.resolveCalls.at(-1)?.keys, ["admission_id", "execution_generation"]);
  answer("success: the resolve path is the run's own", gateway.state.resolveCalls.at(-1)?.runId, "run_1");
  answer("success: the reset never used /stop", gateway.state.stopCalls.length, 0);
  answer("success: the store has no unknown row left", unknownRows(stateDb), []);
  const projection = await (await fetch(`${gateway.url}/v1/runs/run_1`)).json();
  answer("success: the projection now reads cancelled", projection.status, "cancelled");
  answer("success: the watches are gone from the assistant", await watchesNow(), []);
  const journal = await (await fetch(`${panel.base}/api/assistant`)).json();
  ok("success: one `reset` line closes the journal", (journal.journal || []).some((j) => j.kind === "reset"), JSON.stringify((journal.journal || []).slice(-1)));

  // ---- E. incomplete: a failed resolve leaves the fence standing --------------------------------------------
  insertRows(stateDb, [
    { admissionId: "adm_3", requestId: "run_3", threadId: THREAD, generation: 7 },
    { admissionId: "adm_4", requestId: "run_gone_2", threadId: THREAD, generation: 64 },
  ]);
  await post(panel.base, "/api/assistant/watch", { token, body: { thread: THREAD, title: "a watch that must survive", assistantId: ASSISTANT } });
  gateway.state.failResolve.add("run_3");
  const beforeIncomplete = gateway.posts();
  const incomplete = await post(panel.base, resetRoute, { token, body: {} });
  answer("incomplete: status", incomplete.status, 200);
  answer("incomplete: ok", incomplete.json?.ok, false);
  answer("incomplete: verdict", incomplete.json?.verdict, "incomplete");
  answer("incomplete: stillFenced", incomplete.json?.stillFenced, true);
  answer("incomplete: one receipt, and it failed", incomplete.json?.receipts?.map((r) => r.ok), [false]);
  answer("incomplete: the failure is the gateway's own code", incomplete.json?.receipts?.[0]?.code, "stale_generation");
  answer("incomplete: nothing local was cleared", incomplete.json?.cleared?.watches?.length, 0);
  ok(
    "incomplete: the sentence says INCOMPLETE and how many cleared",
    /reset INCOMPLETE/.test(String(incomplete.json?.error || "")) && /0 of 1/.test(String(incomplete.json?.error || "")),
    incomplete.json?.error,
  );
  answer("incomplete: the watch it kept is still there", (await watchesNow()).length, 1);
  answer("incomplete: the store is still fenced", unknownRows(stateDb), ["adm_3", "adm_4"]);
  answer("incomplete: the second press did reach the gateway", gateway.posts() - beforeIncomplete, 1);

  // ---- F. fallback: a row no card names, named by the store's own request_id ------------------------------
  // The live shape from the design's §1.1: the admission's run is on no card, but the store's `request_id` is a run
  // id the gateway still answers for. The route must name it, verify it, and resolve THAT run — never a guess.
  setRow(stateDb, "adm_3");
  setRow(stateDb, "adm_4");
  insertRows(stateDb, [{ admissionId: "adm_fb", requestId: "run_fb", threadId: THREAD, generation: 63, ownerEpoch: 18 }]);
  gateway.state.runs.run_fb = { run_id: "run_fb", status: "unknown", admission_id: "adm_fb", execution_generation: 63, pending_controls: [] };
  const beforeFallback = gateway.posts();
  const fbDry = await post(panel.base, resetRoute, { token, body: { dryRun: true } });
  answer("fallback: dry run status", fbDry.status, 200);
  answer("fallback: verdict", fbDry.json?.verdict, "clearable");
  answer("fallback: one row", fbDry.json?.clear?.admissions?.length, 1);
  const fbRow = fbDry.json?.clear?.admissions?.[0] || {};
  answer("fallback: the run is the store's request id", fbRow.runId, "run_fb");
  answer("fallback: no card names it", fbRow.card, null);
  answer("fallback: the admission", fbRow.admissionId, "adm_fb");
  answer("fallback: the generation is the GET's", fbRow.executionGeneration, 63);
  answer("fallback: the evidence says how it was named", fbRow.evidence?.namedBy, "store-request-id");
  answer("fallback: the dry run sent no POST", gateway.posts() - beforeFallback, 0);

  const fbReal = await post(panel.base, resetRoute, { token, body: { reason: "prove: fallback" } });
  answer("fallback: real status", fbReal.status, 200);
  answer("fallback: ok", fbReal.json?.ok, true);
  answer("fallback: verdict", fbReal.json?.verdict, "clean");
  answer("fallback: the resolve path is the store's run id", gateway.state.resolveCalls.at(-1)?.runId, "run_fb");
  answer("fallback: the paired body", gateway.state.resolveCalls.at(-1)?.body, { admission_id: "adm_fb", execution_generation: 63 });
  answer("fallback: the receipt says how it was named", fbReal.json?.receipts?.[0]?.namedBy, "store-request-id");
  answer("fallback: the store row settled", unknownRows(stateDb), []);
} finally {
  const log = await box.stop();
  if (v.failures) console.log(`\npanel log (tail):\n${log.split("\n").slice(-25).join("\n")}`);
  console.log(`\n${v.checks - v.failures}/${v.checks} checks passed`);
  process.exitCode = v.failures ? 1 : 0;
}
