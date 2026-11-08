// The thread's dim log is GONE from the assistant cards.
//
// The block that drew a `queue-landed` / `queue-sent` / `message-sent` journal line under an assistant's input box
// (`threadLogRowsHtml`, `paintThreadLog`, `THREAD_LOG_KINDS`, `THREAD_LOG_MAX`, and the `.as-thread-log` /
// `.as-thread-line` rules) was removed rather than hidden, so this pins the removal at the source - a re-added
// renderer or stylesheet rule is what would bring the grey lines back - and pins the two things that had to
// SURVIVE it: the journal entries the panel still writes (`lib/assistant.js`), and the queue row's own
// "filed by" line (`public/queue-cards.js`), so a row still names who filed it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");
const page = read("../public/assistant.js");
const sheet = read("../public/style.css");
const store = read("../lib/assistant.js");
const cards = read("../public/queue-cards.js");

test("no renderer for a thread log survives in the page or the sheet", () => {
  for (const gone of [
    "threadLogRowsHtml",
    "paintThreadLog",
    "THREAD_LOG_KINDS",
    "THREAD_LOG_MAX",
    "as-thread-log",
    "as-thread-line",
    "data-as-line",
    "data-as-thread-log",
  ]) {
    assert.equal(page.includes(gone), false, `${gone} is gone from public/assistant.js`);
  }
  for (const rule of [".as-thread-log", ".as-thread-line"]) {
    assert.equal(sheet.includes(rule), false, `${rule} is gone from public/style.css`);
  }
});

test("the journal entries themselves are still written, one line per kind", () => {
  for (const kind of ["queue-landed", "queue-sent", "message-sent"]) {
    assert.match(store, new RegExp(`journalAdd\\(\\s*"${kind}"`), `${kind} is still journaled`);
  }
});

test("a queue row filed by another assistant still names its filer", () => {
  assert.match(cards, /function queueFiledBy\(/, "the filer is derived, not the owner");
  assert.match(cards, /filed by \$\{esc\(filedBy\)\}/, "and the row still draws the line that names it");
});
