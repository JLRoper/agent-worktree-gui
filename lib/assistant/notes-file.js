// One assistant's scratchpad: the freeform notes its OWN turns read and write.
//
// Why a file per assistant rather than the `notes` string in assistant.json: that string is ONE field shared by
// every turn. Every assistant's preamble clipped the same 1,200 characters of it, so one assistant's notes evicted
// another's, and a NOTE written in #3's turn landed in the pad every assistant reads. The field is still there and
// still Assistant #1's — it is not migrated (the same rule ./profile.js states for #1's settings) — while every
// OTHER assistant owns `state/assistants/assistant-N/notes.md`, beside its charter and its settings file.
//
// The shape is ./charter-file.js's, deliberately: a plain read that reports whether the file exists, a tmp+rename
// write, one cap and one refusal. There is no mtime guard: a pad is one box the reader types into and one line the
// assistant appends, so last-writer-wins is what a scratchpad is.
//
// THE CAP IS THE CLIP. `preamble()` reads a pad through `clip(notes, NOTES_CAP)`, so a file longer than NOTES_CAP
// is a file whose tail no turn ever sees. The store accepted 8,000 characters and answered a save by keeping the
// tail of it, which is how the live pads came to sit at 8,000 bytes of mostly-duplicated text nothing read. The
// reader's save is now REFUSED over the cap (the charter's own contract, and a 413 on the route); the assistant's
// own appended line still lands, because `appendNoteLine` drops the OLDEST whole lines to make room.
//
// ONE NOTE HAS ONE CAP. Dropping whole lines is still eviction: at ~500 characters a note, the third such NOTE
// pushed the first out of the pad, so a long note silently took the fact before it with it. A single appended line
// is now clipped to `NOTE_LINE_CAP` first - whole words, ending in `NOTE_CLIP_MARK` - so three 500-character notes
// are three capped lines that all fit, and the caller gets the full text back to journal (`appendNoteLine().full`).
//
// IT IS SEEDED ONCE, from the shared `notes` string the panel kept before the split. The seed is the only write
// that ever copies that string, and it is deliberately a CREATE-only one (`seedNotesFile`): an assistant that
// already has a notes.md — because it was created after the split, or because the reader emptied it — is never
// touched again. That is what makes a restart idempotent, and what stops the seed from evicting a NOTE the
// assistant wrote since.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { NOTE_LINE_CAP, NOTES_CAP } from "./config.js";
import { reasonOf } from "./read.js";

/** The bullet the pad writes in front of an appended NOTE. It counts against the per-note cap. */
export const NOTE_BULLET = "- ";
/** The visible marker a clipped NOTE line ends with. */
export const NOTE_CLIP_MARK = " [clipped]";

/** Where one assistant's pad lives, relative to the state directory (beside its charter). */
export const notesRelFor = (id) => path.join("assistants", String(id || ""), "notes.md");

/**
 * Read one assistant's pad. A missing file is not an error: it is an assistant that has not written anything yet,
 * which is every new assistant.
 * @returns {{ text: string, exists: boolean, chars: number, cap: number, over: boolean, error: string|null }}
 */
export function readNotesFile(file) {
  try {
    if (!existsSync(file)) return { text: "", exists: false, chars: 0, cap: NOTES_CAP, over: false, error: null };
    const text = readFileSync(file, "utf8");
    return { text, exists: true, chars: text.length, cap: NOTES_CAP, over: text.length > NOTES_CAP, error: null };
  } catch (err) {
    // Unreadable is an empty pad this turn rather than a panel that will not boot; the caller journals the reason.
    return { text: "", exists: false, chars: 0, cap: NOTES_CAP, over: false, error: reasonOf(err) };
  }
}

/**
 * The pad trimmed to what a turn reads, OLDEST whole lines first. This is the only place text is dropped, and it
 * is for a line the ASSISTANT appended — never for the reader's save, which is refused instead. A single line
 * longer than the cap keeps its tail, because the newest text is the part that was just written.
 */
export function fitNotesText(text, cap = NOTES_CAP) {
  const body = String(text ?? "");
  if (body.length <= cap) return body;
  const lines = body.split("\n");
  while (lines.length > 1 && lines.join("\n").length > cap) lines.shift();
  const out = lines.join("\n");
  return out.length > cap ? out.slice(-cap) : out;
}

/**
 * Write one assistant's pad, tmp+rename. Over the cap the write is REFUSED and the file is left exactly as it
 * was: the cap is the number a turn reads, so a longer pad is bytes nobody would see, and silently keeping the
 * tail of a reader's paste loses the part of it they were reading.
 * @returns {{ text: string, chars: number, cap: number, refused: boolean, code?: string, error: string|null }}
 *   `text` is what is ON DISK — the existing bytes after a refusal, never a claim about what was saved.
 */
export function writeNotesFile(file, text) {
  const body = String(text ?? "");
  if (body.length > NOTES_CAP) {
    const cur = readNotesFile(file);
    return {
      text: cur.text,
      chars: cur.chars,
      cap: NOTES_CAP,
      refused: true,
      code: "notes-too-long",
      error: `the notes are ${body.length} characters and the cap is ${NOTES_CAP} — a turn reads only ${NOTES_CAP}; prune the oldest lines and save again`,
    };
  }
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, body);
    renameSync(tmp, file);
  } catch (err) {
    return { text: body, chars: body.length, cap: NOTES_CAP, refused: false, error: reasonOf(err) };
  }
  return { text: body, chars: body.length, cap: NOTES_CAP, refused: false, error: null };
}

/**
 * The room a NOTE's own TEXT gets in a stored line: the per-note cap less the pad's bullet and the marker a
 * clipped line ends with. `clipNoteLine` works inside this so `- ` + text + marker is never over the cap.
 */
export const noteTextRoom = (cap = NOTE_LINE_CAP) => Math.max(1, cap - NOTE_BULLET.length - NOTE_CLIP_MARK.length);

/**
 * Clip one NOTE's text to `cap` STORED characters, at a WORD boundary. A line that fits is returned whole. A longer
 * one keeps whole words up to the room the bullet and the marker need, and ends with `NOTE_CLIP_MARK`; a single
 * unbroken run longer than that room has no word boundary to honour and is cut at the room (the marker still says
 * it was clipped). `clipped` is true only when characters were dropped, so a caller can journal the difference.
 * @returns {{ text: string, clipped: boolean, dropped: number }}
 */
export function clipNoteLine(text, cap = NOTE_LINE_CAP) {
  const body = String(text ?? "").trim();
  const room = Math.max(1, cap - NOTE_BULLET.length);
  if (body.length <= room) return { text: body, clipped: false, dropped: 0 };
  const head = body.slice(0, Math.max(1, noteTextRoom(cap)));
  const cut = head.lastIndexOf(" ");
  const kept = (cut >= 0 ? head.slice(0, cut) : head).replace(/\s+$/, "");
  const out = `${kept}${NOTE_CLIP_MARK}`;
  const fitted = out.length > cap ? out.slice(0, cap) : out;
  return { text: fitted, clipped: true, dropped: body.length - kept.length };
}

/**
 * Every non-empty line of a pad, with its OWN length: the Pad tab draws this beside each note instead of only the
 * pad's total. `chars` is the stored line's length, the same number `NOTE_LINE_CAP` bounds, so an appended NOTE
 * reads `n/200` and can never read over it. `clipped` says the line ends with the marker.
 * @returns {{ text: string, chars: number, cap: number, clipped: boolean }[]}
 */
export function noteLines(text, cap = NOTE_LINE_CAP) {
  return String(text ?? "")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => ({ text: line, chars: line.length, cap, clipped: line.endsWith(NOTE_CLIP_MARK) }));
}

/**
 * One line appended by the assistant's own turn: `${before}\n- ${line}`, with the line CLIPPED to `NOTE_LINE_CAP`
 * first and the OLDEST lines dropped only if the result still does not fit. The reader's save is refused over the
 * pad's cap; this is not that save — a NOTE that cannot be kept at all is a note the assistant wrote and the panel
 * then lost, which is the bug the pad exists to avoid. `full` is the text as the turn wrote it, BEFORE the clip, so
 * the NOTE action can journal what the pad could not hold.
 * @returns {{ text: string, chars: number, cap: number, refused: boolean, error: string|null,
 *   appended: boolean, full: string, clipped: boolean }}
 */
export function appendNoteLine(file, line) {
  const before = readNotesFile(file).text;
  const text = String(line ?? "").trim();
  if (!text) return { ...readNotesFile(file), appended: false, full: "", clipped: false };
  const cut = clipNoteLine(text);
  const next = fitNotesText(`${before}${before ? "\n" : ""}${NOTE_BULLET}${cut.text}`);
  const out = writeNotesFile(file, next);
  return { ...out, appended: !out.error && !out.refused, full: text, clipped: cut.clipped };
}

/**
 * Seed one assistant's pad ONCE from the text the panel kept before the split. A file that exists is read and
 * left exactly as it is — even an empty one, which is a pad the reader emptied rather than one that was never
 * written — so calling this on every boot is idempotent and can never undo the assistant's own NOTE lines.
 * The seed is fitted to the cap rather than refused: it copies an old store's string, and a refused seed would
 * leave a new assistant with no pad at all.
 * @returns {{ text: string, seeded: boolean, chars: number, exists: boolean, error: string|null }}
 */
export function seedNotesFile(file, text = "") {
  try {
    if (existsSync(file)) {
      const cur = readNotesFile(file);
      return { text: cur.text, seeded: false, chars: cur.chars, exists: true, error: cur.error };
    }
    const out = writeNotesFile(file, fitNotesText(text));
    return { text: out.text, seeded: !out.error, chars: out.chars, exists: true, error: out.error };
  } catch (err) {
    return { text: "", seeded: false, chars: 0, exists: false, error: reasonOf(err) };
  }
}
