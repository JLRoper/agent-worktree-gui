// A page under docs/reports is a deliverable, and .git/info/exclude hides those pages from `git status` in every
// worktree of this clone. The defect this file exists for: a page written there and never added disappears with the
// worktree that wrote it, and nothing ever says so. The original Route implementation report was lost that way.
//
// So the check is a comparison, not an ignore query: every .html on disk under docs/reports must be in the index.
// Reading the index rather than `git status` is the whole point - an ignored file is invisible to status and visible
// here. The fix a red answer asks for is `git add -f docs/reports/<page>`, or deleting a page that was never meant to
// ship.
import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";

export const REPORT_DIR = "docs/reports";

const slash = (p) => String(p).replace(/\\/g, "/");

// Every .html under the report folder, as a repo-relative path with forward slashes.
export function htmlOnDisk(root, dir = REPORT_DIR) {
  const abs = path.join(root, dir);
  let found;
  try {
    if (!statSync(abs).isDirectory()) return [];
    found = readdirSync(abs, { recursive: true, encoding: "utf8" });
  } catch {
    return [];
  }
  return found
    .map((rel) => `${dir}/${slash(rel)}`)
    .filter((rel) => rel.toLowerCase().endsWith(".html"))
    .sort();
}

// Every .html the index knows under the report folder. `git ls-files` answers for ignored files too, which is what
// makes it the right question: "is this page in the commit" rather than "would git tell me about it".
export function trackedHtml(root, dir = REPORT_DIR) {
  const out = execFileSync("git", ["-C", root, "ls-files", "-z", "--", dir], {
    encoding: "utf8",
    windowsHide: true,
  });
  return new Set(
    out
      .split("\0")
      .filter(Boolean)
      .map(slash)
      .filter((rel) => rel.toLowerCase().endsWith(".html")),
  );
}

// The pages a worktree would take to the grave with it: on disk, not in the index.
export function untrackedReports(root, dir = REPORT_DIR) {
  const tracked = trackedHtml(root, dir);
  return htmlOnDisk(root, dir).filter((rel) => !tracked.has(rel));
}

export function reportOf(list) {
  if (list.length === 0) return "every page under docs/reports is in the index";
  const pages = list.map((rel) => `  ${rel}`).join("\n");
  return (
    `${list.length} page(s) under docs/reports are on disk and not in the index:\n${pages}\n` +
    `.git/info/exclude ignores docs/reports/*.html in every worktree, so git status will never name them.\n` +
    `Fix: git add -f <page> to keep it, or delete it if it was never meant to ship.`
  );
}
