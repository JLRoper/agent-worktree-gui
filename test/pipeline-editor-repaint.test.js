// Settings > Pipeline: add stage / remove stage repaint the rows they change.
//
// The editor's own code is sliced out of public/app.js and driven against a DOM stub just big enough for the tab —
// the form's markup is a flat run of divs, inputs, textareas and selects, so the stub parses what the page writes and
// answers the handful of selectors the region asks for. What this pins:
//
//   - two `add stage` presses leave two VISIBLE rows and a two-stage draft. Today's paint returns at the dirty guard
//     (`paintPipelineEditor`, public/app.js:17748) before it can draw the row the press just appended, so the form
//     keeps one row while the draft holds two — and Save writes the draft;
//   - `remove` leaves neither the row nor the stage;
//   - a keystroke after a structural press reads the rows ON SCREEN, never a stale row: the removed stage does not
//     come back through updateDraftFromForm's read of the DOM;
//   - Save PUTs exactly the stages the form shows;
//   - the repaint is caret-safe: focus, selection and scroll in a stage field survive it, the typed sentence is still
//     in the field, and a press on a removed row's own button hands focus to the add press rather than dropping it;
//   - the dirty guard itself still holds: a full paint while the draft is dirty leaves the reader's title field alone.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { sliceRegion } from "../tools/panel-testkit.mjs";

const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const region = sliceRegion(app, "settings > pipeline");

const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const decode = (s) =>
  String(s ?? "")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

// ---------- a DOM stub, only as large as this tab ----------

const VOID = new Set(["input", "br", "img", "hr", "meta", "link"]);

class El {
  constructor(tag, attrs = {}) {
    this.tag = String(tag || "").toLowerCase();
    this.attrs = attrs;
    this.children = [];
    this.parentElement = null;
    this.text = "";
    this.listeners = {};
    this.selected = null;
    this.selectionStart = undefined;
    this.selectionEnd = undefined;
    this.scrollTop = 0;
    this.doc = null;
  }

  get id() {
    return this.attrs.id || "";
  }
  get className() {
    return this.attrs.class || "";
  }
  get dataset() {
    return { stageIndex: this.attrs["data-stage-index"] };
  }
  get hidden() {
    return "hidden" in this.attrs;
  }
  set hidden(on) {
    if (on) this.attrs.hidden = "";
    else delete this.attrs.hidden;
  }
  get disabled() {
    return "disabled" in this.attrs;
  }
  set disabled(on) {
    if (on) this.attrs.disabled = "";
    else delete this.attrs.disabled;
  }
  get classList() {
    const words = () => String(this.className).split(/\s+/).filter(Boolean);
    const write = (list) => {
      this.attrs.class = [...new Set(list)].join(" ");
    };
    return {
      contains: (name) => words().includes(name),
      add: (name) => write([...words(), name]),
      remove: (name) => write(words().filter((w) => w !== name)),
      toggle: (name, on) => {
        const want = on === undefined ? !words().includes(name) : Boolean(on);
        if (want) write([...words(), name]);
        else write(words().filter((w) => w !== name));
      },
    };
  }
  get value() {
    if (this.tag === "select") {
      const options = this.querySelectorAll("option");
      const picked = options.find((o) => "selected" in o.attrs) || options[0];
      return picked ? picked.value : "";
    }
    if (this.tag === "textarea") return decode(this.text);
    return "value" in this.attrs ? this.attrs.value : "";
  }
  set value(v) {
    if (this.tag === "textarea") this.text = String(v);
    else this.attrs.value = String(v);
  }
  get textContent() {
    return decode(this.text) + this.children.map((c) => c.textContent).join("");
  }
  set textContent(v) {
    this.text = String(v);
    this.children = [];
  }
  set innerHTML(html) {
    this.children = parseMarkup(String(html)).map((c) => link(c, this, this.doc));
  }
  get innerHTML() {
    return "";
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
  querySelectorAll(selector) {
    const out = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (matchesSelector(child, selector)) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }
  contains(node) {
    for (let el = node; el; el = el.parentElement) if (el === this) return true;
    return false;
  }
  addEventListener(type, fn) {
    (this.listeners[type] = this.listeners[type] || []).push(fn);
  }
  dispatch(type) {
    for (const fn of this.listeners[type] || []) fn({ type, target: this });
  }
  focus() {
    if (this.doc) this.doc.activeElement = this;
  }
  setSelectionRange(start, end) {
    this.selectionStart = start;
    this.selectionEnd = end;
  }
}

function link(el, parent, doc) {
  el.parentElement = parent;
  el.doc = doc;
  for (const child of el.children) link(child, el, doc);
  return el;
}

function parseAttrs(raw) {
  const attrs = {};
  const re = /([a-zA-Z_:][\w:.-]*)(?:\s*=\s*"([^"]*)")?/g;
  let m;
  while ((m = re.exec(raw || ""))) if (m[1]) attrs[m[1]] = m[2] === undefined ? "" : decode(m[2]);
  return attrs;
}

// The markup the tab writes: balanced elements, attributes quoted with `esc`'s &quot;, text inside textarea/option.
function parseMarkup(html) {
  const root = new El("#root");
  const stack = [root];
  const token = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[a-zA-Z_:][\w:.-]*(?:\s*=\s*"[^"]*")?)*)\s*(\/?)>|([^<]+)/g;
  let m;
  while ((m = token.exec(html))) {
    const [, close, tag, attrsRaw, selfClose, text] = m;
    const top = stack[stack.length - 1];
    if (text != null) {
      top.text += text;
      continue;
    }
    if (close) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const node = new El(tag, parseAttrs(attrsRaw));
    top.children.push(node);
    if (!selfClose && !VOID.has(node.tag)) stack.push(node);
  }
  return root.children;
}

function simpleMatch(el, part) {
  const re = /([a-zA-Z][\w-]*)|\.([\w-]+)|#([\w-]+)|\[([\w-]+)(?:="([^"]*)")?\]/g;
  let m;
  while ((m = re.exec(part))) {
    if (m[1] && el.tag !== m[1].toLowerCase()) return false;
    if (m[2] && !String(el.className).split(/\s+/).includes(m[2])) return false;
    if (m[3] && el.id !== m[3]) return false;
    if (m[4] && String(el.attrs[m[4]] ?? "") !== (m[5] ?? "")) return false;
  }
  return true;
}

function matchesSelector(el, selector) {
  for (const alternative of String(selector).split(",")) {
    const parts = alternative.trim().split(/\s+/).filter(Boolean);
    if (!parts.length) continue;
    if (!simpleMatch(el, parts[parts.length - 1])) continue;
    let ok = true;
    let node = el.parentElement;
    for (let i = parts.length - 2; i >= 0 && ok; i -= 1) {
      while (node && !simpleMatch(node, parts[i])) node = node.parentElement;
      if (!node) ok = false;
      else node = node.parentElement;
    }
    if (ok) return true;
  }
  return false;
}

function makeDocument() {
  const doc = { body: new El("body"), activeElement: null };
  doc.body.doc = doc;
  doc.getElementById = (id) => {
    const walk = (node) => {
      for (const child of node.children) {
        if (child.id === id) return child;
        const hit = walk(child);
        if (hit) return hit;
      }
      return null;
    };
    return walk(doc.body);
  };
  return doc;
}

// The tab's static surroundings (index.html) plus the editor the page builds into them.
function makePage() {
  const doc = makeDocument();
  for (const id of ["pipeline-summary", "pipeline-source", "pipeline-list", "pipeline-editor"]) {
    doc.body.children.push(link(new El("div", { id }), doc.body, doc));
  }
  return doc;
}

// ---------- the page's own code, against the stub ----------

function makePanel(definition) {
  const doc = makePage();
  const writes = [];
  const state = { version: 1, exitChecks: ["clean"], pipelines: { demo: JSON.parse(JSON.stringify(definition)) } };
  const apiFetch = async (url, opts = {}) => {
    if (url === "/api/pipelines" && opts.method === "PUT") {
      const body = JSON.parse(opts.body);
      writes.push(body);
      state.pipelines = { ...state.pipelines, ...body.pipelines };
      return { ok: true, status: 200, json: async () => ({ state }) };
    }
    return { ok: false, status: 404, json: async () => ({ error: "no route in this stub" }) };
  };
  const api = new Function(
    "document",
    "apiFetch",
    "esc",
    "confirm",
    `${region}
     return {
       get draft() { return pipelineDraft; },
       get dirty() { return pipelineDraftDirty; },
       get index() { return pipelinesIndex; },
       set index(v) { pipelinesIndex = v; },
       openPipelineEditor,
       paintPipelines,
       paintPipelineEditor,
       addPipelineStage,
       removePipelineStage,
       updateDraftFromForm,
       savePipelineEditor,
     };`,
  )(doc, apiFetch, esc, () => true);
  api.index = state;
  api.paintPipelines();
  return { doc, api, writes };
}

const rowsOf = (doc) => doc.getElementById("pipeline-stages").querySelectorAll(".pipeline-stage");
const idsOnScreen = (doc) => rowsOf(doc).map((row) => row.querySelector(".stage-id").value);
const stage = (id, prompt = "") => ({ id, title: `${id} title`, prompt, exit: { check: "clean" } });
const defOf = (...stages) => ({ id: "demo", title: "Demo", kind: "local", description: "", next: null, stages });

// A keystroke, as the browser delivers it: the field holds the new text, then it says so.
const typeInto = (field, text) => {
  field.value = text;
  field.dispatch("input");
};

test("two add stage presses leave two visible rows and a two-stage draft", () => {
  const { doc, api } = makePanel(defOf());
  assert.equal(rowsOf(doc).length, 0, "the definition starts with no stage row");

  api.addPipelineStage();
  assert.equal(rowsOf(doc).length, 1, "the first press draws its row");
  api.addPipelineStage();
  assert.equal(rowsOf(doc).length, 2, "the second press draws its row too");
  assert.equal(api.draft.stages.length, 2, "and the draft holds exactly the rows on screen");
});

test("remove leaves neither the row nor the stage", () => {
  const { doc, api } = makePanel(defOf(stage("a"), stage("b"), stage("c")));
  assert.equal(rowsOf(doc).length, 3);

  api.removePipelineStage(1);
  assert.equal(rowsOf(doc).length, 2, "the row is gone from the form");
  assert.deepEqual(idsOnScreen(doc), ["a", "c"], "and it is the one the press named");
  assert.deepEqual(
    api.draft.stages.map((s) => s.id),
    ["a", "c"],
    "the draft agrees with the form",
  );
});

test("a keystroke after a remove does not resurrect the removed stage", () => {
  const { doc, api } = makePanel(defOf(stage("a"), stage("b"), stage("c")));
  api.removePipelineStage(1);

  typeInto(rowsOf(doc)[0].querySelector(".stage-prompt"), "edited by the reader");
  assert.deepEqual(
    api.draft.stages.map((s) => s.id),
    ["a", "c"],
    "the keystroke reads the two rows on screen, not the three the form used to draw",
  );
  assert.equal(api.draft.stages[0].prompt, "edited by the reader");
  assert.equal(rowsOf(doc).length, 2);
});

test("a keystroke after an add keeps the added stage", () => {
  const { doc, api } = makePanel(defOf(stage("a")));
  api.addPipelineStage();
  typeInto(rowsOf(doc)[0].querySelector(".stage-prompt"), "the first stage, retyped");

  assert.equal(api.draft.stages.length, 2, "the added stage was not dropped by the keystroke");
  assert.equal(api.draft.stages[1].id, "");
  assert.equal(api.draft.stages[0].prompt, "the first stage, retyped");
});

test("Save persists exactly the stages on screen", async () => {
  const { doc, api, writes } = makePanel(defOf(stage("a", "first")));
  api.addPipelineStage();
  typeInto(rowsOf(doc)[0].querySelector(".stage-prompt"), "first, edited");
  typeInto(rowsOf(doc)[1].querySelector(".stage-id"), "b");
  typeInto(rowsOf(doc)[1].querySelector(".stage-prompt"), "second");

  const onScreen = rowsOf(doc).map((row) => ({
    id: row.querySelector(".stage-id").value,
    title: row.querySelector(".stage-title").value,
    prompt: row.querySelector(".stage-prompt").value,
    check: row.querySelector(".stage-exit-check").value,
  }));
  assert.equal(onScreen.length, 2);
  assert.equal(onScreen[1].id, "b");

  await api.savePipelineEditor();
  assert.equal(writes.length, 1, "one PUT");
  const saved = writes[0].pipelines.demo.stages;
  assert.equal(saved.length, onScreen.length, "the body carries one stage per row");
  saved.forEach((s, i) => {
    assert.equal(s.id, onScreen[i].id);
    assert.equal(s.title, onScreen[i].title);
    assert.equal(s.prompt, onScreen[i].prompt);
    assert.deepEqual(s.exit, { check: onScreen[i].check });
  });
});

test("the repaint keeps the caret, the selection and the scroll in a stage field", () => {
  const { doc, api } = makePanel(defOf(stage("a"), stage("b")));
  const prompt = rowsOf(doc)[1].querySelector(".stage-prompt");
  typeInto(prompt, "half a sentence the reader is still typing");
  prompt.focus();
  prompt.setSelectionRange(4, 9);
  prompt.scrollTop = 42;

  api.addPipelineStage();

  const again = rowsOf(doc)[1].querySelector(".stage-prompt");
  assert.equal(doc.activeElement, again, "the same stage's prompt holds the focus");
  assert.equal(again.selectionStart, 4, "the selection starts where it did");
  assert.equal(again.selectionEnd, 9);
  assert.equal(again.scrollTop, 42);
  assert.equal(again.value, "half a sentence the reader is still typing", "and the sentence is still in the field");
  assert.equal(rowsOf(doc).length, 3, "the new row is drawn beside it");
});

test("a press on a row's own remove button hands focus to the add press", () => {
  const { doc, api } = makePanel(defOf(stage("a"), stage("b"), stage("c")));
  const remove = rowsOf(doc)[1].querySelector(".stage-remove");
  remove.focus();
  remove.dispatch("click");

  assert.deepEqual(idsOnScreen(doc), ["a", "c"], "the press removed the row it belongs to");
  assert.equal(rowsOf(doc).length, 2);
  assert.equal(doc.activeElement, doc.getElementById("pipeline-add-stage"), "focus is not left on a detached button");
});

test("a dirty draft is still never fully repainted", () => {
  const { doc, api } = makePanel(defOf(stage("a")));
  const title = doc.getElementById("pipeline-title");
  typeInto(title, "a title the reader is typing");
  title.focus();
  title.setSelectionRange(3, 3);

  api.paintPipelineEditor();

  assert.equal(api.draft.title, "a title the reader is typing");
  assert.equal(doc.activeElement, title, "the title field is the same node, still focused");
  assert.equal(title.selectionStart, 3);
  assert.equal(doc.getElementById("pipeline-title").value, "a title the reader is typing");
});
