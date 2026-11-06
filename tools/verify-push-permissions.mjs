#!/usr/bin/env node
// The push controls, proved on a real page: two four-way selects on every project card — one for a NEW branch, one
// for an EXISTING one — and a Settings → Repo tab with a collapsible section per remote repository.
//
//   PANEL_PLAYWRIGHT_ROOT=<a directory holding node_modules/playwright> node tools/verify-push-permissions.mjs
//
// WHAT WAS WRONG. The panel answered "may a push go through without asking?" with a global three-value select
// (`Remote branches`), a per-project copy of it, and a separate per-project checkbox. Three controls for one question,
// no way to tell which was in force, and no way to say "publish a turnover branch freely, ask about anything else".
//
// WHAT IS DRIVEN, on a sandbox panel and headless Chromium:
//   * the two selects ride the grey remote-mapping row the host chip opens (`.host-form`), each offering exactly the
//     four values, with the server's resolved value selected — and the card's host/remote bar above it carries NONE,
//     so the band they used to sit on is gone;
//   * that row FLEX-WRAPS: it fits at 1400, takes more rows at 520, the controls stay inside the card, and the row
//     never scrolls horizontally — a menu that overflows the card is a menu the reader cannot read;
//   * Settings → Repo is a tab labelled Repo, with a section per remote repository (git.sefl.com/IT, git.sefl.com/SA,
//     github/JLRoper, any other remote, no remote at all), each holding both defaults and a force-override toggle;
//   * turning the force-override on DISABLES that repository's card selects, with a one-line note that names the
//     repository — and leaves another repository's selects editable;
//   * a card select saves through POST /api/settings/push-project, survives a reload, and the old global select and
//     per-project checkbox are nowhere on the page.
//
// RED PROOF. Run it against `git archive origin/main | tar -x` and the first check fails: there is no
// `[data-push-controls]` on main, no `data-settings-tab="repo"`, and the retired `#remote-policy` select is still
// there. `BROWSER-HALF-NOT-RUN` and exit 2 when Playwright is absent, rather than passing a half that never ran.
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadPlaywright, notRun, openSettingsGroup, withBrowser } from "./browser.mjs";
import { configureRepo, git, startPanel } from "./panel-testkit.mjs";

const REPOS = [
  { name: "it-app", url: "git@git.sefl.com:IT/email-multi.git", repo: "git.sefl.com/IT" },
  { name: "sa-app", url: "ssh://git@git.sefl.com/SA/infra.git", repo: "git.sefl.com/SA" },
  { name: "gh-app", url: "git@github.com:JLRoper/agent-worktree-gui.git", repo: "github/JLRoper" },
  { name: "other-app", url: "https://gitlab.com/somebody/else.git", repo: "other" },
  { name: "no-remote", url: "", repo: "none" },
];

let checks = 0;
let failures = 0;
const ok = (name, cond, extra = "") => {
  checks += 1;
  if (cond) console.log(`PASS  ${name}${extra ? `: ${extra}` : ""}`);
  else {
    failures += 1;
    console.log(`FAIL  ${name}${extra ? ` — ${extra}` : ""}`);
  }
};
const same = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} · want ${JSON.stringify(want)}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, { timeoutMs = 20_000, stepMs = 200, what = "condition" } = {}) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    let got = false;
    try {
      got = await fn();
    } catch {
      got = false;
    }
    if (got) return true;
    if (Date.now() > until) {
      console.log(`      (timed out after ${timeoutMs}ms waiting for ${what})`);
      return false;
    }
    await sleep(stepMs);
  }
}

const dir = mkdtempSync(path.join(tmpdir(), "wtgui-push-gate-"));
const repos = path.join(dir, "repos");
mkdirSync(repos, { recursive: true });
const projectPaths = {};
for (const r of REPOS) {
  const repo = path.join(repos, r.name);
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-q", "-b", "main"]);
  configureRepo(repo);
  git(repo, ["commit", "-q", "--allow-empty", "-m", "first"]);
  if (r.url) git(repo, ["remote", "add", "origin", r.url]);
  projectPaths[r.name] = repo.replace(/\\/g, "/");
}
const config = {
  scanRoots: [repos.replace(/\\/g, "/")],
  // The URL is named here as well as on disk, so the repository section is right on the FIRST paint instead of after
  // discovery's probe. That is also what a config-only project needs.
  projects: REPOS.map((r) => ({ name: r.name, path: projectPaths[r.name], mainBranch: "main", ...(r.url ? { remote: "origin", remoteUrl: r.url } : {}) })),
  assistant: { enabled: false },
  worktreeSeconds: 4,
  midSeconds: 4,
  dormantSeconds: 4,
  slowSeconds: 4,
};

const playwright = loadPlaywright({ env: process.env });
if (!playwright) {
  console.log(notRun("push permissions", "no Playwright install (set PANEL_PLAYWRIGHT_ROOT)"));
  process.exit(2);
}

const panel = await startPanel({ dir, keep: true, config });
let exitCode = 0;
try {
  await withBrowser(
    async ({ page, pageErrors }) => {
      const shotsAt = process.argv.includes("--shots") ? process.argv[process.argv.indexOf("--shots") + 1] : "";
      const shot = async (name) => {
        if (!shotsAt) return;
        mkdirSync(shotsAt, { recursive: true });
        await page.screenshot({ path: path.join(shotsAt, `${name}.png`), fullPage: false });
      };

      await page.setViewportSize({ width: 1400, height: 900 });
      await page.goto(`${panel.base}/`, { waitUntil: "domcontentloaded", timeout: 40_000 });
      await page.waitForSelector("section.project", { timeout: 40_000 });
      // The board draws projects collapsed, and the chip bar (with its selects) is only laid out in the open card.
      // Expanding through the page's own state is what the reader's click does, without racing a re-render.
      const expandAll = () =>
        page.evaluate(() => {
          for (const sec of document.querySelectorAll("section.project[data-project]")) {
            if (sec.dataset.project) state.expandedProjects.add(sec.dataset.project);
          }
          renderAll();
        });
      await page.waitForFunction(() => document.querySelectorAll("section.project[data-project]").length >= 5, null, { timeout: 40_000 });
      await expandAll();
      await page.waitForFunction(
        () => [...document.querySelectorAll("section.project[data-project]")].every((s) => !s.classList.contains("collapsed")),
        null,
        { timeout: 20_000 },
      );
      await sleep(500);

      // The two selects ride the grey remote-mapping row, which the host chip draws one project at a time: the page
      // keeps ONE editor open (`state.hostPanel`), so a card is read by opening its row first. The propose call reads
      // the project's own remote, so the row is read once it carries a proposal (or the reason there is none).
      const openRow = async (name) => {
        const open = await page.evaluate((n) => Boolean(document.querySelector(`[data-host-form="${CSS.escape(n)}"]`)), name);
        if (!open) await page.click(`section.project[data-project="${name}"] .btn-host`);
        await page.waitForFunction(
          (n) => {
            const f = document.querySelector(`[data-host-form="${CSS.escape(n)}"]`);
            return Boolean(f && f.querySelector("[data-push-controls]") && /proposed from|no proposal/.test(f.querySelector("[data-host-line]")?.textContent || ""));
          },
          name,
          { timeout: 20_000 },
        );
        await sleep(150);
      };

      // One card's mapping row. `inRow` is the placement claim (the selects' own ancestor is the row) and `onBar` the
      // retired one (the host/remote bar above it), so a select that drifted back up there fails the gate.
      const readCard = (name) =>
        page.evaluate((n) => {
          const sec = document.querySelector(`section.project[data-project="${CSS.escape(n)}"]`);
          const form = sec ? sec.querySelector("[data-host-form]") : null;
          const controls = form ? form.querySelector("[data-push-controls]") : null;
          const selects = controls ? [...controls.querySelectorAll("select")] : [];
          const meta = sec ? sec.querySelector(".project-head.meta-line") : null;
          const f = form ? form.getBoundingClientRect() : null;
          const cb = controls ? controls.getBoundingClientRect() : null;
          return {
            project: n,
            inRow: Boolean(controls && form.contains(controls)),
            onBar: Boolean(meta && meta.querySelector("[data-push-controls]")),
            selectCount: selects.length,
            kinds: selects.map((s) => s.dataset.pushKind),
            values: selects.map((s) => s.value),
            options: selects.map((s) => [...s.options].map((o) => o.value)),
            disabled: selects.map((s) => s.disabled),
            note: controls?.querySelector(".push-repo-note")?.textContent || "",
            rowWrap: form ? getComputedStyle(form).flexWrap : "",
            row: f ? { scrollWidth: form.scrollWidth, clientWidth: form.clientWidth, height: Math.round(f.height), right: f.right, left: f.left } : null,
            controlsBox: cb ? { left: cb.left, right: cb.right, top: Math.round(cb.top) } : null,
          };
        }, name);

      const cards = [];
      for (const r of REPOS) {
        await openRow(r.name);
        cards.push(await readCard(r.name));
      }
      same("one card per project is drawn", cards.map((r) => r.project).sort(), REPOS.map((r) => r.name).sort());
      ok("the two selects are inside the grey remote-mapping row on every card", cards.every((r) => r.inRow), cards.map((r) => `${r.project}:${r.inRow}`).join(" "));
      ok("and NONE is left on the card's host/remote bar — the separate band is gone", cards.every((r) => r.onBar === false), cards.map((r) => `${r.project}:${r.onBar}`).join(" "));
      ok("every card carries exactly two push selects", cards.every((r) => r.selectCount === 2), cards.map((r) => `${r.project}:${r.selectCount}`).join(" "));
      same("the two selects are NEW and EXISTING", [...new Set(cards.flatMap((r) => r.kinds))], ["new", "existing"]);
      same(
        "each select offers the four values, in one order",
        [...new Set(cards.flatMap((r) => r.options.map((o) => o.join(","))))],
        ["allow-all,allow-name-gate,always-ask,never"],
      );
      ok("the shipped answer is always-ask on both controls", cards.every((r) => r.values.every((v) => v === "always-ask")), cards.map((r) => r.values.join("/")).join(" "));
      ok("the mapping row is a wrapping flex row", cards.every((r) => r.rowWrap === "wrap"), cards.map((r) => `${r.project}:${r.rowWrap}`).join(" "));
      ok("and no card's row scrolls sideways at 1400", cards.every((r) => r.row.scrollWidth - r.row.clientWidth <= 1), cards.map((r) => `${r.project}:${r.row.scrollWidth}/${r.row.clientWidth}`).join(" "));
      ok("both selects are editable while no force-override is on", cards.every((r) => r.disabled.every((d) => d === false)));
      ok("and no card carries the disabled note", cards.every((r) => r.note === ""));
      await shot("cards-wide");

      // ---- the row at a narrow width: more rows, still inside the card --------------------------------
      await openRow("gh-app");
      const wideRow = await readCard("gh-app");
      await page.setViewportSize({ width: 520, height: 900 });
      await sleep(400);
      const narrowRow = await readCard("gh-app");
      ok("at 520 the row grows taller — the controls take more rows", narrowRow.row.height > wideRow.row.height, `${wideRow.row.height} -> ${narrowRow.row.height}`);
      ok("no row overflows the viewport at 520", narrowRow.row.scrollWidth - narrowRow.row.clientWidth <= 1, `${narrowRow.row.scrollWidth}/${narrowRow.row.clientWidth}`);
      ok(
        "every control stays inside the card",
        narrowRow.controlsBox.left >= narrowRow.row.left - 1 && narrowRow.controlsBox.right <= narrowRow.row.right + 1,
        `${Math.round(narrowRow.controlsBox.left)}..${Math.round(narrowRow.controlsBox.right)} in ${Math.round(narrowRow.row.left)}..${Math.round(narrowRow.row.right)}`,
      );
      await shot("cards-narrow");

      // ---- a high zoom is the same test by another name (the layout sees fewer CSS pixels) --------------
      await page.setViewportSize({ width: 1400, height: 900 });
      await page.evaluate(() => {
        document.documentElement.style.zoom = "1.6";
      });
      await sleep(400);
      const zoomedRow = await readCard("gh-app");
      ok("at 160% zoom no row overflows either", zoomedRow.row.scrollWidth - zoomedRow.row.clientWidth <= 1, `${zoomedRow.row.scrollWidth}/${zoomedRow.row.clientWidth}`);
      ok(
        "at 160% zoom every control is still inside its card",
        zoomedRow.controlsBox.right <= zoomedRow.row.right + 1 && zoomedRow.controlsBox.left >= zoomedRow.row.left - 1,
        `${Math.round(zoomedRow.controlsBox.left)}..${Math.round(zoomedRow.controlsBox.right)} in ${Math.round(zoomedRow.row.left)}..${Math.round(zoomedRow.row.right)}`,
      );
      await page.evaluate(() => {
        document.documentElement.style.zoom = "";
      });
      await sleep(300);

      // ---- Settings → Repo ---------------------------------------------------------------------------
      const tab = await page.evaluate(() => {
        const t = document.querySelector('[data-settings-tab="repo"]');
        return t ? { label: t.querySelector(".settings-tab-label")?.textContent || "", controls: t.getAttribute("aria-controls") } : null;
      });
      same("there is a Repo tab, and it is labelled Repo", tab && tab.label, "Repo");
      ok("the Repo tab owns the repo panel", tab?.controls === "settings-panel-repo", JSON.stringify(tab));
      await openSettingsGroup(page, "repo");
      await page.waitForSelector("#settings-panel-repo details[data-push-repo-section]", { timeout: 15_000 });
      const sections = await page.evaluate(() =>
        [...document.querySelectorAll("#settings-panel-repo details[data-push-repo-section]")].map((d) => ({
          key: d.dataset.pushRepoSection,
          label: d.querySelector(".settings-repo-name")?.textContent || "",
          projects: d.querySelector(".settings-repo-count")?.textContent || "",
          selects: [...d.querySelectorAll("[data-push-repo-kind]")].map((s) => s.dataset.pushRepoKind),
          force: d.querySelector("[data-push-force]")?.checked === true,
          summary: d.querySelector("summary") ? true : false,
        })),
      );
      same("a collapsible section per remote repository", sections.map((s) => s.key), ["git.sefl.com/IT", "git.sefl.com/SA", "github/JLRoper", "other", "none"]);
      ok("each section is a <details> with a summary", sections.every((s) => s.summary));
      same("each section holds both defaults", [...new Set(sections.map((s) => s.selects.join(",")))], ["new,existing"]);
      ok("the sections name the projects they govern", sections.every((s) => /\d+ project/.test(s.projects)), sections.map((s) => `${s.key}:${s.projects}`).join(" "));
      ok("no section has a force-override on yet", sections.every((s) => s.force === false));
      const none = await page.evaluate(() => {
        const d = document.querySelector('[data-push-repo-section="none"]');
        return { label: d?.querySelector(".settings-repo-name")?.textContent || "", text: d?.querySelector(".settings-repo-list")?.textContent || "" };
      });
      ok("the no-remote section is explicit: it is LABELLED and names the project with no remote", none.label === "no remote at all" && /no-remote/.test(none.text), `${none.label}: ${none.text}`);
      await shot("settings-repo");

      // ---- force-override: the card's selects become disabled and say why -------------------------------
      await page.evaluate(() => {
        const d = document.querySelector('details[data-push-repo-section="git.sefl.com/IT"]');
        if (d && !d.open) d.open = true;
      });
      await page.click('[data-push-force="git.sefl.com/IT"]');
      // The drawer covers the right-hand end of every card row, so it is closed before a card is read: the setting is
      // stored server-side, and the card paints from it either way.
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => document.getElementById("settings")?.classList.contains("hidden"), null, { timeout: 10_000 });
      const forcedOk = await waitFor(async () => {
        await openRow("it-app");
        const row = await readCard("it-app");
        return Boolean(row.disabled.length === 2 && row.disabled.every(Boolean) && /repo setting in force/.test(row.note));
      }, { what: "the IT card's selects to disable with a note" });
      ok("force-override disables that repository's card selects AND says why", forcedOk);
      const it = await page.evaluate(() => {
        const c = document.querySelector('[data-host-form="it-app"] [data-push-controls]');
        return { disabled: [...c.querySelectorAll("select")].map((s) => s.disabled), note: c.querySelector(".push-repo-note")?.textContent || "", title: c.querySelector(".push-repo-note")?.getAttribute("title") || "" };
      });
      ok("the note names the repository in its tooltip", /git\.sefl\.com\/IT/.test(it.title || ""), (it.title || "").slice(0, 120));
      await openRow("sa-app");
      const sa = await readCard("sa-app");
      ok("another repository's card selects stay editable", sa.disabled.every((d) => d === false) && sa.note === "", JSON.stringify({ disabled: sa.disabled, note: sa.note }));
      await shot("force-on");

      // ---- a card select saves, and survives a reload --------------------------------------------------
      // The card is behind the Settings drawer; Escape closes it so the select is the thing being pressed.
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => document.getElementById("settings")?.classList.contains("hidden"), null, { timeout: 10_000 });
      const before = await page.evaluate(() => {
        const s = document.querySelector('[data-host-form="sa-app"] select[data-push-kind="existing"]');
        return s ? s.value : "";
      });
      same("the SA card starts on the shipped answer", before, "always-ask");
      await page.selectOption('[data-host-form="sa-app"] select[data-push-kind="existing"]', "allow-name-gate");
      const savedOk = await waitFor(async () => {
        const cfg = await (await fetch(`${panel.base}/api/config`)).json();
        return cfg.pushPermissions?.projects?.["sa-app"]?.existingBranches === "allow-name-gate";
      }, { what: "the card's change to reach config.json" });
      ok("a card select POSTs and the server stores it", savedOk);
      const stored = await page.evaluate(() => {
        const s = document.querySelector('[data-host-form="sa-app"] select[data-push-kind="existing"]');
        return s ? s.value : "";
      });
      same("the select keeps the value the server accepted", stored, "allow-name-gate");
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForSelector("section.project", { timeout: 40_000 });
      await page.waitForFunction(() => document.querySelectorAll("section.project[data-project]").length >= 5, null, { timeout: 40_000 });
      await expandAll();
      await page.waitForFunction(
        () => [...document.querySelectorAll("section.project[data-project]")].every((s) => !s.classList.contains("collapsed")),
        null,
        { timeout: 20_000 },
      );
      await sleep(500);
      await openRow("sa-app");
      const afterReload = await page.evaluate(() => {
        const s = document.querySelector('[data-host-form="sa-app"] select[data-push-kind="existing"]');
        return s ? s.value : "";
      });
      same("the saved value survives a reload", afterReload, "allow-name-gate");
      // The IT project is still under its force-override after the reload, so its selects render disabled again.
      await openRow("it-app");
      const reloadedIt = await page.evaluate(() => {
        const s = document.querySelector('[data-host-form="it-app"] select[data-push-kind="new"]');
        return s ? s.disabled : null;
      });
      ok("the force-override survives the reload too", reloadedIt === true, String(reloadedIt));
      await shot("after-reload");

      // ---- the retired controls are gone ---------------------------------------------------------------
      const retired = await page.evaluate(() => ({
        policy: Boolean(document.getElementById("remote-policy")),
        switches: document.querySelectorAll("[data-remote-allow]").length,
        oldTab: Boolean(document.querySelector('[data-settings-tab="branches"]')),
      }));
      ok("the old global Remote branches select is not on the page", retired.policy === false);
      ok("the old per-project Allow… checkbox is not on the page", retired.switches === 0);
      ok("and the Branches tab is gone, replaced by Repo", retired.oldTab === false);
      same("no page errors during the run", pageErrors, []);
    },
    { playwright },
  );
} catch (e) {
  failures += 1;
  console.log(`FAIL  the gate threw: ${String((e && e.stack) || e)}`);
} finally {
  await panel.stop();
  if (process.argv.includes("--keep")) console.log(`      (sandbox kept: ${dir})`);
}

console.log(`\n${failures ? "FAIL" : "PASS"}  ${checks - failures}/${checks} checks`);
exitCode = failures ? 1 : 0;
process.exit(exitCode);
