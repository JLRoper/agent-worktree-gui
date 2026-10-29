// The reload decision, as a pure function of what the page knows.
//
// public/core/update-check.js is a classic script in the browser and a plain module to node (it
// exports nothing, publishes itself on globalThis and skips its page wiring when there is no
// document), so this imports the ONE implementation the page runs rather than a copy of it.
import assert from "node:assert/strict";
import test from "node:test";

await import("../public/core/update-check.js");
const { MODES, DEFAULT_MODE, normaliseMode, reloadDecision } = globalThis.wtUpdateCheck;

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
