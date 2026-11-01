// placedNodes() (public/app.js): the board's consoles, thinking bodies and subagent consoles without a walk of the
// page. Six paths - the typing pacer's tick, every streamed line, every stream repaint and the 400 ms sweep three times
// over - used to ask the whole document for them each time. The registry is only worth having if it answers EXACTLY
// what that walk answered, so this drives the shipped functions in a real browser through every way a node arrives
// and leaves (a rebuild, an insert above, a removal, a move, out-and-back in one task, an outerHTML swap, a tree built
// off the page, a lost class, a stream of lines, an emptied board) and compares the two answers after each step, in
// the same task and after the observer's own turn. It also pins the two design decisions the comment in app.js
// rests on: a lookup never walks the document, and taking the registry's records leaves the copy observer's alone.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadPlaywright } from "../tools/browser.mjs";

const src = readFileSync(new URL("../public/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");

function region(startText, endText, tail) {
  const start = src.indexOf(startText);
  assert.ok(start >= 0, `public/app.js carries ${startText.trim()}`);
  const end = src.indexOf(endText, start);
  assert.ok(end > start, `and it ends where expected`);
  return src.slice(start, end + tail);
}
const helpers = () => region("function placedNodes(", "\n}\n", 3) + region("function notePlaced(", "\n}\n", 3) + region("function byDocumentOrder(", "\n}\n", 3);
const watch = () => region("placedNodes.watch = (() => {", "\n})();\n", 7);

async function withBrowser(t, fn) {
  const playwright = loadPlaywright();
  if (!playwright) {
    t.skip("no Playwright install on this machine (PANEL_PLAYWRIGHT_ROOT) - the registry was not exercised");
    return;
  }
  const browser = await playwright.chromium.launch();
  try {
    await fn(browser);
  } finally {
    await browser.close();
  }
}

test("a lookup answers what a walk of the page would, through every way a node arrives and leaves", async (t) => {
  const code = `${helpers()}\n${watch()}`;
  await withBrowser(t, async (browser) => {
    const page = await browser.newPage();
    await page.setContent("<!doctype html><html><body><main id=board></main><aside id=pins></aside></body></html>");
    // A stand-in for the copy observer, set up before the registry the way app.js sets them up.
    await page.addScriptTag({
      content: `window.__copySaw = 0;
new MutationObserver((rs) => { for (const r of rs) window.__copySaw += r.addedNodes.length; }).observe(document.documentElement, { childList: true, subtree: true });
${code}`,
    });
    const out = await page.evaluate(async () => {
      const SELS = ["pre.job-out", ".think-body", ".sub-console", "tr.detail", ".tgrp", ".queue-ago", "[data-q-clock]"];
      const mismatches = [];
      let checks = 0;
      let docWalks = 0;
      let inLookup = false;
      const qsa = Document.prototype.querySelectorAll;
      Document.prototype.querySelectorAll = function (s) {
        if (inLookup) docWalks += 1;
        return qsa.call(this, s);
      };
      const names = (els) => els.map((e) => e.dataset.k || e.className);
      const check = (step) => {
        for (const sel of SELS) {
          const want = [...document.querySelectorAll(sel)];
          inLookup = true;
          const got = placedNodes(sel);
          inLookup = false;
          checks += 1;
          if (want.length !== got.length || want.some((e, i) => e !== got[i])) mismatches.push({ step, sel, want: names(want), got: names(got) });
        }
      };
      const tick = () => new Promise((r) => setTimeout(r, 0));
      const card = (k, n = 2) =>
        `<section class="card" data-k="card-${k}">` +
        Array.from({ length: n }, (_, i) => `<pre class="job-out" data-k="${k}-${i}"><div>x</div><details class="think" open><div class="think-body" data-k="${k}-${i}-think"></div></details></pre>`).join("") +
        `<div class="sub-console" data-k="${k}-sub"></div>` +
        `<table><tbody><tr class="detail" data-detail="${k}" data-k="${k}-detail"><td><div class="tgrp" data-k="${k}-tgrp">` +
        `<span class="queue-ago" data-queued-at="1" data-k="${k}-ago">1s</span><i data-q-clock="${k}" data-k="${k}-clock"></i>` +
        `</div></td></tr></tbody></table></section>`;
      const board = document.getElementById("board");
      const pins = document.getElementById("pins");

      board.innerHTML = card("a") + card("b");
      check("a rebuild by innerHTML, looked up in the same task");
      await tick();
      check("the same, after the observer's own turn");

      const top = document.createElement("pre");
      top.className = "job-out";
      top.dataset.k = "top";
      board.insertBefore(top, board.firstChild);
      check("a console placed above the others: document order, not arrival order");

      board.querySelector('[data-k="a-0"]').remove();
      check("a console removed");

      pins.appendChild(board.querySelector('[data-k="b-1"]'));
      check("a console moved into the pinned block");

      const cardB = board.querySelector('[data-k="card-b"]');
      cardB.remove();
      board.appendChild(cardB);
      check("a card taken out and put back in one task");

      cardB.remove();
      check("a card out of the page");
      board.prepend(cardB);
      check("the same card back, at the top");

      board.querySelector('[data-k="b-sub"]').outerHTML = '<div class="sub-console" data-k="b-sub-2"><pre class="job-out" data-k="b-sub-2-out"></pre></div>';
      check("an outerHTML swap, the subagent strip's shape");

      const built = document.createElement("div");
      built.innerHTML = card("c", 3);
      board.appendChild(built);
      check("a tree built off the page, then placed");

      board.querySelector('[data-k="c-1"]').className = "job-out-old";
      check("a node that lost its class");
      board.querySelector('[data-k="c-1"]').className = "job-out";
      check("and got it back");

      const c0 = board.querySelector('[data-k="c-0"]');
      for (let i = 0; i < 200; i++) {
        const d = document.createElement("div");
        d.textContent = `line ${i}`;
        c0.appendChild(d);
      }
      check("200 lines streamed into a console");

      await tick(); // the stand-in has seen everything placed so far
      const before = window.__copySaw;
      board.insertAdjacentHTML("beforeend", card("e", 1));
      check("a card placed and looked up at once");
      await tick();
      const copyGotIt = window.__copySaw - before;

      board.textContent = "";
      check("the board emptied");
      board.innerHTML = card("d", 1);
      await tick();
      check("built again after it was empty");

      return { mismatches, checks, docWalks, copyGotIt, found: placedNodes("pre.job-out").length };
    });
    assert.deepEqual(out.mismatches, [], "every lookup returned the walk's nodes, in the walk's order");
    assert.ok(out.checks >= 16 * 7, `${out.checks} comparisons (16 steps x 7 kinds)`);
    assert.equal(out.docWalks, 0, "and not one lookup walked the document");
    assert.equal(out.copyGotIt, 1, "the copy observer still saw the card the registry's lookup had already taken");
    assert.equal(out.found, 2, "the rebuilt card's console, and the one still in the pinned block");
  });
});

test("before the watch is set up a lookup is the walk it replaces (control)", async (t) => {
  await withBrowser(t, async (browser) => {
    const page = await browser.newPage();
    await page.setContent('<!doctype html><html><body><pre class="job-out" data-k="1"></pre><div class="sub-console"></div><pre class="job-out" data-k="2"></pre></body></html>');
    await page.addScriptTag({ content: helpers() });
    const got = await page.evaluate(() => ({
      outs: placedNodes("pre.job-out").map((e) => e.dataset.k),
      subs: placedNodes(".sub-console").length,
      watch: typeof placedNodes.watch,
    }));
    assert.deepEqual(got, { outs: ["1", "2"], subs: 1, watch: "undefined" });
  });
});

test("on a board-sized page the lookup and the walk agree (the timing is a diagnostic, not a gate)", async (t) => {
  await withBrowser(t, async (browser) => {
    const page = await browser.newPage();
    await page.setContent("<!doctype html><html><body><main id=board></main></body></html>");
    await page.addScriptTag({ content: `${helpers()}\n${watch()}` });
    const r = await page.evaluate(() => {
      // ~55k nodes, 40 consoles: the reader's board, measured.
      const board = document.getElementById("board");
      let html = "";
      for (let c = 0; c < 40; c++) {
        html += `<section><pre class="job-out" data-k="${c}">`;
        for (let l = 0; l < 450; l++) html += `<div class="ln"><span>a</span><span>b</span></div>`;
        html += `</pre></section>`;
      }
      board.innerHTML = html;
      const nodes = document.getElementsByTagName("*").length;
      const time = (fn) => {
        const t0 = performance.now();
        for (let i = 0; i < 200; i++) fn();
        return (performance.now() - t0) / 200;
      };
      placedNodes("pre.job-out");
      const walk = time(() => document.querySelectorAll("pre.job-out").length);
      const lookup = time(() => placedNodes("pre.job-out").length);
      return { nodes, walk, lookup, same: placedNodes("pre.job-out").length === document.querySelectorAll("pre.job-out").length };
    });
    t.diagnostic(`${r.nodes} nodes: a walk ${r.walk.toFixed(3)} ms, a lookup ${r.lookup.toFixed(3)} ms`);
    assert.ok(r.same);
    assert.ok(r.nodes > 50_000, `${r.nodes} nodes`);
  });
});
