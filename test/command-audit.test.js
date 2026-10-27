// The per-turn command audit: what a turn WROTE against what the panel DID with it.
//
// Five cases, and each one is a hole the panel used to have:
//   1. a well-formed SPAWN that started nothing was called applied because the promise resolved;
//   2. a TO refused for a busy thread must count as ACCOUNTED FOR, or every held thread cries wolf;
//   3. a line that begins with a known prefix and misses its regex used to be dropped with no journal line at all;
//   4. `harvest` only runs when a turn ends, so a restart mid-turn carried out nothing and said nothing — the next
//      pass has to reconcile it from the lines the job store still holds, and enforce has to replay it once;
//   5. `commandAudit: off` is the default and must stay completely silent.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ASSISTANT_THREAD, Assistant } from "../lib/assistant.js";
import { auditCounts, gaps } from "../lib/assistant/audit.js";

const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));

async function board(t, { rows = [], spawner = null, busy = () => ({ held: false, where: null, by: [] }) } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wtgui-command-audit-"));
  const assistant = new Assistant({
    config: {
      jobsFile: path.join(dir, "jobs.json"),
      defaultCwd: dir,
      assistantFile: path.join(dir, "assistant.json"),
      charterFile: path.join(dir, "assistant-charter.md"),
    },
    jobs: {
      list: () => rows,
      get: (id) => rows.find((j) => j.id === id) || null,
      firstOfThread: (thread) => rows.find((j) => j.thread === thread) || null,
      busyFor: (thread) => busy(thread),
    },
    getProjects: () => [{ name: "wtgui", path: path.join(dir, "wtgui"), mainBranch: "main", remote: "origin" }],
    spawner,
    onEvent: () => {},
    onLog: () => {},
  });
  t.after(async () => {
    clearTimeout(assistant.persistTimer);
    if (assistant.timer) clearInterval(assistant.timer);
    await rm(dir, { recursive: true, force: true });
  });
  return { assistant, dir };
}

// One finished turn of the assistant's own: its reply is the whole text block, because that is what `turnProse`
// hands the harvest and what the audit reads.
const turn = (id, text, extra = {}) => ({
  id,
  thread: ASSISTANT_THREAD,
  turn: 1,
  status: "done",
  startedAt: new Date(Date.now() - 120_000).toISOString(),
  endedAt: new Date().toISOString(),
  lines: [{ kind: "text", text, at: Date.now() - 60_000 }],
  ...extra,
});

const kinds = (assistant, kind) => assistant.journal.filter((j) => j.kind === kind);
const cards = (assistant) => assistant.alerts.filter((a) => a.rule === "unactioned");

test("a well-formed SPAWN that started no run is reported as unactioned", async (t) => {
  // The spawner resolves with nothing: no job, no thread, no row. Before the audit this read as applied,
  // because the only question asked was "did the call throw".
  const { assistant } = await board(t, { spawner: async () => null });
  assistant.setSettings({ commandAudit: "report", spawn: "auto" });
  await assistant.harvest(turn("turn-spawn-1", "Cutting a tree for this.\n\nSPAWN wtgui | write the docs"));

  const audit = assistant.findAudit("turn-spawn-1");
  assert.ok(audit, "the turn has a ledger even though one of its lines produced nothing");
  const gap = gaps(audit).find((g) => g.kind === "spawn");
  assert.ok(gap, `the SPAWN is the gap: ${JSON.stringify(gaps(audit))}`);
  assert.equal(gap.parsed, 1);
  assert.equal(gap.applied, 0);
  assert.equal(gap.refused, 0);
  assert.equal(gap.missing, 1, "read, and carried out by nobody");

  const card = cards(assistant)[0];
  assert.ok(card, "a red card names it");
  assert.equal(card.severity, "bad");
  assert.equal(card.turnId, "turn-spawn-1");
  assert.match(card.title, /turn-spawn-1/);
  assert.match(card.title, /spawn/);
  assert.match(card.title, /1 command line/);
  assert.match(card.detail, /1 of 1 spawn line/);

  const raised = kinds(assistant, "command-unactioned");
  assert.equal(raised.length, 1, "journaled once, as command-unactioned");
  assert.match(raised[0].text, /turn-spawn-1/, "naming the turn");
  assert.match(raised[0].text, /SPAWN wtgui/, "and the line itself");

  // The digest is what the assistant reads on every turn: a line it wrote that never happened has to be in it,
  // or it re-reads its own prose and believes it acted.
  assert.match(assistant.digest(), /Command lines the panel did NOT carry out/);
  assert.equal(assistant.state().alerts.filter((a) => a.turnId === "turn-spawn-1").length, 1);
});

test("a TO refused for a busy thread counts as accounted for", async (t) => {
  const rows = [{ id: "job-busy", thread: "wtgui-busy", status: "running", cwd: "/x/wtgui-busy" }];
  const { assistant } = await board(t, {
    rows,
    busy: () => ({ held: true, where: "thread", by: [{ id: "job-busy", thread: "wtgui-busy", status: "running" }] }),
  });
  assistant.setSettings({ commandAudit: "report" });
  await assistant.harvest(turn("turn-to-1", "TO wtgui-busy: are you still there?"));

  assert.equal(kinds(assistant, "to-skipped").length, 1, "the refusal the panel already writes");
  assert.equal(kinds(assistant, "command-unactioned").length, 0, "and the audit does not call it lost");
  assert.equal(cards(assistant).length, 0);

  const counts = auditCounts(assistant.findAudit("turn-to-1"));
  assert.deepEqual(
    { parsed: counts.to.parsed, applied: counts.to.applied, refused: counts.to.refused, missing: counts.to.missing },
    { parsed: 1, applied: 0, refused: 1, missing: 0 },
  );
  assert.doesNotMatch(assistant.digest(), /Command lines the panel did NOT carry out/);
});

test("a near-miss line is captured as unparsed rather than dropped", async (t) => {
  const { assistant } = await board(t);
  assistant.setSettings({ commandAudit: "report" });
  // The grammar wants `TO <thread>: <text>`; this line has the prefix and has lost its colon, which is exactly
  // the shape actions.js warns about in its own header.
  await assistant.harvest(turn("turn-near-1", "TO wtgui-x without a colon"));

  const audit = assistant.findAudit("turn-near-1");
  assert.ok(audit, "the ledger exists even though nothing parsed");
  assert.equal(audit.lines.length, 1);
  assert.equal(audit.lines[0].kind, "to");
  assert.equal(audit.lines[0].parsed, false, "captured as unparsed, not skipped");

  const said = kinds(assistant, "command-unparsed");
  assert.equal(said.length, 1);
  assert.match(said[0].text, /TO wtgui-x without a colon/, "the line itself is quoted");
  assert.match(said[0].text, /turn-near-1/);
  assert.equal(cards(assistant).length, 0, "an unparsed line is not a lost one: nothing was ever going to run");
});

test("a restart mid-turn reports unactioned on the next pass, and enforce replays it once", async (t) => {
  let spawned = null;
  const { assistant } = await board(t, { spawner: async () => spawned });
  assistant.setSettings({ commandAudit: "enforce", spawn: "auto" });

  // The turn the restart cut in half: `jobs.load()` writes it back as interrupted with no endedAt, and its own
  // lines are still in the store. This process never harvested it, because harvest only runs when a turn ENDS.
  const cut = turn("turn-cut-1", "SPAWN wtgui | write the docs", {
    status: "interrupted",
    endedAt: null,
    startedAt: new Date(Date.now() - 120_000).toISOString(),
    lines: [{ kind: "text", text: "SPAWN wtgui | write the docs", at: Date.now() - 60_000 }],
  });

  const first = await assistant.checkCommandAudit([cut]);
  assert.equal(first.length, 1, "the pass names it");
  assert.equal(kinds(assistant, "command-unactioned").length, 1);
  assert.equal(cards(assistant)[0].turnId, "turn-cut-1");
  assert.ok(assistant.findAudit("turn-cut-1").replay, "enforce arms the replay for the NEXT pass, not this one");
  assert.equal(kinds(assistant, "command-replay").length, 0);

  // The next pass: the same turn, and this time a run exists behind the line.
  spawned = { id: "job-replayed", thread: "wtgui-write-the-docs" };
  await assistant.checkCommandAudit([cut]);
  assert.equal(kinds(assistant, "command-replay").length, 1, "the lines nothing accounted for are carried out once");
  const audit = assistant.findAudit("turn-cut-1");
  assert.equal(audit.lines.find((l) => l.kind === "spawn").outcome, "applied", "and the ledger says so");
  assert.equal(gaps(audit).length, 0);
  assert.equal(cards(assistant)[0].status, "done", "the red card closes when the work is actually done");
  assert.equal(kinds(assistant, "command-settled").length, 1);

  // Never a third attempt: a replay that ran once is history, however often the clock is asked.
  await assistant.checkCommandAudit([cut]);
  await settle();
  assert.equal(kinds(assistant, "command-replay").length, 1);
});

test("commandAudit off is the default and stays silent", async (t) => {
  const { assistant } = await board(t, { spawner: async () => null });
  assert.equal(assistant.settings.commandAudit, "off", "off by default");
  assert.deepEqual(assistant.state().commandAuditModes, ["off", "report", "enforce"]);

  assistant.setSettings({ spawn: "auto" });
  await assistant.harvest(turn("turn-off-1", "SPAWN wtgui | write the docs\n\nTO nobody without a colon"));

  assert.equal(assistant.alerts.length, 0, "no card");
  assert.equal(assistant.commandAudits.length, 0, "and no ledger at all");
  assert.equal(assistant.journal.filter((j) => String(j.kind).startsWith("command-")).length, 0, "no journal line");
  assert.doesNotMatch(assistant.digest(), /Command lines the panel did NOT carry out/);

  // A value outside the three is not a setting: it is dropped rather than stored as-is.
  assistant.setSettings({ commandAudit: "yell" });
  assert.equal(assistant.settings.commandAudit, "off");
});
