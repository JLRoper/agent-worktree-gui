// The host mapping: templates, the unmapped case, and the landing doctrines.
//
// Every case here is about DATA that decides where a link goes — the tokens, which coordinates win, what an unmapped
// project reads like, and what a landing agent is told. None of it needs a server, a browser or a network: the module
// is pure over a loaded document, and the prompt is a string function.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DEFAULT_SEED_FILE,
  HOST_TOKENS,
  Hosts,
  linkFor,
  mappingView,
  mergeDocs,
  parseRemote,
  prListing,
  proposeMapping,
  readHostsFile,
  renderProse,
  renderTemplate,
  resolveMapping,
  saveProjectMapping,
  validateHostRecord,
} from "../lib/hosts.js";
import { mergePrompt } from "../lib/merge-prompt.js";

// The seed this repo ships: the real github and git.sefl.com records, read from disk so a change to them is judged
// here rather than kept in step by hand.
const seed = readHostsFile(DEFAULT_SEED_FILE);

test("the shipped seed is valid, and carries the two hosts the board uses", () => {
  assert.deepEqual(seed.warnings, []);
  assert.deepEqual(Object.keys(seed.hosts).sort(), ["github", "sefl-bitbucket"]);
  assert.equal(seed.hosts.github.kind, "github");
  assert.equal(seed.hosts.github.coordinates.owner, "JLRoper");
  assert.equal(seed.hosts["sefl-bitbucket"].kind, "bitbucket-server");
  assert.equal(seed.hosts["sefl-bitbucket"].base, "https://git.sefl.com");
  assert.equal(seed.hosts["sefl-bitbucket"].coordinates.projectKey, "IT");
  assert.equal(seed.hosts["sefl-bitbucket"].api.tokenEnv, "BITBUCKET_SEFL_TOKEN");
  // The api block names the endpoint the doctrine polls and the one the board reads.
  assert.match(seed.hosts["sefl-bitbucket"].api.listOpenPrs, /\/pull-requests\?state=OPEN/);
  assert.match(seed.hosts["sefl-bitbucket"].api.listPullRequests, /\/pull-requests\?state=ALL/);
});

test("every token in the seed's templates is one the renderer knows", () => {
  for (const [id, rec] of Object.entries(seed.hosts)) {
    for (const [kind, tpl] of Object.entries(rec.links)) {
      for (const token of tpl.matchAll(/\{([A-Za-z]+)\}/g)) {
        assert.ok(HOST_TOKENS.includes(token[1]), `${id}.links.${kind} uses {${token[1]}}`);
      }
    }
  }
});

test("a token is encoded by where it sits: path segments keep their slashes, query values do not", () => {
  // Path context (the GitHub tree page): one segment per branch segment.
  assert.equal(renderTemplate("{base}/{owner}/{repo}/tree/{branch}", { base: "https://github.com", owner: "JLRoper", repo: "r", branch: "wtgui/x-1a2b3c" }), "https://github.com/JLRoper/r/tree/wtgui/x-1a2b3c");
  // Query context (Bitbucket's `at`): the whole ref as one value.
  assert.equal(
    renderTemplate("{base}/projects/{projectKey}/repos/{repoSlug}/browse?at=refs/heads/{branch}", { base: "https://git.sefl.com", projectKey: "IT", repoSlug: "m", branch: "feature/x" }),
    "https://git.sefl.com/projects/IT/repos/m/browse?at=refs/heads/feature%2Fx",
  );
  // `base` is a URL, never encoded into `https%3A//…`.
  assert.equal(renderTemplate("{base}/{owner}", { base: "https://git.sefl.com", owner: "IT" }), "https://git.sefl.com/IT");
  // A token with no value never becomes half a URL.
  assert.throws(() => renderTemplate("{base}/{owner}/{repo}", { base: "https://x", owner: "a" }), /no value for \{repo\}/);
  assert.throws(() => renderTemplate("{base}/{nope}", { base: "https://x" }), /unknown token \{nope\}/);
});

test("a bitbucket project's four links come out in the shapes that host documents", () => {
  const project = { name: "Menu", mainBranch: "master" };
  const vals = { branch: "feature/menu-oauth2-gateway", sha: "abc1234", pr: 42 };
  assert.equal(linkFor(seed, project, "repo").url, "https://git.sefl.com/projects/IT/repos/Menu");
  assert.equal(linkFor(seed, project, "branch", vals).url, "https://git.sefl.com/projects/IT/repos/Menu/browse?at=refs/heads/feature%2Fmenu-oauth2-gateway");
  assert.equal(linkFor(seed, project, "pull", vals).url, "https://git.sefl.com/projects/IT/repos/Menu/pull-requests/42");
  assert.equal(linkFor(seed, project, "commit", vals).url, "https://git.sefl.com/projects/IT/repos/Menu/commits/abc1234");
  assert.equal(
    linkFor(seed, project, "newPull", vals).url,
    "https://git.sefl.com/projects/IT/repos/Menu/pull-requests?create&sourceBranch=refs%2Fheads%2Ffeature%2Fmenu-oauth2-gateway&targetBranch=refs%2Fheads%2Fmaster",
  );
});

test("a github project's branch and PR links keep their own shapes", () => {
  const project = { name: "agent-worktree-gui", mainBranch: "main" };
  assert.equal(linkFor(seed, project, "branch", { branch: "wtgui/panel-5523df" }).url, "https://github.com/JLRoper/agent-worktree-gui/tree/wtgui/panel-5523df");
  assert.equal(linkFor(seed, project, "pull", { pr: 68 }).url, "https://github.com/JLRoper/agent-worktree-gui/pull/68");
  // A project in another org overrides only the owner: that is what "optional coordinate overrides" is for.
  assert.equal(linkFor(seed, { name: "jlr-test-repo", mainBranch: "main" }, "repo").url, "https://github.com/59055_SEFL/jlr-test-repo");
});

test("another Bitbucket project (SA vs IT) is a coordinate override, not a second host", () => {
  assert.equal(resolveMapping(seed, { name: "fleet-kafka" }).coordinates.projectKey, "SA");
  assert.equal(linkFor(seed, { name: "fleet-kafka", mainBranch: "master" }, "repo").url, "https://git.sefl.com/projects/SA/repos/fleet-kafka");
  assert.equal(resolveMapping(seed, { name: "email-multi" }).coordinates.projectKey, "IT");
});

test("coordinates compose: host defaults, then the project record, then the reader's file", () => {
  const doc = {
    hosts: { h: { kind: "bitbucket-server", base: "https://bb.example", coordinates: { projectKey: "IT", repoSlug: "default" }, links: { branch: "{base}/{projectKey}/{repoSlug}/{branch}", pull: "{base}/{projectKey}/{repoSlug}/{pr}" }, api: { listOpenPrs: "{base}/{projectKey}/{repoSlug}", tokenEnv: "T" }, landing: "x" } },
    projects: { p: { host: "h", coordinates: { repoSlug: "from-file" } } },
    warnings: [],
  };
  // The file's entry wins over the project record's own coordinates…
  assert.equal(resolveMapping(doc, { name: "p", coordinates: { repoSlug: "from-record", projectKey: "SA" } }).coordinates.repoSlug, "from-file");
  // …and anything it does not name falls back to the record, then to the host.
  assert.equal(resolveMapping(doc, { name: "p", coordinates: { repoSlug: "from-record", projectKey: "SA" } }).coordinates.projectKey, "SA");
  assert.equal(resolveMapping(doc, { name: "other", host: "h" }).coordinates.repoSlug, "default");
});

test("a project with no mapping gets NO url, and a sentence naming the file to edit", () => {
  const link = linkFor(seed, { name: "JIRA-cleanup-edp-epics", mainBranch: "master" }, "branch", { branch: "master" });
  assert.equal(link.url, null);
  assert.match(link.why, /has no host mapping/);
  assert.match(link.why, /logs\/hosts\.json/);
  // The PR link is the same answer: never a github.com guess for a project nobody mapped.
  assert.equal(linkFor(seed, { name: "JIRA-cleanup-edp-epics" }, "pull", { pr: 3 }).url, null);
  assert.equal(linkFor(seed, { name: "JIRA-cleanup-edp-epics" }, "pull", { pr: 3 }).url === null, true);
});

test("an unknown host id is refused with the id it could not find, not a fallback", () => {
  const doc = { hosts: seed.hosts, projects: { ghost: { host: "nowhere" } }, warnings: [] };
  const link = linkFor(doc, { name: "ghost" }, "branch", { branch: "main" });
  assert.equal(link.url, null);
  assert.match(link.why, /host "nowhere" is not defined/);
});

test("a host record with a typo is DROPPED with a warning; the other records still work", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wtgui-hosts-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "hosts.json");
  await writeFile(
    file,
    JSON.stringify({
      version: 1,
      hosts: {
        good: { kind: "github", base: "https://github.com", coordinates: { owner: "o" }, links: { branch: "{base}/{owner}/{repo}/tree/{branch}", pull: "{base}/{owner}/{repo}/pull/{pr}" }, api: { listOpenPrs: "https://api/{owner}/{repo}", tokenEnv: "T" }, landing: "land it" },
        bad: { kind: "gitlab", base: "not-a-url", links: {}, api: {}, landing: "" },
      },
      projects: { a: { host: "good", coordinates: { repo: "r" } }, b: { host: "" } },
    }),
    "utf8",
  );
  const doc = readHostsFile(file);
  assert.deepEqual(Object.keys(doc.hosts), ["good"]);
  assert.deepEqual(Object.keys(doc.projects), ["a"]);
  assert.ok(doc.warnings.some((w) => w.startsWith('host "bad"')), doc.warnings.join("\n"));
  assert.ok(doc.warnings.some((w) => w.startsWith("projects.b")), doc.warnings.join("\n"));
  assert.equal(linkFor(doc, { name: "a" }, "branch", { branch: "b" }).url, "https://github.com/o/r/tree/b");
});

test("the live file overrides the seed per host id and per project, the seed supplies the rest", () => {
  const live = { hosts: { github: { ...seed.hosts.github, base: "https://github.example" } }, projects: { Menu: { host: "github", coordinates: { owner: "someone", repo: "Menu" } } }, warnings: [] };
  const doc = mergeDocs(seed, live);
  assert.equal(doc.hosts.github.base, "https://github.example");
  assert.ok(doc.hosts["sefl-bitbucket"], "a host the live file did not mention is still there from the seed");
  assert.equal(doc.projects.Menu.host, "github");
  assert.equal(doc.projects["email-multi"].host, "sefl-bitbucket");
});

test("the PR list comes from the api block: transport, endpoint and the env var that holds the token", () => {
  const listing = prListing(seed, { name: "email-multi", mainBranch: "master" });
  assert.equal(listing.transport, "rest");
  assert.equal(listing.tokenEnv, "BITBUCKET_SEFL_TOKEN");
  assert.equal(listing.url, "https://git.sefl.com/rest/api/1.0/projects/IT/repos/email-multi/pull-requests?state=ALL&limit=100");
  assert.equal(listing.openUrl, "https://git.sefl.com/rest/api/1.0/projects/IT/repos/email-multi/pull-requests?state=OPEN&limit=50");
  const gh = prListing(seed, { name: "agent-worktree-gui" });
  assert.equal(gh.transport, "gh");
  assert.equal(gh.url, "https://api.github.com/repos/JLRoper/agent-worktree-gui/pulls?state=all&per_page=100");
  // No mapping: nothing to list, and the same sentence the cells carry.
  assert.match(prListing(seed, { name: "nothing-mapped" }).why, /has no host mapping/);
});

test("a remote URL proposes a mapping against a host this board already has", () => {
  const bb = proposeMapping(seed, {}, "ssh://git@git.sefl.com/it/email-multi.git");
  assert.deepEqual({ ok: bb.ok, host: bb.host, coordinates: bb.coordinates }, { ok: true, host: "sefl-bitbucket", coordinates: { projectKey: "IT", repoSlug: "email-multi" } });
  const gh = proposeMapping(seed, {}, "git@github.com:JLRoper/agent-worktree-gui.git");
  assert.deepEqual({ ok: gh.ok, host: gh.host, coordinates: gh.coordinates }, { ok: true, host: "github", coordinates: { owner: "JLRoper", repo: "agent-worktree-gui" } });
  const https = proposeMapping(seed, {}, "https://git.sefl.com/scm/SA/fleet-kafka.git");
  assert.deepEqual(https.coordinates, { projectKey: "SA", repoSlug: "fleet-kafka" });
  // A host nobody has a record for is refused, with the hostname to add — never silently mapped to github.
  const unknown = proposeMapping(seed, {}, "git@gitlab.example:team/thing.git");
  assert.equal(unknown.ok, false);
  assert.match(unknown.why, /no host record has base gitlab\.example/);
  // No remote at all.
  assert.equal(proposeMapping(seed, {}, "").ok, false);
});

test("parseRemote reads the forms a real remote uses", () => {
  assert.deepEqual(parseRemote("git@github.com:owner/repo.git").segments, ["owner", "repo"]);
  assert.deepEqual(parseRemote("ssh://git@git.sefl.com:7999/IT/repo.git").segments, ["IT", "repo"]);
  assert.deepEqual(parseRemote("https://git.sefl.com/scm/it/repo.git").segments, ["it", "repo"]);
  assert.equal(parseRemote("C:/just/a/path").why !== undefined, true);
});

test("saving one project's mapping preserves every host and every other project", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wtgui-hosts-save-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "hosts.json");
  await writeFile(file, JSON.stringify({ version: 1, hosts: { keep: { kind: "github" } }, projects: { a: { host: "keep" } } }), "utf8");
  saveProjectMapping(file, "b", { host: "sefl-bitbucket", coordinates: { projectKey: "IT", repoSlug: "b" } });
  const written = JSON.parse(await readFile(file, "utf8"));
  assert.deepEqual(written.hosts, { keep: { kind: "github" } });
  assert.deepEqual(written.projects.a, { host: "keep" });
  assert.deepEqual(written.projects.b, { host: "sefl-bitbucket", coordinates: { projectKey: "IT", repoSlug: "b" } });
  // Writing again with no coordinates REPLACES them: an override the reader removed must not survive.
  saveProjectMapping(file, "b", { host: "sefl-bitbucket", coordinates: { projectKey: "SA" } });
  const again = JSON.parse(await readFile(file, "utf8"));
  assert.deepEqual(again.projects.b.coordinates, { projectKey: "SA" });
  // And a file that did not exist is created rather than throwing.
  const fresh = path.join(dir, "new", "hosts.json");
  saveProjectMapping(fresh, "c", { host: "keep" });
  assert.deepEqual(JSON.parse(await readFile(fresh, "utf8")).projects.c, { host: "keep" });
});

test("the header view says which host a project resolves to, and why when it does not", () => {
  const menu = mappingView(seed, { name: "Menu" });
  assert.equal(menu.host, "sefl-bitbucket");
  assert.deepEqual(menu.coordinates, { projectKey: "IT", repoSlug: "Menu" });
  assert.equal(menu.links.repo, "https://git.sefl.com/projects/IT/repos/Menu");
  assert.equal(menu.templates.pull, "{base}/projects/{projectKey}/repos/{repoSlug}/pull-requests/{pr}");
  assert.equal(menu.landing, true);
  const none = mappingView(seed, { name: "unmapped" });
  assert.equal(none.host, null);
  assert.match(none.why, /no host mapping/);
});

test("Hosts reads the seed and the live file together, and a fresh save shows up on the next read", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wtgui-hosts-class-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "hosts.json");
  const hosts = new Hosts({ file, seedFile: DEFAULT_SEED_FILE, ttlMs: 0 });
  assert.equal(hosts.linkFor({ name: "Menu", mainBranch: "master" }, "repo").url, "https://git.sefl.com/projects/IT/repos/Menu");
  hosts.save("unmapped", { host: "github", coordinates: { repo: "thing" } });
  assert.equal(hosts.linkFor({ name: "unmapped" }, "repo").url, "https://github.com/JLRoper/thing");
  // The seed's other records are untouched by that write.
  assert.ok(hosts.doc({ fresh: true }).hosts["sefl-bitbucket"]);
});

// ---- the landing doctrine, in the prompt ---------------------------------------------------------------

test("the bitbucket doctrine reaches the merge prompt: four sections, one reviewer group, an hourly poll", () => {
  const prompt = mergePrompt({
    project: "email-multi",
    worktree: "C:/t",
    root: "C:/p",
    branch: "feature/mail-retry",
    base: "master",
    remote: "origin",
    ahead: 3,
    host: { id: "sefl-bitbucket", kind: "bitbucket-server", base: "https://git.sefl.com", text: renderProse(seed.hosts["sefl-bitbucket"].landing, { main: "master", branch: "feature/mail-retry", projectKey: "IT", repoSlug: "email-multi", base: "https://git.sefl.com" }), pullUrl: "https://git.sefl.com/projects/IT/repos/email-multi/pull-requests/1" },
  });
  assert.match(prompt, /LANDING - where this branch lands \(host: sefl-bitbucket/);
  // The four-section description, named.
  for (const heading of ["## Jira Ticket", "## Description", "## Test Procedures", "## Technical Specifications"]) {
    assert.ok(prompt.includes(heading), `missing ${heading}`);
  }
  assert.match(prompt, /reviewers: the GROUP code_review_java and nothing else/);
  assert.match(prompt, /title: "Java Code Review for <repo> <branch>"/);
  assert.match(prompt, /human reviewer may take a day/);
  assert.match(prompt, /poll it HOURLY/);
  assert.match(prompt, /Never report it as merged/);
  // The doctrine is the ruling where the mechanical phases disagree about the remote.
  assert.match(prompt, /Where this section and PHASE 4 disagree about the remote, THIS SECTION WINS/);
  // The branch and the coordinates were filled in; no template survived into the prompt.
  assert.ok(prompt.includes("git push origin feature/mail-retry"));
  assert.ok(!/\{branch\}|\{main\}|\{repoSlug\}|\{projectKey\}/.test(prompt), "a template token was left in the prompt");
  // And the pull request's page is named, with the id still to come.
  assert.match(prompt, /pull-requests\/<id>/);
});

test("the github doctrine is the github one: a PR this run opens, and no push to main", () => {
  const prompt = mergePrompt({ project: "agent-worktree-gui", worktree: "C:/t", root: "C:/p", branch: "wtgui/x-1a2b3c", base: "main", remote: "origin", ahead: 2, host: { id: "github", kind: "github", base: "https://github.com", text: renderProse(seed.hosts.github.landing, { main: "main", branch: "wtgui/x-1a2b3c" }), pullUrl: null } });
  assert.match(prompt, /LANDING - where this branch lands \(host: github/);
  assert.match(prompt, /gh pr create --base main --head wtgui\/x-1a2b3c/);
  assert.match(prompt, /never a push to main/);
  assert.match(prompt, /leave it OPEN/);
  assert.ok(!/code_review_java/.test(prompt), "the bitbucket doctrine leaked into a github prompt");
});

test("an unmapped project's prompt says so, and authorises nothing on a remote nobody described", () => {
  const prompt = mergePrompt({ project: "email-handler-openvms", worktree: "C:/t", root: "C:/p", branch: "b", base: "master", remote: "origin", ahead: 1 });
  assert.match(prompt, /LANDING - no host is mapped for email-handler-openvms/);
  assert.match(prompt, /do not treat PHASE 4's push of master as authorised/);
  assert.ok(!/github\.com|git\.sefl\.com/.test(prompt), "an unmapped project must not be sent to a guessed host");
  assert.ok(!/code_review_java/.test(prompt));
});
