// A failed refresh is news ABOUT the release notes, never a replacement for them.
//
// The defect this file exists for: paintChangelog's error branch returned the one red line and nothing else, so a
// tab that had already been read went blank - the reader lost every section they were looking at because a LATER
// fetch failed. The reader's question ("what changed since the build I am running?") was answered a moment ago and
// then un-answered by a transient read.
//
// The page's own region is sliced out of public/app.js and run against a stub strip (the three elements the region
// paints), the page's own `esc` and a fetch that answers from a list. Four facts:
//
//   1. a failed refresh keeps every entry the last good read rendered;
//   2. the failure notice is at the TOP of that list, above the first release;
//   3. a failure with nothing rendered yet is still a lone notice, not an empty list;
//   4. a good read after a failure clears the notice - it is about one read, not a permanent state.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { readSource, sliceRegion } from "../tools/panel-testkit.mjs";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const region = sliceRegion(readSource("public/app.js"), "settings > updates: the release notes", "settings > updates");

// The page's own escaper: the notice carries a fetch's error text, so the escaping is part of the answer.
const domFormat = readSource("public/core/dom-format.js");
const escStart = domFormat.indexOf("const esc = (s) =>");
assert.ok(escStart >= 0, "public/core/dom-format.js still defines esc()");
const escSource = domFormat.slice(escStart).split(/\r?\n\r?\n/)[0];

// The ids the stub has to carry are the page's own; a rename in index.html fails here instead of silently
// returning `null` from getElementById and making every assertion below vacuous.
const IDS = { list: "release-notes", source: "release-notes-source", row: "release-notes-row" };
for (const id of Object.values(IDS)) {
  assert.equal(html.split(`id="${id}"`).length - 1, 1, `index.html carries #${id} exactly once`);
}

const make = new Function(
  "document",
  "apiFetch",
  `${escSource}\n${region}\nreturn { paintChangelog, loadChangelog };`,
);

// The strip: #release-notes is the list itself, #release-notes-source is the one-line stamp above it, and
// #release-notes-row is the settings row the search hides - the region un-hides it on every paint.
function makeStrip() {
  const classes = new Set(["search-hidden"]);
  const list = { innerHTML: "" };
  const source = { textContent: "", title: "" };
  const row = {
    classList: {
      remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name),
    },
  };
  const elements = new Map([
    [IDS.list, list],
    [IDS.source, source],
    [IDS.row, row],
  ]);
  return {
    document: { getElementById: (id) => elements.get(id) || null },
    list,
    source,
    row,
    classes,
  };
}

// One answer per call, in order; the last one repeats if the page asks more often than the case supplies.
function answers(...list) {
  let n = 0;
  return async () => {
    const answer = list[Math.min(n, list.length - 1)];
    n += 1;
    return answer();
  };
}

const good = (payload) => () => ({ ok: true, status: 200, json: async () => payload });

const changelog = (sections, serving = "1.2.0") => ({
  state: "ok",
  file: "CHANGELOG.md",
  path: "CHANGELOG.md",
  size: 4096,
  mtime: Date.UTC(2026, 10, 7, 12, 0, 0),
  serving,
  sections,
});

const FIRST = changelog([
  { version: "1.2.0", date: "2026-11-07", commits: 3, lines: ["### Fixed", "- a failed refresh keeps the list"] },
  { version: "1.1.0", date: "2026-11-01", commits: 2, lines: ["- the older capability"] },
  { version: "1.0.0", date: "2026-10-20", commits: 5, lines: ["- the first release"] },
]);

const versionsIn = (markup) => [...markup.matchAll(/data-release-version="([^"]+)"/g)].map(([, v]) => v);

test("a failed refresh keeps every rendered entry, with the notice above them", async () => {
  const strip = makeStrip();
  const { loadChangelog } = make(
    strip.document,
    answers(good(FIRST), () => ({
      ok: false,
      status: 500,
      json: async () => ({ error: "CHANGELOG.md read failed: <ENOENT>" }),
    })),
  );

  await loadChangelog();
  const before = versionsIn(strip.list.innerHTML);
  assert.deepEqual(before, ["1.2.0", "1.1.0", "1.0.0"], "the first read renders every release");
  assert.match(strip.list.innerHTML, /a failed refresh keeps the list/);

  await loadChangelog();
  const after = strip.list.innerHTML;
  const versions = versionsIn(after);
  assert.deepEqual(versions, before, "every entry the last good read rendered is still on screen");
  // Not merely "some entries": each one, and each bullet it carried.
  for (const line of ["a failed refresh keeps the list", "the older capability", "the first release"]) {
    assert.match(after, new RegExp(line), `the bullet "${line}" survived the failed refresh`);
  }
  assert.match(after, /class="release-state bad"/, "the failure is said, in the list");
  assert.match(after, /could not answer for CHANGELOG\.md/, "the notice says what could not be answered");
  assert.match(after, /&lt;ENOENT&gt;/, "the fetch's own text is escaped into the notice");
  assert.ok(
    after.indexOf("release-state bad") < after.indexOf("<details"),
    "the notice is at the TOP of the list, before the first release",
  );
  assert.match(strip.source.textContent, /refresh failed/, "the stamp says the list is the last good read");
  assert.match(strip.source.textContent, /bytes/);
  assert.equal(strip.classes.has("search-hidden"), false, "the row is revealed, as on any other paint");
});

test("a failure on the first read is a lone notice, not an empty list", async () => {
  const strip = makeStrip();
  const { loadChangelog } = make(
    strip.document,
    answers(() => {
      throw new Error("fetch failed: ECONNREFUSED");
    }),
  );

  await loadChangelog();
  assert.match(strip.list.innerHTML, /ECONNREFUSED/);
  assert.deepEqual(versionsIn(strip.list.innerHTML), [], "there was nothing to keep, and nothing is invented");
  assert.doesNotMatch(strip.list.innerHTML, /refresh failed|not read/);
  assert.equal(strip.source.textContent, "CHANGELOG.md · not read", "the stamp says the file was not read");
});

test("a good read after a failure clears the notice and paints the new answer", async () => {
  const strip = makeStrip();
  const second = changelog([
    { version: "1.3.0", date: "2026-11-08", commits: 1, lines: ["- a newer release"] },
  ], "1.3.0");
  const { loadChangelog } = make(
    strip.document,
    answers(
      good(FIRST),
      () => ({ ok: false, status: 503, json: async () => ({ error: "the panel is restarting" }) }),
      good(second),
    ),
  );

  await loadChangelog();
  await loadChangelog();
  assert.match(strip.list.innerHTML, /release-state bad/, "the failure is up while it is current");

  await loadChangelog();
  assert.doesNotMatch(strip.list.innerHTML, /release-state bad/, "a good read takes the notice down");
  assert.doesNotMatch(strip.list.innerHTML, /restarting/);
  assert.deepEqual(versionsIn(strip.list.innerHTML), ["1.3.0"], "the list is the new answer, not the old one");
  assert.doesNotMatch(strip.source.textContent, /refresh failed/, "the stamp is the new read's own");
});
