// The console's file renderer: a unified diff becomes framed windows, any other file dump a folded code box.
//
//   node tools/verify-console-diff.mjs
//
// Two things are being pinned here. First, the CLASSIFIER — public/core/console-format.js is loaded in a vm as
// the page loads it (a classic script over the real dom-format.js, so `esc`, `linkifyText` and `tailPath` are
// the shipped ones, not copies), and every rule it must and must not apply is asserted as text in, class out.
// Second, the MARKUP the three console paths share: which lines land in a diff window, which in a code box,
// and that the code box is folded by default.
//
// The fixture lines are real: every diff, every read_file body and every heading below was copied out of the
// panel's own logs/jobs.json, including the two lines that make the conservative rules necessary — a terminal
// heading that starts with "--- " and a patch preview cut mid-line by the gateway.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

let failed = 0;
const ok = (name, cond, detail) => {
  if (!cond) failed++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail === undefined || cond ? "" : `: ${JSON.stringify(detail)}`}`);
};
const check = (name, got, want) => {
  const same = JSON.stringify(got) === JSON.stringify(want);
  if (!same) failed++;
  console.log(`${same ? "PASS" : "FAIL"}  ${name}: ${JSON.stringify(got)}${same ? "" : `  (wanted ${JSON.stringify(want)})`}`);
};

// ── the shipped modules, loaded the way index.html loads them ──────────────────────────────────────
const context = vm.createContext({
  window: {},
  console,
  document: { getElementById: () => null },
  state: { projects: new Map() },
  // dom-format's tailPath reaches for normPath, which lives in app.js; the page has it by the time a console
  // is drawn. Same contract here, and it is the only back-edge these two files need.
  normPath: (p) => String(p ?? "").split("\\").join("/").replace(/\/+$/, ""),
});
vm.runInContext(readFileSync(path.join(root, "public/core/dom-format.js"), "utf8"), context, { filename: "dom-format.js" });
const src = readFileSync(path.join(root, "public/core/console-format.js"), "utf8");
vm.runInContext(src, context, { filename: "console-format.js" });
const CF = context.window.WMApp.core.consoleFormat;
ok("the module publishes its four entry points", Boolean(CF && CF.classify && CF.bodyHtml && CF.fileOutput && CF.lineClasses));

const out = (lines) => lines.map((text) => ({ kind: "tool-out", text }));
const classes = (lines, opts) => CF.lineClasses(out(lines), opts);

// ── (1) a unified diff: headers, hunk, body — the shape the classifier must read ───────────────────
const diff = [
  "--- a/C:\\ProjectDevelopment\\heroes-js\\docs\\map.md",
  "+++ b/C:\\ProjectDevelopment\\heroes-js\\docs\\map.md",
  "@@ -1,6 +1,6 @@",
  " # Map",
  " ",
  "-<!-- docs:verified 2026-10-17 -->",
  "+<!-- docs:verified 2026-10-26 -->",
  " ",
  " The world the heroes move through. Hex grid, isometric rendering, procedurally generated.",
];
check("diff: the file headers and the hunk are labels, not body lines", classes(diff), [
  "fileminus",
  "fileplus",
  "hunk",
  "ctx",
  "ctx",
  "mod",
  "add",
  "ctx",
  "ctx",
]);

// The pairing rule: a run of "-" immediately followed by a run of "+" pairs index by index, so a two-for-two
// change is two modifications — not one modification and two strays.
const paired = ["@@ -1,4 +1,4 @@", "-a", "-b", "+c", "+d", "-only-removed", " tail"];
const pairedRes = CF.classify(out(paired), {});
check("pairing: a change block pairs index by index", pairedRes.classes, ["hunk", "mod", "mod", "add", "add", "del", "ctx"]);
check("pairing: each half points at the other", [pairedRes.pair[1], pairedRes.pair[2], pairedRes.pair[3], pairedRes.pair[4]], [3, 4, 1, 2]);
check("pairing: a leftover removal has no partner", pairedRes.pair[5], null);

// ── (3) diff lines with no hunk header still colour, off their own shape ───────────────────────────
const headerless = [" context line", "-old value", "+new value", " another context"];
check("headerless: body lines colour without any header", classes(headerless), ["ctx", "mod", "add", "ctx"]);

// ── (5) conservative: everything that must stay plain ──────────────────────────────────────────────
const mustStayPlain = {
  "a terminal heading that starts with ---": "--- thread: wtgui-toolgrouphtml-public-app-js-bafa4e | id: 5cf62f29 | status: running | turn: 1",
  "another --- heading": "--- count ---",
  "an ls -l mode string": "-rw-r--r-- 1 jacob 197609 227765 Oct 26 00:57 assistant.json",
  "a bulleted list": "- one thing\n- another thing",
  "a diffstat": " packages/engine/src/hydrate.ts | 54 ++++++++++++++++++++++++-",
  "a shell line": "$ git fetch github -q 2>/dev/null",
  "an error line": "fatal: not a git repository (or any of the parent directories): .git",
  "a note the gateway added": "… result truncated by the gateway — the live stream carries a preview of a tool result, not all of it",
  "a result header": "  ↳ patch · 3.27s",
  "prose": "Report written to the file and merged; nothing else to do here.",
};
for (const [name, text] of Object.entries(mustStayPlain)) {
  const one = text.split("\n");
  const got = classes(one);
  ok(`plain: ${name}`, got.every((c) => c === "plain"), got);
}
// A sentence, a call line and the panel's own notes are never even eligible: the classifier only reads a
// tool's output, so prose stays prose by construction rather than by a rule that could drift.
check(
  "plain: kind alone keeps a sentence, a call and a note out of it",
  CF.lineClasses([
    { kind: "text", text: "- not a removal" },
    { kind: "tool", text: "🔧 patch · C:/x/y.md" },
    { kind: "dim", text: "⇢ assistant context attached" },
    { kind: "raw", text: "error: something failed" },
    { kind: "cmd", text: "POST /v1/runs" },
  ]),
  ["plain", "plain", "plain", "plain", "plain"],
);
// A run of mode strings and bullets with no "+" is not a diff, and the change-block rule is what says so.
check("plain: a run of removals with no addition is a list, not a diff", classes(["- one", "- two", "- three"]), ["plain", "plain", "plain"]);

// ── (4) the code box: a file's body, named, folded ────────────────────────────────────────────────
const readBody = [
  "  ↳ read_file · 1.64s",
  "1|# Consolidated playthrough findings — heroes-js",
  "2|",
  "3|Merge of every report in .agentboard/playthrough-reports/",
];
const boxHtml = CF.bodyHtml(out(readBody), { tool: "read_file", arg: "CONSOLIDATED-playthrough-findings.md" });
ok("code box: the result header stays a console line", boxHtml.includes('class="jl jl-tool-out" data-ltext="  ↳ read_file · 1.64s"'));
ok("code box: one box", (boxHtml.match(/class="code-box"/g) || []).length === 1, boxHtml.slice(0, 120));
ok("code box: its header names the file", boxHtml.includes("read_file · CONSOLIDATED-playthrough-findings.md"));
ok("code box: it says how many lines", boxHtml.includes("3 lines"));
ok("code box: folded by default", boxHtml.includes('class="code-body" hidden'));
ok("code box: the file's lines are inside it", boxHtml.includes("1|# Consolidated playthrough findings — heroes-js"));
ok("code box: blank lines are content, not a break", boxHtml.includes('data-ltext="2|"'));
// Nothing to box for a tool whose output is not a file: a shell transcript stays a shell transcript.
const termHtml = CF.bodyHtml(out(["  ↳ terminal · 0.58s", "(clean above = no tracked change)", "fatal: no such file"]), {
  tool: "terminal",
  arg: "git status --short + 3 commands",
});
ok("code box: a terminal batch gets no box", !termHtml.includes("code-box"), termHtml.slice(0, 160));
// A bare file print through the shell is a file's body: the call line says which command ran.
check("file output: a read_file call names its file", CF.fileOutput("read_file", "docs/map.md"), { file: "docs/map.md" });
check("file output: `cat x` names x", CF.fileOutput("terminal", "cat package.json"), { file: "package.json" });
check("file output: `sed -n '1,20p' x` names x", CF.fileOutput("terminal", "sed -n '1,20p' src/app.js"), { file: "src/app.js" });
check("file output: a batch summary is not one file", CF.fileOutput("terminal", "cat package.json + 3 commands"), null);
check("file output: a shell command that is not a print is not a file", CF.fileOutput("terminal", "git diff --stat"), null);

// ── (2) the markup of a diff window: framed, two sides, one window per hunk ───────────────────────
const twoHunks = [
  "--- a/x.md",
  "+++ b/x.md",
  "@@ -1,3 +1,3 @@",
  " keep",
  "-before",
  "+after",
  "@@ -20,3 +20,4 @@",
  " keep two",
  "-gone",
  "+added",
  "+extra",
  "-dropped",
  " tail",
];
const winHtml = CF.bodyHtml(out(twoHunks), { tool: "patch", arg: "C:/x.md" });
check("window: one framed window per hunk", (winHtml.match(/class="df-win"/g) || []).length, 2);
ok("window: the diff headers and the hunk line are labels", winHtml.includes("df-label is-minus") && winHtml.includes("df-label is-plus") && winHtml.includes("df-label is-hunk"));
ok("window: the hunk line's own text is kept as the label", winHtml.includes("@@ -1,3 +1,3 @@"));
ok("window: the second window still names the file it is in", (winHtml.match(/df-lab-path/g) || []).length === 1, winHtml.match(/df-lab-path[^<]*/g));
ok("window: a modification's two halves sit on one row", /<div class="df-row"><div class="jl jl-tool-out df-c is-mod"[^>]*>-before<\/div><div class="jl jl-tool-out df-c is-add"[^>]*>\+after<\/div><\/div>/.test(winHtml));
ok("window: a pure removal is its own row", /<div class="df-row"><div class="jl jl-tool-out df-c is-del"[^>]*>-dropped<\/div><\/div>/.test(winHtml));
check("window: the second hunk pairs, leaves the extras alone and reds the leftover removal", CF.lineClasses(out(twoHunks)), [
  "fileminus",
  "fileplus",
  "hunk",
  "ctx",
  "mod",
  "add",
  "hunk",
  "ctx",
  "mod",
  "add",
  "add",
  "del",
  "ctx",
]);
ok("window: context is dim and spans the row", winHtml.includes('class="jl jl-tool-out df-c is-ctx"'));
ok("window: a lone addition keeps an empty left cell", winHtml.includes('class="df-c is-gap" aria-hidden="true"'));
// Nothing in the window may carry a fixed width or nowrap: the CSS wraps both sides.
ok("window: no inline width or nowrap in the markup", !/style=|nowrap/.test(winHtml));

// ── (6) pure and deterministic: same rows in, same classes and markup out ─────────────────────────
const rows = out(twoHunks);
const a = JSON.stringify(CF.classify(rows, {}));
const b = JSON.stringify(CF.classify(out(twoHunks), {}));
check("determinism: two runs of the same rows agree", a, b);
check("determinism: the markup agrees too", CF.bodyHtml(rows, { tool: "patch" }), CF.bodyHtml(out(twoHunks), { tool: "patch" }));
ok("determinism: no clock and no randomness in the module", !/Date\.now|Math\.random|new Date/.test(src.replace(/^\/\/.*$/gm, "")));

// The read-back a burst rebuild depends on: every line it drew is still readable, in source order, with its
// own text — a window's two sides and a code box's folded body must not lose or reorder a line.
const cells = [...winHtml.matchAll(/data-ltext="([^"]*)"/g)].map((m) => m[1]);
check("read-back: every diff line survives in source order", cells, twoHunks);
const boxCells = [...boxHtml.matchAll(/data-ltext="([^"]*)"/g)].map((m) => m[1]);
check("read-back: the code box's lines survive, the header line first", boxCells, readBody);

console.log(failed ? `RESULT: ${failed} FAILED` : "RESULT: ALL PASS");
process.exit(failed ? 1 : 0);
