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
  TURNOVER_MAX_CHARS,
  projectTurnoverRow,
  turnoverBranchFrom,
  turnoverBranchOf,
  turnoverLookup,
  validateTurnoverBranch,
} from "../lib/project-turnover.js";
import { TURNOVER_PATH, createProjectTurnoverRoutes, turnoverOut } from "../routes/project-turnover.js";
import { configureRepo, git, startPanel } from "../tools/panel-testkit.mjs";

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

test("turnoverOut is the read's one shape, and a project it cannot find says why", () => {
  const registry = { projects: [{ name: "alpha", turnoverBranch: "feature/turnover" }, { name: "beta" }] };
  // The read gained the THREE KINDS and their labels (lib/base-ref-kind.js): the bar draws its select from this
  // answer, so a page never carries a second copy of the list or of the words the reader picks from.
  assert.deepEqual(turnoverOut(registry, "beta"), {
    maxChars: TURNOVER_MAX_CHARS,
    kinds: ["checkout", "turnover", "local-turnover"],
    kindLabels: { checkout: "the checkout's own branch", turnover: "the named turnover branch", "local-turnover": "local turnover branch - ask if none exist" },
    project: "beta",
    turnoverBranch: "",
    baseRefKind: "checkout",
  });
  assert.deepEqual(turnoverOut(registry, "alpha").turnoverBranch, "feature/turnover");
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
  const panel = await startPanel({
    dir,
    keep: false,
    config: {
      scanRoots: [repos.replace(/\\/g, "/")],
      projects: [
        { name: "alpha", path: paths.alpha, mainBranch: "main", turnoverBranch: "feature/turnover" },
        { name: "beta", path: paths.beta, mainBranch: "main" },
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

    // A save on a DISCOVERED project: a new row, the branch, and NO invented path.
    const discovered = await postTurnover("gamma", "feature/roll-up");
    assert.equal(discovered.status, 200);
    file = JSON.parse(await readFile(cfgPath, "utf8"));
    const gamma = file.projects.find((p) => p.name === "gamma");
    assert.equal(gamma.turnoverBranch, "feature/roll-up");
    assert.equal(Object.hasOwn(gamma, "path"), false, "the row invents no path");

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
    // next discovery pass or the chip lies until then.
    const state = await (await fetch(`${panel.base}/api/state`)).json();
    const record = (state.projects || []).find((p) => p.name === "beta");
    assert.equal(record.turnoverBranch, "feature/roll-up");
    assert.equal((state.projects || []).find((p) => p.name === "gamma").turnoverBranch, "feature/roll-up");
    // ...and the route agrees with the snapshot, which is the pair of answers the chip and the bar are drawn from.
    assert.equal((await get("?project=beta")).json.turnoverBranch, "feature/roll-up");
  } finally {
    await panel.stop();
  }
});
