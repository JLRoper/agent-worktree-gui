#!/usr/bin/env node
// tools/release-history.mjs — the one derivation of "which commit first declared each version".
//
// WHY: a tag is only an anchor if it points at the commit that declared the number, and a changelog is only
// honest if it reads the same history the tags do. Both the renderer (tools/changelog.mjs) and the gate
// (tools/verify-version-tags.mjs) read this module, so neither re-implements the walk and the two cannot
// disagree about where a version began.
//
// The walk is `git log --follow -p -- package.json` from a ref, oldest first, with the diff of each commit. A
// version FIRST APPEARS at the first commit whose patch writes a new value to the file's top-level "version"
// line. A commit that touches package.json without touching that line — a new script, a new dependency — is
// skipped, which is why the version count is smaller than the count of commits that touched the file.
//
// This history is not linear: two bumps (0.14.0) landed on a side branch and were merged, so a tag can point
// at a merge commit and consecutive ranges can share it. Ranges are still `previous..next`, which is what a
// reader means by "the commits between two tags"; the renderer drops merge commits, so the shared one is
// never printed twice.

import { execFileSync } from "node:child_process";

export const VERSION_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;

function git(root, argv) {
  return execFileSync("git", argv, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60000,
    // The package.json log with patches runs to a few megabytes on this repo; the default 1 MB buffer is not
    // enough and the failure (ENOBUFS) reads like a git crash.
    maxBuffer: 64 * 1024 * 1024,
  });
}

export function parseVersionTag(name) {
  const m = VERSION_TAG.exec(String(name || "").trim());
  return m ? `${Number(m[1])}.${Number(m[2])}.${Number(m[3])}` : null;
}

// Git pathspecs are relative to the working directory, so a tool run from `tools/` would read no package.json at
// all and the gate would pass on an empty history. Every read in this module anchors on the repository root.
export function repoRoot(cwd = process.cwd()) {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" }).trim();
}


export function compareVersions(a, b) {
  const pa = String(a).split(".").map(Number);
  const pb = String(b).split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

// The log's own format: a record separator before each commit, then sha, author date and subject, then the
// patch. Splitting on the record separator keeps a subject that contains a newline (a squash body) out of the
// parse: only the first line of each block is read as the header.
export function parseVersionHistory(text) {
  const blocks = String(text || "").split("\x1e").slice(1);
  const commits = blocks.map((block) => {
    const lines = block.split("\n");
    const [sha = "", date = "", subject = ""] = (lines[0] || "").split("\x1f");
    let written = null;
    for (const line of lines.slice(1)) {
      const m = /^\+[ \t]*"version"[ \t]*:[ \t]*"([^"]*)"/.exec(line);
      if (m) written = m[1];
    }
    return { sha: sha.trim(), date: date.trim(), subject: subject.trim(), written };
  });
  const out = [];
  let tracked = null;
  // blocks are newest-first; reverse to walk the file forward in time.
  for (const c of commits.slice().reverse()) {
    if (!c.written || c.written === tracked) continue;
    out.push({ version: c.written, sha: c.sha, date: c.date, subject: c.subject, from: tracked });
    tracked = c.written;
  }
  return out;
}

// The anchor is the FIRST commit that declared a version. A history that re-declares a number it already had (a
// revert of a bump) keeps the original commit, so one tag still names one release; the transition that went back
// is still in the raw list for the gate to report.
export function firstAppearances(transitions) {
  const seen = new Set();
  const out = [];
  for (const t of transitions) {
    if (seen.has(t.version)) continue;
    seen.add(t.version);
    out.push(t);
  }
  return out;
}

export function readVersionHistory({ root = process.cwd(), ref = "HEAD" } = {}) {
  const text = git(repoRoot(root), [
    "log",
    "--follow",
    "-p",
    "--format=%x1e%H%x1f%ad%x1f%s",
    "--date=short",
    ref,
    "--",
    "package.json",
  ]);
  return parseVersionHistory(text);
}

// Every tag in the repository, with the commit it resolves to. `for-each-ref` peels an annotated tag's object
// to its commit in one call, so a 205-tag repository costs one subprocess rather than 205.
export function readTags(root = process.cwd()) {
  const raw = git(repoRoot(root), [
    "for-each-ref",
    "--format=%(refname:short)%09%(objecttype)%09%(objectname)%09%(*objectname)",
    "refs/tags",
  ]);
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name, objecttype, objectname, peeled] = line.split("\t");
      const annotated = objecttype === "tag";
      return { name, version: parseVersionTag(name), annotated, object: objectname, commit: annotated ? peeled : objectname };
    });
}

// The history and the tags it should be anchored by, joined. `transitions` is every change to the version line in
// the order it happened (a number that went backwards is visible there); `versions` is the first appearance of
// each number, each carrying its tag, or null when the bump was never tagged.
export function readReleaseHistory({ root = process.cwd(), ref = "HEAD" } = {}) {
  const transitions = readVersionHistory({ root, ref });
  const byName = new Map(readTags(root).map((t) => [t.name, t]));
  const versions = firstAppearances(transitions).map((v) => {
    const tag = byName.get(`v${v.version}`) || null;
    return { ...v, tag };
  });
  const known = new Set(versions.map((v) => `v${v.version}`));
  const orphanTags = [...byName.values()].filter((t) => t.version && !known.has(t.name));
  const commit = git(repoRoot(root), ["rev-parse", `${ref}^{commit}`]).trim();
  return { ref, commit, transitions, versions, tags: [...byName.values()], orphanTags };
}

// Where a number may be anchored: the commit whose patch FIRST writes it to package.json's top-level version
// line, in the history reachable from `ref` — the same walk, and the same first-appearance rule, the gate
// judges. A ref's TREE is not an anchor: a changelog render commit on top of a bump still reads the bumped
// number, and a tag placed there names a commit whose diff touches only CHANGELOG.md. That mis-anchor is why
// `version.mjs tag` asks this function instead of reading the tree and tagging the tip.
//
// `declaration` is null when the walk has no commit writing that number — a merge resolution that changed the
// line is invisible to `git log -p` unless -m/--cc is given, and a shallow clone can hide the commit that
// declared it. Both leave no honest anchor, so the caller refuses rather than falling back to the tip.
export function findDeclaration({ root = process.cwd(), ref = "HEAD", version } = {}) {
  const history = readReleaseHistory({ root, ref });
  const want = String(version == null ? "" : version).trim();
  return {
    ref: history.ref,
    tip: history.commit,
    version: want,
    declaration: history.versions.find((v) => v.version === want) || null,
    versions: history.versions,
  };
}
