// The changelog's links come from the clone's own remotes — never from a remote that happens to be NAMED `origin`.
//
// The defect this file exists for: `githubRepoUrl()` ran `git remote get-url origin` and read nothing else, so a
// clone whose GitHub remote is named otherwise (this box's own clone carries `github` over SSH) rendered every
// release heading without its commit and compare links. The file the repository carries HAS the links, so
// `npm run changelog:check` in such a clone could never go green on it, and the only render that WOULD satisfy the
// check was the link-less one — which is exactly what the base's own landing step (`tools/land.mjs` renders through
// this same resolver) would commit over it, stripping every link in the file.
//
// So the resolver falls back to any remote whose URL is a GitHub one (`origin` first when it exists), and a render
// that was asked for links and cannot resolve one REFUSES: a link-less file that reads as a successful render is the
// defect, not the missing links. `--no-links` is the deliberate way to write that file.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  NoGithubRemoteError,
  githubRepoUrl,
  githubUrlFrom,
  listRemotes,
  noGithubRemoteMessage,
  renderRepo,
  resolveGithubRemote,
} from "../tools/changelog.mjs";
import { ROOT, configureRepo, git } from "../tools/panel-testkit.mjs";

const GITHUB = "git@github.com:acme/widget.git";
const GITLAB = "git@gitlab.com:acme/widget.git";

// A repository with two releases and whichever remotes the case needs. The resolver's whole input is the clone's
// remote table, so the shape under test is a real clone's — and the remotes are added for real (`git remote add`),
// never through an exported GIT_CONFIG_COUNT overlay, which leaks into every child process of the whole run.
function makeRepo(remotes = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wtgui-links-"));
  git(dir, ["init", "-q", "-b", "main"]);
  configureRepo(dir);
  git(dir, ["config", "core.autocrlf", "false"]);
  writeFileSync(path.join(dir, "package.json"), `{\n  "name": "sandbox",\n  "version": "1.0.0",\n  "private": true\n}\n`, "utf8");
  writeFileSync(path.join(dir, "CHANGELOG.md"), "# Changelog\n", "utf8");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "feat: the first capability, so a release has something to name"]);
  writeFileSync(path.join(dir, "package.json"), `{\n  "name": "sandbox",\n  "version": "1.1.0",\n  "private": true\n}\n`, "utf8");
  git(dir, ["commit", "-q", "-am", "feat: the second capability, and the version this release carries"]);
  for (const [name, url] of Object.entries(remotes)) git(dir, ["remote", "add", name, url]);
  return dir;
}

function runCli(root, ...args) {
  const r = spawnSync(process.execPath, [path.join(ROOT, "tools", "changelog.mjs"), ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" },
    windowsHide: true,
  });
  return { status: r.status, text: `${r.stdout || ""}${r.stderr || ""}` };
}

const withRepo = (remotes, fn) => {
  const dir = makeRepo(remotes);
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const linksIn = (file) => (readFileSync(file, "utf8").match(/\]\(https:\/\/github\.com\//g) || []).length;

// ---------- the resolver ----------

test("a clone whose only GitHub remote is named otherwise still resolves its links", () => {
  withRepo({ github: GITHUB }, (dir) => {
    assert.equal(githubRepoUrl(dir), "https://github.com/acme/widget");
    assert.equal(resolveGithubRemote(dir).remote, "github", "the answer names the remote the links come from");
  });
});

test("origin is preferred when it is a GitHub remote, and a non-GitHub origin does not hide the GitHub one", () => {
  withRepo({ upstream: GITHUB, origin: "https://github.com/acme/widget.git" }, (dir) => {
    assert.equal(resolveGithubRemote(dir).remote, "origin");
  });
  withRepo({ origin: GITLAB, github: GITHUB }, (dir) => {
    assert.equal(
      resolveGithubRemote(dir).url,
      "https://github.com/acme/widget",
      "a remote NAMED origin that points at a mirror is not a GitHub remote, and must not stand in for one",
    );
    assert.equal(resolveGithubRemote(dir).remote, "github");
    assert.deepEqual(listRemotes(dir).map((r) => r.name), ["origin", "github"], "origin is read first, then the rest");
  });
});

test("the URL decides, not the remote's name: every GitHub URL shape a clone of this repo carries", () => {
  const cases = [
    ["git@github.com:acme/widget.git", "https://github.com/acme/widget"],
    ["git@github.com:acme/widget", "https://github.com/acme/widget"],
    ["ssh://git@github.com/acme/widget.git", "https://github.com/acme/widget"],
    ["https://github.com/acme/widget.git", "https://github.com/acme/widget"],
    ["https://github.com/acme/widget", "https://github.com/acme/widget"],
    ["https://github.com/acme/widget/", "https://github.com/acme/widget"],
    ["git@gitlab.com:acme/widget.git", null],
    ["https://bitbucket.org/acme/widget", null],
    ["C:/ProjectDevelopment/heroes-js", null],
    ["", null],
    [undefined, null],
  ];
  for (const [raw, want] of cases) assert.equal(githubUrlFrom(raw), want, `githubUrlFrom(${JSON.stringify(raw)})`);
});

test("a clone with no GitHub remote resolves nothing, and says what it looked at", () => {
  withRepo({ upstream: GITLAB }, (dir) => {
    assert.equal(githubRepoUrl(dir), null);
    assert.deepEqual(listRemotes(dir), [{ name: "upstream", url: GITLAB }]);
    const said = noGithubRemoteMessage(listRemotes(dir));
    assert.match(said, /this clone's remotes are upstream \(git@gitlab\.com:acme\/widget\.git\)/);
    assert.match(said, /--no-links/);
  });
  withRepo({}, (dir) => {
    assert.equal(githubRepoUrl(dir), null);
    assert.deepEqual(listRemotes(dir), []);
    assert.match(noGithubRemoteMessage(listRemotes(dir)), /no remotes at all/);
  });
});

test("renderRepo refuses instead of returning a link-less render, and renders one only when --no-links asked", () => {
  withRepo({ upstream: GITLAB }, (dir) => {
    assert.throws(
      () => renderRepo({ root: dir }),
      (e) => e instanceof NoGithubRemoteError && /no GitHub remote to take the changelog's links from/.test(e.message),
      "an unresolvable GitHub remote is a refusal, not a render without links",
    );
    const plain = renderRepo({ root: dir, links: false });
    assert.equal(plain.repoUrl, null);
    assert.equal(plain.remote, null);
    assert.doesNotMatch(plain.text, /https:\/\/github\.com/);
  });
});

// ---------- the CLI, end to end ----------

test("the CLI renders the links of a clone whose only GitHub remote is named otherwise, and goes green on the file it wrote", () => {
  withRepo({ github: GITHUB }, (dir) => {
    const out = path.join(dir, "CHANGELOG.md");
    const first = runCli(dir);
    assert.equal(first.status, 0, first.text);
    assert.match(first.text, /links from github/, "the render says which remote it took the links from");

    const text = readFileSync(out, "utf8");
    assert.match(text, /https:\/\/github\.com\/acme\/widget\/commit\/[0-9a-f]{40}/);
    assert.match(text, /https:\/\/github\.com\/acme\/widget\/compare\/v1\.0\.0\.\.\.v1\.1\.0/);
    assert.ok(linksIn(out) >= 4, `each release heading and each commit bullet carries a link: ${linksIn(out)}`);

    const check = runCli(dir, "--check");
    assert.equal(check.status, 0, `--check agrees with the file the same clone just wrote: ${check.text}`);
    assert.match(check.text, /is current — 2 releases/);
  });
});

test("the CLI refuses when no GitHub remote resolves, names the remotes it saw, and writes nothing", () => {
  withRepo({ github: GITHUB }, (dir) => {
    const out = path.join(dir, "CHANGELOG.md");
    assert.equal(runCli(dir).status, 0);
    const linked = readFileSync(out, "utf8");
    assert.ok(linksIn(out) > 0);

    // The GitHub remote is turned into a non-GitHub one while the file on disk keeps its links — the state a clone
    // cut from a GitHub-origin checkout is in, and the one the reported defect described. (Renaming the remote
    // alone is not enough: the URL is what decides, so a GitHub remote under another name still resolves.)
    git(dir, ["remote", "rename", "github", "upstream"]);
    git(dir, ["remote", "set-url", "upstream", GITLAB]);
    const refused = runCli(dir);
    assert.equal(refused.status, 2, refused.text);
    assert.match(refused.text, /no GitHub remote to take the changelog's links from/);
    assert.match(refused.text, /this clone's remotes are upstream \(git@gitlab\.com:acme\/widget\.git\)/);
    assert.equal(readFileSync(out, "utf8"), linked, "the refusal must leave the file the repository carries alone");

    const check = runCli(dir, "--check");
    assert.equal(check.status, 2, `--check refuses too, rather than answer about a file it cannot render: ${check.text}`);
    assert.match(check.text, /no GitHub remote/);

    // The deliberate opt-out still writes a link-less file, and says which it did.
    const plain = runCli(dir, "--no-links");
    assert.equal(plain.status, 0, plain.text);
    assert.match(plain.text, /no links: --no-links was asked for/);
    assert.equal(linksIn(out), 0);
  });
});

test("the CLI's refusal survives a clone carrying only a non-GitHub remote, and one carrying none at all", () => {
  withRepo({ upstream: GITLAB }, (dir) => {
    const r = runCli(dir);
    assert.equal(r.status, 2, r.text);
    assert.match(r.text, /upstream \(git@gitlab\.com:acme\/widget\.git\)/);
  });
  withRepo({}, (dir) => {
    const r = runCli(dir);
    assert.equal(r.status, 2, r.text);
    assert.match(r.text, /this clone has no remotes at all/);
  });
});
