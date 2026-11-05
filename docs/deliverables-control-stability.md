# The DELIVERABLES control: a stable button, and a page that cannot be silently dead

Measured on the live panel at `127.0.0.1:7331` (headless Chromium, 1440 px wide) on 2026-11-05, then fixed and
re-measured on a sandbox panel booted by `tools/panel-testkit.mjs`. The popup itself was never the problem — it opens,
lists 200 rows and closes — so nothing in this change touches its data path.

## 1. The button was a moving target

`#btn-deliver`'s left edge, sampled once a second on the live page:

| when | x | what the status line said |
| --- | --- | --- |
| ticks 1-5 | 654.25 | `pool 5/5 · 34 conversations · 4 running · 97 events · 7.4/s` |
| tick 6 | 660.84 | `… · 111 events · 7.8/s` |
| first paint, before the pool clause arrived | 588.28 | `34 conversations · 4 running · 33 events · 11.5/s` |

The cause is `#stream-rate`: `public/app.js` rewrites it from a 1 s interval, and its text grows with the numbers in it
(`97 events` → `111 events` is one mono character, 6.59 px). `.controls` was content-sized and left-packed, so every
character added to that line pushed every button after it — 6.59 px for a digit, 72.56 px the first time the whole
`pool 5/5 · ` clause appeared. A `MutationObserver` on the line showed the text mutation and the button's move in the
same tick, with `#stream-state` unchanged: the rate line is the only repainting element in the header.

The gate that existed at the time (`tools/verify-deliverables-ui.mjs`) worked around it: it waited for the header to
"settle" before opening the popover, because a popover positioned from the old box was left behind its anchor. That
workaround is why the defect survived a green gate.

**The fix is a layout contract, not a wider box.** `.controls` now fills the header's free width and packs its buttons
to the right edge; `#stream-rate` takes the row's free space and ellipsizes when there is none. The line's length is
therefore not a layout input for anything after it, whatever it says and however wide the window is:

```css
.controls { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; flex: 1 1 auto; min-width: 0; justify-content: flex-end; }
#stream-rate { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: right; font-variant-numeric: tabular-nums; }
```

After: `x = 1082.25` held across four clock ticks, and identical for a short line (`12 events · 1.2/s`) and a long one
(`pool 5/5 · 34 conversations · 4 running · 12345 events · 11.5/s`). The whole line is also in the element's `title`,
so an ellipsized header still answers on hover.

## 2. The badge was a dead 0x0 span

Before: the markup shipped `<span id="deliver-badge" hidden>0</span>` inside the button and the page only toggled
`hidden`. The pill measured `0x0` at `(0,0)` with `display:none`, and its `"0"` stayed in the button's `textContent` —
anything that reads the node (a copy, a test, a DOM dump) read `DELIVERABLES0`. A hidden zero is still a zero.

After: the markup carries no badge at all. `paintDeliverBadge()` creates the pill when rows sit above the reader's
watermark and **removes** it when the count is zero, so:

| state | node | geometry | button text |
| --- | --- | --- | --- |
| nothing unseen | absent | — | `DELIVERABLES` |
| one unseen row | present | `17 × 17`, inside the button's box | `DELIVERABLES` + a green `1` |

The badge keeps its real job — a press on the number writes the same seen-watermark the open writes, without opening
the list — and that press is now delegated from the button, because the node it lands on exists only while the count
does.

## 3. The stale page: a click that did nothing

**Hypothesis.** The shell (`index.html`) is served no-store, but every asset URL it renders carries the build version
(`lib/build-version.js`). A tab opened while `app.js` was being written — the live panel measured `app.js` mtime
09:02:57 and a boot at 09:03:24 — gets the new shell and the *old* `app.js` under the URL the shell was rendered with,
and a browser holding that URL keeps the old bytes. If the old `app.js` predates the DELIVERABLES block, the header
carries the button and nothing is wired to it: the click does nothing, logs nothing, shows nothing.

**Reproduced.** `tools/verify-deliverables-stale.mjs` loads the real panel's shell with the build version the tab was
loaded with (the commit before `#btn-deliver`), and fulfils the `app.js` request with that same build's file. On the
tree before this change the click was silent: no console line, no visible change, `aria-expanded` still `false` —
5 of 12 checks passed.

**What the fix does.** `index.html` carries a small inline guard, and inline is the point: it must be the one piece of
code that is never stale, because a `core/*.js` guard would be cached at the same old version as the `app.js` it is
meant to catch. At click time it asks whether this build's `app.js` wired the button (`data-wired`, set by `app.js`).
When it did not, it:

* logs `[panel] DELIVERABLES is dead on this page: it was loaded from build <loaded> …` and, after `GET /api/build`,
  `[panel] stale page: loaded build <loaded>, the panel serves <served> — reload to pick up the new app.js.`
* appends a visible `role="alert"` bar naming both builds, with a **Reload** button (`#stale-build-bar`,
  `#stale-build-reload`).
* `app.js` reports through the same channel if the popover throws while opening — the old-page-against-new-API shape.

**Its limit, said plainly.** A tab loaded *before this build existed* has no guard in its shell, and nothing served
afterwards can reach into it; only a reload can. What the guard guarantees is that from this build on, the
mid-edit/cached-asset window cannot produce a silent dead button: every shell rendered from here carries the check.
On a healthy page the guard never fires (the stale gate asserts the real build wires the button, opens the list, and
shows no bar).

## 4. The gates

| gate | what it pins | red on the old tree | green now |
| --- | --- | --- | --- |
| `npm run verify:deliverables-stable` | zero movement across ≥ 4 clock ticks and across a short/long status line; no badge node at zero; real pill geometry when unseen | 9/15 | 15/15 |
| `npm run verify:deliverables-stale` | a click on a stale page names both builds, offers the reload, and does not pretend to open; the healthy page is untouched | 5/12 | 12/12 |
| `npm run verify:deliverables-ui` | the popover, its rows, the watermark and the badge's real job (unchanged scope) | — | unchanged |

Both new gates boot a throwaway panel (`tools/panel-testkit.mjs`) and drive headless Chromium; without a Playwright
install they exit 2 with `BROWSER-HALF-NOT-RUN`, like the other `verify-*.mjs` harnesses.
