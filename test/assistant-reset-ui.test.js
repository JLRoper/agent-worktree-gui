// The assistant reset CONTROL: the row it sits in, the five copy states it paints, and the two-press shape.
//
// The renderer is the page's own code, sliced out of public/app.js and driven with the route's real answer shapes —
// the same style as test/agent-cleanup.test.js and test/assistant-queue-ui.test.js. What this pins:
//
//   1. the markup: a select, a button and its OWN #reset-preview inside the gateway restart row, after the two
//      restarts and after the restart line's preview (a reset answer never overwrites the restart's);
//   2. the five states, each from the body the route returns: dry run (row by row, then the keeps line), blocked
//      (409 assistant_live), refused (409 fence_unclearable, carrying the admissions it could not name), success
//      (the receipt's outcome, the projection's other word, then `hermes --resume <thread>`), and incomplete (the
//      store is still fenced, nothing local cleared, and the same resume path);
//   3. the success and incomplete copy name the resume command with the REAL thread id, and none of the copy ever
//      says "start a new panel session";
//   4. the press: the first sends { dryRun: true } and only that, a refusal disarms (a second press would ask the
//      same question), and the second sends the real call with `reason` and no `dryRun`.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const src = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../public/style.css", import.meta.url), "utf8");

const begin = src.indexOf("// ---- the assistant reset: a dry run, then one real clear");
const end = src.indexOf("// ---- end the assistant reset");
assert.ok(begin > 0 && end > begin, "the assistant reset region is in public/app.js");
const region = src.slice(begin, end);

const THREAD = "panel-assistant-2";

function build({ answers = [], selectValue = "assistant-2" } = {}) {
  const calls = [];
  const frames = answers.slice();
  let n = 0;
  const apiFetch = async (url, opts) => {
    const body = opts?.body ? JSON.parse(opts.body) : null;
    calls.push({ url, body });
    const answer = frames.length ? frames.shift() : { status: 200, body: dryBody() };
    return { ok: answer.status >= 200 && answer.status < 300, status: answer.status, json: async () => answer.body };
  };
  const btn = { dataset: { armed: "" }, textContent: "Reset assistant", title: "", disabled: false, classList: { add() {}, remove() {} } };
  const preview = { textContent: "", classList: { bad: false, toggle(_c, on) { this.bad = Boolean(on); }, remove() { this.bad = false; }, add() { this.bad = true; } } };
  const options = [];
  const select = {
    value: selectValue,
    textContent: "",
    hidden: false,
    appendChild(el) {
      options.push(el);
    },
  };
  const els = { "reset-assistant": select, "btn-reset-assistant": btn, "reset-preview": preview };
  const $ = (id) => els[id] || null;
  const banners = [];
  const doc = { createElement: () => ({ value: "", textContent: "", title: "" }) };
  // `unref` so a test that leaves an arm timer pending does not keep node --test on the feature's own clock.
  const later = (fn, ms) => {
    const t = globalThis.setTimeout(fn, ms);
    t?.unref?.();
    return t;
  };
  const api = new Function(
    "state",
    "$",
    "apiFetch",
    "showBanner",
    "document",
    "setTimeout",
    "clearTimeout",
    `${region}
return { resetCopyView, paintResetPreview, resetDryLines, paintResetRow, resetChosen, resetAssistant, resetDisarm, resetRoster };`,
  )(
    { assistant: { assistants: [{ id: "assistant-1", name: "Assistant #1", threadId: "panel-assistant" }, { id: "assistant-2", name: "Assistant #2", threadId: THREAD }] }, assistantThread: "panel-assistant" },
    $,
    apiFetch,
    (text) => banners.push(text),
    doc,
    later,
    (t) => globalThis.clearTimeout(t),
  );
  n += 1;
  return { api, calls, btn, preview, select, options, banners, frames };
}

// The dry run's body, as lib/assistant/reset.js returns it.
function dryBody(over = {}) {
  return {
    ok: true,
    dryRun: true,
    assistant: { id: "assistant-2", name: "Assistant #2", threadId: THREAD },
    clear: {
      admissions: [
        {
          runId: "run_3ea61cf9",
          admissionId: "a1209a5f",
          executionGeneration: 1,
          card: { id: "3f9a1c02", status: "interrupted", startedAt: "2026-11-04T01:02:11Z" },
          evidence: { runStatus: "unknown", answers: [[Date.now() - 4 * 60_000, "unknown"]] },
          action: "resolve-unknown",
        },
      ],
      wakes: [{ reason: "watch finished: land the queue fix", rule: "watch", assistantId: "assistant-2", at: Date.now() - 6 * 60_000, ageMs: 6 * 60_000 }],
      watches: [
        { id: "9c2d1e77", thread: "wtgui-a-worker-1a2b3c", title: "the queue fix is pushed", at: "T", state: "watching" },
        { id: "1f2e3d4c", thread: THREAD, title: "its own turn finished", at: "T", state: "watching" },
      ],
    },
    keep: { queue: { rows: 6 }, scratchpad: { notes: 1184, rules: 12, journal: 340, alerts: 4 }, charter: { chars: 20431, sha: "6f1c" } },
    block: { unnameable: [], queued: [{ runId: "run_51ea12df", executionGeneration: null, card: "0b7e4411" }], unreadable: [] },
    verdict: "clearable",
    stillFenced: true,
    ...over,
  };
}

const successBody = (over = {}) => ({
  ok: true,
  dryRun: false,
  assistant: { id: "assistant-2", name: "Assistant #2", threadId: THREAD },
  block: { unnameable: [], queued: [], unreadable: [] },
  verdict: "clean",
  stillFenced: false,
  cleared: { admissions: [{ runId: "run_3ea61cf9", admissionId: "a1209a5f", executionGeneration: 1, ok: true }], wakes: [{ reason: "one stale wake" }], watches: [{ id: "a" }, { id: "b" }] },
  kept: { queue: { rows: 6 }, scratchpad: { notes: 1184, rules: 12 }, charter: { chars: 20431, sha: "6f1c" } },
  receipts: [{ ok: true, status: 200, receipt: { run_id: "run_3ea61cf9", status: "terminal", outcome: "interrupted", authority_epoch: 19 } }],
  ...over,
});

// ---- 1. the markup ------------------------------------------------------------------------------------
test("the reset is the third control in the gateway restart row, with its own preview line", () => {
  const row = html.slice(html.indexOf('id="restart-row"'), html.indexOf('id="models-row"'));
  assert.match(row, /id="btn-restart-gateway"/);
  assert.match(row, /id="btn-restart-panel"/);
  assert.match(row, /<select id="reset-assistant" title="[^"]+"><\/select>/, "the select is empty markup — the roster is painted from state");
  assert.match(row, /<button id="btn-reset-assistant" type="button" title="Reset Assistant #1 — settle its gateway turn/, "the button's title names whose reset it is");
  const gateway = row.indexOf('id="btn-restart-gateway"');
  const panel = row.indexOf('id="btn-restart-panel"');
  const select = row.indexOf('id="reset-assistant"');
  const button = row.indexOf('id="btn-reset-assistant"');
  assert.ok(gateway > 0 && gateway < panel && panel < select && select < button, "the order is restart gateway, restart panel, select, reset");

  const restart = html.indexOf('id="restart-preview"');
  const reset = html.indexOf('id="reset-preview"');
  assert.ok(restart > 0 && reset > restart, "#reset-preview is its own line under the restart line, never over it");
  assert.equal((html.match(/id="btn-restart-/g) || []).length, 2, "still exactly two restart buttons — the reset is not a restart");
  assert.match(html, /id="reset-preview"[^>]*>…</, "the preview starts empty rather than claiming a state");
});

test("the reset preview is styled as a list, not a paragraph", () => {
  assert.match(css, /\.settings-preview\.reset \{[^}]*white-space: pre-wrap/, "one row per line needs pre-wrap");
  assert.match(css, /#restart-row \{[^}]*flex-wrap: wrap/, "three controls at 340px wrap instead of squeezing the select to its caret");
});

// ---- 2. the five copy states -------------------------------------------------------------------------
test("dry run: one row per admission, watch and wake, then the keeps line", () => {
  const { api } = build();
  const view = api.resetCopyView(dryBody(), 200, Date.now());
  assert.equal(view.kind, "dry");
  assert.equal(view.bad, false);
  assert.equal(view.lines[0], `Assistant #2 · ${THREAD}`);
  assert.match(view.lines[1], /^would clear 1 admission:$/);
  assert.match(view.lines[2], /run run_3ea61cf9 · admission a1209a5f · generation 1 · card 3f9a1c02 interrupted · unknown for 4m/, "the admission row is the run, admission, generation, card and the age of the unknown");
  const watches = view.lines.findIndex((l) => /^would drop 2 watches \(1 on its own turn, 1 on workers\):$/.test(l));
  assert.ok(watches > 0, "the watches' count says how many are on workers");
  assert.match(view.lines[watches + 1], /wtgui-a-worker-1a2b3c — the queue fix is pushed \(watching\)/, "a worker's watch is its own row");
  assert.match(view.lines[watches + 2], new RegExp(`${THREAD} — its own turn finished \\(watching\\)`), "so is its own");
  const wakes = view.lines.findIndex((l) => /^would drop 1 queued wake:$/.test(l));
  assert.ok(wakes > 0, "the wake is its own section");
  assert.match(view.lines[wakes + 1], /watch finished: land the queue fix \(rule watch, queued 6m ago\)/);
  assert.ok(view.lines.includes("keeps: 6 queue rows · 1184 notes · 12 rules · charter 20431 chars"), "the keeps line counts what survives");
  assert.ok(view.lines.some((l) => /^also: 1 turn queued behind the fence will start when it clears \(generation null\)\.$/.test(l)), "a queued run behind the fence is named");
  assert.equal(view.lines.at(-1), "press again to reset. The settled turn is reported interrupted and is not replayed — resend it if you still want it.");
});

test("a clean dry run says there is nothing to clear and asks for no second press", () => {
  const { api } = build();
  const view = api.resetCopyView(dryBody({ clear: { admissions: [], wakes: [], watches: [] }, block: { unnameable: [], queued: [], unreadable: [] }, verdict: "clean", stillFenced: false }), 200);
  assert.equal(view.kind, "dry");
  assert.equal(view.lines[1], "nothing is fenced. Nothing to clear.");
  assert.ok(!view.lines.some((l) => /press again/.test(l)), "an empty list must not invite a confirmation");
});

test("a partly unnameable dry run names the row it cannot settle and what the press will do", () => {
  const { api } = build();
  const view = api.resetCopyView(
    dryBody({ verdict: "blocked", block: { unnameable: [{ admissionId: "adm_gone", generation: 63, seq: 41 }], queued: [], unreadable: [] } }),
    200,
  );
  assert.equal(view.kind, "dry");
  assert.equal(view.bad, true, "a blocked dry run is painted as one");
  assert.ok(view.lines.some((l) => l.startsWith("blocked: 1 admission no card here names (admission adm_gone · generation 63 · seq 41)")), view.lines.join("\n"));
  assert.match(view.lines.at(-1), /press again to reset — it will settle what it can and report incomplete\. The rest needs a terminal: hermes --resume panel-assistant-2/);
});

test("blocked: 409 assistant_live is the route's own sentence, and nothing was cleared", () => {
  const { api } = build();
  const body = {
    ok: false,
    code: "assistant_live",
    error: "not reset — Assistant #2 has a run still executing (run_51ea12dfa92c4f339a8fc4b9af0e9e23 · started 12m ago). Wait for it or stop it on its card; a reset never touches an executing turn.",
    runId: "run_51ea12dfa92c4f339a8fc4b9af0e9e23",
    thread: THREAD,
    assistant: { id: "assistant-2", name: "Assistant #2", threadId: THREAD },
  };
  const view = api.resetCopyView(body, 409);
  assert.equal(view.kind, "blocked");
  assert.equal(view.bad, true);
  assert.equal(view.lines[0], body.error);
  assert.match(view.lines[1], /^nothing was cleared — the reset refuses before it mutates anything\./);
});

test("refused: 409 fence_unclearable carries every admission it could not name, and the resume path", () => {
  const { api } = build();
  const body = {
    ok: false,
    code: "fence_unclearable",
    error: `not reset — the fence on ${THREAD} is held by an admission no card here names (admission 16e7a6a7 · generation 63). This endpoint can only settle an admission through the run that owns it; there is no session-keyed resolve. Nothing would be cleared, including the watches. Continue that session in a terminal: hermes --resume ${THREAD}`,
    thread: THREAD,
    assistant: { id: "assistant-2", name: "Assistant #2", threadId: THREAD },
    admissions: [{ admissionId: "16e7a6a7", generation: 63, seq: 41, ownerEpoch: 18 }],
    stillFenced: true,
  };
  const view = api.resetCopyView(body, 409);
  assert.equal(view.kind, "refused");
  assert.equal(view.bad, true);
  assert.equal(view.lines[0], body.error);
  assert.equal(view.lines[1], "the admissions it could not name:");
  assert.equal(view.lines[2], "  · admission 16e7a6a7 · generation 63 · seq 41 · owner epoch 18");
  assert.match(view.lines[0], new RegExp(`hermes --resume ${THREAD}`), "the refusal names the way into the session");
});

test("success: the receipt's outcome, the projection's other word, and the resume command with the real thread", () => {
  const { api } = build();
  const view = api.resetCopyView(successBody(), 200);
  assert.equal(view.kind, "success");
  assert.equal(view.bad, false);
  assert.match(view.lines[0], /^reset — Assistant #2: 1 admission settled \(interrupted; the projection now reads cancelled\), 2 watches dropped, 1 wake dropped\./);
  assert.match(view.lines[0], /Kept 6 queue rows, the notes \(1184 notes, 12 rules\) and the charter \(20431 chars\)\./);
  assert.equal(view.lines[1], "If a panel turn is still refused with 409 permission_denied, the session is the CLI's:");
  assert.equal(view.lines[2], `continue it with hermes --resume ${THREAD}`);
  assert.ok(view.lines.some((l) => /not replayed — resend it if you still want it/.test(l)), "it says what resume does not do");
  assert.ok(!view.lines.join(" ").includes("start a new panel session"), "the abandoned-session advice is never in the reset path");
});

test("incomplete: the store is still fenced, nothing local was cleared, and the resume command is still named", () => {
  const { api } = build();
  const body = {
    ok: false,
    dryRun: false,
    assistant: { id: "assistant-2", name: "Assistant #2", threadId: THREAD },
    verdict: "incomplete",
    stillFenced: true,
    cleared: { admissions: [], wakes: [], watches: [] },
    kept: { queue: { rows: 6 }, scratchpad: { notes: 1184, rules: 12 }, charter: { chars: 20431 } },
    receipts: [{ ok: false, code: "stale_generation", error: "the generation has moved" }],
    error: "reset INCOMPLETE — 0 of 1 admission(s) cleared; the session is still fenced, so nothing local was cleared (2 watch(es) and 1 wake(s) kept). Re-run to retry the remaining row.",
  };
  const view = api.resetCopyView(body, 200);
  assert.equal(view.kind, "incomplete");
  assert.equal(view.bad, true);
  assert.equal(view.lines[0], body.error);
  assert.equal(view.lines[1], `still fenced — a terminal is the only way into that session now: hermes --resume ${THREAD}`);
  assert.match(view.lines[2], /does not replay the lost turn/);
});

test("an answer that is neither of the five is painted as the failure it is, not as a sixth state", () => {
  const { api } = build();
  const store = api.resetCopyView({ ok: false, code: "store_unreadable", error: "could not read the session store: ENOENT" }, 500);
  assert.equal(store.kind, "error");
  assert.equal(store.bad, true);
  assert.equal(store.lines[0], "reset NOT DONE — could not read the session store: ENOENT");
  const junk = api.resetCopyView(null, 502);
  assert.equal(junk.kind, "error");
  assert.equal(junk.lines[0], "reset NOT DONE — the panel answered HTTP 502");
  assert.equal(new Set(["dry", "blocked", "refused", "success", "incomplete"]).size, 5, "the five states are five, and none of them is `error`");
});

// ---- 3. the press ------------------------------------------------------------------------------------
test("the first press sends the dry run and arms; the second sends the real call", async () => {
  const h = build({ answers: [{ status: 200, body: dryBody() }, { status: 200, body: successBody() }] });
  await h.api.resetAssistant(h.btn);
  assert.equal(h.calls.length, 1, "one request per press");
  assert.equal(h.calls[0].url, `/api/assistants/assistant-2/reset`, "the URL is the route's, with the chosen assistant");
  assert.equal(h.calls[0].body.dryRun, true, "the first press is a dry run");
  assert.match(h.calls[0].body.reason, /Settings → Gateway/, "the reason is journalled with the press");
  assert.equal(h.btn.dataset.armed, "1", "the button stays armed for the confirmation");
  assert.equal(h.btn.textContent, "reset Assistant #2?", "the armed label names the assistant, not just the verb");
  assert.equal(h.preview.classList.bad, false, "a clearable dry run is not painted as a refusal");
  assert.match(h.preview.textContent, /^Assistant #2 · panel-assistant-2\nwould clear 1 admission:/, "the rows are painted from the answer");

  await h.api.resetAssistant(h.btn);
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1].body.dryRun, undefined, "the second press is NOT a dry run");
  assert.equal(h.calls[1].body.reason.includes("Reset Assistant #2"), true);
  assert.equal(h.btn.dataset.armed, "", "the second press disarms");
  assert.equal(h.btn.disabled, false, "the button is pressable again");
  assert.match(h.preview.textContent, /^reset — Assistant #2:/, "the outcome replaces the dry run");
  assert.deepEqual(h.banners, ["reset: Assistant #2"], "a success banners the assistant it reset");
  h.api.resetDisarm();
});

test("a refusal disarms the button: the second press would ask the same question", async () => {
  const h = build({
    answers: [
      { status: 409, body: { ok: false, code: "assistant_live", error: `not reset — Assistant #2 has a run still executing (run_2 · started 12m ago).`, assistant: { id: "assistant-2", name: "Assistant #2", threadId: THREAD } } },
    ],
  });
  await h.api.resetAssistant(h.btn);
  assert.equal(h.btn.dataset.armed, "", "a 409 leaves nothing armed");
  assert.equal(h.btn.textContent, "Reset assistant");
  assert.match(h.preview.textContent, /still executing/);
  assert.equal(h.calls.length, 1);
  await h.api.resetAssistant(h.btn);
  assert.equal(h.calls.length, 2, "the next press starts a new dry run rather than confirming the refusal");
  assert.equal(h.calls[1].body.dryRun, true);
  h.api.resetDisarm();
});

test("the select is painted from the roster, keeps the reader's choice, and hides with one assistant", () => {
  const h = build();
  h.api.paintResetRow();
  assert.equal(h.select.hidden, false, "two assistants means the select is shown");
  assert.deepEqual(h.options.map((o) => o.value), ["assistant-1", "assistant-2"]);
  assert.deepEqual(h.options.map((o) => o.title), ["Assistant #1 · panel-assistant", "Assistant #2 · panel-assistant-2"], "each option's title carries its thread id");
  assert.equal(h.select.value, "assistant-2", "the reader's choice survives the repaint");
  assert.match(h.btn.title, /^Reset Assistant #2 — settle its gateway turn \(the unknown admission that fences panel-assistant-2\)/, "the button names whose thread it resets");
  assert.equal(h.api.resetChosen().id, "assistant-2");
});

test("the page binds the press and the select, and repaints the roster on a snapshot", () => {
  assert.match(src, /\$\("btn-reset-assistant"\)\?\.addEventListener\("click", \(e\) => void resetAssistant\(e\.currentTarget\)\)/);
  const changeAt = src.indexOf('$("reset-assistant")?.addEventListener("change"');
  assert.ok(changeAt > 0, "the select is bound");
  assert.match(src.slice(changeAt, changeAt + 120), /resetDisarm\(\);[\s\S]{0,8}paintResetRow\(\);/);
  const snapshotAt = src.indexOf("function applySnapshot(data)");
  const snapshot = src.slice(snapshotAt, src.indexOf("\nfunction ", snapshotAt + 10));
  assert.match(snapshot, /if \(typeof paintResetRow === "function"\) paintResetRow\(\);/, "a new assistant becomes a choice on the next snapshot");
  const open = src.slice(src.indexOf("function toggleSettings(open = null)"), src.indexOf("function toggleSettings(open = null)") + 3000);
  assert.match(open, /paintResetRow\(\);/, "opening Settings reads the roster again");
});
