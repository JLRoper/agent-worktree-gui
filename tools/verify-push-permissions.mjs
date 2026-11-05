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
//   * every project card's grey host/remote bar carries TWO selects, each offering exactly the four values, with the
//     server's resolved value selected;
//   * the bar FLEX-WRAPS: at 1400 it is one row, at 520 it is more rows, the controls stay inside the card, and the
//     bar never scrolls horizontally — a menu that overflows the card is a menu the reader cannot read;
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
      await expandAll();
      await page.waitForSelector("[data-push-controls]", { state: "visible", timeout: 20_000 });
      await sleep(600);

      const read = () =>
        page.evaluate(() => {
          const out = [];
          for (const meta of document.querySelectorAll("section.project .project-head.meta-line")) {
            const sec = meta.closest("section.project");
            const controls = meta.querySelector("[data-push-controls]");
            const selects = controls ? [...controls.querySelectorAll("select")] : [];
            const host = meta.querySelector(".btn-host");
            const box = meta.getBoundingClientRect();
            const cb = controls ? controls.getBoundingClientRect() : null;
            out.push({
              project: sec ? sec.dataset.project : "",
              selectCount: selects.length,
              kinds: selects.map((s) => s.dataset.pushKind),
              values: selects.map((s) => s.value),
              options: selects.map((s) => [...s.options].map((o) => o.value)),
              disabled: selects.map((s) => s.disabled),
              note: controls?.querySelector(".push-repo-note")?.textContent || "",
              flexWrap: getComputedStyle(meta).flexWrap,
              meta: { scrollWidth: meta.scrollWidth, clientWidth: meta.clientWidth, height: Math.round(box.height), right: box.right, left: box.left },
              hostTop: host ? Math.round(host.getBoundingClientRect().top) : null,
              controlsTop: cb ? Math.round(cb.top) : null,
              controlsRight: cb ? cb.right : null,
              controlsLeft: cb ? cb.left : null,
            });
          }
          return out;
        });

      const wide = await read();
      same("one card per project is drawn", wide.map((r) => r.project).sort(), REPOS.map((r) => r.name).sort());
      ok("every card carries exactly two push selects", wide.every((r) => r.selectCount === 2), wide.map((r) => `${r.project}:${r.selectCount}`).join(" "));
      same("the two selects are NEW and EXISTING", [...new Set(wide.flatMap((r) => r.kinds))], ["new", "existing"]);
      same(
        "each select offers the four values, in one order",
        [...new Set(wide.flatMap((r) => r.options.map((o) => o.join(","))))],
        ["allow-all,allow-name-gate,always-ask,never"],
      );
      ok("the shipped answer is always-ask on both controls", wide.every((r) => r.values.every((v) => v === "always-ask")), wide.map((r) => r.values.join("/")).join(" "));
      ok("every card's bar is a wrapping flex row", wide.every((r) => r.flexWrap === "wrap"), wide.map((r) => `${r.project}:${r.flexWrap}`).join(" "));
      ok("and no card's bar scrolls sideways at 1400", wide.every((r) => r.meta.scrollWidth - r.meta.clientWidth <= 1), wide.map((r) => `${r.project}:${r.meta.scrollWidth}/${r.meta.clientWidth}`).join(" "));
      ok("both selects are editable while no force-override is on", wide.every((r) => r.disabled.every((d) => d === false)));
      ok("and no card carries the disabled note", wide.every((r) => r.note === ""));
      await shot("cards-wide");

      // ---- the bar at a narrow width: more rows, still inside the card --------------------------------
      await page.setViewportSize({ width: 520, height: 900 });
      await sleep(400);
      const narrow = await read();
      const wrapped = narrow.filter((n) => {
        const w = wide.find((x) => x.project === n.project);
        return w && n.meta.height > w.meta.height;
      });
      ok("at 520 the bars grow taller — the controls drop to another line", wrapped.length >= narrow.length - 1, `${wrapped.length}/${narrow.length} grew`);
      ok("no bar overflows the viewport at 520", narrow.every((r) => r.meta.scrollWidth - r.meta.clientWidth <= 1), narrow.map((r) => `${r.project}:${r.meta.scrollWidth}/${r.meta.clientWidth}`).join(" "));
      ok(
        "every control stays inside the card",
        narrow.every((r) => r.controlsLeft >= r.meta.left - 1 && r.controlsRight <= r.meta.right + 1),
        narrow.map((r) => `${r.project}:${Math.round(r.controlsLeft)}..${Math.round(r.controlsRight)} in ${Math.round(r.meta.left)}..${Math.round(r.meta.right)}`).join(" "),
      );
      await shot("cards-narrow");

      // ---- a high zoom is the same test by another name (the layout sees fewer CSS pixels) --------------
      await page.setViewportSize({ width: 1400, height: 900 });
      await page.evaluate(() => {
        document.documentElement.style.zoom = "1.6";
      });
      await sleep(400);
      const zoomed = await read();
      ok("at 160% zoom no bar overflows either", zoomed.every((r) => r.meta.scrollWidth - r.meta.clientWidth <= 1), zoomed.map((r) => `${r.project}:${r.meta.scrollWidth}/${r.meta.clientWidth}`).join(" "));
      ok("at 160% zoom every control is still inside its card", zoomed.every((r) => r.controlsRight <= r.meta.right + 1 && r.controlsLeft >= r.meta.left - 1));
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
      const forcedOk = await waitFor(async () => {
        const rows = await page.evaluate(() =>
          [...document.querySelectorAll("[data-push-controls]")].map((el) => ({
            project: el.dataset.pushControls,
            disabled: [...el.querySelectorAll("select")].map((s) => s.disabled),
            note: el.querySelector(".push-repo-note")?.textContent || "",
          })),
        );
        const it = rows.find((r) => r.project === "it-app");
        return Boolean(it && it.disabled.every(Boolean) && /repo setting in force/.test(it.note));
      }, { what: "the IT card's selects to disable with a note" });
      ok("force-override disables that repository's card selects AND says why", forcedOk);
      const afterForce = await page.evaluate(() =>
        [...document.querySelectorAll("[data-push-controls]")].map((el) => ({
          project: el.dataset.pushControls,
          disabled: [...el.querySelectorAll("select")].map((s) => s.disabled),
          note: el.querySelector(".push-repo-note")?.textContent || "",
          title: el.querySelector(".push-repo-note")?.getAttribute("title") || "",
        })),
      );
      const it = afterForce.find((r) => r.project === "it-app");
      const sa = afterForce.find((r) => r.project === "sa-app");
      ok("the note names the repository in its tooltip", /git\.sefl\.com\/IT/.test(it?.title || ""), (it?.title || "").slice(0, 120));
      ok("another repository's card selects stay editable", sa && sa.disabled.every((d) => d === false) && sa.note === "", JSON.stringify(sa));
      await shot("force-on");

      // ---- a card select saves, and survives a reload --------------------------------------------------
      // The card is behind the Settings drawer; Escape closes it so the select is the thing being pressed.
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => document.getElementById("settings")?.classList.contains("hidden"), null, { timeout: 10_000 });
      const before = await page.evaluate(() => {
        const s = document.querySelector('[data-push-controls="sa-app"] select[data-push-kind="existing"]');
        return s ? s.value : "";
      });
      same("the SA card starts on the shipped answer", before, "always-ask");
      await page.selectOption('[data-push-controls="sa-app"] select[data-push-kind="existing"]', "allow-name-gate");
      const savedOk = await waitFor(async () => {
        const cfg = await (await fetch(`${panel.base}/api/config`)).json();
        return cfg.pushPermissions?.projects?.["sa-app"]?.existingBranches === "allow-name-gate";
      }, { what: "the card's change to reach config.json" });
      ok("a card select POSTs and the server stores it", savedOk);
      const stored = await page.evaluate(() => {
        const s = document.querySelector('[data-push-controls="sa-app"] select[data-push-kind="existing"]');
        return s ? s.value : "";
      });
      same("the select keeps the value the server accepted", stored, "allow-name-gate");
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForSelector("section.project", { timeout: 40_000 });
      await expandAll();
      await page.waitForSelector("[data-push-controls]", { state: "visible", timeout: 20_000 });
      await sleep(400);
      const afterReload = await page.evaluate(() => {
        const s = document.querySelector('[data-push-controls="sa-app"] select[data-push-kind="existing"]');
        return s ? s.value : "";
      });
      same("the saved value survives a reload", afterReload, "allow-name-gate");
      // The IT project is still under its force-override after the reload, so its selects render disabled again.
      const reloadedIt = await page.evaluate(() => {
        const s = document.querySelector('[data-push-controls="it-app"] select[data-push-kind="new"]');
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
