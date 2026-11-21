// THE MEASUREMENTS THE INITIATIVES REDESIGN IS JUDGED BY, read out of the painted page.
//
// WHY THIS IS A MODULE. Two things need the same numbers: `tools/capture-initiatives-redesign.mjs` writes them beside
// the screenshots, and `tools/verify-initiatives-redesign.mjs` scores them as a gate. A second copy of "how big is the
// title" would be two definitions of the thing under test, and the one that agrees with the screenshot would win.
//
// EVERY NUMBER IS COMPUTED IN THE PAGE. Font sizes and line heights are computed styles; contrast is the WCAG ratio
// of the text colour over the first opaque stack of ancestor backgrounds (rgba composited, so a chip on a card is
// measured against the card, not against the body); hit targets are painted border boxes; a chip is "clipped" when
// its scrollWidth is larger than its clientWidth, which is what an ellipsis does to a name that does not fit; and a
// long description's line length is the element's width divided by the measured width of one `0`, in the element's
// own font. Nothing here reads the source, and nothing here guesses at a state it did not measure.

const HOST = "#as-initiatives";

const PAGE_FN = `(() => {
  const host = document.querySelector(${JSON.stringify(HOST)});
  if (!host) return { error: "the initiatives pane is not on screen" };
  const one = (sel, root = host) => root.querySelector(sel);
  const all = (sel, root = host) => [...root.querySelectorAll(sel)];
  const style = (node) => getComputedStyle(node);
  const round = (n) => Math.round(Number(n) * 10) / 10;

  // ---- colour and contrast ---------------------------------------------------------------------
  const parse = (value) => {
    const m = String(value || "").match(/rgba?\\(([^)]+)\\)/);
    if (!m) return null;
    const parts = m[1].split(/[,\\s\\/]+/).filter(Boolean).map(Number);
    if (parts.length < 3 || parts.some((n) => !Number.isFinite(n))) return null;
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
  };
  const over = (fg, bg) => ({
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  });
  const luminance = (c) => {
    const ch = (v) => {
      const x = v / 255;
      return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b);
  };
  const ratio = (a, b) => {
    const l1 = luminance(a);
    const l2 = luminance(b);
    return round((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05));
  };
  const pageBg = (() => {
    const body = parse(style(document.body).backgroundColor);
    return body && body.a > 0 ? body : { r: 15, g: 17, b: 21, a: 1 };
  })();
  const backgroundOf = (node) => {
    const layers = [];
    for (let n = node; n; n = n.parentElement) {
      const c = parse(style(n).backgroundColor);
      if (c && c.a > 0) layers.push(c);
    }
    let base = pageBg;
    for (const c of layers.reverse()) base = over(c, base);
    return base;
  };
  const contrastOf = (node) => {
    if (!node) return null;
    const bg = backgroundOf(node);
    const fg = parse(style(node).color);
    if (!fg) return null;
    return ratio(fg.a < 1 ? over(fg, bg) : fg, bg);
  };

  const textOf = (node) => String(node ? node.textContent || "" : "").replace(/\\s+/g, " ").trim().slice(0, 90);
  const typeOf = (sel) => {
    const node = one(sel);
    if (!node) return null;
    const cs = style(node);
    return {
      selector: sel,
      sample: textOf(node),
      fontSize: round(parseFloat(cs.fontSize) || 0),
      lineHeight: round(parseFloat(cs.lineHeight) || 0),
      fontWeight: Number(cs.fontWeight) || 0,
      letterSpacing: cs.letterSpacing,
      color: cs.color,
      contrast: contrastOf(node),
    };
  };

  // ---- the card's own spacing -------------------------------------------------------------------
  const box = (node) => {
    if (!node) return null;
    const cs = style(node);
    const r = node.getBoundingClientRect();
    return {
      width: round(r.width),
      height: round(r.height),
      paddingTop: round(parseFloat(cs.paddingTop) || 0),
      paddingRight: round(parseFloat(cs.paddingRight) || 0),
      paddingBottom: round(parseFloat(cs.paddingBottom) || 0),
      paddingLeft: round(parseFloat(cs.paddingLeft) || 0),
      marginTop: round(parseFloat(cs.marginTop) || 0),
      marginBottom: round(parseFloat(cs.marginBottom) || 0),
      gap: round(parseFloat(cs.rowGap) || 0),
      left: round(r.left),
      right: round(r.right),
      radius: round(parseFloat(cs.borderTopLeftRadius) || 0),
    };
  };

  // ---- hit targets ------------------------------------------------------------------------------
  const target = (sel) => {
    const node = one(sel);
    if (!node) return null;
    const r = node.getBoundingClientRect();
    return { selector: sel, tag: node.tagName.toLowerCase(), width: round(r.width), height: round(r.height), sample: textOf(node) };
  };

  // ---- the aligned left edge ---------------------------------------------------------------------
  const leftOf = (sel) => {
    const node = one(sel);
    if (!node) return null;
    const r = node.getBoundingClientRect();
    return round(r.left);
  };

  // ---- chips ------------------------------------------------------------------------------------
  const chipNodes = all(".init-chips .chip, .init-counts .chip, .init-branch, .init-tree .chip");
  const chips = {
    count: chipNodes.length,
    clipped: chipNodes
      .filter((n) => n.scrollWidth > n.clientWidth + 1)
      .map((n) => ({ text: textOf(n), scrollWidth: n.scrollWidth, clientWidth: n.clientWidth, className: String(n.className || "") })),
    heights: [...new Set(chipNodes.map((n) => round(n.getBoundingClientRect().height)))],
    fontSizes: [...new Set(chipNodes.map((n) => round(parseFloat(style(n).fontSize) || 0)))],
    widest: round(Math.max(0, ...chipNodes.map((n) => n.getBoundingClientRect().width))),
  };

  // ---- line length, in characters of the element's own font ---------------------------------------
  const desc = one(".init-desc");
  let lineLength = null;
  if (desc) {
    const cs = style(desc);
    const canvas = document.createElement("canvas").getContext("2d");
    canvas.font = cs.fontWeight + " " + cs.fontSize + " " + cs.fontFamily;
    const ch = canvas.measureText("0").width || parseFloat(cs.fontSize) * 0.55;
    const width = desc.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
    lineLength = { widthPx: round(width), chPx: round(ch), charsPerLine: Math.round(width / ch) };
  }

  // ---- interaction states, read without moving anything --------------------------------------------
  const stateOf = (sel) => {
    const node = one(sel);
    if (!node) return null;
    const cs = style(node);
    return {
      selector: sel,
      background: cs.backgroundColor,
      color: cs.color,
      transform: cs.transform,
      textDecoration: cs.textDecorationLine,
      outlineWidth: round(parseFloat(cs.outlineWidth) || 0),
      outlineStyle: cs.outlineStyle,
      outlineColor: cs.outlineColor,
    };
  };

  // ---- the empty state, when the tab draws one -----------------------------------------------------
  const emptyNode = one(".init-empty");
  const empty = emptyNode
    ? {
        present: true,
        textLength: String(emptyNode.textContent || "").replace(/\\s+/g, " ").trim().length,
        headingTag: one("h1,h2,h3,h4,h5,h6", emptyNode)?.tagName?.toLowerCase() || null,
        headingText: textOf(one("h1,h2,h3,h4,h5,h6", emptyNode)),
        primary: Boolean(one("button.primary", emptyNode)),
        buttonLabel: textOf(one("button", emptyNode)),
        contrast: contrastOf(one("p, .init-empty-copy, b", emptyNode) || emptyNode),
        padding: box(emptyNode),
      }
    : { present: false };

  // ---- the card's structure, in the order it is painted ---------------------------------------------
  const card = one(".init-card");
  const sections = card
    ? [...card.children].map((n) => ({
        className: String(n.className || ""),
        height: round(n.getBoundingClientRect().height),
        visible: Boolean(n.getClientRects().length),
      }))
    : [];

  return {
    paneWidth: host.clientWidth,
    paneScrollWidth: host.scrollWidth,
    cards: all(".init-card").length,
    openCards: all(".init-card:not(.is-titlecard)").length,
    type: {
      title: typeOf(".init-title"),
      description: typeOf(".init-desc"),
      chip: typeOf(".init-chips .chip"),
      hint: typeOf(".init-chips .as-hint"),
      fold: typeOf(".init-proj .init-proj-name"),
      project: typeOf(".init-project .init-proj"),
      tree: typeOf(".init-tree-name"),
      mini: typeOf(".init-mini"),
      assist: typeOf(".init-assist-btn"),
      empty: typeOf(".init-empty"),
    },
    cardBox: box(card),
    headerBox: box(one(".init-head")),
    descBox: box(desc),
    chipsBox: box(one(".init-chips")),
    projectsBox: box(one(".init-projects")),
    addRowBox: box(one(".init-addrow")),
    assistsBox: box(one(".init-assists")),
    historyBox: box(one(".init-history")),
    targets: [
      target(".init-head-btn"),
      target(".init-project .init-proj"),
      target(".init-mini"),
      target(".init-tree-name"),
      target(".init-assist-btn"),
      target(".init-assist-fold"),
      target(".init-desc-head"),
      target(".init-form select"),
      target(".init-form .primary"),
    ].filter(Boolean),
    left: {
      title: leftOf(".init-title"),
      description: leftOf(".init-desc"),
      chips: leftOf(".init-chips .chip"),
      projects: leftOf(".init-projects"),
      addRow: leftOf(".init-addrow"),
      assist: leftOf(".init-assists"),
      history: leftOf(".init-history"),
    },
    chips,
    lineLength,
    sections,
    states: {
      projectFold: stateOf(".init-proj"),
      mini: stateOf(".init-mini"),
      treeLink: stateOf(".init-tree-name"),
      titleButton: stateOf(".init-head-btn"),
    },
    empty,
  };
})()`;

// The static half: one read of the painted pane. No focus, no hover, no press - the capture tool calls the
// interaction reader separately, and the gate calls both.
export async function measurePane(page) {
  return page.evaluate(PAGE_FN);
}

// The interactive half: hover, keyboard focus and an active press, each read from computed styles. It leaves the pane
// as it found it (the fold is pressed twice, the pointer is moved off), so a caller can measure and then screenshot.
export async function measureInteractions(page) {
  const out = { hover: {}, focus: {}, active: {}, keyboard: {} };
  const read = async (sel) => page.evaluate((s) => {
    const node = document.querySelector(`#as-initiatives ${s}`);
    if (!node) return null;
    const cs = getComputedStyle(node);
    return { background: cs.backgroundColor, color: cs.color, textDecoration: cs.textDecorationLine, transform: cs.transform, boxShadow: cs.boxShadow, filter: cs.filter };
  }, sel);

  // HOVER. The fold rows and the small buttons have a background; the tree name is a link and is allowed to answer
  // with a decoration instead. Both are real answers; "nothing changed" is the failure.
  const project = page.locator("#as-initiatives .init-project .init-proj").first();
  out.hover.projectFoldBefore = await read(".init-project .init-proj");
  if (await project.count()) {
    await project.hover();
    await page.waitForTimeout(80);
    out.hover.projectFoldAfter = await read(".init-project .init-proj");
  }
  const mini = page.locator("#as-initiatives .init-mini").first();
  out.hover.miniBefore = await read(".init-mini");
  if (await mini.count()) {
    await mini.hover();
    await page.waitForTimeout(80);
    out.hover.miniAfter = await read(".init-mini");
  }
  const treeLink = page.locator("#as-initiatives .init-tree-name").first();
  out.hover.treeBefore = await read(".init-tree-name");
  if (await treeLink.count()) {
    await treeLink.hover();
    await page.waitForTimeout(80);
    out.hover.treeAfter = await read(".init-tree-name");
  }
  await page.mouse.move(2, 2);

  // KEYBOARD. Reach a control the reader's own way - Tab, not `focus()` - and read the ring the browser paints. The
  // step count is the number of presses it took to get inside the pane; a huge one is its own finding.
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.locator("#as-tabs [data-as-tab=\"initiatives\"]").focus();
  const snapshot = () => page.evaluate(() => {
    const el = document.activeElement;
    if (!el || !el.closest || !el.closest("#as-initiatives")) return null;
    const cs = getComputedStyle(el);
    return {
      tag: el.tagName.toLowerCase(),
      text: String(el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60),
      className: String(el.className || ""),
      outlineWidth: Math.round((parseFloat(cs.outlineWidth) || 0) * 10) / 10,
      outlineStyle: cs.outlineStyle,
      outlineColor: cs.outlineColor,
      focusVisible: el.matches(":focus-visible"),
      background: cs.backgroundColor,
    };
  });
  let steps = 0;
  let reached = null;
  for (let i = 0; i < 60; i += 1) {
    await page.keyboard.press("Tab");
    steps += 1;
    reached = await snapshot();
    if (reached) break;
  }
  out.keyboard.steps = steps;
  out.keyboard.reached = reached;

  // Unused on a pane whose controls are all real buttons; kept because a <div role=button> is the failure this catches.
  out.keyboard.enterToggled = null;

  // The ring's own contrast: the outline colour against what is behind the control. 3:1 is the WCAG floor for a
  // non-text indicator.
  out.focus.ring = reached
    ? await page.evaluate(() => {
        const el = document.activeElement;
        if (!el) return null;
        const cs = getComputedStyle(el);
        const parse = (v) => {
          const m = String(v || "").match(/rgba?\(([^)]+)\)/);
          if (!m) return null;
          const p = m[1].split(/[,\s\/]+/).filter(Boolean).map(Number);
          return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
        };
        const over = (fg, bg) => ({ r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 });
        const lum = (c) => {
          const ch = (v) => (v / 255 <= 0.03928 ? v / 255 / 12.92 : Math.pow((v / 255 + 0.055) / 1.055, 2.4));
          return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b);
        };
        const ratio = (a, b) => Math.round(((Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05)) * 10) / 10;
        let bg = parse(getComputedStyle(document.body).backgroundColor) || { r: 15, g: 17, b: 21, a: 1 };
        for (let n = el; n; n = n.parentElement) {
          const c = parse(getComputedStyle(n).backgroundColor);
          if (c && c.a > 0) bg = over(c, bg);
        }
        const fg = parse(cs.outlineColor);
        return { outlineWidth: Math.round((parseFloat(cs.outlineWidth) || 0) * 10) / 10, outlineStyle: cs.outlineStyle, outlineColor: cs.outlineColor, contrast: fg ? ratio(fg, bg) : null };
      })
    : null;

  // DOES THE FOCUS SURVIVE THE PANE'S OWN REPAINT? The tab re-reads every four seconds and rebuilds its markup. A
  // ring that is gone by the next screenshot is not a keyboard state, so the control that was reached by Tab is read
  // again after the timer has had time to fire.
  const focusNow = () => page.evaluate(() => {
    const el = document.activeElement;
    if (!el || !el.closest || !el.closest("#as-initiatives")) return null;
    const cs = getComputedStyle(el);
    return {
      text: String(el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60),
      attrs: [...el.attributes].filter((a) => a.name.startsWith("data-init-")).map((a) => `${a.name}=${a.value}`).sort(),
      ringWidth: Math.round((parseFloat(cs.outlineWidth) || 0) * 10) / 10,
      restored: el.classList.contains("init-focus-restored"),
    };
  });
  out.keyboard.beforeRepaint = await focusNow();
  await page.waitForTimeout(4600);
  out.keyboard.afterRepaint = await focusNow();
  out.keyboard.persisted = Boolean(
    out.keyboard.beforeRepaint &&
      out.keyboard.afterRepaint &&
      out.keyboard.afterRepaint.attrs.join("|") === out.keyboard.beforeRepaint.attrs.join("|") &&
      out.keyboard.afterRepaint.ringWidth >= 2,
  );

  // ENTER ON A PROJECT FOLD. The keyboard has to be able to open a project, not only reach a row: Tab to the fold
  // itself, press Enter, and read that button's own aria-expanded before and after.
  let foldSteps = 0;
  for (let i = 0; i < 60; i += 1) {
    const atFold = await page.evaluate(() => Boolean(document.activeElement?.matches?.("button[data-init-fold]")));
    if (atFold) break;
    await page.keyboard.press("Tab");
    foldSteps += 1;
  }
  out.keyboard.foldSteps = foldSteps;
  out.keyboard.foldReached = await page.evaluate(() => Boolean(document.activeElement?.matches?.("button[data-init-fold]")));
  if (out.keyboard.foldReached) {
    const readExpanded = () => page.evaluate(() => document.activeElement?.getAttribute("aria-expanded") || null);
    const before = await readExpanded();
    await page.keyboard.press("Enter");
    await page.waitForTimeout(300);
    const after = await readExpanded();
    out.keyboard.enterToggled = before !== after;
    if (before !== after) {
      await page.keyboard.press("Enter");
      await page.waitForTimeout(250);
    }
  }

  // ACTIVE. Press and hold the same small button that was hovered, and compare the pressed paint with the hovered
  // paint: a button whose only "active" look is the hover it already had has no pressed state. Then release
  // somewhere else so the press is not also a click.
  const hoveredMini = page.locator("#as-initiatives .init-mini").first();
  const activeBox = await hoveredMini.boundingBox().catch(() => null);
  if (activeBox) {
    await page.mouse.move(activeBox.x + activeBox.width / 2, activeBox.y + activeBox.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(60);
    out.active.mini = await read(".init-mini");
    out.active.hoveredMini = out.hover.miniAfter;
    await page.mouse.move(2, 2);
    await page.mouse.up();
  }
  return out;
}

// ---- the rubric ---------------------------------------------------------------------------------
// One entry per claim the redesign makes. `ok` is computed from the measurement, never from a threshold a caller
// supplies; the gate prints all of them so a failure names the number that missed.
export function scoreInitiatives(m, interactions, { emptyPane = null, widePane = null } = {}) {
  const checks = [];
  const add = (id, label, ok, detail) => checks.push({ id, label, ok: Boolean(ok), detail });
  const t = m?.type || {};
  const it = interactions || {};
  const px = (v) => (Number.isFinite(v) ? `${v}px` : "absent");

  if (m?.error) {
    add("pane", "the initiatives pane is on screen", false, m.error);
    return { checks, passed: 0, total: checks.length, score: 0 };
  }

  // 1. TYPE SCALE. The redesign's scale is 13.5 title / 12 body / 12 fold / 11 meta / 10.5 chip - a hierarchy a
  // reader can see, with the body no smaller than the panel's 12px base.
  add("type-title", "the card title is at least 13px and heavier than the body", (t.title?.fontSize || 0) >= 13 && (t.title?.fontWeight || 0) >= 600, `${px(t.title?.fontSize)}, weight ${t.title?.fontWeight}`);
  add("type-body", "the description is at least 12px with 1.5 line-height", (t.description?.fontSize || 0) >= 12 && (t.description?.lineHeight || 0) / (t.description?.fontSize || 1) >= 1.45, `${px(t.description?.fontSize)} / ${px(t.description?.lineHeight)}`);
  add("type-fold", "project, tree and assistant rows are at least 12px", [t.fold, t.tree, t.assist].every((x) => (x?.fontSize || 0) >= 12), `${px(t.fold?.fontSize)} fold, ${px(t.tree?.fontSize)} tree, ${px(t.assist?.fontSize)} assistant`);
  add("type-meta", "hints and chips are at least 10.5px", [t.hint, t.chip].every((x) => (x?.fontSize || 0) >= 10.5), `${px(t.hint?.fontSize)} hint, ${px(t.chip?.fontSize)} chip`);

  // 2. AA CONTRAST, every measured text run, not only the title.
  const contrasts = [t.title, t.description, t.chip, t.hint, t.fold, t.tree, t.mini, t.assist].filter(Boolean).map((x) => ({ selector: x.selector, ratio: x.contrast }));
  const worst = contrasts.reduce((min, x) => (x.ratio == null ? min : !min || x.ratio < min.ratio ? x : min), null);
  add("contrast-aa", "every text run is at least 4.5:1 against its own background", contrasts.length > 0 && contrasts.every((x) => (x.ratio || 0) >= 4.5), worst ? `worst ${worst.ratio}:1 at ${worst.selector}` : "no text measured");

  // 3. A 4px SPACING SCALE. Card padding, the gaps between folds and the margins under the description and chips
  // are the readable rhythm; 7, 9 and 5 are three different opinions about the same gap.
  const rhythm = [m.cardBox, m.headerBox, m.descBox, m.chipsBox, m.projectsBox, m.addRowBox, m.assistsBox, m.historyBox].filter(Boolean);
  const values = rhythm.flatMap((b) => [b.paddingTop, b.paddingBottom, b.paddingLeft, b.paddingRight, b.marginTop, b.marginBottom, b.gap]).filter((n) => n > 0);
  const offGrid = [...new Set(values.filter((n) => n % 4 !== 0).map((n) => Math.round(n)))];
  add("spacing-4", "padding, gaps and margins sit on a 4px scale", offGrid.length === 0, offGrid.length ? `off-grid: ${offGrid.join(", ")}px` : `${new Set(values.map((n) => Math.round(n))).size} values, all multiples of 4`);

  // 4. HIT TARGETS. WCAG 2.5.8 is 24x24; 28 is the floor this panel can hold without the rail becoming a list of
  // buttons. The title row is the card's primary target and gets 32.
  const small = (m.targets || []).filter((x) => x.height < 28 || x.width < 24);
  add("hit-targets", "every control is at least 28px tall and 24px wide", small.length === 0 && (m.targets || []).length >= 5, small.length ? small.map((x) => `${x.selector} ${x.width}x${x.height}`).join("; ") : `${(m.targets || []).length} controls measured, smallest ${Math.min(...(m.targets || []).map((x) => x.height))}px`);

  // 5. CHIPS FIT. An ellipsis is not a chip that fits: the branch name is the long one on purpose.
  add("chips-fit", "no chip clips its text", (m.chips?.clipped || []).length === 0, (m.chips?.clipped || []).length ? `${m.chips.clipped.length} clipped: ${m.chips.clipped.map((c) => c.text.slice(0, 40)).join(" | ")}` : `${m.chips?.count || 0} chips, widest ${px(m.chips?.widest)}`);

  // 6. ALIGNMENT. The title, the description, the chips and the sections share one left edge; the indented lists are
  // one step in, not four different ones.
  const lefts = Object.values(m.left || {}).filter((n) => Number.isFinite(n));
  const spread = lefts.length ? Math.max(...lefts) - Math.min(...lefts) : 999;
  add("alignment", "the card's text shares one left edge", spread <= 20, `left edges ${lefts.join(", ")} (spread ${spread}px)`);

  // 7. LINE LENGTH at the widest float: prose past ~80 characters is a wall, not a paragraph.
  const line = widePane?.lineLength || m.lineLength;
  add("line-length", "a full description stays under 80 characters per line", Boolean(line) && line.charsPerLine <= 80, line ? `${line.charsPerLine} ch at ${px(line.widthPx)}` : "no description on screen");

  // 8. A REAL EMPTY STATE: a heading, a sentence, and the action that creates the first initiative.
  const empty = (emptyPane || m).empty || {};
  add("empty-state", "the empty tab has a heading, a sentence and its primary action", Boolean(empty.present) && Boolean(empty.headingTag) && empty.textLength >= 80 && empty.primary, empty.present ? `heading ${empty.headingTag || "none"}, ${empty.textLength} chars, primary ${empty.primary}` : "not on screen (this run captured a populated tab)");

  // 9. FOCUS, HOVER AND ACTIVE. A control that only works with a mouse is not a control.
  const ring = it.focus?.ring;
  add("focus-ring", "a keyboard-reached control paints a 2px ring at 3:1", Boolean(ring) && ring.outlineWidth >= 2 && ring.outlineStyle !== "none" && (ring.contrast || 0) >= 3, ring ? `${ring.outlineWidth}px ${ring.outlineStyle}, ${ring.contrast}:1` : "no control reached by Tab");
  const hoverChanged = (a, b) => Boolean(a && b) && (a.background !== b.background || a.color !== b.color || a.textDecoration !== b.textDecoration);
  add("hover", "folds, buttons and links answer a hover", hoverChanged(it.hover?.projectFoldBefore, it.hover?.projectFoldAfter) && hoverChanged(it.hover?.miniBefore, it.hover?.miniAfter) && hoverChanged(it.hover?.treeBefore, it.hover?.treeAfter), "project fold, mini button and tree link each change a computed colour or decoration");
  const pressed = it.active?.mini;
  const hovered = it.active?.hoveredMini;
  const pressedChanged = Boolean(pressed) && Boolean(hovered) && (pressed.transform !== hovered.transform || pressed.background !== hovered.background || pressed.boxShadow !== hovered.boxShadow || pressed.filter !== hovered.filter);
  add("active", "a pressed button paints a state beyond its own hover", pressedChanged, pressed ? `pressed transform ${pressed.transform}, background ${pressed.background}` : "no press measured");
  add("keyboard", "a project fold opens from the keyboard", Boolean(it.keyboard?.enterToggled) && Boolean(it.keyboard?.foldReached), `reached the fold after ${it.keyboard?.foldSteps ?? "?"} Tab press(es), Enter changed its aria-expanded: ${it.keyboard?.enterToggled ? "yes" : "no"}`);
  add("focus-persist", "keyboard focus survives the tab's own repaint", Boolean(it.keyboard?.persisted), it.keyboard?.afterRepaint ? `4.6s after Tab: ${it.keyboard.afterRepaint.attrs.join(", ") || "focus outside the pane"}, ring ${it.keyboard.afterRepaint.ringWidth}px` : "focus was outside the pane after 4.6s");

  const passed = checks.filter((c) => c.ok).length;
  return { checks, passed, total: checks.length, score: checks.length ? Math.round((passed / checks.length) * 1000) / 1000 : 0 };
}
