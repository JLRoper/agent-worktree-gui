#!/usr/bin/env node
// tools/absolute-paths.mjs — no commit may name a folder on the machine that wrote it.
//
// WHY: a landing is read on another machine. A line like "the report is at C:/Users/<someone>/AppData/Local/
// Temp/wag/8a6b6ca1/report.html" is not evidence a reader can follow — the folder does not exist for them, it
// does not exist on the NEXT run on this machine either (the scratch dir is pruned), and once it is a commit on
// main it is permanent history nobody can correct without rewriting it. The paths arrive by accident: an agent
// pastes the file it just wrote into a doc, a probe prints the tree it ran in, a changelog line quotes the commit
// subject that named one. Nothing caught them, so main already carries hundreds of them; this tool is the gate
// that stops the next one, and tools/absolute-paths.allow is the record of the ones already there.
//
// FOUR FORMS, because the same path is written four ways and a rule that catches one catches none:
//
//   forward       C:/Users/roper/AppData/Local/Temp/wag/x.html
//   backslash     C:\Users\roper\AppData\Local\Temp\wag\x.html
//   json-escaped  C:\\Users\\roper\\AppData\\Local\\Temp\\wag\\x.html   (what a .json file stores)
//   file-url      file:///C:/Users/roper/AppData/Local/Temp/wag/x.html
//
// What counts is the SHAPE, not the owner: `C:/Proj/app` in a test fixture is as absolute as `C:/Users/roper`,
// and the tool has no business guessing which names are real. So every form is a hit, and a file that must keep
// one says so in the allowlist, with a reason, once.
//
// What is NOT a hit is code wearing a path's shape, because a gate that cries about those is turned off within a
// week: `https://` (its `s:` follows a letter), a timestamp regex's `\d:` (a drive letter does not follow a
// backslash), the `a:/m.test` at the end of a hyphenated identifier, and `s:/[%p]/` (a path's first segment does
// not start with a bracket). Each is one line in findPaths, with the reason beside it.
//
//   node tools/absolute-paths.mjs                 scan the tracked files in this working tree
//   node tools/absolute-paths.mjs --rev <sha>     scan that commit's tree — what a push would SEND, which is
//                                                 what .githooks/pre-push checks, not the dirty tree
//   node tools/absolute-paths.mjs --list          every path found, allowed or not, with its form and line
//   node tools/absolute-paths.mjs --draft         the allowlist lines for whatever is not allowed yet
//   node tools/absolute-paths.mjs --allow <file>  read a different allowlist (fixtures and tests)
//
// Exit 0 when nothing new is there, 1 when something is, 2 on a usage error. It reads git and the filesystem and
// nothing else: no network, no clock, no state.
//
// The allowlist is by PATH because a permission is a decision about a file, not about a string: allowing the
// literal `C:/Users/roper/x` would bless it wherever an agent next pasted it. Each line carries the number of
// paths the file held when it was recorded, and the gate fails when a file holds MORE — so a frozen record
// cannot quietly grow a second, newer path. Removing one is always allowed.
//
// This tool, its allowlist, and its own test are the one thing the scan does not scan: their subject IS the
// pattern, so every example in this header and every fixture in that test is a hit. Three exact names, not a glob,
// so widening the hole is an edit a reviewer sees.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ALLOW_FILE = "tools/absolute-paths.allow";

export const SELF = new Set(["tools/absolute-paths.mjs", "tools/absolute-paths.allow", "test/absolute-paths.test.js"]);

export const FORMS = ["forward", "backslash", "json-escaped", "file-url"];

// A drive letter is one letter, a colon, and a separator. What precedes it may not be a letter or a digit, so
// "https://" — whose "s:" is preceded by "p" — is not a drive. The separator is optional IN the match so that
// "file:///C:" is caught with nothing after it; a missing separator is accepted only when a file:// prefix
// carried it, and `!sep && !url` below is what decides that.
const DRIVE = /(?:^|[^A-Za-z0-9])((?:file:\/{2,})?)([A-Za-z]):([\\/]?)/gi;

// The character after the separator decides between a path and a regex. A path's first segment starts with a
// name; `s:/[%p]/.test(T)` in a minified bundle is the start of a character class, not a folder called "[%p]".
const CODE_AFTER_SEPARATOR = new Set("[({*+?^$|");

// A JavaScript escape is not a folder. `throw new Error(\`... within 25 s:\n\${out}\`)` reads as a drive "s:"
// with a backslash separator, and so does the `\\d` in a timestamp regex — but a real path's first segment is a
// NAME, so a one-letter escape followed by the thing that ends the escape is the escape.
const ESCAPE_LETTERS = "nrtbfv0";
const ESCAPE_ENDS = new Set(["$", "{", "}", "(", ")", "\"", "'", "`", ";", ",", ".", "+", ":", " ", ""]);

const STOP = /[\s"'`<>()[\]{}|,;]/;

const BINARY_PROBE = 8000;

// ---------- the matcher: one line of text in, the paths on it out ----------

function tokenAt(line, at) {
  let end = at;
  while (end < line.length && !STOP.test(line.charAt(end))) end += 1;
  return line.slice(at, Math.min(end, at + 160));
}

function formOf(line, url, sep, colonAt) {
  if (url) return "file-url";
  if (sep === "/") return "forward";
  // Two literal backslashes after the colon is how a JSON string stores one separator.
  return line.charAt(colonAt + 2) === "\\" ? "json-escaped" : "backslash";
}

// Every absolute local path on one line, with the column it starts at, its form, and the token as written.
export function findPaths(line) {
  const found = [];
  DRIVE.lastIndex = 0;
  let m;
  while ((m = DRIVE.exec(line))) {
    const [whole, url, , sep] = m;
    const colonAt = m.index + whole.length - 1 - (sep ? 1 : 0);
    const at = colonAt - 1;
    if (!sep && !url) continue;                                       // "a:" in prose is not a path
    const before = at > 0 ? line.charAt(at - 1) : "";
    if (before && "\\-_".includes(before)) continue;                   // a regex's `\d:`, an id's `worker-a:/m.test`
    if (sep && CODE_AFTER_SEPARATOR.has(line.charAt(colonAt + 2))) continue;
    const afterColon = line.slice(colonAt + 2);
    if (sep === "\\" && afterColon && ESCAPE_LETTERS.includes(afterColon.charAt(0)) && ESCAPE_ENDS.has(afterColon.charAt(1))) continue;
    // A file:// URL is quoted with its scheme: "C:/" alone does not say what a reader is looking at.
    const start = url ? at - url.length : at;
    found.push({ at, form: formOf(line, url, sep, colonAt), token: tokenAt(line, start) });
  }
  return found;
}

export function isBinary(buf) {
  return buf.subarray(0, BINARY_PROBE).includes(0);
}

// The hits in one file's text. `file` only labels them; line numbers are 1-based, as an editor shows them.
export function scanText(text, file = "") {
  const hits = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    for (const p of findPaths(lines[i])) hits.push({ file, line: i + 1, ...p });
  }
  return hits;
}

// ---------- the two places a tree can be read from ----------

function git(root, args, input) {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    input,
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 120000,
    maxBuffer: 512 * 1024 * 1024,
  });
}

function gitOk(root, args) {
  try {
    return git(root, args);
  } catch {
    return null;
  }
}

function scanBuffer(buf, file) {
  return isBinary(buf) ? [] : scanText(buf.toString("utf8"), file);
}

// The files this working tree tracks. Untracked work is deliberately not scanned: it cannot land until it is
// added, and the push checks the commit it is added to.
export function scanWorktree(root) {
  const files = git(root, ["ls-files", "-z"]).split("\0").filter(Boolean);
  const hits = [];
  for (const file of files) {
    if (SELF.has(file)) continue;
    let buf;
    try {
      buf = readFileSync(path.join(root, file));
    } catch {
      continue;
    }
    hits.push(...scanBuffer(buf, file));
  }
  return { files: files.length, hits };
}

// The contents of every blob in a commit's tree, read in one `git cat-file --batch`: the scan must see what the
// push would send, not what happens to be on disk beside it.
export function scanRev(root, rev) {
  const listing = git(root, ["ls-tree", "-r", "-z", "--full-tree", rev]);
  const blobs = listing
    .split("\0")
    .filter(Boolean)
    .map((row) => {
      const tab = row.indexOf("\t");
      const [mode, type, oid] = row.slice(0, tab).split(" ");
      return { mode, type, oid, file: row.slice(tab + 1) };
    })
    .filter((e) => e.type === "blob");
  const entries = blobs.filter((e) => !SELF.has(e.file));

  if (!entries.length) return { files: blobs.length, hits: [] };
  const out = execFileSync("git", ["-C", root, "cat-file", "--batch"], {
    input: `${entries.map((e) => e.oid).join("\n")}\n`,
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 120000,
    maxBuffer: 512 * 1024 * 1024,
    windowsHide: true,
  });
  const hits = [];
  let pos = 0;
  for (const entry of entries) {
    const nl = out.indexOf(0x0a, pos);
    if (nl < 0) break;
    const header = out.toString("utf8", pos, nl).split(" ");
    pos = nl + 1;
    if (header[1] !== "blob") continue;                       // "missing", or a submodule's commit
    const size = Number(header[2]);
    hits.push(...scanBuffer(out.subarray(pos, pos + size), entry.file));
    pos += size + 1;
  }
  return { files: blobs.length, hits };
}

// ---------- the allowlist ----------

// `<path> | <count> | <reason>`, one per line, `#` starts a comment. Five things are refused rather than
// ignored, because a record that can be broken quietly is not a record: a line that is not three fields, a path
// that is not repo-relative (an absolute path or a glob would allow more than the one file), a count that is not
// a whole number, a path recorded twice, and an EMPTY REASON — an allowed path is a decision, and a decision says
// why.
export function parseAllowlist(text) {
  const entries = new Map();
  const problems = [];
  const lines = String(text || "").split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i].trim();
    if (!raw || raw.startsWith("#")) continue;
    const parts = raw.split("|");
    const at = i + 1;
    if (parts.length < 3) {
      problems.push({ line: at, why: "not `<path> | <count> | <reason>`", text: raw });
      continue;
    }
    const file = parts[0].trim().replace(/\\/g, "/");
    const count = Number(parts[1].trim());
    const reason = parts.slice(2).join("|").trim();
    if (!file) problems.push({ line: at, why: "names no path", text: raw });
    else if (path.isAbsolute(file) || /^[A-Za-z]:/.test(file) || file.includes("..") || /[*?]/.test(file)) {
      problems.push({ line: at, why: `"${file}" is not a repo-relative path — an absolute path or a glob allows more than one file`, text: raw });
    } else if (!Number.isInteger(count) || count < 1) {
      problems.push({ line: at, why: `"${parts[1].trim()}" is not a whole number of paths`, text: raw });
    } else if (!reason) {
      problems.push({ line: at, why: `"${file}" is allowed with no reason — say why the path is there`, text: raw });
    } else if (entries.has(file)) {
      problems.push({ line: at, why: `"${file}" is recorded twice (first at line ${entries.get(file).line})`, text: raw });
    } else {
      entries.set(file, { max: count, reason, line: at });
    }
  }
  return { entries, problems };
}

export function loadAllowlist(root, { rev = null, file = null } = {}) {
  let text = null;
  if (file) {
    text = readFileSync(file, "utf8");
  } else if (rev) {
    text = gitOk(root, ["show", `${rev}:${ALLOW_FILE}`]);
  } else if (existsSync(path.join(root, ALLOW_FILE))) {
    text = readFileSync(path.join(root, ALLOW_FILE), "utf8");
  }
  if (text == null) return { entries: new Map(), problems: [], missing: true };
  return { ...parseAllowlist(text), missing: false };
}

// ---------- the verdict ----------

// `fresh` is a file the allowlist does not name at all; `grown` one that names it and now holds more paths than
// it recorded. Both are refusals: the first is a path that arrived with this change, the second is one that
// arrived in a file already allowed to hold the older ones.
export function evaluate(hits, entries) {
  const byFile = new Map();
  for (const hit of hits) {
    if (!byFile.has(hit.file)) byFile.set(hit.file, []);
    byFile.get(hit.file).push(hit);
  }
  const fresh = [];
  const grown = [];
  for (const [file, list] of [...byFile.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const entry = entries.get(file);
    if (!entry) fresh.push({ file, hits: list });
    else if (list.length > entry.max) grown.push({ file, hits: list, max: entry.max });
  }
  const recorded = [...entries.keys()].filter((f) => !byFile.has(f));
  return { fresh, grown, recorded };
}

// ---------- printing ----------

function hitLine(hit) {
  return `  ${`${hit.file}:${hit.line}`.padEnd(46)} [${hit.form}] ${hit.token}`;
}

function report(result, allow) {
  const { fresh, grown } = result;
  const out = [];
  if (!fresh.length && !grown.length) return out;

  const bits = [];
  if (fresh.length) bits.push(`${fresh.length} file${fresh.length === 1 ? "" : "s"} naming a folder on this machine`);
  if (grown.length) bits.push(`${grown.length} file${grown.length === 1 ? "" : "s"} over the count they recorded`);
  out.push(`absolute-paths: refused — ${bits.join(", ")}`);
  out.push("");

  for (const { file, hits } of fresh) {
    out.push(file);
    for (const hit of hits) out.push(hitLine(hit));
    out.push("");
  }
  for (const { file, hits, max } of grown) {
    out.push(`${file}   (${hits.length} paths, ${max} recorded in ${ALLOW_FILE})`);
    for (const hit of hits) out.push(hitLine(hit));
    out.push("");
  }

  out.push(
    "A drive-letter path exists on exactly one machine — the one that wrote the line — so a reader cannot open",
    "it, and a scratch folder like AppData/Local/Temp is gone by the next run anyway. Say where the file is",
    "relatively (\"the report the run wrote\"), or describe it, rather than copying the path in.",
    "",
    "Two ways out:",
    "  - take the path out of the line (the fix, for anything this change added), or",
    `  - if the line records something that already happened and must not be rewritten, record it in ${ALLOW_FILE}:`,
    "        <path> | <count> | <one line saying why that path is there>",
    "    node tools/absolute-paths.mjs --draft prints those lines for whatever is not allowed yet.",
    "",
  );
  for (const p of allow.problems) out.push(`allowlist line ${p.line}: ${p.why}`);
  return out;
}

// ---------- the command line ----------

const USAGE = `usage:
  node tools/absolute-paths.mjs                 scan the tracked files in this working tree
  node tools/absolute-paths.mjs --rev <sha>     scan that commit's tree
  node tools/absolute-paths.mjs --list          every path found, allowed or not
  node tools/absolute-paths.mjs --draft         the allowlist lines for whatever is not allowed yet
  node tools/absolute-paths.mjs --allow <file>  read a different allowlist
`;

function main(argv) {
  let rev = null;
  let allowFile = null;
  let list = false;
  let draft = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--rev") {
      rev = argv[i + 1];
      if (!rev) return { code: 2, out: [`absolute-paths: --rev needs a commit or ref\n`] };
      i += 1;
    } else if (arg === "--allow") {
      allowFile = argv[i + 1];
      if (!allowFile) return { code: 2, out: [`absolute-paths: --allow needs a file\n`] };
      i += 1;
    } else if (arg === "--list") {
      list = true;
    } else if (arg === "--draft") {
      draft = true;
    } else if (arg === "-h" || arg === "--help") {
      return { code: 0, out: [USAGE] };
    } else {
      return { code: 2, out: [`absolute-paths: unknown argument "${arg}"\n`, USAGE] };
    }
  }

  const root = (gitOk(process.cwd(), ["rev-parse", "--show-toplevel"]) || "").trim();
  if (!root) return { code: 2, out: ["absolute-paths: this is not a git working tree\n"] };

  const { files, hits } = rev ? scanRev(root, rev) : scanWorktree(root);
  const allow = loadAllowlist(root, { rev, file: allowFile });
  const result = evaluate(hits, allow.entries);
  const out = [];

  if (list) {
    out.push(`absolute-paths: ${files} ${rev ? `files at ${rev}` : "tracked files"}, ${hits.length} paths, ${allow.entries.size} allowlisted files`);
    for (const hit of hits) {
      const entry = allow.entries.get(hit.file);
      const mark = entry ? `allowed (${entry.max})` : "NOT ALLOWED";
      out.push(`  ${`${hit.file}:${hit.line}`.padEnd(46)} [${hit.form}] ${mark.padEnd(18)} ${hit.token}`);
    }
    out.push("");
    for (const file of result.recorded) out.push(`  recorded but holds none now: ${file}`);
    return { code: 0, out };
  }

  if (draft) {
    const seen = new Set();
    for (const { file, hits: list2 } of [...result.fresh, ...result.grown]) {
      if (seen.has(file)) continue;
      seen.add(file);
      out.push(`${file} | ${list2.length} | `);
      for (const hit of list2) out.push(`#   ${hit.file}:${hit.line} [${hit.form}] ${hit.token}`);
    }
    if (!seen.size) out.push("absolute-paths: nothing to draft — every path found is already recorded");
    else out.push("", "# paste the lines above into " + ALLOW_FILE + " and write the reason after the last |.");
    return { code: 0, out };
  }

  const refused = report(result, allow);
  if (refused.length) return { code: 1, out: refused };

  if (allow.missing) {
    out.push(`absolute-paths: ${hits.length ? "refused" : "clean"} — there is no ${allowFile || ALLOW_FILE} to read`);
    if (hits.length) return { code: 1, out };
  }
  for (const p of allow.problems) out.push(`allowlist line ${p.line}: ${p.why}`);
  if (allow.problems.length) {
    out.push("", `absolute-paths: refused — ${allow.problems.length} line${allow.problems.length === 1 ? "" : "s"} of ${ALLOW_FILE} cannot be read`);
    return { code: 1, out };
  }
  out.push(
    `absolute-paths: clean — ${files} ${rev ? `files at ${rev}` : "tracked files"}, ` +
      `${hits.length} paths in ${allow.entries.size} allowlisted files, none new`,
  );
  return { code: 0, out };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { code, out } = main(process.argv.slice(2));
  (code === 0 ? process.stdout : process.stderr).write(`${out.join("\n")}\n`);
  process.exitCode = code;
}
