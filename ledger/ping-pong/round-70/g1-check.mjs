// G1's own sentence, made runnable: "a note is open and the draft was not rewritten against it".
//
// This is the round's check of the gate, not the panel's (the panel routes the record; this reads the pair the gate is
// about). It is deliberately small and has one job:
//
//   node g1-check.mjs --critique <critique.md> --draft-a <git-tree>:<commit> --draft-b <git-tree>:<commit> \
//                     --verdict <verdict-rN.json>
//
// Pass means: either no note is open and the verdict accepts, or the open notes were answered by a draft that changed.
// Refuse means the gate's refuses_when is met (an open note on a draft that was not rewritten), or the critique does not
// say how many notes are open, or an accepted verdict carries an open note.
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const argOf = (name) => {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 && process.argv[at + 1] ? process.argv[at + 1] : null;
};
const die = (why) => {
  console.log(JSON.stringify({ gate: "G1", pass: false, refused: true, why }, null, 2));
  process.exit(2);
};

const critiquePath = argOf("critique");
const verdictPath = argOf("verdict");
const draftA = argOf("draft-a");
const draftB = argOf("draft-b");
if (!critiquePath || !verdictPath || !draftA || !draftB) die("usage: --critique <file> --draft-a <tree>:<commit> --draft-b <tree>:<commit> --verdict <file>");

const split = (spec) => {
  const at = String(spec).lastIndexOf(":");
  if (at < 2) die(`a draft spec must be <git-tree>:<commit>, not ${JSON.stringify(spec)}`);
  return { tree: spec.slice(0, at), commit: spec.slice(at + 1) };
};
const blobOf = ({ tree, commit }) => {
  try {
    return execFileSync("git", ["-C", tree, "rev-parse", `${commit}:ledger/ping-pong/draft.md`], { encoding: "utf8" }).trim();
  } catch (error) {
    die(`the draft does not resolve at ${commit} in ${tree}: ${String((error && error.stderr) || error).trim()}`);
  }
};

const critique = readFileSync(critiquePath, "utf8");
if (critique.trim() === "") die(`${critiquePath} is empty`);

// The critique states its own count, in the one line the reader and this check both read. A critique that does not say
// is not a pass: an unreadable gate is the state this check exists to refuse.
const counted = /^Open notes:\s*(\d+)\s*$/m.exec(critique);
if (!counted) die(`${critiquePath} does not carry an "Open notes: <n>" line, so the gate cannot say whether a note is open`);
const openNotes = Number(counted[1]);

let verdict;
try {
  verdict = JSON.parse(readFileSync(verdictPath, "utf8").replace(/^\uFEFF/, ""));
} catch (error) {
  die(`${verdictPath} is not JSON: ${String((error && error.message) || error)}`);
}
const outcome = String((verdict && verdict.outcome) || "").trim().toLowerCase();
if (!outcome) die(`${verdictPath} names no outcome`);

const before = blobOf(split(draftA));
const after = blobOf(split(draftB));
const rewritten = before !== after;

const base = { gate: "G1", refuses_when: "a note is open and the draft was not rewritten against it", openNotes, draftRewritten: rewritten, draftBlobBefore: before, draftBlobAfter: after, verdict: outcome, verdictPath, critiquePath };

if (openNotes > 0 && !rewritten) {
  console.log(JSON.stringify({ ...base, pass: false, refused: true, why: `a note is open (${openNotes}) and the draft was not rewritten against it (blob ${before.slice(0, 12)} at both visits), so G1 refuses` }, null, 2));
  process.exit(1);
}
if (openNotes === 0 && outcome === "revise") {
  console.log(JSON.stringify({ ...base, pass: false, refused: true, why: "no note is open, but the verdict asks for another round - a revise with nothing to revise is the verdict ignoring its own critique" }, null, 2));
  process.exit(1);
}
if (openNotes > 0 && outcome === "accept") {
  console.log(JSON.stringify({ ...base, pass: false, refused: true, why: `the verdict accepts the draft while ${openNotes} note(s) are open` }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({ ...base, pass: true, refused: false, why: openNotes === 0 ? "no note is open and the verdict accepts, so G1 passes" : `the open note was answered by a rewritten draft (blob ${before.slice(0, 12)} -> ${after.slice(0, 12)}), so G1 does not refuse` }, null, 2));
process.exit(0);
