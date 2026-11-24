// THE INITIATIVES READ BACKS OFF WHEN IT KEEPS FAILING.
//
// WHY THIS FILE EXISTS. The pane's stale read is re-armed from its own render and from a four-second timer, and neither
// looked at whether the last read FAILED: `initReadAt` never moves on a failure, so every render found the document
// older than the gap and started another read, and that read's own repaint started the next one. Row 275's worker
// counted 114 GET /api/initiatives inside one sample window with the read forced to fail (queue row 279). The
// measurement lives in tools/verify-initiatives-read-backoff.mjs, which counts the pane's GETs in the page's route
// handler on both arms of the change; this file pins the source shapes that measurement depends on, so the gate cannot
// stay green after a refactor quietly takes the wait out:
//
//   1. THE HEALTHY GAP IS NOT RAISED. `INIT_READ_GAP_MS` stays four seconds; the backoff starts above it and caps at a
//      minute, which is the cadence a broken store is allowed to cost.
//   2. BOTH RE-ARMS ARE GATED. The render's stale branch and the timer's read both pass through `initHeld()`, and the
//      read itself refuses an automatic attempt inside the wait - three locks, because any one of them alone is the
//      loop again.
//   3. A FAILURE SETS THE WAIT, A GOOD READ CLEARS IT. The count, the wait and the deadline move together in the catch
//      and are all cleared in the then (and when a write hands the pane a document), so a recovery is not slow for the
//      rest of the session.
//   4. REFRESH NEVER WAITS. The press calls `loadInitiatives({ force: true })`, which skips the gate; every read that
//      follows a write is forced for the same reason (the write just proved the server answers).
//   5. THE REASON IS DRAWN WITH THE FAILURE AND NOWHERE ELSE. `read failed: …` keeps its prefix (the zero-shift gate
//      asserts it), and the reason names the wait and the control that does not wait. It must not say "reading", which
//      is the word the meta line may never carry while a read is in flight.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const pane = readFileSync(new URL("../public/assistant.js", import.meta.url), "utf8");

test("the healthy gap is unchanged and the failing path caps at a minute", () => {
  assert.match(pane, /const INIT_READ_GAP_MS = 4000;/, "the healthy cadence is still four seconds");
  assert.match(pane, /const INIT_BACKOFF_BASE_MS = 8000;/, "the first retry waits twice the healthy gap");
  assert.match(pane, /const INIT_BACKOFF_CAP_MS = 60000;/, "the ceiling is one request a minute");
  // The schedule the gate measures: 8 s, 16 s, 32 s, 60 s, 60 s. The formula is asserted, not a table that could drift
  // away from it.
  assert.match(
    pane,
    /function initBackoffMs\(n\) \{\s*return Math\.min\(INIT_BACKOFF_CAP_MS, INIT_BACKOFF_BASE_MS \* 2 \*\* Math\.max\(0, n - 1\)\);\s*\}/,
    "the wait doubles from the base and stops at the cap",
  );
  const schedule = [1, 2, 3, 4, 5].map((n) => Math.min(60000, 8000 * 2 ** Math.max(0, n - 1)));
  assert.deepEqual(schedule, [8000, 16000, 32000, 60000, 60000], "the numbers the report states");
});

test("the read refuses an automatic attempt inside the wait, and a forced one skips it", () => {
  assert.match(pane, /function loadInitiatives\(\{ force = false \} = \{\}\) \{/, "the read takes the force flag");
  assert.match(pane, /if \(!force && initHeld\(\)\) return Promise\.resolve\(\);/, "the gate is the read's own, not a caller's");
  // Both re-arms ask the pane whether it is held: the render's stale read and the timer's read.
  const renderAt = pane.indexOf("function renderAssistantInitiatives(");
  assert.ok(renderAt > 0, "the pane's renderer is where this test expects it");
  const renderBody = pane.slice(renderAt, renderAt + 1600);
  assert.match(
    renderBody,
    /if \(!initLoading && !initHeld\(\) && Date\.now\(\) - initReadAt > INIT_READ_GAP_MS\) void loadInitiatives\(\);/,
    "the render's stale read is gated by the wait and by the healthy gap",
  );
  const timerAt = pane.indexOf("function scheduleInitRefresh(");
  assert.ok(timerAt > 0, "the pane's timer is where this test expects it");
  const timerBody = pane.slice(timerAt, pane.indexOf("\n  }", timerAt));
  assert.match(timerBody, /Math\.max\(INIT_READ_GAP_MS, initRetryAt - Date\.now\(\)\)/, "a held pane is asked when the wait ends");
});

test("a failure sets the wait and a good read clears it", () => {
  assert.match(pane, /initFailCount \+= 1;/, "every failure counts");
  assert.match(pane, /initRetryWaitMs = initBackoffMs\(initFailCount\);/, "the wait comes from the count");
  assert.match(pane, /initRetryAt = Date\.now\(\) \+ initRetryWaitMs;/, "the wait is a deadline the gate reads");
  // Cleared in the success branch AND when a write hands the pane a document: two places, both whole.
  const cleared = pane.match(/initFailCount = 0;\s*initRetryAt = 0;\s*initRetryWaitMs = 0;/g) || [];
  assert.ok(cleared.length >= 2, `the count and the wait are cleared together (found ${cleared.length} place(s))`);
});

test("Refresh and every post-write read are forced", () => {
  const force = pane.match(/loadInitiatives\(\{ force: true \}\)/g) || [];
  assert.ok(force.length >= 6, `the press and the six post-write reads bypass the wait (found ${force.length})`);
  assert.doesNotMatch(pane, /await loadInitiatives\(\);/, "no post-write read is left unforced");
  const pressAt = pane.indexOf('el.hasAttribute("data-init-refresh")');
  assert.ok(pressAt > 0, "the Refresh handler is where this test expects it");
  const pressBody = pane.slice(pressAt, pressAt + 900);
  assert.match(pressBody, /void loadInitiatives\(\{ force: true \}\);/, "the press asks at once, whatever the wait says");
});

test("the reason is drawn with the failure, names the wait and the control, and never says 'reading'", () => {
  const span = pane.match(/<span class="as-hint init-read">read failed: \$\{esc\(initErr\)\}[^\n]*<\/span>/);
  assert.ok(span, "the failure span is still one line in the meta line");
  assert.match(span[0], /^<span class="as-hint init-read">read failed: /, "the prefix the other gate asserts");
  assert.match(span[0], /\$\{esc\(initRetryReason\(\)\)\}/, "the reason rides with the failure");
  const reason = pane.match(/return ` - retrying in \$\{Math\.round\(initRetryWaitMs \/ 1000\)\}s; \$\{control\} reads now`;/);
  assert.ok(reason, "the reason is a sentence about the schedule, not a countdown");
  assert.doesNotMatch(reason[0], /reading/i, "the word the meta line may never carry");
});
