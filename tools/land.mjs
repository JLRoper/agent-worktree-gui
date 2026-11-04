#!/usr/bin/env node
// tools/land.mjs — the landing's LAST step: render the changelog on the base branch, commit it, publish it.
//
// WHY: the render used to be a second step a landing agent had to remember ("now run npm run changelog, commit
// it, push it"). A rule in a document is not a pipeline: landings finished with a CHANGELOG that named every
// release but the one that had just landed, `npm run changelog:check` stayed red, and the next reader found a
// release with no section. This is the command the landing path runs instead, and it is the whole step:
//
//   node tools/land.mjs              on the base branch, after the merge: render, commit if it changed, push, prove
//   node tools/land.mjs --check      render in memory; exit 1 when the base's changelog is stale (writes nothing)
//   node tools/land.mjs --render     render only, in whatever tree you are in — the BRANCH case, where the sections
//                                    describe versions the base ALREADY carries and the landing's own section has
//                                    to wait for the merge
//
// The rules out of docs/versioning.md shape it, and they are enforced here rather than remembered:
//
//   - THE RENDER IS POST-MERGE, and is never folded into the bump commit. Every section links shas, and a rebase
//     or squash merge re-creates the branch's commits on the base with new ones — so a section written on the
//     branch lists links that 404 for the reader. The base commit is refused when HEAD is behind the base or the
//     tree is dirty; a branch render is written but warned about, because its newest sections name commits the
//     base does not carry and must be re-rendered after the merge. `--check` is the gate and writes nothing.
//
//   - A RENDER SPENDS NO VERSION: it is a docs commit — no bump, no tag. `.githooks/pre-push` refuses a push whose
//     branch did not bump (and refuses a base push whose changelog is stale), so this tool passes --no-verify only
//     when every commit it is sending touches nothing but CHANGELOG.md, and prints that line instead of leaving
//     the bypass silent.
//
// Idempotent by construction: the render is compared with the file before anything is written, so a second run
// finds it current, commits nothing, pushes nothing and leaves the tree clean. The decision is one pure function
// (landPlan) so the states below are pinned by test/land.test.js without building a repository for each one.

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderRepo } from "./changelog.mjs";
import { repoRoot } from "./release-history.mjs";

export const FILE = "CHANGELOG.md";

function git(root, args) {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60000,
    maxBuffer: 64 * 1024 * 1024,
  }).trim();
}

function gitOk(root, args) {
  try {
    return git(root, args);
  } catch {
    return null;
  }
}

// ---------- the pure half: what state is this landing in ----------

// The versions the file already names, in file order (newest first). A section header is the only thing this
// reads: the renderer writes `## v<version> — <date> · <n> commits`, and nothing else in the file starts a line
// that way.
export function parseSections(text) {
  const out = [];
  for (const m of String(text || "").matchAll(/^## v(\d+\.\d+\.\d+)\b/gm)) out.push(m[1]);
  return out;
}

// The releases the file does not name yet. A version missing from the MIDDLE is stale too, not only the newest —
// a hand-deleted section is the same red check as a missing release.
export function missingReleases(releases, diskText) {
  const named = new Set(parseSections(diskText));
  return releases.filter((r) => !named.has(r.version));
}

// The commits a render would name that the base does not carry — the versioning.md defect, as a list. `isAncestor`
// is injected so the rule is testable without a repository: (sha) -> boolean.
export function foreignCommits(releases, isAncestor) {
  const out = [];
  for (const r of releases) {
    for (const c of r.commits) {
      if (!isAncestor(c.sha)) out.push({ version: r.version, sha: c.sha, subject: c.subject });
    }
  }
  return out;
}

// The decision, with every input named. `action` is what the CLI does; `why` is the sentence it prints. Keeping
// this pure is what lets the test suite prove the refusals without a dirty tree, a moved remote and a branch in
// one run each. `onBase` decides which ancestry question matters: on the base, HEAD IS the base, so a commit the
// base carries cannot be foreign; on a branch the base is a separate ref and the newest sections are checked
// against it.
export function landPlan({ onBase, base, clean, behind, changed, missing, foreign, mode }) {
  if (!clean) {
    return {
      action: "refuse",
      why: "the tree is not clean — the render is one commit of one file, and a dirty tree cannot show that the commit is the whole of it",
    };
  }
  if (behind > 0) {
    return {
      action: "refuse",
      why:
        `HEAD is ${behind} commit${behind === 1 ? "" : "s"} behind ${base} — a render made against a base that has moved names the wrong history; ` +
        `bring the base up first (git fetch && git merge --ff-only on the base) and run again`,
    };
  }
  if (onBase && foreign.length) {
    return {
      action: "refuse",
      why: `this render names ${foreign.length} commit${foreign.length === 1 ? "" : "s"} ${base} does not carry (${foreign
        .slice(0, 3)
        .map((c) => `${c.sha.slice(0, 7)} v${c.version}`)
        .join(", ")}) — a section written on the branch lists shas the merge re-creates; merge first, then render`,
    };
  }
  if (!changed) {
    return { action: "current", why: `${FILE} already names every release` };
  }
  if (mode === "check") return { action: "stale", why: `stale — it would add ${missing.map((r) => `v${r.version}`).join(", ")}` };
  if (!onBase) {
    const warn = foreign.length
      ? `, and ${foreign.length} of its commits are not on ${base} yet — those sections name shas the merge re-creates, so re-render after the merge`
      : "";
    return { action: "render", why: `not the base branch, so the file is written and left for the branch's own commit${warn}` };
  }
  return { action: "commit", why: `writes ${missing.map((r) => `v${r.version}`).join(", ")} and publishes them` };
}

// ---------- the render ----------

function renderAt(root) {
  const rendered = renderRepo({ root, ref: "HEAD" });
  if (!rendered) throw new Error("package.json's history came back empty — refusing to render a changelog of nothing");
  return rendered;
}

function readDisk(root) {
  try {
    return readFileSync(path.join(root, FILE), "utf8");
  } catch {
    return null; // missing is stale
  }
}

const normalise = (text) => String(text || "").replace(/\r\n/g, "\n");

// Every commit this push would send touches nothing but CHANGELOG.md. The pre-push hook's own rule is "a branch
// that lands commits must bump", and a render is the documented exception: it spends no version. Narrowing the
// bypass to a push that is provably a render is the point — a landing commit riding along with it still faces the
// hook.
export function docsOnlyPush(root, from) {
  let shas;
  try {
    shas = git(root, ["rev-list", "--no-merges", `${from}..HEAD`]).split("\n").filter(Boolean);
  } catch {
    return false;
  }
  if (!shas.length) return false;
  for (const sha of shas) {
    const files = git(root, ["show", "--name-only", "--format=", sha]).split("\n").filter(Boolean);
    if (files.length !== 1 || files[0] !== FILE) return false;
  }
  return true;
}

function ancestry(root, ref) {
  return (sha) => spawnSync("git", ["-C", root, "merge-base", "--is-ancestor", sha, ref], { encoding: "utf8" }).status === 0;
}

function parseArgs(argv) {
  const opt = { base: null, remote: null, check: false, render: false, fetch: true, push: true, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--check") opt.check = true;
    else if (a === "--render") opt.render = true;
    else if (a === "--no-fetch") opt.fetch = false;
    else if (a === "--no-push") opt.push = false;
    else if (a === "--base") opt.base = String(argv[(i += 1)] || "");
    else if (a === "--remote") opt.remote = String(argv[(i += 1)] || "");
    else if (a === "--help" || a === "-h") opt.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return opt;
}

const USAGE = [
  "node tools/land.mjs [--check | --render] [--base main] [--remote origin] [--no-fetch] [--no-push]",
  "  the landing's last step: render CHANGELOG.md on the base branch, commit it as a docs commit, push it, prove it.",
  "  --check   write nothing; exit 1 when the base's changelog is stale (the gate shape)",
  "  --render  write the file only — the branch case, for versions the base already carries",
];

function main(argv) {
  let opt;
  try {
    opt = parseArgs(argv);
  } catch (e) {
    console.error(`land: ${e.message}`);
    return 2;
  }
  if (opt.help) {
    for (const line of USAGE) console.log(line);
    return 0;
  }

  let root;
  try {
    root = repoRoot(process.cwd());
  } catch {
    console.error("land: not inside a git repository");
    return 2;
  }

  const base = opt.base || "main";
  const branch = gitOk(root, ["symbolic-ref", "--short", "-q", "HEAD"]);
  const onBase = branch === base;
  const remotes = (gitOk(root, ["remote"]) || "").split("\n").filter(Boolean);
  const remote = opt.remote || (remotes.includes("origin") ? "origin" : remotes[0] || null);
  const remoteRef = remote ? `${remote}/${base}` : null;
  const mode = opt.check ? "check" : opt.render ? "render" : onBase ? "base" : "branch";

  if (mode === "branch") {
    console.error(
      `land: this tree is on ${branch || "a detached HEAD"}, not ${base} — the render is the BASE branch's last step, ` +
        `run after the merge (docs/versioning.md). On a branch, --render writes the sections for versions ${base} already ` +
        `carries and leaves the file for the branch's own commit.`,
    );
    return 1;
  }

  if (remote && opt.fetch) {
    try {
      git(root, ["fetch", "--prune", remote, base]);
    } catch (e) {
      console.error(`land: could not fetch ${remote} — ${String((e.stderr || e.message || "").trim().split("\n")[0] || "unknown error")}`);
      return 2;
    }
  }

  const behind = remoteRef && gitOk(root, ["rev-parse", "--verify", "--quiet", remoteRef])
    ? Number(git(root, ["rev-list", "--count", `HEAD..${remoteRef}`]) || 0)
    : 0;
  const ahead = remoteRef && gitOk(root, ["rev-parse", "--verify", "--quiet", remoteRef])
    ? Number(git(root, ["rev-list", "--count", `${remoteRef}..HEAD`]) || 0)
    : 0;
  const dirty = git(root, ["status", "--porcelain"]).split("\n").filter(Boolean);
  const disk = readDisk(root);

  let rendered;
  try {
    rendered = renderAt(root);
  } catch (e) {
    console.error(`land: ${e.message}`);
    return 2;
  }
  const changed = normalise(disk) !== rendered.text;
  const missing = missingReleases(rendered.releases, disk);
  const baseRef = remoteRef && gitOk(root, ["rev-parse", "--verify", "--quiet", remoteRef]) ? remoteRef : base;
  const foreign = foreignCommits(missing, ancestry(root, baseRef));

  const plan = landPlan({
    // A gate reads the tree it has, so --check ignores dirt and a moved remote: the two states it judges are the
    // file's staleness and the shas the render would name. --render is a preview in a working tree, so dirt there
    // is the normal state and only the base commit insists on a clean one.
    onBase,
    base,
    clean: dirty.length === 0 || mode === "check" || mode === "render",
    behind: mode === "check" || mode === "render" ? 0 : behind,
    changed,
    missing,
    foreign,
    mode,
  });

  if (plan.action === "refuse") {
    console.error(`land: refused — ${plan.why}`);
    if (dirty.length) for (const line of dirty.slice(0, 8)) console.error(`  ${line}`);
    return 1;
  }
  if (plan.action === "stale") {
    console.error(`land: CHANGELOG.md is ${plan.why}`);
    console.error(`land: run npm run land on ${base} after the merge, then commit the render — never by hand.`);
    return 1;
  }

  if (plan.action === "render") {
    writeFileSync(path.join(root, FILE), rendered.text);
    console.log(`land: rendered ${FILE} — ${rendered.releases.length} releases, adding ${missing.map((r) => `v${r.version}`).join(", ")}`);
    console.log(`land: ${plan.why} (this tree is on ${branch || "a detached HEAD"}) — commit it, do not push ${base} from here`);
    return 0;
  }

  if (plan.action === "commit") {
    writeFileSync(path.join(root, FILE), rendered.text);
    const subject = `docs: render the changelog — ${rendered.releases.length} releases`;
    const body = [
      `The landing's last step, run on ${base} after the merge: CHANGELOG.md is rendered from the commits between`,
      `consecutive tags, so the section describing this landing names the shas ${base} carries — never the branch's,`,
      "which a rebase or squash merge re-creates.",
      "",
      "It spends no version and creates no tag (docs/versioning.md): the version went with the change.",
    ].join("\n");
    try {
      git(root, ["add", "--", FILE]);
      const staged = git(root, ["diff", "--cached", "--name-only"]).split("\n").filter(Boolean);
      if (staged.length !== 1 || staged[0] !== FILE) {
        console.error(`land: refused — staging ${FILE} also staged ${staged.filter((f) => f !== FILE).join(", ")}; the tree was dirty`);
        return 1;
      }
      git(root, ["commit", "-q", "-m", subject, "-m", body]);
    } catch (e) {
      console.error(`land: the render could not be committed — ${String((e.stderr || e.message || "").trim().split("\n")[0] || "unknown error")}`);
      return 1;
    }
    const made = git(root, ["rev-parse", "HEAD"]);
    const files = git(root, ["show", "--name-only", "--format=", "HEAD"]).split("\n").filter(Boolean);
    console.log(`land: committed ${made.slice(0, 7)} — ${subject} (${files.join(", ")})`);
  } else {
    console.log(`land: ${FILE} is current — ${rendered.releases.length} releases, nothing to render`);
  }

  // Publish. A gate publishes nothing; a base that is already at the remote has nothing to send; a base carrying
  // the landing and not yet pushed sends the landing with its render, which is the step this command exists for.
  const sendable = plan.action === "commit" || ahead > 0;
  if (mode === "check" || !opt.push || !remote || !sendable) {
    if (!remote && plan.action === "commit") console.log("land: no remote — the render is committed locally only");
    return verify(root, rendered);
  }

  const bypass = docsOnlyPush(root, remoteRef);
  const args = ["push", remote, base];
  if (bypass) args.push("--no-verify");
  try {
    git(root, args);
  } catch (e) {
    console.error(`land: the push was refused — ${String((e.stderr || e.message || "").trim().split("\n").slice(-2).join(" ") || "unknown error")}`);
    return 1;
  }
  console.log(
    `land: pushed ${base} to ${remote}${bypass ? " with --no-verify — every commit sent touches only CHANGELOG.md, and a render spends no version (docs/versioning.md)" : ""}`,
  );
  const sent = git(root, ["rev-parse", "HEAD"]);
  const there = (gitOk(root, ["ls-remote", remote, `refs/heads/${base}`]) || "").split(/\s+/)[0] || "";
  if (there !== sent) {
    console.error(`land: ${remote}/${base} reads ${there.slice(0, 7) || "nothing"}, not ${sent.slice(0, 7)} — the push did not land`);
    return 1;
  }
  console.log(`land: ${remote}/${base} is at ${sent.slice(0, 7)}`);
  return verify(root, rendered);
}

// The proof, in the check's own words: a re-render against what is now on disk and in HEAD. If these two disagree
// the tool has left a tree it cannot describe, which is the one outcome worse than a stale file.
function verify(root, rendered) {
  const disk = readDisk(root);
  const same = normalise(disk) === rendered.text;
  const clean = git(root, ["status", "--porcelain"]).trim() === "";
  if (!same || !clean) {
    console.error(
      `land: the tree did not settle — ${!same ? `${FILE} is not the render` : ""}${!same && !clean ? "; " : ""}${!clean ? "git status is not empty" : ""}`,
    );
    return 1;
  }
  console.log(`changelog: ${FILE} is current — ${rendered.releases.length} releases`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
