// ---- the one convention for a file attached to a prompt ----------------------------------------
//
// The gateway's runs API has no attachment field, so a document is stored by the panel
// (POST /api/attachments, under config.attachmentsDir) and its ABSOLUTE PATH is appended to the
// reader's message. public/board/attachments.js builds that line in the page; this module builds and
// reads the SAME line on the server, because a SPAWN harvest has to answer a question the page
// answered once already: which files was this turn handed?
//
// Three rules, and they are the whole module:
//
//   * the line is the browser's, byte for byte — `Attachment: <abs path> (<type>, <size>) —
//     read_file it before answering.` (or `use vision_analyze on it` for an image). public/app.js
//     strips exactly this shape for display (ATTACH_BLOCK_RE), so a line written here is recognised
//     there and a chip on the reader's turn is a chip on the worker's;
//   * a path OUTSIDE the panel's attachments directory is never inherited. The panel stored every
//     file it accepted, so a path that is not one of those is somebody naming an arbitrary file in a
//     message — `inheritAttachments` is the only gate, and it answers keep/dropped so the drop can be
//     SAID instead of happening in silence;
//   * nothing here reads or writes a job, a store or the page. Text in, text out.
import path from "node:path";
import { insideDir } from "./paths.js";

// The page's own size formatter (public/core/dom-format.js `fmtBytes`), reproduced rather than
// imported: it is a browser global, and a server that rounded differently would write a line the
// page still strips but a reader would see changed.
export function fmtBytes(n) {
  const bytes = Number(n) || 0;
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

// Which instruction the file's type earns: an image is looked at, everything else is read.
export function attachmentHow(a) {
  return /^image\//.test(String(a?.type || "")) ? "use vision_analyze on it" : "read_file it";
}

// One attachment, as the message carries it. The path is written with forward slashes: that is what
// POST /api/attachments answers with, and a backslashed one would still match but would not read the
// same on both sides of the line.
export function attachmentLine(a) {
  const p = String(a?.path ?? "").replace(/\\/g, "/");
  return `Attachment: ${p} (${a?.type || "unknown type"}, ${fmtBytes(a?.bytes)}) — ${attachmentHow(a)} before answering.`;
}

// A turn's whole block, in the page's own placement: two newlines before each line, appended to the
// message. Empty for a turn that carried nothing, which is what keeps that turn's text unchanged.
export function attachmentBlock(list) {
  return (Array.isArray(list) ? list : []).map((a) => `\n\n${attachmentLine(a)}`).join("");
}

// The one line shape the page writes. Found ANYWHERE in a line, not only as a whole line: the page appends
// its block on lines of its own, but a SPAWN line's brief is one line by grammar, so a line the assistant
// wrote sits after the pipe on the same line as the brief and still has to be recognised — and taken out.
// The path is matched non-greedily up to the type field so a filename carrying brackets (`report (1).pdf`)
// still parses: the type may not contain brackets, so the first `(<type>, <size>)` after the path is the
// one that belongs to the line.
const BLOCK_RE = /Attachment: (.+?) \(([^()]*), (\d+(?:\.\d+)?) (KB|MB)\) — (read_file it|use vision_analyze on it) before answering\./g;
const freshBlockRe = () => new RegExp(BLOCK_RE.source, "g");

const KILO = 1024;
const MEGA = 1024 * 1024;

function fromMatch(m) {
  const bytes = Math.round(Number(m[3]) * (m[4] === "MB" ? MEGA : KILO));
  const p = String(m[1]).replace(/\\/g, "/").trim();
  return {
    path: p,
    name: path.basename(p),
    // The type the line carried, and the instruction it earned. "unknown type" is the page's word for
    // a file it had no type for, so it reads back as no type at all rather than as a mime called
    // "unknown type"; the instruction is re-derived from the type, and the two always agree because
    // that is how the page wrote them.
    type: m[2] === "unknown type" ? "" : String(m[2]).trim(),
    bytes,
  };
}

// Every Attachment: line in a piece of text, in order.
export function attachmentLines(text) {
  const found = [];
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const re = freshBlockRe();
    let m;
    while ((m = re.exec(raw))) found.push(fromMatch(m));
  }
  return found;
}

// The same read, for a message: what the page appended to it.
export const parseAttachmentBlock = attachmentLines;

// A piece of text with every Attachment: line taken out, and the lines that were there. `text` is the
// INPUT UNCHANGED when nothing matched — byte for byte, because that is the shape a turn with no
// attachments has to keep. A line that was nothing but the block goes entirely (that is how the page
// appends it, so the blank line in front of it goes too); a line that carried other words keeps them,
// with the block taken out and the gap it left closed up. Nothing outside a line that held a block is
// touched, so a multi-line brief keeps its layout.
export function stripAttachmentLines(text) {
  const src = String(text ?? "");
  if (!src) return { text: src, found: [] };
  const found = [];
  const keep = [];
  for (const raw of src.split(/\r?\n/)) {
    const re = freshBlockRe();
    let hit = false;
    let m;
    while ((m = re.exec(raw))) {
      found.push(fromMatch(m));
      hit = true;
    }
    if (!hit) {
      keep.push(raw);
      continue;
    }
    const rest = raw.replace(freshBlockRe(), "").replace(/[ \t]{2,}/g, " ").trim();
    if (rest) keep.push(rest);
  }
  if (!found.length) return { text: src, found };
  while (keep.length && !keep[keep.length - 1].trim()) keep.pop();
  return { text: keep.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd(), found };
}

// A path as this module compares and writes it: forward slashes, no trailing separator.
export const cleanPath = (p) => String(p ?? "").trim().replace(/\\/g, "/").replace(/\/+$/, "");

// One entry, trimmed to what the record and the line need (the same shape normaliseAttachments uses
// in lib/hermes-runtime.js: the path is the identity, the name is what is shown, type/bytes are the
// tooltip and the instruction).
export function normaliseOne(a) {
  const p = cleanPath(a?.path);
  if (!p) return null;
  return {
    path: p,
    name: String(a?.name || path.basename(p)).slice(0, 160),
    type: typeof a?.type === "string" ? a.type.slice(0, 80) : "",
    bytes: Number(a?.bytes) || 0,
  };
}

// THE GATE. Everything a message claims to have attached is split in two: what the panel may hand on,
// and what it refuses to. `dir` is config.attachmentsDir — the one directory the panel stores uploads
// in, so a path inside it is a file this panel received, and a path outside it is a name somebody
// typed. Case and separators are folded by insideDir, because Windows paths compare that way.
export function inheritAttachments(list, dir) {
  const keep = [];
  const dropped = [];
  const seen = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    const one = normaliseOne(raw);
    if (!one) continue;
    const key = one.path.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    (insideDir(one.path, dir) ? keep : dropped).push(one);
  }
  return { keep, dropped };
}

// Said out loud wherever a refused path matters — the child's input, its card, the journal. One
// sentence, and it names the file and the reason: "not inherited" without a why reads as a bug.
export function droppedAttachmentLine(a, dir = null) {
  const where = dir ? ` (${cleanPath(dir)})` : "";
  return `Attachment dropped: ${a?.path ?? "(no path)"} — it is outside the panel's attachments directory${where}, so it was not inherited.`;
}

// The block a child's prompt carries: the files it is handed, then one line per file that was refused.
// Always prefixed with two newlines, so it appends to a prompt the way the page appends to a message;
// empty when there is nothing to say, which leaves the prompt untouched.
export function inheritanceBlock(keep, dropped, dir = null) {
  const parts = [];
  const block = attachmentBlock(keep);
  if (block) parts.push(block.replace(/^\n\n/, ""));
  for (const a of Array.isArray(dropped) ? dropped : []) parts.push(droppedAttachmentLine(a, dir));
  return parts.length ? `\n\n${parts.join("\n\n")}` : "";
}
