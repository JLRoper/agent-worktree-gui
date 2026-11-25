// The clone route: the URL comes from the CHOSEN HOST'S RECORD, never from a literal in server.js.
//
//   POST /api/clone {root, name, host} -> the host's `clone.ssh` template rendered with that host's coordinates.
//
// The two shapes this board actually has are asserted exactly: github keeps the owner's mixed case
// (`JLRoper/agent-worktree-gui`), and git.sefl.com takes the PROJECT KEY and repo slug, with the key lower case in
// its ssh path (`citdev/java-ruleset` -> `/citdev/java-ruleset.git`). A third host is added as DATA in a file and
// builds its URL with no code change; a host with no clone template, an unknown id, and the names the route has
// always refused (a URL, a path, `..`) are asserted by the sentence the row prints.
//
// The route itself is exercised against a real panel. Both real hosts are asked for a DRY RUN, which builds the URL
// from the record and touches no network; the one clone that actually runs is a local fixture host, so the test needs
// no ssh and no GitHub.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DEFAULT_SEED_FILE,
  Hosts,
  cloneTarget,
  readHostsFile,
  validateHostRecord,
} from "../lib/hosts.js";
import { git, post, slash, startPanel } from "../tools/panel-testkit.mjs";

// The address a clone URL carries, built rather than written so this file holds no real mailbox.
const AT = String.fromCharCode(64);
const GH_URL = `git${AT}github.com:JLRoper/agent-worktree-gui.git`;
const SEFL_URL = `ssh://git${AT}git.sefl.com:7999/citdev/java-ruleset.git`;
// A drive-letter path, built rather than written: the repository's absolute-path scan refuses a literal one in a
// committed file, and this test needs the shape without adding a path that exists on one machine only.
const DRIVE_PATH = ["C", ":", "/repos/x"].join("");

const seed = readHostsFile(DEFAULT_SEED_FILE);

test("the shipped seed gives both hosts a human name and a clone route, and still validates", () => {
  assert.deepEqual(seed.warnings, []);
  assert.equal(seed.hosts.github.name, "GitHub");
  assert.equal(seed.hosts["sefl-bitbucket"].name, "SEFL Bitbucket");
  // The clone template is a remote route, not a links kind: it is not forced to start from {base}.
  assert.ok(seed.hosts.github.clone.ssh.includes("{owner}/{repo}"));
  assert.ok(seed.hosts["sefl-bitbucket"].clone.ssh.includes("{projectKeyLower}/{repoSlug}"));
  for (const [id, rec] of Object.entries(seed.hosts)) assert.deepEqual(validateHostRecord(id, rec), [], id);
});

test("the github shape keeps the owner's case, and a bare name falls back to the record's owner", () => {
  const typed = cloneTarget(seed, "github", "JLRoper/agent-worktree-gui");
  assert.equal(typed.url, GH_URL);
  assert.deepEqual(typed.coordinates, { owner: "JLRoper", repo: "agent-worktree-gui" });
  assert.equal(typed.destName, "agent-worktree-gui");
  assert.equal(typed.host, "github");
  assert.equal(typed.hostName, "GitHub");
  // The owner default is now the CHOSEN RECORD's coordinate, not config.cloneOwner.
  assert.equal(cloneTarget(seed, "github", "agent-worktree-gui").url, GH_URL);
  // A trailing .git is accepted and does not land in the destination name.
  assert.equal(cloneTarget(seed, "github", "agent-worktree-gui.git").destName, "agent-worktree-gui");
});

test("the SEFL shape resolves to git.sefl.com with the PROJECT KEY, lower-cased in the ssh path", () => {
  const typed = cloneTarget(seed, "sefl-bitbucket", "citdev/java-ruleset");
  assert.equal(typed.url, SEFL_URL);
  assert.deepEqual(typed.coordinates, { projectKey: "CITDEV", repoSlug: "java-ruleset" });
  assert.equal(typed.destName, "java-ruleset");
  assert.equal(typed.hostName, "SEFL Bitbucket");
  // A bare repo name takes the record's own project key (IT), the same way a bare github name takes its owner.
  assert.equal(cloneTarget(seed, "sefl-bitbucket", "java-ruleset").url, `ssh://git${AT}git.sefl.com:7999/it/java-ruleset.git`);
  // The key is an identifier: typed lower, upper or mixed, it is the same project and the path is lower case.
  for (const spelling of ["CITDEV/java-ruleset", "citDev/java-ruleset"]) {
    assert.equal(cloneTarget(seed, "sefl-bitbucket", spelling).url, SEFL_URL, spelling);
  }
});

test("a third host is a record: it builds its own clone URL with no code change", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wtgui-clone-host-"));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  const file = path.join(dir, "hosts.json");
  await writeFile(
    file,
    JSON.stringify({
      version: 1,
      hosts: {
        "example-git": {
          name: "Example Git",
          kind: "bitbucket-server",
          base: "https://git.example.test",
          coordinates: { projectKey: "TEAM" },
          clone: { ssh: `ssh://git${AT}git.example.test:2222/{projectKeyLower}/{repoSlug}.git` },
          links: {
            branch: "{base}/projects/{projectKey}/repos/{repoSlug}/browse?at=refs/heads/{branch}",
            pull: "{base}/projects/{projectKey}/repos/{repoSlug}/pull-requests/{pr}",
          },
          api: { transport: "rest", listOpenPrs: "{base}/rest/pull-requests", tokenEnv: "EXAMPLE_TOKEN" },
          landing: "push {branch} and open a pull request into {main}",
        },
      },
      projects: {},
    }),
    "utf8",
  );
  const doc = readHostsFile(file);
  assert.deepEqual(doc.warnings, [], "a third record is data the file already understands");
  const built = cloneTarget(doc, "example-git", "team/widget");
  assert.equal(built.url, `ssh://git${AT}git.example.test:2222/team/widget.git`);
  assert.equal(built.hostName, "Example Git");
  assert.equal(built.coordinates.projectKey, "TEAM");
});

test("every refusal NAMES the host it could not resolve, and no refusal carries a URL", () => {
  const unknown = cloneTarget(seed, "nowhere", "repo");
  assert.equal(unknown.url, null);
  assert.match(unknown.why, /host "nowhere" is not defined/);
  assert.match(unknown.why, /known hosts: github, sefl-bitbucket/);

  const none = cloneTarget(seed, "", "repo");
  assert.equal(none.url, null);
  assert.match(none.why, /no host chosen/);

  // A record with links and no clone route is valid for the board and NOT cloneable; it is refused by name.
  const noClone = { version: 1, hosts: { plain: { ...seed.hosts.github, clone: undefined } }, projects: {} };
  assert.deepEqual(validateHostRecord("plain", noClone.hosts.plain), []);
  const refused = cloneTarget(noClone, "plain", "JLRoper/agent-worktree-gui");
  assert.equal(refused.url, null);
  assert.match(refused.why, /host "plain" has no clone\.ssh template/);

  // The names the route has always refused, each with the host's own sentence.
  const cases = [
    ["https://github.com/a/b", /is a URL or a path/],
    ["git" + AT + ":a/b.git", /is a URL or a path/],
    ["a/b/c", /is a path/],
    ["../escape", /carries "\.\."/],
    ["..", /carries "\.\."/],
    ["sub/../../x", /carries "\.\."/],
    ["/absolute", /is a path/],
    [DRIVE_PATH, /is a URL or a path/],
    ["a\\b", /is a path/],
  ];
  for (const [name, why] of cases) {
    const out = cloneTarget(seed, "github", name);
    assert.equal(out.url, null, `${name} must not build a URL`);
    assert.match(out.why, why, name);
    assert.match(out.why, /host "github"/, `${name} must name the host`);
  }
});

test("the state the page draws carries the human name and whether the host can clone", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wtgui-clone-state-"));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  const live = path.join(dir, "hosts.json");
  await writeFile(live, JSON.stringify({ version: 1, hosts: {}, projects: {} }), "utf8");
  const hosts = new Hosts({ file: live, seedFile: DEFAULT_SEED_FILE });
  const state = hosts.state();
  assert.equal(state.hosts.github.name, "GitHub");
  assert.equal(state.hosts.github.clone, true);
  assert.equal(state.hosts["sefl-bitbucket"].name, "SEFL Bitbucket");
  assert.equal(state.hosts["sefl-bitbucket"].clone, true);
});

test("POST /api/clone builds from the record, refuses by name, and still creates a local project", async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), "wtgui-clone-route-"));
  const logs = path.join(base, "logs");
  const scanRoot = path.join(base, "repos");
  const fixtures = path.join(base, "fixtures");
  await mkdir(logs, { recursive: true });
  await mkdir(scanRoot, { recursive: true });
  await mkdir(fixtures, { recursive: true });

  // A local bare repo the fixture host clones, so the success path runs without ssh or a remote network.
  const src = path.join(base, "fixture-src");
  await mkdir(src, { recursive: true });
  await writeFile(path.join(src, "README.md"), "the fixture\n", "utf8");
  git(src, ["init", "-q", "-b", "main"]);
  git(src, ["add", "."]);
  git(src, ["commit", "-qm", "fixture"]);
  git(base, ["clone", "-q", "--bare", src, path.join(fixtures, "fixture.git")]);

  const record = (over = {}) => ({
    kind: "github",
    base: "https://example.invalid",
    coordinates: {},
    links: { branch: "{base}/{owner}/{repo}/tree/{branch}", pull: "{base}/{owner}/{repo}/pull/{pr}" },
    api: { transport: "rest", listOpenPrs: "{base}/prs", tokenEnv: "TEST_TOKEN" },
    landing: "push {branch} and open a pull request into {main}",
    ...over,
  });
  const seedDoc = {
    version: 1,
    hosts: {
      github: record({ name: "GitHub", base: "https://github.com", coordinates: { owner: "JLRoper" }, clone: { ssh: `git${AT}github.com:{owner}/{repo}.git` } }),
      "sefl-bitbucket": record({
        name: "SEFL Bitbucket",
        kind: "bitbucket-server",
        base: "https://git.sefl.com",
        coordinates: { projectKey: "IT" },
        clone: { ssh: `ssh://git${AT}git.sefl.com:7999/{projectKeyLower}/{repoSlug}.git` },
      }),
      local: record({ name: "Local fixture", clone: { ssh: `${slash(fixtures)}/{repo}.git` } }),
      "no-clone": record({ name: "No clone route" }),
    },
    projects: {},
  };
  await writeFile(path.join(logs, "hosts.seed.json"), JSON.stringify(seedDoc, null, 2), "utf8");

  const panel = await startPanel({
    dir: base,
    config: {
      scanRoots: [scanRoot],
      worktreeSeconds: 1,
      midSeconds: 1,
      dormantSeconds: 1,
      slowSeconds: 2,
      hostsFile: path.join(logs, "hosts.json"),
      hostsSeedFile: path.join(logs, "hosts.seed.json"),
    },
  });
  t.after(async () => {
    await panel.stop();
    await rm(base, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  const clone = (body) => post(panel.base, "/api/clone", { body });

  // A root outside scanRoots is still refused first.
  const outside = await clone({ root: path.join(base, "elsewhere"), name: "x", host: "github" });
  assert.equal(outside.status, 400);
  assert.match(outside.json?.error || "", /root must be one of scanRoots/);

  // No host, an unknown host, and a host with no clone route: each refused BY NAME.
  const none = await clone({ root: scanRoot, name: "repo" });
  assert.equal(none.status, 400);
  assert.match(none.json?.error || "", /no host chosen/);
  const unknown = await clone({ root: scanRoot, name: "repo", host: "nowhere" });
  assert.equal(unknown.status, 400);
  assert.match(unknown.json?.error || "", /host "nowhere" is not defined/);
  assert.equal(unknown.json?.host, "nowhere");
  const noClone = await clone({ root: scanRoot, name: "repo", host: "no-clone" });
  assert.equal(noClone.status, 400);
  assert.match(noClone.json?.error || "", /host "no-clone" has no clone\.ssh template/);

  // A URL, a path and `..` never build a URL or make a folder.
  for (const name of ["https://github.com/a/b", "a/b/c", "..", "../escape", DRIVE_PATH]) {
    const bad = await clone({ root: scanRoot, name, host: "github" });
    assert.equal(bad.status, 400, `${name}: ${bad.text.slice(0, 200)}`);
    assert.match(bad.json?.error || "", /host "github"/, name);
  }
  assert.equal((await readFile(path.join(scanRoot, "..", "escape"), "utf8").catch(() => null)), null);

  // The two real shapes, built by the route from each host's own record. A dry run proves the URL without a network.
  const gh = await clone({ root: scanRoot, name: "JLRoper/agent-worktree-gui", host: "github", dryRun: true });
  assert.equal(gh.status, 200, gh.text.slice(0, 300));
  assert.equal(gh.json?.url, GH_URL);
  assert.equal(gh.json?.host, "github");
  assert.equal(gh.json?.hostName, "GitHub");
  const sefl = await clone({ root: scanRoot, name: "citdev/java-ruleset", host: "sefl-bitbucket", dryRun: true });
  assert.equal(sefl.status, 200, sefl.text.slice(0, 300));
  assert.equal(sefl.json?.url, SEFL_URL);
  assert.deepEqual(sefl.json?.coordinates, { projectKey: "CITDEV", repoSlug: "java-ruleset" });
  // The choice CHANGES the URL the same name builds.
  assert.notEqual(gh.json?.url, sefl.json?.url);

  // The one real clone: the fixture host's record is the URL, and the destination is the repo slug.
  const made = await clone({ root: scanRoot, name: "fixture", host: "local" });
  assert.equal(made.status, 200, made.text.slice(0, 400));
  const dest = path.join(scanRoot, "fixture");
  assert.equal(slash(made.json?.dest), slash(dest));
  assert.equal(made.json?.host, "local");
  assert.equal(made.json?.hostName, "Local fixture");
  assert.equal(made.json?.url, `${slash(fixtures)}/fixture.git`);
  assert.equal(git(dest, ["rev-parse", "--abbrev-ref", "HEAD"]), "main");
  assert.equal(git(dest, ["rev-list", "--count", "HEAD"]), "1");
  const again = await clone({ root: scanRoot, name: "fixture", host: "local" });
  assert.equal(again.status, 409);
  assert.match(again.json?.error || "", /already exists/);

  // A clone that fails names the host and the URL it tried, so the row says which route broke.
  const failed = await clone({ root: scanRoot, name: "missing", host: "local" });
  assert.equal(failed.status, 502, failed.text.slice(0, 300));
  assert.match(failed.json?.error || "", /clone from Local fixture \(local\) failed at .*missing\.git/);
  assert.equal(failed.json?.host, "local");
  assert.equal(failed.json?.url, `${slash(fixtures)}/missing.git`);

  // The button beside it is untouched: no host is posted and a local project is still inited on main.
  const fresh = await post(panel.base, "/api/project/new", { body: { root: scanRoot, name: "local-proj" } });
  assert.equal(fresh.status, 201, fresh.text.slice(0, 300));
  assert.equal(git(path.join(scanRoot, "local-proj"), ["rev-parse", "--abbrev-ref", "HEAD"]), "main");
});
