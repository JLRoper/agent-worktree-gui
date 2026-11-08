#!/usr/bin/env node
// tools/changelog.mjs — render CHANGELOG.md from the commits between consecutive version tags.
//
// WHY: the panel tells a reader which build a tab is running (`v0.84.0 · …` on the board's config line), and the
// question that follows is always "what changed since then". A version number alone cannot answer it; a tag at
// the commit that declared the number plus the commits between consecutive tags can. So this reads
// tools/release-history.mjs's walk (the same one tools/verify-version-tags.mjs gates) and writes one section per
// release, newest first, with the commits grouped by what a reader gets from them.
//
//   node tools/changelog.mjs                    rewrite CHANGELOG.md at the repository root
//   node tools/changelog.mjs --check            exit 1 when the file on disk is not what the history renders
//                                               (writes nothing; the CI-shaped use)
//   node tools/changelog.mjs --since v0.80.0    print only the releases after v0.80.0 — "my build vs now"
//   node tools/changelog.mjs --out <path>       write somewhere else
//   node tools/changelog.mjs --no-links         plain text, no commit or compare links — the deliberate opt-out for
//                                               a mirror this tool can find no GitHub remote on
//   node tools/changelog.mjs --full             rebuild every release from the first tag, ignoring what the file
//                                               already carries (see below)
//
// THE RENDER IS INCREMENTAL, BECAUSE A FULL ONE DOES NOT FINISH INSIDE A LANDING. A section costs one
// `git log <previous-tag>..<tag>` subprocess, and this repository has hundreds of releases: the full walk ran to
// more than five minutes, past `tools/land.mjs`'s 600 second foreground cap, so the landing's post-merge render
// could never complete and CHANGELOG.md fell releases behind the base. A post-merge render only has to answer for
// the releases the file does NOT name yet — every section already in it was rendered from the same history and
// states for itself which commits it carries. So the default render reads CHANGELOG.md, keeps those sections byte
// for byte, lists commits only for the versions above the newest one it carries (and for a hole below it), and
// rewrites the header's count and range from the same sections. `--full` is the complete rebuild from the first
// tag: use it for a file damaged past what a forward render repairs, or when the whole history is wanted at once.
// The two agree on a file that was written by a render and is only missing its newest releases.
//
// The grouping is the conventional-commit prefix each subject already carries:
// perf/Performance, refactor/style/build/ci/revert/Changed, docs/doc/test/Docs & tests, and everything else
// (chore:, a bare subject) under Other. Merge commits are dropped: a merge says how the work arrived, not what
// changed.
//
// THE LINKS COME FROM THE CLONE'S OWN REMOTES. The resolver takes the first remote whose URL is a GitHub one,
// preferring `origin` when it exists: a clone whose GitHub remote is named otherwise is still a clone of the same
// repository, and its changelog deserves its links. With links on — the default — and no GitHub remote to take them
// from, the render REFUSES. The old behaviour read a remote named `origin` and nothing else, so such a clone got a
// link-less file that read exactly like a successful render, `--check` could never agree with the file it had just
// written, and the base's own landing step (`tools/land.mjs` renders through this module too) would strip the links
// the base's changelog carries and commit that. `--no-links` is the deliberate way to write a link-less file.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compareVersions, readReleaseHistory, repoRoot } from "./release-history.mjs";

// The order a reader scans a release in: what is new, what was fixed, what got faster, what moved, what is
// housekeeping. A group with no commits is not printed.
export const GROUPS = [
  ["added", "Added"],
  ["fixed", "Fixed"],
  ["performance", "Performance"],
  ["changed", "Changed"],
  ["docs", "Docs & tests"],
  ["other", "Other"],
];

const TYPES = {
  feat: "added",
  fix: "fixed",
  perf: "performance",
  refactor: "changed", style: "changed", build: "changed", ci: "changed", revert: "changed",
  docs: "docs", doc: "docs", test: "docs", tests: "docs",
  chore: "other",
};

export function classify(subject) {
  const m = /^([A-Za-z][A-Za-z0-9_-]*)(\([^)]*\))?!?:/.exec(String(subject || ""));
  return m ? TYPES[m[1].toLowerCase()] || "other" : "other";
}

// Group a release's commits, keeping each group's own chronological order. Returns [[key, label, commits], …].
export function groupCommits(commits) {
  const buckets = new Map(GROUPS.map(([key]) => [key, []]));
  for (const c of commits) buckets.get(classify(c.subject)).push(c);
  return GROUPS.filter(([key]) => buckets.get(key).length).map(([key, label]) => [key, label, buckets.get(key)]);
}

// One entry per version, oldest first, each with the commits its range adds over the previous version. `seen`
// is the guard for a non-linear history: two ranges can share a commit when a side branch was merged, and the
// earlier release keeps it rather than both printing it.
//
// `startIndex` and `skip` are what make a FORWARD render cheap: `startIndex` drops the releases below the oldest
// one the file already carries (their sections are the file's, and their ranges are never listed), and `skip`
// returns a release with no commits listed at all because its section is being kept verbatim. `previous` is still
// read from the full walk, so a section rendered above the seed still names the tag it followed.
export function collectReleases(versions, listCommits, { startIndex = 0, skip = null } = {}) {
  const seen = new Set();
  const releases = [];
  for (let i = startIndex; i < versions.length; i += 1) {
    const v = versions[i];
    const previous = i ? versions[i - 1].version : null;
    if (skip && skip(v)) {
      releases.push({ ...v, previous, commits: [] });
      continue;
    }
    const from = i ? versions[i - 1].sha : null;
    const commits = listCommits(from, v.sha).filter((c) => {
      if (seen.has(c.sha)) return false;
      seen.add(c.sha);
      return true;
    });
    releases.push({ ...v, previous, commits });
  }
  return releases;
}

function commitRef(repoUrl, sha) {
  const short = String(sha).slice(0, 7);
  return repoUrl ? `[\`${short}\`](${repoUrl}/commit/${sha})` : `\`${short}\``;
}

// ---------- reading the file back, and rendering forward from it ----------
//
// A section is one `git log <previous-tag>..<tag>`, so a render's cost is the number of releases it renders — 400
// subprocesses on this repository, minutes of wall clock, past the landing's 600 second cap. The file's own
// sections were rendered from the same history and each states the commits it carries, so a post-merge render only
// needs the releases the file does not name. These three functions are that half: read the file into sections,
// keep them, render the rest.

// The heading the renderer writes and nothing else in the file starts with: `## v1.53.6 — 2026-11-07 · 2 commits`.
export const SECTION_HEADING = /^## v(\d+\.\d+\.\d+) — (\d{4}-\d{2}-\d{2}) · (\d+) commits?$/;

const trimBlank = (lines) => {
  const out = lines.slice();
  while (out.length && out[out.length - 1].trim() === "") out.pop();
  while (out.length && out[0].trim() === "") out.shift();
  return out;
};

// The commit a section's meta line names — its own release's tag commit. With links that is the
// `/commit/<40 hex>` URL; without them (`--no-links`) it is the short sha in backticks. Read from the top of the
// section, because a bullet's sha is a commit the release CONTAINS, not the commit the release IS.
export function sectionSha(section) {
  const m = /(?:commit\/([0-9a-f]{40})|`([0-9a-f]{7,40})`)/.exec(String(section?.text || ""));
  return m ? m[1] || m[2] : null;
}

// Every commit the ref carries, and their short prefixes, in one `rev-list` — the one question a kept section has
// to answer. A rebase merge RE-CREATES the branch's commits with new shas, so a section rendered on the branch
// names a commit the base never carried; `tools/land.mjs` refuses that render outright, and the forward render
// must render such a section again rather than preserve it for ever. A section naming an ANCESTOR the walk no
// longer calls the version's anchor is left alone: it is the file's own section, and only `--full` rewrites those.
export function reachableShas(root, ref = "HEAD") {
  const raw = execFileSync("git", ["rev-list", ref], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 64 * 1024 * 1024,
  });
  const full = new Set(raw.split("\n").filter(Boolean));
  return { full, short: new Set([...full].map((s) => s.slice(0, 7))) };
}

export function sectionMatches(section, reachable) {
  const sha = sectionSha(section);
  if (!sha) return false;
  return reachable.full.has(sha) || reachable.short.has(sha.slice(0, 7));
}

// CHANGELOG.md read back into the release sections it carries, newest first, each with its own text and the commit
// count its heading claims, plus the prose above the first heading. A CRLF checkout is normalised: the blob is LF,
// and a render that kept the line endings it was handed would rewrite every line of a file it did not change.
export function parseChangelog(text) {
  const header = [];
  const sections = [];
  let current = null;
  const LF = String.fromCharCode(10);
  const CR = String.fromCharCode(13);
  const normalised = String(text ?? "").split(CR + LF).join(LF).split(LF);
  for (const line of normalised) {
    const m = SECTION_HEADING.exec(line);
    if (m) {
      current = { version: m[1], date: m[2], commits: Number(m[3]), lines: [line] };
      sections.push(current);
    } else if (current) {
      current.lines.push(line);
    } else {
      header.push(line);
    }
  }
  return {
    header: trimBlank(header),
    sections: sections.map((s) => ({ version: s.version, date: s.date, commits: s.commits, text: trimBlank(s.lines).join("\n") })),
  };
}

// One release's section, as lines. Shared by the full render and the forward one, so a section kept from the file
// and a section rendered beside it cannot differ in shape.
function renderRelease(r, repoUrl) {
  const commits = r.commits.length;
  const lines = [`## v${r.version} — ${r.date} · ${commits} commit${commits === 1 ? "" : "s"}`, ""];
  const meta = [commitRef(repoUrl, r.sha)];
  if (repoUrl && r.previous) meta.push(`[compare v${r.previous}...v${r.version}](${repoUrl}/compare/v${r.previous}...v${r.version})`);
  else if (r.previous) meta.push(`the ${commits} commit${commits === 1 ? "" : "s"} after v${r.previous}`);
  lines.push(meta.join(" · "), "");
  if (!commits) {
    lines.push("_No commits between the two tags._", "");
    return lines;
  }
  for (const [, label, group] of groupCommits(r.commits)) {
    lines.push(`### ${label}`, "");
    for (const c of group) lines.push(`- ${c.subject} (${commitRef(repoUrl, c.sha)})`);
    lines.push("");
  }
  return lines;
}

// The prose above the first section. Its range and counts describe WHAT THE FILE CARRIES, which for a forward
// render is the sections it kept plus the ones it added — not necessarily every tag the repository has.
function renderHeader({ newest, oldest, releaseCount, commitCount }) {
  if (!newest) return ["# Changelog", ""];
  const lines = ["# Changelog", ""];
  lines.push(
    "Every released version of the panel, newest first: the commits each release carried over the tag before it,",
    "grouped by what a reader gets from them. Generated from git history — `npm run changelog` rewrites this file and",
    "`npm run changelog:check` fails when it is stale. Do not edit it by hand.",
    "",
  );
  lines.push(`**What changed since the build I am running?** The board's config line names the build (\`v${newest.version} · …\`).`, "Pass that version here and read only what came after it:", "");
  lines.push("```", "npm run changelog -- --since v0.80.0", "```", "");
  lines.push(
    `${releaseCount} releases from v${oldest.version} (${oldest.date}) to v${newest.version} (${newest.date}), ` +
      `${commitCount} commits between the tags. Every release is anchored by an`,
    "annotated tag at the commit that first declared its version; `npm run verify:version-tags` fails when a bump",
    "has no tag.",
    "",
  );
  return lines;
}

// The file: the header, then one block per section, one blank line between them and one trailing newline.
function composeChangelog(header, blocks) {
  const lines = [...header];
  for (const b of blocks) lines.push(...b);
  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}

export function renderChangelog({ releases, repoUrl = null, since = null }) {
  const all = releases.slice().sort((a, b) => compareVersions(b.version, a.version));
  if (since) {
    const shown = all.filter((r) => compareVersions(r.version, since) > 0);
    const commitsShown = shown.reduce((n, r) => n + r.commits.length, 0);
    return composeChangelog(
      [
        `# Changes since v${since}`,
        "",
        `${shown.length} release${shown.length === 1 ? "" : "s"} after v${since}, newest first — ${commitsShown} commit${commitsShown === 1 ? "" : "s"}.`,
        "This is the same grouping CHANGELOG.md carries, cut at the build you are running.",
        "",
      ],
      shown.map((r) => renderRelease(r, repoUrl)),
    );
  }
  return composeChangelog(
    renderHeader({
      newest: all[0],
      oldest: all[all.length - 1],
      releaseCount: all.length,
      commitCount: all.reduce((n, r) => n + r.commits.length, 0),
    }),
    all.map((r) => renderRelease(r, repoUrl)),
  );
}

// The forward render: the file's own sections kept byte for byte, and a section rendered for every release above
// the oldest one it carries. `releases` is the tail of the walk from that version up, so the ranges below it are
// never listed; a release in it carrying no commits was KEPT, and `sections` supplies its text and its count.
export function renderChangelogForward({ releases, sections, repoUrl = null }) {
  const carried = new Map(sections.map((s) => [s.version, s]));
  const all = releases.slice().sort((a, b) => compareVersions(b.version, a.version));
  const blocks = [];
  const rendered = [];
  let commitCount = 0;
  for (const r of all) {
    const kept = carried.get(r.version);
    if (kept) {
      blocks.push([...kept.text.split("\n"), ""]);
      commitCount += kept.commits;
    } else {
      blocks.push(renderRelease(r, repoUrl));
      commitCount += r.commits.length;
      rendered.push(r.version);
    }
  }
  const header = renderHeader({ newest: all[0] || null, oldest: all[all.length - 1] || null, releaseCount: all.length, commitCount });
  return { text: composeChangelog(header, blocks), rendered, kept: all.length - rendered.length };
}

// Every remote this clone carries, `origin` first and then the rest in git's own order — the preference order the
// link resolver reads. Name and URL together, so a refusal can quote what it actually looked at.
export function listRemotes(root) {
  let names;
  try {
    names = execFileSync("git", ["remote"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .split("\n")
      .map((n) => n.trim())
      .filter(Boolean);
  } catch {
    return []; // not a repository, or git is not there: no remotes, which the caller refuses on rather than assumes around
  }
  const ordered = [...names.filter((n) => n === "origin"), ...names.filter((n) => n !== "origin")];
  return ordered.map((name) => ({ name, url: remoteUrl(root, name) }));
}

function remoteUrl(root, name) {
  try {
    return execFileSync("git", ["remote", "get-url", name], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return ""; // a remote whose URL cannot be read carries no GitHub URL; the name alone renders no link
  }
}

// The GitHub web URL a remote's URL names, or null for anything else — and asked of the URL, never of the remote's
// name. `origin` is a convention, not a fact: this clone may hold the same repository under `github`, `upstream` or
// anything else, while a remote NAMED origin can perfectly well point at a mirror somewhere else.
export function githubUrlFrom(remoteUrl) {
  const raw = String(remoteUrl || "").trim().replace(/\/+$/, "");
  const m = /github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/.exec(raw);
  return m ? `https://github.com/${m[1]}/${m[2]}` : null;
}

// Which remote the links come from, and what the clone carried when it could not answer one. A GitHub URL beats a
// plain one, and `origin` beats the rest among equals, because that is the name a landing pushes to and the one a
// render made by a clone cut from it would take its shas from.
export function resolveGithubRemote(root) {
  const remotes = listRemotes(root);
  const github = remotes.filter((r) => githubUrlFrom(r.url));
  const first = github.find((r) => r.name === "origin") || github[0] || null;
  return { url: first ? githubUrlFrom(first.url) : null, remote: first ? first.name : null, remotes };
}

// A GitHub remote's web URL, or null when this clone carries none (see resolveGithubRemote for which, and why).
export function githubRepoUrl(root) {
  return resolveGithubRemote(root).url;
}

// The sentence a refusal prints: what the clone has, and the one command that fixes it. A clone with nine remotes
// does not need all nine read out to learn that none of them is GitHub.
export function noGithubRemoteMessage(remotes = []) {
  const seen = remotes.length
    ? `this clone's remotes are ${remotes.map((r) => `${r.name} (${r.url || "no url"})`).join(", ")}`
    : "this clone has no remotes at all";
  return (
    `no GitHub remote to take the changelog's links from — ${seen}. ` +
    "Every release heading would be written without its commit and compare links, and --check could then never agree " +
    "with the file this tool had just written, so nothing was rendered. " +
    "Add the repository's GitHub remote (`git remote add origin https://github.com/<owner>/<repo>.git`) and run " +
    "again, or render without links on purpose with --no-links."
  );
}

// A refusal, not a git failure, so a caller can tell the two apart: tools/land.mjs renders this same file and must
// refuse alongside the CLI rather than commit a link-less render over the linked one the base carries.
export class NoGithubRemoteError extends Error {
  constructor(remotes = []) {
    super(noGithubRemoteMessage(remotes));
    this.name = "NoGithubRemoteError";
    this.remotes = remotes;
  }
}

// One render, from one ref, for both this CLI and tools/land.mjs: the landing's last step has to write byte for
// byte what `npm run changelog` writes, or the two disagree about the same history. Returns null when the walk
// comes back empty, so the caller refuses instead of rendering a changelog of nothing, and THROWS a
// NoGithubRemoteError when links were asked for and this clone carries no GitHub remote — a link-less file is the
// one outcome both callers must refuse, because it reads as a successful render while no check can ever agree with
// it and the base's own landing step would commit it over a file that has its links.
//
// `full` rebuilds every release from the first tag. The default renders FORWARD from what CHANGELOG.md already
// carries (the note at the top of this file says why), and the seed is always the repository's own CHANGELOG.md —
// never `--out`: the versions are read from the file the repository carries, and a render written elsewhere must
// still start where that file reaches.
export function renderRepo({ root = process.cwd(), ref = "HEAD", links = true, full = false } = {}) {
  const history = readReleaseHistory({ root, ref });
  if (!history.versions.length) return null;
  const found = resolveGithubRemote(root);
  if (links && !found.url) throw new NoGithubRemoteError(found.remotes);
  const repoUrl = links ? found.url : null;
  const common = { repoUrl, remote: links ? found.remote : null, remotes: found.remotes };
  const listAll = (from, to) => listCommits(root, from, to);

  const carried = full ? null : readChangelog(path.join(root, "CHANGELOG.md"));
  // `--no-links` is an opt-out about the FILE, not only about the releases this run adds: a section kept from a
  // linked file would keep its links, so a linked file is not a seed for a link-less render.
  const seed = !links && carried && carried.sections.some((s) => /\]\(https?:\/\//.test(s.text)) ? null : carried;
  if (seed && seed.sections.length) {
    const reachable = reachableShas(root, ref);
    // Keep only sections naming a commit this ref carries. A section naming a sha the ref never had is a branch
    // render whose commits the merge re-created, and the base's own render step exists to repair exactly that;
    // anything the ref does carry is the file's section, kept as it stands.
    const sections = seed.sections.filter((s) => sectionMatches(s, reachable));
    const kept = new Set(sections.map((s) => s.version));
    // The walk's own order decides where the file's oldest section starts: every version below it is history the
    // file deliberately begins after, so its range is never listed and its section is never regenerated. It starts
    // at the oldest version the file NAMES, not at the oldest the file still matches, so a section that stopped
    // matching is rendered again in place instead of being dropped with the releases below it.
    const named = new Set(seed.sections.map((s) => s.version));
    const startIndex = history.versions.findIndex((v) => named.has(v.version));
    if (startIndex >= 0) {
      const releases = collectReleases(history.versions, listAll, { startIndex, skip: (v) => kept.has(v.version) });
      const forward = renderChangelogForward({ releases, sections, repoUrl });
      return { ...common, releases, text: forward.text, releaseCount: releases.length, kept: forward.kept, rendered: forward.rendered, mode: "forward" };
    }
  }
  const releases = collectReleases(history.versions, listAll);
  return {
    ...common,
    releases,
    text: renderChangelog({ releases, repoUrl }),
    releaseCount: releases.length,
    kept: 0,
    rendered: releases.map((r) => r.version),
    mode: "full",
  };
}

function readChangelog(file) {
  try {
    return parseChangelog(readFileSync(file, "utf8"));
  } catch {
    return null; // a missing file carries nothing to keep: the render falls back to the whole walk
  }
}

function listCommits(root, from, to) {
  const range = from ? `${from}..${to}` : to;
  const raw = execFileSync("git", ["log", "--reverse", "--no-merges", "--format=%H%x1f%ad%x1f%s", "--date=short", range], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 64 * 1024 * 1024,
  });
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha = "", date = "", subject = ""] = line.split("\x1f");
      return { sha: sha.trim(), date: date.trim(), subject: subject.trim() };
    });
}

function parseArgs(argv) {
  const opt = { out: "CHANGELOG.md", check: false, since: null, links: true, full: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--check") opt.check = true;
    else if (a === "--full") opt.full = true;
    else if (a === "--out") opt.out = String(argv[(i += 1)] || "");
    else if (a === "--since") opt.since = String(argv[(i += 1)] || "");
    else if (a === "--no-links") opt.links = false;
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
    console.error(`changelog: ${e.message}`);
    return 2;
  }
  if (opt.help) {
    console.log("node tools/changelog.mjs [--check] [--since <version>] [--out <path>] [--no-links] [--full]");
    console.log("  renders CHANGELOG.md from the commits between consecutive v<version> tags.");
    console.log("  By default the render is INCREMENTAL: the sections CHANGELOG.md already carries are kept byte for");
    console.log("  byte and only the releases above them are rendered, which is what lets a post-merge render finish.");
    console.log("  --full        rebuild every release from the first tag (minutes on a history this size)");
    console.log("  The commit and compare links come from this clone's first GitHub remote (origin wins).");
    console.log("  A clone carrying no GitHub remote is REFUSED — the file would be link-less and --check could");
    console.log("  never agree with it. `--no-links` writes that file deliberately.");
    return 0;
  }

  const root = repoRoot(process.cwd());
  let rendered;
  try {
    rendered = renderRepo({ root, ref: "HEAD", links: opt.links, full: opt.full || Boolean(opt.since) });
  } catch (e) {
    if (!(e instanceof NoGithubRemoteError)) throw e;
    console.error(`changelog: ${e.message}`);
    return 2;
  }
  if (!rendered) {
    console.error("changelog: package.json's history came back empty — refusing to render a changelog of nothing");
    return 2;
  }
  const { releases, repoUrl, remote, text, releaseCount, kept, rendered: renderedVersions, mode } = rendered;

  if (opt.since) {
    const want = opt.since.replace(/^v/, "");
    if (!releases.some((r) => r.version === want)) {
      console.error(`changelog: no release v${want}. Known: v${releases[0].version} .. v${releases[releases.length - 1].version}`);
      return 2;
    }
    process.stdout.write(renderChangelog({ releases, repoUrl, since: want }));
    return 0;
  }

  const out = path.resolve(root, opt.out);
  if (opt.check) {
    let disk = null;
    try {
      disk = readFileSync(out, "utf8");
    } catch {
      /* missing is stale */
    }
    // A checkout with core.autocrlf hands this file back with CRLF while the render is LF; the content is the
    // same file, so compare the lines rather than the bytes.
    const same = disk !== null && disk.replace(/\r\n/g, "\n") === text;
    if (!same) {
      console.error(`changelog: ${path.relative(root, out)} is out of date — run npm run changelog and commit the result`);
      return 1;
    }
    console.log(`changelog: ${path.relative(root, out)} is current — ${releaseCount} releases`);
    return 0;
  }
  writeFileSync(out, text);
  const commits = parseChangelog(text).sections.reduce((n, s) => n + s.commits, 0);
  const how = mode === "full" ? "full rebuild" : `${kept} kept, ${renderedVersions.length} rendered`;
  console.log(
    `changelog: wrote ${path.relative(root, out)} — ${releaseCount} releases (${how}), ${commits} commits, ` +
      `${text.length} chars${repoUrl ? `, links from ${remote}` : ", no links: --no-links was asked for"}`,
  );
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
