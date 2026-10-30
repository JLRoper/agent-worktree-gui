// The panel's side of a CHECKING agent's answer: which settled runs have one, and the one word that acts on it.
//
// The check itself is read-only and produces nothing but a sentence, so the value of the feature is what the panel
// does with that sentence: on LANDED: YES it moves the tree to the Recycle Bin (lib/worktree-remove.js) - and on
// every other word, including a word it cannot read, it deletes nothing. A missing answer costs the reader one
// click; a wrong YES costs them a worktree, so only the explicit YES is evidence enough.
//
// The sweep is a pass over the JOB STORE rather than a callback on one run, because a panel restarted between the
// answer and the delete has to still act on it, and the job store is what survives a restart.
import { VERIFY_LABEL_PREFIX, verdictFromText } from "./verify-prompt.js";
import { isLiveJobStatus } from "./jobs.js";

// How old an answer may be and still be acted on. Past this it is history: the tree has been re-read, renamed or
// touched many times since, and a delete caused by a fifteen-minute-old sentence is not something the reader asked
// for. The window is generous because a restart takes seconds and the agent's answer is the reader's own click.
export const ANSWER_MAX_AGE_MS = 15 * 60_000;

export const isCheckJob = (job) => String(job?.label || "").startsWith(VERIFY_LABEL_PREFIX);

// The words the answer is read from. `jobs.list()` returns SUMMARIES, and a summary deliberately drops
// `finalMessage` - it is the largest field a card has. `jobs.get(id)` is the door that holds it, and it is what the
// sweep uses first; this fallback is for a run whose live object is gone (a restored card, a test's fixture), where
// the completion payload's `final.text` is the same words, capped at 4000 characters from the START - so a report
// long enough to be truncated has lost its last line, and that is exactly why the live object comes first.
export function answerTextOf(job) {
  return String(job?.finalMessage || job?.completion?.final?.text || "");
}

// The settled check runs whose answer has not been acted on yet, newest first. `acted` is the caller's record of the
// job ids it has already answered (one delete per answer, per process); `now` is injectable so the age rule is
// testable without a clock.
export function answeredChecks(jobs = [], { acted = new Set(), now = Date.now(), maxAgeMs = ANSWER_MAX_AGE_MS } = {}) {
  const out = [];
  for (const job of jobs || []) {
    if (!job || !job.id || acted.has(job.id)) continue;
    if (!isCheckJob(job)) continue;
    // A live turn has said nothing final yet, however many LANDED: lines its transcript already carries.
    if (isLiveJobStatus(job.status)) continue;
    const ended = Date.parse(job.endedAt || "");
    if (!Number.isFinite(ended) || now - ended > maxAgeMs) continue;
    const answer = verdictFromText(answerTextOf(job));
    if (!answer) continue;
    out.push({ job, answer });
  }
  return out.sort((a, b) => String(b.job.endedAt).localeCompare(String(a.job.endedAt)));
}

// The only answer that authorises a delete. Named rather than inlined at the call site so the rule has one home and
// one sentence: PARTIAL, NO, SUPERSEDED and "no answer" all leave the tree exactly where it is.
export const answerDeletes = (answer) => answer?.verdict === "YES";

// What the card says when the answer has been read, whether or not it deleted anything. The reader needs the word
// and the reason more than they need a second summary of the check, which is already in the run's own report.
export function answerLine(answer, { deleted, error, base = "main" } = {}) {
  const word = answer?.verdict || "NO ANSWER";
  if (deleted) {
    return `panel: LANDED: ${word} - the change is on ${base}, so this worktree went to the Recycle Bin and git's record of it was pruned`;
  }
  if (error) return `panel: LANDED: ${word} - nothing was deleted: ${error}`;
  if (answerDeletes(answer)) return `panel: LANDED: ${word} - nothing was deleted`;
  if (word === "NO ANSWER") return "panel: this run published no LANDED: line, so nothing was deleted - the tree is exactly where it was";
  return `panel: LANDED: ${word} - nothing was deleted, and this worktree stays where it is`;
}
