// No child_process call in the panel may start a child without `windowsHide: true`.
//
// The panel usually runs with no console of its own — started hidden from start-background.cmd, or by the
// restart helper — so every console child it starts without windowsHide gets a console of its OWN: a cmd
// window that appears for the length of one git call and takes the focus off whatever the reader is typing
// into. That is why this is a rule about EVERY call site rather than about the one that flashed on a
// particular machine: which site fires depends on which poll is due or which turn just ended, and the
// uncovered ones (the turn-end artifact sweep, the automatic rename, the editor) all run while a reader is
// mid-sentence somewhere else on the board.
//
// `detached: true` does not excuse it either: a detached console child is the one that is guaranteed its own
// console, so the two options belong together.
//
// The scan is textual but bracket-aware: strings, template literals, regex literals and comments are masked
// out first, so a `spawn(` inside a comment or a `,` inside a string cannot fool it. No dependency, because
// this has to run inside `npm test`.
//
// Run it directly to list every call site:
//   node tools/child-process-audit.mjs          # violations only, exit 1 when there are any
//   node tools/child-process-audit.mjs --list   # every call site and whether it hides its window

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, "..");

export const CHILD_PROCESS_NAMES = ["exec", "execFile", "execSync", "execFileSync", "spawn", "spawnSync"];

// ---- masking -----------------------------------------------------------------------------------
// Replace the contents of every literal and comment with spaces, keeping offsets and newlines intact, so
// the structural scan below can look at real code only. Template interpolations are recursed into, not
// blanked: a call inside `${…}` is code.
function regexAllowed(prev) {
  if (!prev) return true;
  return "(,=:[!&|?{};+-*%~^<>".includes(prev);
}

function maskRange(src, from, to, out, offset) {
  let i = from;
  let prev = "";
  const blank = (a, b) => {
    for (let k = a; k < b; k++) {
      const idx = k - offset;
      if (out[idx] !== "\n" && out[idx] !== "\r") out[idx] = " ";
    }
  };
  while (i < to) {
    const c = src[i];
    const n = src[i + 1];
    if (c === "/" && n === "/") {
      const end = src.indexOf("\n", i);
      const stop = end < 0 || end > to ? to : end;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (c === "/" && n === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end < 0 || end + 2 > to ? to : end + 2;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < to && src[j] !== c) {
        if (src[j] === "\\") j += 1;
        j += 1;
      }
      blank(i + 1, Math.min(j, to));
      i = j + 1;
      prev = c;
      continue;
    }
    if (c === "`") {
      let j = i + 1;
      let lit = j;
      while (j < to) {
        if (src[j] === "\\") {
          j += 2;
          continue;
        }
        if (src[j] === "`") break;
        if (src[j] === "$" && src[j + 1] === "{") {
          blank(lit, j);
          let depth = 1;
          let k = j + 2;
          while (k < to && depth > 0) {
            // Strings inside an interpolation are handled by the recursive pass below; this only has to
            // find the matching brace.
            if (src[k] === "{") depth += 1;
            else if (src[k] === "}") depth -= 1;
            k += 1;
          }
          const inner = src.slice(j + 2, k - 1).split("");
          maskRange(src, j + 2, k - 1, inner, j + 2);
          for (let m = 0; m < inner.length; m++) out[j + 2 - offset + m] = inner[m];
          j = k;
          lit = j;
          continue;
        }
        j += 1;
      }
      blank(lit, Math.min(j, to));
      i = j + 1;
      prev = "`";
      continue;
    }
    if (c === "/" && regexAllowed(prev)) {
      let j = i + 1;
      let inClass = false;
      while (j < to) {
        const ch = src[j];
        if (ch === "\\") {
          j += 2;
          continue;
        }
        if (ch === "[") inClass = true;
        else if (ch === "]") inClass = false;
        else if (ch === "/" && !inClass) break;
        else if (ch === "\n") break; // not a regex after all; leave it alone
        j += 1;
      }
      if (src[j] === "/") {
        blank(i + 1, j);
        i = j + 1;
        prev = "/";
        continue;
      }
    }
    if (c && !/\s/.test(c)) prev = c;
    i += 1;
  }
  return out;
}

export function maskSource(src) {
  const out = src.split("");
  return maskRange(src, 0, src.length, out, 0).join("");
}

// ---- call discovery ----------------------------------------------------------------------------
function collectAliases(masked) {
  const aliases = new Set();
  const aliasing = (name) => CHILD_PROCESS_NAMES.includes(name) || aliases.has(name);
  for (let pass = 0; pass < 4; pass += 1) {
    let added = 0;
    // `const pexec = promisify(execFile)` — the shape every module here uses.
    for (const m of masked.matchAll(/([A-Za-z_$][\w$]*)\s*=\s*promisify\(\s*([A-Za-z_$][\w$]*)\s*\)/g)) {
      if (aliasing(m[2]) && !aliases.has(m[1])) {
        aliases.add(m[1]);
        added += 1;
      }
    }
    // `exec = pexec` — a parameter default, or a plain alias: `const run = spawn`.
    for (const m of masked.matchAll(/([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\s*(?=[,;\n)])/g)) {
      if (aliasing(m[2]) && !aliases.has(m[1])) {
        aliases.add(m[1]);
        added += 1;
      }
    }
    if (!added) break;
  }
  return aliases;
}

function matchingParen(masked, open) {
  let depth = 0;
  for (let i = open; i < masked.length; i += 1) {
    const c = masked[i];
    if (c === "(") depth += 1;
    else if (c === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function splitArgs(masked, raw, open, close) {
  const args = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open + 1; i < close; i += 1) {
    const c = masked[i];
    if (c === "(" || c === "[" || c === "{") depth += 1;
    else if (c === ")" || c === "]" || c === "}") depth -= 1;
    else if (c === "," && depth === 0) {
      args.push({ raw: raw.slice(start, i), masked: masked.slice(start, i) });
      start = i + 1;
    }
  }
  if (masked.slice(start, close).trim()) args.push({ raw: raw.slice(start, close), masked: masked.slice(start, close) });
  return args;
}

// The options argument: the first object literal after the command (argv may itself be omitted).
function optionsArg(args) {
  for (let i = 1; i < args.length; i += 1) {
    if (args[i].masked.trim().startsWith("{")) return args[i];
  }
  return null;
}

function lineAt(src, index) {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (src[i] === "\n") line += 1;
  return line;
}

export function auditSource(source, file = "<source>") {
  const masked = maskSource(source);
  const aliases = collectAliases(masked);
  const watched = new Set([...CHILD_PROCESS_NAMES, ...aliases]);
  const calls = [];
  for (const m of masked.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = m[1];
    if (!watched.has(name)) continue;
    const at = m.index ?? 0;
    const before = masked.slice(Math.max(0, at - 24), at);
    if (/\.\s*$/.test(before)) continue; // a method on something — `pool.spawn()`, `re.exec()`
    if (/\bfunction\s*\*?\s*$/.test(before)) continue; // a declaration
    const open = masked.indexOf("(", at + name.length);
    const close = matchingParen(masked, open);
    if (close < 0) continue;
    const after = masked.slice(close + 1).match(/^\s*/)[0];
    const next = masked[close + 1 + after.length];
    if (next === "{") continue; // `spawn() {` is a method definition, not a call
    const args = splitArgs(masked, source, open, close);
    const opts = optionsArg(args);
    const hides = Boolean(opts && /\bwindowsHide\s*:\s*true\b/.test(opts.masked));
    const detached = Boolean(opts && /\bdetached\s*:\s*true\b/.test(opts.masked));
    calls.push({
      file,
      line: lineAt(source, at),
      callee: name,
      alias: !CHILD_PROCESS_NAMES.includes(name),
      args: args.length,
      hasOptions: Boolean(opts),
      windowsHide: hides,
      detached,
      snippet: source.slice(at, Math.min(close + 1, at + 120)).replace(/\s+/g, " ").trim(),
    });
  }
  return calls;
}

export function auditChildProcess(root = ROOT) {
  const files = [];
  const serverPath = path.join(root, "server.js");
  try {
    if (statSync(serverPath).isFile()) files.push(serverPath);
  } catch {
    /* no server.js: the caller pointed at the wrong root */
  }
  const walk = (dir) => {
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === "node_modules") continue;
        walk(full);
      } else if (/\.(js|cjs|mjs)$/.test(e.name)) {
        files.push(full);
      }
    }
  };
  walk(path.join(root, "lib"));
  const calls = [];
  for (const file of files) {
    const rel = path.relative(root, file).replace(/\\/g, "/");
    calls.push(...auditSource(readFileSync(file, "utf8"), rel));
  }
  return { files: files.map((f) => path.relative(root, f).replace(/\\/g, "/")), calls, violations: calls.filter((c) => !c.windowsHide) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const list = process.argv.includes("--list");
  const { files, calls, violations } = auditChildProcess();
  if (list) {
    for (const c of calls) {
      const flags = [c.windowsHide ? "windowsHide" : "NO-WINDOWSHIDE", c.detached ? "detached" : null].filter(Boolean).join(" ");
      console.log(`${c.file}:${c.line}  ${c.callee}(${c.args} args)  ${flags}`);
    }
    console.log(`\n${calls.length} call sites in ${files.length} files`);
  }
  if (violations.length) {
    console.error(`\n${violations.length} child_process call(s) without windowsHide: true:`);
    for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.callee}: ${v.snippet}`);
    process.exit(1);
  }
  if (!list) console.log(`ok: ${calls.length} child_process call sites in ${files.length} files all pass windowsHide: true`);
}
