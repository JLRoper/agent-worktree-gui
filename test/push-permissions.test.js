// Two four-way push controls — one for a NEW branch, one for an EXISTING branch — and the precedence that decides
// what a push actually meets. This replaces the old three-value `remoteBranchPolicy` plus the per-project
// `allowPushWithoutAsking` switch, so these tests are written against the new model ONLY: a resolver that still
// reads the old precedence fails here even when the old tests would have passed.
//
// What is pinned, each one a way a permission model can look right and be wrong:
//
//   1. the four values are a CLOSED vocabulary, and a value that cannot be read falls back to ASKING;
//   2. a project's own pair beats its repository's defaults, and a repo force-override beats both;
//   3. `never` is ABSOLUTE — a project's never beats a forced repo allow-all, and a repo's never beats a project's
//      allow-all. A force-override that could open a `never` would be a permission nobody granted;
//   4. the legacy keys migrate on READ: deny → never, allow / the old switch → allow-all, local-only → always-ask,
//      and the file on disk is not rewritten;
//   5. the NAME GATE is one rule: the resolver and the generated pre-push hook agree about main/master and
//      YYYYMMDD_HHMM_<TICKET>_<desc>, because the hook greps the pattern the resolver compiled;
//   6. the two settings routes round-trip through config.json and back out of /api/config, and refuse a value, a
//      kind, a project or a force-overridden project they cannot honour;
//   7. the card renders a project's pair, and renders it DISABLED with a one-line note under a force-override;
//   8. the Settings → Repo tab carries a section per remote repository (including "any other remote" and "no remote
//      at all"), and the old global select and per-project checkbox are gone from the page.
//
// The route half boots the real server.js (tools/panel-testkit.mjs); the page half slices public/app.js between its
// own region markers, so the claim is about the function the browser runs rather than about its source text.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { BRANCH_NAME_GATE_PATTERN, branchNamePassesGate, branchesInPushRefs, permissionForPush, pushChoiceFrom, repoKeyForProject, repoKeyForRemoteUrl, resolvePushPermissions } from "../lib/push-permissions.js";
import { commonDirOf, guardPaths, guardState, installGuard } from "../lib/push-guard.js";
import { configureRepo, git as runGit, post, startPanel } from "../tools/panel-testkit.mjs";

const src = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const slash = (p) => String(p || "").replace(/\\/g, "/");
const ZERO = "0000000000000000000000000000000000000000";

// ---- 1–5: the resolver, with no panel and no page ---------------------------------------------------------------
test("the four values are a closed vocabulary, and an unreadable value asks", () => {
  assert.deepEqual(
    ["allow-all", "allow-name-gate", "always-ask", "never"].map((v) => pushChoiceFrom(v)),
    ["allow-all", "allow-name-gate", "always-ask", "never"],
  );
  // Everything that is not one of the four is a value somebody invented: fall back — to the caller's fallback when
  // it is one of the four, otherwise to the shipped default, which asks.
  for (const junk of ["", null, undefined, "yes", "on", "1", "allow", "local-only"]) {
    assert.equal(pushChoiceFrom(junk), "always-ask", `junk ${JSON.stringify(junk)} falls back to asking`);
    assert.equal(pushChoiceFrom(junk, "allow-all"), "allow-all", `junk ${JSON.stringify(junk)} falls back to the caller's value`);
  }
  assert.equal(pushChoiceFrom("ALLOW-ALL "), "allow-all", "case and padding are trimmed, not refused");
  assert.equal(pushChoiceFrom("bogus", "also-bogus"), "always-ask", "an unreadable fallback is still the asking default");
});

test("the repository section is read from the remote URL, with `other` and `none` as explicit answers", () => {
  const cases = [
    ["git@git.sefl.com:IT/email-multi.git", "git.sefl.com/IT"],
    ["ssh://git@git.sefl.com/SA/infra.git", "git.sefl.com/SA"],
    ["https://git.sefl.com/IT/email-multi", "git.sefl.com/IT"],
    ["git@github.com:JLRoper/agent-worktree-gui.git", "github/JLRoper"],
    ["https://github.com/Somebody/else.git", "other"],
    ["https://gitlab.com/a/b.git", "other"],
  ];
  for (const [url, key] of cases) assert.equal(repoKeyForRemoteUrl(url), key, url);
  assert.equal(repoKeyForRemoteUrl(""), "", "a project with no URL has no repository section of its own");
  assert.equal(repoKeyForProject({ remoteUrl: "git@git.sefl.com:SA/x.git" }), "git.sefl.com/SA");
  assert.equal(repoKeyForProject({ remote: "origin", remoteUrl: "https://example.com/x.git" }), "other");
  assert.equal(repoKeyForProject({ remote: "origin" }), "other", "a remote with no URL is still a remote");
  assert.equal(repoKeyForProject({}), "none");
});

test("a project's own value beats the repo default, and a force-override beats the project", () => {
  const project = { name: "it-app", remoteUrl: "git@git.sefl.com:IT/email-multi.git", pushNewBranches: "allow-name-gate" };
  const gate = { pushPermissions: { repos: { "git.sefl.com/IT": { newBranches: "allow-all", existingBranches: "allow-all" } } } };

  const own = resolvePushPermissions(project, gate);
  assert.equal(own.newBranches, "allow-name-gate", "the project's own value wins");
  assert.equal(own.newSource, "project");
  assert.equal(own.existingBranches, "allow-all", "a kind the project does not state inherits the repo's");
  assert.equal(own.existingSource, "repo");
  assert.equal(own.forced, false);

  const forced = resolvePushPermissions(project, {
    pushPermissions: { repos: { "git.sefl.com/IT": { newBranches: "always-ask", existingBranches: "allow-all", force: true } } },
  });
  assert.equal(forced.forced, true);
  assert.equal(forced.newBranches, "always-ask", "force makes the repo's value win");
  assert.equal(forced.newSource, "repo-force");
  assert.equal(forced.projectNewBranches, "allow-name-gate", "and the project's own answer is still reported, replaced not erased");
});

test("never is absolute: it beats a force-override and a project's allow-all", () => {
  const it = { name: "it", remoteUrl: "git@git.sefl.com:IT/x.git" };
  // The project says never; the repo forces allow-all. The answer is never.
  const fromProject = resolvePushPermissions(
    { ...it, pushNewBranches: "never" },
    { pushPermissions: { repos: { "git.sefl.com/IT": { newBranches: "allow-all", existingBranches: "allow-all", force: true } } } },
  );
  assert.equal(fromProject.newBranches, "never");
  assert.equal(fromProject.newSource, "project");

  // The repo says never; the project says allow-all. The answer is never, without a force-override.
  const fromRepo = resolvePushPermissions(
    { ...it, pushNewBranches: "allow-all" },
    { pushPermissions: { repos: { "git.sefl.com/IT": { newBranches: "never" } } } },
  );
  assert.equal(fromRepo.newBranches, "never");
  assert.equal(fromRepo.newSource, "repo");

  // …and the legacy global `deny` is a never too, for a project and a repo that state nothing.
  const legacyDeny = resolvePushPermissions(it, { remoteBranchPolicy: "deny" });
  assert.equal(legacyDeny.newBranches, "never");
  assert.equal(legacyDeny.existingBranches, "never");
});

test("the legacy keys migrate on read — deny, allow, and the old per-project switch", () => {
  const at = (project, gate) => {
    const r = resolvePushPermissions(project, gate);
    return [r.newBranches, r.existingBranches, r.legacy];
  };
  assert.deepEqual(at({}, { remoteBranchPolicy: "local-only" }), ["always-ask", "always-ask", true]);
  assert.deepEqual(at({}, { remoteBranchPolicy: "allow" }), ["allow-all", "allow-all", true]);
  assert.deepEqual(at({}, { remoteBranchPolicy: "deny" }), ["never", "never", true]);
  assert.deepEqual(at({ allowPushWithoutAsking: true }, {}), ["allow-all", "allow-all", true]);
  assert.deepEqual(at({ remoteBranchPolicy: "deny", allowPushWithoutAsking: true }, {}), ["never", "never", true], "deny wins in the legacy pair too");
  assert.deepEqual(at({}, {}), ["always-ask", "always-ask", false], "nothing stated, nothing legacy");
  // The new key beats the legacy one on the same record: a reader who edited the file by hand meant the new pair.
  // Only the kind it states moves; the other still falls back, because a key nobody wrote is not an answer.
  assert.deepEqual(at({ pushNewBranches: "allow-all", allowPushWithoutAsking: false }, {}), ["allow-all", "always-ask", true]);
});

test("the name gate is one rule, and the generated hook greps the same pattern the resolver compiled", async () => {
  assert.equal(BRANCH_NAME_GATE_PATTERN, "^[0-9]{8}_[0-9]{4}_[A-Z][A-Z0-9]+-[0-9]+_[a-z0-9._-]+$", "the portable ERE the hook can grep");
  assert.equal(branchNamePassesGate("main"), true);
  assert.equal(branchNamePassesGate("master"), true);
  assert.equal(branchNamePassesGate("20261102_1431_ABC-1234_fix_login_redirect"), true);
  assert.equal(branchNamePassesGate("refs/heads/20261102_1431_ABC-1234_fix_login_redirect"), true, "a full ref is the same branch");
  for (const bad of ["wtgui/replace-the-push-permiss-588511", "20261102_1431_abc-1234_fix", "20261102_1431_ABC-1234_Fix", "2026_1431_ABC-1234_fix", "feature/x", ""]) {
    assert.equal(branchNamePassesGate(bad), false, bad);
  }
  // The permission matrix the card and the guard both read.
  assert.equal(permissionForPush({ newBranches: "allow-name-gate" }, { branch: "20261102_1431_ABC-1_x", isNew: true }), "allow");
  assert.equal(permissionForPush({ newBranches: "allow-name-gate" }, { branch: "wtgui/x", isNew: true }), "ask");
  assert.equal(permissionForPush({ newBranches: "allow-name-gate", existingBranches: "never" }, { branch: "main", isNew: false }), "refuse");
  assert.equal(permissionForPush({ newBranches: "allow-all" }, { branch: "whatever", isNew: true }), "allow");
  assert.equal(permissionForPush({ existingBranches: "always-ask" }, { branch: "main", isNew: false }), "ask");

  // …and the HOOK, generated by the installer into a throwaway repo, decides the same three cases. This is the half
  // that proves "exposed from one place": the pattern in the guard dir is the constant above, not a second copy.
  const dir = mkdtempSync(path.join(os.tmpdir(), "wtgui-push-gate-"));
  try {
    const repo = path.join(dir, "repo");
    mkdirSync(repo, { recursive: true });
    runGit(repo, ["init", "-q", "-b", "main"]);
    configureRepo(repo);
    runGit(repo, ["commit", "-q", "--allow-empty", "-m", "first"]);
    runGit(repo, ["remote", "add", "origin", "git@git.sefl.com:IT/email-multi.git"]);
    const out = await installGuard({
      projectPath: repo,
      worktree: repo,
      panelUrl: "http://127.0.0.1:1",
      policy: "local-only",
      pushPermissions: { newBranches: "allow-name-gate", existingBranches: "never" },
    });
    assert.equal(out.ok, true, out.error);
    const paths = guardPaths(await commonDirOf(repo));
    assert.equal(readFileSync(paths.namegate, "utf8").trim(), BRANCH_NAME_GATE_PATTERN, "the hook's gate file is the resolver's constant");
    const run = (branch, remoteSha) => {
      const line = `refs/heads/${branch} HEAD refs/heads/${branch} ${remoteSha}\n`;
      try {
        // cwd is the fixture repo, as git runs a hook: the hook reads `git rev-parse --show-toplevel` for its
        // message, and a run from this checkout would name the wrong tree in it.
        return { code: 0, out: execFileSync("sh", [path.join(paths.dir, "pre-push")], { cwd: repo, input: line, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }) };
      } catch (e) {
        return { code: e.status ?? 1, out: `${e.stdout || ""}${e.stderr || ""}` };
      }
    };
    assert.equal(run("20261102_1431_ABC-1234_fix_login", ZERO).code, 0, "a new branch that passes the gate goes through without asking");
    const failing = run("wtgui/some-work", ZERO);
    assert.equal(failing.code, 1, "a new branch that fails the gate parks on the panel");
    assert.match(failing.out, /permission box|did not answer/, "…and it asked, it did not refuse outright");
    assert.doesNotMatch(failing.out, /is never/);
    const existing = run("main", "1111111111111111111111111111111111111111");
    assert.equal(existing.code, 1, "an existing branch meets the existing control, which is never");
    assert.match(existing.out, /never/, "the refusal names the control that refused it");
    const state = await guardState({ projectPath: repo, worktree: repo });
    assert.equal(state.newBranches, "allow-name-gate");
    assert.equal(state.existingBranches, "never");
    assert.equal(state.nameGate, BRANCH_NAME_GATE_PATTERN);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

test("a push list is read per ref: new when the remote has no sha, existing when it does", () => {
  const refs = [
    `refs/heads/main abc refs/heads/main 1111`,
    `refs/heads/20261102_1431_ABC-1_x def refs/heads/20261102_1431_ABC-1_x ${ZERO}`,
    `refs/heads/gone 000 refs/heads/gone ${ZERO}`,
    `refs/tags/v1 abc refs/tags/v1 ${ZERO}`,
  ].join("\n");
  assert.deepEqual(branchesInPushRefs(refs), [
    { branch: "main", isNew: false },
    { branch: "20261102_1431_ABC-1_x", isNew: true },
  ]);
});

// ---- 6: the routes, on a real server -------------------------------------------------------------------------
const REPOS = [
  { name: "it-app", url: "git@git.sefl.com:IT/email-multi.git" },
  { name: "sa-app", url: "ssh://git@git.sefl.com/SA/infra.git" },
  { name: "gh-app", url: "git@github.com:JLRoper/agent-worktree-gui.git" },
  { name: "other-app", url: "https://gitlab.com/somebody/else.git" },
  { name: "no-remote", url: "" },
];

async function makeBoard() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wtgui-push-"));
  const repos = path.join(dir, "repos");
  mkdirSync(repos, { recursive: true });
  const paths = {};
  for (const r of REPOS) {
    const repo = path.join(repos, r.name);
    mkdirSync(repo, { recursive: true });
    runGit(repo, ["init", "-q", "-b", "main"]);
    configureRepo(repo);
    runGit(repo, ["commit", "-q", "--allow-empty", "-m", "first"]);
    if (r.url) runGit(repo, ["remote", "add", "origin", r.url]);
    paths[r.name] = slash(repo);
  }
  return { dir, repos, paths };
}

const configFor = (board) => ({
  scanRoots: [slash(board.repos)],
  projects: REPOS.map((r) => ({ name: r.name, path: board.paths[r.name], mainBranch: "main", ...(r.url ? { remote: "origin" } : {}) })),
  assistant: { enabled: false },
  worktreeSeconds: 4,
  midSeconds: 4,
  dormantSeconds: 4,
  slowSeconds: 4,
});

async function withPanel(board, config, fn) {
  const panel = await startPanel({ dir: board.dir, keep: true, config });
  try {
    return await fn(panel);
  } finally {
    await panel.stop();
  }
}

const settingsOf = async (base) => (await fetch(`${base}/api/config`)).json();

// Discovery probes a project's remote URL on its own clock, and the repository section is read from that URL. Poll
// until the panel has classified the project, so the assertion is about the resolver rather than about a race.
async function waitForRepo(base, name, key, timeoutMs = 60_000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const s = await settingsOf(base);
    if (s.pushPermissions?.projects?.[name]?.repo === key) return s;
    if (Date.now() > until) return s;
    await new Promise((r) => setTimeout(r, 250));
  }
}

test("POST /api/settings/push-project round-trips one kind through config.json and /api/config", async (t) => {
  const board = await makeBoard();
  try {
    await withPanel(board, configFor(board), async (panel) => {
      const before = await waitForRepo(panel.base, "it-app", "git.sefl.com/IT");
      assert.equal(before.pushPermissions.projects["it-app"].newBranches, "always-ask", "the shipped default asks");
      assert.equal(before.pushPermissions.projects["it-app"].repo, "git.sefl.com/IT", "the project is filed under its repository");

      const on = await post(panel.base, "/api/settings/push-project", { body: { project: "it-app", kind: "new", value: "allow-name-gate" } });
      assert.equal(on.status, 200, on.text);
      assert.equal(on.json.ok, true);
      assert.equal(on.json.settings.pushPermissions.projects["it-app"].newBranches, "allow-name-gate");
      assert.equal(on.json.settings.pushPermissions.projects["it-app"].existingBranches, "always-ask", "one kind is one kind");
      const live = await settingsOf(panel.base);
      assert.equal(live.pushPermissions.projects["it-app"].newBranches, "allow-name-gate");
      assert.equal(live.pushPermissions.projects["sa-app"].newBranches, "always-ask", "another repository is untouched");
      const written = JSON.parse(readFileSync(path.join(board.dir, "config.json"), "utf8"));
      assert.equal(written.projects.find((p) => p.name === "it-app").pushNewBranches, "allow-name-gate");
      assert.equal("pushExistingBranches" in written.projects.find((p) => p.name === "it-app"), false, "only the key that changed is written");

      // The assistant-readable endpoint answers the same pair, and a branch question now has an answer.
      const ask = await (await fetch(`${panel.base}/api/remote-write/allow-push?project=it-app&branch=20261102_1431_ABC-1_x&new=1`)).json();
      assert.equal(ask.newBranches, "allow-name-gate");
      assert.equal(ask.permission, "allow", "a turnover name passes the gate");
      assert.equal(ask.ask, false);
      const askFail = await (await fetch(`${panel.base}/api/remote-write/allow-push?project=it-app&branch=wtgui/x&new=1`)).json();
      assert.equal(askFail.permission, "ask", "anything else parks");

      // A value, a kind and a project it cannot honour are refusals, not silent saves.
      assert.equal((await post(panel.base, "/api/settings/push-project", { body: { project: "it-app", kind: "new", value: "yes" } })).status, 400);
      assert.equal((await post(panel.base, "/api/settings/push-project", { body: { project: "it-app", kind: "sideways", value: "never" } })).status, 400);
      assert.equal((await post(panel.base, "/api/settings/push-project", { body: { project: "nope", kind: "new", value: "never" } })).status, 404);
    });
  } finally {
    await rm(board.dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

test("POST /api/settings/push-repo writes the repository defaults and its force-override", async (t) => {
  const board = await makeBoard();
  try {
    await withPanel(board, configFor(board), async (panel) => {
      const repo = await post(panel.base, "/api/settings/push-repo", { body: { repo: "git.sefl.com/IT", kind: "existing", value: "allow-all" } });
      assert.equal(repo.status, 200, repo.text);
      assert.equal(repo.json.record.existingBranches, "allow-all");
      let live = await waitForRepo(panel.base, "it-app", "git.sefl.com/IT");
      assert.equal(live.pushPermissions.repos["git.sefl.com/IT"].existingBranches, "allow-all");
      assert.equal(live.pushPermissions.projects["it-app"].existingBranches, "allow-all", "a project that states nothing inherits it");
      assert.equal(live.pushPermissions.projects["it-app"].existingSource, "repo");
      assert.equal(live.pushPermissions.projects["sa-app"].existingBranches, "always-ask", "the SA repository has its own record");

      // A project's own value wins while the force-override is off…
      const own = await post(panel.base, "/api/settings/push-project", { body: { project: "it-app", kind: "existing", value: "allow-name-gate" } });
      assert.equal(own.status, 200, own.text);
      live = await settingsOf(panel.base);
      assert.equal(live.pushPermissions.projects["it-app"].existingBranches, "allow-name-gate");

      // …and stops winning the moment the repository forces its values.
      const forced = await post(panel.base, "/api/settings/push-repo", { body: { repo: "git.sefl.com/IT", force: true } });
      assert.equal(forced.status, 200, forced.text);
      live = await settingsOf(panel.base);
      assert.equal(live.pushPermissions.repos["git.sefl.com/IT"].force, true);
      assert.equal(live.pushPermissions.projects["it-app"].forced, true, "the card renders disabled on this");
      assert.equal(live.pushPermissions.projects["it-app"].existingBranches, "allow-all", "the repo's value is in force");

      // A write to a project the repository owns is refused while the override is on: the disabled select and the
      // route must tell the same story.
      const refused = await post(panel.base, "/api/settings/push-project", { body: { project: "it-app", kind: "new", value: "allow-all" } });
      assert.equal(refused.status, 409, refused.text);
      assert.match(refused.json.error, /force-override/);
      assert.match(refused.json.error, /git\.sefl\.com\/IT/);

      // `never` is still absolute: the forced repo is allow-all, the project says never, and never wins.
      const written = JSON.parse(readFileSync(path.join(board.dir, "config.json"), "utf8"));
      written.projects.find((p) => p.name === "it-app").pushExistingBranches = "never";
      // (written directly: the ROUTE refuses while the override is on, which is the point of the 409 above)
      const { writeFileSync } = await import("node:fs");
      writeFileSync(path.join(board.dir, "config.json"), `${JSON.stringify(written, null, 2)}\n`);
      const reload = await post(panel.base, "/api/reload", { body: {} });
      assert.ok([200, 202, 204].includes(reload.status), `reload answered ${reload.status}`);
      live = await settingsOf(panel.base);
      assert.equal(live.pushPermissions.projects["it-app"].existingBranches, "never", "never beats the force-override");
      assert.equal(live.pushPermissions.projects["it-app"].forced, true, "the override is still on — it just cannot open a never");

      // A repository key and a force value the model cannot read are refusals.
      assert.equal((await post(panel.base, "/api/settings/push-repo", { body: { repo: "git.sefl.com/XX", force: true } })).status, 400);
      assert.equal((await post(panel.base, "/api/settings/push-repo", { body: { repo: "other", force: "yes" } })).status, 400);
    });
  } finally {
    await rm(board.dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

test("the legacy config keys are read, mapped, and left on disk", async (t) => {
  const board = await makeBoard();
  try {
    const cfg = configFor(board);
    // An install that never knew the new controls: a global allow, one project that says deny, one that turned the
    // old per-remote switch on. The page must draw the four-way pair the old file MEANS.
    cfg.remoteBranchPolicy = "allow";
    cfg.projects = cfg.projects.map((p) =>
      p.name === "sa-app" ? { ...p, remoteBranchPolicy: "deny" } : p.name === "gh-app" ? { ...p, allowPushWithoutAsking: true } : p,
    );
    await withPanel(board, cfg, async (panel) => {
      const live = await settingsOf(panel.base);
      assert.equal(live.pushPermissions.projects["it-app"].newBranches, "allow-all", "the global allow is both allow-all");
      assert.equal(live.pushPermissions.projects["it-app"].existingBranches, "allow-all");
      assert.equal(live.pushPermissions.projects["sa-app"].newBranches, "never", "the project's legacy deny is never");
      assert.equal(live.pushPermissions.projects["gh-app"].newBranches, "allow-all", "the old per-project switch is allow-all");
      assert.equal(live.pushPermissions.projects["other-app"].newBranches, "allow-all", "an unstated project inherits the global legacy value");
      // Nothing was written: migration happens on READ, so a downgrade still finds the file it wrote.
      const written = JSON.parse(readFileSync(path.join(board.dir, "config.json"), "utf8"));
      assert.equal(written.remoteBranchPolicy, "allow");
      assert.equal("pushPermissions" in written, false);
      assert.equal("pushNewBranches" in written.projects.find((p) => p.name === "it-app"), false);
    });
  } finally {
    await rm(board.dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

// ---- 7–8: the page -------------------------------------------------------------------------------------------
function pageRegion() {
  const begin = src.indexOf("// ---- push permissions: the two controls");
  assert.ok(begin >= 0, "public/app.js carries the push-permissions region");
  const end = src.indexOf("// ---- end push permissions", begin);
  assert.ok(end > begin, "and its end marker");
  return src.slice(src.indexOf("\n", begin) + 1, end);
}

function pageWith(settings) {
  const region = pageRegion();
  const document = {
    addEventListener() {},
    querySelectorAll: () => [],
    querySelector: () => null,
    activeElement: null,
  };
  const $ = () => null;
  const state = { settings: { pushPermissions: settings } };
  const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const apiFetch = async () => ({ ok: true, json: async () => ({}) });
  const showBanner = () => {};
  const CSS = { escape: (s) => String(s) };
  return new Function("state", "$", "esc", "apiFetch", "showBanner", "document", "CSS", `${region}\nreturn { pushControlsHtml, pushOptionsHtml, pushRepoSectionHtml, paintPushPermissions, PUSH_REPO_ORDER };`)(
    state,
    $,
    esc,
    apiFetch,
    showBanner,
    document,
    CSS,
  );
}

const BLOCK = {
  choices: ["allow-all", "allow-name-gate", "always-ask", "never"],
  labels: { "allow-all": "allow all", "allow-name-gate": "name gate", "always-ask": "always ask", never: "never" },
  defaultChoice: "always-ask",
  repos: {
    "git.sefl.com/IT": { key: "git.sefl.com/IT", label: "git.sefl.com/IT", newBranches: "allow-all", existingBranches: "always-ask", force: true, projects: ["it-app"] },
    "git.sefl.com/SA": { key: "git.sefl.com/SA", label: "git.sefl.com/SA", newBranches: "always-ask", existingBranches: "allow-name-gate", force: false, projects: ["sa-app"] },
    "github/JLRoper": { key: "github/JLRoper", label: "github/JLRoper", newBranches: "always-ask", existingBranches: "always-ask", force: false, projects: [] },
    other: { key: "other", label: "any other remote", newBranches: "always-ask", existingBranches: "always-ask", force: false, projects: ["other-app"] },
    none: { key: "none", label: "no remote at all", newBranches: "always-ask", existingBranches: "always-ask", force: false, projects: ["no-remote"] },
  },
  projects: {
    "it-app": { repo: "git.sefl.com/IT", repoLabel: "git.sefl.com/IT", newBranches: "allow-all", existingBranches: "always-ask", forced: true },
    "sa-app": { repo: "git.sefl.com/SA", repoLabel: "git.sefl.com/SA", newBranches: "always-ask", existingBranches: "allow-name-gate", forced: false },
  },
};

test("the card draws both controls — and draws them disabled with a note under a force-override", () => {
  const page = pageWith(BLOCK);
  const forced = page.pushControlsHtml("it-app");
  assert.equal((forced.match(/data-push-kind="new"/g) || []).length, 1, "a NEW control");
  assert.equal((forced.match(/data-push-kind="existing"/g) || []).length, 1, "and an EXISTING control");
  assert.equal((forced.match(/ disabled/g) || []).length, 2, "both render disabled, not one");
  assert.match(forced, /repo setting in force/, "and the one-line note says why");
  assert.match(forced, /git\.sefl\.com\/IT/, "the note names the repository, not just \"the repo\"");
  assert.equal((forced.match(/<option/g) || []).length, 8, "each select offers exactly the four values");

  const free = page.pushControlsHtml("sa-app");
  assert.doesNotMatch(free, /disabled/, "no force-override, no disabled select");
  assert.doesNotMatch(free, /repo setting in force/);
  assert.match(free, /value="allow-name-gate" selected/, "the resolved value is the selected option");
  assert.match(page.pushOptionsHtml("never"), /value="never" selected/);
});

test("the Settings → Repo tab carries a section per remote repository, and the retired controls are gone", () => {
  const page = pageWith(BLOCK);
  assert.deepEqual(page.PUSH_REPO_ORDER, ["git.sefl.com/IT", "git.sefl.com/SA", "github/JLRoper", "other", "none"]);
  const it = page.pushRepoSectionHtml("git.sefl.com/IT", BLOCK.repos["git.sefl.com/IT"]);
  assert.match(it, /<details/, "a collapsible section");
  assert.match(it, /data-push-repo-kind="new"/, "its new-branch default");
  assert.match(it, /data-push-repo-kind="existing"/, "its existing-branch default");
  assert.match(it, /data-push-force="git\.sefl\.com\/IT" checked/, "the force-override toggle, checked where it is on");
  assert.match(it, /force these values for every project/);
  assert.match(it, /1 project: it-app/, "and it names the projects it governs");
  assert.match(page.pushRepoSectionHtml("other", BLOCK.repos.other), /any other remote/);
  const none = page.pushRepoSectionHtml("none", BLOCK.repos.none);
  assert.match(none, /no remote at all/);
  assert.match(page.pushRepoSectionHtml("none", { ...BLOCK.repos.none, projects: [] }), /no project on this board has no remote at all/, "the no-remote section is explicit rather than empty");
  assert.match(page.pushRepoSectionHtml("github/JLRoper", BLOCK.repos["github/JLRoper"]), /0 projects/, "a named repository with no projects still has its section");

  // The old model's two controls are gone from the markup and from the page.
  assert.doesNotMatch(html, /id="remote-policy"/, "the global Remote branches select is gone");
  assert.doesNotMatch(html, /id="remote-switch-rows"/, "the per-project switch list is gone");
  assert.doesNotMatch(src, /data-remote-allow/, "and no checkbox reads the old switch");
  assert.doesNotMatch(src, /saveRemotePolicy|remote-switch-count/, "nor its writer or count");
  assert.match(html, /data-settings-tab="repo"/);
  assert.match(html, />Repo</, "the tab is labelled Repo");
  assert.match(html, /data-settings-group="repo"/);
});
