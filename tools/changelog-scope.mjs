#!/usr/bin/env node
// tools/changelog-scope.mjs — which docs commits belong to this repository's own changelog.
//
// WHY: a landing agent wrote a retest report for two SEFL applications, filed it under this repo's docs/ and
// pushed it here. It was a real report about real work, but it is not this panel's work, and CHANGELOG.md listed
// it under v1.76.24 as if it were. History is not rewritten for that: the report is preserved where it belongs,
// deleted here, and both the renderer and the commit gate read ONE list of the projects whose reports do not
// belong here, so a second report cannot follow the first.
//
// The list is tools/changelog-scope.json and it is a LIST on purpose: no git fact says "this path names another
// project". The subject and the path are the only evidence a commit carries, so the projects are named there,
// matched case-insensitively on a word boundary, and adding one is an edit a reviewer sees.
//
// The rule is one sentence: a DOCS commit that names another project, in its subject or in a path it adds or
// modifies, is out of scope. Two halves keep it honest:
//
//   - a DELETION is not a match. Removing another project's report is this repo's own cleanup, and the commit
//     that removes the reports must be able to say so in the changelog.
//   - a subject match and a path match are the same rule, so a foreign report whose subject is neutral ("docs:
//     name the retest evidence without machine paths") is still caught by the path it edits.
//
//   node tools/changelog-scope.mjs --commit-msg <msgfile>   the .githooks/commit-msg gate: exit 1, with the
//                                                           reason, when the staged docs commit names another
//                                                           project; 0 when it does not; 2 on a usage error
//   node tools/changelog-scope.mjs --subject "<subject>"    the same decision for a subject alone (a probe)
//
// Only exit 1 is a refusal. A hook that cannot run its own check must not block a commit, so a tool that dies
// for any other reason passes.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SCOPE_FILE = "tools/changelog-scope.json";

// The docs half of tools/changelog.mjs's `classify`, kept here because the RENDERER imports this module and the
// module cannot import the renderer back. It is the whole DOCS GROUP, tests included: the changelog prints one
// "Docs & tests" bucket, so a test commit that files another project's fixture in this repo is the same mistake.
// test/changelog-scope.test.js pins the two answers together over every prefix either one reads.
const DOCS_SUBJECT = /^(docs?|tests?)(\([^)]*\))?!?:/i;

export function isDocsSubject(subject) {
  return DOCS_SUBJECT.test(String(subject || "").trim());
}

// One normal form for the subject, the path and the token: lowercase, separators as spaces, single spaces. A
// path is read as words too, so "landing-pictureviewer-pmw-sso" and "PictureViewer + PMW" match one token.
export function normalise(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[-_.\\/]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// The project this text names, or null. A token matches whole words only: "pmw" does not match "pmwx", and a
// token that is a prefix of a longer word ("picture" in "pictureviewer") does not match unless it is the token.
export function namesForeignProject(text, scope) {
  const hay = normalise(text);
  if (!hay) return null;
  for (const project of scope?.projects || []) {
    const needle = normalise(project);
    if (!needle) continue;
    let at = hay.indexOf(needle);
    while (at >= 0) {
      const before = at === 0 ? "" : hay[at - 1];
      const after = hay[at + needle.length] || "";
      if (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after)) return String(project);
      at = hay.indexOf(needle, at + 1);
    }
  }
  return null;
}

// A commit is foreign when it is a docs commit and names another project. Returns {project, how} or null. The
// commit's `files` are [{status, path}] as tools/changelog.mjs's listCommits builds them; a call with no files
// falls back to the subject alone, which is what the commit-msg gate has before the commit exists.
export function foreignCommit(commit, scope) {
  if (!scope?.projects?.length) return null;
  if (!isDocsSubject(commit?.subject)) return null;
  const bySubject = namesForeignProject(commit.subject, scope);
  if (bySubject) return { project: bySubject, how: "in its subject" };
  for (const file of commit?.files || []) {
    if (!file?.path) continue;
    if (String(file.status || "").toUpperCase() === "D") continue; // a deletion is this repo's cleanup
    const named = namesForeignProject(file.path, scope);
    if (named) return { project: named, how: `in the path it adds or edits (${file.path})` };
  }
  return null;
}

// A section CHANGELOG.md already carries, read for the bullets a foreign commit would have written. Only the
// bullets are checked: the heading and the meta line name this repo and its tags, and a section's prose is not
// where a commit is listed.
export function sectionNamesForeignProject(text, scope) {
  if (!scope?.projects?.length) return null;
  for (const line of String(text || "").split("\n")) {
    if (!/^[-*]\s+/.test(line)) continue;
    const named = namesForeignProject(line, scope);
    if (named) return named;
  }
  return null;
}

// The scope the repository at `root` carries. A clone without the file has no list and nothing is filtered,
// exactly as before this module existed: the guard is a fact about a repository, not about the tool.
export function loadScope(root = process.cwd()) {
  try {
    const raw = JSON.parse(readFileSync(path.join(root, SCOPE_FILE), "utf8"));
    const projects = Array.isArray(raw?.projects) ? raw.projects.map((p) => String(p || "").trim()).filter(Boolean) : [];
    return { projects, why: raw?.why ? String(raw.why) : "", file: path.join(root, SCOPE_FILE) };
  } catch {
    return { projects: [], why: "", file: null };
  }
}

function git(root, argv) {
  return execFileSync("git", argv, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 16 * 1024 * 1024 });
}

// The staged files as [{status, path}]. --diff-filter=ACMR leaves deletions out on purpose: a commit that only
// deletes another project's report is the cleanup, and it must pass.
export function stagedFiles(root = process.cwd()) {
  let raw = "";
  try {
    raw = git(root, ["diff", "--cached", "--name-status", "--diff-filter=ACMR"]);
  } catch {
    return [];
  }
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [status = "", firstName = "", secondName = ""] = line.split("\t");
      if (!status || !firstName) return null;
      const renamed = status.startsWith("R") || status.startsWith("C");
      return { status: status[0], path: renamed ? secondName || firstName : firstName };
    })
    .filter(Boolean);
}

// The first non-comment, non-blank line: git keeps '#' template lines until cleanup, and the subject is what
// .githooks/commit-msg already reads.
export function subjectOf(message) {
  const line = String(message || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith("#"));
  return line || "";
}

function refusal(subject, hit, scope) {
  return [
    "commit-msg: refused - this docs commit names another project",
    "",
    `  subject: "${subject}"`,
    `  it names ${hit.project} ${hit.how}, which is not this repository's work.`,
    "",
    "CHANGELOG.md is this repo's own history, and a report for another project does not belong in it. That",
    "project's report goes in that project's own repository, or outside any repository as a local file. If this",
    "commit really is this repo's work, take the other project's name out of its subject and out of its path.",
    "",
    `The list is ${SCOPE_FILE}${scope?.file ? "" : " (absent here)"}; adding a project is a deliberate edit a reviewer sees.`,
    "",
  ].join("\n");
}

function main(argv) {
  const root = process.cwd();
  const scope = loadScope(root);
  let mode = null;
  let value = "";
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--commit-msg") {
      mode = "message";
      value = String(argv[(i += 1)] || "");
    } else if (a === "--subject") {
      mode = "subject";
      value = String(argv[(i += 1)] || "");
    } else if (a === "--help" || a === "-h") {
      console.log("node tools/changelog-scope.mjs --commit-msg <msgfile>");
      console.log("node tools/changelog-scope.mjs --subject \"<subject>\"");
      console.log(`  reads ${SCOPE_FILE}; exit 1 only when a docs commit names another project.`);
      return 0;
    } else {
      return 2;
    }
  }
  if (!mode) return 2;

  let subject = value;
  let files = [];
  if (mode === "message") {
    let message = "";
    try {
      message = readFileSync(value, "utf8");
    } catch {
      return 0; // no message file: nothing to judge, and a hook must not block on that
    }
    subject = subjectOf(message);
    files = stagedFiles(root);
  }
  const hit = foreignCommit({ subject, files }, scope);
  if (!hit) return 0;
  process.stderr.write(refusal(subject, hit, scope));
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
