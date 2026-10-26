// Turning prose into an alert: is this a question, does it look like work that produced nothing, and does
// one of the reader's standing rules answer it.
//
// All three are pure string work over a turn's answer, and all three are deliberately conservative. The
// comments that say why travel with the code: a question mark mid-paragraph is usually rhetoric, and waking
// the reader for rhetoric is worse than missing a real question; `matchRule` needs two shared content words
// before a rule counts as an answer, so "yes, do that" cannot be answered by a rule about something else.
//
// The first three take prose and the last two take the reader's rule table. It reads two of ./read.js's
// primitives and nothing else: `clip`, the one-line shortening every message uses, and `toolSigs`, the call
// list a bare-work check is built on.

import { clip, toolSigs } from "./read.js";

// A turn that ended on a question: the last prose paragraph asks something, or the whole answer is
// short and ends with a question mark. Deliberately conservative - a question mark mid-paragraph is
// usually rhetoric, and waking the reader for that is worse than missing one.
const ASK_RE = /\b(should i|shall i|do you want|would you like|which (?:one|option|approach|way)|can you (?:confirm|clarify|tell me)|let me know (?:if|whether|which)|your call|confirm (?:whether|which)|go ahead\?)/i;
export function looksLikeQuestion(answer) {
  const text = String(answer || "").trim();
  if (!text) return null;
  const paras = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const tail = paras.slice(-2).join(" ").trim();
  const last = clip(tail, 400);
  const endsAsk = /[?]\s*["')\]]*\s*$/.test(tail);
  const saysAsk = ASK_RE.test(tail);
  if (!endsAsk && !saysAsk) return null;
  return { text: last, endsAsk, saysAsk };
}

// A turn that sounds like work but left no trace of work. "Evidence" here is a tool that can change
// something plus any file deliverable; a pure answer to a question is not supposed to have any.
const WORK_WORDS = /\b(implement|add|build|create|fix|refactor|change|update|migrate|write|remove|rename|wire|port|patch|test|debug)\b/i;
const WRITE_TOOLS = new Set(["write_file", "patch", "terminal", "execute_code", "skill_manage", "cronjob_manage", "browser_exec", "delegate_task"]);
export function looksLikeBareWork(prompt, lines, artifacts) {
  if (!WORK_WORDS.test(String(prompt || ""))) return null;
  if (Array.isArray(artifacts) && artifacts.length) return null;
  const called = new Set(toolSigs(lines).map((s) => s.tool));
  for (const t of called) if (WRITE_TOOLS.has(t)) return null;
  return { tools: [...called] };
}

// Standing rules are the assistant's only source of confidence that is not a guess: a rule the reader
// wrote down that shares real words with the question. Two shared content words is the bar.
const STOP = new Set("the a an and or of to in on for with from by is are was were be been do does did i you we they it this that my your our their if then than as at not no yes can could should would will shall please let me know what which who when where why how about into over under".split(" "));
// Two-letter words count: "QA", "CI", "DB", "UI" are exactly the words a rule about a choice turns on, and a
// tokenizer that drops them silently loses the match. The stopword list above is what keeps prose out.
export const words = (s) => new Set(String(s || "").toLowerCase().match(/[a-z][a-z0-9_.-]+/g)?.filter((w) => !STOP.has(w)) || []);
export function matchRule(question, rules) {
  const q = words(question);
  let best = null;
  for (const r of rules || []) {
    const rw = words(r.text);
    let shared = 0;
    for (const w of rw) if (q.has(w)) shared += 1;
    if (shared >= 2 && (!best || shared > best.shared)) best = { rule: r, shared };
  }
  return best;
}

// A standing rule that names one of the offered choices is a confident answer: the rule says "deploy to QA" and the
// tool offers "QA" as a choice, so sending that choice is exactly what the reader would have clicked. Anything less
// — a rule about the topic, or a choice that appears alongside a second one in the same rule — stays a draft.
export function pickChoice(question, rules) {
  const rule = matchRule(String(question?.question || ""), rules)?.rule || null;
  if (!rule) return null;
  const choices = Array.isArray(question?.choices) ? question.choices : [];
  if (!choices.length) return null;
  const hits = choices.filter((c) => {
    const needle = String(c).replace(/\s*\(Recommended\)\s*$/i, "").trim().toLowerCase();
    if (!needle) return false;
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(String(rule.text));
  });
  return hits.length === 1 ? { rule, choice: hits[0] } : null;
}
