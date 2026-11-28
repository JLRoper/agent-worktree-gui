#!/usr/bin/env node
// tools/verify-version-tags.mjs — a version bump with no tag fails this gate.
//
// WHY: the version anchors a build to a commit. A reader running an old tab (the board's config line says
// which build) can only ask "what changed between mine and now" if each number names a commit, and a
// CHANGELOG rendered between tags is only as truthful as the tags it reads. The walk in
// tools/release-history.mjs already knows where every version first appeared; this gate asks git whether a
// tag says the same thing.
//
// THE REMOTE IS THE TRUTH. A tag is a repository-wide claim, so the gate asks origin what it publishes
// (`git ls-remote --tags origin`) instead of asking this checkout's refs/tags. A clone whose tags were fetched
// before a landing re-created a bump commit keeps the old sha for every tag that landing moved; judging those refs
// reported six correct anchors as wrong-commit — a statement about the reader's checkout, not about the
// repository. The checkout's own tags are still read, and where one disagrees with origin it is reported as
// `stale-local`, a warning under its own label. With no origin remote (a fixture, an offline clone) the gate says
// so and judges the checkout, which is then the only source there is.
//
// Six findings, five of them failures and one a warning:
//   missing       package.json's history first declared <version> at <sha>, and origin carries no v<version> tag.
//                 A tag that exists only in this checkout is named in the message: it was never pushed.
//   wrong-commit  origin's tag resolves to another commit - the anchor points at the wrong history
//   lightweight   origin's tag is at the right commit but carries no message; an annotated tag records the
//                 version, its date and a line of why, and survives a clone as an object of its own
//   orphan-tag    a v<major>.<minor>.<patch> tag names a version package.json never held - read at the commit
//                 the tag names, so the finding is about that commit and not about the ref's history. A tag for
//                 a version this ref has not carried yet, at a commit whose package.json DOES declare it, is a
//                 pre-landing anchor held by its branch and is not a finding: the branch carries the tag so this
//                 gate can read it, and the landing moves it onto the commit main carries.
//   off-main      a version tag whose commit is NOT AN ANCESTOR OF MAIN, and which a branch still holds. That is a
//                 claim no reader of main can follow: package.json at the tagged commit may declare the number,
//                 but the commit never landed, so the number cannot be released from it. The finding names the tag,
//                 its commit and the branch holding it. A tag no branch holds is a fossil of a rewritten history
//                 and stays a note (see `held`), because no commit can still be landed from it and a refusal
//                 nobody can act on is noise in every landing's gate.
//   stale-local   (warning, exit 0) this checkout's v<version> ref disagrees with origin's. The gate judged
//                 origin; the next `git fetch --tags --force` refreshes the checkout. Not an anchor defect:
//                 reporting it as wrong-commit is what hid six correct anchors behind a stale clone.
//   backwards     a commit's own patch replaces a higher version with a lower one (the version its patch REMOVED
//                 is compared with the one it wrote, when the walk recorded both; the ordered walk's neighbour is
//                 only the fallback). A number that goes backwards exists in the file's history and its tag may be
//                 right, but no reader could order the two releases - a hotfix to an older line is the honest
//                 shape, and the finding names it so a future decrease is still visible.
//
// PINS. A gate that fails every landing with the same historical findings is not a signal: a worker cannot tell
// the defect it caused from the ones history already carried. A finding named in tools/version-tags-pins.json -
// by kind, version, commit and, for a wrong anchor, the tag's own commit, with a written reason - is still
// computed and still printed with that reason on every run; it simply does not fail the gate. A pin that names no
// finding any more is itself a failure (a stale pin: the anchor was repaired, so the pin must go), so the file can
// only ever name history and can never hide a new defect. This is not a deleted check and not a silence: the
// number of pinned findings is on the gate's own line, every one is listed by name below the findings, and a
// finding that is not pinned still exits 1 exactly as before.
//
//   node tools/verify-version-tags.mjs                 check HEAD
//   node tools/verify-version-tags.mjs --ref <ref>     check another ref (a tag, a commit, origin/main)
//   node tools/verify-version-tags.mjs --main <ref>    the release branch a tag must be an ancestor of (main)
//   node tools/verify-version-tags.mjs --json          one JSON object on stdout
//   node tools/verify-version-tags.mjs --limit <n>     how many findings to print (default 40; 0 = all)
//   node tools/verify-version-tags.mjs --pins <file>   read a different pin file (a fixture's own; a missing one
//                                                      given on the command line is exit 2, not a silent pass)
//
// Exit codes: 0 every unpinned bump is tagged and agrees with origin, and every pin names a live finding; 1 at
// least one finding that is not pinned, or a pin that names nothing; 2 the check could not run (including an
// origin that is configured but unreadable, a main that cannot be read, or a pin file that does not parse - a
// gate that cannot see the remote, the release branch or its own pins says so rather than passing).

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { branchesHolding, offMainTags, parseVersionTag, readReleaseHistory, readVersionAtCommit, repoRoot } from "./release-history.mjs";

// The gate's logic, separated from git and from the terminal so a test can drive every kind of finding
// without building a repository. `versions` is the first appearance of each number, oldest first; `transitions`
// is every change to the version line, which is where a number that went backwards shows up. `tag` is the anchor
// the gate judged - origin's, when origin was read - and `localTag` is only set in that mode: it is the checkout's
// ref, used to explain a finding and to raise `stale-local`, never to decide one. `tag.onMain` and `tag.branches`
// are the ancestry the caller measured (tools/release-history.mjs); when they are absent the gate does not claim
// to know, and says nothing about main rather than guessing.
export function checkReleaseTags({ versions, transitions = versions, orphanTags = [], offMain = [] }) {
  const findings = [];
  let previous = null;
  for (const v of transitions) {
    // This commit's OWN transition, when the walk recorded the line its patch replaced: across a merge the
    // ordered walk's neighbour is a sibling lane, not this commit's parent. v1.76.12 was reported as a decrease
    // because the 1.76.13 bump commit (897dc66d, 09:51:13) was authored 26 seconds before this one (09:51:39) on
    // a lane cut from the same 1.76.11, so the walk listed it first - while this commit's own patch reads
    // 1.76.11 -> 1.76.12 and main's first-parent chain reads 1.76.11 -> 1.76.12 -> 1.76.13. The neighbour stays
    // the fallback for a commit whose patch shows no replaced line.
    const before = v.read != null ? v.read : previous ? previous.version : null;
    if (before) {
      const [a, b] = [before.split(".").map(Number), v.version.split(".").map(Number)];
      const backwards = b[0] < a[0] || (b[0] === a[0] && (b[1] < a[1] || (b[1] === a[1] && b[2] < a[2])));
      if (backwards) {
        findings.push({
          kind: "backwards",
          version: v.version,
          sha: v.sha,
          from: before,
          message: `package.json goes backwards: ${before} -> ${v.version} at ${v.sha.slice(0, 10)}`,
        });
      }
    }
    previous = v;
  }
  for (const v of versions) {
    const where = v.tag && v.tag.remote ? "origin" : "this checkout";
    if (!v.tag) {
      findings.push({
        kind: "missing",
        version: v.version,
        sha: v.sha,
        date: v.date,
        subject: v.subject,
        message:
          `v${v.version} is not tagged - first declared at ${v.sha.slice(0, 10)} (${v.date}) ${v.subject}` +
          (v.localTag
            ? ` (this checkout's ${v.localTag.name} at ${String(v.localTag.commit).slice(0, 10)} is not on origin: git push origin ${v.localTag.name})`
            : ""),
      });
    } else if (v.tag.commit !== v.sha) {
      findings.push({
        kind: "wrong-commit",
        version: v.version,
        sha: v.sha,
        tagCommit: v.tag.commit,
        branches: v.tag.branches || [],
        message:
          `v${v.version} points at ${String(v.tag.commit).slice(0, 10)} on ${where}, but ${v.version} first appeared at ${v.sha.slice(0, 10)}` +
          ancestry(v.tag) +
          (v.localTag && v.localTag.commit === v.sha
            ? ` - this checkout's tag already names that commit and was never pushed: git push --force origin v${v.version}`
            : ""),
      });
    } else if (!v.tag.annotated) {
      findings.push({
        kind: "lightweight",
        version: v.version,
        sha: v.sha,
        message: `v${v.version} is a lightweight tag on ${where} - recreate it with git tag -a v${v.version} ${v.sha.slice(0, 10)} -m "v${v.version}" and push --force`,
      });
    }
  }
  // The tags the walk cannot join. A tag a branch still holds and main never carried is the refusal this gate
  // exists for now: it names the tag, its commit and the branch, because either one can be the thing to move.
  const refused = new Map(offMain.filter((t) => !t.release && t.branches && t.branches.length).map((t) => [t.name, t]));
  for (const t of orphanTags) {
    const off = refused.get(t.name);
    if (off) {
      findings.push({
        kind: "off-main",
        version: t.version,
        sha: t.commit,
        branches: off.branches,
        message:
          `${t.name} points at ${String(t.commit).slice(0, 10)}, which is not an ancestor of main - the tag is held by ` +
          `${off.branches.join(", ")}; re-point it at the commit main carries, or delete it and name the branch that held it`,
      });
      continue;
    }
    // `declares` is what package.json at the tagged commit says (tools/release-history.mjs). A tag whose own
    // commit carries the number anchors a version this ref has not landed yet - held on a branch, not a false
    // claim. It is still a tag, so a message-less one is reported: held does not excuse a lightweight anchor.
    if (t.declares === true) {
      if (t.annotated === false) {
        findings.push({
          kind: "lightweight",
          version: t.version,
          sha: t.commit,
          message: `${t.name} is a lightweight tag at ${String(t.commit).slice(0, 10)} - recreate it with git tag -a ${t.name} ${String(t.commit).slice(0, 10)} -m "${t.name}"`,
        });
      }
      continue;
    }
    findings.push({
      kind: "orphan-tag",
      version: t.version,
      sha: t.commit,
      message: `${t.name} points at ${String(t.commit).slice(0, 10)}, where package.json does not declare ${t.version}`,
    });
  }
  return findings;
}

// The half-sentence a finding carries when the anchor's commit is not on main. Silent when the caller did not
// measure ancestry: a gate that does not know must not sound as if it does.
function ancestry(tag) {
  if (!tag || tag.onMain !== false) return "";
  const held = tag.branches && tag.branches.length ? `held by ${tag.branches.join(", ")}` : "no branch holds it";
  return ` - and ${String(tag.commit).slice(0, 10)} is not an ancestor of main (${held})`;
}

// `git ls-remote --tags` in one parse: a name appears twice when the tag is annotated — the tag object's sha
// first, then `refs/tags/<name>^{}` peeled to the commit it names. No peel line means the ref IS the commit, which
// is exactly what a lightweight tag is. The annotated flag therefore comes from the wire, not from this clone.
export function parseRemoteTags(text) {
  const tags = new Map();
  for (const line of String(text || "").split("\n")) {
    if (!line.trim()) continue;
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const sha = line.slice(0, tab).trim();
    const ref = line.slice(tab + 1).trim();
    if (!ref.startsWith("refs/tags/")) continue;
    const peeled = ref.endsWith("^{}");
    const name = ref.slice("refs/tags/".length).replace(/\^\{\}$/, "");
    if (!name || !sha) continue;
    const tag = tags.get(name) || { name, version: parseVersionTag(name), object: sha, commit: sha, annotated: false };
    if (peeled) {
      tag.annotated = true;
      tag.commit = sha;
    } else {
      tag.object = sha;
      if (!tag.annotated) tag.commit = sha;
    }
    tags.set(name, tag);
  }
  return tags;
}

// What origin publishes, or why it cannot be asked. `none` is a repository with no origin (a test fixture, an
// offline copy): the checkout is the only source and the gate says so. `error` is an origin that is configured but
// unreadable — that is exit 2, because the anchor cannot be judged and a PASS would be a statement about nothing.
export function readRemoteTags(root = process.cwd()) {
  const at = repoRoot(root);
  try {
    execFileSync("git", ["remote", "get-url", "origin"], { cwd: at, stdio: ["ignore", "ignore", "ignore"], timeout: 20000 });
  } catch {
    return { kind: "none", reason: "no origin remote" };
  }
  try {
    const raw = execFileSync("git", ["ls-remote", "--tags", "origin"], {
      cwd: at,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120000,
      maxBuffer: 32 * 1024 * 1024,
    });
    return { kind: "remote", source: "origin", tags: parseRemoteTags(raw) };
  } catch (e) {
    return { kind: "error", message: String(e.stderr || e.message).trim() };
  }
}

// Join each bump to the anchor origin publishes, and keep the checkout's own ref beside it. `remoteTags` null means
// the checkout is being judged (no origin): then `tag` is the local ref and there is nothing to call stale. A
// `stale-local` is raised only when origin's anchor is good — when origin is wrong the wrong-commit finding is the
// story, and telling a reader whose tag is the correct one to "refresh" would be backwards advice.
export function judgeAnchors({ versions, localTags = [], remoteTags = null }) {
  const local = new Map(localTags.filter((t) => t.version).map((t) => [t.name, t]));
  const remote = remoteTags ? new Map(remoteTags.filter((t) => t.version).map((t) => [t.name, t])) : null;
  const staleLocal = [];
  const judged = versions.map((v) => {
    const name = `v${v.version}`;
    const localTag = local.get(name) || null;
    const remoteTag = remote ? remote.get(name) || null : null;
    const tag = remote ? (remoteTag ? { ...remoteTag, remote: true } : null) : localTag;
    if (
      remote &&
      remoteTag &&
      remoteTag.commit === v.sha &&
      remoteTag.annotated &&
      localTag &&
      (localTag.commit !== remoteTag.commit || !localTag.annotated)
    ) {
      const disagreement =
        localTag.commit !== remoteTag.commit
          ? `this checkout has ${String(localTag.commit).slice(0, 10)}, origin has ${String(remoteTag.commit).slice(0, 10)}`
          : `this checkout's tag is lightweight, origin's is annotated at ${String(remoteTag.commit).slice(0, 10)}`;
      staleLocal.push({
        kind: "stale-local",
        version: v.version,
        name,
        sha: v.sha,
        local: localTag.commit,
        remote: remoteTag.commit,
        message: `${name}: ${disagreement} — the gate judged origin; refresh the checkout with git fetch --tags --force`,
      });
    }
    return { ...v, tag, localTag: remote ? localTag : null };
  });
  return { versions: judged, staleLocal };
}

// A tag on origin can name a commit this checkout has not fetched. Its tree cannot be read, so its `declares` is
// unknown and the gate neither calls it held nor calls it an orphan; it is counted and named instead of guessed at.
function hasCommit(root, sha) {
  if (!sha) return false;
  try {
    execFileSync("git", ["cat-file", "-e", `${sha}^{commit}`], { cwd: root, stdio: ["ignore", "ignore", "ignore"], timeout: 20000 });
    return true;
  } catch {
    return false;
  }
}

// ---------- the pins: history that is named once, not silenced ----------
//
// The gate fails a landing for every finding the history carries, which is the right rule and a useless signal:
// fourteen findings on `main` before this file existed meant a worker could not tell the defect it caused from
// the ones already there. A pin is a WRITTEN decision about one finding - its kind, its number, the commit it is
// about, and (for a wrong anchor) the commit the tag points at, plus the reason. It never removes the finding
// from the computation or from the output; it keeps that one finding from failing the gate, and a pin that names
// no finding any more fails the gate itself, so the file can only describe history and can never hide a new
// defect behind a broad rule. The dispositions it records are the ones docs/versioning.md already names: a real
// anchor defect waiting on a tag write (with the command in `repair`), or a shape this history really has (a
// hotfix landed on an older line) which the gate reports and the team has decided is not a defect.
export const PINS_FILE = "tools/version-tags-pins.json";
export const PIN_KINDS = ["backwards", "missing", "wrong-commit", "lightweight", "orphan-tag", "off-main"];

// A finding's identity. `sha` is the commit the finding is about (the declaring commit for missing,
// wrong-commit and backwards; the tagged commit for lightweight, orphan-tag and off-main). A wrong anchor also
// names the commit the tag resolved to, so a tag moved onto a different wrong commit is a NEW finding rather
// than the pinned one riding along.
export function findingIdentity(f) {
  const tagCommit = f.kind === "wrong-commit" ? String(f.tagCommit || "") : "";
  return [f.kind, f.version, f.sha, tagCommit].join("|");
}

// The file, validated rather than trusted. Every problem is named with its index, and a caller that finds any
// problem must exit 2: a gate that cannot read its own pins would judge fewer findings than it printed.
export function parsePins(text, { file = PINS_FILE } = {}) {
  const problems = [];
  let parsed;
  try {
    parsed = JSON.parse(String(text).replace(/^\uFEFF/, ""));
  } catch (e) {
    return { pins: [], problems: [`${file}: not JSON - ${e.message}`] };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { pins: [], problems: [`${file}: the file must be one JSON object with a "pins" array`] };
  }
  if (!Array.isArray(parsed.pins)) return { pins: [], problems: [`${file}: "pins" must be an array`] };
  const seen = new Set();
  const pins = [];
  parsed.pins.forEach((p, i) => {
    const at = `${file}: pins[${i}]`;
    if (!p || typeof p !== "object" || Array.isArray(p)) {
      problems.push(`${at} is not an object`);
      return;
    }
    const kind = String(p.kind || "");
    if (!PIN_KINDS.includes(kind)) {
      problems.push(`${at}: kind "${kind}" is not one of ${PIN_KINDS.join(", ")}`);
      return;
    }
    if (!/^\d+\.\d+\.\d+$/.test(String(p.version || ""))) {
      problems.push(`${at}: version must read <major>.<minor>.<patch>`);
      return;
    }
    if (!/^[0-9a-f]{40}$/.test(String(p.sha || ""))) {
      problems.push(`${at}: sha must be the full 40-character commit the finding is about`);
      return;
    }
    if (kind === "wrong-commit" && !/^[0-9a-f]{40}$/.test(String(p.tagCommit || ""))) {
      problems.push(`${at}: a wrong-commit pin must name the tagCommit it read, or a tag moved to another wrong commit would ride the same pin`);
      return;
    }
    const reason = String(p.reason || "").trim();
    if (reason.length < 24) {
      problems.push(`${at}: reason must say what the finding is and why it is pinned (one sentence at least)`);
      return;
    }
    const pin = {
      kind,
      version: String(p.version),
      sha: String(p.sha),
      tagCommit: kind === "wrong-commit" ? String(p.tagCommit) : "",
      reason,
      repair: p.repair ? String(p.repair) : null,
    };
    const id = findingIdentity(pin);
    if (seen.has(id)) {
      problems.push(`${at}: a second pin for the same finding (${id})`);
      return;
    }
    seen.add(id);
    pins.push(pin);
  });
  // A file with any problem yields NO pins at all, not the subset that happened to parse: a caller that judges
  // with half a pin file would pass findings it printed, and the one invariant worth enforcing here is that the
  // gate and the file agree or nothing is judged.
  return { pins: problems.length ? [] : pins, problems, note: parsed.note ? String(parsed.note) : null };
}

// Split what the gate computed into the findings a pin names (printed with their reason, not failing) and the
// ones nobody has named. A pin with no finding left is `stale`: the anchor it described was repaired, or the
// finding changed shape, and keeping it would hide the next finding that looks the same.
export function applyPins(findings, pins) {
  const byId = new Map(pins.map((p) => [findingIdentity(p), p]));
  const pinned = [];
  const live = [];
  for (const f of findings) {
    const pin = byId.get(findingIdentity(f));
    if (pin) pinned.push({ ...f, reason: pin.reason, repair: pin.repair });
    else live.push(f);
  }
  const used = new Set(pinned.map((p) => findingIdentity(p)));
  return { live, pinned, stale: pins.filter((p) => !used.has(findingIdentity(p))) };
}

// The default file is optional - a fixture repository has no pins and nothing to pin - but a file named on the
// command line is a claim that it exists, so a missing one is a problem rather than an empty pin set.
export function readPins(root, file = PINS_FILE, { required = false } = {}) {
  const at = path.isAbsolute(file) ? file : path.join(root, file);
  let text;
  try {
    text = readFileSync(at, "utf8");
  } catch (e) {
    if (e.code === "ENOENT" && !required) return { pins: [], problems: [], missing: true };
    return { pins: [], problems: [`${file}: cannot be read - ${e.message}`] };
  }
  return { ...parsePins(text, { file }), missing: false };
}

function parseArgs(argv) {
  const opt = { ref: "HEAD", main: "main", json: false, limit: 40, pins: PINS_FILE, pinsGiven: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--ref") opt.ref = String(argv[(i += 1)] || "HEAD");
    else if (a === "--main") opt.main = String(argv[(i += 1)] || "main");
    else if (a === "--json") opt.json = true;
    else if (a === "--limit") opt.limit = Math.max(0, Number(argv[(i += 1)]) || 0);
    else if (a === "--pins") {
      opt.pins = String(argv[(i += 1)] || "");
      opt.pinsGiven = true;
    } else if (a === "--help" || a === "-h") opt.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return opt;
}

function main(argv) {
  let opt;
  try {
    opt = parseArgs(argv);
  } catch (e) {
    console.error(`version-tags: ${e.message}`);
    return 2;
  }
  if (opt.help) {
    console.log("node tools/verify-version-tags.mjs [--ref <ref>] [--main <ref>] [--json] [--limit <n>] [--pins <file>]");
    console.log("  fails when a version bump in package.json's history has no annotated tag at its commit on origin,");
    console.log("  when a tag points at another commit, or when a number goes backwards - unless that exact finding is");
    console.log(`  pinned by name in ${PINS_FILE}, which is printed with its reason and does not fail. A pin that names`);
    console.log("  no finding any more (a stale pin) fails, so the file can never hide a new defect.");
    return 0;
  }

  const root = repoRoot(process.cwd());
  let history;
  const mainRef = opt.main || "main";
  try {
    history = readReleaseHistory({ root, ref: opt.ref, mainRef });
  } catch (e) {
    console.error(`version-tags: could not read the history of ${opt.ref}: ${String(e.stderr || e.message).trim()}`);
    return 2;
  }
  // Ancestry is the second half of the anchor: a tag is only readable if main carries its commit, and a gate
  // that cannot see main must say so rather than pass every tag by. Fail closed, like an unreadable origin.
  if (!history.main) {
    console.error(`version-tags: could not read ${mainRef}, so a tag's ancestry cannot be judged - nothing was checked`);
    return 2;
  }

  const versions = history.versions;
  // An empty walk is not a pass: it means the pathspec, the ref or the checkout is wrong, and a gate that
  // certifies nothing while printing PASS is worse than one that is red.
  if (!versions.length) {
    console.error(`version-tags: no version history found at ${opt.ref} - package.json's log came back empty`);
    return 2;
  }

  const remote = readRemoteTags(root);
  if (remote.kind === "error") {
    console.error(`version-tags: could not read origin's tags, so the anchor cannot be judged: ${remote.message}`);
    return 2;
  }
  const tagSource = remote.kind === "remote" ? "origin" : "checkout";
  const sourceTags = remote.kind === "remote" ? [...remote.tags.values()] : history.tags;
  const { versions: rawJudged, staleLocal } = judgeAnchors({
    versions,
    localTags: history.tags,
    remoteTags: remote.kind === "remote" ? sourceTags : null,
  });

  // What main carries, and which branch holds each tag main does not. `offMainTags` reads every tag once; the
  // judged anchors are joined to it by name, and an origin-only tag it did not see is measured here instead.
  const offMain = offMainTags(history, { root });
  const offByName = new Map(offMain.map((t) => [t.name, t]));
  const judged = rawJudged.map((v) => {
    if (!v.tag) return v;
    const onMain = history.main.commits.has(v.tag.commit);
    if (onMain) return { ...v, tag: { ...v.tag, onMain: true } };
    const known = offByName.get(v.tag.name);
    return { ...v, tag: { ...v.tag, onMain: false, branches: known ? known.branches : branchesHolding(root, v.tag.commit) } };
  });

  // The tags the walk cannot join: a live branch's pre-landing anchor, or a number no commit declares. Judged from
  // the same source as the anchors, so a tag this checkout never fetched is not silently held on nothing.
  const known = new Set(versions.map((v) => `v${v.version}`));
  const orphanTags = [];
  const unreadTags = [];
  for (const t of sourceTags) {
    if (!t.version || known.has(t.name)) continue;
    if (!hasCommit(root, t.commit)) {
      unreadTags.push(t);
      continue;
    }
    orphanTags.push({ ...t, declares: readVersionAtCommit(root, t.commit) === t.version });
  }

  const refusedOffMain = offMain.filter((t) => !t.release && t.branches && t.branches.length && orphanTags.some((o) => o.name === t.name));
  const findings = checkReleaseTags({ ...history, versions: judged, orphanTags, offMain });
  const held = orphanTags.filter((t) => t.declares === true && !refusedOffMain.some((o) => o.name === t.name));
  const first = versions[0];
  const last = versions[versions.length - 1];

  // Read the pins before printing anything: a file that does not parse is exit 2, because the gate would
  // otherwise print findings it had silently stopped counting.
  const pinsRead = readPins(root, opt.pins, { required: opt.pinsGiven });
  if (pinsRead.problems.length) {
    for (const p of pinsRead.problems) console.error(`version-tags: ${p}`);
    console.error("version-tags: the pin file could not be read, so nothing was judged");
    return 2;
  }
  const { live, pinned, stale } = applyPins(findings, pinsRead.pins);

  if (opt.json) {
    console.log(JSON.stringify({
      ref: history.ref,
      commit: history.commit,
      main: { ref: history.main.ref, commit: history.main.commit },
      tagSource,
      versions: versions.length,
      from: first ? first.version : null,
      to: last ? last.version : null,
      findings: live,
      pinned,
      stalePins: stale,
      pins: { file: opt.pins, present: !pinsRead.missing, count: pinsRead.pins.length },
      staleLocal,
      offMain: offMain.map((t) => ({ name: t.name, commit: t.commit, release: t.release, branches: t.branches })),
      held: held.map((t) => ({ name: t.name, version: t.version, commit: t.commit })),
      unread: unreadTags.map((t) => ({ name: t.name, commit: t.commit })),
      ok: live.length === 0 && stale.length === 0,
    }, null, 2));
    return live.length || stale.length ? 1 : 0;
  }

  const tagged = judged.filter((v) => v.tag && v.tag.commit === v.sha && v.tag.annotated).length;
  console.log(
    `version-tags: ${versions.length} version bump${versions.length === 1 ? "" : "s"} in package.json's history` +
      (first ? ` (v${first.version} .. v${last.version})` : "") +
      `, ${tagged} tagged and annotated at the commit that first declared them ` +
      (tagSource === "origin" ? "as origin publishes them" : "(read from this checkout: no origin remote)") +
      `, against ${history.main.ref} at ${String(history.main.commit).slice(0, 10)}`,
  );
  if (refusedOffMain.length) {
    console.log(
      `  ${refusedOffMain.length} tag${refusedOffMain.length === 1 ? "" : "s"} name a version ${opt.ref} does not carry ` +
        "and are held by a branch, on a commit main never carried (a refusable claim, listed below): " +
        refusedOffMain.slice(0, 6).map((t) => `${t.name}@${String(t.commit).slice(0, 8)}`).join(", ") +
        (refusedOffMain.length > 6 ? `, and ${refusedOffMain.length - 6} more` : ""),
    );
  }
  if (held.length) {
    const shown = held.slice(0, 6).map((t) => `${t.name}@${String(t.commit).slice(0, 8)}`).join(", ");
    console.log(
      `  ${held.length} tag${held.length === 1 ? "" : "s"} name a version ${opt.ref} does not carry yet, ` +
        `each at a commit whose package.json declares it and that no branch still holds (a fossil of a rewritten ` +
        `history, not a claim somebody can land): ${shown}` +
        (held.length > 6 ? `, and ${held.length - 6} more` : ""),
    );
  }
  if (unreadTags.length) {
    const shown = unreadTags.slice(0, 6).map((t) => t.name).join(", ");
    console.log(
      `  ${unreadTags.length} tag${unreadTags.length === 1 ? "" : "s"} on ${tagSource === "origin" ? "origin" : "the checkout"} ` +
        `name a version ${opt.ref} does not carry and their commits are not fetched - not judged: ${shown}` +
        (unreadTags.length > 6 ? `, and ${unreadTags.length - 6} more` : ""),
    );
  }
  if (staleLocal.length) {
    const shown = opt.limit ? staleLocal.slice(0, opt.limit) : staleLocal;
    console.log(`  ${staleLocal.length} local tag${staleLocal.length === 1 ? "" : "s"} disagree with origin - a stale checkout, not an anchor defect:`);
    for (const s of shown) console.log(`  ${s.kind.padEnd(12)} ${s.message}`);
    if (shown.length < staleLocal.length) console.log(`  ... and ${staleLocal.length - shown.length} more (--limit 0 prints all)`);
  }
  // The history that is named rather than silenced. Every pinned finding is printed with the reason a reader can
  // disagree with, and the count is here so a green gate never reads as "nothing was found".
  if (pinned.length) {
    console.log(
      `  ${pinned.length} historical finding${pinned.length === 1 ? "" : "s"} ${pinned.length === 1 ? "is" : "are"} pinned by name in ${opt.pins}: ` +
        "each is listed with the reason it is not a defect, or the tag write it waits on. A pin that names no finding fails this gate.",
    );
    for (const p of pinned) {
      console.log(`  ${"pinned".padEnd(12)} ${p.message}`);
      console.log(`  ${"".padEnd(12)} why: ${p.reason}`);
      if (p.repair) console.log(`  ${"".padEnd(12)} repair: ${p.repair}`);
    }
    console.log("");
  }
  if (stale.length) {
    for (const p of stale) {
      console.log(
        `  ${"stale-pin".padEnd(12)} ${p.kind} v${p.version} at ${p.sha.slice(0, 10)} is pinned in ${opt.pins} and no finding matches it any more - ` +
          "remove the pin (the anchor it described was repaired) or correct its kind, commit or tag commit",
      );
    }
    console.log("");
  }
  if (live.length) {
    const shown = opt.limit ? live.slice(0, opt.limit) : live;
    for (const f of shown) console.log(`  ${f.kind.padEnd(12)} ${f.message}`);
    if (shown.length < live.length) console.log(`  ... and ${live.length - shown.length} more (--limit 0 prints all)`);
    console.log("");
    const missing = live.filter((f) => f.kind === "missing");
    if (missing.length) {
      console.log("  Tag the commit that declared each number - annotated, with the version as its message:");
      console.log(`    git tag -a v${missing[0].version} ${missing[0].sha.slice(0, 10)} -m "v${missing[0].version}"`);
      console.log("  then re-render the changelog with npm run changelog and push the tags with git push origin --tags.");
      console.log("");
    }
    if (refusedOffMain.length) {
      console.log("  A tag main never carried is settled one of two ways, and neither is silence:");
      console.log("    git tag -f -a <tag> <commit main carries> -m \"<tag>\" && git push --force origin <tag>");
      console.log("    git push origin :refs/tags/<tag> && git tag -d <tag>   # and name the branch that held it");
      console.log("");
    }
  }
  // A stale pin fails on its own: it is a permission for a finding that no longer exists, and leaving it would
  // hand the same permission to the next finding of that shape.
  const fails = live.length + stale.length;
  if (fails) {
    console.log(
      `FAIL - ${fails} finding${fails === 1 ? "" : "s"} across ${versions.length} version bumps` +
        (stale.length ? ` (${live.length} unpinned, ${stale.length} stale pin${stale.length === 1 ? "" : "s"})` : "") +
        (pinned.length ? `, ${pinned.length} pinned by name and not counted here` : ""),
    );
    return 1;
  }
  console.log(
    (tagSource === "origin" ? "  every bump carries an annotated tag at its own commit on origin" : "  every bump carries an annotated tag at its own commit") +
      `, every tag names a commit ${history.main.ref} carries, and no v<version> tag points elsewhere`,
  );
  if (pinned.length) {
    console.log(
      `  ${pinned.length} historical finding${pinned.length === 1 ? "" : "s"} ${pinned.length === 1 ? "is" : "are"} pinned by name in ${opt.pins} and printed above - ` +
        "nothing unpinned remains, and a pin that stops naming a finding will fail this gate",
    );
  }
  console.log("PASS");
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
