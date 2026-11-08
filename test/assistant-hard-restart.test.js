// THE HARD RESTART: one assistant leaves the thread it was carrying and starts a fresh one.
//
// What this file is the contract for:
//
//   1. IT MOVES ONE ASSISTANT AND ONLY ONE. `hardRestart` writes a new `threadId` on that assistant's record, keeps
//      the old id in `previousThreads`, and leaves every other assistant's thread, recall and record alone.
//   2. THE NEW THREAD IS THE MECHANISM. The thread id IS the gateway's session id (`Jobs.create` posts
//      `session_id: thread`), so the NEXT turn after a restart asks for a session that does not exist yet — the test
//      asserts the request's own `thread` and `reply: false`, not a sentence about it.
//   3. THE RECALL IS CLEARED WITH IT. The charter send record, the board signature and the queue tick for THAT id are
//      dropped, so the first turn of the new session carries the full charter, board and queue — and #1's records, or
//      #2's, are untouched.
//   4. IT REFUSES A LIVE TURN. Moving the thread under an executing run would orphan that run; the refusal is
//      `assistant-live` and nothing on the record moves.
//   5. #1'S NEW THREAD SURVIVES A RELOAD. The store's normaliser used to force #1 back onto `panel-assistant`; a
//      restarted #1 that reverted on the next panel start made the press look like a no-op.
//   6. THE ROUTE ANSWERS WITH THE WHOLE PANEL STATE, so the page repaints from one read, and 404s an id it does not
//      hold instead of hard-restarting #1 in its place.
//   7. THE ROW IS A TWO-PRESS. Its markup at rest has ONE button; armed, it has Cancel and an "Are you sure?" press
//      and the first press's only effect is that flag — asserted on the page's own markup function, sliced out of
//      public/assistant.js between its markers.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Assistant } from "../lib/assistant.js";
import { PRIMARY_ASSISTANT, PRIMARY_THREAD } from "../lib/assistants.js";
import { post, startPanel } from "../tools/panel-testkit.mjs";

const iso = (at = Date.now()) => new Date(at).toISOString();

async function panel(t, { jobs = [] } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wtgui-hard-restart-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const assistantFile = path.join(dir, "assistant.json");
  await writeFile(assistantFile, JSON.stringify({ version: 2, settings: {}, notes: "", rules: [], watches: [], alerts: [], journal: [] }));
  const listed = jobs.slice();
  const created = [];
  const assistant = new Assistant({
    config: { jobsFile: path.join(dir, "jobs.json"), assistantFile, defaultCwd: dir },
    jobs: {
      list: () => listed.slice(),
      firstOfThread: () => null,
      create: async (body) => {
        created.push(body);
        return { id: `job-${created.length}`, ...body };
      },
      stop: async () => ({ ok: true }),
    },
    getProjects: () => [],
    getRows: () => [],
    onLog: () => {},
  });
  t.after(() => {
    if (assistant.wakeTimer) clearTimeout(assistant.wakeTimer);
    if (assistant.timer) clearInterval(assistant.timer);
    if (assistant.persistTimer) clearTimeout(assistant.persistTimer);
    if (assistant.settleTimer) clearTimeout(assistant.settleTimer);
  });
  const second = assistant.createAssistant({ roleId: "assistant-agent-manager" }).created;
  return { assistant, dir, assistantFile, assistantsFile: assistant.assistantsFile, second, listed, created };
}

// A finished turn on a thread, the shape `say()` counts (`turn > 0`) and `assistantLive()` ignores.
const doneJob = (thread) => ({ id: `old-${thread}`, thread, status: "done", startedAt: iso(Date.now() - 60_000), endedAt: iso() });

test("a hard restart moves ONE assistant to a fresh thread, and keeps every other record", async (t) => {
  const { assistant, second } = await panel(t);
  const id = second.id;
  const before = assistant.threadOf(id);
  // Recall for BOTH, so "only this one" is a real comparison rather than an empty map.
  assistant.preamble(PRIMARY_ASSISTANT);
  assistant.boardForTurn(PRIMARY_ASSISTANT);
  assistant.queueDigestDue(PRIMARY_ASSISTANT);
  assistant.preamble(id);
  assistant.boardForTurn(id);
  assistant.queueDigestDue(id);

  const out = assistant.hardRestart(id);
  assert.equal(out.target.id, id);
  assert.equal(out.target.previousThread, before, "the answer names the thread it left");
  assert.equal(out.target.threadId, `${before}-r2`, "the new thread is a generation of its own");
  assert.notEqual(out.target.threadId, PRIMARY_THREAD);
  assert.equal(assistant.threadOf(id), out.target.threadId, "the record its turns read moved");
  assert.equal(assistant.threadOf(PRIMARY_ASSISTANT), PRIMARY_THREAD, "Assistant #1's thread did not move");
  assert.deepEqual(out.cleared.sort(), ["board", "charter", "queue"], "it says exactly what recall it dropped");
  assert.equal(out.panelRestarted, false);
  assert.equal(out.gatewayRestarted, false);

  const rec = assistant.assistants.find((a) => a.id === id);
  assert.deepEqual(rec.previousThreads, [before], "the old thread is remembered, not forgotten");
  assert.equal(assistant.charterSends.has(id), false);
  assert.equal(assistant.boardSigs.has(id), false);
  assert.equal(assistant.queueWakeTicks.has(id), false);
  assert.equal(assistant.charterSends.has(PRIMARY_ASSISTANT), true, "Assistant #1's charter recall is untouched");
  assert.equal(assistant.boardSigs.has(PRIMARY_ASSISTANT), true);
  assert.equal(assistant.queueWakeTicks.has(PRIMARY_ASSISTANT), true);

  // The payload the page draws from names the new thread and the old one.
  const entry = assistant.state().assistants.find((a) => a.id === id);
  assert.equal(entry.threadId, out.target.threadId);
  assert.deepEqual(entry.previousThreads, [before]);
  assert.equal(assistant.state().thread, PRIMARY_THREAD, "with #1 intact, the payload's own thread is #1's");
});

test("Assistant #1 can be hard restarted, and its new thread survives a reload", async (t) => {
  const { assistant, dir, assistantsFile } = await panel(t);
  const out = assistant.hardRestart(PRIMARY_ASSISTANT);
  assert.equal(out.target.threadId, `${PRIMARY_THREAD}-r2`);
  assert.notEqual(out.target.threadId, assistant.threadOf("assistant-2"), "never collides with another assistant's thread");
  assert.equal(assistant.state().thread, `${PRIMARY_THREAD}-r2`, "the payload follows #1's record");

  const onDisk = JSON.parse(await readFile(assistantsFile, "utf8"));
  assert.equal(onDisk.assistants.find((a) => a.id === PRIMARY_ASSISTANT)?.threadId, `${PRIMARY_THREAD}-r2`);

  // A panel reload is a new Assistant over the same files; the normaliser used to force #1 back to PRIMARY_THREAD.
  const reloaded = new Assistant({
    config: { jobsFile: path.join(dir, "jobs.json"), assistantFile: path.join(dir, "assistant.json"), assistantsFile, defaultCwd: dir },
    jobs: { list: () => [], firstOfThread: () => null, create: async (body) => ({ id: "job-1", ...body }), stop: async () => ({ ok: true }) },
    getProjects: () => [],
    getRows: () => [],
    onLog: () => {},
  });
  t.after(() => {
    if (reloaded.timer) clearInterval(reloaded.timer);
    if (reloaded.persistTimer) clearTimeout(reloaded.persistTimer);
  });
  assert.equal(reloaded.threadOf(PRIMARY_ASSISTANT), `${PRIMARY_THREAD}-r2`, "the restarted thread is still #1's after a reload");
  assert.deepEqual(reloaded.assistants.find((a) => a.id === PRIMARY_ASSISTANT)?.previousThreads, [PRIMARY_THREAD]);

  // A second restart moves on again rather than reusing the first generation.
  const again = reloaded.hardRestart(PRIMARY_ASSISTANT);
  assert.equal(again.target.threadId, `${PRIMARY_THREAD}-r3`);
  assert.deepEqual(reloaded.assistants.find((a) => a.id === PRIMARY_ASSISTANT)?.previousThreads, [`${PRIMARY_THREAD}-r2`, PRIMARY_THREAD]);
});

test("a hard restart is refused while that assistant has a turn running", async (t) => {
  const { assistant, second } = await panel(t);
  const id = second.id;
  const before = assistant.threadOf(id);
  const live = { id: "live-1", thread: before, status: "running", startedAt: iso() };
  assistant.jobs.list = () => [live];
  assert.throws(
    () => assistant.hardRestart(id),
    (err) => err.code === "assistant-live" && /turn still running/.test(err.message),
    "a live turn refuses the restart by name",
  );
  assert.equal(assistant.threadOf(id), before, "nothing moved");
  assert.equal(assistant.charterSends.has(id), false, "and no recall was cleared by the refused call");
});

test("the next turn after a hard restart is the first turn of a new session", async (t) => {
  const { assistant, second, listed, created } = await panel(t);
  const id = second.id;
  const old = assistant.threadOf(id);
  listed.push(doneJob(old));

  await assistant.say("before the restart", { assistantId: id });
  assert.equal(created.at(-1).thread, old);
  assert.equal(created.at(-1).reply, true, "a thread with a turn behind it continues its session");

  const out = assistant.hardRestart(id);
  await assistant.say("after the restart", { assistantId: id });
  const request = created.at(-1);
  assert.equal(request.thread, out.target.threadId, "the next run is posted on the NEW thread — a new gateway session");
  assert.equal(request.reply, false, "and it is a first turn, not a continuation");
  assert.equal(request.assistantId, id, "still stamped as this assistant's turn");
  assert.equal(assistant.jobs.list().filter((j) => j.thread === old).length, 1, "no second job was started on the old thread");
  assert.match(request.preamble, /Read your queue first/, "the turn half still carries the queue directive");
  // The charter moved halves with the cache split: it rides the turn's input (`turnBriefing`) because it changes form
  // on `CHARTER_RESEND_EVERY`, and a block that changes at the head of the system text costs the prefix cache for the
  // whole thread behind it. `system` is the constant half now and carries no charter at all.
  assert.match(request.preamble, /Charter — the long tier, read in full this turn/, "the new session gets the charter in full");
  assert.ok(!request.system.includes("Charter —"), "and the constant system half carries none of it");
});

test("a running panel hard-restarts one assistant and answers with the whole state", async (t) => {
  const panel = await startPanel({});
  t.after(() => panel.stop());
  const created = await post(panel.base, "/api/assistant/assistants", { body: { roleId: "assistant-agent-manager" } });
  assert.equal(created.status, 201, created.text.slice(0, 300));
  const id = created.json.created.id;
  const before = created.json.created.threadId;

  const out = await post(panel.base, "/api/assistant/hard-restart", { body: { assistantId: id } });
  assert.equal(out.status, 200, out.text.slice(0, 300));
  assert.equal(out.json.target.id, id);
  assert.equal(out.json.target.previousThread, before);
  assert.equal(out.json.target.threadId, `${before}-r2`);
  assert.ok(out.json.assistant, "the answer carries the whole assistant state");
  const roster = out.json.assistant.assistants || [];
  assert.equal(roster.find((a) => a.id === id)?.threadId, `${before}-r2`, "the state agrees with the restart");
  assert.equal(roster.find((a) => a.id === PRIMARY_ASSISTANT)?.threadId, PRIMARY_THREAD, "Assistant #1 was not touched");

  const unknown = await post(panel.base, "/api/assistant/hard-restart", { body: { assistantId: "assistant-9" } });
  assert.equal(unknown.status, 404, unknown.text.slice(0, 300));
  assert.equal(unknown.json.code, "assistant-unknown");
});

// ---- the page's own markup, sliced out of public/assistant.js ------------------------------------------------
const src = readFileSync(new URL("../public/assistant.js", import.meta.url), "utf8");
const begin = src.indexOf("// ---- the hard restart: one assistant, a fresh thread, two presses");
const end = src.indexOf("// ---- end the hard restart");
assert.ok(begin > 0 && end > begin, "the hard restart region is in public/assistant.js");
const region = src.slice(begin, end);
const stubEsc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const ui = new Function("esc", "document", `${region}\nreturn { hardRestartRowHtml };`)(stubEsc, { querySelectorAll: () => [] });

// Every button in the row, split into the ones painted and the ones held back. `<button … hidden>` is the shape the
// row toggles, so this reads the states the page itself draws rather than a copy of them.
function buttonState(html) {
  const all = [...html.matchAll(/<button\b([^>]*)>([^<]*)<\/button>/g)].map((m) => ({ text: m[2].trim(), hidden: /\shidden(?:\s|$)/.test(m[1]) }));
  return { shown: all.filter((b) => !b.hidden).map((b) => b.text), hidden: all.filter((b) => b.hidden).map((b) => b.text) };
}

test("the Settings row at rest has ONE button; arming it reveals the 'Are you sure?' press", () => {
  const rest = ui.hardRestartRowHtml("assistant-2", { threadId: "panel-assistant-2", previousThreads: [] }, {});
  assert.deepEqual(buttonState(rest), { shown: ["Hard restart"], hidden: ["Cancel", "Are you sure? Start a fresh thread"] });
  assert.match(rest, /The panel and\s+the gateway are <b>not<\/b> restarted/, "the copy says neither process is restarted");
  assert.match(rest, /no other assistant's thread is touched/);
  assert.match(rest, /thread panel-assistant-2/, "the row names the thread it is on");

  const armed = ui.hardRestartRowHtml(
    "assistant-2",
    { threadId: "panel-assistant-2-r2", previousThreads: ["panel-assistant-2"] },
    { armed: true },
  );
  assert.deepEqual(buttonState(armed), { shown: ["Cancel", "Are you sure? Start a fresh thread"], hidden: ["Hard restart"] });
  assert.match(armed, /Are you sure\?/, "the confirm asks the question the reader asked for");
  assert.match(armed, /panel-assistant-2 → panel-assistant-2-r2/, "the row shows where the thread is going");

  const live = ui.hardRestartRowHtml("assistant-2", { threadId: "panel-assistant-2", previousThreads: [] }, { live: true });
  assert.match(live, /A turn is running — stop it first/, "a live turn is named before the press, not after it");

  const done = ui.hardRestartRowHtml(
    "assistant-2",
    { threadId: "panel-assistant-2-r2", previousThreads: ["panel-assistant-2"] },
    { note: "Hard restarted Assistant #2 — thread panel-assistant-2 → panel-assistant-2-r2. The panel and the gateway were not restarted." },
  );
  assert.match(done, /Hard restarted Assistant #2/, "a finished press keeps its account on the row");
});
