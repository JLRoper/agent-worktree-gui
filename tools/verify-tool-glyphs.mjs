// Every tool call in an agent's console leads with the tool's glyph, the way the Hermes CLI prints
// it. The glyphs come from the CLI's own registry, so read_file is 📖 in both places; a tool the table
// does not name falls back by family and then to the CLI's default ⚡, because a wrong glyph is worse
// than a generic one.
//
//   node tools/verify-tool-glyphs.mjs
import { readFileSync } from "node:fs";
import { Jobs } from "../lib/jobs.js";

let failed = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}: ${JSON.stringify(got)}${ok ? "" : `  (wanted ${JSON.stringify(want)})`}`);
};

const jobs = new Jobs({ jobsFile: null });
const startLine = (tool, preview) => {
  const j = { id: "j1", lines: [], curText: null };
  jobs.consume(j, { event: "tool.started", tool, preview });
  return j.lines[0]?.text ?? "";
};

// ── the glyph table, tool by tool (values read from the Hermes registry) ──────────────────────────
const expected = {
  read_file: "📖", write_file: "✍️", patch: "🔧", search_files: "🔎",
  terminal: "💻", execute_code: "🐍", browser_exec: "🌐", browser_vault: "🔐",
  web_search: "🔍", web_extract: "📄", delegate_task: "🔀", todo_list: "📋",
  memory: "🧠", skill_view: "📚", clarify: "❓", cronjob_manage: "⏰",
};
for (const [tool, glyph] of Object.entries(expected)) {
  check(`${tool} -> ${glyph}`, startLine(tool, "").split(" ")[0], glyph);
}

// ── fallbacks: MCP families, browser variants, anything unknown ──────────────────────────────────
check("mcp__github__create_issue -> 🧩", startLine("mcp__github__create_issue", "").split(" ")[0], "🧩");
check("browser_dialog -> 💬 (named in the registry)", startLine("browser_dialog", "").split(" ")[0], "💬");
check("a new browser_* tool -> 🌐 (family)", startLine("browser_something_new", "").split(" ")[0], "🌐");
check("a new *_search tool -> 🔍 (family)", startLine("wiki_search", "").split(" ")[0], "🔍");
check("skills_list -> 📚", startLine("skills_list", "").split(" ")[0], "📚");
check("process_manage -> ⚙️", startLine("process_manage", "").split(" ")[0], "⚙️");
check("an unknown tool -> ⚡ (the CLI default)", startLine("quantum_flux", "").split(" ")[0], "⚡");
check("no tool name at all -> ⚡ tool", startLine(undefined, ""), "⚡ tool");

// ── the line still reads the way the console expects: glyph, name, preview ───────────────────────
check("shape with a preview", startLine("terminal", "git status --short"), "💻 terminal · git status --short");
check("shape without a preview", startLine("read_file", ""), "📖 read_file");
check(
  "preview whitespace is collapsed",
  startLine("terminal", "  echo   a\n\tb  "),
  "💻 terminal · echo a b",
);
check(
  "a 400-char preview is cut to 240",
  startLine("terminal", "x".repeat(400)).length,
  "💻 terminal · ".length + 240,
);

// ── the result line is untouched: the arrow still separates a call from its output ───────────────
const jr = { id: "j2", lines: [], curText: null };
jobs.consume(jr, { event: "tool.completed", tool: "read_file", preview: JSON.stringify({ content: "a\nb" }), duration: 1.234 });
check("result line keeps ↳", jr.lines[0].text.trim(), "↳ read_file · 1.23s");
check("and its output follows", jr.lines[1].text, "a");
check("result lines carry no glyph", /[📖💻🔧]/.test(jr.lines[0].text), false);

// ── the browser's live-clock pairing must survive the glyph ──────────────────────────────────────
// The regex is read out of public/app.js rather than copied, so this test tracks the shipped source.
const appSrc = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const reLine = appSrc.split("\n").find((l) => l.startsWith("const TOOL_START_RE")) ?? "";
check("the shipped regex is glyph-aware", /\\p\{Extended_Pictographic\}/.test(reLine), true);
const rhs = reLine.slice(reLine.indexOf("=") + 1).trim();
const literal = /^\/(.*)\/([a-z]*)\s*;?$/.exec(rhs);
check("the shipped regex parses as a literal", Boolean(literal), true);
const shipped = new RegExp(literal[1], literal[2]);
const name = (line) => shipped.exec(line)?.[1] ?? null;
check("📖 read_file · x", name("📖 read_file · C:/x.js"), "read_file");
check("💻 terminal · x", name("💻 terminal · git status"), "terminal");
check("🖥️ read_terminal · x (VS16)", name("🖥️ read_terminal · x"), "read_terminal");
check("🧩 mcp__github__create_issue · x", name("🧩 mcp__github__create_issue · OAUTH-441"), "mcp__github__create_issue");
check("legacy ▸ patch · x", name("▸ patch · src/a.js"), "patch");
check("a glyph line with no preview", name("🔎 search_files"), "search_files");

console.log(failed ? `RESULT: ${failed} FAILED` : "RESULT: ALL PASS");
process.exit(failed ? 1 : 0);
