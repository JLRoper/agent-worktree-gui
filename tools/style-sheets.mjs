#!/usr/bin/env node
// tools/style-sheets.mjs - the sheets public/index.html links, in cascade order, and their text as one string.
//
// The one panel sheet was split into per-surface sheets in 1.191.0, so a tool that used to read that file has to
// read EVERY sheet the page links, in the order the page links them. Load order is half of what a rule means to a
// browser: a concatenation in any other order is a different stylesheet, and a hand-written list of sheets goes
// stale the first time a surface gains a file. Both facts are why the list is PARSED from the page, once, here.
//
//   node tools/style-sheets.mjs                the sheet names, one per line, in load order
//   node tools/style-sheets.mjs --text         the concatenated text (LF only)
//   node tools/style-sheets.mjs --json         { root, files, text }
//   node tools/style-sheets.mjs --root <dir>   read another build (a `git archive` of a base commit)
//
// Imported:
//
//   import { styleSheetFiles, styleSheetPaths, readStyleSheets, styleLinkTags } from "./style-sheets.mjs";
//
//   styleSheetFiles({ root })       -> ["base.css", "chrome.css", ...] in load order
//   styleSheetPaths({ root })       -> the same names as absolute paths under <root>/public
//   readStyleSheets({ root })       -> one string, every sheet in load order, LF newlines
//   readStyleSheets({ files })      -> the same for an explicit list of names (a caller's own subset)
//   styleLinkTags({ root, prefix }) -> the <link> tags a fixture page serves, one per sheet, in load order
//
// A root named explicitly is read as that build (its own public/index.html and its own sheets), which is what a
// before/after capture needs: an older export may still link the one file, and the tags then say so.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The checkout this module lives in. Every caller passes its own root when it measures another build.
export const PANEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// One shape only: the page writes `<link rel="stylesheet" href="/name.css" />`, and a sheet's href is what a
// fixture server must be asked for as well.
const LINK = /<link\s+rel="stylesheet"\s+href="\/([^"]+\.css)"/g;

const rootOf = (options) => {
  const wanted = typeof options === "string" ? options : options?.root;
  return path.resolve(wanted || PANEL_ROOT);
};

const indexOf = (root) => path.join(root, "public", "index.html");

/**
 * The stylesheets the page links, in the order it links them.
 *
 * Throws when the page links none, or links one that is not on disk: a caller that asserts "this rule is not in
 * the stylesheet" would otherwise pass against an empty read, which is the one way a stylesheet gate can lie.
 */
export function styleSheetFiles(options = {}) {
  const root = rootOf(options);
  const html = readFileSync(indexOf(root), "utf8");
  const files = [...html.matchAll(LINK)].map((m) => m[1]);
  if (!files.length) throw new Error(`${indexOf(root)} links no stylesheet`);
  const missing = files.filter((name) => !existsSync(path.join(root, "public", name)));
  if (missing.length) {
    throw new Error(`${indexOf(root)} links ${missing.join(", ")}, which public/ does not hold`);
  }
  return files;
}

/** The same names as absolute paths, in load order. */
export function styleSheetPaths(options = {}) {
  const root = rootOf(options);
  return styleSheetFiles({ root }).map((name) => path.join(root, "public", name));
}

/**
 * Every sheet as one string, in load order, LF newlines.
 *
 * `files` reads an explicit list instead of the page's: a caller that owns a SUBSET (the nineteen sheets the
 * split produced, say) names it once and still gets the sheets' own bytes in one string.
 */
export function readStyleSheets(options = {}) {
  const root = rootOf(options);
  const files = Array.isArray(options?.files) ? options.files : styleSheetFiles({ root });
  return files
    .map((name) => readFileSync(path.join(root, "public", name), "utf8"))
    .join("\n")
    .replace(/\r\n/g, "\n");
}

/**
 * The page's stylesheets as `<link>` tags a fixture can serve.
 *
 * The prefix is where the fixture server keeps public/; the fixture pages here serve this checkout at "/", so a
 * sheet is "/public/<name>". Each sheet keeps its own URL, and therefore its own cascade position.
 */
export function styleLinkTags(options = {}) {
  const prefix = (options && typeof options === "object" && options.prefix) || "/public/";
  return styleSheetFiles(options)
    .map((name) => `<link rel="stylesheet" href="${prefix}${name}">`)
    .join("\n");
}

// ---- the command line ----------------------------------------------------------------------------------------
function main(argv) {
  const at = argv.indexOf("--root");
  const root = at >= 0 ? argv[at + 1] : PANEL_ROOT;
  if (argv.includes("--json")) {
    const files = styleSheetFiles({ root });
    process.stdout.write(`${JSON.stringify({ root: path.resolve(root), files, text: readStyleSheets({ root }) }, null, 1)}\n`);
    return 0;
  }
  if (argv.includes("--text")) {
    process.stdout.write(`${readStyleSheets({ root })}\n`);
    return 0;
  }
  for (const name of styleSheetFiles({ root })) process.stdout.write(`${name}\n`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // `node tools/style-sheets.mjs --text | head` closes the pipe early; that is the reader's last word, not an error.
  process.stdout.on("error", (e) => {
    if (e && e.code === "EPIPE") process.exit(0);
    throw e;
  });
  process.exitCode = main(process.argv.slice(2));
}
