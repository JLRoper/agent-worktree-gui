#!/usr/bin/env node
// tools/verify-version-tags.mjs — a version bump with no tag fails this gate.
//
// WHY: the version anchors a build to a commit. A reader running an old tab (the board's config line says
// which build) can only ask "what changed between mine and now" if each number names a commit, and a
// CHANGELOG rendered between tags is only as truthful as the tags it reads. The walk in
// tools/release-history.mjs already knows where every version first appeared; this gate asks git whether a
// tag says the same thing.
//
// Four findings, all of them failures:
//   missing       package.json's history first declared <version> at <sha>, and no v<version> tag exists
//   wrong-commit  the tag exists but resolves to another commit — the anchor points at the wrong history
//   lightweight   the tag exists at the right commit but carries no message; an annotated tag records the
//                 version, its date and a line of why, and survives a clone as an object of its own
//   orphan-tag    a v<major>.<minor>.<patch> tag names a version package.json never held
// A version that goes BACKWARDS in history is reported too: the tag would still exist, but no reader could
// order the two.
//
//   node tools/verify-version-tags.mjs                 check HEAD
//   node tools/verify-version-tags.mjs --ref <ref>     check another ref (a tag, a commit, origin/main)
//   node tools/verify-version-tags.mjs --json          one JSON object on stdout
//   node tools/verify-version-tags.mjs --limit <n>     how many findings to print (default 40; 0 = all)
//
// Exit codes: 0 every bump is tagged and every tag is right; 1 at least one finding; 2 the check could not run.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { readReleaseHistory } from "./release-history.mjs";

// The gate's logic, separated from git and from the terminal so a test can drive every kind of finding
// without building a repository. `versions` is the first appearance of each number, oldest first; `transitions`
// is every change to the version line, which is where a number that went backwards shows up.
export function checkReleaseTags({ versions, transitions = versions, orphanTags = [] }) {
  const findings = [];
  let previous = null;
  for (const v of transitions) {
    if (previous) {
      const [a, b] = [previous.version.split(".").map(Number), v.version.split(".").map(Number)];
      const backwards = b[0] < a[0] || (b[0] === a[0] && (b[1] < a[1] || (b[1] === a[1] && b[2] < a[2])));
      if (backwards) {
        findings.push({
          kind: "backwards",
          version: v.version,
          sha: v.sha,
          message: `package.json goes backwards: ${previous.version} -> ${v.version} at ${v.sha.slice(0, 10)}`,
        });
      }
    }
    previous = v;
  }
  for (const v of versions) {
    if (!v.tag) {
      findings.push({
        kind: "missing",
        version: v.version,
        sha: v.sha,
        date: v.date,
        subject: v.subject,
        message: `v${v.version} is not tagged — first declared at ${v.sha.slice(0, 10)} (${v.date}) ${v.subject}`,
      });
    } else if (v.tag.commit !== v.sha) {
      findings.push({
        kind: "wrong-commit",
        version: v.version,
        sha: v.sha,
        tagCommit: v.tag.commit,
        message: `v${v.version} points at ${String(v.tag.commit).slice(0, 10)}, but ${v.version} first appeared at ${v.sha.slice(0, 10)}`,
      });
    } else if (!v.tag.annotated) {
      findings.push({
        kind: "lightweight",
        version: v.version,
        sha: v.sha,
        message: `v${v.version} is a lightweight tag — recreate it with git tag -a v${v.version} ${v.sha.slice(0, 10)} -m "v${v.version}"`,
      });
    }
  }
  for (const t of orphanTags) {
    findings.push({
      kind: "orphan-tag",
      version: t.version,
      sha: t.commit,
      message: `${t.name} points at ${String(t.commit).slice(0, 10)}, where package.json does not declare ${t.version}`,
    });
  }
  return findings;
}

function parseArgs(argv) {
  const opt = { ref: "HEAD", json: false, limit: 40 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--ref") opt.ref = String(argv[(i += 1)] || "HEAD");
    else if (a === "--json") opt.json = true;
    else if (a === "--limit") opt.limit = Math.max(0, Number(argv[(i += 1)]) || 0);
    else if (a === "--help" || a === "-h") opt.help = true;
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
    console.log("node tools/verify-version-tags.mjs [--ref <ref>] [--json] [--limit <n>]");
    console.log("  fails when a version bump in package.json's history has no annotated tag at its commit.");
    return 0;
  }

  let history;
  try {
    history = readReleaseHistory({ root: process.cwd(), ref: opt.ref });
  } catch (e) {
    console.error(`version-tags: could not read the history of ${opt.ref}: ${String(e.stderr || e.message).trim()}`);
    return 2;
  }

  const versions = history.versions;
  // An empty walk is not a pass: it means the pathspec, the ref or the checkout is wrong, and a gate that
  // certifies nothing while printing PASS is worse than one that is red.
  if (!versions.length) {
    console.error(`version-tags: no version history found at ${opt.ref} — package.json's log came back empty`);
    return 2;
  }
  const findings = checkReleaseTags(history);
  const first = versions[0];
  const last = versions[versions.length - 1];

  if (opt.json) {
    console.log(JSON.stringify({
      ref: history.ref,
      commit: history.commit,
      versions: versions.length,
      from: first ? first.version : null,
      to: last ? last.version : null,
      findings,
      ok: findings.length === 0,
    }, null, 2));
    return findings.length ? 1 : 0;
  }

  const tagged = versions.filter((v) => v.tag && v.tag.commit === v.sha && v.tag.annotated).length;
  console.log(
    `version-tags: ${versions.length} version bump${versions.length === 1 ? "" : "s"} in package.json's history` +
      (first ? ` (v${first.version} .. v${last.version})` : "") +
      `, ${tagged} tagged and annotated at the commit that first declared them`,
  );
  if (findings.length) {
    const shown = opt.limit ? findings.slice(0, opt.limit) : findings;
    for (const f of shown) console.log(`  ${f.kind.padEnd(12)} ${f.message}`);
    if (shown.length < findings.length) console.log(`  … and ${findings.length - shown.length} more (--limit 0 prints all)`);
    console.log("");
    const missing = findings.filter((f) => f.kind === "missing");
    if (missing.length) {
      console.log("  Tag the commit that declared each number — annotated, with the version as its message:");
      console.log(`    git tag -a v${missing[0].version} ${missing[0].sha.slice(0, 10)} -m "v${missing[0].version}"`);
      console.log("  then re-render the changelog with npm run changelog and push the tags with git push origin --tags.");
      console.log("");
    }
    console.log(`FAIL — ${findings.length} finding${findings.length === 1 ? "" : "s"} across ${versions.length} version bumps`);
    return 1;
  }
  console.log("  every bump carries an annotated tag at its own commit, and no v<version> tag points elsewhere");
  console.log("PASS");
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
