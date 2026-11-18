// test/hot-agent-landing.test.js - the landing, pinned where it went wrong.
//
// WHY THIS FILE EXISTS: the first version of `revealHotTurn` looked the card up once, and its re-aim loop gave up
// when that node was gone: `if (!node) return true`. The board repaints on its poll, and opening the row repaints
// the card, so a miss in that window ended the loop before it ever scrolled - Enter closed the list, rang the turn
// and left the reader at the top of a page with the ringed turn a screenful away. The verifier caught it one run in
// ten, which is the worst way for a defect to exist: a source pin is the honest fix, and a miss is now a reason to
// look again rather than an answer.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../public/assistant.js", import.meta.url), "utf8");
const START = SRC.indexOf("function revealHotTurn");
const END = SRC.indexOf("function openHotAt", START);
const BODY = START >= 0 && END > START ? SRC.slice(START, END) : "";

test("revealHotTurn exists and hands the landing to the board's own model", () => {
  assert.ok(BODY, "revealHotTurn is in public/assistant.js");
  assert.ok(BODY.includes("wtTurnFold"), "it uses the fold's reveal rather than a second idea of opening a turn");
  assert.ok(BODY.includes("renderConversation"), "and the panel's own renderer to draw the card");
  assert.ok(BODY.includes("hotOpenPath"), "with the row's page, so the card is the page the reader asked for");
});

test("the aim re-reads the card on every sample and never gives up on a missing one", () => {
  assert.ok(BODY.includes("const aim = () =>"), "the sample is its own function");
  assert.ok(BODY.includes(".job[data-thread="), "it looks the card up again, by the thread it is landing on");
  assert.ok(BODY.includes("[data-turn="), "and the turn inside it, by the id the row carried");
  assert.ok(!/if \(!node\) return true/.test(BODY), "a missing card is not an answer: the loop looks again");
});

test("the loop runs for the ring's own window, then stops", () => {
  assert.ok(BODY.includes("Date.now() >= until"), "the ring's deadline ends it, so nothing outlives the ring");
  assert.ok(BODY.includes("setInterval"), "it samples on a timer rather than once");
  assert.ok(BODY.includes("}, 100"), "every 100ms, so a repaint is corrected before the reader sees the jump");
  assert.ok(BODY.includes("3"), "and a hard stop of its own clears the interval");
});

test("a repaint re-aims the landing instead of waiting for the next sample", () => {
  const renderer = readFileSync(new URL("../public/render-jobs.js", import.meta.url), "utf8");
  assert.ok(renderer.includes("function reaimHotHit"), "the renderer knows the landing's anchor");
  assert.ok(renderer.includes("globalThis.wtHotAim"), "and calls into it while the ring is live");
  assert.ok(renderer.includes("!(Date.now() < hit.until)"), "with the ring's own deadline, so a stale hook cannot outlive it");
  const calls = renderer.split("reaimHotHit();").length - 1;
  assert.ok(calls >= 2, `both render paths re-aim (found ${calls} call sites)`);
  assert.ok(BODY.includes("globalThis.wtHotAim = aim"), "and the landing publishes it");
});

test("the flash is state first, so a repaint keeps it", () => {
  const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  const at = app.indexOf("function flashHotCard(thread)");
  const body = at >= 0 ? app.slice(at, app.indexOf("// ---- HUMAN", at)) : "";
  assert.ok(body, "flashHotCard is in public/app.js");
  const stateAt = body.indexOf("state.hotFlash = { thread, until }");
  const nodeAt = body.indexOf(".job[data-thread=");
  assert.ok(stateAt >= 0, "it sets the state the renderer stamps from");
  assert.ok(nodeAt > stateAt, "BEFORE it looks for the card: a card that is not placed yet must still flash when it is");
});

test("a reader who moves the page keeps it", () => {
  assert.ok(BODY.includes('"wheel"'), "a wheel hands the page over");
  assert.ok(BODY.includes('"touchstart"'), "so does a touch");
  assert.ok(BODY.includes("PageDown"), "and the keys that are navigation, so the loop cannot pull the page back");
  assert.ok(BODY.includes("readerMoved"), "one flag, checked before every sample");
});
