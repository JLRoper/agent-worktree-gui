// core/transport.js — every HTTP call the page makes to its own server, and the panel token.
//
// Extracted from public/app.js as M3 in .agentboard/refactor-research/frontend-app-js.md (§2, §5 step 3),
// moved line for line: lines 190-253 and 9337-9353 of public/app.js at ae528c7. Nothing renamed, nothing
// rewritten, no call site touched.
//
// WHAT MOVED: PANEL_TOKEN_KEY, the panelToken IIFE that reads ?token= once and then drops it from the address
// bar, apiFetch (the deadline wrapper and the single place the token is attached), resync and post.
//
// One deliberate departure from the plan's line table, noted here because the plan's count says 96: its range
// for this module runs to 9372 and so swallows two click listeners at 9355 and 9369 (`btn-refresh`,
// `btn-collapse-all`) that are the wiring hub's, not the transport's. They stay in app.js; only the four
// transport units move, which is 81 lines.
//
// LOADED AS A CLASSIC SCRIPT, BEFORE app.js (see index.html). `resync` and `post` are function declarations,
// so they are page globals exactly as they were. The panelToken IIFE runs at load, one step earlier in the same
// tick than it used to; it reads location and localStorage and writes nothing, so there is no ordering to keep.
//
// WHAT IT STILL REACHES OUT FOR (by name, at call time): $ (core/dom-format.js), setStream (core/sse.js),
// showBanner and applySnapshot (M5), headTitle, saveProjectHues and updateColorsRow (M9). The plan records it
// as "not a leaf" for exactly those reasons; the two it must not lose are the abort message ("the panel server
// did not answer within Ns — it may be restarting") and the 403 sentence, both of which are user-visible text
// that other modules rely on apiFetch to produce.

// The write routes demand x-panel-token whenever the request does NOT come from this machine — loopback
// is the panel's own UI and is never challenged. A browser on another machine authenticates once by
// opening the link with ?token=…: the value is remembered here, dropped from the address bar so a copied
// or shared URL stops carrying it, and every fetch below then sends it. It is kept in localStorage too,
// so a later reload without the query string still works.
const PANEL_TOKEN_KEY = "wtgui.panelToken";
const panelToken = (() => {
  let fromUrl = "";
  try {
    fromUrl = new URLSearchParams(location.search).get("token") || "";
  } catch {
    /* unparsable location: fall back to what is remembered */
  }
  if (fromUrl) {
    try {
      localStorage.setItem(PANEL_TOKEN_KEY, fromUrl);
    } catch {
      /* private mode: this load still carries it in memory */
    }
    try {
      const clean = new URL(location.href);
      clean.searchParams.delete("token");
      history.replaceState(null, "", `${clean.pathname}${clean.search}${clean.hash}`);
    } catch {
      /* tidying the URL is a courtesy, not a requirement */
    }
    return fromUrl;
  }
  try {
    return localStorage.getItem(PANEL_TOKEN_KEY) || "";
  } catch {
    return "";
  }
})();

// Every call to the panel's own server goes through here. A plain fetch has no deadline, so when the
// server is restarting — a gateway bounce refuses or hangs connections for a while — the promise never
// settles: the button stays disabled, no message appears, and the card is indistinguishable from a
// frozen page. A timeout turns that into a sentence on screen.
async function apiFetch(url, opts = {}, { timeoutMs = 20000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  // One wrapper means one place to attach the token: a route added later cannot forget to send it, and
  // the local board (where the header is ignored) behaves exactly as before.
  const headers = new Headers(opts.headers || {});
  if (panelToken) headers.set("x-panel-token", panelToken);
  try {
    const res = await fetch(url, { ...opts, headers, signal: ctrl.signal });
    if (res.status === 403) {
      // Reached from another machine without a usable token. Say so, instead of letting it look like the
      // panel is broken — reads are still allowed, so the board still draws and the action is the only
      // thing that failed.
      showBanner("This browser may only read the board: open the panel once with its ?token=… link to allow changes.");
    }
    return res;
  } catch (e) {
    if (e && e.name === "AbortError") {
      throw new Error(`the panel server did not answer within ${Math.round(timeoutMs / 1000)}s — it may be restarting; try again`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function resync() {
  try {
    const r = await apiFetch("/api/state");
    // The status decides, not the shape of the body. An error answer is `{error}` and carries no
    // projects, so feeding it to applySnapshot painted an empty board with no message — a server fault
    // that looked exactly like "you have no repos", which is the blank page this now says out loud.
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      throw new Error(body.error || `the panel answered ${r.status}`);
    }
    applySnapshot(await r.json());
  } catch (e) {
    showBanner(`Cannot load the board: ${e.message}`);
    setStream("offline", "bad");
  }
}

async function post(route) {
  try {
    await apiFetch(route, { method: "POST" });
    await resync();
  } catch (e) {
    showBanner(`${route}: ${e.message}`);
  }
}

window.WMApp = window.WMApp || {};
window.WMApp.core = window.WMApp.core || {};
// Published for the later steps of the split; nothing reads it yet.
window.WMApp.core.transport = { apiFetch, resync, post };
