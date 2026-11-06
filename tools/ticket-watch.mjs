#!/usr/bin/env node
// tools/ticket-watch.mjs — watch SR/DMR tickets, wake the assistant that owns the list, and leave the judgement to it.
//
//   node tools/ticket-watch.mjs add SR-242996 --note "DEV firewall rule, waiting on Greene"
//   node tools/ticket-watch.mjs add SR-242997 --assistant assistant-3
//   node tools/ticket-watch.mjs list
//   node tools/ticket-watch.mjs remove SR-242996 --assistant assistant-3
//   node tools/ticket-watch.mjs seed                  # the four Optym SRs, from ticket-watch.seed.json
//   node tools/ticket-watch.mjs show SR-242996       # the ticket, for the agent's judgement
//   node tools/ticket-watch.mjs check                 # one poll, every assistant's list
//   node tools/ticket-watch.mjs check --dry-run       # say what moved, write nothing, wake nobody
//   node tools/ticket-watch.mjs check --fixture f.json --assistant assistant-3
//
// WHAT ONE POLL DOES, per watched key:
//
//   1. GET https://jira.sefl.com/rest/api/2/issue/<KEY>?fields=summary,status,assignee,updated,comment with
//      `Authorization: Bearer $JIRA_API_TOKEN` (an exported shell variable — never a file, never a flag: a token
//      in argv is a token in the process list);
//   2. diff it against the entry's `lastSeen` and classify the three movements (a new comment, a status change, an
//      assignee change). lib/ticket-watch.js owns the diff; it decides NOTHING about whether a movement matters —
//      there is no "addressed to the reader" test, no severity and no option list anywhere in this path;
//   3. POST /api/ticket-watch/wake with the ticket key and every movement in neutral words. That route is the
//      panel's OWN `assistant.wake` behind a door (the ladder tools/verify-wake-ladder.mjs drives; there is no
//      second wake path here and this script starts no turn itself). The assistant reads the ticket, judges it,
//      and raises a clarify card only when the reader has a decision to make — see docs/ticket-watch.md;
//   4. write `lastSeen` ONLY after the wake landed, so a failure retries the report instead of forgetting it.
//
// NOTHING IS PUT IN FRONT OF THE READER BY THIS POLLER. It writes no queue row and no card: a movement is news for
// the assistant, and the assistant decides whether the reader should see anything at all.
//
// IDEMPOTENCE is the acceptance bar: a second `check` with nothing moved on Jira classifies zero movements, makes
// no HTTP call to the panel at all, and writes no file (the `lastSeen` snapshot is identical, so the file is left
// byte for byte as it was). `--json` prints the per-ticket verdicts for a cron log.
//
// NOTHING IS EVER WRITTEN TO JIRA. There is no POST, PUT or DELETE to jira.sefl.com in this file: the only Jira
// requests are GETs of the issue and, for a ticket with more comments than one page returns, its comment list.
//
// State: state/assistants/<assistantId>/tickets.json beside that assistant's queue. The state directory resolves
// through lib/paths.js — the same function the panel boots with — so `WAG_HOME`, `--state-dir` and the default
// `~/.wag` mean here exactly what they mean there. `seed` reads the four Optym SRs out of `ticket-watch.seed.json`
// at the repo root, so a fresh machine can reproduce the list without typing four keys and four notes.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  WATCH_VERSION,
  addTicket,
  classifyTicket,
  movementLine,
  readTicketFile,
  removeTicket,
  ticketsPathFor,
  wakeTextFor,
  writeTicketFile,
} from "../lib/ticket-watch.js";
import { resolveDirs, statePaths } from "../lib/paths.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const JIRA_BASE_DEFAULT = "https://jira.sefl.com";
const PANEL_PORT_DEFAULT = 7331;
const FETCH_TIMEOUT_MS = 20_000;

const USAGE = `ticket-watch — watch Jira SR/DMR tickets, wake the assistant, leave the judgement to it

  node tools/ticket-watch.mjs add <KEY> [--note "why"] [--assistant <id>]
  node tools/ticket-watch.mjs list [--assistant <id>] [--json]
  node tools/ticket-watch.mjs remove <KEY> [--assistant <id>]
  node tools/ticket-watch.mjs seed [--assistant <id>] [--file <seed.json>]
  node tools/ticket-watch.mjs show <KEY> [--comments <n>] [--json]
  node tools/ticket-watch.mjs check [--assistant <id>] [--dry-run] [--fixture <file>] [--json]

Options
  --assistant <id>   which assistant's list (default: assistant-1 for add/remove/list/seed, EVERY list for check)
  --state-dir <dir>  the panel's state directory (default: lib/paths.js — WAG_HOME, else ~/.wag, /state)
  --panel <url>      the panel base URL (default: PANEL_URL, else http://127.0.0.1:<config.json port>)
  --jira <url>       Jira base URL (default: JIRA_BASE_URL, else ${JIRA_BASE_DEFAULT})
  --file <seed.json> the seed to load (default: ticket-watch.seed.json at the repo root)
  --comments <n>     how many comments \`show\` prints, newest last (default: 6)
  --fixture <file>   read issue payloads from a JSON file instead of Jira (a test seam; never used by cron)
  --dry-run          say what moved and write nothing, wake nobody
  --json             print a machine-readable summary

Environment: JIRA_API_TOKEN (required for a live check or show), PANEL_TOKEN (only for a non-loopback panel),
             JIRA_BASE_URL, PANEL_URL, WAG_HOME.
Exit: 0 ok · 1 a ticket or a wake failed · 2 a usage error.`;

// ---- arguments ------------------------------------------------------------------------------------------------
function parseArgs(argv) {
  const out = { _: [], flags: {} };
  const takesValue = new Set(["--note", "--assistant", "--state-dir", "--panel", "--jira", "--fixture", "--file", "--comments", "--now"]);
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      out.flags.help = true;
      continue;
    }
    if (a === "--dry-run") {
      out.flags.dryRun = true;
      continue;
    }
    if (a === "--json") {
      out.flags.json = true;
      continue;
    }
    if (takesValue.has(a)) {
      const v = argv[i + 1];
      if (v === undefined || String(v).startsWith("--")) fail(`usage: ${a} needs a value`, 2);
      out.flags[a.replace(/^--/, "")] = v;
      i += 1;
      continue;
    }
    if (String(a).startsWith("--")) fail(`usage: unknown option ${a}`, 2);
    out._.push(a);
  }
  return out;
}

function fail(message, code = 1) {
  process.stderr.write(`ticket-watch: ${message}\n`);
  process.exit(code);
}

const args = parseArgs(process.argv.slice(2));
const flag = (name) => args.flags[name];
if (flag("help")) {
  process.stdout.write(`${USAGE}\n`);
  process.exit(0);
}
const command = String(args._[0] || "").trim();
if (!["add", "list", "remove", "seed", "show", "check"].includes(command)) {
  process.stderr.write(`${USAGE}\n`);
  process.exit(command ? 2 : 0);
}

// ---- where things are -----------------------------------------------------------------------------------------
function stateDirOf() {
  const explicit = flag("state-dir") || process.env.TICKET_WATCH_STATE_DIR;
  if (explicit) return path.resolve(explicit);
  const dirs = resolveDirs({ config: {}, env: process.env, home: os.homedir(), tmpdir: os.tmpdir() });
  return statePaths({ dataDir: dirs.dataDir }).stateDir;
}

const STATE_DIR = stateDirOf();
const ASSISTANT_DIR = path.join(STATE_DIR, "assistants");
const listOf = (id) => ticketsPathFor(STATE_DIR, id);

/** Every assistant directory this panel has (a list can exist before its file does). */
function assistantIds() {
  if (!existsSync(ASSISTANT_DIR)) return [];
  try {
    return readdirSync(ASSISTANT_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^assistant-\d+$/.test(d.name))
      .map((d) => d.name)
      .sort((a, b) => Number(a.split("-")[1]) - Number(b.split("-")[1]));
  } catch {
    return [];
  }
}

function requireAssistant(id) {
  const known = assistantIds();
  if (known.includes(id)) return id;
  fail(`no such assistant: ${id} — this panel has ${known.join(", ") || "none"} (looked in ${ASSISTANT_DIR})`, 2);
}

function panelBase() {
  const explicit = flag("panel") || process.env.PANEL_URL;
  if (explicit) return String(explicit).replace(/\/+$/, "");
  let port = PANEL_PORT_DEFAULT;
  try {
    const cfg = JSON.parse(readFileSync(path.join(ROOT, "config.json"), "utf8"));
    if (Number(cfg.port) > 0) port = Number(cfg.port);
  } catch {
    /* no config beside the tool: the default port is the panel's own */
  }
  return `http://127.0.0.1:${port}`;
}

function jiraBase() {
  return String(flag("jira") || process.env.JIRA_BASE_URL || JIRA_BASE_DEFAULT).replace(/\/+$/, "");
}

// ---- HTTP -----------------------------------------------------------------------------------------------------
async function panel(pathname, { method = "GET", body = null } = {}) {
  const headers = { Accept: "application/json" };
  if (body) headers["Content-Type"] = "application/json";
  const token = process.env.PANEL_TOKEN;
  if (token) headers["x-panel-token"] = token;
  let res;
  try {
    res = await fetch(`${panelBase()}${pathname}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`the panel at ${panelBase()} did not answer: ${String((err && err.message) || err)}`);
  }
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const err = new Error(`the panel refused ${method} ${pathname}: ${(json && json.error) || text.slice(0, 200) || res.status}`);
    err.status = res.status;
    err.pathname = pathname;
    throw err;
  }
  return json;
}

/** One issue, exactly the fields the diff reads. Comments are paged if the field hands back only a prefix. */
async function fetchIssue(key) {
  const token = process.env.JIRA_API_TOKEN;
  if (!token) fail("JIRA_API_TOKEN is not exported in this shell — the watch cannot read Jira without it");
  const base = jiraBase();
  const url = `${base}/rest/api/2/issue/${encodeURIComponent(key)}?fields=summary,description,status,assignee,updated,comment`;
  let res;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`could not reach ${base}: ${String((err && err.message) || err)}`);
  }
  if (!res.ok) throw new Error(`Jira answered ${res.status} for ${key}${res.status === 404 ? " (no such issue, or this token cannot see it)" : ""}`);
  const issue = await res.json();
  const field = issue?.fields?.comment;
  const total = Number(field?.total) || 0;
  const got = Array.isArray(field?.comments) ? field.comments.length : 0;
  if (total > got) {
    const more = await fetch(`${base}/rest/api/2/issue/${encodeURIComponent(key)}/comment?startAt=${got}&maxResults=${Math.min(500, total - got)}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!more.ok) throw new Error(`Jira answered ${more.status} for ${key}'s comment page`);
    const page = await more.json();
    issue.fields.comment.comments = [...(field.comments || []), ...(Array.isArray(page?.comments) ? page.comments : [])];
  }
  return issue;
}

// ---- the fixture seam -----------------------------------------------------------------------------------------
function loadFixture(file) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    fail(`could not read the fixture ${file}: ${String((err && err.message) || err)}`, 2);
  }
  const map = new Map();
  const add = (issue) => {
    if (!issue || !issue.key) return;
    map.set(String(issue.key).toUpperCase(), issue);
  };
  if (Array.isArray(parsed)) parsed.forEach(add);
  else if (Array.isArray(parsed?.issues)) parsed.issues.forEach(add);
  else if (parsed && typeof parsed === "object") {
    for (const [key, issue] of Object.entries(parsed)) add({ key, ...(issue || {}) });
  }
  return map;
}

// ---- the commands ---------------------------------------------------------------------------------------------
function loadList(id) {
  const file = listOf(id);
  const out = readTicketFile(file);
  if (out.error) fail(out.error);
  // The document names the assistant it belongs to, and a file that does not (hand-written, or written before the
  // key existed) is stamped on the next write rather than left ambiguous beside five other assistants' files.
  const doc = out.doc.assistantId === id ? out.doc : { ...out.doc, assistantId: id };
  return { file, doc, exists: out.exists };
}

function cmdAdd() {
  const key = args._[1];
  if (!key) fail("usage: add <KEY> [--note \"...\"]", 2);
  const id = requireAssistant(flag("assistant") || "assistant-1");
  const { file, doc } = loadList(id);
  let out;
  try {
    out = addTicket(doc, { key, note: flag("note") || "" });
  } catch (err) {
    fail(String((err && err.message) || err), 2);
  }
  writeTicketFile(file, out.doc);
  const total = out.doc.tickets.length;
  process.stdout.write(`${out.entry.key} ${out.added ? "added to" : "already on"} ${id}'s watch list${out.entry.note ? ` — note: ${out.entry.note}` : ""} (${total} watched · ${file})\n`);
}

function cmdList() {
  const wanted = flag("assistant") ? requireAssistant(flag("assistant")) : null;
  const ids = wanted ? [wanted] : assistantIds();
  const rows = [];
  for (const id of ids) {
    const { file, doc, exists } = loadList(id);
    for (const t of doc.tickets) rows.push({ assistantId: id, file, ...t });
    if (!wanted && !exists) continue;
  }
  if (flag("json")) {
    process.stdout.write(`${JSON.stringify({ stateDir: STATE_DIR, tickets: rows }, null, 1)}\n`);
    return;
  }
  if (!rows.length) {
    process.stdout.write(`no tickets watched${wanted ? ` by ${wanted}` : ""} — add one with: node tools/ticket-watch.mjs add <KEY> --assistant <id>\n`);
    return;
  }
  let current = null;
  for (const r of rows) {
    if (r.assistantId !== current) {
      current = r.assistantId;
      process.stdout.write(`\n${current}\n`);
    }
    const seen = r.lastSeen || {};
    const last = seen.commentId ? `last comment #${seen.commentId} ${seen.updated || ""}`.trim() : "baseline not taken yet";
    process.stdout.write(`  ${r.key}  ${seen.status || "(no status yet)"} · ${seen.assignee || "unassigned"} · ${last}${r.note ? `  — ${r.note}` : ""}\n`);
  }
  process.stdout.write(`\n${rows.length} watched\n`);
}

function cmdRemove() {
  const key = args._[1];
  if (!key) fail("usage: remove <KEY> [--assistant <id>]", 2);
  const id = requireAssistant(flag("assistant") || "assistant-1");
  const { file, doc } = loadList(id);
  const out = removeTicket(doc, key);
  if (!out.removed) fail(`${String(key).toUpperCase()} is not on ${id}'s watch list (${file})`, 1);
  writeTicketFile(file, out.doc);
  process.stdout.write(`${String(key).toUpperCase()} removed from ${id}'s watch list (${out.doc.tickets.length} left · ${file})\n`);
}

function cmdSeed() {
  const id = requireAssistant(flag("assistant") || "assistant-1");
  const file = flag("file") ? path.resolve(flag("file")) : path.join(ROOT, "ticket-watch.seed.json");
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    fail(`could not read the seed ${file}: ${String((err && err.message) || err)}`, 2);
  }
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.tickets) ? parsed.tickets : null;
  if (!list) fail(`${file} has no tickets list`, 2);
  const target = loadList(id);
  let doc = target.doc;
  let added = 0;
  let noted = 0;
  for (const t of list) {
    let out;
    try {
      out = addTicket(doc, { key: t?.key, note: t?.note || "" });
    } catch (err) {
      fail(`${file}: ${String((err && err.message) || err)}`, 2);
    }
    doc = out.doc;
    if (out.added) added += 1;
    else if (out.changed) noted += 1;
  }
  const wrote = added + noted > 0;
  if (wrote) writeTicketFile(target.file, doc);
  process.stdout.write(
    `seeded ${id}'s watch list from ${file}: ${added} added, ${noted} note${noted === 1 ? "" : "s"} updated, ${doc.tickets.length} watched${wrote ? "" : " (nothing to write)"}\n`,
  );
  for (const t of doc.tickets) process.stdout.write(`  ${t.key}${t.note ? `  ${t.note}` : ""}\n`);
}

/** The ticket, for the assistant's judgement: fields, description and the last few comments, with their ids. */
async function cmdShow() {
  const key = args._[1];
  if (!key) fail("usage: show <KEY> [--comments <n>]", 2);
  const wanted = String(key).toUpperCase();
  let issue;
  try {
    issue = await fetchIssue(wanted);
  } catch (err) {
    fail(String((err && err.message) || err), 1);
  }
  const f = issue.fields || {};
  const comments = Array.isArray(f.comment?.comments) ? f.comment.comments.slice().sort((a, b) => (Number(a?.id) || 0) - (Number(b?.id) || 0)) : [];
  const n = Math.max(1, Number(flag("comments")) || 6);
  const shown = comments.slice(-n);
  if (flag("json")) {
    process.stdout.write(
      `${JSON.stringify({ key: issue.key || wanted, summary: f.summary || "", status: f.status?.name || null, assignee: f.assignee?.displayName || null, updated: f.updated || null, description: f.description || "", comments: shown }, null, 1)}\n`,
    );
    return 0;
  }
  const lines = [`${issue.key || wanted} - ${f.summary || "(no summary)"}`];
  lines.push(
    `status: ${f.status?.name || "none"} · assignee: ${f.assignee?.displayName || "unassigned"} · updated: ${f.updated || "(not given)"} · ${comments.length} comment${comments.length === 1 ? "" : "s"}`,
  );
  if (String(f.description || "").trim()) {
    lines.push("");
    lines.push(String(f.description).trim());
  }
  if (shown.length) {
    lines.push("");
    lines.push(`Last ${shown.length} comment${shown.length === 1 ? "" : "s"} (oldest first):`);
    for (const c of shown) {
      lines.push("");
      lines.push(`#${c.id} ${c.author?.displayName || "someone"} ${String(c.created || "").replace("T", " ").slice(0, 19)}`);
      lines.push(String(c.body || "").trim());
    }
  }
  process.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}

/**
 * Report one ticket's movements: ONE wake naming the key and every movement, and nothing else. No queue row, no
 * card, no options - the assistant that receives this reads the ticket and decides whether the reader sees
 * anything. The text is built by the module so the CLI and the test cannot drift apart on its words.
 */
async function wake(id, entry, events) {
  const text = wakeTextFor({
    key: entry.key,
    summary: events[0]?.summary || "",
    events,
    browse: `${jiraBase()}/browse/${entry.key}`,
  });
  const answer = await panel("/api/ticket-watch/wake", { method: "POST", body: { assistantId: id, text } });
  return { text, wake: answer };
}

async function cmdCheck() {
  const wanted = flag("assistant") ? requireAssistant(flag("assistant")) : null;
  const ids = wanted ? [wanted] : assistantIds();
  const fixture = flag("fixture") ? loadFixture(flag("fixture")) : null;
  const dryRun = Boolean(flag("dryRun"));
  const report = { stateDir: STATE_DIR, panel: panelBase(), dryRun, fixture: flag("fixture") || null, tickets: [], movements: 0, wakes: 0, writes: 0, errors: [] };

  if (!ids.length) {
    process.stdout.write(`no assistant directories under ${ASSISTANT_DIR} - nothing to check\n`);
    return 0;
  }

  for (const id of ids) {
    const file = listOf(id);
    const out = readTicketFile(file);
    if (out.error) {
      report.errors.push({ assistantId: id, error: out.error });
      process.stderr.write(`ticket-watch: ${out.error}\n`);
      continue;
    }
    if (!out.doc.tickets.length) continue;
    let dirty = false;
    for (const entry of out.doc.tickets) {
      const line = { assistantId: id, key: entry.key, baseline: false, events: [], wake: null, error: null };
      let issue;
      try {
        issue = fixture ? fixture.get(entry.key) : await fetchIssue(entry.key);
        if (!issue) throw new Error(`${entry.key} is not in the fixture`);
      } catch (err) {
        line.error = String((err && err.message) || err);
        report.errors.push({ assistantId: id, key: entry.key, error: line.error });
        report.tickets.push(line);
        process.stderr.write(`ticket-watch: ${entry.key} (${id}): ${line.error}\n`);
        continue;
      }
      // A fixture entry may carry only `fields`; the issue's own key is the entry's.
      const classified = classifyTicket(entry, { ...issue, key: issue.key || entry.key });
      line.baseline = classified.baseline;
      // Where the snapshot lands when this ticket has nothing to report (or reported successfully): the LAST write
      // of the loop below stores it. A wake that fails leaves it out, so the next check reports the same movement
      // again rather than forgetting it.
      const at = out.doc.tickets.findIndex((t) => t.key === entry.key);
      const adopt = () => {
        if (at >= 0 && classified.changed) {
          out.doc.tickets[at] = classified.entry;
          dirty = true;
        }
      };
      if (classified.baseline) {
        adopt();
        line.note = `${classified.entry.lastSeen.status || "no status"} · ${classified.entry.lastSeen.assignee || "unassigned"} · comment #${classified.entry.lastSeen.commentId || "none"}`;
        report.tickets.push(line);
        continue;
      }
      if (!classified.events.length) {
        adopt();
        line.note = "nothing moved";
        report.tickets.push(line);
        continue;
      }
      line.events = classified.events.map((e) => ({ kind: e.kind, what: movementLine(e), id: e.id, from: e.from ?? null, to: e.to ?? null }));
      report.movements += line.events.length;
      if (dryRun) {
        report.tickets.push(line);
        continue;
      }
      try {
        const reported = await wake(id, entry, classified.events);
        line.wakeText = reported.text;
        line.wake = reported.wake?.queued === false ? { refused: reported.wake.refused } : { queued: true, pending: reported.wake?.pending ?? null };
        report.wakes += reported.wake?.queued === false ? 0 : 1;
        // lastSeen moves ONLY once the wake landed: a failure below reports the same movement on the next check
        // instead of swallowing it.
        adopt();
      } catch (err) {
        line.error = String((err && err.message) || err);
        report.errors.push({ assistantId: id, key: entry.key, error: line.error });
        process.stderr.write(`ticket-watch: ${entry.key} (${id}): ${line.error}\n`);
      }
      report.tickets.push(line);
    }
    // Written once per assistant, and only when a tracked fact moved. A second check with nothing changed leaves
    // the file's bytes (and its mtime) exactly as they were.
    if (dirty && !dryRun) {
      writeTicketFile(file, out.doc);
      report.writes += 1;
    }
  }

  if (flag("json")) {
    process.stdout.write(`${JSON.stringify({ ...report, version: WATCH_VERSION }, null, 1)}\n`);
  } else {
    printReport(report, dryRun);
  }
  return report.errors.length ? 1 : 0;
}

function printReport(report, dryRun) {
  const rows = [];
  for (const t of report.tickets) {
    if (t.error) rows.push(`${t.key.padEnd(12)} ERROR ${t.error}`);
    else if (t.baseline) rows.push(`${t.key.padEnd(12)} baseline - ${t.note}`);
    else if (!t.events.length) rows.push(`${t.key.padEnd(12)} nothing moved`);
    else {
      const what = t.events.map((e) => e.what).join("; ");
      const did = dryRun
        ? "would wake the assistant"
        : t.wake
          ? t.wake.queued
            ? "assistant woken"
            : `wake refused (${t.wake.refused})`
          : "woke nobody";
      rows.push(`${t.key.padEnd(12)} ${what} - ${did}`);
    }
  }
  if (!rows.length) process.stdout.write(`nothing watched yet - add a key with: node tools/ticket-watch.mjs add <KEY> --assistant <id>\n`);
  else process.stdout.write(`${rows.join("\n")}\n`);
  if (dryRun) {
    process.stdout.write(`\nDRY RUN - nothing was written, nobody was woken.\n`);
    return;
  }
  if (!report.movements && !report.writes && !report.errors.length) {
    process.stdout.write(`\nnothing moved: no movement, no wake, no write.\n`);
    return;
  }
  const bits = [`${report.movements} movement${report.movements === 1 ? "" : "s"}`, `${report.wakes} wake${report.wakes === 1 ? "" : "s"}`];
  if (report.writes) bits.push(`${report.writes} list write${report.writes === 1 ? "" : "s"}`);
  if (report.errors.length) bits.push(`${report.errors.length} error${report.errors.length === 1 ? "" : "s"}`);
  process.stdout.write(`\n${bits.join(", ")}.\n`);
}

async function main() {
  if (command === "add") return cmdAdd(), 0;
  if (command === "list") return cmdList(), 0;
  if (command === "remove") return cmdRemove(), 0;
  if (command === "seed") return cmdSeed(), 0;
  if (command === "show") return cmdShow();
  return cmdCheck();
}

main()
  .then((code) => process.exit(code || 0))
  .catch((err) => {
    process.stderr.write(`ticket-watch: ${String((err && err.message) || err)}\n`);
    process.exit(1);
  });
