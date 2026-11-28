// A project's turnover branch: the config field the reader names in the project settings, the cap it obeys, and the
// route that reads and writes it.
//
// What is pinned here, each one a way this feature can look right and be wrong:
//
//   1. `turnoverBranch` is OPTIONAL and absence reads as "" - a config that never heard of the key boots with no
//      turnover branch, and the junk a hand-editor can type (a number, an object, a boolean, a bare `refs/heads/`
//      prefix, a trailing slash) reads as a name or as empty rather than as characters or as a throw;
//   2. the READ is forgiving and the WRITE is strict - a name git cannot carry, HEAD, and a landing branch are refused
//      with the reason, and clearing is a real answer rather than a refusal;
//   3. the WRITER's row keeps every field the project already had, invents no path (discovery owns where the repo is),
//      and REMOVES the key when the branch is cleared, because absence is the field's empty value;
//   4. the ROUTE answers 200/400/403/404/405 for the shapes a caller can send, and its read carries the one cap the
//      editor's `maxlength` obeys;
//   5. the ROUND TRIP through a real panel: a save lands in the reader's config.json, reads back out of the route, and
//      rides the next `/api/state` on the project record - which is what the header's chip draws from.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mkdirSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DEFAULT_TURNOVER_POLICY,
  TURNOVER_MAX_CHARS,
  planTurnoverCut,
  planTurnoverSave,
  projectTurnoverRow,
  turnoverBranchFrom,
  turnoverBranchForKey,
  turnoverBranchOf,
  turnoverBranchesOf,
  turnoverLookup,
  turnoverNameFor,
  turnoverPolicyFrom,
  turnoverPolicyOf,
  turnoverSlugFrom,
  turnoverTicketFrom,
  validateTurnoverBranch,
  validateTurnoverBranches,
} from "../lib/project-turnover.js";
import { isTurnoverBranchName } from "../lib/turnover-base.js";
import { TURNOVER_PATH, createProjectTurnoverRoutes, turnoverOut } from "../routes/project-turnover.js";
import { boot, configureRepo, git } from "../tools/panel-testkit.mjs";

// ---- 1: the read side ------------------------------------------------------------------------------------------
test("an absent or unreadable turnover field reads as no branch, and a name is trimmed to one line", () => {
  for (const junk of [undefined, null, "", "   ", 3, true, { name: "x" }, ["x"]]) {
    assert.equal(turnoverBranchFrom(junk), "", `${JSON.stringify(junk)} is not a branch name`);
  }
  // What a hand-editor pastes is read as the branch it means: the full ref prefix and a trailing slash both go.
  assert.equal(turnoverBranchFrom("  refs/heads/feature/turnover/  "), "feature/turnover");
  assert.equal(turnoverBranchFrom("feature/turnover\n"), "feature/turnover");
  assert.equal(turnoverBranchFrom("feature/turnover"), "feature/turnover");
  // HEAD is not a branch, and a pathological value is capped rather than stored whole.
  assert.equal(turnoverBranchFrom("HEAD"), "");
  assert.equal(turnoverBranchFrom("a".repeat(TURNOVER_MAX_CHARS + 50)).length, TURNOVER_MAX_CHARS);
  // The project wrapper answers the same thing, whichever shape the record has.
  assert.equal(turnoverBranchOf({ turnoverBranch: "feature/turnover" }), "feature/turnover");
  assert.equal(turnoverBranchOf({}), "");
  assert.equal(turnoverBranchOf(null), "");
});

// ---- 2: the write side -----------------------------------------------------------------------------------------
test("a save is refused when git cannot carry the name, and clearing is a real answer", () => {
  // Clearing: "", null and undefined all mean "no turnover branch", which is how a project goes back to cutting from
  // its checkout's own branch.
  for (const clear of ["", "   ", null, undefined]) {
    assert.deepEqual(validateTurnoverBranch(clear), { branch: "" }, `${JSON.stringify(clear)} clears the field`);
  }
  // A name git can carry, pasted with the ref prefix or padding, is stored as the branch.
  assert.deepEqual(validateTurnoverBranch(" refs/heads/feature/turnover "), { branch: "feature/turnover" });
  // The refusals: a non-string, a landing branch, HEAD, whitespace, the characters git's own check-ref-format bans.
  assert.match(validateTurnoverBranch(7).error, /must be a branch name/);
  for (const landing of ["main", "master", "trunk", "develop", "MAIN"]) {
    assert.match(validateTurnoverBranch(landing).error, /landing branch, not a turnover branch/, landing);
  }
  assert.match(validateTurnoverBranch("HEAD").error, /HEAD is not a branch/);
  for (const bad of ["feature/turn over", "feature/turn~over", "feature/turn:over", "feature/turn?over", "feature/turn*over", "feature/turn..over", "feature/turn.lock", "feature//turnover", "/feature"]) {
    assert.ok(validateTurnoverBranch(bad).error, `${bad} is not a branch name git can carry`);
  }
  // A name the cap refuses says the length and the cap, the two numbers the writer and the field share.
  const long = validateTurnoverBranch("x".repeat(TURNOVER_MAX_CHARS + 1));
  assert.match(long.error, new RegExp(`${TURNOVER_MAX_CHARS}`));
});

// ---- 3: the config row -----------------------------------------------------------------------------------------
test("the config row keeps every field it had, invents no path, and drops the key when cleared", () => {
  // A folder name, not a folder on the machine that wrote this test: the row must keep a path it was given,
  // and naming a real one would bake a machine's layout into the repository (tools/absolute-paths.mjs).
  const existing = { name: "alpha", path: "repos/alpha", mainBranch: "main", remoteBranchPolicy: "local-only" };
  const saved = projectTurnoverRow(existing, "alpha", " feature/turnover ");
  assert.equal(saved.name, "alpha");
  assert.equal(saved.path, "repos/alpha");
  assert.equal(saved.mainBranch, "main");
  assert.equal(saved.remoteBranchPolicy, "local-only");
  assert.equal(saved.turnoverBranch, "feature/turnover");
  // The input row is untouched: the write replaces the entry, it does not mutate the object it read.
  assert.equal(existing.turnoverBranch, undefined);

  // A project config.json does not name yet is a row with the name and the branch, and NO path: the board merges the
  // row onto the repository discovery scanned by that name.
  const invented = projectTurnoverRow(null, "gamma", "feature/turnover");
  assert.deepEqual(invented, { name: "gamma", turnoverBranch: "feature/turnover" });
  assert.equal(Object.hasOwn(invented, "path"), false, "the row invents no path");

  // Clearing removes the key rather than storing "" beside the reader's other project facts.
  const cleared = projectTurnoverRow(saved, "alpha", "");
  assert.equal(Object.hasOwn(cleared, "turnoverBranch"), false);
  assert.equal(cleared.path, "repos/alpha", "the rest of the row survives a clear");
});

// ---- 3b: the list, the policy and the one-per-feature rule -----------------------------------------------------
test("the turnover list is read forgivingly, strict on write, and the old single key is one entry", () => {
  // READ: absence is [], the old single key is one entry, junk is dropped, duplicates keep the first spelling.
  assert.deepEqual(turnoverBranchesOf({}), []);
  assert.deepEqual(turnoverBranchesOf(null), []);
  assert.deepEqual(turnoverBranchesOf({ turnoverBranch: " feature/turnover " }), [{ branch: "feature/turnover", key: null }]);
  assert.deepEqual(turnoverBranchesOf({ turnoverBranches: ["a/b", { branch: "c/d", key: "task 7" }, 3, { branch: "" }, "a/b"] }), [
    { branch: "a/b", key: null },
    { branch: "c/d", key: "task 7" },
  ]);
  // Both shapes in one record: the list first, the old key added when the list does not already carry it.
  assert.deepEqual(turnoverBranchesOf({ turnoverBranches: ["a/b"], turnoverBranch: "c/d" }).map((e) => e.branch), ["a/b", "c/d"]);
  assert.deepEqual(turnoverBranchesOf({ turnoverBranches: ["a/b"], turnoverBranch: "a/b" }).map((e) => e.branch), ["a/b"]);
  assert.equal(turnoverBranchOf({ turnoverBranches: ["a/b", "c/d"] }), "a/b", "the first entry is the primary branch");
  assert.equal(turnoverBranchForKey({ turnoverBranches: [{ branch: "a/b", key: "task 7" }] }, "task 7"), "a/b");
  assert.equal(turnoverBranchForKey({ turnoverBranches: [{ branch: "a/b", key: "task 7" }] }, " task 8 "), "");

  // WRITE: an array of names or { branch, key }, each branch git can carry, no duplicates, a key one line.
  assert.match(validateTurnoverBranches("a/b").error, /must be an array/);
  assert.match(validateTurnoverBranches(["main"]).error, /landing branch, not a turnover branch/);
  assert.match(validateTurnoverBranches(["a/b", "A/B"]).error, /twice/);
  assert.match(validateTurnoverBranches([{ key: "task 7" }]).error, /branch name or \{ branch, key \}/);
  assert.deepEqual(validateTurnoverBranches([" feature/a ", { branch: "feature/b", key: " task 7 " }]).entries, [
    { branch: "feature/a" },
    { branch: "feature/b", key: "task 7" },
  ]);
  assert.deepEqual(validateTurnoverBranches([]).entries, [], "[] clears the list");
  assert.deepEqual(validateTurnoverBranches(null).entries, []);

  // POLICY: three values, default ask, anything unreadable is the default rather than a guess.
  assert.equal(DEFAULT_TURNOVER_POLICY, "ask");
  assert.equal(turnoverPolicyFrom(undefined), "ask");
  assert.equal(turnoverPolicyFrom(" FREE "), "free");
  assert.equal(turnoverPolicyFrom("one-per-feature"), "one-per-feature");
  assert.equal(turnoverPolicyFrom("nonsense"), "ask");
  assert.equal(turnoverPolicyOf({ turnoverPolicy: "one-per-feature" }), "one-per-feature");
  assert.equal(turnoverPolicyOf({}), "ask");
});

test("the policy decides whether a new branch is free, asks, or is refused for a key that already has one", () => {
  // free adds without asking.
  const free = planTurnoverSave({ project: { turnoverPolicy: "free" }, entries: [{ branch: "a/b" }] });
  assert.deepEqual({ ok: free.ok, ask: free.ask, added: free.added.map((e) => e.branch) }, { ok: true, ask: false, added: ["a/b"] });
  // ask (and the default) parks the card.
  const ask = planTurnoverSave({ project: {}, entries: [{ branch: "a/b" }] });
  assert.equal(ask.ok, true);
  assert.equal(ask.ask, true);
  // A save that adds nothing never asks - editing the list or re-saving a name is not a creation.
  const again = planTurnoverSave({ project: { turnoverBranch: "a/b" }, entries: [{ branch: "a/b" }] });
  assert.equal(again.ask, false);
  assert.deepEqual(again.added, []);
  // one-per-feature: the FIRST branch for a key still asks, a SECOND one is refused by name and offers the existing.
  const first = planTurnoverSave({ project: { turnoverPolicy: "one-per-feature" }, entries: [{ branch: "a/b", key: "task 7" }] });
  assert.equal(first.ok, true);
  assert.equal(first.ask, true);
  const second = planTurnoverSave({
    project: { turnoverPolicy: "one-per-feature", turnoverBranches: [{ branch: "a/b", key: "task 7" }] },
    entries: [{ branch: "c/d", key: "task 7" }],
  });
  assert.equal(second.ok, false);
  assert.equal(second.refused, "one-per-feature");
  assert.equal(second.existing, "a/b");
  assert.match(second.error, /task 7/);
  assert.match(second.error, /a\/b/, "the refusal offers the branch that already exists");
  // The same key's OWN branch is not a second branch: re-saving it is a no-op, not a refusal.
  const same = planTurnoverSave({
    project: { turnoverPolicy: "one-per-feature", turnoverBranches: [{ branch: "a/b", key: "task 7" }] },
    entries: [{ branch: "a/b", key: "task 7" }],
  });
  assert.equal(same.ok, true);
  assert.equal(same.ask, false);
  // A different key may add its own branch.
  const other = planTurnoverSave({
    project: { turnoverPolicy: "one-per-feature", turnoverBranches: [{ branch: "a/b", key: "task 7" }] },
    entries: [{ branch: "a/b", key: "task 7" }, { branch: "c/d", key: "task 8" }],
  });
  assert.equal(other.ok, true);
  assert.equal(other.ask, true);
});

// ---- 3c: the feature container's branch and the policy that makes one -------------------------------------------
test("a cut's feature container is reused, cut or asked for by the project's policy", () => {
  // The name is derived and legal: the key's ticket, the cut's own words, and the minute of the cut.
  const at = new Date(2026, 10, 26, 18, 0); // local time, which is how turnoverNameFor stamps it
  assert.equal(turnoverTicketFrom("task 186"), "TASK-186");
  assert.equal(turnoverTicketFrom("dmr-44001"), "DMR-44001");
  assert.match(turnoverTicketFrom("menu sso"), /^KEY-[0-9]+$/, "a key with no number gets a stable one");
  assert.equal(turnoverTicketFrom("menu sso"), turnoverTicketFrom("menu sso"), "and the same feature keeps it");
  assert.equal(turnoverSlugFrom("Fix the seam!"), "fix-the-seam");
  assert.equal(turnoverSlugFrom("   "), "work");
  const name = turnoverNameFor({ key: "task 186", name: "Fix the seam", at });
  assert.equal(name, "20261126_1800_TASK-186_fix-the-seam");
  assert.equal(isTurnoverBranchName(name), true, "the name is one the turnover predicate recognises");

  // reuse: the branch the project already files under this task or initiative key.
  const filed = { turnoverBranches: [{ branch: "20261101_0900_TASK-7_old", key: "task 7" }], turnoverPolicy: "one-per-feature" };
  const reuse = planTurnoverCut({ project: filed, key: "task 7", name: "another cut" });
  assert.equal(reuse.action, "reuse");
  assert.equal(reuse.branch, "20261101_0900_TASK-7_old");
  assert.equal(reuse.existing, true);
  assert.match(reuse.why, /already has/);

  // free: cut at once, named for the feature.
  const free = planTurnoverCut({ project: { turnoverPolicy: "free" }, key: "task 186", name: "Fix the seam", at });
  assert.equal(free.action, "cut");
  assert.equal(free.branch, name);
  assert.equal(free.key, "task 186");

  // ask (the default), and one-per-feature without the key's branch: the permission card.
  assert.equal(planTurnoverCut({ project: {}, key: "task 186", name: "Fix the seam", at }).action, "ask");
  const one = planTurnoverCut({ project: { turnoverPolicy: "one-per-feature" }, key: "task 186", name: "Fix the seam", at });
  assert.equal(one.action, "ask");
  assert.equal(one.policy, "one-per-feature");
  // A DIFFERENT key under one-per-feature does not steal another feature's branch: it asks for its own.
  assert.equal(planTurnoverCut({ project: filed, key: "task 8", name: "another", at }).action, "ask");
});

test("the config row writes the list beside the old single key, and a policy-only save leaves the branch alone", () => {
  const existing = { name: "alpha", path: "repos/alpha", turnoverBranch: "old/branch" };
  const listed = projectTurnoverRow(existing, "alpha", [{ branch: "feature/a" }, { branch: "feature/b", key: "task 7" }], undefined, { policy: "one-per-feature" });
  assert.deepEqual(listed.turnoverBranches, ["feature/a", { branch: "feature/b", key: "task 7" }]);
  assert.equal(Object.hasOwn(listed, "turnoverBranch"), false, "the list replaces the old key");
  assert.equal(listed.turnoverPolicy, "one-per-feature");
  assert.equal(listed.path, "repos/alpha", "the rest of the row survives");
  // A single-name save is the whole list: the stale array goes.
  const single = projectTurnoverRow(listed, "alpha", "feature/c");
  assert.equal(single.turnoverBranch, "feature/c");
  assert.equal(Object.hasOwn(single, "turnoverBranches"), false);
  // A policy-only save (`branch` undefined) leaves the branch exactly as it was.
  const policyOnly = projectTurnoverRow(single, "alpha", undefined, undefined, { policy: "ask" });
  assert.equal(policyOnly.turnoverBranch, "feature/c");
  assert.equal(Object.hasOwn(policyOnly, "turnoverPolicy"), false, "the default policy is absence, not a stored word");
});

// ---- 4: the route's own contract, with a recorder instead of a socket ------------------------------------------
function harness({ body = {}, token = null, method = "POST", query = "" } = {}) {
  const sent = [];
  const calls = [];
  const registry = {
    projects: [
      { name: "alpha", turnoverBranch: "feature/turnover" },
      { name: "beta", turnoverBranch: "" },
    ],
  };
  const routes = createProjectTurnoverRoutes({
    getConfig: () => ({ token }),
    registry,
    setProjectTurnover: async (name, value) => {
      calls.push({ name, value });
      if (name === "nope") return { status: 404, error: "unknown project: nope" };
      const checked = validateTurnoverBranch(value);
      if (checked.error) return { status: 400, error: checked.error };
      const rec = registry.projects.find((p) => p.name === name);
      if (rec) rec.turnoverBranch = checked.branch;
      return { ok: true, project: name, turnoverBranch: checked.branch };
    },
    sendJson: (res, status, payload) => sent.push({ status, payload }),
    readBody: async () => body,
    authorised: (req) => req.authorised !== false,
  });
  const req = { method, url: `${TURNOVER_PATH}${query}`, authorised: true };
  return { routes, req, sent, calls, registry };
}

test("the route answers the shapes a caller can send, and its read carries the cap", async () => {
  // The board read: every project's branch, the empty one present as "", and the one cap.
  {
    const h = harness({ method: "GET" });
    assert.equal(await h.routes(h.req, {}, TURNOVER_PATH, new URL(`http://x${TURNOVER_PATH}`)), true);
    assert.equal(h.sent[0].status, 200);
    assert.deepEqual(h.sent[0].payload.projects, { alpha: "feature/turnover", beta: "" });
    assert.equal(h.sent[0].payload.maxChars, TURNOVER_MAX_CHARS);
  }
  // One project: its branch and the cap the editor's `maxlength` comes from.
  {
    const h = harness({ method: "GET" });
    await h.routes(h.req, {}, TURNOVER_PATH, new URL(`http://x${TURNOVER_PATH}?project=beta`));
    assert.equal(h.sent[0].status, 200);
    assert.equal(h.sent[0].payload.turnoverBranch, "");
    assert.equal(h.sent[0].payload.maxChars, TURNOVER_MAX_CHARS);
  }
  // A project the board does not carry is a 404, not an empty name: a typo has to be findable.
  {
    const h = harness({ method: "GET" });
    await h.routes(h.req, {}, TURNOVER_PATH, new URL(`http://x${TURNOVER_PATH}?project=nope`));
    assert.equal(h.sent[0].status, 404);
    assert.match(h.sent[0].payload.error, /unknown project/);
  }
  // A save: the name goes up, and the answer is what the writer stored.
  {
    const h = harness({ body: { project: "beta", turnoverBranch: " refs/heads/feature/roll-up " } });
    await h.routes(h.req, {}, TURNOVER_PATH, new URL(`http://x${TURNOVER_PATH}`));
    assert.equal(h.sent[0].status, 200);
    assert.equal(h.sent[0].payload.turnoverBranch, "feature/roll-up");
    assert.match(h.sent[0].payload.note, /beta: turnover branch feature\/roll-up/);
    assert.deepEqual(h.calls, [{ name: "beta", value: " refs/heads/feature/roll-up " }]);
  }
  // Clearing is a save, not a refusal.
  {
    const h = harness({ body: { project: "alpha", turnoverBranch: "" } });
    await h.routes(h.req, {}, TURNOVER_PATH, new URL(`http://x${TURNOVER_PATH}`));
    assert.equal(h.sent[0].status, 200);
    assert.equal(h.sent[0].payload.turnoverBranch, "");
    assert.match(h.sent[0].payload.note, /alpha: no turnover branch/);
  }
  // The refusals: a missing project, a missing value, a landing branch, an unknown project, a bad method, a bad token.
  {
    const h = harness({ body: { turnoverBranch: "feature/x" } });
    await h.routes(h.req, {}, TURNOVER_PATH, new URL(`http://x${TURNOVER_PATH}`));
    assert.equal(h.sent[0].status, 400);
    assert.match(h.sent[0].payload.error, /project is required/);
  }
  {
    const h = harness({ body: { project: "alpha" } });
    await h.routes(h.req, {}, TURNOVER_PATH, new URL(`http://x${TURNOVER_PATH}`));
    assert.equal(h.sent[0].status, 400);
    assert.match(h.sent[0].payload.error, /turnoverBranch is required/);
  }
  {
    const h = harness({ body: { project: "alpha", turnoverBranch: "main" } });
    await h.routes(h.req, {}, TURNOVER_PATH, new URL(`http://x${TURNOVER_PATH}`));
    assert.equal(h.sent[0].status, 400);
    assert.match(h.sent[0].payload.error, /landing branch, not a turnover branch/);
    // The refusal carries the name the panel still holds, so the field can put the reader's branch back.
    assert.equal(h.sent[0].payload.turnoverBranch, "feature/turnover");
  }
  {
    const h = harness({ body: { project: "nope", turnoverBranch: "feature/x" } });
    await h.routes(h.req, {}, TURNOVER_PATH, new URL(`http://x${TURNOVER_PATH}`));
    assert.equal(h.sent[0].status, 404);
  }
  {
    const h = harness({ method: "PUT" });
    await h.routes(h.req, {}, TURNOVER_PATH, new URL(`http://x${TURNOVER_PATH}`));
    assert.equal(h.sent[0].status, 405);
    assert.match(h.sent[0].payload.error, /PUT is not allowed/);
  }
  {
    const h = harness({ body: { project: "alpha", turnoverBranch: "feature/x" }, token: "secret" });
    h.req.authorised = false;
    await h.routes(h.req, {}, TURNOVER_PATH, new URL(`http://x${TURNOVER_PATH}`));
    assert.equal(h.sent[0].status, 403);
    assert.deepEqual(h.calls, [], "an unauthorised save never reaches the writer");
  }
  // A path this prefix does not answer falls through to the rest of the chain rather than inventing a 404 here.
  {
    const h = harness({ method: "GET" });
    assert.equal(await h.routes(h.req, {}, "/api/settings/general", new URL("http://x/api/settings/general")), false);
    assert.deepEqual(h.sent, []);
  }
});

// A new turnover branch is a branch CREATION, and the project's policy decides whether it is free, waits on the
// permission card, or is refused because the feature already has one. The card's answer runs exactly the save it was
// asked about - one grant, one branch creation.
test("the route asks for a new turnover branch, refuses a second one for a key, and asks nothing under free", async () => {
  const sent = [];
  const calls = [];
  const asked = [];
  const registry = {
    projects: [
      { name: "free", turnoverPolicy: "free" },
      { name: "asking", turnoverPolicy: "ask" },
      { name: "one", turnoverPolicy: "one-per-feature", turnoverBranches: [{ branch: "feature/a", key: "task 7" }] },
    ],
  };
  const remoteWrites = {
    request: (input) => {
      asked.push(input);
      return { id: `rw_${asked.length}`, deadline: Date.now() + 60_000, timeoutSeconds: 65 };
    },
  };
  const setProjectTurnover = async (name, value, options) => {
    calls.push({ name, value, options });
    const list = Array.isArray(value) ? value : value ? [{ branch: String(value) }] : [];
    return { ok: true, project: name, turnoverBranch: list[0]?.branch || "", turnoverBranches: list, turnoverPolicy: "ask" };
  };
  const run = async (body) => {
    const routes = createProjectTurnoverRoutes({
      getConfig: () => ({}),
      registry,
      setProjectTurnover,
      sendJson: (res, status, payload) => sent.push({ status, payload }),
      readBody: async () => body,
      authorised: () => true,
      remoteWrites,
    });
    await routes({ method: "POST", url: TURNOVER_PATH }, {}, TURNOVER_PATH, new URL(`http://x${TURNOVER_PATH}`));
    return sent[sent.length - 1];
  };

  // free: applied at once, no card.
  const freeOut = await run({ project: "free", turnoverBranches: ["feature/x"] });
  assert.equal(freeOut.status, 200);
  assert.equal(asked.length, 0, "free adds without asking");
  assert.deepEqual(calls[0].value, [{ branch: "feature/x" }]);

  // ask: parked, with the once/deny answer and a resume that runs the same save.
  const askOut = await run({ project: "asking", turnoverBranches: ["feature/y"], turnoverKey: "task 9" });
  assert.equal(askOut.status, 202);
  assert.equal(askOut.payload.asked, true);
  assert.match(askOut.payload.note, /in the dock/);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].kind, "turnover");
  assert.equal(asked[0].grants, false, "the answer grants no push");
  assert.deepEqual(asked[0].allowed, ["once", "deny"]);
  assert.match(asked[0].command, /feature\/y/);
  assert.match(asked[0].description, /exactly this branch/);
  calls.length = 0;
  const resumed = await asked[0].resume();
  assert.equal(resumed.ok, true, "the granted save runs");
  assert.deepEqual(calls[0], { name: "asking", value: [{ branch: "feature/y" }], options: { by: "the turnover bar", baseRefKind: undefined, policy: undefined } });

  // one-per-feature: a second branch for a key that already has one is refused by name, with no card.
  const askedBefore = asked.length;
  const second = await run({ project: "one", turnoverBranches: [{ branch: "feature/b", key: "task 7" }] });
  assert.equal(second.status, 409);
  assert.equal(second.payload.refused, "one-per-feature");
  assert.equal(second.payload.existing, "feature/a", "the refusal offers the existing branch");
  assert.match(second.payload.error, /task 7/);
  assert.equal(asked.length, askedBefore, "a refusal parks nothing");

  // …but a NEW key's first branch still asks.
  const first = await run({ project: "one", turnoverBranches: [{ branch: "feature/c", key: "task 8" }] });
  assert.equal(first.status, 202);
  assert.equal(asked.length, askedBefore + 1);

  // A branch name git cannot carry is refused BEFORE a card is parked.
  const bad = await run({ project: "asking", turnoverBranches: ["main"] });
  assert.equal(bad.status, 400);
  assert.match(bad.payload.error, /landing branch, not a turnover branch/);
  assert.equal(asked.length, askedBefore + 1, "a save that could only fail never becomes a question");

  // A POLICY-only save writes the policy and touches no branch: no card, and `value` is undefined.
  calls.length = 0;
  const policyOut = await run({ project: "asking", turnoverPolicy: "one-per-feature" });
  assert.equal(policyOut.status, 200);
  assert.equal(calls[0].value, undefined, "the branch list is not rewritten by a policy save");
  assert.equal(calls[0].options.policy, "one-per-feature");
});

test("turnoverOut is the read's one shape, and a project it cannot find says why", () => {
  const registry = { projects: [{ name: "alpha", turnoverBranch: "feature/turnover" }, { name: "beta" }] };
  // The read gained the THREE KINDS and their labels (lib/base-ref-kind.js), the three POLICIES with theirs, and the
  // branch LIST beside the old single name: the bar draws its selects from this answer, so a page never carries a
  // second copy of a list or of the words the reader picks from.
  assert.deepEqual(turnoverOut(registry, "beta"), {
    maxChars: TURNOVER_MAX_CHARS,
    kinds: ["checkout", "turnover", "local-turnover"],
    kindLabels: { checkout: "the checkout's own branch", turnover: "the named turnover branch", "local-turnover": "local turnover branch - ask if none exist" },
    policies: ["free", "ask", "one-per-feature"],
    policyLabels: {
      free: "free - add a turnover branch without asking",
      ask: "ask - a new turnover branch waits for your answer",
      "one-per-feature": "one per feature - ask, and refuse a second branch for the same key",
    },
    defaultPolicy: "ask",
    project: "beta",
    turnoverBranch: "",
    turnoverBranches: [],
    turnoverPolicy: "ask",
    baseRefKind: "checkout",
  });
  assert.deepEqual(turnoverOut(registry, "alpha").turnoverBranch, "feature/turnover");
  assert.deepEqual(turnoverOut(registry, "alpha").turnoverBranches, [{ branch: "feature/turnover", key: null }], "the old single key reads as one entry");
  const missing = turnoverOut(registry, "nope");
  assert.equal(missing.turnoverBranch, null);
  assert.match(missing.error, /unknown project/);
});

// The one lookup a cut asks. Registry first (the settings save updates that record, so the next SPAWN must see the new
// name without a restart), config second (a project discovery has not merged yet still answers), "" otherwise - which
// is what makes a project without the setting cut where it always did.
test("the cut's lookup reads the live registry first, then the config row, then nothing", () => {
  const registry = { projects: [{ name: "alpha", turnoverBranch: "feature/turnover" }] };
  const config = { projects: [{ name: "alpha", turnoverBranch: "stale/in-the-file" }, { name: "beta", turnoverBranch: "feature/beta-turnover" }] };
  const lookup = turnoverLookup({ registry, config });
  assert.equal(lookup("alpha"), "feature/turnover", "the registry's record wins over the file");
  assert.equal(lookup("beta"), "feature/beta-turnover", "a project only the config names still answers");
  assert.equal(lookup("gamma"), "", "an unknown project has no turnover branch");
  assert.equal(lookup(""), "", "no project, no branch");
  assert.equal(lookup(null), "");
  // The settings save mutates the registry record, and the SAME lookup answers the new name: no restart, no re-wiring.
  registry.projects[0].turnoverBranch = "feature/renamed";
  assert.equal(lookup("alpha"), "feature/renamed");
  // The lookup is built from nothing without complaint: a panel whose registry has not scanned yet still boots.
  assert.equal(turnoverLookup()("alpha"), "");
  assert.equal(turnoverLookup({ registry: { projects: [{ name: "alpha" }] } })("alpha"), "");
});

// ---- 5: the round trip through a real panel --------------------------------------------------------------------
test("a save lands in config.json, reads back out of the route, and rides the next snapshot", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wtgui-turnover-"));
  const repos = path.join(dir, "repos");
  mkdirSync(repos, { recursive: true });
  const paths = {};
  for (const name of ["alpha", "beta", "gamma"]) {
    const repo = path.join(repos, name);
    mkdirSync(repo, { recursive: true });
    git(repo, ["init", "-q", "-b", "main"]);
    configureRepo(repo);
    git(repo, ["commit", "-q", "--allow-empty", "-m", "first"]);
    paths[name] = repo.replace(/\\/g, "/");
  }
  // `alpha` starts WITH a turnover branch (as a hand-edited config would hold it), `beta` starts without the key at
  // all, and `gamma` is discovered from the scan root but NOT named in config.json - the three shapes the writer has
  // to answer for: edit, add-to-known, and add-a-row-for-a-discovered-project.
  const panel = await boot({
    dir,
    keep: false,
    config: {
      scanRoots: [repos.replace(/\\/g, "/")],
      projects: [
        { name: "alpha", path: paths.alpha, mainBranch: "main", turnoverBranch: "feature/turnover", turnoverPolicy: "free" },
        { name: "beta", path: paths.beta, mainBranch: "main", turnoverPolicy: "free" },
      ],
      assistant: { enabled: false },
      worktreeSeconds: 60,
      midSeconds: 60,
      dormantSeconds: 60,
      slowSeconds: 60,
    },
  });
  const get = async (query = "") => {
    const r = await fetch(`${panel.base}${TURNOVER_PATH}${query}`);
    return { status: r.status, json: await r.json() };
  };
  const postTurnover = async (project, value) => {
    const r = await fetch(`${panel.base}${TURNOVER_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project, turnoverBranch: value }),
    });
    return { status: r.status, json: await r.json() };
  };

  try {
    // The board is drawn before the states are read: the route answers from the registry, which discovery fills.
    for (let i = 0; i < 120; i++) {
      const state = await (await fetch(`${panel.base}/api/state`)).json();
      if ((state.projects || []).length >= 3) break;
      await new Promise((r) => setTimeout(r, 150));
    }

    // BOTH halves of the default: beta has no key in the file and reads as no branch; alpha's hand-written branch is
    // served unchanged.
    const all = await get();
    assert.equal(all.status, 200);
    assert.equal(all.json.projects.alpha, "feature/turnover");
    assert.equal(all.json.projects.beta, "");
    assert.equal(all.json.maxChars, TURNOVER_MAX_CHARS);

    // A save on a project config.json already names: the row keeps its path, and the branch is the thing that moved.
    const saved = await postTurnover("beta", " refs/heads/feature/roll-up ");
    assert.equal(saved.status, 200);
    assert.equal(saved.json.turnoverBranch, "feature/roll-up");
    const cfgPath = path.join(dir, "config.json");
    let file = JSON.parse(await readFile(cfgPath, "utf8"));
    let beta = file.projects.find((p) => p.name === "beta");
    assert.equal(beta.turnoverBranch, "feature/roll-up");
    assert.equal(beta.path, paths.beta, "the row keeps the path it already had");
    assert.deepEqual(file.projects.find((p) => p.name === "alpha").turnoverBranch, "feature/turnover", "a sibling's branch is untouched");

    // A save on a DISCOVERED project is a NEW branch under the default `ask`: it parks on the permission card, the
    // file is untouched, and the Permissions history counts the question. Answering once runs exactly that save.
    const discovered = await postTurnover("gamma", "feature/roll-up");
    assert.equal(discovered.status, 202, "the default policy asks before adding a branch");
    assert.equal(discovered.json.asked, true);
    assert.match(discovered.json.note, /in the dock/);
    file = JSON.parse(await readFile(cfgPath, "utf8"));
    assert.equal(file.projects.some((p) => p.name === "gamma"), false, "nothing is written while the question waits");
    // The card is a permission the header's button counts, and it is in the durable history by name.
    const historyBefore = await (await fetch(`${panel.base}/api/permissions/history?limit=1`)).json();
    assert.equal(historyBefore.outstanding, 1, "the Permissions button counts the card");
    assert.equal(historyBefore.entries[0].surface, "permission card");
    assert.match(historyBefore.entries[0].command, /feature\/roll-up/);
    const answered = await fetch(`${panel.base}/api/remote-write/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: discovered.json.id, choice: "once" }),
    });
    assert.equal(answered.status, 200, "one grant answers the one branch creation");
    file = JSON.parse(await readFile(cfgPath, "utf8"));
    const gamma = file.projects.find((p) => p.name === "gamma");
    assert.equal(gamma.turnoverBranch, "feature/roll-up");
    assert.equal(Object.hasOwn(gamma, "path"), false, "the row invents no path");
    const historyAfter = await (await fetch(`${panel.base}/api/permissions/history?limit=1`)).json();
    assert.equal(historyAfter.outstanding, 0, "the answered card stops counting");
    assert.equal(historyAfter.entries[0].status, "answered");
    assert.equal(historyAfter.entries[0].choice, "once");

    // Clearing removes the key rather than storing "" beside the reader's other project facts.
    const cleared = await postTurnover("alpha", "");
    assert.equal(cleared.status, 200);
    assert.equal(cleared.json.turnoverBranch, "");
    file = JSON.parse(await readFile(cfgPath, "utf8"));
    assert.equal(Object.hasOwn(file.projects.find((p) => p.name === "alpha"), "turnoverBranch"), false);

    // The refusal is a 400 and the file is untouched: a landing branch is refused, never stored.
    const landing = await postTurnover("beta", "main");
    assert.equal(landing.status, 400);
    assert.match(landing.json.error, /landing branch, not a turnover branch/);
    file = JSON.parse(await readFile(cfgPath, "utf8"));
    assert.equal(file.projects.find((p) => p.name === "beta").turnoverBranch, "feature/roll-up");

    const unknown = await postTurnover("nope", "feature/x");
    assert.equal(unknown.status, 404);
    assert.equal((await get("?project=nope")).status, 404);

    // WHAT THE CHIP DRAWS: the project record on `/api/state` carries the branch, so a save has to reach it before the
    // next discovery pass or the chip lies until then. The read itself is the poll's cached copy (3s floor), so this
    // waits for the refresh a reader's next poll would get rather than reading the copy built before the save.
    const waitForState = async (name, branch) => {
      let seen = null;
      for (let i = 0; i < 50; i += 1) {
        const state = await (await fetch(`${panel.base}/api/state`)).json();
        seen = (state.projects || []).find((p) => p.name === name) || null;
        if (seen && seen.turnoverBranch === branch) return seen;
        await new Promise((r) => setTimeout(r, 150));
      }
      return seen;
    };
    const record = await waitForState("beta", "feature/roll-up");
    assert.equal(record.turnoverBranch, "feature/roll-up", `the snapshot carries it: ${JSON.stringify(record)}`);
    assert.deepEqual(record.turnoverBranches, [{ branch: "feature/roll-up", key: null }], "and the list beside it");
    assert.equal((await waitForState("gamma", "feature/roll-up")).turnoverBranch, "feature/roll-up");
    // ...and the route agrees with the snapshot, which is the pair of answers the chip and the bar are drawn from.
    assert.equal((await get("?project=beta")).json.turnoverBranch, "feature/roll-up");
  } finally {
    await panel.stop();
  }
});
