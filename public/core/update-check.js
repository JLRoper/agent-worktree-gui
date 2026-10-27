// core/update-check.js — the build this tab is running, and the moment it stops being the build
// the panel is serving.
//
// The shell (index.html) carries the version it was served with in a meta tag, and every asset URL
// it loads carries the same version (lib/build-version.js). So the page knows exactly which build
// it is running, and GET /api/build says which build the panel is serving now. When the two part
// company — the panel restarted, or public/ was edited under a running panel — this module decides
// what to do: nothing (mode off), offer a reload (mode prompt, the default) or take it (mode auto).
//
// TWO HARD GUARDS, whatever the mode: a reload is never taken while the reader has text that the
// server does not have (a reply, a question answer, the spawn prompt, a queued reply) and never
// while a turn is still writing into a console. Either one HOLDS the chip — it appears, says why,
// and acts when the page goes idle.
//
// The decision itself is pure (`reloadDecision`, exported on globalThis.wtUpdateCheck) so
// test/update-check.test.js can drive every combination without a browser; everything below the
// export is the page half, and it is skipped when there is no document (the node import).
(function (root) {
  "use strict";

  const MODES = ["off", "prompt", "auto"];
  const DEFAULT_MODE = "prompt";

  function normaliseMode(mode) {
    return MODES.includes(mode) ? mode : DEFAULT_MODE;
  }

  // What to do about a build that is not the one this page loaded. `drafting` and `streaming` win
  // over every mode: a prompt is not shown as actionable and an auto reload waits, so nothing the
  // reader cannot get back is ever thrown away by the panel.
  function reloadDecision({ versionChanged = false, drafting = false, streaming = false, mode = DEFAULT_MODE } = {}) {
    const m = normaliseMode(mode);
    if (!versionChanged) return { action: "none", hold: false, reason: "current" };
    if (m === "off") return { action: "none", hold: false, reason: "off" };
    if (streaming) return { action: "hold", hold: true, reason: "streaming" };
    if (drafting) return { action: "hold", hold: true, reason: "drafting" };
    if (m === "auto") return { action: "reload", hold: false, reason: "auto" };
    return { action: "prompt", hold: false, reason: "prompt" };
  }

  root.wtUpdateCheck = { MODES, DEFAULT_MODE, normaliseMode, reloadDecision };

  if (typeof document === "undefined") return; // node:test imports the function only

  const MODE_KEY = "wtgui.updateCheck";
  const POLL_MS = 30_000;
  const WATCH_MS = 2_000;

  let loaded = ""; // the version this tab loaded with
  let served = null; // the last /api/build answer
  let pollTimer = 0;
  let watchTimer = 0;
  let checking = false;
  let forced = false; // a manual check offers the update even when the setting is off

  function short(v) {
    return v ? String(v).slice(0, 12) : "unknown";
  }

  function readMode() {
    try {
      return normaliseMode(localStorage.getItem(MODE_KEY));
    } catch {
      return DEFAULT_MODE;
    }
  }

  function writeMode(mode) {
    try {
      localStorage.setItem(MODE_KEY, normaliseMode(mode));
    } catch {
      /* private mode: the choice still holds for this page */
    }
  }

  // The build the shell was served with. The meta is authoritative; an asset URL carrying ?v= is
  // the fallback for a shell from a panel that predates the meta.
  function metaVersion() {
    const meta = document.querySelector('meta[name="panel-build"]');
    if (meta && meta.getAttribute("content")) return meta.getAttribute("content");
    const tagged = document.querySelector('script[src*="?v="]');
    const m = tagged && /[?&]v=([^&#]+)/.exec(tagged.getAttribute("src") || "");
    return m ? m[1] : "";
  }

  // Is there text in this page that a reload would destroy? Deliberately explicit rather than a
  // scan of every input: the assistant's notes and charter boxes, the provider URL and a filter
  // box all hold saved text, and treating those as drafts would hold the chip forever.
  function drafting() {
    try {
      if (typeof state !== "undefined" && state) {
        for (const v of Object.values(state.replyDrafts || {})) if (String(v || "").trim()) return true;
        if (state.replyQueue && state.replyQueue.size) return true; // replies waiting for their turn
        if (state.replyEdit && String(state.replyEdit.text || "").trim()) return true;
        if (state.addAgent && String(state.addAgent.value || "").trim()) return true;
      }
      if (typeof questionDrafts !== "undefined" && questionDrafts && questionDrafts.size) {
        for (const v of questionDrafts.values()) if (String(v || "").trim()) return true;
      }
      const hosts = document.querySelectorAll(
        '.reply-box[data-reply], textarea.tq-other, textarea.as-draft, #job-prompt, #as-first-text'
      );
      for (const el of hosts) {
        if (el.disabled || el.readOnly) continue;
        const text = el.tagName === "TEXTAREA" ? el.value : el.textContent;
        if (String(text || "").trim()) return true;
      }
    } catch {
      // Not knowing is not a reason to reload: say nothing and treat it as a draft.
      return true;
    }
    return false;
  }

  // Is a turn still writing? A live job is the panel's own record of one — the same predicate the
  // cards use — and it covers the assistant's thread too, which is a job like any other.
  function streaming() {
    try {
      if (typeof state === "undefined" || !state || !state.jobs) return false;
      for (const job of state.jobs.values()) {
        if (typeof turnLive === "function" ? turnLive(job) : job && job.status === "running") return true;
      }
      return false;
    } catch {
      return true;
    }
  }

  function say(msg, bad = false) {
    try {
      if (bad && typeof showBanner === "function") return showBanner(msg);
      if (!bad && typeof showNote === "function") return showNote(msg);
    } catch {
      /* fall through to the settings preview */
    }
    const preview = document.getElementById("update-preview");
    if (preview) preview.textContent = msg;
  }

  function paintVersionRow() {
    const row = document.getElementById("build-version");
    if (row) row.textContent = short(loaded);
    const preview = document.getElementById("update-preview");
    if (!preview) return;
    const bits = [];
    bits.push(loaded ? `this tab is running ${short(loaded)}` : "this tab did not carry a build version");
    if (served) {
      bits.push(served.version === loaded ? "the panel serves the same build" : `the panel now serves ${short(served.version)}`);
      if (served.bootedAt) bits.push(`booted ${new Date(served.bootedAt).toLocaleTimeString()}`);
      bits.push(`${Object.keys(served.files || {}).length} file(s) hashed`);
    }
    preview.textContent = bits.join(" · ");
  }

  function chip() {
    let el = document.getElementById("update-chip");
    if (el) return el;
    el = document.createElement("div");
    el.id = "update-chip";
    el.className = "update-chip hidden";
    el.setAttribute("role", "status");
    el.setAttribute("aria-live", "polite");
    el.innerHTML = '<span class="uc-text"></span><button type="button" class="uc-reload">Reload</button>';
    el.querySelector(".uc-reload").addEventListener("click", () => reloadOnto());
    document.body.appendChild(el);
    return el;
  }

  function paint(decision) {
    const el = chip();
    const why = decision.reason === "streaming" ? "a turn is still streaming" : "you have an unsent draft";
    el.querySelector(".uc-text").textContent = decision.hold
      ? `a newer panel build is ready (${short(loaded)} → ${short(served && served.version)}) — reload held: ${why}`
      : `a newer panel build is ready (${short(loaded)} → ${short(served && served.version)})`;
    const btn = el.querySelector(".uc-reload");
    btn.disabled = Boolean(decision.hold);
    btn.title = decision.hold ? `reload this tab once ${why} is gone` : "reload this tab onto the new build";
    el.classList.remove("hidden");
  }

  function hideChip() {
    const el = document.getElementById("update-chip");
    if (el) el.classList.add("hidden");
    stopWatch();
  }

  // While the chip is up, look again every couple of seconds: a draft can be sent and a turn can
  // end without any poll of /api/build, and in auto mode the reload is owed the moment the page
  // goes idle.
  function startWatch() {
    if (watchTimer) return;
    watchTimer = setInterval(evaluate, WATCH_MS);
  }

  function stopWatch() {
    if (!watchTimer) return;
    clearInterval(watchTimer);
    watchTimer = 0;
  }

  function effectiveMode() {
    const mode = readMode();
    return forced && mode === "off" ? "prompt" : mode;
  }

  function evaluate() {
    if (!served) return;
    const changed = Boolean(loaded) && served.version !== loaded;
    const decision = reloadDecision({
      versionChanged: changed,
      drafting: drafting(),
      streaming: streaming(),
      mode: effectiveMode(),
    });
    if (decision.action === "none") return hideChip();
    if (decision.action === "reload") return reloadOnto();
    paint(decision);
    startWatch();
  }

  // The one place a reload happens, and it asks again: the button may have been enabled when the
  // page was idle and the reader can type between the paint and the click.
  function reloadOnto() {
    const decision = reloadDecision({
      versionChanged: Boolean(served) && served.version !== loaded,
      drafting: drafting(),
      streaming: streaming(),
      mode: effectiveMode(),
    });
    if (decision.hold) {
      paint(decision);
      startWatch();
      return;
    }
    if (decision.action === "none") return hideChip();
    location.reload();
  }

  async function check({ manual = false } = {}) {
    if (checking) return null;
    checking = true;
    try {
      // The page's own transport: the deadline, the token and the 403 sentence are the same facts
      // every other call uses. A read needs no token, so this changes nothing about the guard.
      const r = await apiFetch("/api/build", { cache: "no-store" }, { timeoutMs: 8000 });
      if (!r.ok) throw new Error(`the panel answered ${r.status}`);
      const d = await r.json();
      if (!d || !d.version) throw new Error("the answer carried no build version");
      served = d;
      if (!loaded) loaded = metaVersion() || d.version;
      paintVersionRow();
      if (manual) {
        forced = true;
        if (d.version === loaded) say(`up to date — this tab is running ${short(loaded)}, the build the panel is serving`);
      }
      evaluate();
      return d;
    } catch (e) {
      if (manual) say(`could not check for a new build: ${String((e && e.message) || e)}`, true);
      return null;
    } finally {
      checking = false;
    }
  }

  function schedulePoll() {
    clearInterval(pollTimer);
    pollTimer = 0;
    if (readMode() === "off") return;
    pollTimer = setInterval(() => void check(), POLL_MS);
    void check();
  }

  function init() {
    loaded = metaVersion();
    paintVersionRow();
    const select = document.getElementById("update-mode");
    if (select) {
      select.value = readMode();
      select.addEventListener("change", () => {
        writeMode(select.value);
        forced = false;
        paintVersionRow();
        if (select.value === "off") {
          clearInterval(pollTimer);
          pollTimer = 0;
          hideChip();
          return;
        }
        schedulePoll();
      });
    }
    const button = document.getElementById("btn-check-update");
    if (button) {
      button.addEventListener("click", async () => {
        const label = button.textContent;
        button.disabled = true;
        button.textContent = "checking…";
        await check({ manual: true });
        button.textContent = label;
        button.disabled = false;
      });
    }
    // A laptop that was closed, or a tab that was in the background, checks the moment it is looked
    // at again instead of waiting out the rest of the interval.
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && readMode() !== "off") void check();
    });
    window.addEventListener("online", () => {
      if (readMode() !== "off") void check();
    });
    schedulePoll();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})(typeof globalThis !== "undefined" ? globalThis : this);
