// Change 2 of the approved gateway fixes: the long tier stops riding on every turn.
//
// The charter is ~20 KB of standing memory, and until now `Assistant.preamble()` put the WHOLE file in the run's input
// on every single turn — the same bytes, turn after turn, for a file that changes once in a while. This file is the
// contract for what replaces it, and it is the four cases the item names plus the one guarantee that must survive:
//
//   1. the FIRST turn of a session carries the charter in full (a restart is a new session, so its first turn does too);
//   2. a charter EDIT forces a full send on the very next turn — the marker can only claim "unchanged" about the bytes
//      it just read, so a save can never leave the turn reading a sha for text it was never given;
//   3. every CHARTER_RESEND_EVERY-th turn (20, as the item's safety net) sends the whole file again, and the turns
//      between carry the one-line marker;
//   4. the marker's sha is the sha of the FILE, so it tracks the bytes: the same sha on every withheld turn of one
//      revision, a different one after an edit — and it names the raw bytes, so `sha256sum` on the path agrees.
//
// The short tier — standing rules, the scratchpad and the queue digest — is present on every turn without exception:
// the gate added here is on the charter lines ONLY, and the digest keeps the wake gate it already had
// (`queueSweepEveryNWakes`, default 1 = every turn), which this change does not touch.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Assistant, CHARTER_RESEND_EVERY } from "../lib/assistant.js";
import { writeQueueFile } from "../lib/assistant/queue.js";
import { PRIMARY_ASSISTANT } from "../lib/assistants.js";

const sha12 = (text) => createHash("sha256").update(text).digest("hex").slice(0, 12);

// A charter with a body line a test can grep for: the point of every case is WHICH revision's text reached the turn,
// so each revision is named rather than counted. Long enough to look like a real file (40 lines) and small enough that
// the whole suite stays fast — the cost of the real 20 KB file is measured by tools/verify-preamble-cost.mjs.
function charterText(tag) {
  const body = Array.from({ length: 40 }, (_, i) => `- charter line ${i} (${tag})`).join("\n");
  return `# The long tier\n\nBODY-${tag}\n\n${body}\n`;
}

const RULE = "never start a second run on a thread the digest lists as LIVE";
const NOTE = "SCRATCHPAD-NOTE: the 0.69.2 landing is on main";

async function panel(t, { charter = charterText("v1") } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wtgui-preamble-"));
  const assistantFile = path.join(dir, "assistant.json");
  const charterFile = path.join(dir, "assistant-charter.md");
  await writeFile(
    assistantFile,
    JSON.stringify({
      version: 2,
      settings: {},
      notes: NOTE,
      rules: [{ id: "r1", text: RULE, at: new Date().toISOString(), by: "reader" }],
      watches: [],
      alerts: [],
      journal: [],
    }),
  );
  await writeFile(charterFile, charter);
  const created = [];
  const assistant = new Assistant({
    config: { jobsFile: path.join(dir, "jobs.json"), assistantFile, charterFile },
    jobs: {
      list: () => [],
      firstOfThread: () => null,
      create: async (body) => {
        created.push(body);
        return { id: `job-${created.length}`, ...body };
      },
    },
    onLog: () => {},
  });
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { assistant, dir, assistantFile, charterFile, created };
}

// One queued task is enough for `queueBriefing` to produce a digest: an empty queue returns no lines at all, so a
// digest assertion against an empty queue would pass without the digest ever being built.
function seedQueue(assistant) {
  const file = assistant.queuePathOf(assistant.assistantRecord());
  writeQueueFile(file, [{ id: 1, title: "land change 2 of the approved gateway fixes", state: "queued" }], 2);
  return file;
}

test("the first turn of a session carries the whole charter, and a restart is a new session", async (t) => {
  const { assistant, assistantFile, charterFile } = await panel(t);
  const first = assistant.preamble();
  assert.ok(first.includes("BODY-v1"), "the first turn of the session reads the file in full");
  assert.match(first, /Charter — the long tier, read in full this turn \(/, "and says so, rather than claiming every turn");
  assert.ok(first.includes(`sha256:${sha12(await readFile(charterFile, "utf8"))}`), "with the file's sha in the label");

  // A restart is a new process session: the same files, a fresh send record, and the whole charter again. That is the
  // case the safety net is NOT for — a model that just lost its context gets the text back on its first turn.
  const restarted = new Assistant({
    config: { jobsFile: path.join(path.dirname(assistantFile), "jobs.json"), assistantFile },
    jobs: { list: () => [] },
    onLog: () => {},
  });
  assert.ok(restarted.preamble().includes("BODY-v1"), "the first turn after a restart carries it too");

  // And the SAME session's second turn does not.
  assert.ok(!assistant.preamble().includes("BODY-v1"), "the second turn of that session does not");
});

test("a charter edit forces a full send on the very next turn", async (t) => {
  const { assistant, charterFile } = await panel(t);
  assert.ok(assistant.preamble().includes("BODY-v1"), "turn 1: in full");
  const second = assistant.preamble();
  assert.ok(!second.includes("BODY-v1"), "turn 2: withheld, so the edit below is the only thing that can bring it back");
  assert.match(second, /unchanged and withheld this turn/, "turn 2 says the tier is unchanged and withheld");

  await writeFile(charterFile, charterText("v2"));
  const third = assistant.preamble();
  assert.ok(third.includes("BODY-v2"), "turn 3, the VERY NEXT turn, carries the new revision whole");
  assert.ok(!third.includes("unchanged and withheld"), "and is a full send, not a marker");
  assert.match(third, /read in full this turn/, "labelled as the full read it is");

  // A save through the class is the same fact as an edit on disk: the next turn reads the bytes, sees the sha move and
  // sends them. The reader's other two writers (a CHARTER: line, a rule change) land in the same file.
  assistant.setCharter(charterText("v3"));
  assert.ok(assistant.preamble().includes("BODY-v3"), "a save from the tab forces the next turn too");
});

test(`the ${CHARTER_RESEND_EVERY}th turn sends the whole charter again`, async (t) => {
  const { assistant } = await panel(t);
  assert.equal(CHARTER_RESEND_EVERY, 20, "the safety net is every 20th turn, as the item says");
  assert.ok(assistant.preamble().includes("BODY-v1"), "turn 1: in full");
  // Turns 2..19: the marker, every one of them. Asserted turn by turn rather than sampled, because an off-by-one in
  // the interval shows up as exactly one turn in this range being full.
  for (let turn = 2; turn < CHARTER_RESEND_EVERY; turn += 1) {
    const text = assistant.preamble();
    assert.ok(!text.includes("BODY-v1"), `turn ${turn} withholds the charter`);
    assert.match(text, /unchanged and withheld this turn/, `turn ${turn} carries the marker`);
  }
  const twentieth = assistant.preamble();
  assert.ok(twentieth.includes("BODY-v1"), "turn 20 re-sends the whole file");
  assert.match(twentieth, /read in full this turn/, "as a full send");
  assert.ok(!assistant.preamble().includes("BODY-v1"), "and turn 21 is back to the marker — the next cycle starts over");
});

test("the marker's sha tracks the file's bytes", async (t) => {
  const { assistant, charterFile } = await panel(t);
  const v1 = charterText("v1");
  assert.ok(assistant.preamble().includes("BODY-v1"), "turn 1: the full send records the sha it sent");
  const marker1 = assistant.preamble();
  assert.ok(marker1.includes(`sha256:${sha12(v1)}`), "turn 2's marker carries the sha of the bytes on disk");
  assert.ok(!marker1.includes("sha256:" + "0".repeat(12)), "and it is a real read, not a placeholder");
  assert.equal(assistant.preamble(), marker1, "two withheld turns of one revision say the same thing");

  const v2 = charterText("v2");
  await writeFile(charterFile, v2);
  assert.ok(assistant.preamble().includes("BODY-v2"), "the edit is sent on the next turn");
  const marker2 = assistant.preamble();
  assert.ok(marker2.includes(`sha256:${sha12(v2)}`), "and the marker after it carries the NEW sha");
  assert.ok(!marker2.includes(`sha256:${sha12(v1)}`), "the old sha is gone — the marker tracks the file, not the session");
  // The sha is over the RAW bytes, so a reader can reproduce it with sha256sum on the same path. A file that only
  // gained a trailing newline is still a changed file and still forces a send.
  await writeFile(charterFile, `${v2}\n`);
  const t1 = assistant.preamble();
  assert.ok(t1.includes("BODY-v2"), "a one-byte change is a full send too");
  assert.ok(t1.includes(`sha256:${sha12(`${v2}\n`)}`), "and its sha names the new bytes");
});

test("the short tier rides every turn — nothing but the charter lines is withheld", async (t) => {
  const { assistant } = await panel(t);
  seedQueue(assistant);
  const turns = [assistant.preamble(), assistant.preamble(), assistant.preamble()];
  for (const [i, text] of turns.entries()) {
    assert.ok(text.includes(RULE), `turn ${i + 1}: the standing rules are there`);
    assert.ok(text.includes(NOTE), `turn ${i + 1}: the scratchpad is there`);
    assert.ok(text.includes("Your task queue (1 queued"), `turn ${i + 1}: the queue digest is there`);
    assert.ok(text.includes("Read your queue first"), `turn ${i + 1}: and the directive that promises it`);
  }
  assert.ok(turns[0].includes("BODY-v1") && !turns[1].includes("BODY-v1"), "the only difference is the long tier");
  // The digest's OWN gate is untouched by this change: `queue: false` still omits the digest and nothing else. It is
  // the wake gate `queueSweepEveryNWakes` (default 1, so every turn) that decides that, not the charter's gate.
  const gated = assistant.preamble(PRIMARY_ASSISTANT, { queue: false });
  assert.ok(!gated.includes("Your task queue ("), "the digest's wake gate still applies");
  assert.ok(gated.includes(RULE) && gated.includes(NOTE), "but the rules and the scratchpad never do");
});
