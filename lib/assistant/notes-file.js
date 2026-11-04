// One assistant's scratchpad: the freeform notes its OWN turns read and write.
//
// Why a file per assistant rather than the `notes` string in assistant.json: that string is ONE field shared by
// every turn. Every assistant's preamble clipped the same 1,200 characters of it, so one assistant's notes evicted
// another's, and a NOTE written in #3's turn landed in the pad every assistant reads. The field is still there and
// still Assistant #1's — it is not migrated (the same rule ./profile.js states for #1's settings) — while every
// OTHER assistant owns `state/assistants/assistant-N/notes.md`, beside its charter and its settings file.
//
// The shape is ./charter-file.js's, deliberately: a plain read that reports whether the file exists, a tmp+rename
// write, one cap and one reason. There is no seed and no mtime guard, and both omissions are on purpose — a pad is
// one box the reader types into and one line the assistant appends, so last-writer-wins is what a scratchpad is,
// and a new assistant starts EMPTY rather than inheriting the shared blob (the reader can move anything worth
// keeping by hand). Nothing here holds state: the path comes in, the bytes come back.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { LINE_CAP } from "./config.js";
import { reasonOf } from "./read.js";

/** Where one assistant's pad lives, relative to the state directory (beside its charter). */
export const notesRelFor = (id) => path.join("assistants", String(id || ""), "notes.md");

/**
 * Read one assistant's pad. A missing file is not an error: it is an assistant that has not written anything yet,
 * which is every new assistant.
 * @returns {{ text: string, exists: boolean, chars: number, error: string|null }}
 */
export function readNotesFile(file) {
  try {
    if (!existsSync(file)) return { text: "", exists: false, chars: 0, error: null };
    const text = readFileSync(file, "utf8");
    return { text, exists: true, chars: text.length, error: null };
  } catch (err) {
    // Unreadable is an empty pad this turn rather than a panel that will not boot; the caller journals the reason.
    return { text: "", exists: false, chars: 0, error: reasonOf(err) };
  }
}

/**
 * Write one assistant's pad, tmp+rename. Over the cap the OLDEST text goes first, exactly as the store's own
 * `setNotes` and the NOTE harvest cap the string: the tail is the part the assistant last wrote.
 * @returns {{ text: string, chars: number, error: string|null }} — the bytes on disk (after the cap), never a throw;
 *   the caller journals a failure and the route turns it into a 400.
 */
export function writeNotesFile(file, text) {
  const body = String(text ?? "").slice(-LINE_CAP);
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, body);
    renameSync(tmp, file);
  } catch (err) {
    return { text: body, chars: body.length, error: reasonOf(err) };
  }
  return { text: body, chars: body.length, error: null };
}
