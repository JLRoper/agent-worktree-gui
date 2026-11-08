// Deleting one assistant: the refusal, the archive, and the roster write.
//
// A delete is not a hard restart. A hard restart moves the assistant to a fresh thread and keeps every
// file; a delete takes the assistant out of the roster and off the float, and the panel must be able to
// say what happened to what it owned. Two rules make that safe to offer from the Settings pane:
//
//   1. It REFUSES while the assistant has live work - a run on its thread, or any row of its queue that
//      is not done. Deleting the record under a running turn orphans that run; deleting it beside a queued
//      row leaves the row pointing at a queue file nobody can read. The refusal NAMES the run and the
//      rows so the reader knows exactly what to stop or finish.
//   2. It ARCHIVES rather than erases. The record, the queue, the charter and the notes are copied into a
//      timestamped folder under the state directory BEFORE the assistant's own directory is removed, so
//      the reader can still read what that assistant was told and what it was carrying.
//
// The write order is the archive's safety. The copy lands first, the roster write second, and the
// assistant's directory is removed last: a failed roster write puts the record back in memory, so the
// only durable state is one the panel could still boot with. A directory removal that fails after the
// roster write is reported, not thrown - the assistant is already off the panel at that point.
//
// Nothing here touches lib/assistant/rules.js or lib/assistant/wakes.js. This module owns the refusals,
// the archive and the one write to assistants.json; routes/assistant-delete.js owns HTTP.
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PRIMARY_ASSISTANT, findAssistant, writeAssistantsFile } from "../assistants.js";
import { readQueueFile, TASK_OPEN } from "./queue.js";
import { clip, isLive, reasonOf } from "./read.js";

/** The folder under the state directory that holds every deleted assistant. */
export const ARCHIVE_DIR = "assistant-archive";
/** The record written into the archive: the roster entry exactly as it was, plus what else went with it. */
export const ARCHIVE_RECORD = "record.json";
/** The four things the second press names, in the order the confirmation says them. */
export const REMOVED_FILES = ["record.json", "queue.json", "charter.md", "notes.md"];
const COPY_NAMES = { charter: "charter.md", notes: "notes.md", queue: "queue.json", settings: "settings.json" };

/** `2026-11-07T23-59-00-000Z`: one folder per delete, readable and safe on Windows. */
export function archiveStamp(at = new Date()) {
  return new Date(at).toISOString().replace(/[:.]/g, "-");
}

/** The state directory every assistant file is resolved against. `assistant.file` is assistant.json. */
function stateDirOf(assistant) {
  return path.dirname(String(assistant?.file || assistant?.charterFile || ""));
}

/** Where one assistant's archive folder goes. Exported so the pane and the route can name it without guessing. */
export function archiveDirFor(assistant, rec, at = new Date()) {
  return path.join(stateDirOf(assistant), ARCHIVE_DIR, `${rec.id}-${archiveStamp(at)}`);
}

/** One line for one queue row, enough to tell two of them apart in a refusal. */
function rowLine(task) {
  return `#${task.id} "${clip(String(task.title || ""), 60)}" (${task.state})`;
}

/**
 * What stops this delete: the live run on the assistant's thread, and every open row of its queue.
 * A read only - `deleteAssistant` calls it for both the dry run and the real press, so the refusal a
 * reader sees on the first press is the one the second press would also get.
 */
export function deleteBlockers(assistant, rec) {
  const blockers = [];
  const thread = assistant.threadOf(rec.id);
  const jobs = typeof assistant.jobs?.list === "function" ? assistant.jobs.list() : [];
  const live = (Array.isArray(jobs) ? jobs : []).find((j) => String(j?.thread || "") === String(thread || "") && isLive(j));
  if (live) {
    blockers.push({
      kind: "run",
      id: String(live.id || live.runId || "?"),
      runId: live.runId ? String(live.runId) : "",
      status: String(live.status || "live"),
      thread: String(thread || ""),
    });
  }
  const queue = readQueueFile(assistant.queuePathOf(rec));
  const open = (queue.tasks || []).filter((t) => TASK_OPEN.includes(String(t.state || "")));
  if (open.length) {
    blockers.push({
      kind: "queue",
      count: open.length,
      // Capped for the sentence, not for the decision: every open row refuses, the first few are named.
      rows: open.slice(0, 4).map((t) => ({ id: t.id, title: String(t.title || ""), state: String(t.state || "") })),
      more: Math.max(0, open.length - 4),
    });
  }
  return blockers;
}

/** The refusal sentence. It names the blocking run or rows, because those are what the reader has to clear. */
export function blockerMessage(rec, blockers) {
  const run = blockers.find((b) => b.kind === "run");
  const queue = blockers.find((b) => b.kind === "queue");
  const said = [];
  const fix = [];
  if (run) {
    said.push(`${rec.name} has a live run — job ${run.id}${run.runId && run.runId !== run.id ? ` (run ${run.runId})` : ""} is ${run.status} on thread ${run.thread}`);
    fix.push("stop that run");
  }
  if (queue) {
    const rows = queue.rows.map(rowLine).join(", ");
    said.push(
      `${rec.name}'s queue has ${queue.count} open row${queue.count === 1 ? "" : "s"}: ${rows}${queue.more ? ` and ${queue.more} more` : ""}`,
    );
    fix.push(`finish or remove ${queue.count === 1 ? "that row" : "those rows"}`);
  }
  return `${said.join("; ")}. ${fix.join(" and ")} first — the delete refuses while that work is open.`;
}

/** Everything the two presses decide between: the four files, where they go, and what is left of the queue. */
export function deletePlan(assistant, rec, at = new Date()) {
  const archiveDir = archiveDirFor(assistant, rec, at);
  const sources = [
    { name: COPY_NAMES.charter, from: assistant.charterPathOf(rec) },
    { name: COPY_NAMES.notes, from: assistant.notesPathOf(rec) },
    { name: COPY_NAMES.queue, from: assistant.queuePathOf(rec) },
    { name: COPY_NAMES.settings, from: assistant.profilePathOf(rec) },
  ].filter((f) => f.from);
  const rows = readQueueFile(assistant.queuePathOf(rec)).tasks || [];
  return {
    id: rec.id,
    name: rec.name,
    threadId: rec.threadId,
    roleId: rec.roleId || "",
    // What the confirmation names: the record, its queue, its charter and its notes.
    removes: REMOVED_FILES.slice(),
    archive: { dir: archiveDir, files: sources.map((f) => f.name) },
    queue: { rows: rows.length, open: rows.filter((t) => TASK_OPEN.includes(String(t.state || ""))).length },
    sources,
  };
}

/**
 * Delete one assistant, or report what a delete would do.
 *
 * @param assistant - the live Assistant (it owns the roster, the paths and the journal).
 * @param id - the record to remove. Assistant #1 is refused by name: it is the panel's own session.
 * @param {object} options - `dryRun` returns the plan and the refusals without touching a file;
 *   `at` is the archive's clock (tests pin it); `by` names the caller in the journal.
 * @returns {{ok: true, dryRun?: boolean, plan?: object, removed?: object, archive?: object, roster?: string[]}}
 * @throws an Error with `code` `assistant-unknown`, `assistant-primary` or `assistant-busy`.
 */
export function deleteAssistant(assistant, id, { dryRun = false, at = new Date(), by = "reader" } = {}) {
  const wanted = String(id || "").trim();
  // An exact record, not `assistantRecord()`: that falls back to #1, so a typo in an id would delete the
  // assistant the reader did not name.
  const rec = findAssistant(assistant.assistants || [], wanted);
  if (!rec) throw Object.assign(new Error(`no such assistant: ${wanted || "(none)"}`), { code: "assistant-unknown" });
  if (rec.id === PRIMARY_ASSISTANT) {
    throw Object.assign(
      new Error("Assistant #1 is the panel's own assistant — it cannot be deleted; hard restart it instead if it needs a fresh thread"),
      { code: "assistant-primary" },
    );
  }
  const blockers = deleteBlockers(assistant, rec);
  if (blockers.length) throw Object.assign(new Error(blockerMessage(rec, blockers)), { code: "assistant-busy", blockers });
  const plan = deletePlan(assistant, rec, at);
  if (dryRun) return { ok: true, dryRun: true, plan };

  // 1. The archive. Every copy lands before the roster moves, so a half-written archive leaves the
  //    assistant in place rather than a record gone with no copy of what it owned.
  const archived = [];
  try {
    mkdirSync(plan.archive.dir, { recursive: true });
    writeFileSync(
      path.join(plan.archive.dir, ARCHIVE_RECORD),
      `${JSON.stringify(
        {
          version: 1,
          archivedAt: new Date(at).toISOString(),
          removed: REMOVED_FILES.slice(),
          record: rec,
        },
        null,
        1,
      )}\n`,
      "utf8",
    );
    archived.push(ARCHIVE_RECORD);
    for (const source of plan.sources) {
      if (!existsSync(source.from)) continue;
      copyFileSync(source.from, path.join(plan.archive.dir, source.name));
      archived.push(source.name);
    }
    writeFileSync(
      path.join(plan.archive.dir, "manifest.json"),
      `${JSON.stringify({ version: 1, archivedAt: new Date(at).toISOString(), assistant: { id: rec.id, name: rec.name, threadId: rec.threadId }, files: archived }, null, 1)}\n`,
      "utf8",
    );
  } catch (err) {
    throw Object.assign(new Error(`could not archive ${rec.name} to ${plan.archive.dir}: ${reasonOf(err)} — nothing was deleted`), {
      code: "archive-failed",
    });
  }

  // 2. The roster. `assistants` is the live array every read walks, so the record is spliced in place
  //    rather than replaced; a failed write puts it back at the index it held.
  const at2 = assistant.assistants.indexOf(rec);
  assistant.assistants.splice(at2, 1);
  try {
    writeAssistantsFile(assistant.assistantsFile, assistant.assistants);
  } catch (err) {
    assistant.assistants.splice(at2, 0, rec);
    throw Object.assign(new Error(`could not write ${assistant.assistantsFile}: ${reasonOf(err)} — ${rec.name} was not deleted`), {
      code: "assistants-write-failed",
    });
  }

  // 3. The assistant's own directory, now that the roster and the archive both stand. The archive is a
  //    SIBLING of `assistants/<id>`, so this removal cannot take it with them.
  const ownDir = path.join(stateDirOf(assistant), "assistants", rec.id);
  let filesRemoved = true;
  try {
    rmSync(ownDir, { recursive: true, force: true });
  } catch (err) {
    filesRemoved = false;
    assistant.onLog?.(`assistant: deleted ${rec.name} but could not remove ${ownDir} (${reasonOf(err)})`);
  }

  // 4. The per-id recall records, so a re-created assistant-2 cannot inherit the deleted one's sends.
  for (const key of ["profiles", "charterSends", "boardSigs", "queueWakeTicks"]) {
    const store = assistant[key];
    if (store && typeof store.delete === "function") store.delete(rec.id);
  }

  assistant.journalAdd(
    "assistant",
    null,
    `${rec.name} (${rec.id}) deleted by ${by} — its record, queue, charter and notes were archived to ${plan.archive.dir}${filesRemoved ? "" : `; its directory could not be removed`}`,
  );
  assistant.emit();
  return {
    ok: true,
    removed: { id: rec.id, name: rec.name, threadId: rec.threadId },
    archive: { dir: plan.archive.dir, files: archived },
    filesRemoved,
    roster: assistant.assistants.map((a) => a.id),
  };
}
