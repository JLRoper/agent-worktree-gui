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
//   node tools/changelog.mjs --no-links         plain text: no commit or compare links (a mirror with no GitHub)
//
// The grouping is the conventional-commit prefix each subject already carries: feat/Added, fix/Fixed,
// perf/Performance, refactor/style/build/ci/revert/Changed, docs/doc/test/Docs & tests, and everything else
// (chore:, a bare subject) under Other. Merge commits are dropped: a merge says how the work arrived, not what
// changed.

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
export function collectReleases(versions, listCommits) {
  const seen = new Set();
  const releases = [];
  for (let i = 0; i < versions.length; i += 1) {
    const v = versions[i];
    const from = i ? versions[i - 1].sha : null;
    const commits = listCommits(from, v.sha).filter((c) => {
      if (seen.has(c.sha)) return false;
      seen.add(c.sha);
      return true;
    });
    releases.push({ ...v, previous: i ? versions[i - 1].version : null, commits });
  }
  return releases;
}

function commitRef(repoUrl, sha) {
  const short = String(sha).slice(0, 7);
  return repoUrl ? `[\`${short}\`](${repoUrl}/commit/${sha})` : `\`${short}\``;
}

export function renderChangelog({ releases, repoUrl = null, since = null }) {
  const all = releases.slice().sort((a, b) => compareVersions(b.version, a.version));
  const shown = since ? all.filter((r) => compareVersions(r.version, since) > 0) : all;
  const newest = all[0];
  const oldest = all[all.length - 1];
  const commitsShown = shown.reduce((n, r) => n + r.commits.length, 0);
  const lines = [];

  if (since) {
    lines.push(`# Changes since v${since}`, "");
    lines.push(
      `${shown.length} release${shown.length === 1 ? "" : "s"} after v${since}, newest first — ${commitsShown} commit${commitsShown === 1 ? "" : "s"}.`,
      "This is the same grouping CHANGELOG.md carries, cut at the build you are running.",
      "",
    );
  } else {
    lines.push("# Changelog", "");
    lines.push(
      "Every released version of the panel, newest first: the commits each release carried over the tag before it,",
      "grouped by what a reader gets from them. Generated from git history — `npm run changelog` rewrites this file and",
      "`npm run changelog:check` fails when it is stale. Do not edit it by hand.",
      "",
    );
    lines.push("**What changed since the build I am running?** The board's config line names the build (`v0.84.0 · …`).", "Pass that version here and read only what came after it:", "");
    lines.push("```", "npm run changelog -- --since v0.80.0", "```", "");
    if (all.length) {
      lines.push(
        `${all.length} releases from v${oldest.version} (${oldest.date}) to v${newest.version} (${newest.date}), ` +
          `${all.reduce((n, r) => n + r.commits.length, 0)} commits between the tags. Every release is anchored by an`,
        "annotated tag at the commit that first declared its version; `npm run verify:version-tags` fails when a bump",
        "has no tag.",
        "",
      );
    }
  }

  for (const r of shown) {
    const commits = r.commits.length;
    lines.push(`## v${r.version} — ${r.date} · ${commits} commit${commits === 1 ? "" : "s"}`, "");
    const meta = [commitRef(repoUrl, r.sha)];
    if (repoUrl && r.previous) meta.push(`[compare v${r.previous}...v${r.version}](${repoUrl}/compare/v${r.previous}...v${r.version})`);
    else if (r.previous) meta.push(`the ${commits} commit${commits === 1 ? "" : "s"} after v${r.previous}`);
    lines.push(meta.join(" · "), "");
    if (!commits) {
      lines.push("_No commits between the two tags._", "");
      continue;
    }
    for (const [, label, group] of groupCommits(r.commits)) {
      lines.push(`### ${label}`, "");
      for (const c of group) lines.push(`- ${c.subject} (${commitRef(repoUrl, c.sha)})`);
      lines.push("");
    }
  }
  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}

// A GitHub remote's web URL, or null for a mirror that is not GitHub (the renderer then omits links rather than
// pointing them at a host that will 404).
export function githubRepoUrl(root) {
  try {
    const raw = execFileSync("git", ["remote", "get-url", "origin"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const m = /github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/.exec(raw);
    return m ? `https://github.com/${m[1]}/${m[2]}` : null;
  } catch {
    return null;
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
  const opt = { out: "CHANGELOG.md", check: false, since: null, links: true, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--check") opt.check = true;
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
    console.log("node tools/changelog.mjs [--check] [--since <version>] [--out <path>] [--no-links]");
    console.log("  renders CHANGELOG.md from the commits between consecutive v<version> tags.");
    return 0;
  }

  const root = repoRoot(process.cwd());
  const history = readReleaseHistory({ root, ref: "HEAD" });
  if (!history.versions.length) {
    console.error("changelog: package.json's history came back empty — refusing to render a changelog of nothing");
    return 2;
  }
  const releases = collectReleases(history.versions, (from, to) => listCommits(root, from, to));
  const repoUrl = opt.links ? githubRepoUrl(root) : null;

  if (opt.since) {
    const want = opt.since.replace(/^v/, "");
    if (!releases.some((r) => r.version === want)) {
      console.error(`changelog: no release v${want}. Known: v${releases[0].version} .. v${releases[releases.length - 1].version}`);
      return 2;
    }
    process.stdout.write(renderChangelog({ releases, repoUrl, since: want }));
    return 0;
  }

  const text = renderChangelog({ releases, repoUrl });
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
    console.log(`changelog: ${path.relative(root, out)} is current — ${releases.length} releases`);
    return 0;
  }
  writeFileSync(out, text);
  const commits = releases.reduce((n, r) => n + r.commits.length, 0);
  console.log(
    `changelog: wrote ${path.relative(root, out)} — ${releases.length} releases, ${commits} commits, ` +
      `${text.length} chars${repoUrl ? "" : " (no links: origin is not a GitHub remote)"}`,
  );
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
