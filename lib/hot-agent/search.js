// The Hot Agent search: the turns the READER wrote to worker agents, across every tree this panel has run one in.
//
// WHAT A ROW IS. One turn the reader wrote to a worker agent: a job record in the panel's store whose `prompt` is
// the reader's own instruction. The record's other text is deliberately NOT searchable here:
//
//   * a REPLY the agent wrote (`finalMessage`, the card's completion) is the agent's text - "never an agent reply"
//     is this rule, not a filter the page applies afterwards;
//   * a console line is the agent's work, not the reader's writing;
//   * an ASSISTANT manager turn (`assistant: true`) is the panel's own sentry talking to itself, and a turn the
//     assistant started on a worker's behalf (`origin.kind` assistant-message / assistant-reply) is the manager
//     writing to a worker - neither is the reader's.
//
// A reply the READER typed into a worker's card is still the reader's turn, so `reply: true` records are in: the
// list is about who wrote the text, not about which of the two boxes it was typed in.
//
// WHERE THE TEXT IS. `Jobs.list()` (lib/jobs.js) is the summary set the page never sees: its card draws five turns
// and a console tail, while the store holds every turn it kept. `Jobs.get()` supplies the record for a field the
// summary drops, exactly as lib/assistant/search.js reads the same store for the assistant's own search.
//
// THE MATCHER is public/core/turn-search.js - the file the page loads as a classic script - so `*`, `?`, the
// substring rule, case-insensitivity and the metacharacter escaping have ONE implementation across both searches.
// An EMPTY query is not a failure here (the assistant's search refuses one): the Hot Agent bar opens on the most
// recent N turns with nothing typed, which is what makes the chord a browsing gesture as well as a search.
//
// THE LIMIT is public/core/hot-agent-list.js's default and clamp, the same numbers the page's Settings row writes.
// `matched` always counts every matching turn; `hits` holds what the limit allowed.
import "../../public/core/turn-search.js";
// Loaded for its global, exactly as the matcher above is: the file publishes `wtHotAgentList` and exports nothing,
// which is what lets the SAME file be a classic script for the page and a module import for the server.
import "../../public/core/hot-agent-list.js";

const { compile, excerpt } = globalThis.wtTurnSearch;
const hotAgentList = globalThis.wtHotAgentList;

// Per prompt, so one enormous brief cannot make a request unbounded on its own. The same cap the assistant's
// search uses.
export const HOT_AGENT_FIELD_CAP = 4000;
// The origin kinds that mean the ASSISTANT started this turn rather than the reader. The store's own spellings are
// `assistant-spawn` (the manager started a worker) and `assistant-wake` (the manager woke one); the message/reply
// kinds are the same rule under older names, and any `assistant-` prefix is treated as the manager's for the same
// reason - this list is the store's vocabulary, and the prefix is the defensive half for a kind added later.
const ASSISTANT_ORIGINS = new Set(["assistant-message", "assistant-reply", "assistant-spawn", "assistant-wake"]);
const isAssistantOrigin = (kind) => ASSISTANT_ORIGINS.has(kind) || kind.startsWith("assistant-");

export const HOT_AGENT_DEFAULT_LIMIT = hotAgentList.DEFAULT;
export const HOT_AGENT_LIMIT_MAX = hotAgentList.MAX;

/** Is this summary a turn the reader wrote to a WORKER agent, rather than to the manager or as the manager? */
export function isReaderWorkerTurn(summary, assistantThreads = null) {
  if (!summary || typeof summary !== "object") return false;
  if (summary.assistant) return false;
  const kind = String(summary.origin?.kind || "").trim();
  if (isAssistantOrigin(kind)) return false;
  // The board assistant's own thread is the MANAGER's card: a reader turn typed there is written to the manager,
  // not to a worker, and a card of the manager's is the one place the list must never point at.
  const thread = String(summary.thread || "");
  if (assistantThreads && thread) {
    const set = assistantThreads instanceof Set ? assistantThreads : new Set(assistantThreads);
    if (set.has(thread)) return false;
  }
  return true;
}

/** The last segment of a path, either separator, "" for nothing. */
function leaf(value) {
  const s = String(value == null ? "" : value).replace(/\\/g, "/").replace(/\/+$/, "");
  if (!s) return "";
  const at = s.lastIndexOf("/");
  return at >= 0 ? s.slice(at + 1) : s;
}

// What a row names besides the text: the agent the reader wrote to, its thread, and the project tree it ran in.
// `title` is the session's own name from the gateway's store and `label` is the panel's rename; either names the
// agent better than a thread id, and the thread id is the honest answer when neither exists.
//
// THE TREE, in the store's own shape: a job carries `tree` (the measurement `{path, branch, ...}` written at the end
// of the turn), and the path is also in `projectPath` - for a worktree job that IS the worktree, the
// `.worktrees/<name>` folder under the repo. So the tree is that leaf,
// and the PROJECT is the repo it was cut from: the segment before `/.worktrees/`, or the tree itself when the job
// ran in a plain checkout. `worktree`/`worktreePath` are the older fields of the same fact.
function nameOf(summary) {
  const thread = String(summary.thread || "");
  const title = String(summary.title || "").trim();
  const label = String(summary.label || "").trim();
  const agent = title || label || thread;
  const treePath = String(
    (summary.tree && typeof summary.tree === "object" ? summary.tree.path : "") || summary.worktreePath || summary.projectPath || summary.ownerPath || "",
  );
  const worktree = String(summary.worktree || "").trim() || leaf(treePath);
  const project = leaf(String(treePath).replace(/\/+\.worktrees\/[^/]+$/i, "")) || worktree;
  return { agent, thread, tree: worktree, treePath, project };
}

/**
 * One search over the worker turns a caller passed in.
 *
 * @param summaries `Jobs.list()` - each with `id`, `thread`, `turn`, `prompt`, `startedAt`, `assistant`, `origin`.
 * @param records   `(id) => raw job record | null` - `Jobs.get()`, for a prompt the summary dropped (a test may
 *                  pass nothing and the summary's own prompt is read).
 * @param query     what the reader typed; "" lists the most recent turns.
 * @param limit     how many turns to return.
 * @returns {{ query, limit, matched, displayed, hits }}
 *   `matched` counts every turn that answers, `displayed` is `hits.length`.
 */
export function searchHotAgents({ summaries = [], records = () => null, query = "", limit = HOT_AGENT_DEFAULT_LIMIT, assistantThreads = null } = {}) {
  const compiled = compile(query);
  const capped = hotAgentList.norm(limit);
  const managerThreads = assistantThreads ? (assistantThreads instanceof Set ? assistantThreads : new Set(assistantThreads)) : null;
  const hits = [];
  for (const summary of Array.isArray(summaries) ? summaries : []) {
    if (!isReaderWorkerTurn(summary, managerThreads)) continue;
    const id = String(summary.id || "");
    if (!id) continue;
    const record = records(id) || summary;
    const prompt = String(record?.prompt ?? summary.prompt ?? "");
    if (!prompt.trim()) continue;
    const text = prompt.length > HOT_AGENT_FIELD_CAP ? prompt.slice(0, HOT_AGENT_FIELD_CAP) : prompt;
    if (compiled && !compiled.re.test(text)) continue;
    const ex = excerpt(text, compiled);
    const at = Date.parse(record?.startedAt || summary.startedAt || "") || 0;
    const names = nameOf(summary);
    hits.push({
      id,
      thread: names.thread,
      // The counter the store wrote, which can move backwards after a trim; the row shows it as context, not as
      // an order.
      turn: Number(record?.turn ?? summary.turn) || 0,
      at,
      agent: names.agent,
      label: String(summary.label || "").trim() || null,
      tree: names.tree,
      treePath: names.treePath,
      project: names.project,
      branch: summary.branch || null,
      status: summary.status || null,
      // The one-line window around the match, already split so the row can mark `hit` without re-finding it. With
      // no filter the excerpt is the prompt's own head, which is what an unfiltered row shows.
      before: ex.before,
      hit: ex.hit,
      after: ex.after,
      lead: ex.lead,
      tail: ex.tail,
    });
  }
  // Newest first, by the clock the store wrote. An EQUAL stamp is broken deterministically so two reads of the
  // same store cannot swap rows: the higher turn counter first (a later turn in one thread is the newer one), then
  // the id, so the order is a function of the records and never of their arrival.
  hits.sort((a, b) => b.at - a.at || b.turn - a.turn || String(a.id).localeCompare(String(b.id)));
  const shown = hits.slice(0, capped);
  return {
    query: compiled ? compiled.text : "",
    limit: capped,
    matched: hits.length,
    displayed: shown.length,
    hits: shown,
  };
}
