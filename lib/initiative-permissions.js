// THE INITIATIVE TIER: one setting decides whether a change to the initiative map is a question or a fact.
//
// Four levels, strictest first. `all` asks about every create, edit, attach and detach; `remove` asks only about a
// detach; `own` asks about a detach by somebody other than the actor who made the attachment; `none` asks nothing.
// The tier decides ONLY whether the panel asks. The permission card, its wording, its once/deny answer and the
// resume path are the same at every level, so a reader who moves the setting has changed how often they are
// interrupted, not what a change does.
//
// WHY THE THIRD LEVEL NEEDS A RECORD. "Ask me only to remove trees I attached myself" is a question about the
// ATTACHMENT, and a removal request only knows who is removing. So every attachment carries its actor and its time
// (lib/initiatives.js `members[id] = { at, by }`), and a detach is judged against that record. An attachment with no
// recorded actor - a store written before the field existed - is treated as somebody else's and asks: the
// alternative is guessing in the remover's favour and letting an assistant take out a tree it never added.
//
// THE READING OF `own`, stated once because the label alone can be read two ways. The tier is asking when the actor
// removing a tree is NOT the actor who attached it: a reader's own attachments come out without a question, and an
// assistant's do too when the assistant is removing what it attached. The opposite reading (ask when the remover IS
// the attacher) would let an assistant remove a tree the reader attached with no question at all, which is the one
// case this tier exists to stop.
export const INITIATIVE_TIERS = Object.freeze(["all", "remove", "own", "none"]);

// The strictest level, and the one an install with no key runs: a panel that has never been told a preference asks
// rather than assumes.
export const INITIATIVE_TIER_DEFAULT = "all";

// The four rows the settings select draws. `label` is the reader's words for the level, `hint` is what the panel then
// does - a label alone leaves the third level readable two ways, so the preview spells the behaviour out.
export const INITIATIVE_TIER_INFO = Object.freeze([
  {
    id: "all",
    label: "ask me for everything",
    short: "everything asks",
    hint: "every create, edit, attach and detach waits for your answer",
  },
  {
    id: "remove",
    label: "ask me only to remove things",
    short: "removals ask",
    hint: "creating, editing and attaching are free; taking a worktree out of an initiative asks",
  },
  {
    id: "own",
    label: "ask me only to remove trees I attached myself",
    short: "other people's trees ask",
    hint: "a tree you attached comes out without a question; one an assistant attached still asks",
  },
  {
    id: "none",
    label: "need no permission at all",
    short: "nothing asks",
    hint: "every change is made at once and recorded in the initiative's history, with the actor and the time",
  },
]);

// The four changes the tier governs. `attach` and `detach` are one tree's membership; `create` and `edit` are the
// initiative itself.
export const INITIATIVE_ACTIONS = Object.freeze(["create", "edit", "attach", "detach"]);

/** A stored or posted value as one of the four levels. Anything else is the default, never a thrown error. */
export function initiativeTierFrom(value) {
  const id = String(value ?? "").trim().toLowerCase();
  return INITIATIVE_TIERS.includes(id) ? id : INITIATIVE_TIER_DEFAULT;
}

/** The row the settings select and the tab's own line read, always one of the four. */
export function initiativeTierInfo(tier) {
  const id = initiativeTierFrom(tier);
  return INITIATIVE_TIER_INFO.find((row) => row.id === id) || INITIATIVE_TIER_INFO[0];
}

/**
 * Does this level ask the reader before `action` is made?
 *
 * `actor` is who is changing the map ("reader", or an assistant id), and `attachedBy` is the actor recorded on the
 * attachment a detach would remove. Only `own` reads the pair, and only for a detach. An unknown action is not a
 * change this setting governs and answers false, so a typo cannot park a question about nothing.
 */
export function initiativeAsks(tier, action, { actor = "reader", attachedBy = null } = {}) {
  const level = initiativeTierFrom(tier);
  const verb = String(action ?? "").trim().toLowerCase();
  if (!INITIATIVE_ACTIONS.includes(verb)) return false;
  if (level === "all") return true;
  if (level === "none") return false;
  // `remove` and `own` are both "removals only": nothing else at these levels asks.
  if (verb !== "detach") return false;
  if (level === "remove") return true;
  const who = String(actor || "reader").trim().toLowerCase();
  const owner = String(attachedBy ?? "").trim().toLowerCase();
  return !owner || who !== owner;
}

/** The sentence the settings preview and the tab draw for a level, with the actor rule spelled out. */
export function describeInitiativeTier(tier) {
  const info = initiativeTierInfo(tier);
  return `${info.label} - ${info.hint}`;
}
