// The five logging levels as incrementing tiers: the numbers, the threshold, and the two line shapes.
//
// WHY: the panel used to log one flat line shape from a copy of the same console.log in every module, so
// "what is noisy" and "what is broken" could not be told apart in server.out.log — the thing the user reads
// after "the page stopped answering". These tests pin the parts a reader depends on:
//   - the tiers increment (trace < debug < info < warn < error), which is what makes one switch composable;
//   - INFO keeps the legacy `HH:MM:SS message` shape (tools/measure-slow-panel.mjs parses it anchored at the
//     line start), while every other level tags itself (`HH:MM:SS warn message`);
//   - an unreadable level value falls back — never off, never on by accident.
import assert from "node:assert/strict";
import test from "node:test";
import { LEVELS, createLogger, levelNumber, parseLevel } from "../lib/log.js";

const AT_NOON = () => new Date("2026-11-09T12:34:56Z");

function collector() {
  const lines = [];
  return { lines, sink: (line) => lines.push(line) };
}

test("the tiers increment: each level is strictly above the one it outranks", () => {
  assert.ok(LEVELS.trace < LEVELS.debug);
  assert.ok(LEVELS.debug < LEVELS.info);
  assert.ok(LEVELS.info < LEVELS.warn);
  assert.ok(LEVELS.warn < LEVELS.error);
});

test("levelNumber reads the five names (trimmed, case-insensitive) and nothing else", () => {
  assert.equal(levelNumber("info"), LEVELS.info);
  assert.equal(levelNumber(" WARN "), LEVELS.warn);
  assert.equal(levelNumber("Trace"), LEVELS.trace);
  assert.equal(levelNumber("verbose"), null);
  assert.equal(levelNumber(null), null);
  assert.equal(levelNumber(""), null);
});

test("parseLevel falls back for an unreadable value instead of guessing", () => {
  assert.equal(parseLevel("debug"), "debug");
  assert.equal(parseLevel("BOGUS"), "info");
  assert.equal(parseLevel(undefined), "info");
  assert.equal(parseLevel("BOGUS", "warn"), "warn");
});

test("INFO keeps the legacy line shape; every other level tags itself", () => {
  const { lines, sink } = collector();
  const logger = createLogger({ level: "trace", sink, now: AT_NOON });
  logger.info("client connected (1 streaming)");
  logger.warn("write refused from 10.0.0.5");
  logger.error("handler blew up");
  logger.debug("GET /api/stats 12ms");
  logger.trace("tiny detail");
  assert.deepEqual(lines, [
    "12:34:56 client connected (1 streaming)",
    "12:34:56 warn write refused from 10.0.0.5",
    "12:34:56 error handler blew up",
    "12:34:56 debug GET /api/stats 12ms",
    "12:34:56 trace tiny detail",
  ]);
});

test("the info shape a line parser anchors on is exactly `HH:MM:SS ` + the message", () => {
  const { lines, sink } = collector();
  const logger = createLogger({ level: "info", sink, now: AT_NOON });
  logger.info("projects: 177 (probed 0 new, reused 177) | skipped 59 non-repo dir(s) | discovery 102ms (readdir 19.7)");
  assert.match(lines[0], /^(\d\d:\d\d:\d\d) projects: 177 .*discovery (\d+)ms/);
});

test("the threshold hides everything below it and nothing above it", () => {
  const { lines, sink } = collector();
  const logger = createLogger({ level: "warn", sink, now: AT_NOON });
  assert.equal(logger.info("hidden"), false);
  assert.equal(logger.debug("hidden"), false);
  assert.equal(logger.trace("hidden"), false);
  assert.equal(logger.warn("seen"), true);
  assert.equal(logger.error("seen"), true);
  assert.deepEqual(lines, ["12:34:56 warn seen", "12:34:56 error seen"]);
  assert.equal(logger.enabled("warn"), true);
  assert.equal(logger.enabled("info"), false);
  assert.equal(logger.enabled("nonsense"), false);
});

test("setLevel switches live and an unknown name changes nothing", () => {
  const { lines, sink } = collector();
  const logger = createLogger({ level: "info", sink, now: AT_NOON });
  assert.equal(logger.level, "info");
  logger.debug("hidden");
  assert.equal(logger.setLevel("debug"), "debug");
  logger.debug("seen");
  assert.equal(logger.setLevel("verbose"), "debug");
  assert.equal(logger.setLevel("ERROR"), "error");
  logger.warn("hidden now");
  logger.error("seen");
  assert.deepEqual(lines, ["12:34:56 debug seen", "12:34:56 error seen"]);
});

test("arguments join like console.log used to: strings verbatim, the rest stringified", () => {
  const { lines, sink } = collector();
  const logger = createLogger({ level: "trace", sink, now: AT_NOON });
  logger.info("took", 42, { route: "/api/health" }, "ms");
  assert.equal(lines[0], '12:34:56 took 42 {"route":"/api/health"} ms');
});
