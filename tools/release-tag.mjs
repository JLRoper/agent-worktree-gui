#!/usr/bin/env node
// tools/release-tag.mjs — the post-merge move of a release's annotated tag, as one step the landing runs.
//
// WHY: a rebase merge RE-CREATES the branch's commits on main with new shas, so the `v<version>` tag
// `version.mjs apply` put on the branch's bump commit names a commit main does not carry. Nothing noticed until
// the anchor gate read origin: `wrong-commit v1.66.6 points at e0a2875958 on origin, but 1.66.6 first appeared at
// d11bb9bf01`, and the repair was two commands the landing agent had to remember after the landing had already
// been called finished — `node tools/version.mjs tag --ref origin/main --force` and
// `git push origin v1.66.6 --force`. A rule in a document is not a pipeline. This is the step tools/land.mjs and
// tools/land-pr.mjs run after the merge, so a landing whose tag a rebase orphaned ends on the gate's own PASS
// with nobody's hand in it.
//
// THE NUMBER comes from the tree the landing just produced (package.json at the ref the landing moved to), and
// the COMMIT comes from the walk the gate judges (tools/release-history.mjs): the first commit whose patch writes
// that number to the version line. Tagging the ref's tip instead is the mis-anchor that put v1.5.0 on a changelog
// render commit, and it is the mistake this module exists not to repeat.
//
// ORIGIN IS THE TRUTH, exactly as it is for the gate, and the tags are parsed by the gate's own parser
// (tools/verify-version-tags.mjs) so the landing cannot disagree with the check that judges it:
//
//   already right   origin carries v<version>, annotated, at the declaring commit -> nothing is written and
//                   nothing is force-pushed; this is what makes a second landing run a no-op
//   wrong commit    origin carries it at another commit -> recreated annotated at the declaring commit and
//                   pushed --force: the move a rebase merge owes
//   never pushed    only this checkout carries it, or nothing does -> created and pushed
//   stale checkout  origin is right and this checkout disagrees -> the local ref is refreshed, origin untouched
//
// WHAT IT WILL NOT DO: move a tag to a commit the base's history does not show declaring the number (a merge
// resolution or a shallow clone can leave a tree with no commit that wrote it — the tool refuses and says what it
// looked for), guess a number, or delete a tag. A refusal writes nothing.
//
//   node tools/release-tag.mjs [--ref <ref>] [--remote <name>] [--no-push] [--dry-run]
//
// Idempotent: a second run finds the anchor right, prints it and changes nothing; --dry-run says what it would do.
// Exit codes: 0 the anchor is where the gate wants it (created, moved, or already right); 1 it is not, and the
// message says why; 2 the arguments or the repository could not be read.

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findDeclaration, readTags, repoRoot } from "./release-history.mjs";
import { parseRemoteTags } from "./verify-version-tags.mjs";

const DASHED = "\u2014"; // the separator the landing's other lines print
const short = (sha) => String(sha || "").slice(0, 10);

// ---------- git, quietly: a read that fails is an answer, a write that fails is the whole answer ----------

function gitRun(root, args, { timeout = 120000 } = {}) {
  try {
    const out = execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return { ok: true, out: out.trim(), err: "" };
  } catch (e) {
    return { ok: false, out: String(e.stdout || "").trim(), err: String(e.stderr || e.message || "").trim() };
  }
}

function versionAt(root, ref) {
  const shown = gitRun(root, ["show", `${ref}:package.json`]);
  if (!shown.ok) return null;
  try {
    const v = JSON.parse(shown.out).version;
    return v == null ? null : String(v).trim() || null;
  } catch {
    return null;
  }
}

// What the remote publishes, or why it cannot be asked. `none` is a repository with no such remote (a local-only
// clone, a fixture): the checkout is then the only source there is, and the caller is told so. `error` is a remote
// that is configured but unreadable — at that point nothing can be proved about the anchor.
export function readRemoteTagMap(root, remote) {
  if (!remote) return { kind: "none", reason: "no remote named" };
  if (!gitRun(root, ["remote", "get-url", remote]).ok) return { kind: "none", reason: `no remote named ${remote}` };
  const raw = gitRun(root, ["ls-remote", "--tags", remote]);
  if (!raw.ok) return { kind: "error", message: raw.err || raw.out || `git ls-remote ${remote} failed` };
  return { kind: "remote", tags: parseRemoteTags(raw.out) };
}

// One annotated tag, carrying the two lines every tag in this repo carries: the number, and where it first
// appeared. The message is rewritten on a move on purpose — a tag whose message still names the pre-merge sha is
// a record that reads like the branch, not like main.
function createTag(root, version, commit, { force = false } = {}) {
  const subject = gitRun(root, ["log", "-1", "--format=%s", commit]).out || "";
  return gitRun(root, [
    "tag", ...(force ? ["-f"] : []), "-a", `v${version}`, commit,
    "-m", `v${version}`,
    "-m", `package.json first carried ${version} at ${short(commit)} (${subject})`,
  ]);
}

// ---------- the pure half: where does this release's anchor belong ----------

// The decision, with every input named, so the states are pinned by test/land.test.js without building a
// repository for each one. `declared` is the walk's first-appearance record (or null); `remoteTag`/`localTag` are
// the peeled tag objects, annotated flags included. `action` is what the writer does: nothing for `current`,
// recreate-and-push for `create`/`move`, nothing-written for `refuse`.
export function planTagMove({ version, ref = "HEAD", declared, remoteTag = null, localTag = null, remote = null }) {
  const where = remote || "this tree";
  if (!version) {
    return { action: "refuse", why: `${ref} carries no readable package.json "version" ${DASHED} there is no number to anchor` };
  }
  if (!declared) {
    return {
      action: "refuse",
      why:
        `no commit reachable from ${ref} first declares ${version} ${DASHED} the tree showing the number is not the ` +
        "same thing as its history carrying it, so a tag here would name a commit that never wrote it",
    };
  }
  const commit = declared.sha;
  // With a remote, origin's ref is the anchor the gate reads; without one the checkout's own ref is all there is.
  const anchor = remote ? remoteTag : localTag;
  if (anchor && anchor.commit === commit && anchor.annotated) {
    return { action: "current", commit, why: `v${version} is already at ${short(commit)} on ${where} ${DASHED} the commit that first declared it` };
  }
  if (anchor && anchor.commit === commit) {
    return {
      action: "move",
      commit,
      why: `v${version} names the right commit on ${where} but is a lightweight tag ${DASHED} recreating it annotated at ${short(commit)}`,
    };
  }
  if (anchor) {
    return {
      action: "move",
      commit,
      why:
        `v${version} points at ${short(anchor.commit)} on ${where}, but ${version} first appeared at ` +
        `${short(commit)} ${DASHED} the move the rebase merge owes`,
    };
  }
  if (localTag) {
    return {
      action: "create",
      commit,
      why:
        `v${version} is at ${short(localTag.commit)} in this checkout and ${where} carries no such tag ${DASHED} ` +
        `anchoring it at ${short(commit)}, which first declared ${version}`,
    };
  }
  return { action: "create", commit, why: `${version} first appeared at ${short(commit)} and carries no tag ${DASHED} anchoring it there` };
}

// ---------- the write ----------

// Move (or create) the anchor for the version the ref's tree declares, then prove it by reading the remote back.
// `remote: null` is local-only: the tag is created in this checkout and nothing is pushed. Every failure returns
// with `ok: false` and an `error` that names what git said — never a silent success.
export function moveReleaseTag({ root = process.cwd(), ref = "HEAD", remote = "origin", push = true, dryRun = false } = {}) {
  const notes = [];
  const fail = (error, extra = {}) => ({ ok: false, action: "refuse", version: null, commit: null, moved: false, pushed: false, notes, error, ...extra });

  let at;
  try {
    at = repoRoot(root);
  } catch {
    return fail("not inside a git repository");
  }

  const tipRes = gitRun(at, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  if (!tipRes.ok) return fail(`${ref} is not a commit in this repository`);
  const tip = tipRes.out;

  const version = versionAt(at, tip);
  let found;
  try {
    found = version ? findDeclaration({ root: at, ref: tip, version }) : { declaration: null };
  } catch (e) {
    return fail(`could not walk package.json's history at ${ref} ${DASHED} ${String(e.stderr || e.message || "").trim()}`);
  }

  const remoteRead = readRemoteTagMap(at, remote);
  if (remoteRead.kind === "error") {
    return fail(
      `could not read ${remote}'s tags, so the anchor cannot be judged: ${remoteRead.message}. Nothing was written.`,
    );
  }
  let localTags;
  try {
    localTags = readTags(at);
  } catch (e) {
    return fail(`could not read this checkout's tags ${DASHED} ${String(e.stderr || e.message || "").trim()}`);
  }
  const localTag = version ? localTags.find((t) => t.name === `v${version}`) || null : null;
  const remoteTag = version && remoteRead.kind === "remote" ? remoteRead.tags.get(`v${version}`) || null : null;

  const plan = planTagMove({ version, ref, declared: found.declaration, remoteTag, localTag, remote: remoteRead.kind === "remote" ? remote : null });
  const base = { version, commit: plan.commit || null, moved: false, pushed: false };

  if (plan.action === "refuse") return { ok: false, action: "refuse", notes, error: plan.why, ...base };

  // Already right on the remote. A clone whose own ref disagrees is refreshed without a force-push: origin is the
  // anchor, and a push here would be the very move this branch exists to stop making by hand.
  if (plan.action === "current") {
    if (localTag && (localTag.commit !== plan.commit || !localTag.annotated) && !dryRun) {
      const refreshed = createTag(at, version, plan.commit, { force: true });
      if (!refreshed.ok) return { ok: false, action: "current", notes, error: `git tag refused ${DASHED} ${refreshed.err}`, ...base };
      notes.push(`this checkout's v${version} named ${short(localTag.commit)}; refreshed to ${short(plan.commit)} (origin untouched)`);
    }
    notes.push(plan.why);
    return { ok: true, action: "current", version, commit: plan.commit, moved: false, pushed: false, notes };
  }

  if (dryRun) {
    notes.push(`would ${plan.action === "move" ? "move" : "create"} v${version} at ${short(plan.commit)}${remoteRead.kind === "remote" ? ` on ${remote}` : " in this checkout"} ${DASHED} nothing was written`);
    return { ok: true, action: "dry-run", notes, ...base };
  }

  const made = createTag(at, version, plan.commit, { force: Boolean(localTag) });
  if (!made.ok) return { ok: false, action: plan.action, notes, error: `git tag refused ${DASHED} ${made.err}`, ...base };

  const previous = remoteTag ? short(remoteTag.commit) : localTag ? short(localTag.commit) : null;
  if (!remote || !push) {
    notes.push(
      `v${version} is at ${short(plan.commit)} in this checkout; not pushed (${remote ? "--no-push" : "no remote"})`,
    );
    return { ok: true, action: plan.action, version, commit: plan.commit, moved: true, pushed: false, notes };
  }

  // `--force` exactly when the remote already carries the ref: creating a tag is a plain push, and moving one is
  // the post-merge move of a claim this landing already owns.
  const sent = gitRun(at, ["push", ...(remoteTag ? ["--force"] : []), remote, `refs/tags/v${version}`]);
  if (!sent.ok) {
    return {
      ok: false, action: plan.action, notes, moved: true, pushed: false, ...{ version, commit: plan.commit },
      error: `the tag was anchored at ${short(plan.commit)} but the push to ${remote} refused ${DASHED} ${sent.err}. Nothing on the remote reserves this anchor.`,
    };
  }

  // Read it back. A push that returned 0 is git's claim; the anchor the gate reads is what ls-remote shows.
  const after = readRemoteTagMap(at, remote);
  if (after.kind !== "remote") {
    return {
      ok: false, action: plan.action, notes, moved: true, pushed: true, version, commit: plan.commit,
      error: `the push returned, but ${remote} could not be read back ${DASHED} ${after.message || after.reason || "unknown error"}`,
    };
  }
  const landed = after.tags.get(`v${version}`) || null;
  if (!landed || landed.commit !== plan.commit || !landed.annotated) {
    return {
      ok: false, action: plan.action, notes, moved: true, pushed: true, version, commit: plan.commit,
      error:
        `${remote} reads ${landed ? `${landed.annotated ? "an" : "a lightweight"} tag at ${short(landed.commit)}` : "no such tag"}` +
        `, not an annotated tag at ${short(plan.commit)} ${DASHED} the push did not land`,
    };
  }

  notes.push(
    `${previous ? `moved ${previous} -> ${short(plan.commit)}` : `created at ${short(plan.commit)}`} on ${remote}` +
      `${remoteTag ? " (--force)" : ""} ${DASHED} the commit that first declared ${version}`,
  );
  return { ok: true, action: plan.action, version, commit: plan.commit, moved: true, pushed: true, notes };
}

// ---------- the CLI ----------

const USAGE = [
  "node tools/release-tag.mjs [--ref <ref>] [--remote <name>] [--no-push] [--dry-run]",
  "  move the release tag for the version <ref>'s tree declares onto the commit that first declared it,",
  "  and push it, so an anchor a rebase merge orphaned is back where verify-version-tags reads it.",
  "  --ref <ref>      the commit whose package.json names the release (default HEAD)",
  "  --remote <name>  the remote whose tags are the truth (default origin)",
  "  --no-push        anchor it in this checkout only; nothing is sent",
  "  --dry-run        say what it would do, write nothing",
];

function main(argv) {
  const opt = { ref: "HEAD", remote: "origin", push: true, dryRun: false };
  try {
    for (let i = 0; i < argv.length; i += 1) {
      const a = argv[i];
      if (a === "--ref") opt.ref = String(argv[(i += 1)] || "HEAD");
      else if (a === "--remote") opt.remote = String(argv[(i += 1)] || "origin");
      else if (a === "--no-push") opt.push = false;
      else if (a === "--dry-run") opt.dryRun = true;
      else if (a === "--help" || a === "-h") {
        for (const line of USAGE) console.log(line);
        return 0;
      } else {
        console.error(`tag: unknown argument: ${a}`);
        return 2;
      }
    }
  } catch (e) {
    console.error(`tag: ${e.message}`);
    return 2;
  }

  const res = moveReleaseTag({
    root: process.cwd(),
    ref: opt.ref,
    remote: opt.push ? opt.remote : null,
    push: opt.push,
    dryRun: opt.dryRun,
  });
  for (const line of res.notes) console.log(`tag: ${line}`);
  if (!res.ok) {
    console.error(`tag: FAILED ${DASHED} ${res.error}`);
    return 1;
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
