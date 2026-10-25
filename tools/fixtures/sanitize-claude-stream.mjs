// Sanitise a raw `claude -p --output-format stream-json` capture into a fixture for tools/verify-claude-transport.mjs.
// Keeps the lines the panel reads (init, assistant text/tool_use, user tool_result, result) and drops hook events,
// rate-limit events, thinking blocks and signatures, the tool catalogue, and the cwd.
//
//   node tools/fixtures/sanitize-claude-stream.mjs <raw.jsonl> <out.jsonl>
import { readFileSync, writeFileSync } from "node:fs";

const [inFile, outFile] = process.argv.slice(2);
if (!inFile || !outFile) {
  console.error("usage: node tools/fixtures/sanitize-claude-stream.mjs <raw.jsonl> <out.jsonl>");
  process.exit(2);
}

const out = [];
for (const line of readFileSync(inFile, "utf8").split("\n")) {
  if (!line.trim()) continue;
  const o = JSON.parse(line);
  if (o.type === "system" && o.subtype === "init") {
    out.push({ type: "system", subtype: "init", cwd: "<worktree>", session_id: o.session_id, model: o.model });
  } else if (o.type === "assistant") {
    const content = (o.message?.content || [])
      .filter((b) => b.type !== "thinking")
      .map((b) => (b.type === "tool_use" ? { type: "tool_use", id: b.id, name: b.name, input: b.input } : { type: b.type, text: b.text }));
    if (content.length) out.push({ type: "assistant", message: { model: o.message.model, role: "assistant", content }, session_id: o.session_id });
  } else if (o.type === "user") {
    const content = (o.message?.content || []).map((b) => ({ type: b.type, tool_use_id: b.tool_use_id, content: b.content, is_error: b.is_error }));
    out.push({ type: "user", message: { role: "user", content }, session_id: o.session_id });
  } else if (o.type === "result") {
    out.push({
      type: "result",
      subtype: o.subtype,
      is_error: o.is_error,
      num_turns: o.num_turns,
      result: o.result,
      total_cost_usd: o.total_cost_usd,
      usage: o.usage,
      permission_denials: o.permission_denials,
      stop_reason: o.stop_reason,
      session_id: o.session_id,
    });
  }
}
writeFileSync(outFile, out.map((o) => JSON.stringify(o)).join("\n") + "\n");
console.log(out.map((o) => o.type + (o.subtype ? `/${o.subtype}` : "")).join(" "));
