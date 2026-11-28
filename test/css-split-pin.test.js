// The css split gate's pin, asserted: the committed file is the multiset the sheets hold today, and the two
// canaries a pin of this shape exists for really fail it. A pin nobody has watched fail is a green light that might
// be wired to nothing, which is the defect this file is written against.
//
//   - a rule DELETED from a sheet fails the pin and the failure names the rule. The canary deletes a rule a later
//     row added, not one the pre-split file held: the origin half of the gate would catch the latter, so only the
//     pin proves the claim "nothing changed since the pin was written".
//   - a sheet RENAMED fails the SURFACES map, by the name that is gone and the name that is new. The map is what
//     tools/css-split-review.mjs names a sheet's surface with, and rows 445 and 446 left it naming four sheets that
//     no longer exist.
//   - a TRUNCATED pin is refused rather than read as a shorter one: the header states the counts and the parser
//     holds the lines to them.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { ROOT } from "../tools/panel-testkit.mjs";
import { comparePin, measureSheetSet, parsePin, parseRules, pinText, ruleKey } from "../tools/verify-css-split.mjs";
import { mapFindings, stylesheetsInLoadOrder } from "../tools/css-split-review.mjs";

const PIN_PATH = path.join(ROOT, "tools", "css-split-pin.txt");
const pinTextOnDisk = () => readFileSync(PIN_PATH, "utf8").replace(/\r\n/g, "\n");
const pin = parsePin(pinTextOnDisk());
const measured = measureSheetSet(ROOT);

test("the committed pin is the rule multiset the sheets hold today", () => {
  const delta = comparePin(pin, measured);
  assert.equal(
    delta.ok,
    true,
    `tools/css-split-pin.txt and the sheets disagree (${delta.lost.length} lost, ${delta.added.length} added, ` +
      `${delta.missing.length} sheet(s) gone, ${delta.extra.length} unpinned): re-pin with the row that changed a sheet`,
  );
  assert.deepEqual(
    [...pin.bySheet.keys()],
    measured.map((m) => m.sheet),
    "the pin names every sheet the page links, in the page's load order",
  );
  assert.ok(pin.meta.rules > 3000, `the pin holds the whole page, not a sample: ${pin.meta.rules} rules`);
  assert.equal(pinText(measured), pinTextOnDisk(), "the file on disk is byte for byte what --pin writes; it was not hand-edited");
});

test("a rule deleted from a sheet fails the pin, and the failure names it", () => {
  // A rule a later row added, so the origin half cannot be what catches this: only the pin can.
  const RULE = "#as-initiatives .wave-lane-dot.is-queued { background: var(--tab-idle); }";
  const victim = measured.find((m) => m.sheet === "initiatives.css");
  assert.ok(victim.text.includes(RULE), "the canary's rule is still written this way in public/initiatives.css");
  // The sheet on disk is CRLF; the rule is one line, so drop its own line ending with it.
  const without = victim.text.replace(`${RULE}\r\n`, "").replace(`${RULE}\n`, "");
  assert.notEqual(without, victim.text);
  const mutated = measured.map((m) => (m.sheet === victim.sheet ? { ...m, text: without, keys: parseRules(without).map(ruleKey) } : m));

  const delta = comparePin(pin, mutated);
  assert.equal(delta.ok, false, "deleting one rule must fail the pin");
  const row = delta.perSheet.find((s) => s.sheet === victim.sheet);
  assert.equal(row.lost.length, 1, "exactly one rule reads as lost");
  assert.match(row.lost[0], /\.wave-lane-dot\.is-queued/, "the lost rule is named");
  assert.equal(row.added.length, 0);
  assert.deepEqual(delta.missing, [], "a rule deletion is not a sheet rename");
  assert.deepEqual(delta.extra, []);
});

test("a renamed sheet fails the map, by both names", () => {
  assert.equal(mapFindings().ok, true, "the committed SURFACES map matches the sheets public/index.html links");
  const renamed = stylesheetsInLoadOrder().map((entry) =>
    entry.href === "console-head.css" ? { ...entry, href: "console-head-alt.css" } : entry,
  );
  const map = mapFindings(renamed);
  assert.equal(map.ok, false, "a rename must fail the map");
  assert.deepEqual(map.stale, ["console-head.css"], "the name that is gone is named");
  assert.deepEqual(map.unmapped, ["console-head-alt.css"], "the name that is new is named");
});

test("a truncated pin is refused rather than read as a shorter one", () => {
  const lines = pinTextOnDisk().trimEnd().split("\n");
  assert.ok(lines.length > 10, "the pin is a real file");
  assert.throws(() => parsePin(lines.slice(0, -1).join("\n")), /truncated or hand-edited/);
});
