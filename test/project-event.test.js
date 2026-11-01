// A project event that carries nothing new stops before the section rebuild (public/core/sse.js).
//
// The store sends a `project` event on every patch, changed or not (lib/store.js patchProject), and the board answered
// each one by rebuilding the project's section: forced layout reads, a fresh header, the rows moved across, a row
// repaint and a re-sort. On the reader's board 68 of 68 repeat events in 100 s were byte-identical to the last one for
// their project, and the handler was the most expensive path on the page (350 ms of main thread a minute, 0.48.1).
// These tests run the shipped connect() against a fake EventSource and send it events.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const src = readFileSync(new URL("../public/core/sse.js", import.meta.url), "utf8");

function board() {
  const calls = { refreshChips: 0, renderAll: 0, projectSection: 0, renderProjectRows: 0, reorderProjects: 0 };
  const listeners = new Map();
  class FakeEventSource {
    constructor(url) {
      this.url = url;
    }
    addEventListener(type, fn) {
      listeners.set(type, fn);
    }
    close() {}
  }
  const ctx = {
    state: { projects: new Map(), es: null, events: 0 },
    EventSource: FakeEventSource,
    // No section on the page, so an event that goes on is seen to: it asks for a full render.
    document: { querySelector: () => null },
    CSS: { escape: (s) => String(s) },
    refreshChips: () => (calls.refreshChips += 1),
    renderAll: () => (calls.renderAll += 1),
    projectSection: () => {
      calls.projectSection += 1;
      return "";
    },
    renderProjectRows: () => (calls.renderProjectRows += 1),
    reorderProjects: () => (calls.reorderProjects += 1),
    $: () => ({ textContent: "", className: "" }),
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  vm.runInContext("connect()", ctx);
  assert.ok(listeners.has("project"), "connect() listens for project events");
  const send = (project) => listeners.get("project")({ data: JSON.stringify({ project }) });
  return { ctx, calls, send };
}

test("a project the page has never seen is drawn (control)", () => {
  const { ctx, calls, send } = board();
  send({ name: "alpha", summary: { rows: 1, dirty: 0 } });
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.state.projects.get("alpha"))), { name: "alpha", summary: { rows: 1, dirty: 0 } });
  assert.equal(calls.refreshChips, 1);
  assert.equal(calls.renderAll, 1, "it went on to draw the project");
});

test("the same event again stops before anything is rebuilt", () => {
  const { ctx, calls, send } = board();
  send({ name: "alpha", summary: { rows: 1, dirty: 0 } });
  const held = ctx.state.projects.get("alpha");
  send({ name: "alpha", summary: { rows: 1, dirty: 0 } });
  send({ name: "alpha", summary: { rows: 1, dirty: 0 } });
  assert.equal(calls.refreshChips, 1, "no chip refresh for an event that changes nothing");
  assert.equal(calls.renderAll, 1, "and no rebuild");
  assert.equal(ctx.state.projects.get("alpha"), held, "the record the page holds is left as it was");
});

test("any field that moved is drawn, nested ones included (control)", () => {
  const { calls, send } = board();
  send({ name: "alpha", summary: { rows: 1, dirty: 0 }, fetchNote: "" });
  send({ name: "alpha", summary: { rows: 1, dirty: 1 }, fetchNote: "" });
  assert.equal(calls.renderAll, 2, "a changed summary");
  send({ name: "alpha", summary: { rows: 1, dirty: 1 }, fetchNote: "ssh: connect timed out" });
  assert.equal(calls.renderAll, 3, "a changed fetch note, which the rows quote");
  send({ name: "alpha", summary: { rows: 1, dirty: 1 }, fetchNote: "ssh: connect timed out", mainBranch: "main" });
  assert.equal(calls.renderAll, 4, "a field the page did not have");
});

test("what the snapshot added and the event does not carry is not compared", () => {
  const { ctx, calls, send } = board();
  ctx.state.projects.set("beta", { name: "beta", summary: { rows: 2 }, worktrees: [{ path: "C:/w/one" }, { path: "C:/w/two" }] });
  send({ name: "beta", summary: { rows: 2 } });
  assert.equal(calls.renderAll, 0, "the snapshot's worktree list is not part of the event, so it is not a difference");
  assert.equal(ctx.state.projects.get("beta").worktrees.length, 2);
});

test("projectEventIsNew answers field by field over what the event carries", () => {
  const { ctx } = board();
  const isNew = (a, b) => vm.runInContext(`projectEventIsNew(${JSON.stringify(a)}, ${JSON.stringify(b)})`, ctx);
  assert.equal(vm.runInContext("projectEventIsNew(undefined, { name: 'x' })", ctx), true, "an unknown project is new");
  assert.equal(isNew({ name: "x", a: 1 }, { name: "x", a: 1 }), false);
  assert.equal(isNew({ name: "x", a: 1 }, { name: "x", a: 2 }), true);
  assert.equal(isNew({ name: "x", a: { b: [1, 2] } }, { name: "x", a: { b: [1, 2] } }), false);
  assert.equal(isNew({ name: "x", a: { b: [1, 2] } }, { name: "x", a: { b: [2, 1] } }), true);
  assert.equal(isNew({ name: "x", extra: [1] }, { name: "x" }), false, "only the event's own fields are compared");
});
