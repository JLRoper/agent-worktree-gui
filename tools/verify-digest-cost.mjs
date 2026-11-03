// What the board digest costs per turn, measured against the four turn kinds that decide it.
//
//   node tools/verify-digest-cost.mjs        (through npm: npm run verify:digest-cost)
//
// The board digest — the block under "The board right now:" — rides in the preamble of every turn. Before this
// change it was sent in full on every turn, including the sweep turns that find the board exactly as they left it.
// The fix sends a one-line marker on those turns, naming the board's signature and its row count, and keeps the
// full digest for the four cases that need it: an event turn, a reader turn, a turn where the board's signature
// changed, and every Nth sweep.
//
// This tool measures each case on a real Assistant, with the rows and jobs mocked so the digest has something to
// describe. Run it on a tree WITHOUT the change and all four carry the full digest; run it here and the unchanged
// sweep carries the marker. The exit code is 1 when the unchanged sweep is not the smallest of the four — that is
// the red proof on a pre-change tree.
import { Assistant } from "../lib/assistant.js";

const makeRow = (head) => ({
  path: "C:/test/repo",
  branch: "main",
  head,
  ahead: 0,
  behind: 0,
  dirty: 0,
  untracked: 0,
  dirtyFiles: [],
  untrackedFiles: [],
  parent: "main",
  parentSha: "abc123",
  verdict: "ON MAIN",
  error: null,
  released: null,
});

// A board with enough on it that the full digest is the multi-KB text the change exists to stop repeating. The
// jobs are only read by `digest()`, which lists the live and recent runs; the rows decide the signature. Ten live
// runs and five recent ones, each with a long prompt, is about the 8 KB the brief names.
const longPrompt = "work " + "x".repeat(450);
const makeJobs = () => {
  const list = [];
  for (let i = 1; i <= 10; i += 1) {
    list.push({
      id: `live-${i}`,
      thread: `live-thread-${i}`,
      title: `live worker ${i}`,
      status: "running",
      startedAt: new Date(Date.now() - i * 60_000).toISOString(),
      prompt: longPrompt,
      lines: [],
      worktreePath: `C:/test/repo-${i}`,
      branch: `branch-${i}`,
    });
  }
  for (let i = 1; i <= 5; i += 1) {
    list.push({
      id: `recent-${i}`,
      thread: `recent-thread-${i}`,
      title: `recent worker ${i}`,
      status: "done",
      startedAt: new Date(Date.now() - (10 + i) * 60_000).toISOString(),
      endedAt: new Date(Date.now() - (10 + i) * 60_000 + 30_000).toISOString(),
      prompt: longPrompt,
      lines: [],
      worktreePath: `C:/test/repo-${i}`,
      branch: `branch-${i}`,
    });
  }
  return { list: () => list };
};

const makeAssistant = (rows) =>
  new Assistant({
    config: {},
    jobs: makeJobs(),
    getProjects: () => [],
    getRows: () => rows,
    getChildren: () => ({}),
  });

const sweep = { kind: "assistant-wake", rule: "quiet" };
const event = { kind: "assistant-wake", rule: "settle" };
const reader = { kind: "reader" };

// What this tree sends for one turn. On a tree WITHOUT the gate there is no `boardForTurn`: the board block is
// `this.digest()` on every turn, so that is what the four cases measure there — which is the red proof this tool is
// for. On this tree the gate decides between the digest and the marker.
const turnText = (asst, origin) =>
  typeof asst.boardForTurn === "function" ? asst.boardForTurn("assistant-1", origin) : asst.digest();

const measure = (label, origin, asst) => {
  const text = turnText(asst, origin);
  const bytes = Buffer.byteLength(text, "utf8");
  console.log(`${label}: ${text.length} chars (${bytes} bytes)`);
  return { text, bytes };
};

console.log("board digest cost, by turn kind:");
console.log("");

// 1. An event turn: a wake whose rule is not a sweep. Always the full digest.
const eventTurn = measure("event turn               ", event, makeAssistant([makeRow("abc123")]));

// 2. A reader turn: the person typing. Always the full digest.
const readerTurn = measure("reader turn              ", reader, makeAssistant([makeRow("abc123")]));

// 3. A sweep turn with an unchanged board. The board's signature must be known before the turn starts — the first
// sweep sends the full digest because the signature is new. The second sweep is the Nth sweep (N = 2) and sends it
// again. The third sweep is the unchanged one this change exists for: the marker.
const a = makeAssistant([makeRow("abc123")]);
// A tree without the gate has no counter to prime: it keeps no signature and sends the full digest on every turn.
if (typeof a.boardForTurn === "function") {
  a.boardForTurn("assistant-1", sweep);
  a.boardForTurn("assistant-1", sweep);
}
const sweepUnchanged = measure("sweep, unchanged board   ", sweep, a);

// 4. A sweep turn after a row changes. The signature moves, so the full digest is due however the counter reads.
const rowsB = [makeRow("abc123")];
const b = makeAssistant(rowsB);
if (typeof b.boardForTurn === "function") b.boardForTurn("assistant-1", sweep);
rowsB[0] = makeRow("def456");
const sweepChanged = measure("sweep, row changed       ", sweep, b);

console.log("");
const checks = [];
const ok = (name, cond, extra = "") => {
  checks.push(Boolean(cond));
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
  return Boolean(cond);
};

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
const full = [eventTurn, readerTurn, sweepChanged].map((m) => m.bytes);
const biggest = Math.max(...full);

ok("the event turn carries the full digest", eventTurn.bytes === biggest, kb(eventTurn.bytes));
ok("the reader turn carries the full digest", readerTurn.bytes === biggest, kb(readerTurn.bytes));
ok("the sweep after a row changes carries the full digest", sweepChanged.bytes === biggest, kb(sweepChanged.bytes));
ok(
  "the unchanged sweep carries the marker instead",
  sweepUnchanged.bytes < biggest && /^\[Board unchanged —/.test(sweepUnchanged.text),
  `${sweepUnchanged.bytes} bytes vs ${biggest} bytes, ${Math.round((1 - sweepUnchanged.bytes / biggest) * 100)}% smaller`,
);

const failed = checks.filter((c) => !c).length;
console.log("");
console.log(`RESULT: ${failed ? `FAIL (${failed} of ${checks.length} checks)` : `PASS (${checks.length} checks)`}`);
process.exit(failed ? 1 : 0);
