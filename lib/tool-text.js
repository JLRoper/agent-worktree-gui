// A tool result is JSON on the wire and prose in the console.
//
// Both places a result reaches the panel from - the run stream's `tool.completed` preview and the session
// store's `messages.content` - carry a JSON envelope: `{"output": "..."}` for terminal, `{"success": true,
// "diff": "..."}` for patch, `{"status": "ok", ...}` for the rest. The console draws text, so the envelope
// is unwrapped HERE, once, for both paths. Printing it raw puts literal `\n`, backslash-escaped Windows
// paths and a wall of braces in front of the reader, which is what a stored patch diff used to look like.
//
// The preview is also capped by the gateway (~500 chars, "..." appended) and cut mid-string, so the
// tolerant path has to survive a payload JSON.parse refuses.

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

// Fields that carry a result's text. patch answers with `diff`, terminal with `output`, a refusal with
// `error` - and every one of them is preferred over the envelope itself.
const DIFF_KEYS = ["diff", "patch"];
const TEXT_KEYS = ["output", "text", "stdout", "result", "content", "message", "error"];

const clean = (s) => String(s ?? "").replace(ANSI, "").replace(/\r\n?/g, "\n");

// How a nested value reads in a one-line summary: saying how big it is beats dumping it.
function scalar(v) {
  if (v === null || v === undefined) return "null";
  if (Array.isArray(v)) return `[${v.length}]`;
  if (typeof v === "object") return "{…}";
  return String(v).replace(/\s+/g, " ").trim();
}

// The fields worth one trailing line: they answer what the text leaves open.
function notesFor(o) {
  const out = [];
  const exit = o.exit_code;
  if (exit !== undefined && exit !== null && Number(exit) !== 0) out.push(`exit ${exit}`);
  const lint = o.lint && typeof o.lint === "object" ? o.lint : null;
  if (lint && lint.status && lint.status !== "ok") out.push(`lint: ${scalar(lint.status)}`);
  const files = Array.isArray(o.files_modified) ? o.files_modified : null;
  if (files && files.length > 1) out.push(`${files.length} files`);
  return out;
}

// One object, one readable body. A payload with no text field at all still has to read as prose, so its
// keys become `key: value` lines instead of JSON.stringify's braces.
function bodyFromObject(o) {
  const failed = o.success === false || o.ok === false;
  if (failed) {
    const why = ["error", "output", "text", "message", "stderr"].find((k) => typeof o[k] === "string" && o[k].trim());
    if (why) return o[why];
  }
  for (const k of DIFF_KEYS) if (typeof o[k] === "string" && o[k].trim()) return o[k];
  for (const k of TEXT_KEYS) if (typeof o[k] === "string" && o[k].trim()) return o[k];
  const keys = Object.keys(o);
  if (!keys.length) return "";
  return keys.map((k) => `${k}: ${scalar(o[k])}`).join("\n");
}

/**
 * Unwrap a tool result to the text a console can draw.
 * @returns {{text: string, truncated: boolean, notes: string[]}}
 *   truncated - the payload was cut (by the gateway's preview cap) and the text is a salvage of it.
 *   notes - facts the text cannot carry: a non-zero exit, a failed lint, several changed files.
 */
function unwrapRaw(raw) {
  const text = clean(raw);
  if (!text.trim()) return { text: "", truncated: false, notes: [] };
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed === "string") return { text: parsed.replace(/\r\n?/g, "\n"), truncated: false, notes: [] };
    if (parsed && typeof parsed === "object") {
      if (Array.isArray(parsed)) return { text: parsed.map(scalar).join("\n"), truncated: false, notes: [] };
      return { text: bodyFromObject(parsed), truncated: false, notes: notesFor(parsed) };
    }
    return { text, truncated: false, notes: [] };
  } catch {
    /* a cut preview, or already text */
  }
  // Tolerant path: pull the first non-empty text field out of a payload we cannot parse — in the order the
  // unwrapper cares about, not the order the payload happens to print them, so `{"output":"","error":"no such
  // file"` still reads as the refusal. A half-written escape or the gateway's own "..." would otherwise survive
  // into the console.
  // A payload that ends with a quote or a brace arrived whole; anything else was cut mid-string by the gateway.
  const cut = !/["}]\s*$/.test(text);
  for (const field of [...DIFF_KEYS, ...TEXT_KEYS]) {
    const m = new RegExp(`"${field}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`).exec(text);
    if (!m || !m[1].trim()) continue;
    let body = m[1];
    if (body.endsWith("\\")) body = body.slice(0, -1);
    try {
      body = JSON.parse(`"${body}"`);
    } catch {
      /* leave the raw escapes rather than lose the text */
    }
    body = body.replace(/\s*\.\.\.$/, "").replace(/\r\n?/g, "\n");
    return { text: body, truncated: cut, notes: [] };
  }
  // Nothing readable in it. A JSON wall is worse than saying it was cut — but text that merely starts with a
  // bracket is text: `[terminal] ran `ls` -> exit 0` and `[Tool execution cancelled …]` are real stored results
  // (403 of 22,878 on this box), and blanking them is losing output, not cleaning it up.
  const envelope = /^\s*\{\s*"/.test(text);
  return { text: envelope ? "" : text, truncated: envelope, notes: [] };
}

// One exit point: a parsed field can still carry CRLF (the diff of a CRLF source file is lines of it) and ANSI
// colour (a terminal's output is escaped inside the JSON string, so stripping the raw payload never reached it),
// so both are normalised after the envelope is out of the way.
export function unwrapToolText(raw) {
  const r = unwrapRaw(raw);
  return { text: clean(r.text), truncated: r.truncated, notes: r.notes };
}


