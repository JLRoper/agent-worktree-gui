// The reload decision, as a pure function of what the page knows.
//
// public/core/update-check.js is a classic script in the browser and a plain module to node (it
// exports nothing, publishes itself on globalThis and skips its page wiring when there is no
// document), so this imports the ONE implementation the page runs rather than a copy of it.
import assert from "node:assert/strict";
import test from "node:test";

await import("../public/core/update-check.js");
const { MODES, DEFAULT_MODE, normaliseMode, reloadDecision, buildRows, NO_LINE } = globalThis.wtUpdateCheck;

test("the setting is off / prompt / auto, and prompt is the default", () => {
  assert.deepEqual(MODES, ["off", "prompt", "auto"]);
  assert.equal(DEFAULT_MODE, "prompt", "a reader who never opens Settings is offered the reload, never given it");
  assert.equal(normaliseMode(undefined), "prompt");
  assert.equal(normaliseMode("nonsense"), "prompt", "a stored value that is not a mode falls back to the default");
  assert.equal(normaliseMode("auto"), "auto");
});

test("a page running the served build has nothing to do, whatever the mode", () => {
  for (const mode of MODES) {
    assert.deepEqual(
      reloadDecision({ versionChanged: false, drafting: false, streaming: false, mode }),
      { action: "none", hold: false, reason: "current" },
      `mode ${mode}`
    );
  }
  assert.deepEqual(reloadDecision(), { action: "none", hold: false, reason: "current" }, "no arguments is not a change");
});

test("off never reloads and never offers, even when the build moved", () => {
  for (const drafting of [false, true]) {
    for (const streaming of [false, true]) {
      assert.deepEqual(
        reloadDecision({ versionChanged: true, drafting, streaming, mode: "off" }),
        { action: "none", hold: false, reason: "off" },
        `drafting=${drafting} streaming=${streaming}`
      );
    }
  }
});

test("prompt offers the reload when the page is idle", () => {
  assert.deepEqual(
    reloadDecision({ versionChanged: true, drafting: false, streaming: false, mode: "prompt" }),
    { action: "prompt", hold: false, reason: "prompt" }
  );
});

test("auto takes the reload when the page is idle", () => {
  assert.deepEqual(
    reloadDecision({ versionChanged: true, drafting: false, streaming: false, mode: "auto" }),
    { action: "reload", hold: false, reason: "auto" }
  );
});

test("a draft holds the reload in both modes — it is never thrown away", () => {
  for (const mode of ["prompt", "auto"]) {
    assert.deepEqual(
      reloadDecision({ versionChanged: true, drafting: true, streaming: false, mode }),
      { action: "hold", hold: true, reason: "drafting" },
      `mode ${mode}`
    );
  }
});

test("a streaming turn holds the reload in both modes", () => {
  for (const mode of ["prompt", "auto"]) {
    assert.deepEqual(
      reloadDecision({ versionChanged: true, drafting: false, streaming: true, mode }),
      { action: "hold", hold: true, reason: "streaming" },
      `mode ${mode}`
    );
  }
});

test("streaming is named first when both guards are up — it is the one that is over on its own", () => {
  for (const mode of ["prompt", "auto"]) {
    assert.deepEqual(
      reloadDecision({ versionChanged: true, drafting: true, streaming: true, mode }),
      { action: "hold", hold: true, reason: "streaming" },
      `mode ${mode}`
    );
  }
});

test("a missing or unknown mode behaves as prompt, not as auto", () => {
  assert.deepEqual(reloadDecision({ versionChanged: true, drafting: false, streaming: false }), { action: "prompt", hold: false, reason: "prompt" });
  assert.deepEqual(reloadDecision({ versionChanged: true, drafting: false, streaming: false, mode: "" }), { action: "prompt", hold: false, reason: "prompt" });
  assert.deepEqual(reloadDecision({ versionChanged: true, drafting: false, streaming: false, mode: "off " }), { action: "prompt", hold: false, reason: "prompt" });
});

// ---- the expanded chip -------------------------------------------------------------------------
// `buildRows` is the panel's content as data: the build a reload would pick up, and one line per
// release between this tab's build and that one. It sits beside reloadDecision on the export, so
// every case below is decided without a document - which is the half of a hover panel a node test
// can honestly prove.

test("the expanded chip names the build a reload would pick up: release, then short hash", () => {
  const rows = buildRows({
    served: {
      version: "d25f985c1234",
      semver: "1.76.24",
      restart: { semver: "1.76.25", version: "d25f985c1234" },
      since: "1.76.24",
      releases: [],
    },
    loadedSemver: "1.76.24",
  });
  assert.equal(rows.head, "1.76.25 · d25f985c", "the release and the first eight characters of the hash");
  assert.deepEqual(rows.rows, []);
  assert.equal(rows.note, "no released version between this build and the one on disk", "an empty range says so instead of drawing a blank box");
});

test("every release between the two builds gets its line, and one with no line still gets a row", () => {
  const rows = buildRows({
    served: {
      version: "aaaa1111bbbb",
      restart: { semver: "1.76.25", version: "aaaa1111bbbb" },
      since: "1.76.22",
      releases: [
        { version: "1.76.25", note: "feat: the expanded chip (aaa1111)" },
        { version: "1.76.24", note: null },
        { version: "1.76.23", note: "fix: a real fix (fff6666)" },
      ],
    },
    loadedSemver: "1.76.22",
  });
  assert.equal(rows.head, "1.76.25 · aaaa1111");
  assert.deepEqual(rows.rows, [
    { version: "1.76.25", line: "feat: the expanded chip (aaa1111)" },
    { version: "1.76.24", line: NO_LINE },
    { version: "1.76.23", line: "fix: a real fix (fff6666)" },
  ]);
  assert.equal(NO_LINE, "no changelog line found", "the sentence a release with no non-docs bullet gets");
  assert.equal(rows.note, "", "rows are their own answer; the note is only for none");
});

test("a tab whose shell carried no release number lists the disk build and says the range is unknown", () => {
  const rows = buildRows({
    served: {
      version: "aaaa1111bbbb",
      restart: { semver: "1.76.25", version: "aaaa1111bbbb" },
      since: null,
      releases: [{ version: "1.76.25", note: null }],
    },
    loadedSemver: "",
  });
  assert.equal(rows.rows.length, 1, "the release on disk is still named");
  assert.equal(rows.rows[0].line, NO_LINE);

  const empty = buildRows({ served: { version: "aaaa1111bbbb", restart: { semver: "1.76.25", version: "aaaa1111bbbb" }, since: null, releases: [] }, loadedSemver: "" });
  assert.equal(empty.note, "this tab did not name the version it is running");
});

test("a served answer with no releases key paints nothing rather than throwing", () => {
  const rows = buildRows({ served: { version: "aaaa1111bbbb", restart: { semver: "1.76.25", version: "aaaa1111bbbb" } }, loadedSemver: "1.76.24" });
  assert.deepEqual(rows.rows, []);
  assert.equal(rows.head, "1.76.25 · aaaa1111");
  assert.deepEqual(buildRows(), { head: "unknown", rows: [], note: "this tab did not name the version it is running" });
});
