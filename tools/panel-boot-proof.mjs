// Prove a converted test file's file-level net: strip every per-test stop hook, add one boot that throws before it
// can stop, and show the file still exits on its own.
//
// WHY. row 569 fixed the npm-test stall in one file and proved it with a hooks-stripped copy that still exited
// (docs/reports/npm-test-stall-2026-11-28.html). The kit's `boot()` is that fix moved into tools/panel-testkit.mjs,
// and the same proof has to hold for every converted file: if the file only works because each test remembers its
// own `t.after(() => panel.stop())`, the net is not carrying anything.
//
// WHAT IT DOES:
//   1. copies the test file to test/.panel-boot-proof-<stem>.test.js (a dotfile, so `test/*.test.js` never runs it)
//   2. removes every `t.after(...)` whose body calls `.stop(` - the per-test fast path - and keeps the rest
//   3. appends one test that boots a panel and throws on the next line, before any stop it could have written
//   4. runs the copy under `node --test` with a hard timeout and reports whether it exited
//
// `--before` rewrites the same copy's `boot(` back to `startPanel(` - the call the file used before conversion - so
// the stall is shown on identical bytes, not asserted. That run is expected to TIME OUT; its children see their
// stdin close when the runner is killed (PANEL_PARENT_WATCH_STDIN) and shut down on their own.
//
//   node tools/panel-boot-proof.mjs test/chart-columns.test.js
//   node tools/panel-boot-proof.mjs test/chart-columns.test.js --before
//   node tools/panel-boot-proof.mjs test/chart-columns.test.js --timeout 900 --keep
//
// The cap defaults to ten minutes because the slowest file in the suite takes about four on this machine; a cap that
// sits under a file's own runtime reports the net as broken when the file was merely slow.
import { spawn } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { maskSource } from "./child-process-audit.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, "..");

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const valueOf = (flag, fallback = null) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const target = args.find((arg) => !arg.startsWith("--") && args[args.indexOf(arg) - 1] !== "--timeout");

function fail(message) {
  console.error(`FAIL  ${message}`);
  process.exit(1);
}

function matchingParen(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === "(") depth += 1;
    else if (src[i] === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// Remove each per-test hook statement: the whole line it owns when the line is the hook alone, otherwise the call
// itself. Ranges are collected against the masked source (so a hook inside a comment or a string is not one) and cut
// from the raw text in reverse, leaving every other byte alone.
export function stripStopHooks(raw) {
  const masked = maskSource(raw);
  const ranges = [];
  const hook = /(?<![\w.])t\.after\s*\(/g;
  for (let m = hook.exec(masked); m; m = hook.exec(masked)) {
    const open = masked.indexOf("(", m.index);
    const close = matchingParen(masked, open);
    if (close < 0) continue;
    if (!/\.stop\s*\(/.test(masked.slice(open, close))) continue;
    let end = close + 1;
    while (end < raw.length && (raw[end] === ";" || raw[end] === " " || raw[end] === "\t" || raw[end] === "\r")) end += 1;
    if (raw[end] === "\n") end += 1;
    const lineStart = raw.lastIndexOf("\n", m.index) + 1;
    const start = raw.slice(lineStart, m.index).trim() === "" ? lineStart : m.index;
    ranges.push([start, end]);
  }
  ranges.sort((a, b) => b[0] - a[0]);
  let out = raw;
  let removed = 0;
  for (const [start, end] of ranges) {
    out = out.slice(0, start) + out.slice(end);
    removed += 1;
  }
  return { text: out, removed };
}

// Turn a converted file's `boot(` sites back into `startPanel(`, and its import item with them.
export function rewriteToStartPanel(raw) {
  const masked = maskSource(raw);
  const ranges = [];
  const call = /(?<![\w.$])boot\s*\(/g;
  for (let m = call.exec(masked); m; m = call.exec(masked)) {
    const before = masked.slice(Math.max(0, m.index - 40), m.index);
    if (/\b(?:function|const|let|var|class)\s+$/.test(before)) continue;
    ranges.push([m.index, m.index + "boot".length, "startPanel"]);
  }
  let out = raw;
  for (const [start, end, text] of ranges.sort((a, b) => b[0] - a[0])) {
    out = out.slice(0, start) + text + out.slice(end);
  }
  // The import clause: `boot` (optionally an alias) becomes startPanel, unless the file already imports it.
  out = out.replace(/import\s*\{([^}]*)\}\s*from\s*(["'][^"']*panel-testkit\.mjs["'])/, (whole, clause, from) => {
    const items = clause.split(",").map((item) => item.trim()).filter(Boolean);
    if (items.some((item) => /^startPanel(?:\s+as\s+[\w$]+)?$/.test(item))) {
      return whole.replace(clause, items.filter((item) => !/^boot(?:\s+as\s+[\w$]+)?$/.test(item)).join(", "));
    }
    const rewritten = items.map((item) => (/^boot(?:\s+as\s+[\w$]+)?$/.test(item) ? "startPanel" : item));
    return `import { ${rewritten.join(", ")} } from ${from}`;
  });
  return out;
}

const PROOF_TEST = (starter) => `
// injected by tools/panel-boot-proof.mjs: ${starter}() that throws before any stop line it might have written.
test("proof: a boot that throws before its stop leaves no child holding the file open", { timeout: 120_000 }, async () => {
  await ${starter}({ keep: true });
  throw new Error("the proof: this test never reaches a stop line");
});
`;

async function runCopy(copy, timeoutMs) {
  const started = Date.now();
  const child = spawn(process.execPath, ["--test", "--test-reporter=spec", copy], {
    cwd: ROOT,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const out = [];
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (d) => out.push(d));
  child.stderr.on("data", (d) => out.push(d));
  let timedOut = false;
  let exit = null;
  const done = new Promise((resolve) => {
    child.on("exit", (code, signal) => {
      exit = { code, signal };
      resolve();
    });
  });
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
    setTimeout(() => child.kill("SIGKILL"), 5_000).unref?.();
  }, timeoutMs);
  await done;
  clearTimeout(timer);
  return { timedOut, exit, ms: Date.now() - started, out: out.join("") };
}

const summaryOf = (text) => {
  const one = (name) => {
    const m = text.match(new RegExp(`ℹ ${name} (\\d+)`));
    return m ? Number(m[1]) : null;
  };
  return { tests: one("tests"), pass: one("pass"), fail: one("fail") };
};

async function main() {
  if (!target) fail("usage: node tools/panel-boot-proof.mjs <test file> [--before] [--timeout <s>] [--keep]");
  const file = path.resolve(ROOT, target);
  const stem = path.basename(file).replace(/\.test\.js$/, "");
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    fail(`cannot read ${target}`);
  }
  const before = has("--before");
  const starter = before ? "startPanel" : "boot";
  if (!before && !/import\s*\{[^}]*\bboot\b[^}]*\}\s*from\s*["'][^"']*panel-testkit\.mjs["']/.test(raw)) {
    fail(`${target} does not import boot from tools/panel-testkit.mjs - convert it first`);
  }

  let text = stripStopHooks(raw);
  let body = text.text;
  const notes = [`${text.removed} per-test stop hook(s) stripped`];
  if (before) {
    body = rewriteToStartPanel(body);
    notes.push("boot() rewritten to startPanel() (the call the file made before conversion)");
  }
  body += PROOF_TEST(starter);
  notes.push(`one ${starter}()-then-throw test appended`);

  const copy = path.join(ROOT, "test", `.panel-boot-proof-${stem}.test.js`);
  writeFileSync(copy, body, "utf8");
  const timeoutMs = Number(valueOf("--timeout", "600")) * 1000;
  console.log(`panel-boot-proof  ${path.relative(ROOT, file).replace(/\\/g, "/")}`);
  console.log(`  copy: ${path.relative(ROOT, copy).replace(/\\/g, "/")}`);
  for (const note of notes) console.log(`  ${note}`);
  console.log(`  mode: ${before ? "startPanel() - before the kit" : "boot() - the kit's registry"}`);

  let result;
  try {
    result = await runCopy(copy, timeoutMs);
  } finally {
    if (!has("--keep")) rmSync(copy, { force: true });
  }

  const summary = summaryOf(result.out);
  const seconds = (result.ms / 1000).toFixed(1);
  if (before) {
    if (!result.timedOut) {
      console.log(`  exit: ${result.exit?.code ?? "?"} in ${seconds}s  tests ${summary.tests ?? "?"} pass ${summary.pass ?? "?"} fail ${summary.fail ?? "?"}`);
      fail(`the stall did not reproduce: the hooks-stripped copy on startPanel() exited on its own`);
    }
    console.log(`  still running after ${seconds}s (cap ${timeoutMs / 1000}s), killed; the panel children see their stdin close and shut down`);
    console.log(`PASS  the stall reproduces on the same bytes with startPanel() - this file needed the kit`);
    return;
  }

  if (result.timedOut) fail(`the hooks-stripped copy did not exit within ${timeoutMs / 1000}s - the file-level net did not carry it`);
  if (summary.tests === null) fail(`the copy exited but printed no runner summary (exit ${result.exit?.code ?? "?"})`);
  const proofFailed = /✖ proof: a boot that throws before its stop/.test(result.out);
  if (!proofFailed) fail("the appended proof test did not run - the copy is not exercising the net");
  console.log(`  exit: ${result.exit?.code ?? "?"} in ${seconds}s  tests ${summary.tests} pass ${summary.pass} fail ${summary.fail} (the injected throw is the failure)`);
  console.log(`PASS  the hooks-stripped copy exits on its own; boot() stopped the panel the thrown test left behind`);
}

await main();
