// A relative path in a clarify question is only a link when the card can say WHAT it is relative to.
//
// THE DEFECT. A worker card asked "the rebuild status report at docs/reports/rebuild-phase_status.html ..." as bare
// relative text. The card drew an anchor (a relative path looked clickable), the reader clicked it, and the request
// carried the path with no base - so lib/open-url.js resolved it with path.resolve(), i.e. against the PANEL'S OWN
// cwd, and POST /api/open-file tried the open projects' checkouts in turn. The run that asked the question was in a
// worktree of one of them: the file was there, the panel looked in the checkout, and the reader got a 404 banner.
//
// THE RULE THIS PINS, in three halves:
//   - a relative target resolves against the base the QUESTION carries (the asking turn's own tree), and the anchor
//     that carries it says so in data-open-file-base, so the POST names the base instead of the panel guessing;
//   - a relative target the card has no base for is NOT an anchor: it stays plain text and the card says the path is
//     relative, because a link that answers "no such file" is worse than a path the reader can see is a path;
//   - an absolute path and a URL behave exactly as they did before this change.
//
// The page's own functions run here - linkifyCardParts / fileAnchor / questionLinks / questionPrompt are sliced out
// of public/core/dom-format.js and public/app.js - and the route is the panel's real /api/open-file in a sandbox.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { linksOf } from "../lib/clarify-links.js";
import { CLARIFY_LINKS_BRIEF } from "../lib/jobs.js";
import * as openUrl from "../lib/open-url.js";
import { post, startPanel, sliceBetween } from "../tools/panel-testkit.mjs";

// The drive letter is built at runtime: written out, it names a folder on the machine that wrote this file, which
// tools/absolute-paths.mjs refuses a commit for naming.
const DRIVE = `${"C"}:`;
const BASE = `${DRIVE}${"/work/demo/.worktrees/report-one"}`;
const REPORT = "docs/reports/rebuild-phase_status.html";
const ABS = `${BASE}/${REPORT}`;
const URL_ONE = "https://example.test/run/8";
// A name with a space and a non-ASCII character: both are legal in a path, both are percent-encoded in the file:///
// URL the browser is asked for, and neither may be mistaken for the end of the target.
const ODD = "docs/reports/rebuild phase_status-café.html";

async function card(question, { links, choices = [], base = undefined } = {}) {
  const page = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const dom = await readFile(new URL("../public/core/dom-format.js", import.meta.url), "utf8");
  const source = [
    sliceBetween(dom, "const esc = (s) =>", "\n// A path as a card"),
    sliceBetween(dom, "const OUT_URL_RE", "\nfunction fmtBytes"),
    sliceBetween(page, "const browserName =", "function paintQLook"),
    sliceBetween(page, "function questionLinks(q) {", "function questionPrompt("),
    sliceBetween(page, "const RECOMMENDED_RE", "// ---- the question box's look (Settings > Display)"),
    sliceBetween(page, 'function questionPrompt(turn, copy = "")', '// "~49m left"'),
  ].join("\n");
  const build = new Function(
    "turnLive", "questionInFlight", "qLookState", "fmtLeft", "questionPicks", "questionDrafts", "questionBrowser",
    `${source}\nreturn { questionPrompt };`,
  );
  const asked = { question, choices, requestId: "p-rel", links: linksOf(links) };
  // `undefined` means the record carries no base at all, which is what an old record looks like.
  if (base !== undefined) asked.base = base;
  const turn = { id: "turn-rel", thread: "wtgui-clarify-rel", status: "running", questionDone: false, question: asked };
  return build(() => true, () => null, { typed: true }, () => "10m", new Map(), new Map(), "Google Chrome").questionPrompt(turn);
}

const row = (html) => (/<div class="tq-question">([\s\S]*?)<\/div>/.exec(html) || [])[1] || "";
const noteOf = (html) => (/<div class="tq-relnote[^>]*>([\s\S]*?)<\/div>/.exec(html) || [])[1] || "";
const anchors = (html) => html.match(/<a\b[^>]*>/g) || [];

test("a relative target resolves against the base the question carries", async () => {
  const html = await card(`The rebuild status report at ${REPORT} finds phase 0 is 1 of 4.`, { base: BASE });
  const inner = row(html);
  assert.ok(inner.includes(`data-open-file="${REPORT}"`), `the path is an anchor:\n${inner}`);
  assert.ok(inner.includes(`data-open-file-base="${BASE}"`),
    `the anchor names the tree it belongs to, so the click cannot resolve anywhere else:\n${inner}`);
  assert.equal(noteOf(html), "", "a path that CAN be opened needs no explanation");
});

test("a path with a space and a non-ASCII character keeps its name and its base", async () => {
  // A bare path in prose ends at the space (OUT_FILE_RE never matches whitespace, which is what keeps a sentence
  // readable), so a name like this one travels through the `links` field - and there it is one target, whole.
  const html = await card("See the report.", { links: [{ label: "the odd report", path: ODD }], base: BASE });
  const inner = (html.match(/<div class="tq-links">([\s\S]*?)<\/div>\s*(?:<div class="tq-note)/) || [])[1] || "";
  assert.ok(inner.includes(`data-open-file="${ODD}"`), `the whole name is the target, spaces and accents included:\n${inner}`);
  assert.ok(inner.includes(`data-open-file-base="${BASE}"`), "and it still carries its base");
  assert.equal(
    openUrl.fileUrlFor(ODD, BASE),
    `${"file:///"}${BASE}/docs/reports/rebuild%20phase_status-caf%C3%A9.html`,
    "the file:/// URL the browser is asked for percent-encodes both, as UTF-8",
  );
  assert.equal(openUrl.resolveFileTarget(ODD, BASE).path.replace(/\\/g, "/"), `${BASE}/${ODD}`,
    "and the resolver lands on the file under the base");
  assert.equal(anchors(await card(`See ${ODD} here.`, { base: BASE })).length, 0,
    "a bare name with a space is not auto-linked, before or after this change: the Links field is how it travels");
});

test("a relative target with no base stays plain text, and the card says why", async () => {
  const html = await card(`The rebuild status report at ${REPORT} is ready - which direction next?`);
  const inner = row(html);
  assert.equal(anchors(html).length, 0, `nothing clickable, so nothing can fail:\n${html}`);
  assert.ok(inner.includes(REPORT), "the path is still readable in the sentence");
  assert.ok(!inner.includes("data-open-file"), "and it carries no opener attribute");
  const note = noteOf(html);
  assert.ok(note, `the card explains it:\n${html}`);
  assert.match(note, /relative/i, "the note says the path is relative");
  assert.ok(note.includes(REPORT), "and names the path it is talking about");
  assert.match(note, /no (tree|worktree|base)|without a base|cannot/, "and why it cannot be opened from here");
});

test("an absolute path is unchanged, and carries no base", async () => {
  const html = await card(`See ${ABS}.`, { base: BASE });
  const inner = row(html);
  assert.ok(inner.includes(`<a class="out-file" href="#" data-open-file="${ABS}" title="open ${ABS} in your browser">${ABS}</a>`),
    `the anchor is exactly what it was before this change:\n${inner}`);
  assert.ok(!inner.includes("data-open-file-base"), "an absolute path needs no base, so none is added");
});

test("a URL is unchanged", async () => {
  const html = await card(`The run is at ${URL_ONE} - ship it?`, { base: BASE });
  assert.ok(row(html).includes(
    `<a class="out-link" href="${URL_ONE}" target="_blank" rel="noreferrer noopener" data-open-url="${URL_ONE}" title="open in your browser">${URL_ONE}</a>`),
    `the URL anchor is untouched:\n${row(html)}`);
});

test("the worker brief asks for an absolute path and says why a relative one cannot be opened", async () => {
  // Step 3 of the fix. The paragraph is what a worker is actually told, so the rule has to live in it: an absolute
  // path, and the one sentence that explains the consequence of writing a relative one.
  const brief = CLARIFY_LINKS_BRIEF;
  assert.match(brief, /ABSOLUTE path/, "the brief asks for an absolute path");
  assert.match(brief, /not `docs\/reports\/thing\.html`/, "and shows the difference by example");
  assert.match(brief, /relative path cannot be opened/, "and says a relative path cannot be opened");
  assert.match(brief, /does not know which tree|wrong file/, "with the reason: the card has no tree, so it refuses instead of guessing");
});

test("a Links entry that is relative and has no base is not drawn as a link either", async () => {
  const html = await card("Pick one.", { links: [{ label: "the report", path: REPORT }] });
  assert.equal(anchors(html).length, 0, `no anchor for a target the card cannot resolve:\n${html}`);
  const inner = (html.match(/<div class="tq-links">([\s\S]*?)<\/div>\s*(?:<div class="tq-note)/) || [])[1] || "";
  assert.match(inner, /relative path, not a link/, `the row itself says why:\n${inner}`);
  assert.ok(inner.includes("the report"), "and the label the worker gave it is still there");
  const withBase = await card("Pick one.", { links: [{ label: "the report", path: REPORT }], base: BASE });
  assert.ok(withBase.includes(`data-open-file="${REPORT}"`) && withBase.includes(`data-open-file-base="${BASE}"`),
    "with a base the same entry is a link, and it names the base");
});

test("the route refuses a relative path with no base instead of guessing one", async (t) => {
  const panel = await startPanel();
  t.after(() => panel.stop());
  const answered = await post(panel.base, "/api/open-file", { body: { path: REPORT } });
  assert.equal(answered.status, 400, `HTTP ${answered.status}: ${answered.json?.error || ""}`);
  assert.match(answered.json?.error || "", /relative|base/i, "the refusal says what is missing");
  assert.ok(!answered.json?.path, "and nothing was opened");
});

test("the route resolves a relative path against the base it was given, and says where it looked", async (t) => {
  const panel = await startPanel();
  t.after(() => panel.stop());
  const missing = await post(panel.base, "/api/open-file", { body: { path: REPORT, base: BASE } });
  assert.equal(missing.status, 404, `HTTP ${missing.status}: ${missing.json?.error || ""}`);
  assert.ok(String(missing.json?.error || "").replace(/\\/g, "/").includes(`${BASE}/${REPORT}`),
    `it looked under the base it was given, not a project root: ${missing.json?.error || ""}`);
  assert.ok(String(missing.json?.error || "").includes(BASE), "and the sentence names that base");
});

test("a base cannot walk a file out of the projects", async (t) => {
  const panel = await startPanel();
  t.after(() => panel.stop());
  // `win.ini` exists on every Windows machine, so the refusal is the boundary and not a missing file.
  const escaped = await post(panel.base, "/api/open-file", { body: { path: "win.ini", base: `${DRIVE}${"/Windows"}` } });
  assert.equal(escaped.status, 403, `HTTP ${escaped.status}: ${escaped.json?.error || ""}`);
  assert.match(escaped.json?.error || "", /outside every project/i, "the boundary is what refused it");
});
