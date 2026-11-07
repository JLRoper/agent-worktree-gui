// What the assistant's preamble costs per turn, measured on a sandbox panel of THIS tree.
//
//   node tools/verify-preamble-cost.mjs        (through npm: npm run verify:preamble-cost)
//
// The charter — the assistant's long tier, the reasoning behind its standing rules — is a file of up to 20,000
// characters, and it used to ride in the run's input on EVERY turn: ~20 KB of identical text per turn, for a file
// that changes once in a while. This tool prints the preamble's size on the first and the second turn of one session,
// which is the pair of numbers that change says moves: turn 1 carries the whole charter, an ordinary turn carries a
// one-line marker naming its sha instead.
//
// It boots a real sandbox panel (`tools/panel-testkit.mjs`), writes a charter the size of the live one — 20,189 chars,
// just over the 20,000 cap, so the "whole" read is the clipped one the live panel actually sends — and then builds ONE
// assistant session over that sandbox's own state files and asks it for two preambles. No gateway, no model, no turn
// is started: the preamble is the string `Assistant.say()` would put in the run's input, and it is built by the same
// method a turn calls.
//
// On a tree WITHOUT the change both turns carry the full charter (the two counts are EQUAL) and the tool exits 1: that
// is the red proof, and it is where the before numbers come from. Measured with a 20,189-char charter in the sandbox:
//
//   before (main, 0.69.2)   turn 1  25,679 chars (25,728 bytes)   turn 2  25,679 chars (25,728 bytes)   0 saved
//   after  (this branch)    turn 1  25,837 chars (25,888 bytes)   turn 2   6,180 chars  (6,229 bytes)   19,657 chars = 19.7 KB
//
// The turn-1 count moves by the sha and the label's new words; every ordinary turn loses the whole file.
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { Assistant } from "../lib/assistant.js";
import { CHARTER_MAX_CHARS } from "../lib/charter.js";
import { statePaths } from "../lib/paths.js";
import { startPanel } from "./panel-testkit.mjs";

// The live panel's own `state/assistant-charter.md`, measured at 20,184–20,189 chars while this change was written.
// Over the cap on purpose: `charterBriefing` clips such a file at 20,000 and NAMES it clipped, which is the shape the
// real board sends.
const LIVE_CHARTER_CHARS = 20189;
const MARKER = /Charter — the long tier is unchanged and withheld this turn \(sha256:([0-9a-f]{12})/;

const fmt = (n) => Number(n).toLocaleString("en-US");
const kb = (bytes) => (bytes / 1000).toFixed(1);
const sha12 = (text) => `sha256:${createHash("sha256").update(text).digest("hex").slice(0, 12)}`;

// A charter of exactly `chars` characters, made of lines a reader can recognise in the output.
function charterOf(chars) {
  const head = "# The long tier — the sandbox's copy, sized like the live panel's file\n\n";
  const line =
    "- a standing note whose only job is to make this file the size a real charter is: the reasoning behind one rule, written down once, read on the turn that carries it.\n";
  let text = head;
  while (text.length < chars) text += line;
  return text.slice(0, chars);
}

let code = 0;
let panel = null;
try {
  panel = await startPanel();
  const config = JSON.parse(await readFile(panel.configPath, "utf8"));
  const paths = statePaths(config);
  const charter = charterOf(LIVE_CHARTER_CHARS);
  await writeFile(paths.charterFile, charter);

  // One session, on the sandbox panel's OWN state: the same files a boot of this panel would talk to.
  const assistant = new Assistant({
    config,
    jobs: { list: () => [], firstOfThread: () => null, create: async (body) => ({ id: "job-1", ...body }) },
    getProjects: () => [],
    onLog: () => {},
  });

  const turn1 = assistant.preamble();
  const turn2 = assistant.preamble();
  const b1 = Buffer.byteLength(turn1, "utf8");
  const b2 = Buffer.byteLength(turn2, "utf8");
  const saved = b1 - b2;
  const charterLine = (text) => (text.split("\n").find((l) => l.startsWith("Charter —")) || "(no charter line)").trim();
  // The first 200 characters of the file's body: what "the charter is present" means here, so the check reads the same
  // on a tree that labels it differently.
  const BODY = charter.split("\n").slice(0, 3).join("\n");

  console.log(`sandbox panel:  ${panel.base}`);
  console.log(`state:          ${paths.stateDir}`);
  console.log(`charter file:   ${paths.charterFile} — ${fmt(charter.length)} chars (the cap is ${fmt(CHARTER_MAX_CHARS)})`);
  console.log("");
  console.log(`turn 1: ${fmt(turn1.length)} chars (${fmt(b1)} bytes)`);
  console.log(`turn 2: ${fmt(turn2.length)} chars (${fmt(b2)} bytes)`);
  console.log(`an ordinary turn loses: ${fmt(turn1.length - turn2.length)} chars (${kb(saved)} KB)`);
  console.log("");
  console.log(`turn 1's charter line: ${charterLine(turn1)}`);
  console.log(`turn 2's charter line: ${charterLine(turn2)}`);
  console.log("");

  const checks = [];
  const ok = (name, cond, extra = "") => {
    checks.push(Boolean(cond));
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
    return Boolean(cond);
  };
  ok("turn 1 carries the whole charter", turn1.includes(BODY), `${fmt(turn1.length)} chars`);
  ok("turn 1 names it as the charter", turn1.includes("Charter —"));
  ok("turn 2 carries the marker instead", MARKER.test(turn2), `${fmt(turn2.length)} chars`);
  ok("turn 2 does not carry the charter's text", !turn2.includes(BODY));
  ok("the marker's sha is the file's sha", MARKER.test(turn2) && turn2.includes(sha12(charter)));
  ok("the short tier rides both turns", ["Standing rules (written by the reader", "Notes"].every((s) => turn1.includes(s) && turn2.includes(s)));
  ok("an ordinary turn is smaller than the first", saved > CHARTER_MAX_CHARS - 500, `${fmt(saved)} bytes`);

  const failed = checks.filter((c) => !c).length;
  console.log("");
  console.log(`RESULT: ${failed ? `FAIL (${failed} of ${checks.length} checks)` : `PASS (${checks.length} checks)`}`);
  code = failed ? 1 : 0;
} catch (err) {
  console.error(`the measurement could not run: ${(err && err.stack) || err}`);
  code = 2;
} finally {
  if (panel) await panel.stop();
}
process.exit(code);
