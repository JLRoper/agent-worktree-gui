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
//   check              exit non-zero when the branch carries commits and package.json still holds the base's
//                      version, naming the commits. Silent and zero on an already-bumped branch and on a
//                      branch with no commits. This is the pipeline's gate — the pre-push hook calls it.
//                      It never writes.
//   apply <level>      write the new version to package.json (the one place it lives), commit that write as the
//                      bump, and anchor the commit with an annotated v<version> tag. Run by the landing agent,
//                      deliberately; never by check and never by a hook. In a tree that already carries other
//                      changes it writes the number and stops — no commit, no tag — because a tag belongs to a
//                      commit that carries the bump and nothing else; it says which of the two happened.
//   tag                anchor the commit package.json's version names with an annotated tag. This is the
//                      post-merge step: a rebase merge re-creates the commit, so the tag is moved onto the one
//                      main carries (node tools/version.mjs tag --ref origin/main --force). Refuses a dirty
//                      tree when the commit is HEAD, and refuses to move an existing tag without --force.
//   backfill           create the annotated tag for every version in package.json's history that has none, at
//                      the commit that first declared it. Idempotent: an anchored version is skipped, never
//                      duplicated, and a second run creates nothing and exits 0. --push sends only the tags
//                      this run created.
//
// The scale these read is docs/versioning.md. The base ref is $VERSION_BASE when set, otherwise the
// remotes' own HEAD (github/main, origin/main, ...), otherwise main, otherwise master. The repository is the
// one the current directory is in (`git rev-parse --show-toplevel`), so the tool works from a worktree.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readReleaseHistory } from "./release-history.mjs";

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
  const base = baseFlag >= 0 && argv[baseFlag + 1] ? argv[baseFlag + 1] : resolveBase().ref;
  if (!base) {
    console.error(`version check: no base ref found (looked for: ${resolveBase().tried.join(", ")}) — nothing compared`);
    return 0;
  }
  const commits = branchCommits(base);
  if (!commits.length) return 0; // a branch with nothing on it cannot be asked to bump anything

  const text = readWorking();
  const here = versionIn(text || "");
  const there = versionAt(base);
  if (here === null) {
    console.error(`version check: refused — package.json has no readable "version" (${PKG})`);
    return 1;
  }
  if (there === null || here !== there) return 0; // bumped (or nothing at the base to compare with): quiet

  const read = commits.map((c) => ({ ...c, ...classify(c.subject, c.body) }));
  const { level } = overall(read);
  const lines = [
    "",
    `version check: refused — ${commits.length} commit${commits.length === 1 ? " is" : "s are"} about to land with no version bump`,
    "",
    `  package.json: ${here} — unchanged from ${base}`,
    "  commits this branch adds:",
    ...read.map((c) => `    ${c.sha.slice(0, 8)}  ${(c.level || "?").padEnd(5)} ${c.subject.slice(0, 68)}`),
    "",
    level
      ? `  the tool would suggest: ${level}  (advice — the level is the landing agent's judgement)`
      : "  no commit here carries a prefix this scale reads — read the diff and decide the level",
    "",
    "  a version that does not move with its change tells a reader nothing moved, and the squash merge puts",
    "  this branch's own subjects into main's history. Fix it in the same PR as the change:",
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

function modeApply(level) {
  const want = String(level || "").toLowerCase();
  if (!LEVELS.includes(want)) {
    console.error(`version apply: needs a level — ${LEVELS.join(" | ")} (got: ${level === undefined ? "nothing" : JSON.stringify(level)})`);
    return 2;
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
  const next = nextVersion(old, want);
  if (!next) {
    console.error(`version apply: "${old}" is not a major.minor.patch version I can bump`);
    return 2;
  }
  // A version is anchored once. Writing a number that already names another commit would make the tag and the
  // gate disagree about what the number means, so this is refused before the file moves.
  const taken = tagAt(`v${next}`);
  if (taken) {
    console.error(
      `version apply: package.json would declare ${next}, and v${next} already names ${taken.commit.slice(0, 10)}` +
        " — a version is anchored once; move or delete that tag first",
    );
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
  if (dirty.length) {
    console.log(
      `  no commit and no tag: the tree carried ${dirty.length} other change${dirty.length === 1 ? "" : "s"} ` +
        "before the bump, and a tag belongs to a commit that carries the bump and nothing else:",
    );
    for (const line of dirty.slice(0, 8)) console.log(`    ${line}`);
    if (dirty.length > 8) console.log(`    … and ${dirty.length - 8} more`);
    console.log("  commit the change, then anchor it: node tools/version.mjs tag");
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
  console.log("  a rebase merge re-creates this commit — after the merge, move the tag onto the commit main carries:");
  console.log(`    node tools/version.mjs tag --ref origin/main --force && git push origin v${next} --force`);
  return 0;
}

// Anchor an existing commit with the version package.json declares at it. Two callers: a dirty-tree apply, after
// the agent has committed the change by hand, and the post-merge step, where a rebase merge has re-created the
// bump commit under a new sha and the tag has to move with it.
function modeTag(argv) {
  let ref = "HEAD";
  let force = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--ref") ref = String(argv[(i += 1)] || "HEAD");
    else if (a === "--force") force = true;
    else {
      console.error(`version tag: unknown argument: ${a}`);
      return 2;
    }
  }
  const commit = gitOk(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  if (!commit) {
    console.error(`version tag: ${ref} is not a commit in this repository`);
    return 2;
  }
  const at = gitOk(["show", `${commit}:package.json`]);
  const version = at === null ? null : versionIn(at);
  if (!version) {
    console.error(`version tag: package.json at ${commit.slice(0, 10)} has no readable "version" — nothing to anchor`);
    return 1;
  }
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
  if (existing && existing.commit === commit && existing.annotated) {
    console.log(`version tag: ${name} is already an annotated tag at ${commit.slice(0, 10)} — nothing to do`);
    return 0;
  }
  if (existing && !force) {
    console.error(
      `version tag: ${name} already exists at ${existing.commit.slice(0, 10)}` +
        `${existing.annotated ? "" : " (lightweight)"}, and ${ref} is ${commit.slice(0, 10)} — pass --force to move it`,
    );
    return 1;
  }
  const made = createTag(version, commit, { force: Boolean(existing) });
  if (!made.ok) {
    console.error(`version tag: git tag refused — ${made.err}`);
    return 1;
  }
  console.log(`version tag: ${name} (annotated) at ${commit.slice(0, 10)}${existing ? ` — moved from ${existing.commit.slice(0, 10)}` : ""}`);
  return 0;
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
      : mode === "apply" ? modeApply(rest[0])
        : mode === "tag" ? modeTag(rest)
          : mode === "backfill" ? modeBackfill(rest)
            : (console.error([
              "tools/version.mjs — the panel's one version number: advice, gate, write, anchor, backfill.",
              "",
              "  node tools/version.mjs suggest                     print the level the commits read as (advice; writes nothing)",
              "  node tools/version.mjs check [--base <ref>]        exit 1 when the branch carries commits with no bump",
              "  node tools/version.mjs apply <patch|minor|major>   write the new version, commit it and tag that commit",
              "  node tools/version.mjs tag [--ref <ref>] [--force] anchor an existing commit with package.json's version",
              "                                                    (--ref origin/main --force: the post-merge move)",
              "  node tools/version.mjs backfill [--ref <ref>] [--push]",
              "                                                    tag every untagged version at the commit that declared it",
              "",
              `  ${DOC} is the scale.`,
            ].join("\n")), 2);
process.exit(code);
