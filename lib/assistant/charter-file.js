// The charter file: the long tier of the assistant's memory, and the three writers that share it.
//
// lib/charter.js owns the PURE text - the seed, one dated entry, the prune - and says so; this module owns the
// FILE: reading it (seeding it once when it is missing), the mtime guard, and the two refusal codes the panel's
// route maps to 409 and 413. The reader's PUT, the assistant's own CHARTER: line and addRule's automatic entry
// all land here, and the mtime guard is the only thing keeping them apart: `readCharterFile` reports when the
// bytes moved, `writeCharterFile` refuses to overwrite a file that moved since the caller read it, and
// `appendCharterEntry` deliberately bypasses that guard because it appends rather than replaces.
//
// Nothing here holds state: the path comes in, the bytes come back. The `charterSeeded` flag, the journal and
// the emit stay on the class, which is the only object that knows what a seed MEANT.

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CHARTER_MAX_CHARS, appendEntry, seedCharter } from "../charter.js";
import { reasonOf } from "./read.js";

/**
 * Read the charter, seeding it once from what the scratchpad already holds when there is no file yet.
 * @param seed - the arguments for lib/charter.js's `seedCharter` ({ rules, notes, panelDir }); omit it and a
 *   missing file is simply an empty charter.
 * @returns {{ text: string, seeded: boolean, chars: number, error: string|null }}
 *   seeded means this call CREATED the file, which is the one thing the caller journals and remembers.
 */
export function readCharterFile(file, { seed = null } = {}) {
  try {
    if (!existsSync(file)) {
      if (!seed) return { text: "", seeded: false, chars: 0, error: null };
      const text = seedCharter(seed);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, text);
      return { text, seeded: true, chars: text.length, error: null };
    }
    const text = readFileSync(file, "utf8");
    return { text, seeded: false, chars: text.length, error: null };
  } catch (err) {
    // No file yet, or unreadable: an empty charter this turn rather than a boot that fails. The caller says so
    // in the log and keeps going.
    return { text: "", seeded: false, chars: 0, error: reasonOf(err) };
  }
}

/**
 * What the page shows beside the box: the path, when it was last written, how big it is against the cap.
 * One read, so `chars` and `mtime` describe the same bytes rather than two moments. `text` rides along so the
 * caller can keep the copy it just measured instead of reading the file a second time.
 * @returns {{ path, exists, mtime, mtimeIso, chars, cap, seeded, over, text }}
 */
export function charterMetaFor(file, { seeded = false } = {}) {
  const meta = {
    path: String(file || "").replace(/\\/g, "/"),
    exists: false,
    mtime: null,
    mtimeIso: null,
    chars: 0,
    cap: CHARTER_MAX_CHARS,
    seeded: Boolean(seeded),
    over: false,
    text: "",
  };
  try {
    const st = statSync(file);
    const text = readFileSync(file, "utf8");
    meta.text = text;
    meta.exists = true;
    meta.mtime = st.mtimeMs;
    meta.mtimeIso = new Date(st.mtimeMs).toISOString();
    meta.chars = text.length;
    meta.over = text.length > CHARTER_MAX_CHARS;
  } catch {
    // No file yet, or unreadable: the meta says so instead of reporting an empty charter as a fact.
  }
  return meta;
}

/**
 * The reader's save, or a PUT: the whole file, tmp+rename, with the two refusals this writer owns.
 * @param expectMtime - the mtime the caller READ before editing. A file that moved since (the assistant's own
 *   CHARTER: line, or the other surface) refuses the save instead of silently discarding the newer text; an
 *   absent or non-numeric value skips the guard, which is what the assistant's own writes want.
 * @returns the written body.
 * @throws err.code === "charter-stale" (moved under the caller), "charter-too-long" (over the cap),
 *   "charter-write-failed" (the write itself). The route maps the first two to 409 and 413.
 */
export function writeCharterFile(file, text, { expectMtime = null } = {}) {
  const body = String(text ?? "");
  const expect = Number(expectMtime);
  if (Number.isFinite(expect) && expect > 0) {
    let now = null;
    try {
      now = statSync(file).mtimeMs;
    } catch {
      now = null;
    }
    if (now !== null && Math.abs(now - expect) > 1) {
      const stale = new Error("the charter changed on disk since this copy was loaded — reload it and re-apply the edit");
      stale.code = "charter-stale";
      throw stale;
    }
  }
  if (body.length > CHARTER_MAX_CHARS) {
    const err = new Error(
      `the charter is ${body.length} characters and the cap is ${CHARTER_MAX_CHARS} — prune the oldest changelog entries first`,
    );
    // The route turns this into a 413 rather than a generic 400: too big is not the same refusal as broken.
    err.code = "charter-too-long";
    throw err;
  }
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, body);
    renameSync(tmp, file);
  } catch (err) {
    const e = new Error(`could not write ${file}: ${reasonOf(err)}`);
    e.code = "charter-write-failed";
    throw e;
  }
  return body;
}

/**
 * One dated entry, appended in place: the CHARTER: line, and addRule's automatic entry. Over the cap the
 * OLDEST entries go first (lib/charter.js), and a file whose PROSE alone is over the cap is left untouched -
 * dropping the reader's own words is not this function's call. Never throws: a refusal comes back as a reason
 * for the caller to journal, because both callers are inside a turn being carried out.
 * @returns {{ written: boolean, text: string, chars: number, reason: "full"|"write-failed"|null, error?: string }}
 *   `chars` is the size of the file either way (before a refusal, after a write).
 */
export function appendCharterEntry(file, before, text, { by = "assistant", kind = "" } = {}) {
  const current = String(before || "");
  const after = appendEntry(current, text, { by, kind });
  if (after === current) return { written: false, text: current, chars: current.length, reason: "full" };
  try {
    writeFileSync(file, after);
  } catch (err) {
    return { written: false, text: current, chars: current.length, reason: "write-failed", error: reasonOf(err) };
  }
  return { written: true, text: after, chars: after.length, reason: null };
}
