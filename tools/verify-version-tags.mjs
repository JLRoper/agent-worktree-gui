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
//   wrong-commit  origin's tag resolves to another commit — the anchor points at the wrong history
//   lightweight   origin's tag is at the right commit but carries no message; an annotated tag records the
//                 version, its date and a line of why, and survives a clone as an object of its own
//   orphan-tag    a v<major>.<minor>.<patch> tag names a version package.json never held — read at the commit
//                 the tag names, so the finding is about that commit and not about the ref's history. A tag for
//                 a version this ref has not carried yet, at a commit whose package.json DOES declare it, is a
//                 pre-landing anchor held by its branch and is not a finding: the branch carries the tag so this
//                 gate can read it, and the landing moves it onto the commit main carries.
//   stale-local   (warning, exit 0) this checkout's v<version> ref disagrees with origin's. The gate judged
//                 origin; the next `git fetch --tags --force` refreshes the checkout. Not an anchor defect:
//                 reporting it as wrong-commit is what hid six correct anchors behind a stale clone.
// A version that goes BACKWARDS in history is reported too: the tag would still exist, but no reader could
// order the two.
//
//   node tools/verify-version-tags.mjs                 check HEAD
//   node tools/verify-version-tags.mjs --ref <ref>     check another ref (a tag, a commit, origin/main)
//   node tools/verify-version-tags.mjs --json          one JSON object on stdout
//   node tools/verify-version-tags.mjs --limit <n>     how many findings to print (default 40; 0 = all)
//
// Exit codes: 0 every bump is tagged and every tag is right; 1 at least one finding; 2 the check could not run
// (including an origin that is configured but unreadable — a gate that cannot see the remote says so).

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseVersionTag, readReleaseHistory, readVersionAtCommit, repoRoot } from "./release-history.mjs";

// The gate's logic, separated from git and from the terminal so a test can drive every kind of finding
// without building a repository. `versions` is the first appearance of each number, oldest first; `transitions`
// is every change to the version line, which is where a number that went backwards shows up. `tag` is the anchor
// the gate judged — origin's, when origin was read — and `localTag` is only set in that mode: it is the checkout's
// ref, used to explain a finding and to raise `stale-local`, never to decide one.
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
    const where = v.tag && v.tag.remote ? "origin" : "this checkout";
    if (!v.tag) {
      findings.push({
        kind: "missing",
        version: v.version,
        sha: v.sha,
        date: v.date,
        subject: v.subject,
        message:
          `v${v.version} is not tagged — first declared at ${v.sha.slice(0, 10)} (${v.date}) ${v.subject}` +
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
        message:
          `v${v.version} points at ${String(v.tag.commit).slice(0, 10)} on ${where}, but ${v.version} first appeared at ${v.sha.slice(0, 10)}` +
          (v.localTag && v.localTag.commit === v.sha
            ? ` — this checkout's tag already names that commit and was never pushed: git push --force origin v${v.version}`
            : ""),
      });
    } else if (!v.tag.annotated) {
      findings.push({
        kind: "lightweight",
        version: v.version,
        sha: v.sha,
        message: `v${v.version} is a lightweight tag on ${where} — recreate it with git tag -a v${v.version} ${v.sha.slice(0, 10)} -m "v${v.version}" and push --force`,
      });
    }
  }
  for (const t of orphanTags) {
    // `declares` is what package.json at the tagged commit says (tools/release-history.mjs). A tag whose own
    // commit carries the number anchors a version this ref has not landed yet — held on a branch, not a false
    // claim. It is still a tag, so a message-less one is reported: held does not excuse a lightweight anchor.
    if (t.declares === true) {
      if (t.annotated === false) {
        findings.push({
          kind: "lightweight",
          version: t.version,
          sha: t.commit,
          message: `${t.name} is a lightweight tag at ${String(t.commit).slice(0, 10)} — recreate it with git tag -a ${t.name} ${String(t.commit).slice(0, 10)} -m "${t.name}"`,
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
    console.log("  fails when a version bump in package.json's history has no annotated tag at its commit on origin.");
    return 0;
  }

  const root = repoRoot(process.cwd());
  let history;
  try {
    history = readReleaseHistory({ root, ref: opt.ref });
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

  const remote = readRemoteTags(root);
  if (remote.kind === "error") {
    console.error(`version-tags: could not read origin's tags, so the anchor cannot be judged: ${remote.message}`);
    return 2;
  }
  const tagSource = remote.kind === "remote" ? "origin" : "checkout";
  const sourceTags = remote.kind === "remote" ? [...remote.tags.values()] : history.tags;
  const { versions: judged, staleLocal } = judgeAnchors({
    versions,
    localTags: history.tags,
    remoteTags: remote.kind === "remote" ? sourceTags : null,
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

  const findings = checkReleaseTags({ ...history, versions: judged, orphanTags });
  const held = orphanTags.filter((t) => t.declares === true);
  const first = versions[0];
  const last = versions[versions.length - 1];

  if (opt.json) {
    console.log(JSON.stringify({
      ref: history.ref,
      commit: history.commit,
      tagSource,
      versions: versions.length,
      from: first ? first.version : null,
      to: last ? last.version : null,
      findings,
      staleLocal,
      held: held.map((t) => ({ name: t.name, version: t.version, commit: t.commit })),
      unread: unreadTags.map((t) => ({ name: t.name, commit: t.commit })),
      ok: findings.length === 0,
    }, null, 2));
    return findings.length ? 1 : 0;
  }

  const tagged = judged.filter((v) => v.tag && v.tag.commit === v.sha && v.tag.annotated).length;
  console.log(
    `version-tags: ${versions.length} version bump${versions.length === 1 ? "" : "s"} in package.json's history` +
      (first ? ` (v${first.version} .. v${last.version})` : "") +
      `, ${tagged} tagged and annotated at the commit that first declared them ` +
      (tagSource === "origin" ? "as origin publishes them" : "(read from this checkout: no origin remote)"),
  );
  if (held.length) {
    const shown = held.slice(0, 6).map((t) => `${t.name}@${String(t.commit).slice(0, 8)}`).join(", ");
    console.log(
      `  ${held.length} tag${held.length === 1 ? "" : "s"} name a version ${opt.ref} does not carry yet, ` +
        `each at a commit whose package.json declares it (held on a branch): ${shown}` +
        (held.length > 6 ? `, and ${held.length - 6} more` : ""),
    );
  }
  if (unreadTags.length) {
    const shown = unreadTags.slice(0, 6).map((t) => t.name).join(", ");
    console.log(
      `  ${unreadTags.length} tag${unreadTags.length === 1 ? "" : "s"} on ${tagSource === "origin" ? "origin" : "the checkout"} ` +
        `name a version ${opt.ref} does not carry and their commits are not fetched — not judged: ${shown}` +
        (unreadTags.length > 6 ? `, and ${unreadTags.length - 6} more` : ""),
    );
  }
  if (staleLocal.length) {
    const shown = opt.limit ? staleLocal.slice(0, opt.limit) : staleLocal;
    console.log(`  ${staleLocal.length} local tag${staleLocal.length === 1 ? "" : "s"} disagree with origin — a stale checkout, not an anchor defect:`);
    for (const s of shown) console.log(`  ${s.kind.padEnd(12)} ${s.message}`);
    if (shown.length < staleLocal.length) console.log(`  … and ${staleLocal.length - shown.length} more (--limit 0 prints all)`);
  }
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
  console.log(
    (tagSource === "origin" ? "  every bump carries an annotated tag at its own commit on origin" : "  every bump carries an annotated tag at its own commit") +
      ", and no v<version> tag points elsewhere",
  );
  console.log("PASS");
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
