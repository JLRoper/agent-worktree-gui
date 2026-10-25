// What each branch was STARTED to do — in the words of the run that started it.
//
// The board's MERGE STATE answers "where did this branch get to". Nothing answered "what was it for", which is the
// question an old row — a tree whose run ended three days ago — actually raises. The panel already holds that
// answer: every run's brief sits in the job store next to its cwd, so the EARLIEST run in a tree is the branch's
// stated goal, and saying so needs no summarising. This module extracts it — the opening sentences of that brief,
// verbatim — and writes it down once, keyed on the six-hex tag a rename keeps (treeKey, shared with
// lib/tree-names.js, so a renamed directory or branch keeps its description).
//
// Written down, not re-derived. Two reasons, and the first is the one that bites: the job store keeps only the most
// recent ~80 runs, so the earliest brief in an old tree ages out of it, and a description computed at render time
// would empty itself the moment that happened. The second is cost: this is one extraction per tree for the whole
// life of the panel, instead of one per render of one row.
//
// Nothing here invents text. Every character of a description comes out of a prompt the reader (or the board
// assistant) actually wrote; the only edits are removing the panel's own "Work in …" wrapper and stopping after a
// couple of sentences.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { treeKey } from "./tree-names.js";

export const DESCRIPTIONS_VERSION = 1;
export const DESC_MAX_SENTENCES = 2;
export const DESC_MAX_CHARS = 400;

// The line the panel appends to a turn aimed at a directory (`lib/jobs.js`, into the request body — not into the
// stored prompt, but a record written by an older build could carry it). "the agent host may have started you in a
// different directory" is not the branch's goal, so it never reaches the description.
const WORK_WRAPPER = /\s*Work in .{1,400}? — run `cd "[^"]*"` before your first terminal command[^]*$/;

// One brief, as flat text: line breaks and indentation out, the panel's directory wrapper out.
export function stripWorkWrapper(prompt) {
  return String(prompt ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(WORK_WRAPPER, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Sentence boundaries, conservatively: a full stop, question or bang mark followed by whitespace AND something that
// can start a sentence. A version number, a path or an abbreviation keeps its tail attached, because the character
// after it is not a space (or the next word starts lowercase), which is what stops "e.g. the resolver" being cut in
// half.
const SENTENCE_BREAK = /(?<=[.!?])\s+(?=[A-Z0-9"'(\[])/;

// The opening of a brief, verbatim: at most `maxSentences` sentences and at most `maxChars` characters. A single
// opening sentence longer than the whole budget — or a brief with no sentence punctuation at all — is cut at a
// word boundary instead of coming back empty: a section that says the first clause of the goal beats one that says
// nothing.
export function describeFromPrompt(prompt, { maxSentences = DESC_MAX_SENTENCES, maxChars = DESC_MAX_CHARS } = {}) {
  const text = stripWorkWrapper(prompt);
  if (!text) return null;
  const sentences = text.split(SENTENCE_BREAK).filter((s) => s.trim());
  let out = "";
  for (const sentence of sentences.slice(0, maxSentences)) {
    const next = out ? `${out} ${sentence.trim()}` : sentence.trim();
    if (next.length > maxChars) break;
    out = next;
  }
  if (out) return out;
  const cut = text.slice(0, maxChars);
  const at = cut.lastIndexOf(" ");
  const head = (at > maxChars / 2 ? cut.slice(0, at) : cut).replace(/[\s,;:.]+$/, "");
  return head ? `${head}\u2026` : null;
}

export class Descriptions {
  constructor({ file, log = () => {} } = {}) {
    this.file = file || null;
    this.log = log;
    this.trees = new Map();
    this.loaded = false;
  }

  // A missing file is the ordinary first-run answer, and a file that does not parse is not worth failing a scan
  // over: it is read once, and rewritten on the next record.
  load() {
    if (this.loaded) return this;
    this.loaded = true;
    if (!this.file) return this;
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8"));
      const trees = raw && typeof raw === "object" && raw.trees && typeof raw.trees === "object" ? raw.trees : {};
      for (const [key, rec] of Object.entries(trees)) {
        if (rec && typeof rec === "object" && String(rec.text || "").trim()) this.trees.set(key, rec);
      }
    } catch (err) {
      if (existsSync(this.file)) {
        this.log(`descriptions: could not read ${this.file} (${String((err && err.message) || err)}) — starting empty`);
      }
    }
    return this;
  }

  get size() {
    this.load();
    return this.trees.size;
  }

  get(key) {
    this.load();
    return (key && this.trees.get(key)) || null;
  }

  // The record for a tree reached by path or branch rather than by key — what the board's rows are.
  forTree(where) {
    return this.get(treeKey(where));
  }

  isDescribed(where) {
    return Boolean(this.forTree(where));
  }

  // Record what a tree was started to do. The FIRST record wins: it comes from the earliest run, which is the only
  // run that can say what the branch was FOR — a later run in the same tree ("land it and write the report") is not
  // that, and a re-derivation per run would rewrite the goal into whatever the branch looks like now. Returns the
  // record when this call wrote one, and null when the tree already had one.
  remember(where, entry) {
    this.load();
    const key = treeKey(where);
    if (!key || this.trees.has(key)) return null;
    return this.record(key, entry);
  }

  record(key, entry) {
    this.load();
    if (!key) return null;
    const prev = this.trees.get(key) || {};
    const rec = { ...prev, ...entry, key, at: entry?.at || prev.at || new Date().toISOString() };
    this.trees.set(key, rec);
    this.save();
    return rec;
  }

  forget(key) {
    this.load();
    if (!key || !this.trees.delete(key)) return false;
    this.save();
    return true;
  }

  save() {
    if (!this.file) return false;
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      const body = { version: DESCRIPTIONS_VERSION, savedAt: new Date().toISOString(), trees: Object.fromEntries(this.trees) };
      // Written beside the target and renamed over it, so a reader (or a crash) never sees half a file.
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, "utf8");
      renameSync(tmp, this.file);
      return true;
    } catch (err) {
      // A description is a note, not a source of truth for anything else: losing a write costs one re-read of the
      // job store, and the in-memory map still holds the text for this process.
      this.log(`descriptions: could not write ${this.file} (${String((err && err.message) || err)})`);
      return false;
    }
  }
}
