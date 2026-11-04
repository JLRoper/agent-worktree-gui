// The version bump anchors itself: apply tags the commit it makes, and the backfill repairs history once.
//
// WHY: tools/version.mjs wrote the number and stopped, so every bump was a tag somebody had to remember — and
// eight of them (0.86.0 .. 0.92.0) were forgotten until `npm run verify:version-tags` went red on main. The gate
// was right and the tool was incomplete: advice, gate and write, with nothing that anchors. These cases drive
// the real tool in a throwaway repository, because the thing being pinned is git's own behaviour — that the tag
// is annotated, that it names the commit that carries the number, that a dirty tree gets neither commit nor tag,
// and that a second backfill creates nothing rather than duplicating or failing.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { GIT_TEST_ENV, ROOT, git } from "../tools/panel-testkit.mjs";

const VERSION = path.join(ROOT, "tools", "version.mjs");
const GATE = path.join(ROOT, "tools", "verify-version-tags.mjs");

// One tool run, in a throwaway repo, with the identity git needs already supplied by panel-testkit's helper.
function tool(file, args, cwd) {
  const r = spawnSync(process.execPath, [file, ...args], {
    cwd, encoding: "utf8", env: GIT_TEST_ENV, windowsHide: true, timeout: 120000,
  });
  return { code: r.status, out: r.stdout || "", err: r.stderr || "" };
}

const pkg = (version) => `{\n  "name": "fixture",\n  "version": "${version}"\n}\n`;

// A repository whose package.json history declares exactly these versions, one commit each, oldest first. No
// tags: that is the state main was in.
async function fixture(t, versions) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wtgui-version-tags-"));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  git(dir, ["init", "-b", "main"]);
  const shas = [];
  for (const version of versions) {
    await writeFile(path.join(dir, "package.json"), pkg(version));
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-m", `chore: ${version}`]);
    shas.push(git(dir, ["rev-parse", "HEAD"]));
  }
  return { dir, shas };
}

const tags = (dir) =>
  git(dir, ["for-each-ref", "--format=%(refname:short)%09%(objecttype)%09%(*objectname)", "refs/tags"])
    .split("\n").filter(Boolean).map((line) => {
      const [name, type, commit] = line.split("\t");
      return { name, type, commit };
    });

test("apply commits the bump and anchors that commit with an annotated tag", async (t) => {
  const { dir, shas } = await fixture(t, ["0.1.0"]);
  const r = tool(VERSION, ["apply", "minor"], dir);
  assert.equal(r.code, 0, r.err);
  assert.equal(JSON.parse(await readFile(path.join(dir, "package.json"), "utf8")).version, "0.2.0", "the number moved");

  const head = git(dir, ["rev-parse", "HEAD"]);
  assert.notEqual(head, shas[0], "the bump is a commit of its own");
  assert.equal(git(dir, ["log", "-1", "--format=%s"]), "chore: 0.2.0 — the version this landing carries");

  const [tag] = tags(dir);
  assert.equal(tag.name, "v0.2.0");
  assert.equal(tag.type, "tag", "annotated: a lightweight tag carries no message and the gate rejects it");
  assert.equal(tag.commit, head, "the tag names the commit that carries the bump, not an earlier one");
  assert.match(git(dir, ["cat-file", "-p", "v0.2.0"]), /package\.json first carried 0\.2\.0 at [0-9a-f]{10}/, "the message records where the number appeared");
  assert.equal(git(dir, ["status", "--porcelain"]), "", "the run leaves nothing uncommitted");
});

test("apply writes the number but neither commits nor tags a dirty tree, and says which", async (t) => {
  const { dir, shas } = await fixture(t, ["0.1.0"]);
  await writeFile(path.join(dir, "notes.txt"), "work in progress\n");

  const r = tool(VERSION, ["apply", "patch"], dir);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /0\.1\.0 -> 0\.1\.1/, "the number is still written: the bump is the agent's declaration");
  assert.match(r.out, /no commit and no tag/, "and it says plainly that neither happened");
  assert.match(r.out, /notes\.txt/, "naming the change that blocked the commit");

  assert.equal(git(dir, ["rev-parse", "HEAD"]), shas[0], "HEAD did not move");
  assert.deepEqual(tags(dir), [], "no tag was created against a tree that carries somebody else's work");
});

test("tag refuses a dirty tree and creates nothing", async (t) => {
  const { dir } = await fixture(t, ["0.1.0"]);
  await writeFile(path.join(dir, "notes.txt"), "work in progress\n");

  const r = tool(VERSION, ["tag"], dir);
  assert.equal(r.code, 1);
  assert.match(r.err, /refused — the tree is dirty/);
  assert.deepEqual(tags(dir), []);
});

test("tag anchors a bump committed by hand, and a second run changes nothing", async (t) => {
  const { dir } = await fixture(t, ["0.1.0"]);
  await writeFile(path.join(dir, "package.json"), pkg("0.2.0"));
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-m", "chore: 0.2.0"]);

  const first = tool(VERSION, ["tag"], dir);
  assert.equal(first.code, 0, first.err);
  const anchored = tags(dir);
  assert.deepEqual(anchored.map((x) => [x.name, x.type, x.commit]), [["v0.2.0", "tag", git(dir, ["rev-parse", "HEAD"])]]);

  const again = tool(VERSION, ["tag"], dir);
  assert.equal(again.code, 0, "an already-anchored commit is not a failure");
  assert.match(again.out, /already an annotated tag/);
  assert.deepEqual(tags(dir), anchored, "no duplicate, nothing moved");
});

test("tag --force moves the anchor onto the commit a rebase merge re-created", async (t) => {
  const { dir } = await fixture(t, ["0.1.0", "0.2.0"]);
  assert.equal(tool(VERSION, ["tag"], dir).code, 0, "anchor the branch's own commit first");
  const before = git(dir, ["rev-parse", "v0.2.0^{commit}"]);

  // What `gh pr merge --rebase` does to the branch: the same tree, a new sha.
  git(dir, ["commit", "--amend", "-m", "chore: 0.2.0 — the version this landing carries"]);
  const onMain = git(dir, ["rev-parse", "HEAD"]);
  assert.notEqual(onMain, before);

  const refused = tool(VERSION, ["tag"], dir);
  assert.equal(refused.code, 1, "a tag that already names another commit is not moved silently");
  assert.match(refused.err, /already exists at [0-9a-f]{10}.*--force/);

  const forced = tool(VERSION, ["tag", "--force"], dir);
  assert.equal(forced.code, 0, forced.err);
  assert.equal(git(dir, ["rev-parse", "v0.2.0^{commit}"]), onMain, "the anchor follows the commit main carries");
});

test("backfill anchors every version once, and a second run creates nothing and does not fail", async (t) => {
  const { dir, shas } = await fixture(t, ["0.1.0", "0.2.0", "0.3.0"]);

  const first = tool(VERSION, ["backfill"], dir);
  assert.equal(first.code, 0, first.err);
  assert.match(first.out, /0 already anchored, 3 tagged now/);

  const anchored = tags(dir);
  assert.deepEqual(anchored.map((x) => x.name), ["v0.1.0", "v0.2.0", "v0.3.0"]);
  for (const [i, tag] of anchored.entries()) {
    assert.equal(tag.type, "tag", `${tag.name} is annotated`);
    assert.equal(tag.commit, shas[i], `${tag.name} names the commit that first declared it`);
  }

  const second = tool(VERSION, ["backfill"], dir);
  assert.equal(second.code, 0, "the second run must not fail");
  assert.match(second.out, /3 already anchored, 0 tagged now/);
  assert.deepEqual(tags(dir), anchored, "no duplicate and no moved tag");

  const gate = tool(GATE, [], dir);
  assert.equal(gate.code, 0, `${gate.out}${gate.err}`);
  assert.match(gate.out, /PASS/, "the gate the backfill exists to satisfy reads PASS on the fixture");
});

// The shape that mis-anchored v1.5.0: the changelog render lands on top of the bump, so the ref's tip reads the
// bumped number while its diff touches only CHANGELOG.md. Reading the version out of the tip's tree and tagging
// the tip is what this case pins against; the anchor has to be the commit whose patch carried the number.
test("tag --ref anchors the bump under a render commit, not the render tip", async (t) => {
  const { dir, shas } = await fixture(t, ["0.1.0", "0.2.0"]);
  // main's earlier bump is already anchored, so the only finding this case can produce is v0.2.0's anchor.
  git(dir, ["tag", "-a", "v0.1.0", shas[0], "-m", "v0.1.0"]);
  await writeFile(path.join(dir, "CHANGELOG.md"), "# Changes\n\n## v0.2.0\n\n- feat: a thing\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-m", "docs: render the 0.2.0 section at the rebased tip"]);
  const tip = git(dir, ["rev-parse", "HEAD"]);

  const r = tool(VERSION, ["tag", "--ref", "main"], dir);
  assert.equal(r.code, 0, r.err);
  assert.equal(git(dir, ["rev-parse", "v0.2.0^{commit}"]), shas[1], "the anchor is the commit that declared 0.2.0");
  assert.notEqual(git(dir, ["rev-parse", "v0.2.0^{commit}"]), tip, "and not the render commit the ref resolves to");
  assert.match(r.out, /not main's tip/, "the run says it walked past the tip instead of tagging it");
  assert.match(git(dir, ["cat-file", "-p", "v0.2.0"]), /package\.json first carried 0\.2\.0 at [0-9a-f]{10}/);

  const gate = tool(GATE, [], dir);
  assert.equal(gate.code, 0, `${gate.out}${gate.err}`);
  assert.match(gate.out, /PASS/, "the gate accepts the anchor the fixed tool chose");
});

// The other half: a number the ref's tree carries but no reachable commit's patch writes. A merge resolution is
// the honest shape — `git log -p` prints no diff for a merge commit unless asked — and falling back to the tip
// there would invent an anchor the gate cannot accept. The run must refuse and name what it looked for.
test("tag refuses loudly when no reachable commit declares the ref's version", async (t) => {
  const { dir } = await fixture(t, ["0.1.0"]);
  git(dir, ["checkout", "-b", "side"]);
  await writeFile(path.join(dir, "notes.txt"), "a side note\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-m", "docs: a side note"]);
  git(dir, ["checkout", "main"]);
  await writeFile(path.join(dir, "package.json"), pkg("0.2.0"));
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-m", "chore: 0.2.0"]);
  git(dir, ["merge", "--no-commit", "--no-ff", "side"]);
  await writeFile(path.join(dir, "package.json"), pkg("0.9.0"));
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-m", "merge side"]);

  const r = tool(VERSION, ["tag"], dir);
  assert.equal(r.code, 1, "0.9.0 has no declaring commit, so there is no honest anchor");
  assert.match(r.err, /refused — no commit reachable from HEAD \([0-9a-f]{8}\) first carries 0\.9\.0/);
  assert.match(r.err, /looked for: the commit whose package\.json patch first writes "version": "0\.9\.0"/);
  assert.match(r.err, /2 bumps seen there: v0\.1\.0 \.\. v0\.2\.0/, "it names the history it found instead");
  assert.deepEqual(tags(dir), [], "nothing was tagged");
});
