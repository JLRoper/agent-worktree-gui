// A project's own one-line rules: the config row's shape, the two caps, and the route that reads and replaces them.
//
// What is pinned here, each one a way this feature can look right and be wrong:
//
//   1. `rules` is OPTIONAL and absence reads as EMPTY - a config that never heard of the key boots with zero rules,
//      and the junk a hand-editor can type (a string, a number, an object, an array with blanks in it) reads as a
//      list rather than as characters or as a throw;
//   2. a rule is ONE LINE: newlines and runs of whitespace collapse, so one rule cannot become two rows in the editor
//      or two lines in anything that reads them;
//   3. the READ is forgiving and the WRITE is strict - a save that would silently change what the reader typed is
//      refused with the reason, and the caps are one pair of numbers shared with the page;
//   4. the WRITER's row keeps every field the project already had, invents no path (discovery owns where the repo
//      is), and REMOVES the key when the list is empty, because absence is the field's empty value;
//   5. the ROUTE answers 200/400/403/404/405 for the shapes a caller can send, and its read carries the caps the
//      editor obeys;
//   6. the ROUND TRIP through a real panel: a save lands in the reader's config.json, reads back out of the route,
//      and rides the next `/api/state` on the project record - which is what the header's chip counts.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mkdirSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { RULES_MAX, RULE_MAX_CHARS, projectRulesRow, rulesCount, rulesFrom, validateRules } from "../lib/project-rules.js";
import { RULES_PATH, createProjectRulesRoutes, rulesOut } from "../routes/project-rules.js";
import { configureRepo, git, startPanel } from "../tools/panel-testkit.mjs";

// ---- 1-2: the read side ----------------------------------------------------------------------------------------
test("an absent or unreadable rules field reads as an empty list, and a rule is one line", () => {
  for (const junk of [undefined, null, "", "ask about the migration", 3, { 0: "nope" }, true]) {
    assert.deepEqual(rulesFrom(junk), [], `${JSON.stringify(junk)} is not a list of rules`);
  }
  // A list keeps its ORDER - it is the order the editor draws and the order a brief would carry - and drops what is
  // not a one-line string without refusing to answer.
  assert.deepEqual(rulesFrom(["  never touch lib/jobs.js  ", "", "   ", 7, null, "quote the failing assertion"]), [
    "never touch lib/jobs.js",
    "quote the failing assertion",
  ]);
  // Newlines and tabs collapse to one space: a rule is one row in the editor, whichever way it was pasted.
  assert.deepEqual(rulesFrom(["two\nlines", "a\t\ttabbed   line"]), ["two lines", "a tabbed line"]);
  // Two identical rules are two rules: nothing here dedupes, because dropping one would change the reader's list.
  assert.deepEqual(rulesFrom(["same", "same"]), ["same", "same"]);
});

test("a project's count is what the chip draws, and a capped read stops at the cap", () => {
  assert.equal(rulesCount({ rules: ["a", "b"] }), 2);
  assert.equal(rulesCount({}), 0);
  // A hand-edited file with more than the cap still reads: the list is capped, not refused, so the panel boots.
  const many = Array.from({ length: RULES_MAX + 5 }, (_, i) => `rule ${i}`);
  assert.equal(rulesFrom(many).length, RULES_MAX);
  assert.equal(rulesFrom(["x".repeat(RULE_MAX_CHARS + 30)])[0].length, RULE_MAX_CHARS);
});

// ---- 3-4: the write side ----------------------------------------------------------------------------------------
test("a save is refused when it would change what the reader typed, and the caps are the ones the page obeys", () => {
  assert.deepEqual(validateRules(["never touch lib/jobs.js", "  quote the assertion  "]), {
    rules: ["never touch lib/jobs.js", "quote the assertion"],
  });
  // Empty is a legal SAVE (it clears the list) but a blank RULE is not: the editor's ✕ is how a line goes away.
  assert.deepEqual(validateRules([]), { rules: [] });
  assert.match(validateRules([""]).error, /rule 1 is empty/);
  assert.match(validateRules(["ok", "   "]).error, /rule 2 is empty/);
  assert.match(validateRules(["not a string", 5]).error, /rule 2 is not a string/);
  assert.match(validateRules("nope").error, /must be a list/);
  assert.match(validateRules(["x".repeat(RULE_MAX_CHARS + 1)]).error, new RegExp(`the cap is ${RULE_MAX_CHARS}`));
  assert.match(validateRules(Array.from({ length: RULES_MAX + 1 }, (_, i) => `r${i}`)).error, /at most 40 rules/);
  // The caps the page is told are the caps this writer enforces: one pair of numbers, not two that can drift.
  assert.equal(RULE_MAX_CHARS, 200);
  assert.equal(RULES_MAX, 40);
});

test("the config row keeps every field it had, invents no path, and drops the key when the list is empty", () => {
  // A project config.json does not name yet: the NAME and the rules. No path - discovery merges this row onto the
  // repository it scanned by name, and a path here would be one machine's copy of a fact the scan owns.
  assert.deepEqual(projectRulesRow(null, "agent-worktree-gui", ["never touch lib/jobs.js"]), {
    name: "agent-worktree-gui",
    rules: ["never touch lib/jobs.js"],
  });
  // A row that exists keeps its own fields: the remote, the main branch and the push controls are not this writer's.
  // The path is written POSIX-style on purpose: tools/absolute-paths.mjs refuses a tracked file that names a folder on
  // this machine, and a test fixture has no reason to - the rule is about this repo's own tree, not about paths in
  // general.
  const existing = { name: "menu", path: "/srv/repos/menu", remote: "origin", mainBranch: "main", pushNewBranches: "never" };
  assert.deepEqual(projectRulesRow(existing, "menu", ["one"]), { ...existing, rules: ["one"] });
  // The row handed in is not mutated: a caller holding the parsed file still has the file it read.
  assert.equal(existing.rules, undefined);
  // Empty means the key is GONE, not `[]`: the field is optional, and a project nobody gave a rule should not carry
  // a key because a reader opened its bar once.
  assert.deepEqual(projectRulesRow({ name: "menu", rules: ["one"] }, "menu", []), { name: "menu" });
});

// ---- 5: the route's own contract, with a recorder instead of a socket -------------------------------------------
function harness({ body = {}, token = null, method = "POST", query = "" } = {}) {
  const sent = [];
  const calls = [];
  const registry = {
    projects: [
      { name: "alpha", rules: ["never touch lib/jobs.js"] },
      { name: "beta", rules: [] },
    ],
  };
  const routes = createProjectRulesRoutes({
    getConfig: () => ({ token }),
    registry,
    setProjectRules: async (name, rules) => {
      calls.push({ name, rules });
      if (name === "nope") return { status: 404, error: "unknown project: nope" };
      const checked = validateRules(rules);
      if (checked.error) return { status: 400, error: checked.error };
      const rec = registry.projects.find((p) => p.name === name);
      if (rec) rec.rules = checked.rules;
      return { ok: true, project: name, rules: checked.rules };
    },
    sendJson: (res, status, payload) => sent.push({ status, payload }),
    readBody: async () => body,
    authorised: (req) => req.authorised !== false,
  });
  const req = { method, url: `${RULES_PATH}${query}`, authorised: true };
  return { routes, req, sent, calls, registry };
}

test("the route answers the shapes a caller can send, and its read carries the caps", async () => {
  // The list read: every project, the caps, and the empty one present as an empty list (the chip draws zero).
  {
    const h = harness({ method: "GET" });
    assert.equal(await h.routes(h.req, {}, RULES_PATH, new URL(`http://x${RULES_PATH}`)), true);
    assert.equal(h.sent[0].status, 200);
    assert.deepEqual(h.sent[0].payload.projects, { alpha: ["never touch lib/jobs.js"], beta: [] });
    assert.equal(h.sent[0].payload.max, RULES_MAX);
    assert.equal(h.sent[0].payload.maxChars, RULE_MAX_CHARS);
  }
  // One project: its list, its count, and the caps the editor's `maxlength` comes from.
  {
    const h = harness({ method: "GET" });
    await h.routes(h.req, {}, RULES_PATH, new URL(`http://x${RULES_PATH}?project=alpha`));
    assert.deepEqual(h.sent[0].payload.rules, ["never touch lib/jobs.js"]);
    assert.equal(h.sent[0].payload.count, 1);
    assert.equal(h.sent[0].payload.maxChars, RULE_MAX_CHARS);
  }
  // A project the board does not carry is a 404, not an empty list: a typo has to be findable.
  {
    const h = harness({ method: "GET" });
    await h.routes(h.req, {}, RULES_PATH, new URL(`http://x${RULES_PATH}?project=nope`));
    assert.equal(h.sent[0].status, 404);
    assert.match(h.sent[0].payload.error, /unknown project/);
  }
  // A save: the whole list, in the reader's order, and the answer is what the writer stored.
  {
    const h = harness({ body: { project: "alpha", rules: ["b", "a"] } });
    await h.routes(h.req, {}, RULES_PATH, new URL(`http://x${RULES_PATH}`));
    assert.equal(h.sent[0].status, 200);
    assert.deepEqual(h.sent[0].payload.rules, ["b", "a"]);
    assert.equal(h.sent[0].payload.count, 2);
    assert.deepEqual(h.calls, [{ name: "alpha", rules: ["b", "a"] }]);
  }
  // The refusals: a missing project, a missing list, a blank rule, an unknown project, a bad method, a bad token.
  {
    const h = harness({ body: { rules: [] } });
    await h.routes(h.req, {}, RULES_PATH, new URL(`http://x${RULES_PATH}`));
    assert.equal(h.sent[0].status, 400);
    assert.match(h.sent[0].payload.error, /project is required/);
  }
  {
    const h = harness({ body: { project: "alpha" } });
    await h.routes(h.req, {}, RULES_PATH, new URL(`http://x${RULES_PATH}`));
    assert.equal(h.sent[0].status, 400);
    assert.match(h.sent[0].payload.error, /rules is required/);
  }
  {
    const h = harness({ body: { project: "alpha", rules: ["ok", "  "] } });
    await h.routes(h.req, {}, RULES_PATH, new URL(`http://x${RULES_PATH}`));
    assert.equal(h.sent[0].status, 400);
    assert.match(h.sent[0].payload.error, /rule 2 is empty/);
    // The refusal carries the list the panel still holds, so the editor can put the reader's rows back.
    assert.deepEqual(h.sent[0].payload.rules, ["never touch lib/jobs.js"]);
  }
  {
    const h = harness({ body: { project: "nope", rules: [] } });
    await h.routes(h.req, {}, RULES_PATH, new URL(`http://x${RULES_PATH}`));
    assert.equal(h.sent[0].status, 404);
  }
  {
    const h = harness({ method: "PUT" });
    await h.routes(h.req, {}, RULES_PATH, new URL(`http://x${RULES_PATH}`));
    assert.equal(h.sent[0].status, 405);
    assert.match(h.sent[0].payload.error, /PUT is not allowed/);
  }
  {
    const h = harness({ body: { project: "alpha", rules: [] }, token: "secret" });
    h.req.authorised = false;
    await h.routes(h.req, {}, RULES_PATH, new URL(`http://x${RULES_PATH}`));
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

test("rulesOut is the read's one shape, and a project it cannot find says why", () => {
  const registry = { projects: [{ name: "alpha", rules: ["x"] }, { name: "beta" }] };
  assert.deepEqual(rulesOut(registry, "beta"), { max: RULES_MAX, maxChars: RULE_MAX_CHARS, project: "beta", rules: [], count: 0 });
  const missing = rulesOut(registry, "nope");
  assert.equal(missing.rules, null);
  assert.match(missing.error, /unknown project/);
});

// ---- 6: the round trip through a real panel --------------------------------------------------------------------
test("a save lands in config.json, reads back out of the route, and rides the next snapshot", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wtgui-rules-"));
  const repos = path.join(dir, "repos");
  mkdirSync(repos, { recursive: true });
  const paths = {};
  for (const name of ["alpha", "beta"]) {
    const repo = path.join(repos, name);
    mkdirSync(repo, { recursive: true });
    git(repo, ["init", "-q", "-b", "main"]);
    configureRepo(repo);
    git(repo, ["commit", "-q", "--allow-empty", "-m", "first"]);
    paths[name] = repo.replace(/\\/g, "/");
  }
  // `beta` starts WITH a rule (as a hand-edited config would hold it) and `alpha` starts without the key at all, so
  // both halves of "optional, defaulting to empty" are on the board at once.
  const panel = await startPanel({
    dir,
    keep: false,
    config: {
      scanRoots: [repos.replace(/\\/g, "/")],
      projects: [
        { name: "alpha", path: paths.alpha, mainBranch: "main" },
        { name: "beta", path: paths.beta, mainBranch: "main", rules: ["seed rule for beta"] },
      ],
      assistant: { enabled: false },
      worktreeSeconds: 60,
      midSeconds: 60,
      dormantSeconds: 60,
      slowSeconds: 60,
    },
  });
  const get = async (query = "") => {
    const r = await fetch(`${panel.base}${RULES_PATH}${query}`);
    return { status: r.status, json: await r.json() };
  };
  const postRules = async (project, rules) => {
    const r = await fetch(`${panel.base}${RULES_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project, rules }),
    });
    return { status: r.status, json: await r.json() };
  };

  try {
    // The board is drawn before the states are read: the route answers from the registry, which discovery fills.
    for (let i = 0; i < 100; i++) {
      const state = await (await fetch(`${panel.base}/api/state`)).json();
      if ((state.projects || []).length >= 2) break;
      await new Promise((r) => setTimeout(r, 150));
    }

    // BOTH halves of the default: alpha has no key in the file and reads as zero rules; beta's hand-written list is
    // served unchanged, in its own order.
    const all = await get();
    assert.equal(all.status, 200);
    assert.deepEqual(all.json.projects.alpha, []);
    assert.deepEqual(all.json.projects.beta, ["seed rule for beta"]);

    // Add: the whole list goes up, and the reader's order is what comes back.
    const added = await postRules("alpha", ["never touch lib/jobs.js", "quote the failing assertion"]);
    assert.equal(added.status, 200);
    assert.deepEqual(added.json.rules, ["never touch lib/jobs.js", "quote the failing assertion"]);

    // THE FILE is the store, so it is read rather than trusted: the row is the project's own and carries no path it
    // did not already have (alpha's entry has one; the RULES are the only thing this write moved).
    const cfgPath = path.join(dir, "config.json");
    let file = JSON.parse(await readFile(cfgPath, "utf8"));
    let alpha = file.projects.find((p) => p.name === "alpha");
    assert.deepEqual(alpha.rules, ["never touch lib/jobs.js", "quote the failing assertion"]);
    assert.equal(alpha.path, paths.alpha, "the row keeps the path it already had");
    assert.deepEqual(file.projects.find((p) => p.name === "beta").rules, ["seed rule for beta"], "a sibling's list is untouched");

    // Edit and reorder are one operation on this route: a new list, in a new order.
    const reordered = await postRules("alpha", ["quote the failing assertion", "never touch lib/jobs.js"]);
    assert.equal(reordered.status, 200);
    assert.deepEqual(reordered.json.rules, ["quote the failing assertion", "never touch lib/jobs.js"]);
    const edited = await postRules("alpha", ["quote the failing assertion before touching the code", "never touch lib/jobs.js"]);
    assert.deepEqual(edited.json.rules, ["quote the failing assertion before touching the code", "never touch lib/jobs.js"]);

    // A delete is the shorter list; a DELETED-ALL is an empty list, and the key leaves the file rather than storing
    // `[]` beside the reader's other project facts.
    await postRules("alpha", ["never touch lib/jobs.js"]);
    const cleared = await postRules("alpha", []);
    assert.equal(cleared.status, 200);
    assert.deepEqual(cleared.json.rules, []);
    file = JSON.parse(await readFile(cfgPath, "utf8"));
    alpha = file.projects.find((p) => p.name === "alpha");
    assert.equal(Object.hasOwn(alpha, "rules"), false, "an empty list removes the key");

    // The refusal is a 400 and the file is untouched: a blank line is refused, never stored.
    const blank = await postRules("alpha", ["ok", ""]);
    assert.equal(blank.status, 400);
    assert.match(blank.json.error, /rule 2 is empty/);
    file = JSON.parse(await readFile(cfgPath, "utf8"));
    assert.equal(Object.hasOwn(file.projects.find((p) => p.name === "alpha"), "rules"), false);

    const unknown = await postRules("nope", ["x"]);
    assert.equal(unknown.status, 404);
    const missing = await get("?project=nope");
    assert.equal(missing.status, 404);

    // WHAT THE CHIP COUNTS: the project record on `/api/state` carries the list, which is what the page draws from
    // without a second call. A save has to reach it before the next discovery pass, or the chip lies until then.
    await postRules("alpha", ["one", "two", "three"]);
    const state = await (await fetch(`${panel.base}/api/state`)).json();
    const record = (state.projects || []).find((p) => p.name === "alpha");
    assert.deepEqual(record.rules, ["one", "two", "three"]);
    assert.deepEqual((state.projects || []).find((p) => p.name === "beta").rules, ["seed rule for beta"]);
    // ...and the route agrees with the snapshot, which is the pair of answers the chip and the bar are drawn from.
    assert.deepEqual((await get("?project=alpha")).json.rules, ["one", "two", "three"]);
  } finally {
    await panel.stop();
  }
});
