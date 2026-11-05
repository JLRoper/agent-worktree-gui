// The Matrix bridge's own reminder list — and a READ-ONLY view of the assistants' watches.
//
// Two lists, deliberately never one:
//
//   reminders  the bridge's own. The reader says "remind me to check the deploy", the panel stores it here
//              (`matrix-reminders.json` in the state folder, beside the policy), and the bridge carries it
//              into every turn from GET /api/matrix/reminders. It has no thread, no worktree and no queue:
//              a reminder is a line of text the reader asked to be reminded of, and completing one writes a
//              `doneAt` stamp rather than moving anything between states. The bridge keeps NO task queue of
//              its own — work it files belongs to an assistant's queue, and a second queue here would be a
//              place for a job to disappear into.
//
//   watches    an ASSISTANT's. A watch is at least a thread (lib/assistant.js `addWatch`) and it wakes an
//              assistant, edits a card and files an alert; none of that is the bridge's to do. This module
//              only PROJECTS them for the phone view — `watchesView` copies a handful of fields, the answer
//              says `readOnly: true`, and the POST dispatcher refuses every body that tries to write one.
//              The bridge may surface a watch ("the deploy watch is still running") and never create,
//              complete, re-title or delete it.
//
// The file is the panel's, not the bridge's: a save is tmp+rename over the whole JSON document, exactly like
// the policy's whole-file write, so a reader editing the list while a turn reads it gets one version or the
// other rather than half a document. Nothing here is a credential and nothing here is copied to the room by
// any route.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

export const MATRIX_REMINDERS_MAX = 200;
export const MATRIX_REMINDER_TEXT_MAX = 500;
// The keys a body may NOT carry: each is a way of asking this route to write an assistant's watch. Naming
// them is the refusal, so a future page that sends one finds out instead of having it silently dropped.
export const WATCH_WRITE_KEYS = ["watches", "watch", "watchId", "watchState", "assistantId"];

const slash = (p) => String(p || "").replace(/\\/g, "/");
const clean = (v) => String(v == null ? "" : v).trim();

function reminderError(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

// One stored row. Unknown fields are not carried: the shape is the panel's, and a hand-edited file must not
// be able to smuggle a field into a turn. `kind` is what keeps a reminder distinguishable from a watch on the
// wire — an assistant's watch has a `thread` and a `state`, a reminder has neither.
function normalizeReminder(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const text = clean(raw.text).slice(0, MATRIX_REMINDER_TEXT_MAX);
  if (!text) return null;
  const due = clean(raw.due) || null;
  const createdAt = clean(raw.createdAt) || new Date().toISOString();
  const doneAt = clean(raw.doneAt) || null;
  return {
    id: clean(raw.id) || `br-${randomUUID().slice(0, 8)}`,
    kind: "bridge-reminder",
    text,
    due,
    createdAt,
    doneAt,
    source: "bridge",
  };
}

// The two open/closed questions a turn or the page asks of the list. Computed, never stored: a `done` field
// beside `doneAt` is a second truth that can disagree with the stamp it is derived from.
export function reminderCounts(reminders = []) {
  const list = Array.isArray(reminders) ? reminders : [];
  const done = list.filter((r) => Boolean(r && r.doneAt)).length;
  return { total: list.length, open: list.length - done, done, cap: MATRIX_REMINDERS_MAX };
}

// The assistants' watches, projected for reading. `readOnly` rides on every row as well as on the payload:
// a consumer that only ever sees one row still cannot mistake it for something it may write.
export function watchesView(watches = []) {
  return (Array.isArray(watches) ? watches : [])
    .filter((w) => w && typeof w === "object")
    .map((w) => {
      const minutes = Number(w.minutes);
      return {
        id: clean(w.id),
        kind: "watch",
        title: clean(w.title),
        state: clean(w.state) || "watching",
        assistantId: clean(w.assistantId) || "assistant-1",
        thread: clean(w.thread),
        at: clean(w.at) || null,
        doneWhen: clean(w.doneWhen) || null,
        minutes: Number.isFinite(minutes) && minutes > 0 ? minutes : null,
        readOnly: true,
      };
    });
}

// What a turn carries. Two headings, because the two lists have two different permissions; the watches one
// says READ ONLY in the instruction itself, so the model is told what the route also enforces. An empty
// list of both is the empty string — a heading with nothing under it is noise in every turn.
export function matrixRemindersPreamble({ reminders = [], watches = [] } = {}) {
  const open = (Array.isArray(reminders) ? reminders : []).filter((r) => r && !r.doneAt);
  const done = (Array.isArray(reminders) ? reminders : []).filter((r) => r && r.doneAt);
  const watching = watchesView(watches);
  const parts = [];
  if (open.length || done.length) {
    const line = (r) => `- [${r.doneAt ? "x" : " "}] ${r.text}${r.due ? ` — due ${r.due}` : ""}${r.doneAt ? ` (done ${r.doneAt})` : ""}`;
    parts.push("## Reminders you keep for the reader (the panel's list — not an assistant's watches)", ...open.map(line), ...done.map(line));
  }
  if (watching.length) {
    parts.push(
      "## Assistants' watches — READ ONLY",
      "These belong to the assistants. You may mention one if it is relevant; never create, complete, re-title or delete one from this bridge.",
      ...watching.map((w) => `- ${w.title} — ${w.state} (${w.assistantId}${w.thread ? `, ${w.thread}` : ""})`),
    );
  }
  return parts.length ? `${parts.join("\n")}\n` : "";
}

export class MatrixRemindersStore {
  constructor({ file = "", watches = () => [] } = {}) {
    this.file = String(file || "");
    // A getter, not a snapshot: the assistants' list changes between two reads of the Bridge tab, and a store
    // that captured it at boot would draw a stale watch list for as long as the panel runs.
    this.watchSource = typeof watches === "function" ? watches : () => watches;
  }

  // The file, as the panel wrote it. A hand-edited or half-written document reads as no list rather than as a
  // crash in a render: every row is normalized, and a row that cannot be normalized is dropped.
  read() {
    let exists = false;
    let mtime = null;
    let raw = null;
    try {
      const st = statSync(this.file);
      exists = true;
      mtime = st.mtimeMs;
      raw = JSON.parse(readFileSync(this.file, "utf8"));
    } catch {
      return { exists: false, mtime: null, reminders: [] };
    }
    const list = Array.isArray(raw) ? raw : raw && Array.isArray(raw.reminders) ? raw.reminders : [];
    return {
      exists,
      mtime,
      reminders: list.map(normalizeReminder).filter(Boolean).slice(0, MATRIX_REMINDERS_MAX),
    };
  }

  // The one answer both the page and the bridge read. `reminders` is this store's; `watches` is a projection
  // of the assistants' and says so. `preamble` is what the bridge's turn appends verbatim, so the heading and
  // the two permissions are decided here rather than being re-invented in Python.
  payload() {
    const { exists, mtime, reminders } = this.read();
    const watches = watchesView(this.watchSource());
    return {
      kind: "matrix-reminders",
      path: slash(this.file),
      exists,
      saved: exists,
      mtime,
      mtimeIso: mtime == null ? null : new Date(mtime).toISOString(),
      reminders,
      counts: reminderCounts(reminders),
      watches,
      watchesReadOnly: true,
      watchesNote: "the assistants' watches are read-only here — the bridge may mention one, never write one",
      preamble: matrixRemindersPreamble({ reminders, watches }),
    };
  }

  write(reminders) {
    const list = (Array.isArray(reminders) ? reminders : []).map(normalizeReminder).filter(Boolean);
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify({ version: 1, reminders: list }, null, 2)}\n`, "utf8");
      renameSync(tmp, this.file);
    } catch (err) {
      throw reminderError(`could not write ${this.file}: ${String((err && err.message) || err)}`, "reminders-write-failed");
    }
    return list;
  }

  add({ text, due } = {}) {
    // A string and nothing else: the same rule the policy route applies to `text`, so a number or an object is a
    // bad body rather than a reminder whose words the page never wrote.
    if (typeof text !== "string") throw reminderError("a reminder needs some text — send { \"text\": \"…\" }", "reminder-text-required");
    const body = clean(text);
    if (!body) throw reminderError("a reminder needs some text — send { \"text\": \"…\" }", "reminder-text-required");
    if (body.length > MATRIX_REMINDER_TEXT_MAX) {
      throw reminderError(`the reminder is ${body.length} characters and the cap is ${MATRIX_REMINDER_TEXT_MAX} — shorten it`, "reminder-too-long");
    }
    const { reminders } = this.read();
    if (reminders.length >= MATRIX_REMINDERS_MAX) {
      throw reminderError(`the list is full (${MATRIX_REMINDERS_MAX} reminders) — remove one before adding another`, "reminders-full");
    }
    const row = normalizeReminder({ text: body, due });
    this.write([...reminders, row]);
    return row;
  }

  // Complete, reopen, re-word or re-date one reminder. Address by id; a body with no id is a create, and a body
  // whose id is not in the list is a 404 rather than a silent no-op — the page then knows its list was stale.
  update({ id, done, text, due } = {}) {
    const wanted = clean(id);
    if (!wanted) throw reminderError("a reminder update needs an `id`", "reminder-id-required");
    const { reminders } = this.read();
    const at = reminders.findIndex((r) => r.id === wanted);
    if (at < 0) throw reminderError(`no reminder with id ${wanted} — reload the list`, "reminder-not-found");
    const current = reminders[at];
    const next = { ...current };
    if (done === true && !current.doneAt) next.doneAt = new Date().toISOString();
    if (done === false) next.doneAt = null;
    if (text !== undefined) {
      if (typeof text !== "string") throw reminderError("a reminder needs some text", "reminder-text-required");
      const body = clean(text);
      if (!body) throw reminderError("a reminder needs some text", "reminder-text-required");
      if (body.length > MATRIX_REMINDER_TEXT_MAX) {
        throw reminderError(`the reminder is ${body.length} characters and the cap is ${MATRIX_REMINDER_TEXT_MAX}`, "reminder-too-long");
      }
      next.text = body;
    }
    if (due !== undefined) next.due = clean(due) || null;
    reminders[at] = next;
    this.write(reminders);
    return next;
  }

  remove({ id }) {
    const wanted = clean(id);
    if (!wanted) throw reminderError("a reminder removal needs an `id`", "reminder-id-required");
    const { reminders } = this.read();
    const left = reminders.filter((r) => r.id !== wanted);
    if (left.length === reminders.length) throw reminderError(`no reminder with id ${wanted} — reload the list`, "reminder-not-found");
    this.write(left);
    return { id: wanted, removed: true };
  }

  // THE POST ROUTE'S DISPATCHER. One body, one verb, one answer — the same shape the policy route uses, because
  // the page has one Save and the bridge has one list. A watch field is refused BEFORE anything is written: this
  // route must never become a second writer for lib/assistant.js's list.
  apply(body = {}) {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw reminderError("send a JSON object — { text } to add, { id, done } to complete, { id, remove: true } to delete", "reminder-body-invalid");
    }
    const watchKey = WATCH_WRITE_KEYS.find((k) => Object.prototype.hasOwnProperty.call(body, k));
    if (watchKey) {
      throw reminderError(`\`${watchKey}\` is not writable here — an assistant's watches are READ ONLY from the bridge`, "reminder-watch-readonly");
    }
    if (body.remove === true) {
      this.remove(body);
    } else if (Object.prototype.hasOwnProperty.call(body, "id")) {
      this.update(body);
    } else {
      this.add(body);
    }
    return this.payload();
  }
}
