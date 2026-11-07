// The thread's dim log: the panel's own lines under an assistant's card.
//
// The renderer is the page's own code, sliced out of public/assistant.js and driven against a journal array - the
// same style as assistant-queue-ui.test.js. What this pins:
//
//   - only the three kinds the panel writes FOR a thread reach it (`queue-landed` on the row's new owner,
//     `queue-sent` / `message-sent` on the Director's own thread), and only the entries filed under THAT thread;
//   - the state's journal is newest-first and the block reads oldest-first, so the newest line is the last one;
//   - the newest eight are the ones drawn, and a thread with nothing carried out for it draws nothing at all;
//   - the text is escaped and the row id and title are what the line leads with.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { sliceRegion } from "../tools/panel-testkit.mjs";

const assistant = readFileSync(new URL("../public/assistant.js", import.meta.url), "utf8");
const region = sliceRegion(assistant, "the thread's dim log");

const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const build = () =>
  new Function("esc", "state", `${region}\nreturn { threadLogRowsHtml, THREAD_LOG_MAX };`)(esc, { assistant: { journal: [] } });

const at = (n) => new Date(Date.UTC(2026, 10, 7, 12, n)).toISOString();

test("only the panel's own thread lines are drawn, and only for the thread they were filed under", () => {
  const { threadLogRowsHtml } = build();
  const journal = [
    { at: at(3), kind: "queue-sent", thread: "panel-assistant-5", text: "QUEUE Assistant #2 | #12 fix the row — filed" },
    { at: at(2), kind: "queue-landed", thread: "panel-assistant-2", text: "#12 fix the row — filed in this queue by the Assistant Director" },
    { at: at(1), kind: "queue", thread: "panel-assistant-2", text: "#9 something the panel settled" },
    { at: at(0), kind: "messaged", thread: "panel-assistant-2", text: "Assistant #2 was sent a message" },
  ];
  const rows = threadLogRowsHtml("panel-assistant-2", journal);
  assert.match(rows, /#12 fix the row — filed in this queue by the Assistant Director/, "the landing is drawn");
  assert.doesNotMatch(rows, /QUEUE Assistant #2/, "another thread's line is not");
  assert.doesNotMatch(rows, /#9 something the panel settled/, "a queue line the panel settled is not a thread log line");
  assert.doesNotMatch(rows, /was sent a message/, "and neither is the target-side message record");
  assert.equal(rows.match(/as-thread-line/g).length, 1, "one entry, one line");
});

test("the block reads oldest-first, so the newest line is the last one", () => {
  const { threadLogRowsHtml } = build();
  // The store's own order: oldest first, the newest at the tail.
  const journal = [
    { at: at(1), kind: "queue-sent", thread: "t", text: "QUEUE #2 | first" },
    { at: at(2), kind: "queue-sent", thread: "t", text: "QUEUE #2 | second" },
  ];
  const rows = threadLogRowsHtml("t", journal);
  assert.ok(rows.indexOf("first") < rows.indexOf("second"), "the newest line is drawn last");
});

test("the newest eight are drawn, and a thread with nothing carried out for it draws nothing", () => {
  const { threadLogRowsHtml, THREAD_LOG_MAX } = build();
  // The store's own order, oldest first: line 11 is the newest and line 0 the oldest.
  const journal = Array.from({ length: 12 }, (_, i) => ({
    at: at(i),
    kind: "queue-sent",
    thread: "t",
    text: `QUEUE #2 | line ${i}`,
  }));
  const rows = threadLogRowsHtml("t", journal);
  assert.equal(rows.match(/as-thread-line/g).length, THREAD_LOG_MAX, "the block is a log, not a second transcript");
  assert.match(rows, /line 11/, "the newest is kept");
  assert.doesNotMatch(rows, /line 3/, "the oldest past the cap is not");
  assert.equal(threadLogRowsHtml("t", []), "", "no entry, no block");
  assert.equal(threadLogRowsHtml("t", undefined), "", "a state with no journal is an empty log, not a throw");
});

test("the line is escaped and carries the kind it came from", () => {
  const { threadLogRowsHtml } = build();
  const rows = threadLogRowsHtml("t", [
    { at: at(0), kind: "queue-landed", thread: "t", text: "#7 <b>not markup</b> — filed" },
  ]);
  assert.match(rows, /data-as-line="queue-landed"/, "the kind is on the row, for a harness to read");
  assert.match(rows, /&lt;b&gt;not markup&lt;\/b&gt;/, "the text is escaped");
  assert.doesNotMatch(rows, /<b>not markup<\/b>/);
});
