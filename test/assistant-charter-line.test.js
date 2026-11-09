// Where a CHARTER: line is written.
//
// The bug this file is the contract against: `harvest` → `applyActions` already resolved WHOSE turn it was
// (`who`, from the run's thread) for notes, watches and settings, but the CHARTER: loop called
// `appendCharter(entry)` with no assistant, and that method wrote `this.charterFile` — Assistant #1's file —
// for every turn. Measured on the live store: Assistant #5 (the Director) ended turns with CHARTER: lines and
// every one of them landed in `state/assistant-charter.md`, the file the panel shows as #1's, while
// `state/assistants/assistant-5/charter.md` stayed byte-identical all night with an empty changelog.
//
// What is asserted here:
//
//   · a non-primary assistant's CHARTER: line lands in ITS own file and nowhere else;
//   · Assistant #1's charter is byte-unchanged by that entry (sha256 of the file before and after);
//   · an assistant whose charter file is missing gets one CREATED — from its role, or the plain seed when the
//     role is gone — rather than falling back to Assistant #1's copy;
//   · #1's own CHARTER: line still lands in #1's file, exactly as before (the non-primary fix must not move it);
//   · an id the roster does not hold is refused rather than silently written into #1's file.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ASSISTANT_THREAD, Assistant } from "../lib/assistant.js";
import { newAudit } from "../lib/assistant/audit.js";
import { parseActions } from "../lib/assistant/actions.js";
import { PRIMARY_ASSISTANT } from "../lib/assistants.js";
import { CHARTER_HEADING } from "../lib/charter.js";

const sha = (text) => createHash("sha256").update(text).digest("hex");
const bytes = async (file) => readFile(file, "utf8");

async function panel(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wtgui-charter-line-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const assistantFile = path.join(dir, "assistant.json");
  await writeFile(assistantFile, JSON.stringify({ version: 2, settings: {}, notes: "", rules: [], watches: [], alerts: [], journal: [] }));
  const rows = [];
  const assistant = new Assistant({
    config: {
      jobsFile: path.join(dir, "jobs.json"),
      assistantFile,
      charterFile: path.join(dir, "assistant-charter.md"),
      defaultCwd: dir,
    },
    jobs: {
      list: () => rows,
      get: (id) => rows.find((j) => j.id === id) || null,
      firstOfThread: (thread) => rows.find((j) => j.thread === thread) || null,
      create: async (body) => {
        const job = { id: `job-${rows.length + 1}`, ...body };
        rows.push(job);
        return job;
      },
    },
    getProjects: () => [],
    onLog: () => {},
  });
  // #1's charter is seeded on first read, exactly as a boot does, so "byte-unchanged" has a file to measure.
  assistant.loadCharter();
  return { assistant, dir, primaryCharter: path.join(dir, "assistant-charter.md") };
}

// Assistant #5, through the panel's own create path: #1 already exists, so four creations make #2 … #5.
function fifthAssistant(assistant) {
  for (const n of [2, 3, 4, 5]) {
    assistant.createAssistant({ roleId: "assistant-agent-manager", name: `Assistant #${n}` });
  }
  return assistant.assistants.find((a) => a.id === "assistant-5");
}

const turnOf = (assistant, id) => ({
  id: `turn-${id}`,
  thread: assistant.threadOf(id),
  lines: [],
});

const auditFor = (job, line) =>
  newAudit(job, [{ index: 0, kind: "charter", line, parsed: true }]);

test("#5's CHARTER: line lands in #5's own charter, and #1's file is byte-unchanged", async (t) => {
  const { assistant, primaryCharter } = await panel(t);
  const rec = fifthAssistant(assistant);
  const own = assistant.charterPathOf(rec);
  assert.equal(own.replace(/\\/g, "/").endsWith("assistants/assistant-5/charter.md"), true, "the path resolves from the assistant, beside #1's charter");
  assert.ok(existsSync(own), "createAssistant gave #5 a charter of its own");

  const before = await bytes(primaryCharter);
  const ownBefore = await bytes(own);
  assert.ok(!ownBefore.includes("CHARTER-LINE-PROOF"), "the entry is not there before the turn");

  const text = "CHARTER-LINE-PROOF: the director's own changelog grew by this line";
  const job = turnOf(assistant, "assistant-5");
  const audit = auditFor(job, `CHARTER: ${text}`);
  await assistant.applyActions(job, parseActions(`CHARTER: ${text}`), audit);

  // The entry landed in #5's file …
  const ownAfter = await bytes(own);
  assert.ok(ownAfter.includes(text), "#5's own charter carries the entry");
  assert.notEqual(sha(ownAfter), sha(ownBefore), "and #5's file actually moved");
  assert.ok(ownAfter.includes(CHARTER_HEADING), "it was appended under #5's own changelog heading");
  // … and ONLY there.
  assert.equal(sha(await bytes(primaryCharter)), sha(before), "#1's charter is byte-unchanged by #5's entry");
  assert.ok(!(await bytes(primaryCharter)).includes(text), "the entry is nowhere in #1's file");
  assert.equal(assistant.charter.includes(text), false, "#1's cached copy did not take it either");
  assert.equal(audit.lines[0].outcome, "applied", "the turn's ledger settles the CHARTER line applied");
  assert.ok(
    assistant.journal.some((j) => j.kind === "charter" && j.thread === rec.threadId && String(j.text).includes("#5")),
    "the journal names the assistant whose charter moved",
  );

  // A second entry from another assistant does not cross either.
  const text2 = "CHARTER-LINE-PROOF-2: a different assistant's line";
  const job2 = turnOf(assistant, PRIMARY_ASSISTANT);
  await assistant.applyActions(job2, parseActions(`CHARTER: ${text2}`), auditFor(job2, `CHARTER: ${text2}`));
  assert.ok((await bytes(primaryCharter)).includes(text2), "#1's own line still lands in #1's file");
  assert.ok(!(await bytes(own)).includes(text2), "and not in #5's");
});

test("an assistant whose charter file is missing gets one created rather than reading #1's", async (t) => {
  const { assistant, primaryCharter } = await panel(t);
  const rec = fifthAssistant(assistant);
  const own = assistant.charterPathOf(rec);
  await rm(own);
  assert.equal(existsSync(own), false, "the file is gone before the turn");

  const before = await bytes(primaryCharter);
  const text = "CHARTER-LINE-PROOF-MISSING: a charter that did not exist a moment ago";
  const job = turnOf(assistant, "assistant-5");
  const audit = auditFor(job, `CHARTER: ${text}`);
  await assistant.applyActions(job, parseActions(`CHARTER: ${text}`), audit);

  assert.ok(existsSync(own), "the missing charter was created, not skipped");
  const created = await bytes(own);
  assert.ok(created.includes(text), "the entry is in the file it created");
  assert.ok(created.includes(CHARTER_HEADING), "the created file carries a changelog heading to append under");
  assert.ok(created.length > 0);
  assert.notEqual(sha(created), sha(before), "it was never seeded with Assistant #1's bytes");
  assert.equal(sha(await bytes(primaryCharter)), sha(before), "#1's charter is untouched by the creation");
  assert.equal(audit.lines[0].outcome, "applied");
});

test("an id the roster does not hold is refused, never written into #1's charter", async (t) => {
  const { assistant, primaryCharter } = await panel(t);
  const before = await bytes(primaryCharter);
  const out = assistant.appendCharter("CHARTER-LINE-PROOF-UNKNOWN: must not land", { assistantId: "assistant-99" });
  assert.equal(out.written, false);
  assert.equal(sha(await bytes(primaryCharter)), sha(before), "#1's file is not the fallback for a bad id");
  assert.ok(assistant.journal.some((j) => j.kind === "charter-failed" && /no such assistant/.test(j.text || "")));
});
