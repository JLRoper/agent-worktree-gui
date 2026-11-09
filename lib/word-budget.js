// How long a piece of written work may be: what the BRIEF states, and nothing the panel invented.
//
// The reader's decision, from the round-7 review: the brief's own text governs. A pipeline stage is not a house style,
// and the panel has no business imposing a length on work it was only handed a prompt for — the round-7 draft landed
// at 599 of the 600 words its brief allowed, and the critic's acceptance note recorded "599 of its 600 words" as a
// constraint, because the only number in play was the brief's own ceiling treated as a target.
//
// So there are two kinds of number here, and they are not the same kind of rule:
//
//   the BUDGET     A range or ceiling the brief states in words ("400-600 words", "no more than 900 words"). It is
//                  quoted back to the stage with the brief's own phrasing, so the stage reads one number and not two:
//                  the brief's text and the panel's paraphrase of it. When the brief states none, there is NO default
//                  ceiling — a stage told to keep to 600 words about a brief that never asked would cut real work.
//
//   the GUARD       One number the panel does own, `RUNAWAY_WORDS` (4,000). It is not a style rule and not a target:
//                  it exists so a draft that has lost control is named as a runaway instead of being argued about, and
//                  it is high enough that no honest brief's ceiling ever collides with it.
//
// Read as prose, not as a contract: this module answers what the brief SAYS, and a brief it cannot read is a brief
// with no stated budget — never a guess. Nothing here counts the words of a finished file; the panel checks an
// artifact's presence and hash, and a word count is the reviewing seat's judgement.
export const RUNAWAY_WORDS = 4000;

const text = (value) => (typeof value === "string" ? value.trim() : "");

// A number a person wrote: thousands separators are how a long one is spelled, so they are stripped before parsing.
function countOf(raw) {
  const n = Number(String(raw ?? "").replace(/[,\s]/g, ""));
  return Number.isInteger(n) && n > 0 ? n : null;
}

// The budget one brief states, as `{ min, max, stated }`, or null when it states none.
//
// The phrasings are the ones a brief actually uses. Order matters where two patterns could match the same words: the
// range is tried first, because "400-600 words" is one budget and not a 600-word ceiling with a stray 400 beside it.
const RANGE = /(\d[\d,]*)\s*(?:-|–|—|to)\s*(\d[\d,]*)\s*words?\b/i;
const BETWEEN = /between\s+(\d[\d,]*)\s+and\s+(\d[\d,]*)\s*words?\b/i;
const MOST = /(?:under|below|at most|no more than|up to|not more than|max(?:imum)?(?:\s+of)?)\s+(\d[\d,]*)\s*words?\b/i;
const LEAST = /(?:over|above|at least|no fewer than|no less than|min(?:imum)?(?:\s+of)?)\s+(\d[\d,]*)\s*words?\b/i;
// The qualifier AFTER the number, which is how a brief often writes it: "900 words maximum", "250 words or more".
const MOST_AFTER = /(\d[\d,]*)\s*words?\s*(?:max(?:imum)?|or less|or fewer)\b/i;
const LEAST_AFTER = /(\d[\d,]*)\s*words?\s*(?:min(?:imum)?|or more)\b/i;
const EXACT = /(\d[\d,]*)\s*words?\b/i;

export function wordBudgetOf(brief) {
  const source = text(brief);
  if (!source) return null;
  const range = BETWEEN.exec(source) || RANGE.exec(source);
  if (range) {
    const a = countOf(range[1]);
    const b = countOf(range[2]);
    if (a && b) return { min: Math.min(a, b), max: Math.max(a, b), stated: range[0].trim() };
    return null;
  }
  const most = MOST.exec(source);
  if (most) {
    const max = countOf(most[1]);
    if (max) return { min: null, max, stated: most[0].trim() };
  }
  const least = LEAST.exec(source);
  if (least) {
    const min = countOf(least[1]);
    if (min) return { min, max: null, stated: least[0].trim() };
  }
  const mostAfter = MOST_AFTER.exec(source);
  if (mostAfter) {
    const max = countOf(mostAfter[1]);
    if (max) return { min: null, max, stated: mostAfter[0].trim() };
  }
  const leastAfter = LEAST_AFTER.exec(source);
  if (leastAfter) {
    const min = countOf(leastAfter[1]);
    if (min) return { min, max: null, stated: leastAfter[0].trim() };
  }
  const exact = EXACT.exec(source);
  if (exact) {
    const n = countOf(exact[1]);
    // One number with no "at most" or "at least" is a target, not a bound: it reads as both, and it is quoted back in
    // the plural a budget is written in ("800 word note" says `800 words`), never as the scrap of prose it came from.
    if (n) return { min: n, max: n, stated: `${n} word${n === 1 ? "" : "s"}` };
  }
  return null;
}

// One sentence for the stage's prompt: the brief's budget when it states one, the panel's guard always, and — when the
// brief states nothing — the fact that nothing was asked for, so a ceiling the model would otherwise assume is named
// as an assumption rather than applied as a rule. Returns "" for a stage with no brief at all.
export function budgetLine(brief) {
  const source = text(brief);
  if (!source) return "";
  const budget = wordBudgetOf(source);
  const guard = `${RUNAWAY_WORDS.toLocaleString("en-US")} words is the panel's runaway guard — a guard, not a style rule: past it, say the work has run away rather than cutting it to fit`;
  if (!budget) {
    return `  budget      the brief states no word budget — do not invent a ceiling; ${guard}`;
  }
  const shape =
    budget.min && budget.max && budget.min === budget.max
      ? `the brief states ${budget.stated}`
      : budget.min && budget.max
        ? `the brief states ${budget.stated} (${budget.min}-${budget.max} words)`
        : budget.max
          ? `the brief states ${budget.stated} (at most ${budget.max} words)`
          : `the brief states ${budget.stated} (at least ${budget.min} words)`;
  return `  budget      ${shape} — enforce that and only that; ${guard}`;
}

// The block a stage prompt carries, in the prompt's own shape. Kept here rather than in the driver so the rule and the
// parser are one file; the driver decides only WHERE the block goes.
//
// It is emitted ONLY when the brief states a budget. Every queue row carries a detail paragraph, and most of them are
// about code, a branch or a ticket — a paragraph about word counts in those prompts would be noise the turn pays for
// on every stage. A brief that says nothing about length gets no line from this panel, which is the decision itself:
// the ABSENCE of a ceiling is the rule, and the one place it has to be SAID is the seat that reviews prose (the seed's
// critique stage), not every prompt the panel builds.
export function budgetBlock(brief) {
  if (!wordBudgetOf(brief)) return [];
  return ["BUDGET", budgetLine(brief)];
}
