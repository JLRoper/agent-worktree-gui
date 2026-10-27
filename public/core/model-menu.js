// ---- one model picker for the whole page --------------------------------------------------------
// Three fields name a model: the spawn card's model select (#job-model), the assistant's own model
// setting (select[data-as-set="model"]), and a card's model readout. A native <select> can only print
// text, so it can never show what the panel already knows about a row — the price per million tokens in
// and out, the 0-10 Artificial Analysis rating, the context window. This is the one picker all of them
// open, and it reads ONE table (/api/models' providers[].pricing), so no call site carries a second copy
// of the prices or of the row order.
//
// The popup is a PORTAL: appended to <body> rather than to the field, so it paints over the assistant
// float (z-index 90) and the settings panel (120) instead of being clipped by their overflow. It anchors
// under its trigger, flips above it when the window has no room below, and never leaves the viewport.
//
// The native <select> stays in the DOM as the value and the change event. Picking a row sets select.value
// and dispatches a bubbling `change`, so both call sites keep the semantics they had: the spawn form reads
// .value when it posts, and the assistant's delegated [data-as-set] handler sends the setting.
//
// Loaded after core/dom-format.js (esc) and before app.js. fmtTokens comes from app.js and is read at
// paint time only — the same way assistant.js reads esc and conversations at runtime.
(function () {
  "use strict";

  const WIDTH = 430; // id · ★rating · window · in/out on one line
  const MIN_WIDTH = 280;
  const MAX_HEIGHT = 360; // what the list wants when the window has room
  const GAP = 4; // between the trigger and the popup
  const MARGIN = 8; // keep this far inside the window edge

  let pop = null; // the portal, while it is open
  let anchorEl = null; // the trigger it is pinned to
  let rows = []; // every row the open list can show
  let hits = []; // the rows a search leaves, in order
  let sel = 0; // the row Enter takes
  let current = ""; // the value the list opens on, for the ✓
  let onPick = null; // what a pick calls, once the list is gone
  let originSelect = null; // the select the open list belongs to

  // What identifies a model field across a repaint. The assistant rebuilds its settings markup whenever its
  // state changes, which replaces the select under an open list; the new node is the same field, so the list
  // is closed rather than left pointing at a detached control whose `change` would never reach the panel.
  const keyOf = (s) => (s?.dataset?.asSet ? `set:${s.dataset.asSet}` : `id:${s?.id || ""}`);

  // A row's 0-10 rating, whichever benchmark supplied it: the gateway's coding index (a string) or the
  // committed OpenRouter snapshot's Intelligence Index (a number). Never both on one row — the table has
  // one rating field per model — and never a zero for an unrated model.
  function ratingOf(row) {
    if (!row) return null;
    if (typeof row.rating === "number" && Number.isFinite(row.rating)) return row.rating;
    const coding = Number(row.coding);
    return row.coding && Number.isFinite(coding) ? coding : null;
  }

  function ratingText(row) {
    const r = ratingOf(row);
    return r === null ? "" : `★${Number(r.toFixed(1))}`;
  }

  // What the rating means, for the row's tooltip. Naming the benchmark matters: two Artificial Analysis
  // indices are 0-10 and a star with no source behind it could be either.
  function ratingTitle(row) {
    const r = ratingOf(row);
    if (r === null) return "";
    const which = row.ratingSource === "intelligence" ? "Intelligence Index" : "coding index";
    return `Artificial Analysis ${which} ${Number(r.toFixed(1))}/10${row.ratingEstimated ? " (estimated)" : ""}`;
  }

  // The text the native option (and so the closed trigger) carries: what the model costs per million
  // tokens in and out, then its rating. Both model fields build their option text with this, so the
  // board's trigger and the assistant's cannot print different prices for the same row.
  function priceText(row) {
    if (!row) return "";
    const parts = [];
    if (row.variable) parts.push("variable");
    else if (row.input || row.output) parts.push(`${row.input || "?"} in / ${row.output || "?"} out`);
    const star = ratingText(row);
    if (star) parts.push(star);
    return parts.join(" · ");
  }

  // The price COLUMN of the floating list. The star column already carries the rating, so this is the two
  // rates alone — the units are stated once, in the row's tooltip.
  function priceCell(row) {
    if (!row || (!row.input && !row.output)) return "";
    return `${row.input || "?"} / ${row.output || "?"}`;
  }

  // A row's price tooltip: the rates, the average when the table knows it, and the unit stated once.
  // "variable" is a router OpenRouter does not quote, which is not the same as free.
  function priceTitle(row) {
    if (!row) return "";
    if (row.variable) return "variable pricing (router) — OpenRouter does not quote a rate";
    if (!row.input && !row.output) return "";
    const bits = [`input ${row.input || "?"}`, `output ${row.output || "?"}`];
    if (typeof row.average === "number") bits.push(`average ${formatRate(row.average)}`);
    return `${bits.join(" · ")} per 1M tokens`;
  }

  // What a native <option> prints for a row. The default row carries its own label; every other row is its
  // id, then the price and rating the shared table knows. One formatter, so the board's select, the
  // assistant's select and the trigger beside each print the same line.
  function optionText(row) {
    if (!row) return "";
    if (!row.id) return row.name;
    const price = priceText(row);
    return price ? `${row.id} — ${price}` : row.id;
  }

  // A per-million rate as money, for the averages the table carries as numbers. Mirrors lib/model-prices.js's
  // formatRate so a snapshot row and a cache row print the same way.
  function formatRate(n) {
    if (typeof n !== "number" || !Number.isFinite(n)) return "?";
    if (n === 0) return "free";
    if (n >= 1) return `$${n.toFixed(2)}`;
    return `$${String(Number(n.toFixed(5)))}`;
  }

  // The rows, in the provider's own order — the same walk the spawn form's <optgroup> list does, so the
  // floating list and the select beneath it can never disagree about what exists or where it sits.
  function rowsFor(models, { extra = [] } = {}) {
    const d = models || null;
    const def = d?.defaultModel || null;
    const out = [{ id: "", name: def ? `(default: ${def})` : "(gateway default)", group: "" }];
    for (const p of d?.providers || []) {
      for (const m of p.models || []) {
        const entry = p.pricing?.[m] || null;
        const ctx = Number(d?.contexts?.[m]);
        out.push({
          id: String(m),
          name: String(m),
          group: p.label || p.id || "",
          // Everything the one price table says about this row, carried as-is: the rates the trigger and
          // the menu print, and the rating whichever benchmark supplied it.
          input: entry?.input || "",
          output: entry?.output || "",
          coding: entry?.coding || "",
          rating: typeof entry?.rating === "number" ? entry.rating : null,
          ratingSource: entry?.ratingSource || "",
          ratingEstimated: Boolean(entry?.ratingEstimated),
          average: typeof entry?.average === "number" ? entry.average : null,
          variable: Boolean(entry?.variable),
          context: Number.isFinite(ctx) && ctx > 0 ? ctx : null,
        });
      }
    }
    // A value the catalogue no longer lists still has to be visible and checked: without its row the list
    // reads as "nothing is chosen" while a model is in force, which is the one thing this must never say.
    for (const e of extra || []) {
      if (!e) continue;
      const id = String(e.id ?? "");
      if (!id || out.some((r) => r.id === id)) continue;
      out.push({ id, name: e.name || id, group: e.group || "" });
    }
    return out;
  }

  function close() {
    if (pop) pop.remove();
    pop = null;
    rows = [];
    hits = [];
    sel = 0;
    onPick = null;
    originSelect = null;
    if (anchorEl) {
      anchorEl.setAttribute("aria-expanded", "false");
      anchorEl = null;
    }
  }

  function pick(id) {
    const fn = onPick;
    close();
    if (fn) fn(String(id ?? ""));
  }

  // Put the panel under the trigger, clamped to the window. Below when there is a usable list down there,
  // otherwise above it — with the list above the search bar (column-reverse) so the box being typed in stays
  // against the trigger. The popup never floats away from its control; it shrinks instead.
  function position() {
    if (!pop) return false;
    const r = anchorEl.getBoundingClientRect();
    // Gone from the page, or scrolled out of it: there is nothing left to point at.
    if (!anchorEl.isConnected || (r.width === 0 && r.height === 0) || r.bottom < 0 || r.top > window.innerHeight) {
      close();
      return false;
    }
    const width = Math.min(WIDTH, Math.max(MIN_WIDTH, window.innerWidth - 2 * MARGIN));
    pop.style.width = `${width}px`;
    const below = window.innerHeight - r.bottom - GAP - MARGIN;
    const above = r.top - GAP - MARGIN;
    const flip = below < Math.min(MAX_HEIGHT, 180) && above > below;
    pop.classList.toggle("is-flipped", flip);
    pop.style.left = `${Math.max(MARGIN, Math.min(window.innerWidth - width - MARGIN, r.left))}px`;
    if (flip) {
      pop.style.top = "auto";
      pop.style.bottom = `${window.innerHeight - r.top + GAP}px`;
      pop.style.maxHeight = `${Math.max(140, Math.min(MAX_HEIGHT, above))}px`;
    } else {
      pop.style.bottom = "auto";
      pop.style.top = `${r.bottom + GAP}px`;
      pop.style.maxHeight = `${Math.max(140, Math.min(MAX_HEIGHT, below))}px`;
    }
    return true;
  }

  function move(step) {
    const items = [...pop.querySelectorAll(".model-item")];
    if (!items.length) return;
    items[sel]?.classList.remove("is-sel");
    sel = (sel + step + items.length) % items.length;
    items[sel].classList.add("is-sel");
    items[sel].scrollIntoView({ block: "nearest" });
  }

  // Paint the list for a search box's current text. Headers are emitted when the group changes, so a filtered
  // list keeps the same shape as the full one.
  function paint(query) {
    if (!pop) return;
    const q = String(query || "").trim().toLowerCase();
    hits = rows.filter(
      (r) =>
        !q ||
        r.name.toLowerCase().includes(q) ||
        r.id.toLowerCase().includes(q) ||
        String(r.group || "").toLowerCase().includes(q),
    );
    sel = 0;
    const list = pop.querySelector(".model-list");
    if (!hits.length) {
      list.innerHTML = `<div class="model-none dimmer">no model matches “${esc(query)}”</div>`;
      return;
    }
    let group = null;
    list.innerHTML = hits
      .map((r, i) => {
        const head = r.group && r.group !== group ? `<div class="model-group dimmer">${esc(r.group)}</div>` : "";
        group = r.group || group;
        const on = r.id === current;
        const star = ratingOf(r) !== null
          ? `<span class="model-rating" title="${esc(ratingTitle(r))}">${esc(ratingText(r))}</span>`
          : "";
        const win = r.context
          ? `<span class="model-ctx-n" title="context window ${esc(fmtTokens(r.context))} tokens">${esc(fmtTokens(r.context))}</span>`
          : "";
        const cash = priceCell(r)
          ? `<span class="model-price${r.variable ? " is-variable" : ""}" title="${esc(priceTitle(r))}">${esc(priceCell(r))}</span>`
          : "";
        const tick = on ? '<span class="model-check">✓</span>' : "";
        return (
          `${head}<button type="button" role="option" aria-selected="${on ? "true" : "false"}" class="model-item${i === 0 ? " is-sel" : ""}${on ? " is-current" : ""}" data-model="${esc(r.id)}">` +
          `<span class="model-name">${esc(r.name)}</span>${star}${win}${cash}${tick}</button>`
        );
      })
      .join("");
  }

  function open(trigger, { rows: list = [], value = "", placeholder = "", onPick: fn = null, select = null } = {}) {
    close();
    if (!trigger) return null;
    anchorEl = trigger;
    originSelect = select;
    rows = list;
    current = String(value || "");
    onPick = fn;
    pop = document.createElement("div");
    pop.className = "model-pop model-pop-shared";
    pop.setAttribute("role", "listbox");
    pop.innerHTML =
      `<input class="model-search mono" type="text" data-1p-ignore autocomplete="off" spellcheck="false" placeholder="${esc(placeholder || `search ${Math.max(0, rows.length - 1)} models…`)}" />` +
      `<div class="model-list mono"></div>`;
    // The portal: last child of body, above every panel on the page.
    document.body.appendChild(pop);
    trigger.setAttribute("aria-expanded", "true");
    position();
    paint("");
    const search = pop.querySelector(".model-search");
    const listEl = pop.querySelector(".model-list");
    search.addEventListener("input", () => paint(search.value));
    search.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") {
        ev.preventDefault();
        ev.stopPropagation();
        const back = anchorEl;
        close();
        back?.focus?.();
      } else if (ev.key === "Enter") {
        ev.preventDefault();
        const items = [...listEl.querySelectorAll(".model-item")];
        const hit = items[sel] || items[0];
        if (hit) pick(hit.dataset.model);
      } else if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
        ev.preventDefault();
        move(ev.key === "ArrowDown" ? 1 : -1);
      }
    });
    listEl.addEventListener("click", (ev) => {
      const b = ev.target.closest(".model-item");
      if (b) pick(b.dataset.model);
    });
    search.focus();
    return pop;
  }

  // Mirror the select onto its trigger: the text the native control would print, and the tooltip that explains
  // it (the spawn form's says how old the list and the prices are; the assistant's says what the model is for).
  function sync(select) {
    const btn = select?._modelTrigger;
    if (!btn) return;
    btn.disabled = Boolean(select.disabled);
    btn.title = select.title || "";
    const opt = select.options[select.selectedIndex] || null;
    btn.textContent = (opt && opt.textContent) || "(no model)";
    btn.classList.toggle("is-default", !select.value);
  }

  // Attach the picker to a native select: the select keeps the value and fires the change, the button beside it
  // paints and opens the list. Idempotent — a caller that repaints its markup can call it again on the new node.
  function attach(select, { models = null, extra = null, placeholder = "" } = {}) {
    if (!select) return null;
    // A repaint replaced the field the open list is anchored to: close it, so a pick can never land on the
    // detached copy of the select. The board re-attaches the SAME element, which leaves an open list alone.
    if (pop && originSelect && originSelect !== select && keyOf(originSelect) === keyOf(select)) close();
    let btn = select._modelTrigger;
    if (!btn || !btn.isConnected) {
      btn = document.createElement("button");
      btn.type = "button";
      btn.className = "model-trigger mono";
      btn.setAttribute("aria-haspopup", "listbox");
      btn.setAttribute("aria-expanded", "false");
      // Hidden, not removed: it is still the value the form reads and the control whose `change` the panel
      // listens for. Only what it paints is replaced.
      select.classList.add("model-native");
      select.setAttribute("aria-hidden", "true");
      select.tabIndex = -1;
      select.after(btn);
      select._modelTrigger = btn;
      btn.addEventListener("click", (ev) => {
        // The button can sit inside a <label> (the settings rows are labels); a label forwards a click to its
        // control, and a hidden select has nothing to open.
        ev.preventDefault();
        ev.stopPropagation();
        if (select.disabled) return;
        const live = typeof models === "function" ? models() : models;
        open(btn, {
          rows: rowsFor(live, { extra: typeof extra === "function" ? extra(select.value) : extra || [] }),
          value: select.value,
          placeholder,
          select,
          onPick: (id) => {
            // A model the catalogue no longer lists has no option to select, so give it one rather than
            // dropping the choice on the floor.
            if (![...select.options].some((o) => o.value === id)) {
              const o = document.createElement("option");
              o.value = id;
              o.textContent = id;
              select.append(o);
            }
            select.value = id;
            sync(select);
            select.dispatchEvent(new Event("change", { bubbles: true }));
          },
        });
      });
      // ArrowDown opens the list the way a native select does.
      btn.addEventListener("keydown", (ev) => {
        if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
          ev.preventDefault();
          btn.click();
        }
      });
      select.addEventListener("change", () => sync(select));
    }
    sync(select);
    return btn;
  }

  // One press anywhere else, or Escape, closes the list. Capture, so a handler on the control being pressed
  // cannot keep the press from dismissing it.
  document.addEventListener(
    "mousedown",
    (e) => {
      if (!pop || pop.contains(e.target) || e.target.closest?.(".model-trigger")) return;
      close();
    },
    true,
  );
  document.addEventListener(
    "keydown",
    (e) => {
      if (!pop || e.key !== "Escape") return;
      e.preventDefault();
      // Give the keyboard back to the control the list came from: closing under the caret and leaving focus on
      // the body is how a reader loses their place in a panel they were tabbing through.
      const back = anchorEl;
      close();
      back?.focus?.();
    },
    true,
  );
  // The trigger can move under the list (a repaint, a window resize, a scroll of the panel it lives in); the
  // list follows it, and closes once the trigger has left the page.
  window.addEventListener("resize", () => position());
  window.addEventListener(
    "scroll",
    (e) => {
      if (!pop || pop.contains(e.target)) return;
      position();
    },
    true,
  );

  window.ModelMenu = { attach, close, open, rowsFor, optionText, priceText, priceCell, priceTitle, ratingText, ratingTitle, ratingOf, sync };
})();
