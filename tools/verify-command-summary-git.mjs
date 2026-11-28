// The permission card's command reading, RENDERED: one git command still summarises to the same line after the
// git half moved into public/core/command-summary-git.js (row 523, the first cut of public/core/command-summary.js).
//
// WHY THIS HARNESS. A pure move is proved by the export surface, the block hash and the tests, and none of them
// paints anything: the scripts could keep their names and still draw a different block, because the entry point now
// reads gitStep and gitParts off a global that a second <script> publishes. So this gate loads BOTH scripts in the
// page's own order (public/index.html: the git file, then the entry point) into Chromium, draws the block the card
// draws, and projects what the reader would see.
//
//   node tools/verify-command-summary-git.mjs                       # this checkout
//   node tools/verify-command-summary-git.mjs --root <tree>          # a base archive, for the before/after diff
//   node tools/verify-command-summary-git.mjs --json <file>          # the projection, for diffing two runs
//
// WHAT IT ASSERTS:
//   (1) both scripts evaluate in page order, with the git one first and the entry point publishing the same four
//       names it always published;
//   (2) every command draws a .ta-summary block, and no page error is raised;
//   (3) a git step is described by the git reading - the line names git and its subject, never "no argument";
//   (4) the projection (the block's text, and each drawn step's text) is printed with a sha256, so a before/after
//       pair is one line per side and byte equality is the claim.
import { createHash } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { withBrowser, REPO } from "./browser.mjs";

const argv = process.argv.slice(2);
const opt = (name, dflt = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const root = path.resolve(opt("--root", REPO));
const jsonPath = opt("--json", "");

// The page's load order, and the two files the cut split: the git reading publishes first, the entry point second.
const SCRIPTS = ["public/core/command-summary-git.js", "public/core/command-summary.js"];
const SURFACE = ["MAX_CONSEQUENTIAL", "html", "splitSteps", "summarize"];

// A git command is the subject of the cut; the last three also exercise what stayed behind (a pipe inside a
// substitution, a non-git program, and the splitter), so a difference names which half moved.
const COMMANDS = [
  "git status --short && git diff -- docs/readme.md",
  "git add -A && git commit -m \"the row lands\" && git push -u origin HEAD",
  "git reset --hard origin/main && git push --force origin HEAD",
  "git -C /repo/demo checkout -- src/app.js",
  "git log --oneline -5 | head -3",
  "git rm --cached vendored/left-pad.js",
  "echo start && find docs -name \"*.html\" -delete",
];

const verdict = await withBrowser(async ({ page, pageErrors }) => {
  const failures = [];
  if (!existsSync(path.join(root, "public/core/command-summary.js"))) {
    return [`no public/core/command-summary.js under ${root}`];
  }
  await page.setContent("<!doctype html><html><body><div id=\"host\"></div></body></html>");
  const loaded = [];
  for (const rel of SCRIPTS) {
    if (!existsSync(path.join(root, rel))) continue;
    await page.addScriptTag({ path: path.join(root, rel) });
    loaded.push(rel);
  }
  const surface = await page.evaluate((names) => {
    const M = globalThis.wtCommandSummary || {};
    return { names: Object.keys(M).sort(), kinds: names.map((n) => `${n}:${typeof M[n]}`) };
  }, SURFACE);
  if (surface.names.join(",") !== SURFACE.join(",")) failures.push(`wtCommandSummary publishes ${surface.names.join(", ")}`);
  const expected = SCRIPTS.filter((rel) => existsSync(path.join(root, rel)));
  if (loaded.join(",") !== expected.join(",")) failures.push(`loaded ${loaded.join(", ")} (the page's order is ${expected.join(", ")})`);

  const projection = await page.evaluate((commands) => {
    const host = document.getElementById("host");
    const flat = (el) => (el ? el.textContent.replace(/\s+/g, " ").trim() : "");
    return commands.map((cmd) => {
      host.innerHTML = globalThis.wtCommandSummary.html(cmd, { root: "/repo/demo" });
      const block = host.querySelector(".ta-summary");
      const parts = [];
      if (block) {
        parts.push(flat(block.querySelector(".ta-summary-head")));
        if (block.querySelector(".ta-summary-lead")) parts.push(flat(block.querySelector(".ta-summary-lead")));
        for (const li of block.querySelectorAll(".ta-summary-steps > li")) {
          const fold = li.querySelector("summary");
          if (fold) {
            const inner = [...li.querySelectorAll(".ta-fold-steps li")].map(flat).join(" | ");
            parts.push(`${flat(fold)} -> ${inner}`);
          } else parts.push(flat(li));
        }
        for (const flag of block.querySelectorAll(".ta-summary-flag")) parts.push(flat(flag));
        if (block.querySelector(".ta-summary-read")) parts.push(flat(block.querySelector(".ta-summary-read")));
      }
      return { cmd, parts };
    });
  }, COMMANDS);
  const text = (row) => row.parts.join(" | ");

  for (const row of projection) {
    if (!row.parts.length) failures.push(`drew nothing for: ${row.cmd}`);
  }
  const first = projection[0];
  if (!/git status: what has changed in this tree/.test(text(first))) failures.push(`the git reading did not describe git status: ${text(first)}`);
  if (projection.some((row) => /no argument|\(empty\)/.test(text(row)))) failures.push("a fragment was drawn as a program");
  if (pageErrors.length) failures.push(`page errors: ${pageErrors.join(" | ")}`);

  // The hash is the PROJECTION alone: the before side has one script and the after side two, so `loaded` differs by
  // design and a hash over it would compare the cut instead of what the reader sees.
  const canonical = JSON.stringify(projection, null, 1);
  const digest = createHash("sha256").update(canonical).digest("hex");
  if (jsonPath) writeFileSync(jsonPath, canonical, "utf8");
  console.log(`ROOT   ${root}`);
  console.log(`LOADED ${loaded.join(" then ")}`);
  console.log(`SURFACE ${surface.kinds.join(" ")}`);
  for (const row of projection) console.log(`LINE   ${text(row)}`);
  console.log(`SHA256 ${digest}`);
  console.log(`${failures.length ? "FAIL" : "PASS"}  ${COMMANDS.length} commands rendered, ${failures.length} failure(s)`);
  for (const f of failures) console.log(`  - ${f}`);
  return failures;
});

process.exit(verdict && verdict.length ? 1 : 0);
