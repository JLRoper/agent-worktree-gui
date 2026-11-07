// A lane claims its number by pushing its tag, so the lane that loses the race re-bumps unaided.
//
// WHY: two lanes cut from one base compute the same "next" number, and nothing is asked whether it is still free
// until the merge — the measured 1.32.0 collision (docs/research/version-integrity/parallel-lanes-and-one-version.md,
// F1) and the clone-local "anchored once" guard that let a taken number be written anyway (E4). The claim makes the
// tag on origin the reservation: git refuses to create a ref that exists, atomically, for every clone, so a
// rejected push is the signal to take the next number. These cases drive the shipped tool through the race in a
// throwaway remote, because what is being pinned is git's own ref behaviour plus the rewrite the tool makes in
// response: the bump commit amended, the tag re-anchored at the new commit, and no 1.0.1 left in the history.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { GIT_TEST_ENV, ROOT, configureRepo, git } from "../tools/panel-testkit.mjs";

const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);
const pkg = (version) => `{\n  "name": "claim-fixture",\n  "version": "${version}",\n  "private": true\n}\n`;

function copyTools(dest) {
  mkdirSync(path.join(dest, "tools"), { recursive: true });
  for (const f of ["version.mjs", "release-history.mjs"]) {
    writeFileSync(
      path.join(dest, "tools", f),
      readFileSync(path.join(ROOT, "tools", f), "utf8").split(CR + LF).join(LF),
      "utf8",
    );
  }
}

// One tool run, from inside a lane, with the identity git needs already supplied by panel-testkit.
function tool(work, args) {
  const r = spawnSync(process.execPath, [path.join(work, "tools", "version.mjs"), ...args], {
    cwd: work, encoding: "utf8", env: { ...GIT_TEST_ENV, VERSION_NO_GH: "1" }, windowsHide: true, timeout: 120000,
  });
  return { code: r.status, out: r.stdout || "", err: r.stderr || "" };
}

// A bare origin whose main declares 1.0.0, and clones that start from it at different moments — the whole point
// is that a lane only sees the claims that existed when it last spoke to the remote.
function sandbox() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wtgui-claim-"));
  const remote = path.join(dir, "remote.git");
  const seed = path.join(dir, "seed");
  mkdirSync(seed, { recursive: true });
  git(dir, ["init", "-q", "--bare", "-b", "main", remote]);
  git(seed, ["init", "-q", "-b", "main"]);
  configureRepo(seed);
  git(seed, ["config", "core.autocrlf", "false"]);
  copyTools(seed);
  writeFileSync(path.join(seed, "package.json"), pkg("1.0.0"), "utf8");
  git(seed, ["add", "-A"]);
  git(seed, ["commit", "-q", "-m", "Add the manifest so the version has one home"]);
  git(seed, ["remote", "add", "origin", remote]);
  git(seed, ["push", "-q", "-u", "origin", "main"]);

  const clone = (name) => {
    const dest = path.join(dir, name);
    // autocrlf=false at clone time, not after: the tools were committed LF and a CRLF checkout would show every
    // one of them as a modified file, which the bump would then refuse to sit under.
    git(dir, ["clone", "-q", "-c", "core.autocrlf=false", remote, dest]);
    configureRepo(dest);
    return dest;
  };
  return { dir, remote, seed, clone, done: () => rmSync(dir, { recursive: true, force: true }) };
}

function commitFile(work, rel, text, subject) {
  writeFileSync(path.join(work, rel), text, "utf8");
  git(work, ["add", "--", rel]);
  git(work, ["commit", "-q", "-m", subject]);
}

const versionOf = (work) => JSON.parse(readFileSync(path.join(work, "package.json"), "utf8")).version;

// What the remote says each tag peels to, read the way another lane reads it.
function remoteTags(work) {
  const out = new Map();
  for (const line of git(work, ["ls-remote", "--tags", "origin"]).split("\n")) {
    const [sha, ref] = line.split("\t");
    const m = /^refs\/tags\/(v\d+\.\d+\.\d+)(\^\{\})?$/.exec(ref || "");
    if (!m) continue;
    if (m[2] || !out.has(m[1])) out.set(m[1], sha);
  }
  return out;
}

test("two lanes pick one number: the second is refused the claim and re-bumps unaided", () => {
  const box = sandbox();
  try {
    const a = box.clone("lane-a");
    const b = box.clone("lane-b");
    commitFile(a, "a.txt", "a\n", "feat: lane a adds a thing");
    commitFile(b, "b.txt", "b\n", "feat: lane b adds another thing");

    // ---- lane A claims 1.0.1: the tag is pushed as part of apply ----
    const ra = tool(a, ["apply", "patch"]);
    assert.equal(ra.code, 0, `${ra.out}${ra.err}`);
    assert.match(ra.out, /package\.json\s+1\.0\.0 -> 1\.0\.1/);
    assert.match(ra.out, /claim\s+v1\.0\.1 is on origin at [0-9a-f]{10}/);
    const aBump = git(a, ["rev-parse", "HEAD"]);
    assert.equal(remoteTags(a).get("v1.0.1"), aBump, "the claim names the commit that declares the number");

    // ---- lane B chose the same number before A claimed it: the push is refused and B re-bumps itself ----
    const rb = tool(b, ["apply", "patch"]);
    assert.equal(rb.code, 0, `${rb.out}${rb.err}`);
    assert.match(rb.out, /claim\s+v1\.0\.1 is taken: origin carries it at [0-9a-f]{10}/, "it discovers the claim");
    assert.match(rb.out, /re-bumped 1\.0\.1 -> 1\.0\.2 \(patch\)/, "and re-bumps at the same level, unaided");
    assert.match(rb.out, /claim\s+v1\.0\.2 is on origin at [0-9a-f]{10}/);

    assert.equal(versionOf(b), "1.0.2", "the branch carries the number the tool printed");
    assert.equal(git(b, ["log", "-1", "--format=%s"]), "chore: 1.0.2 — the version this landing carries");
    assert.equal(git(b, ["rev-parse", "v1.0.2^{commit}"]), git(b, ["rev-parse", "HEAD"]), "the tag peels to the declaring commit");
    assert.doesNotMatch(git(b, ["log", "--format=%s"]), /chore: 1\.0\.1/, "the discarded bump is not in the history");

    const tags = remoteTags(b);
    assert.equal(tags.get("v1.0.1"), aBump, "lane A's claim still names lane A's commit");
    assert.equal(tags.get("v1.0.2"), git(b, ["rev-parse", "HEAD"]), "lane B's claim names lane B's commit");

    // ---- a clone made after both claims reads them and steps past them, instead of refusing ----
    const c = box.clone("lane-c");
    commitFile(c, "c.txt", "c\n", "fix: lane c adds a third thing");
    const rc = tool(c, ["apply", "patch"]);
    assert.equal(rc.code, 0, `${rc.out}${rc.err}`);
    assert.match(rc.out, /skipped\s+v1\.0\.1 is already anchored at [0-9a-f]{10} — taken/);
    assert.match(rc.out, /skipped\s+v1\.0\.2 is already anchored at [0-9a-f]{10} — taken/);
    assert.equal(versionOf(c), "1.0.3");

    // ---- the gate, read from a clone that has fetched the claims: held, not orphaned ----
    git(b, ["fetch", "-q", "--tags"]);
    const gate = spawnSync(process.execPath, [path.join(ROOT, "tools", "verify-version-tags.mjs"), "--ref", "origin/main"], {
      cwd: b, encoding: "utf8", env: { ...GIT_TEST_ENV }, windowsHide: true, timeout: 120000,
    });
    const gateText = `${gate.stdout || ""}${gate.stderr || ""}`;
    assert.equal(gate.status, 0, gateText);
    assert.match(gateText, /2 tags name a version origin\/main does not carry yet/, "both claims are held on branches");
    assert.match(gateText, /PASS/);
  } finally {
    box.done();
  }
});

test("a claim lost after the bump was pushed is refused, not rewritten", () => {
  const box = sandbox();
  try {
    const a = box.clone("lane-a");
    commitFile(a, "a.txt", "a\n", "feat: lane a adds a thing");
    assert.equal(tool(a, ["apply", "patch"]).code, 0);

    // A lane that bumped by hand at a number taken on the remote, and committed something after it: the bump is
    // not the tip, so rewriting it in place would rewrite history the tool cannot see the end of.
    const d = box.clone("lane-d");
    writeFileSync(path.join(d, "package.json"), pkg("1.0.1"), "utf8");
    git(d, ["add", "-A"]);
    git(d, ["commit", "-q", "-m", "chore: 1.0.1 — the version this landing carries"]);
    commitFile(d, "notes.md", "notes\n", "docs: describe the change");

    const r = tool(d, ["claim"]);
    assert.equal(r.code, 1, `${r.out}${r.err}`);
    assert.match(r.err, /the bump is at [0-9a-f]{10}, but HEAD is [0-9a-f]{10}: only a bump commit at the tip/);
    assert.equal(versionOf(d), "1.0.1", "nothing was rewritten");
    assert.equal(remoteTags(d).get("v1.0.1"), git(a, ["rev-parse", "HEAD"]), "the claim on the remote is still lane A's");
  } finally {
    box.done();
  }
});

test("a render spends no number, so there is nothing to claim", () => {
  const box = sandbox();
  try {
    const d = box.clone("render");
    commitFile(d, "CHANGELOG.md", "# Changes\n\n## v1.0.0\n\n- feat: the first release\n", "docs: render the changelog");
    const r = tool(d, ["claim"]);
    assert.equal(r.code, 0, `${r.out}${r.err}`);
    assert.match(r.out, /nothing to claim — this branch declares 1\.0\.0 and origin\/main carries 1\.0\.0/);
    assert.equal(remoteTags(d).has("v1.0.0"), false, "no tag was pushed for a render");
  } finally {
    box.done();
  }
});

test("the post-merge move fetches, moves the claim and pushes it in one command", () => {
  const box = sandbox();
  try {
    const a = box.clone("lane-a");
    git(a, ["checkout", "-q", "-b", "lane-a"]);
    commitFile(a, "a.txt", "a\n", "feat: lane a adds a thing");
    assert.equal(tool(a, ["apply", "patch"]).code, 0);
    const branchBump = git(a, ["rev-parse", "HEAD"]);
    git(a, ["push", "-q", "origin", "lane-a"]);

    // What `gh pr merge --rebase` does: the same patch on main, a new sha the branch's tag cannot name.
    const { seed } = box;
    git(seed, ["fetch", "-q", "origin", "--tags"]);
    git(seed, ["cherry-pick", branchBump]);
    git(seed, ["push", "-q", "origin", "main"]);
    const onMain = git(seed, ["rev-parse", "HEAD"]);
    assert.notEqual(onMain, branchBump);

    const r = tool(seed, ["tag", "--ref", "origin/main", "--force", "--fetch", "--push"]);
    assert.equal(r.code, 0, `${r.out}${r.err}`);
    assert.match(r.out, /moved from [0-9a-f]{10}/);
    assert.match(r.out, /pushed\s+v1\.0\.1 to origin \(forced: the claim moved\)/);
    assert.equal(remoteTags(seed).get("v1.0.1"), onMain, "the claim now names the commit main carries");
  } finally {
    box.done();
  }
});
