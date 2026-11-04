// One assistant's scratchpad: the freeform notes its OWN turns read and write.
//
// Why a file per assistant rather than the `notes` string in assistant.json: that string is ONE field shared by
// every turn. Every assistant's preamble clipped the same 1,200 characters of it, so one assistant's notes evicted
// another's, and a NOTE written in #3's turn landed in the pad every assistant reads. The field is still there and
// still Assistant #1's — it is not migrated (the same rule ./profile.js states for #1's settings) — while every
// OTHER assistant owns `state/assistants/assistant-N/notes.md`, beside its charter and its settings file.
//
// The shape is ./charter-file.js's, deliberately: a plain read that reports whether the file exists, a tmp+rename
// write, one cap and one reason. There is no mtime guard: a pad is one box the reader types into and one line the
// assistant appends, so last-writer-wins is what a scratchpad is.
//
// IT IS SEEDED ONCE, from the shared `notes` string the panel kept before the split. The seed is the only write
// that ever copies that string, and it is deliberately a CREATE-only one (`seedNotesFile`): an assistant that
// already has a notes.md — because it was created after the split, or because the reader emptied it — is never
// touched again. That is what makes a restart idempotent, and what stops the seed from evicting a NOTE the
// assistant wrote since.
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

/**
 * Seed one assistant's pad ONCE from the text the panel kept before the split. A file that exists is read and
 * left exactly as it is — even an empty one, which is a pad the reader emptied rather than one that was never
 * written — so calling this on every boot is idempotent and can never undo the assistant's own NOTE lines.
 * @returns {{ text: string, seeded: boolean, chars: number, exists: boolean, error: string|null }}
 */
export function seedNotesFile(file, text = "") {
  try {
    if (existsSync(file)) {
      const cur = readNotesFile(file);
      return { text: cur.text, seeded: false, chars: cur.chars, exists: true, error: cur.error };
    }
    const out = writeNotesFile(file, text);
    return { text: out.text, seeded: !out.error, chars: out.chars, exists: true, error: out.error };
  } catch (err) {
    return { text: "", seeded: false, chars: 0, exists: false, error: reasonOf(err) };
  }
}
