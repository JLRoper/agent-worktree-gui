#!/usr/bin/env node
// THE INITIATIVE NOTE LOG AND THE TWO MODERNISED FOLDS, ON THE REAL PAGE, AT TWO WIDTHS.
//
// HARNESS: LIVE GATE
//
//   node tools/verify-initiative-notes.mjs [--shots <dir>]
//
// WHAT THIS GATE PROVES, and why each half is a measurement rather than a look:
//
//   1. THE FORM IS THE RIGHT WAY ROUND, AT EVERY WIDTH. The reader's screenshot showed the title input 250px tall and
//      the description textarea 78px with a scrollbar through 356px of words. The rule that did it is
//      `.as-group input[type="text"] { flex: 1 1 250px }`: a flex-basis is measured on the MAIN axis, and the form is
//      `flex-direction: column`, so that 250px was the input's HEIGHT. The gate reads both boxes' rectangles at 1440,
//      900 and 480 - the title is one line (`height <= 40`, and `<= 2 x its line-height`), the description has the
//      room (`height >= 3 x the title's`), and the title's computed flex-basis is not a 250px height any more.
//   2. THE EMPTY STATE SAYS WHAT BELONGS THERE, in words: tickets, pull requests, decisions, versions.
//   3. A NOTE WRITTEN IN THE TAB IS IN THE STORE. Type, press Save note, and the row is drawn newest-first AND the
//      bytes in initiatives.json hold it - the gate reads the file, so a painter that drew a note the route refused
//      cannot pass.
//   4. A PASTED URL IS A CHIP WITH THE STORE'S OWN HOST. A Jira link with a label draws `Jira` and that label; a
//      GitHub link draws `GitHub`; both are real anchors with `target="_blank"` and `rel="noopener noreferrer"`, and
//      the href is the URL itself.
//   5. AN EDIT KEEPS THE AUTHOR AND STAMPS THE EDITOR. The words change, `by` is still `reader`, and the store carries
//      `editedAt`/`editedBy`.
//   6. A DELETE ASKS ONCE. The first press arms (`Delete for good?`), the second removes the row, and the store no
//      longer holds it.
//   7. A NOTE AN ASSISTANT LOGGED IS ATTRIBUTED AND DRAWN DIFFERENTLY. Written through the same route with
//      `by: "assistant-2"` - the writer an assistant's turn uses - it draws `.init-note.is-assistant`, names that
//      assistant, and is visually distinct from the reader's own row (class, author line, left rule colour).
//   8. A DUPLICATE URL IS ONE ROW. Pasting the same ticket again changes nothing and says so.
//   9. THE TWO FOLDS STILL FOLD, with every behaviour under them: Assistants and History open and close (aria-expanded
//      both ways), the assistant rows keep their ask-prefill attributes and their four count chips, an assistant's
//      tasks fold still opens onto its cards, and the history entries keep their actor and time.
//  10. NO SIDEWAYS OVERFLOW at either width, and HEALTH: zero page errors and zero console errors.
//
// Sandbox only: tools/initiatives-fixture.mjs writes its own WAG_HOME under the scratch root and boots server.js on a
// port of its own, so the reader's live panel on 7331 and its state are never touched. Without Playwright the script
// says BROWSER-NOT-RUN and exits 2 rather than passing a half that never ran.
import { mkdirSync, readFileSync } from "node:fs";
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

let checks = 0;
let failures = 0;
const ok = (name, cond, extra = "") => {
  checks += 1;
  if (cond) console.log(`PASS  ${name}${extra ? `: ${extra}` : ""}`);
  else {
    failures += 1;
    console.log(`FAIL  ${name}${extra ? ` - ${extra}` : ""}`);
  }
};
const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want), got === want ? String(JSON.stringify(got)) : `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const args = process.argv.slice(2);
const shotArg = args.includes("--shots") ? args[args.indexOf("--shots") + 1] : null;
const SHOTS = path.resolve(shotArg || path.join(process.cwd(), "docs", "reports", "assets", "initiative-notes-1.174.0"));
mkdirSync(SHOTS, { recursive: true });
let shotNo = 0;
const shotPath = (slug) => path.join(SHOTS, `${String((shotNo += 1)).padStart(2, "0")}-${slug}.png`);

const JIRA = "https://jira.prog.sefl.com/browse/DMR-39015";
const BITBUCKET = "https://bitbucket.prog.sefl.com/projects/DMR/repos/menu/pull-requests/4/overview";
const GITHUB = "https://github.com/JLRoper/agent-worktree-gui/pull/806";
const CARD = '[data-init-card="init_release"]';

const playwright = loadPlaywright({ root: path.join(import.meta.dirname, "..") });
if (!playwright) {
  console.log(notRun("the initiative note log", "playwright is not installed for this node (see tools/browser.mjs)"));
  process.exit(2);
}

const built = await buildFixture({});
const panel = await startFixturePanel({ home: built.home });
const storeFile = built.files.initiatives;
const readStore = () => JSON.parse(readFileSync(storeFile, "utf8"));
const notesInStore = (id) => {
  const rec = (readStore().initiatives || []).find((i) => i.id === id);
  return Array.isArray(rec?.notes) ? rec.notes : [];
};

let verdict = null;
try {
  await waitForFixtureRows(panel.base);
  await waitForInitiativesView(panel.base);
  const view = await fetch(`${panel.base}/api/initiatives`).then((r) => r.json());
  const init = (view.initiatives || []).find((i) => i.id === "init_release");
  const assistantName = (id) => String((init?.assistants || []).find((a) => String(a.id) === id)?.name || id);
  ok("the fixture card is on the read, with its assistants", Boolean(init) && (init.assistants || []).length === 2, `${(init?.assistants || []).map((a) => `${a.id}=${a.name}`).join(", ")}`);
  ok("the note caps ride the read, and they are the store's", view.caps?.noteText === 1000 && view.caps?.notes === 200, JSON.stringify({ text: view.caps?.noteText, label: view.caps?.noteLabel, notes: view.caps?.notes }));

  verdict = await withBrowser(
    async ({ page }) => {
      const errors = [];
      page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
      page.on("console", (m) => {
        if (m.type() === "error") errors.push(`console: ${m.text()}`);
      });

      await openPage(page, panel.base, { selector: "#projects" });
      const floatOpen = await page.evaluate(() => {
        const el = document.getElementById("assistant");
        return Boolean(el) && !el.hidden && getComputedStyle(el).display !== "none";
      });
      if (!floatOpen) await page.click("#btn-assistant");
      await page.waitForSelector("#assistant:not([hidden])", { timeout: 20_000 });
      await page.click('#as-tabs [data-as-tab="initiatives"]');
      await page.waitForSelector("#as-initiatives .init-card", { timeout: 40_000 });
      if ((await page.locator(`${CARD} [data-init-card-toggle]`).getAttribute("aria-expanded")) !== "true") {
        await page.locator(`${CARD} [data-init-card-toggle]`).click();
      }
      await page.waitForSelector(`${CARD} [data-init-notes]`, { timeout: 20_000 });

      // ---- 1. THE FORM, THE RIGHT WAY ROUND, AT THREE WIDTHS ----------------------------------------------------
      const measureForm = async (vp) => {
        await page.setViewportSize(vp);
        await page.waitForTimeout(350);
        if ((await page.locator(`${CARD} [data-init-card-toggle]`).getAttribute("aria-expanded")) !== "true") {
          await page.locator(`${CARD} [data-init-card-toggle]`).click();
        }
        if (!(await page.locator(`${CARD} [data-init-editform]`).count())) {
          await page.locator(`${CARD} [data-init-edit]`).click();
        }
        await page.waitForSelector(`${CARD} [data-init-editform]`, { timeout: 15_000 });
        await page.waitForTimeout(250);
        return await page.evaluate(() => {
          const form = document.querySelector('[data-init-card="init_release"] [data-init-editform]');
          const title = form.querySelector('input[type="text"]');
          const desc = form.querySelector(".as-note-box");
          const box = (el) => {
            const cs = getComputedStyle(el);
            const r = el.getBoundingClientRect();
            return {
              h: Math.round(r.height * 10) / 10,
              w: Math.round(r.width),
              flexBasis: cs.flexBasis,
              flex: cs.flex,
              lineHeight: parseFloat(cs.lineHeight) || 0,
              rows: el.getAttribute("rows"),
              scrolls: el.scrollHeight > el.clientHeight + 1,
              formDirection: getComputedStyle(form).flexDirection,
            };
          };
          return { pane: document.getElementById("as-initiatives").clientWidth, rowH: parseFloat(getComputedStyle(form).getPropertyValue("--tab-row-h")) || 0, title: box(title), desc: box(desc) };
        });
      };
      const forms = [];
      for (const vp of [{ width: 1440, height: 900 }, { width: 900, height: 900 }, { width: 480, height: 900 }]) {
        const m = await measureForm(vp);
        forms.push({ vp: vp.width, ...m });
        ok(
          `the form is a COLUMN at ${vp.width} (so a flex-basis here is a height)`,
          m.title.formDirection === "column",
          `${m.pane}px pane, flex-direction ${m.title.formDirection}`,
        );
        ok(
          `the title is ONE control row at ${vp.width}, not a box with room in it`,
          m.rowH > 0 && Math.abs(m.title.h - m.rowH) <= 1 && m.title.h <= 40,
          `${m.title.h}px tall against the tab's ${m.rowH}px row, ${m.title.w}px wide`,
        );
        ok(
          `the description has the room at ${vp.width}`,
          m.desc.h >= 90 && m.desc.h >= m.title.h * 3,
          `description ${m.desc.h}px against the title's ${m.title.h}px (rows=${m.desc.rows})`,
        );
        ok(
          `the title's flex-basis is no longer the 250px that became its height at ${vp.width}`,
          m.title.flexBasis !== "250px",
          `flex ${m.title.flex}, flex-basis ${m.title.flexBasis}`,
        );
      }
      // The INVERSION itself, in one number per width: title/description must be flatter, not taller.
      for (const f of forms) ok(`the inversion is gone at ${f.vp}: the box holding the paragraph is the taller one`, f.desc.h > f.title.h, `${f.desc.h}px of description against ${f.title.h}px of title`);

      // Back to a comfortable width, and out of the form.
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.waitForTimeout(300);
      await page.click(`${CARD} [data-init-cancel="edit"]`);
      await page.waitForSelector(`${CARD} [data-init-editform]`, { state: "detached", timeout: 10_000 });

      // ---- 2. THE EMPTY STATE SAYS WHAT BELONGS ---------------------------------------------------------------
      const emptyText = (await page.locator(`${CARD} [data-init-notes-empty]`).textContent()).replace(/\s+/g, " ").trim();
      ok("the empty state is drawn on a card with no notes", (await page.locator(`${CARD} [data-init-notes-empty]`).count()) === 1);
      for (const word of ["ticket", "pull request", "decision", "version"]) {
        ok(`the empty state names a ${word}`, emptyText.toLowerCase().includes(word), emptyText.slice(0, 90) + "...");
      }
      eq("the count starts at zero", (await page.locator(`${CARD} [data-init-notes-count]`).textContent()).trim(), "0");
      ok("the section is ABOVE the Assistants fold", await page.evaluate(() => {
        const sec = document.querySelector('[data-init-card="init_release"] [data-init-notes]');
        const assist = document.querySelector('[data-init-card="init_release"] [data-init-assist-section]');
        return Boolean(sec && assist) && Boolean(sec.compareDocumentPosition(assist) & Node.DOCUMENT_POSITION_FOLLOWING);
      }));
      await page.evaluate(() => document.querySelector('[data-init-card="init_release"] [data-init-notes]').scrollIntoView({ block: "start" }));
      await page.screenshot({ path: shotPath("notes-empty-1440") });

      // ---- 3. A NOTE, WRITTEN IN THE TAB, IS IN THE STORE ------------------------------------------------------
      const PROSE = "Decided to hold the Okta flip until the verify pack is signed.";
      await page.fill(`${CARD} [data-init-noteform="init_release"] textarea`, PROSE);
      await page.click(`${CARD} .init-notewrite [data-init-notesave]`);
      await page.waitForFunction(() => document.querySelectorAll('[data-init-card="init_release"] [data-init-note]').length === 1, null, { timeout: 20_000 });
      const proseRow = await page.evaluate(() => {
        const row = document.querySelector('[data-init-card="init_release"] [data-init-note]');
        return { by: row.dataset.initNoteBy, kind: row.dataset.initNoteKind, text: row.querySelector(".init-note-text")?.textContent, cls: row.className };
      });
      eq("the written note is drawn as the reader's own prose", [proseRow.by, proseRow.kind, proseRow.text], ["reader", "note", PROSE]);
      eq("the count follows the read", (await page.locator(`${CARD} [data-init-notes-count]`).textContent()).trim(), "1");
      const stored1 = notesInStore("init_release");
      ok("the store holds the note the tab wrote", stored1.length === 1 && stored1[0].text === PROSE && stored1[0].by === "reader" && Boolean(stored1[0].at), `${stored1.length} note(s) in ${path.basename(storeFile)}`);
      ok("a reader's note carries no assistant styling", !proseRow.cls.includes("is-assistant"), proseRow.cls);
      eq("the empty state has given way to the list", await page.locator(`${CARD} [data-init-notes-empty]`).count(), 0);

      // ---- 4. A PASTED URL IS A CHIP, WITH THE STORE'S OWN HOST -------------------------------------------------
      await page.fill(`${CARD} [data-init-noteform="init_release"] textarea`, JIRA);
      await page.fill(`${CARD} [data-init-noteform="init_release"] input[data-init-notefield="label"]`, "DMR-39015 the release ticket");
      await page.click(`${CARD} .init-notewrite [data-init-notesave]`);
      await page.waitForFunction(() => document.querySelectorAll('[data-init-card="init_release"] [data-init-note]').length === 2, null, { timeout: 20_000 });
      await page.fill(`${CARD} [data-init-noteform="init_release"] textarea`, GITHUB);
      await page.fill(`${CARD} [data-init-noteform="init_release"] input[data-init-notefield="label"]`, "");
      await page.click(`${CARD} .init-notewrite [data-init-notesave]`);
      await page.waitForFunction(() => document.querySelectorAll('[data-init-card="init_release"] [data-init-note]').length === 3, null, { timeout: 20_000 });
      const chips = await page.evaluate(() =>
        [...document.querySelectorAll('[data-init-card="init_release"] .init-note-chip')].map((a) => ({
          href: a.getAttribute("href"),
          host: a.querySelector(".init-note-host")?.textContent.trim(),
          label: a.querySelector(".init-note-label")?.textContent.trim(),
          target: a.getAttribute("target"),
          rel: a.getAttribute("rel"),
          cls: a.className,
        })),
      );
      const jiraChip = chips.find((c) => c.href === JIRA);
      const githubChip = chips.find((c) => c.href === GITHUB);
      ok("a jira url is a chip whose host reads Jira", Boolean(jiraChip) && jiraChip.host === "Jira" && jiraChip.cls.includes("is-jira"), JSON.stringify(jiraChip));
      eq("the jira chip carries the label the reader gave it", jiraChip?.label, "DMR-39015 the release ticket");
      ok("a github url is a chip whose host reads GitHub", Boolean(githubChip) && githubChip.host === "GitHub" && githubChip.cls.includes("is-github"), JSON.stringify(githubChip));
      ok("a chip with no label still names what it points at", Boolean(githubChip?.label) && githubChip.label.length > 0, githubChip?.label);
      ok(
        "both chips open in a new tab, without handing the panel's window over",
        chips.length === 2 && chips.every((c) => c.target === "_blank" && c.rel === "noopener noreferrer"),
        chips.map((c) => `${c.host}:${c.target}/${c.rel}`).join(" "),
      );
      const stored2 = notesInStore("init_release");
      const jiraStored = stored2.find((n) => n.kind === "link" && n.url === JIRA);
      ok("the store recorded the host at write time, not the page", jiraStored?.host === "jira" && jiraStored?.label === "DMR-39015 the release ticket", JSON.stringify({ kind: jiraStored?.kind, host: jiraStored?.host, label: jiraStored?.label }));
      await page.evaluate(() => document.querySelector('[data-init-card="init_release"] [data-init-notes]').scrollIntoView({ block: "start" }));
      await page.screenshot({ path: shotPath("notes-chips-1440") });

      // ---- 5. AN EDIT KEEPS THE AUTHOR AND STAMPS THE EDITOR ---------------------------------------------------
      const proseId = (await page.evaluate(() => document.querySelector('[data-init-card="init_release"] [data-init-note-by="reader"][data-init-note-kind="note"]')?.dataset.initNote)) || "";
      ok("the prose row is found by its id", Boolean(proseId), proseId);
      const EDITED = "Decided to hold the Okta flip until the verify pack is signed, and to name the DBA in the PR.";
      await page.click(`${CARD} [data-init-noteedit="init_release|${proseId}"]`);
      await page.waitForSelector(`${CARD} [data-init-noteform="init_release|${proseId}"] textarea`, { timeout: 10_000 });
      eq("the edit form holds the note's own words", await page.inputValue(`${CARD} [data-init-noteform="init_release|${proseId}"] textarea`), PROSE);
      await page.fill(`${CARD} [data-init-noteform="init_release|${proseId}"] textarea`, EDITED);
      await page.click(`${CARD} [data-init-noteform="init_release|${proseId}"] [data-init-noteeditsave]`);
      await page.waitForFunction(
        (want) => {
          const row = document.querySelector('[data-init-card="init_release"] [data-init-note-by="reader"][data-init-note-kind="note"]');
          return row && !row.querySelector("[data-init-noteform]") && row.querySelector(".init-note-text")?.textContent === want;
        },
        EDITED,
        { timeout: 20_000 },
      );
      const afterEdit = await page.evaluate(() => {
        const row = document.querySelector('[data-init-card="init_release"] [data-init-note-by="reader"][data-init-note-kind="note"]');
        return { text: row.querySelector(".init-note-text")?.textContent, by: row.dataset.initNoteBy, stamp: row.querySelector(".init-note-edited")?.textContent || "" };
      });
      eq("the edited words are on the row, and it is still the reader's note", [afterEdit.text, afterEdit.by], [EDITED, "reader"]);
      ok("the row says it was edited, and when", /edited .* ago/.test(afterEdit.stamp), afterEdit.stamp);
      const storedEdit = notesInStore("init_release").find((n) => n.id === proseId);
      ok(
        "the store kept the author and stamped the editor",
        storedEdit?.text === EDITED && storedEdit?.by === "reader" && Boolean(storedEdit?.editedAt) && storedEdit?.editedBy === "reader",
        JSON.stringify({ by: storedEdit?.by, editedAt: Boolean(storedEdit?.editedAt), editedBy: storedEdit?.editedBy }),
      );

      // ---- 6. A NOTE AN ASSISTANT LOGGED IS ATTRIBUTED AND DRAWN DIFFERENTLY ------------------------------------
      const assistRes = await fetch(`${panel.base}/api/initiatives/notes/add`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "init_release", text: "1.174.0 is the version this first ships in", by: "assistant-2" }),
      });
      const assistBody = await assistRes.json();
      ok("the assistant's write is accepted by the route an assistant's turn uses", assistRes.status === 201 && assistBody.note?.by === "assistant-2", `HTTP ${assistRes.status}, by ${assistBody.note?.by}`);
      await page.click("#as-initiatives [data-init-refresh]");
      await page.waitForFunction(() => document.querySelectorAll('[data-init-card="init_release"] [data-init-note]').length === 4, null, { timeout: 25_000 });
      const attributed = await page.evaluate(() => {
        const mine = document.querySelector('[data-init-card="init_release"] [data-init-note-by="reader"]');
        const theirs = document.querySelector('[data-init-card="init_release"] [data-init-note-by="assistant-2"]');
        const rule = (el) => getComputedStyle(el).borderLeftColor;
        return theirs
          ? {
              cls: theirs.className,
              head: theirs.querySelector(".init-note-by")?.textContent.replace(/\s+/g, " ").trim(),
              text: theirs.querySelector(".init-note-text")?.textContent,
              mineCls: mine?.className || "",
              mineRule: mine ? rule(mine) : "",
              theirRule: rule(theirs),
            }
          : null;
      });
      ok("the assistant's note is drawn as an assistant's", Boolean(attributed) && attributed.cls.includes("is-assistant"), attributed?.cls);
      ok("it names the assistant that logged it", Boolean(attributed) && attributed.head.includes(assistantName("assistant-2")), `${attributed?.head} (${assistantName("assistant-2")})`);
      ok("and it reads differently from the reader's own row, in class and in its rule", Boolean(attributed) && !attributed.mineCls.includes("is-assistant") && attributed.theirRule !== attributed.mineRule, `${attributed?.mineRule} vs ${attributed?.theirRule}`);
      ok("the assistant's own words are on the row", attributed?.text === "1.174.0 is the version this first ships in", attributed?.text);
      eq("the count counts both writers", (await page.locator(`${CARD} [data-init-notes-count]`).textContent()).trim(), "4");

      // ---- 7. A DUPLICATE URL IS ONE ROW ------------------------------------------------------------------------
      await page.fill(`${CARD} [data-init-noteform="init_release"] textarea`, JIRA);
      await page.fill(`${CARD} [data-init-noteform="init_release"] input[data-init-notefield="label"]`, "");
      await page.click(`${CARD} .init-notewrite [data-init-notesave]`);
      await page
        .waitForFunction(
          () => /already on this initiative/i.test(document.querySelector('[data-init-card="init_release"] .init-note-status')?.textContent || ""),
          null,
          { timeout: 20_000 },
        )
        .catch(() => {});
      const dupStatus = (await page.locator(`${CARD} .init-note-status`).textContent().catch(() => "")).replace(/\s+/g, " ").trim();
      eq("the count did not move for a duplicate url", (await page.locator(`${CARD} [data-init-notes-count]`).textContent()).trim(), "4");
      ok("and the tab says the url is already there", /already on this initiative/i.test(dupStatus), dupStatus);
      eq("the store holds one row for that url", notesInStore("init_release").filter((n) => n.kind === "link" && String(n.url).startsWith(JIRA)).length, 1);

      // ---- 8. A DELETE ASKS ONCE --------------------------------------------------------------------------------
      const ghId = await page.evaluate(
        () => [...document.querySelectorAll('[data-init-card="init_release"] [data-init-note]')].find((n) => n.querySelector(".init-note-chip")?.getAttribute("href") === "https://github.com/JLRoper/agent-worktree-gui/pull/806")?.dataset.initNote,
      );
      ok("the github row is found by its id", Boolean(ghId), ghId);
      await page.click(`${CARD} [data-init-notedel="init_release|${ghId}"]`);
      eq("the first press only asks", (await page.locator(`${CARD} [data-init-notedel="init_release|${ghId}"]`).textContent()).trim(), "Delete for good?");
      eq("and nothing was deleted yet", notesInStore("init_release").length, 4);
      await page.click(`${CARD} [data-init-notedel="init_release|${ghId}"]`);
      await page.waitForFunction(() => document.querySelectorAll('[data-init-card="init_release"] [data-init-note]').length === 3, null, { timeout: 20_000 });
      eq("the second press removes the row", (await page.locator(`${CARD} [data-init-notes-count]`).textContent()).trim(), "3");
      ok("the store no longer holds it", !notesInStore("init_release").some((n) => n.id === ghId), `${notesInStore("init_release").length} note(s) left`);

      // ---- 8b. TWO SAVES, TWO FORMS: THE WRITE BOX APPENDS WHILE AN EDIT IS OPEN ---------------------------------
      // The two Save buttons live in one card, so they cannot share an attribute: a shared one let the write box's
      // press save the edit, and the note the reader had typed never went out.
      await page.click(`${CARD} [data-init-noteedit="init_release|${proseId}"]`);
      await page.waitForSelector(`${CARD} [data-init-noteform="init_release|${proseId}"] textarea`, { timeout: 10_000 });
      await page.fill(`${CARD} [data-init-noteform="init_release"] textarea`, "A second note written while an edit is open.");
      await page.click(`${CARD} .init-notewrite [data-init-notesave]`);
      await page.waitForFunction(() => document.querySelectorAll('[data-init-card="init_release"] [data-init-note]').length === 4, null, { timeout: 20_000 });
      eq("the write box appends, and the open edit is left alone", await page.locator(`${CARD} [data-init-noteform="init_release|${proseId}"]`).count(), 1);
      eq("the appended note is the newest line", (await page.locator(`${CARD} [data-init-note] .init-note-text`).first().textContent()).trim(), "A second note written while an edit is open.");
      await page.click(`${CARD} [data-init-noteform="init_release|${proseId}"] [data-init-notecancel]`);
      await page.waitForSelector(`${CARD} [data-init-noteform="init_release|${proseId}"]`, { state: "detached", timeout: 10_000 });

      // ---- 9. THE TWO FOLDS STILL FOLD, WITH EVERYTHING UNDER THEM ----------------------------------------------
      const folds = async (attr) => {
        const before = await page.locator(`${CARD} [${attr}]`).getAttribute("aria-expanded");
        await page.click(`${CARD} [${attr}]`);
        await page.waitForTimeout(450);
        const after = await page.locator(`${CARD} [${attr}]`).getAttribute("aria-expanded");
        await page.click(`${CARD} [${attr}]`);
        await page.waitForTimeout(450);
        const back = await page.locator(`${CARD} [${attr}]`).getAttribute("aria-expanded");
        return { before, after, back };
      };
      const assistFold = await folds("data-init-assist-fold");
      eq("the Assistants fold opens and closes", assistFold, { before: "false", after: "true", back: "false" });
      const histFold = await folds("data-init-history-fold");
      eq("the History fold opens and closes", histFold, { before: "false", after: "true", back: "false" });
      eq("the Assistants head counts the two assistants the read carries", (await page.locator(`${CARD} [data-init-assist-count]`).textContent()).trim(), "2");
      eq("the History head counts the six changes the read carries", (await page.locator(`${CARD} [data-init-hist-count]`).textContent()).trim(), "6");
      ok(
        "each fold's head says what it holds, in a sentence",
        /who has worked/i.test(await page.locator(`${CARD} [data-init-assist-section] .init-foldmeta`).textContent()) &&
          /newest first/i.test(await page.locator(`${CARD} [data-init-hist-section] .init-foldmeta`).textContent()),
      );
      // The assistant rows, with the ask-prefill each one carries.
      await page.click(`${CARD} [data-init-assist-fold]`);
      await page.waitForSelector(`${CARD} [data-init-assistant-row]`, { timeout: 15_000 });
      const rows = await page.evaluate(() =>
        [...document.querySelectorAll('[data-init-card="init_release"] [data-init-assistant-row]')].map((row) => {
          const btn = row.querySelector("[data-init-assistant]");
          return {
            id: row.dataset.initAssistantRow,
            who: btn?.textContent.trim(),
            thread: btn?.dataset.initThread || "",
            title: btn?.dataset.initTitle || "",
            chips: [...row.querySelectorAll(".init-counts .chip")].map((c) => c.textContent.trim()),
            tasks: row.querySelector("[data-init-task-count]")?.textContent.trim(),
          };
        }),
      );
      ok("both assistant rows are drawn, newest first", rows.length === 2 && rows.every((r) => r.who), rows.map((r) => r.who).join(", "));
      ok(
        "every assistant row keeps its ask-prefill: the thread, the card's own title, and the caret that follows",
        rows.every((r) => r.thread && r.title === "Quarter-end release readiness"),
        JSON.stringify(rows.map((r) => ({ thread: r.thread, title: r.title }))),
      );
      ok("every assistant row keeps its four count chips", rows.every((r) => r.chips.length === 4), JSON.stringify(rows.map((r) => r.chips)));
      ok("every assistant row keeps its own task count", rows.every((r) => Number(r.tasks) >= 1), JSON.stringify(rows.map((r) => r.tasks)));
      // One assistant's tasks fold, opening onto its cards.
      const taskFold = await page.locator(`${CARD} [data-init-task-fold]`).first().getAttribute("aria-expanded");
      await page.locator(`${CARD} [data-init-task-fold]`).first().click();
      await page.waitForTimeout(700);
      const taskOpen = await page.locator(`${CARD} [data-init-task-fold]`).first().getAttribute("aria-expanded");
      const taskCards = await page.locator(`${CARD} [data-init-task-card]`).count();
      eq("an assistant's tasks fold opens", [taskFold, taskOpen], ["false", "true"]);
      ok("and its task cards are drawn inside it", taskCards >= 1, `${taskCards} card(s)`);
      // The history entries, with actor and time.
      await page.click(`${CARD} [data-init-history-fold]`);
      await page.waitForSelector(`${CARD} [data-init-hist-row]`, { timeout: 15_000 });
      const hist = await page.evaluate(() =>
        [...document.querySelectorAll('[data-init-card="init_release"] [data-init-hist-row]')].map((r) => ({
          actor: r.dataset.initHistActor,
          at: r.dataset.initHistRow,
          who: r.querySelector(".init-hist-who")?.textContent.trim(),
          what: r.querySelector(".init-hist-what")?.textContent.replace(/\s+/g, " ").trim(),
          when: r.querySelector(".init-hist-when")?.textContent.trim(),
          dot: Boolean(r.querySelector(".init-hist-dot")),
        })),
      );
      ok("every history entry keeps its actor and its time", hist.length === 6 && hist.every((h) => h.actor && h.at && h.when), `${hist.length} rows, first ${hist[0]?.who}`);
      ok("every history entry still reads as a sentence from the module", hist.every((h) => h.what && h.what.length > 8), hist[0]?.what);
      await page.evaluate(() => document.querySelector('[data-init-card="init_release"] [data-init-notes]').scrollIntoView({ block: "start" }));
      await page.screenshot({ path: shotPath("notes-and-folds-1440") });

      // ---- 10. NO SIDEWAYS OVERFLOW, AND HEALTH ---------------------------------------------------------------
      const overflow = await page.evaluate(() => {
        const pane = document.getElementById("as-initiatives");
        const sec = document.querySelector('[data-init-card="init_release"] [data-init-notes]');
        return { pane: [pane.scrollWidth, pane.clientWidth], section: [sec.scrollWidth, sec.clientWidth], doc: [document.documentElement.scrollWidth, document.documentElement.clientWidth] };
      });
      ok("the notes section adds no sideways overflow at 1440", overflow.section[0] <= overflow.section[1] + 1, JSON.stringify(overflow.section));
      ok("the pane adds none at 1440", overflow.pane[0] <= overflow.pane[1] + 1, JSON.stringify(overflow.pane));
      ok("the document adds none at 1440", overflow.doc[0] <= overflow.doc[1] + 1, JSON.stringify(overflow.doc));

      // The narrow dock: the same section, measured again, and a shot of it.
      await page.setViewportSize({ width: 480, height: 900 });
      await page.waitForTimeout(600);
      await page.evaluate(() => document.querySelector('[data-init-card="init_release"] [data-init-notes]').scrollIntoView({ block: "start" }));
      await page.waitForTimeout(300);
      const narrow = await page.evaluate(() => {
        const pane = document.getElementById("as-initiatives");
        const sec = document.querySelector('[data-init-card="init_release"] [data-init-notes]');
        const box = sec.querySelector("textarea.init-notebox").getBoundingClientRect();
        return { pane: [pane.scrollWidth, pane.clientWidth], section: [sec.scrollWidth, sec.clientWidth], boxH: Math.round(box.height) };
      });
      ok("the notes section adds no sideways overflow at 480", narrow.section[0] <= narrow.section[1] + 1, JSON.stringify(narrow.section));
      ok("the pane adds none at 480", narrow.pane[0] <= narrow.pane[1] + 1, JSON.stringify(narrow.pane));
      ok("the write box keeps its room at 480", narrow.boxH >= 70, `${narrow.boxH}px`);
      await page.screenshot({ path: shotPath("notes-480") });

      ok("zero page errors and zero console errors", errors.length === 0, errors.slice(0, 3).join(" | "));
      return { forms, chips, rows, hist: hist.length, taskCards, errors };
    },
    { viewport: { width: 1440, height: 900 } },
  );
} finally {
  await panel.stop();
}

clearTimeout(watchdog);
console.log(`\n${failures === 0 ? "OK" : "FAILED"}  ${checks - failures}/${checks} checks passed; shots in ${SHOTS}`);
process.exit(failures === 0 ? 0 : 1);
