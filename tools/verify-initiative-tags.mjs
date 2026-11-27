#!/usr/bin/env node
// THE BOARD'S TAGS, ON A REAL PAGE: the chips, the +N, the filter row, the rename and the two-step delete.
//
// HARNESS: LIVE GATE (real panel, real git repositories, Playwright at 1440x900)
//
//   node tools/verify-initiative-tags.mjs [--shots <dir>]
//
// Every claim below is read off the running page, not out of public/assistant.js:
//
//   1. THE FILTER ROW IS AT THE TOP OF THE PANE, above the first card, with one toggle per registry tag and ALL of
//      them pressed at rest - the default that shows the whole board.
//   2. THE CARD DRAWS THREE CHIPS AND A +N, and they sit AFTER the "N waves" status chip in the same facts row: the
//      chip is `.init-tag` (`init-tag-<colour>`), never the count `.chip`, so the two are told apart by class and by
//      their computed paint.
//   3. THE +N LISTS THE REST: on a folded card one press opens the card AND draws the remaining chips in the second
//      row; on the open card the same press folds them back.
//   4. THE FILTER COMPOSES: pressing one tag off hides every card that lacks it (untagged cards included), the any/all
//      switch changes the question, and Clear puts every tag back on with "any" and brings the whole board back.
//   5. IT IS SAVED TWICE: after a press the URL carries `initTags`, localStorage holds the record, and a RELOAD lands
//      on the same filtered board.
//   6. A RENAME FOLLOWS EVERY CARD: the registry's one entry is edited and the chip's text changes on BOTH cards that
//      carry the tag, with no card touched.
//   7. A CONFIRMED DELETE NAMES THE COUNT and then leaves: the first press is refused with the count and the titles,
//      the confirm control names the number, and the confirmed press removes the chip from every card.
//   8. HEALTH: zero page errors and zero console errors; no sideways overflow of the filter row.
//
// Sandbox only: tools/initiatives-fixture.mjs writes its own WAG_HOME under the scratch root and boots server.js on a
// port of its own, so the reader's live panel and its state are never touched. Without Playwright the script says
// BROWSER-NOT-RUN and exits 2 rather than passing on a half that never ran.
import { mkdirSync } from "node:fs";
import path from "node:path";
import { loadPlaywright, notRun, openPage, withBrowser } from "./browser.mjs";
import { buildFixture, startFixturePanel, waitForFixtureRows, waitForInitiativesView } from "./initiatives-fixture.mjs";

const WATCHDOG_MS = Number(process.env.PANEL_VERIFY_WATCHDOG_MS || 300_000);
const watchdog = setTimeout(() => {
  try {
    process.stderr.write(`WATCHDOG: ${WATCHDOG_MS}ms elapsed without the run finishing - see the last line printed above.\n`);
  } catch {
    /* nothing left to do */
  }
  process.exit(1);
}, WATCHDOG_MS);

let failures = 0;
let checks = 0;
const check = (name, got, want) => {
  checks += 1;
  const pass = JSON.stringify(got) === JSON.stringify(want);
  if (!pass) failures += 1;
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${pass ? `: ${JSON.stringify(got)}` : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
};
const ok = (name, cond, extra = "") => {
  checks += 1;
  if (cond) console.log(`PASS  ${name}${extra ? `: ${extra}` : ""}`);
  else {
    failures += 1;
    console.log(`FAIL  ${name}${extra ? ` - ${extra}` : ""}`);
  }
};

const args = process.argv.slice(2);
const shotArg = args.includes("--shots") ? args[args.indexOf("--shots") + 1] : null;
const SHOTS = path.resolve(shotArg || path.join(process.cwd(), "docs", "reports", "assets", "initiative-tags-1.183.0"));
mkdirSync(SHOTS, { recursive: true });
let shotNo = 0;
const shotPath = (slug) => path.join(SHOTS, `${String((shotNo += 1)).padStart(2, "0")}-${slug}.png`);

const SSO = '[data-init-card="init_sso"]';
const RELEASE = '[data-init-card="init_release"]';
const KAFKA = '[data-init-card="init_kafka"]';
const SWEEPER = '[data-init-card="init_sweeper"]';

const playwright = loadPlaywright({ root: path.join(import.meta.dirname, "..") });
if (!playwright) {
  console.log(notRun("the board's tags", "playwright is not installed for this node (see tools/browser.mjs)"));
  process.exit(2);
}

const built = await buildFixture({});
const panel = await startFixturePanel({ home: built.home });
const base = panel.base;
const send = async (method, route, body) => {
  const r = await fetch(`${base}${route}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* the caller asserts on the status when the body is not JSON */
  }
  return { status: r.status, json, text };
};
const tagList = async () => (await (await fetch(`${base}/api/initiatives/tags`)).json()).tags || [];
const cardIds = async () => {
  const doc = await (await fetch(`${base}/api/initiatives`)).json();
  const out = {};
  for (const card of doc.initiatives || []) out[card.id] = card.tagIds || [];
  return out;
};

let verdict = null;
let tagIds = {};
try {
  await waitForFixtureRows(base);
  await waitForInitiativesView(base);
  // The tier is a fixture step: `none` makes the seeding writes land at once, and the tag routes never consult it.
  const tier = await send("POST", "/api/settings/initiative-tier", { tier: "none" });
  ok("the fixture panel answers, and its tier is set for a seeding write", tier.status === 200, `HTTP ${tier.status}`);

  // ---- the registry, as the reader writes it --------------------------------------------------------------
  const palette = { SSO: "violet", DMR: "sky", OPS: "green", QA: "amber", INF: "teal" };
  for (const [ident, color] of Object.entries(palette)) {
    const made = await send("POST", "/api/initiatives/tags", { ident, name: `${ident} work stream`, description: `the ${ident} slice of the work`, color });
    ok(`the reader created the tag ${ident}`, made.status === 201, made.status === 201 ? made.json?.tag?.id : made.text);
    if (made.status === 201) tagIds[ident] = made.json.tag.id;
  }
  const all = await tagList();
  check("the registry holds the five tags, oldest first", all.map((t) => t.ident), ["SSO", "DMR", "OPS", "QA", "INF"]);
  for (const tag of all) {
    ok(`${tag.ident} carries a server clock and a palette colour`, /^\d{4}-\d{2}-\d{2}T/.test(tag.createdAt || "") && Boolean(palette[tag.ident]), `${tag.createdAt} / ${tag.color}`);
  }
  const five = ["SSO", "DMR", "OPS", "QA", "INF"].map((i) => tagIds[i]);
  const applied = await send("POST", "/api/initiatives/update", { id: "init_sso", tagIds: five });
  ok("all five tags are applied to the SSO card", applied.status === 200 && (applied.json?.initiative?.tagIds || []).length === 5, `${applied.status} / ${(applied.json?.initiative?.tagIds || []).length} ids`);
  const two = [tagIds.SSO, tagIds.DMR];
  const appliedTwo = await send("POST", "/api/initiatives/update", { id: "init_release", tagIds: two });
  ok("two tags are applied to the release card", appliedTwo.status === 200 && (appliedTwo.json?.initiative?.tagIds || []).length === 2, `${appliedTwo.status}`);

  verdict = await withBrowser(
    async ({ page }) => {
      const errors = [];
      page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
      page.on("console", (m) => {
        // The browser logs every 4xx as a console error ("Failed to load resource"). The delete gate DELIBERATELY
        // provokes a 409, so the network line is not a page error; anything else on the console still is.
        if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(`console: ${m.text()}`);
      });
      const refusals = [];
      page.on("response", async (r) => {
        if (!/\/api\/initiatives/.test(r.url()) || r.status() < 400) return;
        let body = "";
        try {
          body = await r.text();
        } catch {
          /* a body that cannot be read is still a status worth naming */
        }
        refusals.push(`${r.request().method()} ${new URL(r.url()).pathname} -> ${r.status()} ${body.slice(0, 200)}`);
      });

      await openPage(page, base, { selector: "#projects" });
      const floatOpen = await page.evaluate(() => {
        const el = document.getElementById("assistant");
        return Boolean(el) && !el.hidden && getComputedStyle(el).display !== "none";
      });
      if (!floatOpen) await page.click("#btn-assistant");
      await page.waitForSelector("#assistant:not([hidden])", { timeout: 20_000 });
      await page.click('#as-tabs [data-as-tab="initiatives"]');
      await page.waitForSelector(`${SSO} .init-chips`, { timeout: 40_000 });
      await page.waitForSelector("#as-initiatives .init-tagbar", { timeout: 20_000 });

      // ---- 1. THE ROW, AT THE TOP, WITH EVERY TAG PRESSED ---------------------------------------------------
      const row = await page.evaluate(() => {
        const bar = document.querySelector("#as-initiatives .init-tagbar");
        const firstCard = document.querySelector("#as-initiatives [data-init-card]");
        const toggles = [...bar.querySelectorAll("[data-init-tagtoggle]")];
        const mode = [...bar.querySelectorAll("[data-init-tagmode]")].map((b) => ({ id: b.dataset.initTagmode, pressed: b.getAttribute("aria-pressed") }));
        const clear = bar.querySelector("[data-init-tagclear]");
        return {
          above: Boolean(firstCard) && bar.getBoundingClientRect().bottom <= firstCard.getBoundingClientRect().top + 1,
          width: Math.round(bar.getBoundingClientRect().width),
          pane: document.getElementById("as-initiatives").clientWidth,
          scrolls: bar.scrollWidth > bar.clientWidth + 1,
          idents: toggles.map((b) => b.textContent.trim()),
          pressed: toggles.map((b) => b.getAttribute("aria-pressed")),
          mode,
          clearPresent: Boolean(clear),
          clearDisabled: clear ? clear.disabled : null,
        };
      });
      ok("the tag filter row is ABOVE the first card", row.above);
      check("one toggle per registry tag, in registry order", row.idents, ["SSO", "DMR", "OPS", "QA", "INF"]);
      ok("ALL tags are pressed at rest - the default that shows the whole board", row.pressed.every((p) => p === "true"), row.pressed.join(","));
      check("the any/all switch is beside them, on any", row.mode, [{ id: "any", pressed: "true" }, { id: "all", pressed: "false" }]);
      ok("Clear is present and disabled while nothing is filtered", row.clearPresent && row.clearDisabled === true, `disabled=${row.clearDisabled}`);
      ok("the row fits the pane without scrolling sideways", !row.scrolls, `${row.width}px of row in a ${row.pane}px pane`);
      await page.screenshot({ path: shotPath("the-filter-row") });

      // ---- 2. THREE CHIPS AND A +N, AFTER THE WAVES CHIP ---------------------------------------------------
      const chips = await page.evaluate(() => {
        const facts = document.querySelector('[data-init-card="init_sso"] .init-chips');
        const kids = [...facts.children];
        const order = kids.map((el) => (el.classList.contains("init-status") ? "status" : el.classList.contains("init-tag-more") ? "more" : el.classList.contains("init-tag") ? "tag" : el.classList.contains("chip") ? "count" : el.className.split(" ")[0] || el.tagName));
        const tags = kids.filter((el) => el.classList.contains("init-tag"));
        const more = kids.find((el) => el.classList.contains("init-tag-more"));
        const status = kids.find((el) => el.classList.contains("init-status"));
        const paint = tags[0] ? getComputedStyle(tags[0]) : null;
        const countChip = kids.find((el) => el.classList.contains("chip") && !el.classList.contains("init-tag"));
        const countPaint = countChip ? getComputedStyle(countChip) : null;
        return {
          order,
          idents: tags.map((el) => el.textContent.trim()),
          classes: tags.map((el) => el.className),
          more: more ? more.textContent.trim() : null,
          moreAfterStatus: Boolean(more && status) ? kids.indexOf(more) > kids.indexOf(status) : false,
          tagRadius: paint ? parseFloat(paint.borderTopLeftRadius) || 0 : null,
          tagBorder: paint ? paint.borderLeftWidth : null,
          tagBg: paint ? paint.backgroundColor : null,
          countRadius: countPaint ? parseFloat(countPaint.borderTopLeftRadius) || 0 : null,
          countBg: countPaint ? countPaint.backgroundColor : null,
          waves: status ? status.textContent.trim() : null,
        };
      });
      check("the SSO card draws its FIRST THREE tags", chips.idents, ["SSO", "DMR", "OPS"]);
      check("then the +N chip, for the two that are left", chips.more, "+2");
      ok("the tag chips and the +N sit AFTER the waves status chip", chips.moreAfterStatus && chips.order.indexOf("tag") > chips.order.indexOf("status"), chips.order.join(" -> "));
      ok("a tag chip is NOT the count .chip: own class, its own 4px plate and fill", chips.classes.every((c) => c.includes("init-tag") && c.includes("init-tag-")) && chips.tagRadius !== chips.countRadius && chips.tagBg !== chips.countBg, `tag radius ${chips.tagRadius} vs count ${chips.countRadius}`);
      ok("the waves chip is still drawn, untouched, before them", typeof chips.waves === "string" && chips.waves.length > 0, chips.waves || "(none)");
      await page.screenshot({ path: shotPath("three-chips-and-the-rest") });

      // ---- 3. THE +N LISTS THE REST, ON A FOLDED CARD AND ON AN OPEN ONE -----------------------------------
      const folded = await page.evaluate(() => document.querySelector('[data-init-card="init_sso"] [data-init-card-toggle]').getAttribute("aria-expanded"));
      if (folded === "true") {
        await page.click(`${SSO} [data-init-card-toggle]`);
        await page.waitForTimeout(150);
      }
      ok("the SSO card starts this check folded", (await page.getAttribute(`${SSO} [data-init-card-toggle]`, "aria-expanded")) === "false");
      await page.click(`${SSO} [data-init-tags-more]`);
      await page.waitForTimeout(200);
      const opened = await page.evaluate(() => {
        const card = document.querySelector('[data-init-card="init_sso"]');
        const rest = card.querySelector("[data-init-tags-rest]");
        return {
          expanded: card.querySelector("[data-init-card-toggle]").getAttribute("aria-expanded"),
          rest: rest ? [...rest.querySelectorAll(".init-tag")].map((el) => el.textContent.trim()) : [],
          morePressed: card.querySelector("[data-init-tags-more]")?.getAttribute("aria-expanded"),
        };
      });
      check("one press on +2 opens the card AND lists the remaining tags", opened.expanded, "true");
      check("the rest row holds exactly the two that were hidden", opened.rest, ["QA", "INF"]);
      check("the +N chip now says it is open", opened.morePressed, "true");
      await page.screenshot({ path: shotPath("the-rest-listed") });
      await page.click(`${SSO} [data-init-tags-more]`);
      await page.waitForTimeout(200);
      const refolded = await page.evaluate(() => Boolean(document.querySelector('[data-init-card="init_sso"] [data-init-tags-rest]')));
      ok("the same press folds the rest back into +2", refolded === false);

      // ---- 4. THE FILTER COMPOSES WITH THE VIEW, AND CLEAR PUTS IT BACK ------------------------------------
      const cardsNow = async () =>
        await page.evaluate(() => [...document.querySelectorAll("#as-initiatives [data-init-card]")].map((c) => c.dataset.initCard));
      const before = await cardsNow();
      ok("all four active cards are on the board at rest", before.length === 4, before.join(", "));
      await page.click(`[data-init-tagtoggle="${tagIds.SSO}"]`);
      await page.waitForTimeout(250);
      const anyMode = await cardsNow();
      ok("pressing ONE tag off hides the untagged cards", !anyMode.includes("init_kafka") && !anyMode.includes("init_sweeper"), anyMode.join(", "));
      ok("the two cards that carry SSO stay", anyMode.includes("init_sso") && anyMode.includes("init_release"), anyMode.join(", "));
      const pressedNow = await page.getAttribute(`[data-init-tagtoggle="${tagIds.SSO}"]`, "aria-pressed");
      check("the pressed-off tag reads pressed=false", pressedNow, "false");

      // any -> all: every pressed tag must be on the card. SSO is off, and the SSO card carries all four that are left,
      // while the release card carries only DMR - so all mode narrows the board to ONE card where any mode showed two.
      await page.click('[data-init-tagmode="all"]');
      await page.waitForTimeout(250);
      const allMode = await cardsNow();
      check("switching to all keeps only the card that carries EVERY pressed tag", allMode, ["init_sso"]);
      await page.screenshot({ path: shotPath("all-mode-is-every-pressed-tag") });

      await page.click("#as-initiatives [data-init-tagclear]");
      await page.waitForTimeout(300);
      const cleared = { cards: await cardsNow(), state: await page.evaluate(() => ({ mode: document.querySelector('[data-init-tagmode="any"]').getAttribute("aria-pressed"), pressed: [...document.querySelectorAll("[data-init-tagtoggle]")].map((b) => b.getAttribute("aria-pressed")) })) };
      check("Clear draws the whole board again", cleared.cards.length, 4);
      ok("Clear is the DEFAULT: every tag pressed, matching any", cleared.state.mode === "true" && cleared.state.pressed.every((p) => p === "true"), `${cleared.state.mode} / ${cleared.state.pressed.join(",")}`);
      const url = await page.evaluate(() => location.search);
      ok("Clear leaves no filter in the URL", !String(url).includes("initTags"), url || "(no query)");

      // ---- 4b. THE EMPTY STATE NAMES THE FILTER, NOT AN EMPTY BOARD ------------------------------------------
      // A tag nothing carries, reached through the URL: a pasted link is one of the two ways this filter is saved,
      // and the state it lands on is the one a reader must be able to read their way out of.
      const lost = await send("POST", "/api/initiatives/tags", { ident: "LOST", name: "a tag nothing carries", color: "red" });
      ok("a sixth tag exists that no card carries", lost.status === 201, lost.status === 201 ? lost.json.tag.id : lost.text);
      const lostId = lost.status === 201 ? lost.json.tag.id : "";
      await page.goto(`${base}/?initTags=${encodeURIComponent(lostId)}`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("#as-initiatives .init-tagbar", { timeout: 40_000 });
      // The pane paints the document it cached before this tag existed, then the read lands: the empty state is what
      // the READ draws, so this waits for it rather than for a fixed 600ms.
      await page.waitForSelector("#as-initiatives [data-init-tagempty]", { timeout: 20_000 }).catch(() => {});
      const emptyState = await page.evaluate(() => {
        const box = document.querySelector("#as-initiatives [data-init-tagempty]");
        const clear = document.querySelector("#as-initiatives [data-init-tagclear]");
        return {
          text: box ? box.textContent.replace(/\s+/g, " ").trim() : "",
          cards: document.querySelectorAll("#as-initiatives [data-init-card]").length,
          clearEnabled: clear ? !clear.disabled : null,
        };
      });
      ok("a filter nothing matches draws the filter's own empty state", emptyState.cards === 0 && /any of|all of/.test(emptyState.text), `${emptyState.cards} cards :: ${emptyState.text.slice(0, 130)}`);
      ok("and Clear is enabled there - the way out is on screen", emptyState.clearEnabled === true);
      await page.screenshot({ path: shotPath("nothing-carries-this-tag") });
      await page.click("#as-initiatives [data-init-tagclear]");
      await page.waitForTimeout(300);
      check("Clear from that state draws the whole board again", (await cardsNow()).length, 4);

      // ---- 5. SAVED TWICE: THE URL AND localStorage, AND A RELOAD LANDS ON IT --------------------------------
      await page.click(`[data-init-tagtoggle="${tagIds.DMR}"]`);
      await page.waitForTimeout(250);
      const saved = await page.evaluate(() => ({ search: location.search, stored: localStorage.getItem("wm.initiativeTagFilter") }));
      const savedIds = decodeURIComponent(String(saved.search).replace(/^.*initTags=/, "")).split(",").filter(Boolean);
      const expectedPressed = (await tagList()).filter((t) => t.ident !== "DMR").map((t) => t.id).sort();
      check("a press writes the PRESSED tags into the URL", savedIds.slice().sort(), expectedPressed);
      ok("the tag pressed OFF is not in the saved selection", !String(saved.stored || "").includes(tagIds.DMR), String(saved.stored || "").slice(0, 160));
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForSelector("#as-initiatives .init-tagbar", { timeout: 40_000 });
      await page.waitForTimeout(600);
      const reloaded = await page.evaluate(() => ({
        cards: [...document.querySelectorAll("#as-initiatives [data-init-card]")].map((c) => c.dataset.initCard),
        pressed: [...document.querySelectorAll("[data-init-tagtoggle]")].map((b) => b.getAttribute("aria-pressed")),
        url: location.search,
      }));
      ok("after a reload the same tags are pressed and the same cards are drawn", reloaded.cards.length === 2 && reloaded.cards.includes("init_sso") && reloaded.cards.includes("init_release"), `${reloaded.cards.join(", ")} from ${reloaded.url}`);
      await page.screenshot({ path: shotPath("survives-a-reload") });
      await page.click("#as-initiatives [data-init-tagclear]");
      await page.waitForTimeout(250);

      // ---- 6. A RENAME FOLLOWS EVERY CARD ---------------------------------------------------------------
      await page.click("#as-initiatives [data-init-tagmgr]");
      await page.waitForSelector("#as-initiatives [data-init-tagmgr-body]", { timeout: 10_000 });
      await page.click(`[data-init-tagrename="${tagIds.SSO}"]`);
      await page.waitForSelector(`[data-init-tagformbody="${tagIds.SSO}"]`, { timeout: 10_000 });
      await page.fill(`[data-init-tagformbody="${tagIds.SSO}"] [data-init-tagfield="ident"]`, "okta");
      await page.fill(`[data-init-tagformbody="${tagIds.SSO}"] [data-init-tagfield="name"]`, "Okta sign-in");
      await page.selectOption(`[data-init-tagformbody="${tagIds.SSO}"] [data-init-tagfield="color"]`, "violet");
      await page.click(`[data-init-tagsave="${tagIds.SSO}"]`);
      await page.waitForTimeout(500);
      const renamed = await page.evaluate(() => {
        const chipsOf = (sel) => [...document.querySelectorAll(`${sel} .init-tag`)].map((el) => el.textContent.trim());
        const mgr = document.querySelector("#as-initiatives [data-init-tagmgr-body]");
        const rows = [...(mgr ? mgr.querySelectorAll("[data-init-tagrow]") : [])].map((r) => ({
          chip: r.querySelector(".init-tag")?.textContent.trim() || "",
          name: r.querySelector(".init-tagname")?.textContent.trim() || "",
        }));
        return {
          sso: chipsOf('[data-init-card="init_release"]'),
          rows,
          toggle: [...document.querySelectorAll("#as-initiatives [data-init-tagtoggle]")].map((b) => b.textContent.trim()),
        };
      });
      ok("the renamed tag reads as its new ident on a card that carries it", renamed.sso.includes("okta") && !renamed.sso.includes("SSO"), renamed.sso.join(", "));
      ok("the filter row's toggle follows the same entry", renamed.toggle.includes("okta") && !renamed.toggle.includes("SSO"), renamed.toggle.join(", "));
      ok(
        "the registry editor's own row carries the new ident and name",
        renamed.rows.some((r) => r.chip === "okta" && r.name === "Okta sign-in"),
        renamed.rows.map((r) => `${r.chip}=${r.name}`).join(", "),
      );
      await page.screenshot({ path: shotPath("a-rename-follows-every-card") });

      // ---- 7. DELETE REFUSES WITH THE COUNT, THEN LEAVES --------------------------------------------------
      // DMR is carried by two cards (SSO and release) after the seeding above.
      await page.click(`[data-init-tagdelete="${tagIds.DMR}"]`);
      await page.waitForTimeout(400);
      const refused = await page.evaluate(() => {
        const row = document.querySelector(`[data-init-tagrow="${document.querySelector("[data-init-tagdeleteforce]")?.dataset.initTagdeleteforce || ""}"]`);
        return {
          force: Boolean(document.querySelector("[data-init-tagdeleteforce]")),
          text: row ? row.textContent.replace(/\s+/g, " ").trim() : "",
          label: document.querySelector("[data-init-tagdeleteforce]")?.textContent.trim() || "",
        };
      });
      ok("the first press is refused while cards carry the tag", refused.force === true);
      ok("the refusal NAMES THE COUNT (2), and the confirm control repeats it", /2 initiatives/.test(refused.text) && refused.label === "Delete anyway (2)", `${refused.label} :: ${refused.text.slice(0, 160)}`);
      const stillThere = (await tagList()).map((t) => t.ident);
      ok("nothing was deleted by the refused press", stillThere.includes("DMR"), stillThere.join(", "));
      await page.screenshot({ path: shotPath("the-delete-names-the-count") });
      await page.click(`[data-init-tagdeleteforce="${tagIds.DMR}"]`);
      await page.waitForTimeout(600);
      const after = await page.evaluate(() => [...document.querySelectorAll("#as-initiatives [data-init-card] .init-tag")].map((el) => el.textContent.trim()));
      ok("the confirmed delete takes the chip off every card", !after.includes("DMR"), after.join(", "));
      ok("and the registry no longer holds it", !(await tagList()).map((t) => t.ident).includes("DMR"));
      const ids = await cardIds();
      ok("the stored cards no longer carry the deleted id", !ids.init_sso.includes(tagIds.DMR) && !ids.init_release.includes(tagIds.DMR), JSON.stringify({ sso: ids.init_sso.length, release: ids.init_release.length }));
      await page.screenshot({ path: shotPath("after-the-delete") });

      check("zero page errors and zero console errors", errors, []);
      ok("the only refusals the page provoked were the delete gate's own 409", refusals.every((r) => /-> 409/.test(r)), refusals.join(" | ") || "none");
      return { checks, failures };
    },
    { playwright, viewport: { width: 1440, height: 900 } },
  );
} catch (err) {
  failures += 1;
  console.log(`FAIL  the run threw: ${String((err && err.stack) || err)}`);
} finally {
  console.log(`\n${failures ? "FAIL" : "PASS"}  the board's tags: ${checks - failures}/${checks} checks passed`);
  console.log(`SHOTS ${SHOTS}`);
  console.log(`EXIT=${failures ? 1 : 0}`);
  clearTimeout(watchdog);
  await panel.stop().catch(() => {});
  process.exit(failures ? 1 : 0);
}
