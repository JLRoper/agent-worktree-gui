#!/usr/bin/env node
// tools/version.mjs — advice, gate and the write, for the panel's one version number.
//
// WHY: the version is declared once, in package.json's "version"; the annotated tag and the changelog are anchors
// derived from that one number, never a second place to edit. What is NOT mechanical is deciding whether a change
// is a patch, a minor or a major: that is a judgement about who outside the PR the change can break, and it
// belongs to the agent landing the change, in the same PR as the change. This tool exists so that judgement is
// cheap to state and impossible to forget — it does not make the judgement.
//
//   suggest            read the branch's commits against its base (and the PR's title and body, when gh has
//                      them) and print a level with the reason for each commit. ADVISORY: writes nothing.
//   check              the landing gate. It compares the number this branch would push (HEAD's package.json)
//                      with the number at the base ref's CURRENT tip (origin/main's tree — never the merge-base,
//                      never this checkout's own file) and refuses unless the branch is strictly above it.
//                      "Behind" is a refusal too: a branch cut before main moved carries main's old number, and
//                      that is not a bump. It prints what it compared — branch version, base ref, base version —
//                      on BOTH outcomes, so silence can never be read as either. Exit 0 only when the branch's
//                      number is above the base's, or when the branch adds no commits and its number equals the
//                      base's (main itself: nothing to land, nothing to bump). The pre-push hook calls it.
//                      It never writes.
//   apply <level>      write the new version to package.json (the one place it lives), commit that write as the
//                      bump, anchor the commit with an annotated v<version> tag, and CLAIM the number by pushing
//                      that tag to origin. Run by the landing agent, deliberately; never by check and never by a
//                      hook. The number is computed above the higher of the branch and the base, so a branch cut
//                      before main moved still bumps above main. In a tree that already carries other changes it
//                      writes the number and stops — no commit, no tag, no claim — because a tag belongs to a
//                      commit that carries the bump and nothing else; it says which of the two happened.
//                      --no-claim writes and tags without reaching the network; `claim` is then the step.
//   claim [--level <l>]  give this branch's number its claim: push refs/tags/v<version> to origin. git refuses
//                      to create a ref that already exists, atomically, for every lane and every machine, so a
//                      rejected push means the number is taken. The tool then re-derives the next free number at
//                      the same level, rewrites the bump commit, re-tags it and pushes again — the losing lane
//                      re-bumps unaided. Prints the claim, the number it had to move past, and the commit the tag
//                      peels to. Exit 0 when the number is claimed (or already carried by this commit), when the
//                      branch declares no number above the base (a render spends no number), or when the tree is
//                      not the one to rewrite; exit 1 when a claim was needed and could not be made.
//   tag                anchor the commit whose package.json patch FIRST declared the version the ref's tree
//                      carries — not the ref's tip. A changelog render commit on top of a bump still reads the
//                      bumped number, and tagging the tip names a commit whose diff touches only
//                      CHANGELOG.md; v1.5.0 was anchored that way on 5234a3c and the gate refused it. The
//                      declaration comes from the same walk the gate reads (tools/release-history.mjs), and
//                      when no commit reachable from the ref writes the number it refuses and says what it
//                      looked for. This is the post-merge step: a rebase merge re-creates the commit, so the
//                      tag is moved onto the one main carries (node tools/version.mjs tag --ref origin/main
//                      --force). Refuses a dirty tree when the declaring commit is HEAD, and refuses to move
//                      an existing tag without --force.
//   backfill           create the annotated tag for every version in package.json's history that has none, at
//                      the commit that first declared it. Idempotent: an anchored version is skipped, never
//                      duplicated, and a second run creates nothing and exits 0. --push sends only the tags
//                      this run created.
//
// The scale these read is docs/versioning.md. The base ref is --base when given, otherwise $VERSION_BASE,
// otherwise the remotes' own HEAD (github/main, origin/main, ...), otherwise main, otherwise master. The base's
// version is read out of THAT ref's tree, and the branch's out of HEAD — the two commits a push compares. The
// repository is the one the current directory is in (`git rev-parse --show-toplevel`), so the tool works from a
// worktree.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { findDeclaration, readReleaseHistory } from "./release-history.mjs";

const LEVELS = ["patch", "minor", "major"];
const RANK = { patch: 0, minor: 1, major: 2 };
const DOC = "docs/versioning.md";

// ---------- git, quietly ----------

function gitOk(args) {
  try {
    return execFileSync("git", args, {
      cwd: process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 15000,
    }).trim();
  } catch {
    return null;
  }
}

const ROOT = gitOk(["rev-parse", "--show-toplevel"]) || process.cwd();
const PKG = path.join(ROOT, "package.json");

// The conventional-commit prefixes the scale reads. Anything else is reported as unclassified rather than
// folded silently into patch: a subject nobody can classify is a diff somebody has to read.
const TYPES = {
  feat: "minor",
  fix: "patch", docs: "patch", doc: "patch", test: "patch", tests: "patch", chore: "patch",
  refactor: "patch", perf: "patch", style: "patch", build: "patch", ci: "patch", revert: "patch",
};

// ---------- the base ref ----------

function baseCandidates() {
  const out = [];
  const env = (process.env.VERSION_BASE || "").trim();
  if (env) out.push(env);
  // A remote's own HEAD first (github/main), then any other remote-tracking main/master, then the local
  // branches — the remote-tracking ref is what "the base everyone else's work sits on" actually means here.
  const sym = gitOk(["for-each-ref", "--format=%(refname:short)%09%(symref)", "refs/remotes/"]) || "";
  for (const line of sym.split("\n")) {
    const [name, target] = line.split("\t");
    if (name && target) out.push(target.replace(/^refs\/remotes\//, ""));
  }
  const remotes = (gitOk(["for-each-ref", "--format=%(refname:short)", "refs/remotes/"]) || "")
    .split("\n").filter(Boolean).filter((n) => !n.endsWith("/HEAD"));
  const rank = (n) => (n.endsWith("/main") ? 0 : n.endsWith("/master") ? 1 : 2);
  remotes.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  out.push(...remotes, "main", "master");
  return out;
}

function resolveBase() {
  const tried = [];
  for (const c of baseCandidates()) {
    if (!c || tried.includes(c)) continue;
    tried.push(c);
    if (gitOk(["rev-parse", "--verify", "--quiet", `${c}^{commit}`])) return { ref: c, tried };
  }
  return { ref: null, tried };
}

// The commits this branch adds on top of the base, tip first — the same set `git log --oneline <base>..HEAD`
// shows a reader.
function branchCommits(base) {
  if (!base) return [];
  const raw = gitOk(["log", "--format=%H%x1f%s%x1f%b%x1e", `${base}..HEAD`]);
  if (!raw) return [];
  return raw.split("\x1e").map((r) => r.replace(/^\n+/, "")).filter((r) => r.trim()).map((r) => {
    const [sha = "", subject = "", body = ""] = r.split("\x1f");
    return { sha: sha.trim(), subject: subject.trim(), body };
  });
}

// ---------- the scale, as the tool can read it ----------

function classify(subject, body) {
  const s = String(subject || "");
  const breaking = /^BREAKING[ -]CHANGE:/m.test(String(body || ""));
  const m = s.match(/^([A-Za-z][A-Za-z0-9_-]*)(\([^)]*\))?(!)?:[ \t]+(\S.*)$/);
  if (!m) {
    if (breaking) return { level: "major", why: "a BREAKING CHANGE: line in the body (the subject carries no prefix)" };
    return { level: null, why: "no conventional-commit prefix (feat:, fix:, docs:, ...) — nothing here says which level it is" };
  }
  const type = m[1].toLowerCase();
  if (m[3]) return { level: "major", why: `${type}! declares a breaking change` };
  if (breaking) return { level: "major", why: `${type}: with a BREAKING CHANGE: line in the body` };
  const level = TYPES[type];
  if (!level) return { level: null, why: `${type}: is not a prefix this scale reads (feat/fix/docs/test/chore/...)` };
  return {
    level,
    why: level === "minor" ? `${type}: is a new capability that breaks nothing` : `${type}: is a fix, a doc, a refactor or a test-only change`,
  };
}

function overall(list) {
  let level = null;
  let unknown = 0;
  for (const c of list) {
    if (c.level) {
      if (level === null || RANK[c.level] > RANK[level]) level = c.level;
    } else unknown += 1;
  }
  return { level, unknown };
}

// The PR's own title and body, when gh has a PR for this branch. Best effort: no gh, no PR, no network or no
// auth is a note in the output, never a failure, and never something check waits on.
function readPr() {
  if (process.env.VERSION_NO_GH === "1") return { pr: null, note: "VERSION_NO_GH=1 is set" };
  try {
    const out = execFileSync("gh", ["pr", "view", "--json", "number,title,body"], {
      cwd: process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 8000,
    });
    const j = JSON.parse(out);
    if (!j || !j.title) return { pr: null, note: "no PR for this branch" };
    return { pr: { number: j.number, title: String(j.title), body: String(j.body || "") }, note: null };
  } catch {
    return { pr: null, note: "no gh, or no PR for this branch" };
  }
}

// ---------- versions on disk and at the base ----------

function versionIn(text) {
  try {
    const v = JSON.parse(text).version;
    return v == null ? null : String(v).trim() || null;
  } catch {
    return null;
  }
}

function readWorking() {
  try {
    return readFileSync(PKG, "utf8");
  } catch {
    return null;
  }
}

function versionAt(ref) {
  if (!ref) return null;
  const text = gitOk(["show", `${ref}:package.json`]);
  return text === null ? null : versionIn(text);
}

// The number a push would carry: HEAD's file, not the working tree's. An uncommitted bump is not in the push, and
// a gate that read the file on disk would pass a branch whose pushed number never moved.
function versionAtHead() {
  const text = gitOk(["show", "HEAD:package.json"]);
  return text === null ? null : versionIn(text);
}

// Versions as numbers, so "behind" is a comparison rather than an inequality: the old check treated every value
// that was not equal as a bump, which is how 0.84.0 passed against main's 0.87.0.
function semver(v) {
  const m = String(v == null ? "" : v).trim().match(/^(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function compareVersions(a, b) {
  const x = semver(a);
  const y = semver(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
  return 0;
}

function nextVersion(current, level) {
  const m = String(current || "").match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!m) return null;
  const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (level === "major") return `${major + 1}.0.0`;
  if (level === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

// ---------- the tree, and the one commit a tag may name ----------

// Every change the working tree carries, as `git status --porcelain` prints it (staged, unstaged, untracked).
// Read BEFORE apply writes the number, so package.json's own new line is never counted as somebody else's dirt.
function dirtyFiles() {
  const raw = gitOk(["status", "--porcelain"]);
  return raw === null ? [] : raw.split("\n").map((line) => line.trim()).filter(Boolean);
}

// A tag in one read. `%(objecttype)` is "tag" for an annotated tag, and `%(*objectname)` peels it to the commit
// it names — for an annotated tag `%(objectname)` is the tag object's own sha, so comparing that with a commit
// would misreport every good tag as being at the wrong place.
function tagAt(name) {
  const line = gitOk(["for-each-ref", "--format=%(objecttype)%09%(objectname)%09%(*objectname)", `refs/tags/${name}`]);
  if (line === null || !line.trim()) return null;
  const [type, object, peeled] = line.split("\t");
  return { name, annotated: type === "tag", object, commit: type === "tag" ? peeled : object };
}

function commitSubject(commit) {
  return gitOk(["log", "-1", "--format=%s", commit]) || "";
}

// The reads above are silent by design (a gate makes them on every push); the WRITES report git's own stderr,
// because a refusal is the whole answer and swallowing it leaves an agent guessing.
function gitRun(args) {
  try {
    const out = execFileSync("git", args, {
      cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60000,
    });
    return { ok: true, out: out.trim(), err: "" };
  } catch (e) {
    return { ok: false, out: String(e.stdout || "").trim(), err: String(e.stderr || e.message || "").trim() };
  }
}

// One annotated tag, carrying the two lines every tag in this repo carries: the number, and where it first
// appeared. A lightweight tag is not a substitute — it has no message, so a clone cannot say what it meant.
function createTag(version, commit, { force = false } = {}) {
  return gitRun([
    "tag", ...(force ? ["-f"] : []), "-a", `v${version}`, commit,
    "-m", `v${version}`,
    "-m", `package.json first carried ${version} at ${commit.slice(0, 10)} (${commitSubject(commit)})`,
  ]);
}

// Publish the claim. A tag that only exists in this clone reserves nothing: `git push origin refs/tags/v<v>` is
// what every other lane reads, and `--force` is the post-merge move of a claim this landing already owns.
function pushTag(version, { remote = "origin", force = false } = {}) {
  return gitRun(["push", ...(force ? ["--force"] : []), remote, `refs/tags/v${version}`]);
}

// ---------- the claim: a number is taken by pushing its tag ----------
//
// The number is chosen on a branch and consumed on main minutes later, and the only thing every lane and every
// machine can see is the remote. `git push origin refs/tags/v<next>` either creates the ref or fails because it
// already exists, and git decides that atomically — so the annotated tag that anchors the bump is also the
// reservation, and a refused push is the signal to take the next number above it. The options are costed in
// docs/research/version-integrity/parallel-lanes-and-one-version.md; this is option B, the reader's choice.

function maxVersion(a, b) {
  if (a == null) return b == null ? null : b;
  if (b == null) return a;
  const order = compareVersions(a, b);
  if (order === null) return a;
  return order >= 0 ? a : b;
}

// Every v<major>.<minor>.<patch> tag the remote carries, peeled to the commit it names. One `git ls-remote` for
// the whole set: an annotated tag prints twice — the tag object and `<name>^{}` — and the peeled line is the
// commit a reader follows. The remote, not this clone's tag list, is what "taken" means.
function remoteTagMap(remote) {
  const r = gitRun(["ls-remote", "--tags", remote]);
  if (!r.ok) return { ok: false, err: r.err || r.out || "git ls-remote failed" };
  const tags = new Map();
  for (const line of r.out.split("\n")) {
    const [sha, ref] = line.split("\t");
    if (!sha || !ref) continue;
    const m = /^refs\/tags\/(v\d+\.\d+\.\d+)(\^\{\})?$/.exec(ref);
    if (!m) continue;
    const version = m[1].slice(1);
    if (m[2]) tags.set(version, { commit: sha, annotated: true });
    else if (!tags.has(version)) tags.set(version, { commit: sha, annotated: false });
  }
  return { ok: true, tags };
}

function hasRemote(remote) {
  return gitRun(["remote", "get-url", remote]).ok;
}

// The level a lost claim re-bumps at when the caller did not state one: the shape of the jump the branch had
// already made above its base. A minor over the base is a minor; anything else is a patch.
function inferLevel(version, baseVersion) {
  const a = semver(version);
  const b = semver(baseVersion);
  if (!a || !b) return "patch";
  if (a[0] !== b[0]) return "major";
  if (a[1] !== b[1]) return "minor";
  return "patch";
}

// Rewrite the bump commit so it declares `candidate` instead of `declared`, and re-anchor its tag. Only the
// commit that carries the bump, only while it is the tip, and only while it is unpublished: a claim lost after
// the branch was pushed is a rebase the landing agent makes, not history this tool rewrites underneath it.
function rebumpAbove({ declared, level, declSha, occupied, baseVersion }) {
  const head = gitOk(["rev-parse", "HEAD"]);
  if (head !== declSha) {
    return { ok: false, error:
      `the bump is at ${String(declSha).slice(0, 10)}, but HEAD is ${String(head).slice(0, 10)}: only a bump commit at ` +
      "the tip can be rewritten in place. Move it to the tip, then run claim again — nothing was changed." };
  }
  const up = gitRun(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  if (up.ok && up.out && gitRun(["merge-base", "--is-ancestor", declSha, up.out]).ok) {
    return { ok: false, error:
      `the bump commit ${declSha.slice(0, 10)} is already on ${up.out}, so rewriting it would rewrite published ` +
      `history. Land the branch as it is and let the merge re-create the commit, or bump on a fresh commit ` +
      `(node tools/version.mjs apply ${level}) — nothing was changed.` };
  }
  const dirty = dirtyFiles();
  if (dirty.length) {
    return { ok: false, error:
      `the tree carries ${dirty.length} other change${dirty.length === 1 ? "" : "s"}, so a rewritten bump commit ` +
      "would carry somebody else's work — nothing was changed" };
  }
  let candidate = nextVersion(declared, level);
  let guard = 0;
  while (candidate && guard < 64) {
    const claimed = occupied.has(candidate);
    const belowBase = baseVersion != null && compareVersions(candidate, baseVersion) <= 0;
    if (!claimed && !belowBase) break;
    candidate = nextVersion(candidate, level);
    guard += 1;
  }
  if (!candidate) return { ok: false, error: `could not derive a free number above ${declared} at ${level}` };

  const text = readWorking();
  if (text === null) return { ok: false, error: `no package.json at ${PKG} — nothing was changed` };
  let wrote = false;
  const out = text.replace(/^([ \t]*"version"[ \t]*:[ \t]*")[^"]*(")/m, (_m, a, b) => {
    wrote = true;
    return a + candidate + b;
  });
  if (!wrote) return { ok: false, error: "could not find a top-level \"version\" line to write — nothing was changed" };
  writeFileSync(PKG, out);
  const added = gitRun(["add", "--", "package.json"]);
  if (!added.ok) return { ok: false, error: `the number is written but git add refused — ${added.err}` };
  const body = gitOk(["log", "-1", "--format=%B"]) || "";
  const rest = body.split("\n").slice(1).join("\n").trim();
  const subject = `chore: ${candidate} — the version this landing carries`;
  const amended = gitRun(["commit", "--amend", "-m", subject, ...(rest ? ["-m", rest] : [])]);
  if (!amended.ok) return { ok: false, error: `the number is written but git commit --amend refused — ${amended.err}` };
  const sha = gitOk(["rev-parse", "HEAD"]) || "";
  if (tagAt(`v${declared}`)) {
    const deleted = gitRun(["tag", "-d", `v${declared}`]);
    if (!deleted.ok) {
      return { ok: false, error: `the bump was rewritten but the old tag v${declared} could not be removed — ${deleted.err}` };
    }
  }
  const made = createTag(candidate, sha);
  if (!made.ok) return { ok: false, error: `the bump was rewritten but v${candidate} was NOT created — ${made.err}` };
  return { ok: true, version: candidate, commit: sha };
}

// One claim, retried until the number is ours or no free number can be found. Every iteration re-reads HEAD
// (a rewrite moves it), the remote's tags (another lane moves them) and the base (a merge moves it), so nothing
// is cached across a rejection.
function claimVersion({ level, remote = "origin", maxAttempts = 12 }) {
  const notes = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const declared = versionAtHead();
    const head = gitOk(["rev-parse", "HEAD"]);
    if (!declared || !head) {
      return { code: 1, notes, error: "HEAD's package.json has no readable \"version\" — nothing to claim" };
    }
    const { ref: baseRef } = resolveBase();
    const baseVersion = baseRef ? versionAt(baseRef) : null;
    const above = baseVersion === null ? 1 : compareVersions(declared, baseVersion);
    if (above === null) {
      return { code: 2, notes, error: `cannot compare ${declared} with ${baseRef}'s ${baseVersion}` };
    }
    if (above <= 0) {
      return { code: 0, notes, nothing: true, version: declared, baseRef, baseVersion };
    }

    let found;
    try {
      found = findDeclaration({ root: ROOT, ref: head, version: declared });
    } catch (e) {
      return { code: 1, notes, error: `could not walk package.json's history at HEAD — ${String(e.stderr || e.message).trim()}` };
    }
    if (!found.declaration) {
      return { code: 1, notes, error:
        `no commit reachable from HEAD first carries ${declared}: a number whose declaring commit cannot be found ` +
        "has no honest anchor, so there is nothing to claim — nothing was changed" };
    }
    const declSha = found.declaration.sha;

    const remoteRead = remoteTagMap(remote);
    if (!remoteRead.ok) {
      return { code: 1, notes, error:
        `could not read ${remote}'s tags, so v${declared} is UNCLAIMED — ${remoteRead.err}. Fix the remote, then run: ` +
        "node tools/version.mjs claim" };
    }
    const holder = remoteRead.tags.get(declared);
    if (holder && holder.commit === declSha) {
      // The remote carries this number at the commit this branch declares it at: the claim is already ours.
      const local = tagAt(`v${declared}`);
      if (!local || local.commit !== declSha) createTag(declared, declSha, { force: Boolean(local) });
      return { code: 0, notes, claimed: { version: declared, commit: declSha, attempts: attempt }, already: true };
    }
    if (holder) {
      const moved = rebumpAbove({ declared, level, declSha, occupied: remoteRead.tags, baseVersion });
      if (!moved.ok) return { code: 1, notes, error: moved.error };
      notes.push(`  claim     v${declared} is taken: ${remote} carries it at ${String(holder.commit).slice(0, 10)}, this branch's declaration is ${declSha.slice(0, 10)}`);
      notes.push(`  re-bumped ${declared} -> ${moved.version} (${level}) — bump commit rewritten, v${moved.version} anchored at ${moved.commit.slice(0, 10)}`);
      continue;
    }

    // Free on the remote: the local tag has to name the declaring commit, and then the push IS the claim.
    const local = tagAt(`v${declared}`);
    if (!local || local.commit !== declSha || !local.annotated) {
      const made = createTag(declared, declSha, { force: Boolean(local) });
      if (!made.ok) return { code: 1, notes, error: `v${declared} could not be created at ${declSha.slice(0, 10)} — ${made.err}` };
      notes.push(`  tag       v${declared} (annotated) at ${declSha.slice(0, 10)}`);
    }
    const pushed = gitRun(["push", remote, `refs/tags/v${declared}`]);
    if (pushed.ok) {
      return { code: 0, notes, claimed: { version: declared, commit: declSha, attempts: attempt } };
    }
    // The push failed. Ask the remote before believing anything: a network failure and a lost race both exit
    // non-zero, and only one of them means "re-bump".
    const after = remoteTagMap(remote);
    const now = after.ok ? after.tags.get(declared) : null;
    if (now && now.commit === declSha) {
      return { code: 0, notes, claimed: { version: declared, commit: declSha, attempts: attempt }, already: true };
    }
    if (now) {
      const moved = rebumpAbove({ declared, level, declSha, occupied: after.tags, baseVersion });
      if (!moved.ok) return { code: 1, notes, error: moved.error };
      notes.push(`  claim     the push lost: ${remote} now carries v${declared} at ${String(now.commit).slice(0, 10)}`);
      notes.push(`  re-bumped ${declared} -> ${moved.version} (${level}) — bump commit rewritten, v${moved.version} anchored at ${moved.commit.slice(0, 10)}`);
      continue;
    }
    return { code: 1, notes, error:
      `git push of refs/tags/v${declared} refused, and ${remote} does not show that tag at another commit — ` +
      `${pushed.err || pushed.out}. Nothing was claimed: fix the push, then run: node tools/version.mjs claim` };
  }
  return { code: 1, notes, error: `gave up after ${maxAttempts} claim${maxAttempts === 1 ? "" : "s"}: every number it tried was taken` };
}

// ---------- the three modes ----------

function modeSuggest() {
  const { ref: base, tried } = resolveBase();
  if (!base) {
    console.log(`version suggest — no base ref found (looked for: ${tried.join(", ")})`);
    console.log("  nothing to compare against; the level is still the landing agent's call. See " + DOC + ".");
    return 0;
  }
  const commits = branchCommits(base);
  console.log(`version suggest — ${commits.length} commit${commits.length === 1 ? "" : "s"} on this branch since ${base}`);
  if (!commits.length) {
    console.log(`  no commits to read. Nothing to bump for. See ${DOC}.`);
    return 0;
  }
  const read = commits.map((c) => ({ ...c, ...classify(c.subject, c.body) }));
  const { pr, note } = readPr();
  if (pr) read.push({ sha: `#${pr.number}`, subject: pr.title, body: pr.body, ...classify(pr.title, pr.body) });

  for (const c of read) {
    const level = c.level || "?";
    const pad = level.padEnd(5);
    const subject = c.subject.length > 64 ? `${c.subject.slice(0, 61)}...` : c.subject;
    console.log(`  ${pad} ${c.sha.slice(0, 8)}  ${subject}`);
    console.log(`        ${" ".repeat(0)}${c.why}`);
  }
  if (pr) console.log(`  (the PR's title and body were read too — PR #${pr.number})`);
  else console.log(`  (the PR's title and body were not read: ${note})`);

  const { level, unknown } = overall(read);
  console.log("");
  if (!level) {
    console.log("suggested level: none — no commit here carries a prefix this scale reads.");
    console.log(`  Read the diff and decide yourself; the scale is ${DOC}. Advice only — nothing was written.`);
    return 0;
  }
  console.log(`suggested level: ${level}`);
  if (unknown) {
    console.log(`  ${unknown} of ${read.length} commit${read.length === 1 ? "" : "s"} could not be classified, so this is a`);
    console.log("  floor from the ones that could: read those before you settle the level.");
  }
  console.log(`  The judgement is the landing agent's, and the bump belongs in this PR. See ${DOC}.`);
  console.log("  Advice only — nothing was written.");
  return 0;
}

function modeCheck(argv) {
  const baseFlag = argv.indexOf("--base");
  const asked = baseFlag >= 0 ? String(argv[baseFlag + 1] || "").trim() : "";
  const { ref: base, tried } = asked
    ? { ref: gitOk(["rev-parse", "--verify", "--quiet", `${asked}^{commit}`]) ? asked : null, tried: [asked] }
    : resolveBase();

  // A gate that cannot say what it measured has not passed anything: this used to print a note and return 0,
  // which is a pass nobody could tell from a real one.
  if (!base) {
    console.error([
      "",
      "version check: refused — nothing was compared",
      "",
      `  no base ref resolved (looked for: ${tried.join(", ")})`,
      "  a gate that cannot name the branch's base cannot pass it. Fetch the remote, or name the ref:",
      "",
      "    node tools/version.mjs check --base origin/main",
      "",
    ].join("\n"));
    return 1;
  }

  const baseSha = gitOk(["rev-parse", "--short", base]) || "?";
  const there = versionAt(base);
  const here = versionAtHead();
  const work = versionIn(readWorking() || "");

  if (here === null) {
    console.error(`version check: refused — HEAD's package.json has no readable "version" (${PKG})`);
    return 1;
  }
  if (there === null) {
    console.error([
      "",
      `version check: refused — ${base} carries no readable package.json "version"`,
      "",
      `  branch  ${here}  (HEAD's package.json)`,
      `  base    ${base}  (${baseSha})  — no package.json "version" in that tree`,
      "",
      "  nothing was compared, so nothing was proven. Fix the base's package.json, or name another ref.",
      "",
    ].join("\n"));
    return 1;
  }

  const commits = branchCommits(base);
  const order = compareVersions(here, there);
  const note = work !== null && work !== here
    ? `  (the working tree's package.json reads ${work}; HEAD is what a push carries, so HEAD was compared — commit it)`
    : null;

  if (order === null) {
    console.error([
      "",
      "version check: refused — a version that cannot be compared",
      "",
      `  branch  ${here}  (HEAD's package.json)`,
      `  base    ${base}  ${there}  (${baseSha})`,
      "",
      "  both sides must be major.minor.patch numbers for \"above the base\" to mean anything.",
      "",
    ].join("\n"));
    return 1;
  }

  // ---- the pass: the branch's number is above the base's, and it says what it compared ----
  if (order > 0) {
    console.log(`version check: ok — the branch's number is above ${base}'s`);
    console.log(`  branch  ${here}  (HEAD's package.json)`);
    console.log(`  base    ${base}  ${there}  (${baseSha})`);
    console.log(`  ${commits.length
      ? `${commits.length} commit${commits.length === 1 ? "" : "s"} to land on top of ${base}`
      : `no commits of its own on top of ${base}`}`);
    if (note) console.log(note);
    return 0;
  }

  // ---- the other pass: main itself, or a branch with nothing on it at the base's number ----
  if (order === 0 && !commits.length) {
    console.log("version check: ok — nothing to land, so nothing to bump");
    console.log(`  branch  ${here}  (HEAD's package.json)`);
    console.log(`  base    ${base}  ${there}  (${baseSha})`);
    console.log(`  this branch adds no commits on top of ${base}; there is no change here for a number to name`);
    if (note) console.log(note);
    return 0;
  }

  // ---- the refusal: unchanged with commits to land, or behind a base that has moved ----
  const behind = order < 0;
  const read = commits.map((c) => ({ ...c, ...classify(c.subject, c.body) }));
  const { level } = overall(read);
  const lines = [
    "",
    behind
      ? `version check: refused — this branch's version is behind ${base}'s`
      : `version check: refused — ${commits.length} commit${commits.length === 1 ? " is" : "s are"} about to land with no version bump`,
    "",
    `  branch  ${here}  (HEAD's package.json)`,
    `  base    ${base}  ${there}  (${baseSha})`,
    ...(note ? [note] : []),
    "",
    ...(read.length
      ? [
        "  commits this branch adds:",
        ...read.map((c) => `    ${c.sha.slice(0, 8)}  ${(c.level || "?").padEnd(5)} ${c.subject.slice(0, 68)}`),
        "",
      ]
      : []),
    level
      ? `  the tool would suggest: ${level}  (advice — the level is the landing agent's judgement)`
      : "  no commit here carries a prefix this scale reads — read the diff and decide the level",
    "",
    ...(behind
      ? [
        `  a branch cut before ${base} moved still carries the number it was cut at, so "unchanged" is not a bump:`,
        `  ${base} already reads ${there}, and landing this branch would carry a number main has passed. Merge or`,
        `  rebase ${base} into this branch, then bump above ${there} in this PR:`,
      ]
      : [
        "  a version that does not move with its change tells a reader nothing moved, and the squash merge puts",
        "  this branch's own subjects into main's history. Fix it in the same PR as the change:",
      ]),
    "",
    `    node tools/version.mjs apply ${level || "patch|minor|major"}`,
    "",
    `  apply writes the number, commits it as its own commit and tags that commit. State the level and the reason`,
    `  in the PR body. The scale is ${DOC}.`,
    "  (git push --no-verify bypasses this check, and a local hook only ever binds its own author.)",
    "",
  ];
  console.error(lines.join("\n"));
  return 1;
}

function modeApply(level, argv = []) {
  const want = String(level || "").toLowerCase();
  if (!LEVELS.includes(want)) {
    console.error(`version apply: needs a level — ${LEVELS.join(" | ")} (got: ${level === undefined ? "nothing" : JSON.stringify(level)})`);
    return 2;
  }
  let claim = true;
  let remote = "origin";
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--no-claim") claim = false;
    else if (a === "--remote") remote = String(argv[(i += 1)] || "origin");
    else {
      console.error(`version apply: unknown argument: ${a}`);
      return 2;
    }
  }
  const text = readWorking();
  if (text === null) {
    console.error(`version apply: no package.json at ${PKG}`);
    return 2;
  }
  const old = versionIn(text);
  if (old === null) {
    console.error(`version apply: package.json's "version" is missing or not readable — refusing to guess`);
    return 2;
  }
  // The number is taken above the BASE as well as above this branch: a branch cut before main moved still
  // carries main's old number, and bumping from that stale value writes a number main has already passed.
  const { ref: baseRef } = resolveBase();
  const baseVersion = baseRef ? versionAt(baseRef) : null;
  const floor = maxVersion(old, baseVersion);
  // A number this clone already anchors is not free: a lane that has fetched another lane's claim carries its
  // tag, and stepping past it here is cheaper than writing the number and losing the claim a moment later. The
  // remote is the authority either way — the push is what decides — so nothing here stands in for the claim.
  let next = nextVersion(floor, want);
  const skipped = [];
  for (let guard = 0; next && guard < 64; guard += 1) {
    const local = tagAt(`v${next}`);
    if (!local) break;
    skipped.push({ version: next, at: local.commit });
    next = nextVersion(next, want);
  }
  if (!next) {
    console.error(`version apply: "${floor}" is not a major.minor.patch version I can bump`);
    return 2;
  }
  // Dirtiness is read BEFORE the write: package.json is about to be the only change the bump commit may carry,
  // so anything already here is somebody else's work and does not belong under a version number.
  const dirty = dirtyFiles();
  // Replace the value in place, on its own line, rather than re-serialising the file: a JSON round-trip would
  // reformat every key and end the file's CRLF lines differently, which is a diff nobody asked for.
  let wrote = false;
  const out = text.replace(/^([ \t]*"version"[ \t]*:[ \t]*")[^"]*(")/m, (_m, a, b) => {
    wrote = true;
    return a + next + b;
  });
  if (!wrote) {
    console.error("version apply: could not find a top-level \"version\" line to write — nothing changed");
    return 2;
  }
  writeFileSync(PKG, out);
  console.log(`version apply: ${want}`);
  console.log(`  package.json  ${old} -> ${next}`);
  if (baseVersion && compareVersions(baseVersion, old) > 0) {
    console.log(`  base          ${baseRef} reads ${baseVersion}, so the number was taken above the base, not above this branch`);
  }
  for (const s of skipped) {
    console.log(`  skipped       v${s.version} is already anchored at ${String(s.at).slice(0, 10)} — taken, so this branch takes ${next}`);
  }
  if (dirty.length) {
    console.log(
      `  no commit and no tag: the tree carried ${dirty.length} other change${dirty.length === 1 ? "" : "s"} ` +
        "before the bump, and a tag belongs to a commit that carries the bump and nothing else:",
    );
    for (const line of dirty.slice(0, 8)) console.log(`    ${line}`);
    if (dirty.length > 8) console.log(`    … and ${dirty.length - 8} more`);
    console.log("  the number is written but UNCLAIMED; commit the change, then anchor and claim it:");
    console.log("    node tools/version.mjs tag && node tools/version.mjs claim");
    return 0;
  }
  const subject = `chore: ${next} — the version this landing carries`;
  const added = gitRun(["add", "--", "package.json"]);
  if (!added.ok) {
    console.error(`version apply: the number is written but git add refused — ${added.err}`);
    return 1;
  }
  const committed = gitRun(["commit", "-m", subject, "--", "package.json"]);
  if (!committed.ok) {
    console.error(`version apply: the number is written but git commit refused — ${committed.err}`);
    return 1;
  }
  const sha = gitOk(["rev-parse", "HEAD"]) || "";
  console.log(`  commit  ${sha.slice(0, 10)}  ${subject}`);
  const tagged = createTag(next, sha);
  if (!tagged.ok) {
    console.error(`  tag     v${next} was NOT created — ${tagged.err}`);
    console.error("  the commit carries the bump; anchor it with: node tools/version.mjs tag");
    return 1;
  }
  console.log(`  tag     v${next} (annotated) at ${sha.slice(0, 10)}`);
  console.log("  the board's config line reads this at its next start (server.js reads package.json once, at boot).");

  // The claim. A number nothing on the remote carries is a number the next lane will choose too; the push is
  // what makes it ours, and a refused push is the one signal that costs a re-bump now instead of a red tip later.
  if (!claim) {
    console.log("  claim     skipped (--no-claim): the number is not reserved until its tag is pushed — run");
    console.log("    node tools/version.mjs claim");
  } else if (!hasRemote(remote)) {
    console.log(`  claim     skipped: no remote named ${remote} — the number stays unclaimed until one exists`);
  } else {
    const claimed = claimVersion({ level: want, remote });
    for (const line of claimed.notes) console.log(line);
    if (claimed.code !== 0) {
      console.error(`  claim     FAILED — ${claimed.error}`);
      console.error("  the bump commit and its tag are local only: nothing on the remote reserves this number.");
      return 1;
    }
    if (claimed.claimed) {
      console.log(`  claim     v${claimed.claimed.version} is on ${remote} at ${claimed.claimed.commit.slice(0, 10)} — the number is taken by its tag`);
    }
    console.log("  a rebase merge re-creates this commit — after the merge, move the claim onto the commit main carries:");
    console.log("    node tools/version.mjs tag --ref origin/main --force --fetch --push");
  }
  return 0;
}

// The claim on its own: for a bump committed by hand (the dirty-tree path), or for a lane that wrote its number
// with --no-claim while offline. `apply` runs the same loop; this is the second door, not a second rule.
function modeClaim(argv) {
  let level = null;
  let remote = "origin";
  let maxAttempts = 12;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--level") level = String(argv[(i += 1)] || "").toLowerCase();
    else if (a === "--remote") remote = String(argv[(i += 1)] || "origin");
    else if (a === "--max") maxAttempts = Math.max(1, Number(argv[(i += 1)]) || 12);
    else {
      console.error(`version claim: unknown argument: ${a}`);
      return 2;
    }
  }
  if (level !== null && !LEVELS.includes(level)) {
    console.error(`version claim: --level must be ${LEVELS.join(" | ")} (got: ${JSON.stringify(level)})`);
    return 2;
  }
  if (!hasRemote(remote)) {
    console.error(`version claim: no remote named ${remote} — there is nothing to claim against`);
    return 2;
  }
  const declared = versionAtHead();
  const { ref: baseRef } = resolveBase();
  const baseVersion = baseRef ? versionAt(baseRef) : null;
  const effective = level || inferLevel(declared, baseVersion);
  const result = claimVersion({ level: effective, remote, maxAttempts });
  for (const line of result.notes) console.log(line);
  if (result.code !== 0) {
    console.error(`version claim: refused — ${result.error}`);
    return result.code;
  }
  if (result.nothing) {
    console.log(`version claim: nothing to claim — this branch declares ${result.version} and ${result.baseRef} carries ${result.baseVersion}`);
    console.log("  a render that is the whole PR spends no number and creates no tag; nothing was pushed.");
    return 0;
  }
  const c = result.claimed;
  if (result.already) console.log(`version claim: v${c.version} is already claimed at ${String(c.commit).slice(0, 10)} — nothing to push`);
  else console.log(`version claim: v${c.version} claimed on ${remote} at ${String(c.commit).slice(0, 10)} (attempt ${c.attempts})`);
  console.log(`  the claim is the annotated tag: git ls-remote --tags ${remote} carries v${c.version}, so a lane that asks for it is refused.`);
  return 0;
}

// Anchor the commit that FIRST declared the version the ref's tree carries. The ref is resolved only to read
// the number out of that tree; the commit to name comes from the same history walk the gate judges
// (tools/release-history.mjs), because a ref's tip is not where a version began. A changelog render commit on
// top of a bump still reads the bumped number, and tagging it names a commit whose patch touches only
// CHANGELOG.md — the mis-anchor that put v1.5.0 on 5234a3c. Two callers: a dirty-tree apply, after the agent
// has committed the change by hand, and the post-merge step, where a rebase merge has re-created the bump
// commit under a new sha and the tag has to move with it.
function modeTag(argv) {
  let ref = "HEAD";
  let force = false;
  let fetch = false;
  let push = false;
  let remote = "origin";
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--ref") ref = String(argv[(i += 1)] || "HEAD");
    else if (a === "--force") force = true;
    else if (a === "--fetch") fetch = true;
    else if (a === "--push") push = true;
    else if (a === "--remote") remote = String(argv[(i += 1)] || "origin");
    else {
      console.error(`version tag: unknown argument: ${a}`);
      return 2;
    }
  }
  // The move is post-merge, so the ref to read is the base AFTER the merge. On a clone that has not fetched since,
  // `--ref origin/main` resolves to the pre-merge commit the caller is trying to leave.
  if (fetch) {
    const fetched = gitRun(["fetch", remote, "--prune", "--tags"]);
    if (!fetched.ok) {
      console.error(`version tag: git fetch ${remote} refused — ${fetched.err}`);
      return 1;
    }
  }
  const tip = gitOk(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  if (!tip) {
    console.error(`version tag: ${ref} is not a commit in this repository`);
    return 2;
  }
  const at = gitOk(["show", `${tip}:package.json`]);
  const version = at === null ? null : versionIn(at);
  if (!version) {
    console.error(`version tag: package.json at ${tip.slice(0, 10)} has no readable "version" — nothing to anchor`);
    return 1;
  }

  // The number comes from the ref's tree; the commit comes from the walk. Reading the tree and tagging the tip
  // is what mis-anchored v1.5.0 on the render commit above its bump.
  let found;
  try {
    found = findDeclaration({ root: ROOT, ref: tip, version });
  } catch (e) {
    console.error(
      `version tag: refused — could not walk package.json's history at ${ref} (${tip.slice(0, 10)}) — ` +
        String(e.stderr || e.message).trim(),
    );
    console.error("  nothing was tagged: without the walk there is no commit that can be shown to declare the number.");
    return 1;
  }
  const declared = found.declaration;
  if (!declared) {
    const seen = found.versions;
    const range = seen.length ? `v${seen[0].version} .. v${seen[seen.length - 1].version}` : "none";
    console.error("");
    console.error(`version tag: refused — no commit reachable from ${ref} (${tip.slice(0, 8)}) first carries ${version}`);
    console.error("");
    console.error(`  package.json at that ref's tip reads ${version}, but the walk found ${seen.length} version`);
    console.error(`  bump${seen.length === 1 ? "" : "s"} (${range}) and none of them writes ${version} to the version line.`);
    console.error("  the tip's tree showing the number is not the same thing as the history carrying it: a merge");
    console.error("  resolution, a shallow clone or a graft can leave the value with no commit that wrote it.");
    console.error("");
    console.error(`  looked for: the commit whose package.json patch first writes "version": "${version}",`);
    console.error(`             in git log --follow -p -- package.json reachable from ${ref}`);
    console.error(`             (${seen.length} bump${seen.length === 1 ? "" : "s"} seen there: ${range})`);
    console.error("  nothing was tagged.");
    console.error("");
    return 1;
  }
  const commit = declared.sha;
  if (commit === gitOk(["rev-parse", "HEAD"])) {
    const dirty = dirtyFiles();
    if (dirty.length) {
      console.error(
        `version tag: refused — the tree is dirty (${dirty.length} change${dirty.length === 1 ? "" : "s"}), ` +
          "and a tag names a commit, not a working tree:",
      );
      for (const line of dirty.slice(0, 8)) console.error(`  ${line}`);
      if (dirty.length > 8) console.error(`  … and ${dirty.length - 8} more`);
      console.error("  commit the bump first; the tag belongs to the commit that carries it.");
      return 1;
    }
  }
  const name = `v${version}`;
  const existing = tagAt(name);
  // The claim travels with the anchor: --push sends the tag this run created or moved, so the post-merge step is
  // one command and the anchor the reader follows is the same ref every lane reads as "taken".
  const publish = () => {
    if (!push) return 0;
    const sent = pushTag(version, { remote, force: Boolean(existing) });
    if (!sent.ok) {
      console.error(`version tag: ${name} is at ${commit.slice(0, 10)}, but the push refused — ${sent.err}`);
      return 1;
    }
    console.log(`  pushed    ${name} to ${remote}${existing ? " (forced: the claim moved)" : ""}`);
    return 0;
  };
  // Said out loud whenever the anchor is not the ref's tip, so a reader who resolved origin/main can see the
  // tag followed the declaration and not the render commit.
  const namedTip = /^[0-9a-f]{4,40}$/i.test(ref) && tip.toLowerCase().startsWith(ref.toLowerCase())
    ? `the tip ${tip.slice(0, 8)}`
    : `${ref}'s tip ${tip.slice(0, 8)}`;
  const pastTip = commit === tip ? "" : ` — the commit that first declared ${version}, not ${namedTip}`;
  if (existing && existing.commit === commit && existing.annotated) {
    console.log(`version tag: ${name} is already an annotated tag at ${commit.slice(0, 10)}${pastTip} — nothing to do`);
    return publish();
  }
  if (existing && existing.commit === commit && !existing.annotated && !force) {
    console.error(
      `version tag: ${name} exists at ${commit.slice(0, 10)} as a lightweight tag and carries no message — ` +
        "pass --force to recreate it annotated",
    );
    return 1;
  }
  if (existing && !force) {
    console.error(
      `version tag: ${name} already exists at ${existing.commit.slice(0, 10)}` +
        `${existing.annotated ? "" : " (lightweight)"}, but ${ref}'s history first declares ${version} at ` +
        `${commit.slice(0, 10)} (${declared.subject}) — pass --force to move it`,
    );
    return 1;
  }
  const made = createTag(version, commit, { force: Boolean(existing) });
  if (!made.ok) {
    console.error(`version tag: git tag refused — ${made.err}`);
    return 1;
  }
  console.log(
    `version tag: ${name} (annotated) at ${commit.slice(0, 10)}` +
      `${existing ? ` — moved from ${existing.commit.slice(0, 10)}` : ""}${pastTip}`,
  );
  return publish();
}

// Anchor every version in package.json's history that has no tag, at the commit that first declared it. This is
// the repair for the bumps a tool without tagging left behind — and it is written to be run twice: an anchored
// version is counted and skipped, so a second run creates nothing, duplicates nothing and exits 0.
function modeBackfill(argv) {
  let ref = "HEAD";
  let push = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--ref") ref = String(argv[(i += 1)] || "HEAD");
    else if (a === "--push") push = true;
    else {
      console.error(`version backfill: unknown argument: ${a}`);
      return 2;
    }
  }
  let history;
  try {
    history = readReleaseHistory({ root: ROOT, ref });
  } catch (e) {
    console.error(`version backfill: could not read package.json's history at ${ref} — ${String(e.stderr || e.message).trim()}`);
    return 2;
  }
  if (!history.versions.length) {
    console.error(`version backfill: no version history at ${ref} — refusing to report a backfill that anchored nothing`);
    return 2;
  }
  const created = [];
  const already = [];
  const repairs = [];
  for (const v of history.versions) {
    if (!v.tag) {
      const made = createTag(v.version, v.sha);
      if (!made.ok) {
        console.error(`  tag-refused   v${v.version} at ${v.sha.slice(0, 10)} — ${made.err}`);
        return 1;
      }
      created.push(v);
    } else if (v.tag.commit !== v.sha) {
      repairs.push(`  wrong-commit  v${v.version} points at ${String(v.tag.commit).slice(0, 10)}, but ${v.version} first appeared at ${v.sha.slice(0, 10)}`);
    } else if (!v.tag.annotated) {
      repairs.push(`  lightweight   v${v.version} at ${v.sha.slice(0, 10)} carries no message — git tag -f -a v${v.version} ${v.sha.slice(0, 10)} -m "v${v.version}"`);
    } else {
      already.push(v);
    }
  }
  const total = history.versions.length;
  console.log(
    `version backfill: ${total} version bump${total === 1 ? "" : "s"} at ${ref}, ` +
      `${already.length} already anchored, ${created.length} tagged now`,
  );
  for (const v of created) console.log(`  tagged        v${v.version}  ${v.sha.slice(0, 10)}  (${v.date}) ${v.subject}`);
  if (push && created.length) {
    const pushed = gitRun(["push", "origin", ...created.map((v) => `refs/tags/v${v.version}`)]);
    if (!pushed.ok) {
      console.error(`version backfill: git push refused — ${pushed.err}`);
      return 1;
    }
    console.log(`  pushed        ${created.length} tag${created.length === 1 ? "" : "s"} to origin`);
  }
  if (repairs.length) {
    console.log("");
    for (const line of repairs) console.log(line);
    console.log(
      `FAIL — ${repairs.length} existing tag${repairs.length === 1 ? "" : "s"} names the wrong commit or carries no message; ` +
        "this tool creates the missing ones and will not silently rewrite a pushed tag",
    );
    return 1;
  }
  return 0;
}

// ---------- entry ----------

const [mode, ...rest] = process.argv.slice(2);
const code =
  mode === "suggest" ? modeSuggest()
    : mode === "check" ? modeCheck(rest)
      : mode === "apply" ? modeApply(rest[0], rest.slice(1))
        : mode === "claim" ? modeClaim(rest)
          : mode === "tag" ? modeTag(rest)
            : mode === "backfill" ? modeBackfill(rest)
              : (console.error([
                "tools/version.mjs — the panel's one version number: advice, gate, write, claim, anchor, backfill.",
                "",
                "  node tools/version.mjs suggest                     print the level the commits read as (advice; writes nothing)",
                "  node tools/version.mjs check [--base <ref>]        exit 1 unless HEAD's version is above the base ref's",
                "  node tools/version.mjs apply <patch|minor|major> [--no-claim] [--remote <name>]",
                "                                                    write the new version above the base, commit it, tag",
                "                                                    that commit and claim the number by pushing its tag",
                "  node tools/version.mjs claim [--level <l>] [--max <n>] [--remote <name>]",
                "                                                    push v<version> to claim it; if it is taken, re-bump",
                "                                                    above it at the same level and push again",
                "  node tools/version.mjs tag [--ref <ref>] [--force] [--fetch] [--push] [--remote <name>]",
                "                                                    anchor the commit that first declared the version",
                "                                                    in <ref>'s tree (--ref origin/main --force --fetch --push:",
                "                                                    the post-merge move of the claim)",
                "  node tools/version.mjs backfill [--ref <ref>] [--push]",
                "                                                    tag every untagged version at the commit that declared it",
                "",
                `  ${DOC} is the scale.`,
              ].join("\n")), 2);
process.exit(code);
