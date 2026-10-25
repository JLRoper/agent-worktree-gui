// A tool result reaches the console as TEXT, never as the JSON envelope it travelled in.
//
//   node tools/verify-tool-output.mjs
//
// Two paths hand a result to the console - the run stream's `tool.completed` preview (empty for patch/write_file on
// this gateway) and the session store's `messages.content` read back by /api/tool-results - and both used to print
// the envelope verbatim: `{"success":true,"diff":"--- a/...\n+++ b/...` with literal backslash-n, in a <pre>.
// lib/tool-text.js is the one unwrapper both use; this reads the shipped module, not a copy.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { unwrapToolText } from "../lib/tool-text.js";
import { toolResults } from "../lib/tool-results.js";

// What the console must never receive: a JSON envelope drawn as text (`{"key": ...`) or a literal backslash-n from
// an escaped newline that was never decoded.
const looksLikeJsonEnvelope = (s) => /^\s*\{\s*"[^"]+"\s*:/.test(String(s ?? ""));

let failed = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}: ${JSON.stringify(got)}${ok ? "" : `  (wanted ${JSON.stringify(want)})`}`);
};
const ok = (name, cond, detail) => {
  if (!cond) failed++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
};

// ── a patch result: the diff IS the output, and the JSON quotes must not survive ──────────────────
const diff = "--- a/C:/x/lib/jobs.js\r\n+++ b/C:/x/lib/jobs.js\r\n@@ -456,6 +456,7 @@\r\n-old\r\n+new";
const patch = unwrapToolText(JSON.stringify({ success: true, diff, files_modified: ["C:/x/lib/jobs.js"], lint: { status: "ok", output: "" } }));
check("patch: the diff is the text", patch.text, diff.replace(/\r\n/g, "\n"));
check("patch: no braces or escaped newlines", looksLikeJsonEnvelope(patch.text) || patch.text.includes("\\n"), false);
check("patch: one changed file is not a note", patch.notes, []);

const many = unwrapToolText(JSON.stringify({ success: true, diff, files_modified: ["a", "b"], lint: { status: "failed" } }));
check("patch: several files and a failed lint are noted", many.notes, ["lint: failed", "2 files"]);

// ── a terminal result: output plus the facts the text cannot carry ────────────────────────────────
const term = unwrapToolText(JSON.stringify({ output: "on main\nnothing to commit", exit_code: 2 }));
check("terminal: output", term.text, "on main\nnothing to commit");
check("terminal: a non-zero exit is noted", term.notes, ["exit 2"]);
check("terminal: a clean exit is not", unwrapToolText(JSON.stringify({ output: "ok", exit_code: 0 })).notes, []);

const refused = unwrapToolText(JSON.stringify({ success: false, error: "no such file: C:/x" }));
check("a refusal reads as its error", refused.text, "no such file: C:/x");

// ── a preview the gateway cut mid-string: salvage the field, say it was cut ──────────────────────
const cut = unwrapToolText('{"output":"line one\nline two","exit_code":0,"pad":"aaa');
check("cut preview: the readable field survives", cut.text, "line one\nline two");
check("cut preview: flagged as truncated", cut.truncated, true);
ok("cut preview: no envelope left", !looksLikeJsonEnvelope(cut.text), cut.text);

// ── an object with no text field: key/value lines, because a console draws text ──────────────────
const odd = unwrapToolText(JSON.stringify({ status: "ok", data: [1, 2, 3], nested: { a: 1 } }));
check("unknown object reads as key: value", odd.text, "status: ok\ndata: [3]\nnested: {…}");

// ── plain text passes through, ansi stripped, literal braces still readable if not JSON ──────────
check("plain text", unwrapToolText("warning: 3 files changed").text, "warning: 3 files changed");
check("ansi colour is stripped", unwrapToolText("\u001b[31mfailed\u001b[0m").text, "failed");
check("a JSON-ish wall with nothing readable is not printed", unwrapToolText('{"a":1,"b').text, "");

// Text that merely starts with a bracket is text: 403 of 22,878 stored rows on this box look like this, and blanking
// them loses output rather than cleaning it up.
check("a bracketed line survives", unwrapToolText("[terminal] ran `ls` -> exit 0, 12 lines out").text, "[terminal] ran `ls` -> exit 0, 12 lines out");
check("a cancelled-tool marker survives", unwrapToolText("[Tool execution cancelled — terminal was abandoned]").text, "[Tool execution cancelled — terminal was abandoned]");
check("ansi inside a JSON envelope is stripped after unescaping", unwrapToolText(JSON.stringify({ output: "\u001b[31mred\u001b[0m" })).text, "red");
check("a complete payload is not called cut", unwrapToolText(JSON.stringify({ output: "a\nb" })).truncated, false);

// A refusal whose empty output comes first still reads as the refusal, not as nothing.
const cutRefusal = unwrapToolText('{"output":"","error":"no such file: C:/x","pad":"aaa');
check("cut refusal: the error wins over an empty output", cutRefusal.text, "no such file: C:/x");

// ── the store path: same unwrapping, in order ───────────────────────────────────────────────────
const dir = mkdtempSync(join(tmpdir(), "wtgui-toolout-"));
const dbPath = join(dir, "state.db");
const db = new DatabaseSync(dbPath);
db.exec("create table messages (id integer primary key, session_id text, role text, tool_name text, tool_call_id text, content text, timestamp real)");
const ins = db.prepare("insert into messages (session_id, role, tool_name, tool_call_id, content, timestamp) values (?, 'tool', ?, ?, ?, ?)");
ins.run("s1", "patch", "call-a", JSON.stringify({ success: true, diff: "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b" }), 1000);
ins.run("s1", "patch", "call-b", JSON.stringify({ success: true, diff: "--- a/y\n+++ b/y\n@@ -2 +2 @@\n-c\n+d" }), 1001);
ins.run("s1", "terminal", "call-c", JSON.stringify({ output: "hi", exit_code: 1 }), 1002);
db.close();

const rows = toolResults({ dbPath, sessionId: "s1", tool: "patch", from: 999000, to: 1002000 });
check("store: one row per result", rows.length, 2);
ok("store: the text is the diff", rows[0].text.startsWith("--- a/x\n+++ b/x"), rows[0].text.slice(0, 40));
ok("store: no envelope", !looksLikeJsonEnvelope(rows[0].text), rows[0].text.slice(0, 40));
const termRows = toolResults({ dbPath, sessionId: "s1", tool: "terminal", from: 999000, to: 1002000 });
check("store: notes ride along as a line", termRows[0].text, "hi\n(exit 1)");
check("store: a limit is honoured", toolResults({ dbPath, sessionId: "s1", tool: "patch", from: 999000, limit: 1 }).length, 1);
// The panel's endedAt can be a moment before the turn's last tool row: the window keeps two seconds of slack.
check("store: a row just after the turn's end is still read", toolResults({ dbPath, sessionId: "s1", tool: "terminal", from: 999000, to: 1000500 }).length, 1);
check("store: an unknown session is empty, not a throw", toolResults({ dbPath, sessionId: "nope", tool: "patch" }), []);

rmSync(dir, { recursive: true, force: true });

console.log(failed ? `RESULT: ${failed} FAILED` : "RESULT: ALL PASS");
process.exit(failed ? 1 : 0);
