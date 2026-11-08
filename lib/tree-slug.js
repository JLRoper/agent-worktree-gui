// What a tree is called in the half-minute before anything has happened in it.
//
// A tree is cut before there is any work to name it after, so the panel has only the task in hand: it took the
// prompt, folded it to a slug and cut at 24 characters. That lands mid-word, and the rename that follows cut at
// 40 and landed mid-word too, so one job could be spelled twice and neither spelling joined to the other.
// Measured on this board: `convert-all-seven-built-efe600` was the cut, `convert-built-in-ladder-pipelines-to-pdl-f76189`
// the rename, and they were two trees for one job that read as two unrelated jobs in the one list that shows them.
//
// The rule here is the one a reader uses: name the tree after the TASK TITLE (the first sentence of what was
// asked, which is the line a person would write on a card), and cut it on word boundaries instead of inside a
// word. A name may be longer than 24 characters - it is a directory name, not a chip - but it stays short enough
// to read and every word in it is whole.
//
// ASCII only: a branch name is compared, matched and spelled by git, by the page and by the worker's own report,
// so nothing here may depend on a character that another reader normalises differently.
export const TREE_SLUG_MAX = 40;

// The task's title: its first sentence, or its first line when there is no sentence ending. A prompt is often a
// paragraph (a landing brief, a quoted ticket), and the title is the part a reader would put on the card; taking
// the whole prompt would name the tree after whichever boilerplate happened to come first.
//
// The cut is at an end-of-sentence mark that is followed by whitespace or the end of the text, so a dotted token
// ("notes.txt", "lib/jobs.js") is never split in half.
export function taskTitle(raw, { max = 120 } = {}) {
  const text = String(raw ?? "").replace(/\r\n?/g, "\n").trim();
  if (!text) return "";
  const line = text.split("\n").find((l) => l.trim()) || "";
  const flat = line
    .replace(/^[\s#>*+\-]+/, "")
    .replace(/\s+/g, " ")
    .trim();
  const sentence = /^(.*?[.!?])(?=\s|$)/.exec(flat);
  const title = (sentence ? sentence[1] : flat).replace(/[.!?,;:]+$/, "").trim();
  return title.slice(0, max).trim();
}

// A readable slug: lower-case words joined by single hyphens, cut BETWEEN words at the budget. The first word is
// never dropped - a name with nothing left would say less than the old mid-word cut did - so a single word longer
// than the budget is the one case that is cut inside itself.
export function treeSlug(raw, { max = TREE_SLUG_MAX } = {}) {
  const words = String(raw ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .split("-")
    .filter(Boolean);
  if (!words.length) return "agent";
  const kept = [];
  let len = 0;
  for (const word of words) {
    const next = kept.length ? len + 1 + word.length : word.length;
    if (next > max) break;
    kept.push(word);
    len = next;
  }
  if (!kept.length) return words[0].slice(0, Math.max(1, max)).replace(/-+$/, "") || "agent";
  return kept.join("-");
}
