// The three BASE-REF KINDS a cut can be made on, in one place.
//
// A cut needs a start ref, and the panel has grown three honest answers to "which one". Naming them together is what
// keeps the settings editor, the cut and the worker's brief using the same three words:
//
//   checkout        whatever branch the project's checkout is standing on (lib/jobs.js `startRefOf`). This is what
//                   every cut did before a project could say anything, and it is still the default: a checkout
//                   parked on main briefs its worker to push and open a pull request.
//   turnover        the branch the project NAMES in its own settings (`projects[].turnoverBranch`, read and written
//                   by lib/project-turnover.js and wired into the cut by ae6888ca). Named, so it is a fact in a file.
//   local-turnover  a LOCAL TURNOVER BRANCH the panel has to FIND: the name is the turnover shape
//                   YYYYMMDD_HHMM_<KEY>_<slug>, a remote carries it, and it has not landed. Nothing names it, so
//                   `lib/turnover-base.js` resolves it at the cut and ASKS THE READER when no branch qualifies -
//                   it never falls back to main, because that fallback is the failure this kind exists to prevent.
//
// The base ref the BOARD compares every row against is a different fact and is not one of these: it is the
// per-project `<remote>/<mainBranch>` pair `resolveBaseRef` builds in lib/base-ref.js. These three are about where a
// TREE STARTS, which is why a project can have a base pair and no turnover branch at all.
//
// Reading is FORGIVING and writing is STRICT, the same split lib/project-turnover.js uses for the branch name: a hand
// edited file still boots the panel, and a save never stores a value git or the cut cannot obey. A project that names
// a turnover branch and states no kind reads as `turnover`, so every config written before this key existed keeps the
// behaviour it has today.
export const BASE_REF_KINDS = ["checkout", "turnover", "local-turnover"];

/** The reader's words for each kind. The option label for the third is the one the request names, verbatim. */
export const BASE_REF_KIND_LABELS = {
  checkout: "the checkout's own branch",
  turnover: "the named turnover branch",
  "local-turnover": "local turnover branch - ask if none exist",
};

/** The third kind's own names, exported so no caller has to spell the string. */
export const LOCAL_TURNOVER_KIND = "local-turnover";
export const LOCAL_TURNOVER_LABEL = BASE_REF_KIND_LABELS[LOCAL_TURNOVER_KIND];

const KIND_SET = new Set(BASE_REF_KINDS);
const LOOSE_KIND = (value) => String(value ?? "").trim().toLowerCase().replace(/[\s_]+/g, "-");

/** The READ side: a stored value as a kind, with the named-turnover case derived from the branch when absent. */
export function baseRefKindFrom(value, { turnoverBranch = "" } = {}) {
  const kind = LOOSE_KIND(value);
  if (KIND_SET.has(kind)) return kind;
  // `localTurnover`, `local turnover` and `local-turnover-branch` all mean the third kind to a reader typing it by
  // hand; the stored value is the hyphenated one.
  if (kind === "localturnover" || kind === "local-turnover-branch") return LOCAL_TURNOVER_KIND;
  return String(turnoverBranch ?? "").trim() ? "turnover" : "checkout";
}

/** The WRITE side: the kind a POST asked to store, or the reason it cannot be stored. Only a value this list names is
 *  stored: a typo must be refused, never quietly read as `checkout`, because that would send a cut somewhere the
 *  reader did not choose. */
export function validateBaseRefKind(value) {
  if (value === null || value === undefined) return { kind: null };
  const kind = LOOSE_KIND(value);
  if (!kind) return { kind: null };
  if (KIND_SET.has(kind)) return { kind };
  if (kind === "local-turnover-branch" || kind === "localturnover") return { kind: LOCAL_TURNOVER_KIND };
  return { error: `baseRefKind must be one of ${BASE_REF_KINDS.join(", ")} - got \`${String(value).trim()}\`` };
}
