// What the page says about a repair whose session the panel had to replace.
//
// Two facts are the reader's: the failed turn OFFERS the retry that performs the repair (without which a card ending
// `unknown_execution` has no verb on it at all), and the turn the retry starts is marked `new session` in its head, so
// an answer that did not continue the conversation above it cannot be mistaken for one that did. Read out of the page
// and run with no browser, like test/ahead-behind-cell.test.js.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sliceRegion } from "../tools/panel-testkit.mjs";

const src = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const turns = readFileSync(new URL("../public/turns.js", import.meta.url), "utf8");
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const { retryableError } = new Function(`${sliceRegion(src, "retry")}; return { retryableError };`)();
const { sessionReplacedHtml } = new Function("esc", `${sliceRegion(turns, "session replaced")}; return { sessionReplacedHtml };`)(esc);

test("unknown_execution offers the retry — the one verb that repairs a fenced session", () => {
  // The gateway's exact body code, and the same word inside a longer sentence a build might wrap it in.
  assert.equal(retryableError("unknown_execution"), true);
  assert.equal(retryableError("unknown_execution — the session is fenced"), true);
  // Controls: the predicate still refuses what it always refused, and still accepts what it always accepted.
  assert.equal(retryableError("no API key configured for the gateway"), false);
  assert.equal(retryableError("gateway refused the run (HTTP 400)"), false);
  assert.equal(retryableError("the gateway did not answer within 20s"), true);
});

test("the replaced turn's head says so, in the gateway's words and with both ids in the tooltip", () => {
  const html = sessionReplacedHtml({
    sessionReplaced: { from: "wtgui-old-thread-a1b2c3", to: "wtgui-new-thread-d4e5f6", why: "run run_741516853a… ended unknown_execution" },
  });
  const text = html.replace(/<[^>]*>/g, "");
  assert.match(text, /new session/);
  assert.match(html, /data-session-replaced="wtgui-old-thread-a1b2c3"/);
  const title = /title="([^"]*)"/.exec(html)[1];
  assert.match(title, /lost session wtgui-old-thread-a1b2c3/);
  assert.match(title, /run_741516853a… ended unknown_execution/);
  assert.match(title, /starts wtgui-new-thread-d4e5f6 in the same tree/);
});

test("an ordinary turn draws nothing — a warm retry must not look like a cold start", () => {
  assert.equal(sessionReplacedHtml({}), "");
  assert.equal(sessionReplacedHtml({ sessionReplaced: null }), "");
  assert.equal(sessionReplacedHtml(null), "");
  // Half a record is not a claim either: a chip with no id to name would read as a defect on the card.
  assert.equal(sessionReplacedHtml({ sessionReplaced: { from: "", to: "wtgui-new-a1b2c3" } }), "");
  assert.equal(sessionReplacedHtml({ sessionReplaced: { from: "wtgui-old-a1b2c3", to: "" } }), "");
});

test("nothing from the job store is trusted as markup", () => {
  const html = sessionReplacedHtml({ sessionReplaced: { from: 'a"<script>alert(1)</script>', to: "wtgui-new-a1b2c3", why: "<b>why</b>" } });
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&quot;&lt;script&gt;/);
});

test("the turn head draws the chip between the origin note and the inline prompt", () => {
  assert.match(
    turns,
    /<span class="turn-text">\$\{esc\(label\)\} · \$\{esc\(state_\)\}<\/span>\$\{originHtml\(turn\)\}\$\{sessionReplacedHtml\(turn\)\}\$\{inlinePrompt\(turn, inline\)\}<\/div>/,
  );
});
