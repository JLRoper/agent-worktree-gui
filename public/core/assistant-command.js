// core/assistant-command.js - the assistant's command lines, drawn as the tool card the reader already knows.
//
// WHAT THIS IS. A reply an assistant writes ends with lines in the panel's own vocabulary - `QUEUE assistant-3 |
// ...`, `SPAWN IN <tree> | ...`, `TODO ADD ...` - and the reader meets them as plain prose in the transcript. This
// module reads the one thing a reader needs at a glance (which kind, who it is for, what it is called) and hands
// back the SAME `.code-box` frame a tool's result is drawn in: a head button with a caret and "click to read", and a
// body folded to two lines.
//
// DISPLAY ONLY, AND THIS IS THE WHOLE OF THE RULE. Nothing here is read by the executing grammar: lib/assistant/
// actions.js parses the line as it always did, byte for byte, and the title is NOT stripped from what runs. A card
// is a second reading of the same string, so a line this module cannot read renders exactly as it does today and
// the panel does exactly what it did before it existed.
//
// EVERY READABLE LINE IS A CARD, titled or not. The head is the kind's emoji and the recipient - `🧾 assistant-3` -
// and the title is appended only when the payload leads with one: `🧾 assistant-3 | Playwright test`. The body is the
// payload, folded to two lines. A line whose title is malformed or absent is not a lesser line: the reader still gets
// the same frame, the same emoji and the same recipient, which is what a row of monospace prose could not give.
//
// A SPAWN'S TODOS ARE ITS BULLETS. A TODO written under a SPAWN belongs to the tree that SPAWN names, so it is not a
// card of its own: it is a bullet row of the SPAWN's card - `<category> - <todo>`, the category being the TODO's own
// leading `[Title]` and the glyph its card's checkbox - drawn BETWEEN the head and the body. The bullets sit outside
// the body, so the two-line clamp never hides them, and the head counts them (`5 todos`). A TODO with no SPAWN above
// it keeps its card, exactly as it was.
//
// THE TITLE. A line's payload may lead with `[Title]`. The title counts only when its closing bracket arrives
// within the rule below (`COMMAND_TITLE_MAX`): a longer one, or one that never closes, is not a title, and it stays
// in the body as the payload it is. That is deliberate - a title is a display nicety, and a model writing
// `[a long sentence that never ends` must not be able to change what a reader is shown the line MEANS.
//
// THE HEADER. One emoji for the kind, then the recipient, then the title when there is one: `assistant-3 |
// Playwright test`. The recipient is the field the kind addresses - the assistant for QUEUE/MESSAGE, the tree or
// project for SPAWN, the thread for WATCH, `gateway`/`panel` for RESTART - and a kind that addresses nobody (RULE,
// NOTE, CHARTER) draws the emoji and the title alone, or the kind's own name when it has no title either, so a head
// is never a bare glyph.
//
// WHERE IT IS DRAWN. public/turns.js paints the board's tail with it (a folded turn's peek, and the compact card a
// turn freezes to), public/assistant.js paints the transcript's entries with it, and the agent card's own transcript
// reaches it through the one prose renderer (public/core/console-markdown.js asks `consoleFormat.commandCard`), so
// the turn body a reader opens draws the same cards as the panes around it. The frame itself is
// public/core/console-format.js's `box` - published for exactly this - so there is one card component and not two.
//
// Published on globalThis as `wtAssistantCommand`, loaded after core/console-format.js in public/index.html and
// imported by test/assistant-command-card.test.js.
(function (root) {
  "use strict";

  // One emoji per kind, and one only: the header is the first thing a reader's eye lands on, so a kind that has no
  // glyph here is a bug (the test counts them), not a line drawn without one.
  const COMMAND_EMOJI = Object.freeze({
    QUEUE: "\u{1F9FE}",
    MESSAGE: "\u2709\uFE0F",
    SPAWN: "\u{1F331}",
    TODO: "\u2611\uFE0F",
    RULE: "\u{1F4CF}",
    NOTE: "\u{1F4DD}",
    WATCH: "\u{1F440}",
    CHARTER: "\u{1F4DC}",
    RESTART: "\u267B\uFE0F",
  });

  // The 80-character rule, as a number a test can read: the title's own text may be at most this many characters.
  // The closing bracket is therefore at most the 81st character of the payload, which is the "within about 80"
  // the panel asks for. Longer than this and there is no title.
  const COMMAND_TITLE_MAX = 80;

  // HOW MANY PREVIEW ROWS A FOLDED CARD SHOWS. The page publishes the reader's own number as
  // `wtCommandPreviewRows` (Settings > Display, applied by public/app.js to the stylesheet's `--cmd-rows` as well,
  // so the clamp and this attribute can never disagree). A page that publishes none - a test, a harness, a caller
  // that did not ask - draws the two rows this card has always had.
  const COMMAND_PREVIEW_ROWS = 2;

  function previewRows() {
    const n = Math.round(Number(root.wtCommandPreviewRows));
    return Number.isFinite(n) && n >= 1 ? n : COMMAND_PREVIEW_ROWS;
  }

  // THE PROMPT'S LABEL. A card's body is the text the line sends - the prompt - and a folded card shows the first
  // rows of it with nothing saying what they are. The label is bold and INLINE on the body's first row, so it costs
  // no preview row of its own: two rows of prompt still read as two rows.
  const COMMAND_PROMPT_LABEL = "Prompt:";

  // The frame, published by core/console-format.js. Looked up at call time and never imported: this file is a
  // classic script, and a page that has lost the frame should draw the plain line rather than a second card.
  function frame() {
    const core = root.WMApp && root.WMApp.core;
    const published = core && core.consoleFormat;
    return published && typeof published.box === "function" ? published.box : null;
  }

  // The page's escaper when there is one (every caller on the page has `esc`), and the same answer when there is
  // not (a test, a harness): a display-only module must not be the reason a line goes unescaped.
  function escOf(value) {
    const s = String(value == null ? "" : value);
    if (typeof root.esc === "function") return root.esc(s);
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  // The nine kinds, in the order the vocabulary lists them. TO is deliberately absent: it addresses a WORKER thread
  // and is not the panel's own command (lib/assistant/actions.js says so), so it keeps its prose line.
  const KINDS = ["QUEUE", "MESSAGE", "SPAWN", "TODO", "RULE", "NOTE", "WATCH", "CHARTER", "RESTART"];
  const KIND_RE = new RegExp(`^\\s*(${KINDS.join("|")})\\b([\\s\\S]*)$`, "i");

  const QUOTES = /^["']|["']$/g;
  // The dash family the grammar accepts as a RULE/CHARTER separator, built from codes so this file carries no
  // long dash of its own: the separator is one character the model may write before the text.
  const DASHES = String.fromCharCode(0x2010, 0x2011, 0x2012, 0x2013, 0x2014, 0x2015, 0x2212);
  const SEPARATOR_RE = new RegExp(`^\\s*(?:[:${DASHES}-]\\s*)?([\\s\\S]*)$`);

  // The field a kind addresses, and the payload the title is read from. Each shape mirrors lib/assistant/actions.js
  // (and lib/todos.js for TODO) so a line that gets a card is a line the executing grammar reads as a command: the
  // card never invents a reading the panel does not have.
  function fieldsOf(kind, rest) {
    if (kind === "QUEUE" || kind === "MESSAGE" || kind === "SPAWN") {
      // The pipe is the field break for all three: the text may contain anything, a Windows path's colon included.
      const m = /^([\s\S]*?)\s*\|\s*([\s\S]*)$/.exec(rest);
      if (!m) return null;
      const recipient = m[1].trim().replace(QUOTES, "");
      if (!recipient) return null;
      return { recipient, payload: m[2] };
    }
    if (kind === "TODO") {
      // `TODO IN <tree> | <text>`, then an optional op word. An id op (DONE/DOING/DROP/REOPEN) carries an id and no
      // text, so there is nothing for a title to lead: it is not a card.
      let target = "";
      let body = rest.trim();
      const inMatch = /^IN\s+([\s\S]+?)\s*\|\s*([\s\S]*)$/i.exec(body);
      if (inMatch) {
        target = inMatch[1].trim().replace(QUOTES, "");
        body = inMatch[2].trim();
      }
      const op = /^(ADD|DONE|DOING|DROP|REOPEN)\b\s*([\s\S]*)$/i.exec(body);
      if (op) {
        // An id op carries an id and no text, so there is nothing for a title to lead and the payload is empty.
        if (op[1].toUpperCase() !== "ADD") return { recipient: target, payload: "" };
        body = op[2].trim();
      }
      return { recipient: target, payload: body };
    }
    if (kind === "NOTE") {
      const m = /^\s*:\s*(.+)$/.exec(rest);
      return m ? { recipient: "", payload: m[1] } : null;
    }
    if (kind === "WATCH") {
      // The grammar's own shape: a thread, a colon, a watched sentence that carries no pipe in it, and an optional
      // `| <minutes>`. A line with a pipe in the sentence is not a WATCH the panel runs, so it is not a card either.
      const m = /^\s+([A-Za-z0-9._:-]+)\s*:\s*([^|]+?)\s*(?:\|\s*(\d+)\s*(?:m|min|minutes?)?\s*)?$/i.exec(rest);
      if (!m) return null;
      return { recipient: m[1], payload: m[2] };
    }
    if (kind === "RESTART") {
      const m = /^\s+(?:the\s+)?(gateway|panel)\b\s*\|?\s*([\s\S]*)$/i.exec(rest);
      if (!m) return null;
      return { recipient: m[1].toLowerCase(), payload: m[2] };
    }
    // RULE and CHARTER: a separator is optional (the grammar takes all three of `:`, a dash and a bare space).
    const m = SEPARATOR_RE.exec(rest);
    return m ? { recipient: "", payload: m[1] } : null;
  }

  // A payload's leading `[Title]`, or null. The rule lives here and nowhere else, so the card, the tests and any
  // later surface cannot disagree about when a bracket is a title. A line without one is still a card: the title is
  // the head's last field, never the reason a line is drawn.
  function readTitle(payload) {
    const s = String(payload == null ? "" : payload);
    const m = /^\s*\[([^\]\n]*)\]/.exec(s);
    if (!m) return null;
    const title = m[1].trim();
    if (!title || title.length > COMMAND_TITLE_MAX) return null;
    return { title, body: s.slice(m[0].length).replace(/^[ \t]+/, "") };
  }

  // One line, read the way the card needs it. Returns null for anything that is not a command line of the
  // vocabulary. `title` is null when the payload carries no title the rule accepts, and the line is still drawn:
  // `body` is then the payload itself, which is what the card shows.
  function parseCommandLine(text) {
    const line = String(text == null ? "" : text);
    if (!line || /[\r\n]/.test(line)) return null;
    const m = KIND_RE.exec(line);
    if (!m) return null;
    const kind = m[1].toUpperCase();
    const fields = fieldsOf(kind, m[2]);
    if (!fields) return null;
    const titled = readTitle(fields.payload);
    return {
      kind,
      emoji: COMMAND_EMOJI[kind],
      recipient: fields.recipient,
      title: titled ? titled.title : null,
      body: titled ? titled.body : fields.payload.trim(),
      text: line,
    };
  }

  // WHAT A SPAWN CARD OWNS. A TODO written under a SPAWN is that tree's work, so it is not a card of its own: it is
  // one bullet row of the SPAWN's card, drawn between the head and the body. The rule is positional - the nearest
  // SPAWN above the line owns it - because the grammar's own sentence says a TODO belongs to "the worktree the SPAWN
  // above names". A TODO with no SPAWN above it keeps its card exactly as before. This is a second reading of the
  // same strings, like every other line here: the TODO still executes with its bracket, and lib/todos.js is untouched.
  //
  // The bullet reads `<category> - <todo>`, where the category is the TODO's leading `[Title]` - the same bracket the
  // card's head already reads - and the glyph is the TODO card's own checkbox. A TODO with no bracket is still the
  // SPAWN's bullet: it draws the glyph and its text, with no invented category.
  function todoBullet(parsed) {
    if (!parsed || parsed.kind !== "TODO") return null;
    // An id op (`TODO DONE 3`) carries no text, so there is nothing to fold: the prose line is the whole command.
    if (!parsed.title && !parsed.body) return null;
    return { category: parsed.title || "", text: parsed.body || "", source: parsed.text };
  }

  // One bullet's label, in the one place, so the card, the tests and the docs cannot disagree.
  function bulletLabel(bullet) {
    if (!bullet) return "";
    if (!bullet.category) return bullet.text;
    return bullet.text ? `${bullet.category} - ${bullet.text}` : bullet.category;
  }

  // The same label as markup: the category is the label a reader scans for, so it carries the weight, and the item
  // reads after the hyphen. Only the category is escaped here - the hyphen and the space are ours, and a bullet with
  // no category is its item alone, in the same quiet weight as the rest.
  function bulletText(bullet) {
    if (!bullet) return "";
    if (!bullet.category) return escOf(bullet.text);
    return `<b class="code-bullet-cat">${escOf(bullet.category)}</b>${bullet.text ? ` - ${escOf(bullet.text)}` : ""}`;
  }

  // Lines in, the same lines out, with each SPAWN's following TODOs attached to it and marked `folded` (the caller
  // draws nothing for those). Entries are `{ text, ... }` and are returned shallow-copied, so a caller's own fields
  // (an index, a line id) survive. Ownership is the nearest SPAWN above and is not reset by prose: a reply's tail is
  // one block of command lines, and a TODO an inch below its SPAWN belongs to it however the sentences are broken up.
  function foldSpawnTodos(entries) {
    const list = Array.isArray(entries) ? entries : [];
    let owner = null;
    return list.map((entry) => {
      const text = String(entry && entry.text != null ? entry.text : "");
      const parsed = parseCommandLine(text);
      if (parsed && parsed.kind === "SPAWN") {
        owner = { todos: [] };
        return { ...entry, parsed, todos: owner.todos };
      }
      const bullet = todoBullet(parsed);
      if (bullet && owner) {
        owner.todos.push(bullet);
        return { ...entry, parsed, folded: true, todos: [] };
      }
      return { ...entry, parsed, todos: [] };
    });
  }

  // A SPAWN card's bullets, as rows BETWEEN the head and the body: they stay on the page when the body is folded to
  // two lines, because they are not part of it. Each row is its own line of text, escaped like every other row, and
  // carries the TODO it was read from in `title` - no `data-ltext`, because the box's own `data-ltext` is the SPAWN
  // line and the console's copy walker lifts the box, not its parts.
  function bulletsHtml(bullets) {
    const list = (Array.isArray(bullets) ? bullets : []).filter(Boolean);
    if (!list.length) return "";
    const rows = list.map(
      (b) =>
        `<div class="code-bullet" role="listitem" title="${escOf(b.source || "")}">` +
        `<span class="code-bullet-glyph" aria-hidden="true">${COMMAND_EMOJI.TODO}</span>` +
        `<span class="code-bullet-text">${bulletText(b)}</span></div>`,
    );
    return `<div class="code-bullets" role="list" aria-label="${list.length} todo${list.length === 1 ? "" : "s"} in this tree">${rows.join("")}</div>`;
  }

  const todoCount = (n) => `${n} todo${n === 1 ? "" : "s"}`;

  // The head's one line: the kind's emoji, the recipient when the kind addresses one, then the title when the line
  // carries one. A kind that addresses nobody and carries no title says its own kind after the glyph, so a head is
  // never a bare emoji.
  function headerOf(parsed) {
    if (!parsed) return "";
    const lead = parsed.recipient ? `${parsed.emoji} ${parsed.recipient}` : parsed.emoji;
    if (parsed.title) return parsed.recipient ? `${lead} | ${parsed.title}` : `${lead} ${parsed.title}`;
    return parsed.recipient ? lead : `${lead} ${parsed.kind}`;
  }

  // A stable key for the reader's open state, so a repaint does not fold a card the reader opened. The caller words
  // its own scope (a turn, a message) and `ref` is what is stable inside it - a line's own id when it has one, its
  // index in the run when it does not.
  function keyOf(scope, ref) {
    const at = ref == null || ref === "" ? 0 : ref;
    return `cmd|${String(scope || "")}|${String(at)}`;
  }

  // One command line as a card, or "" when the text is not a command line this module can read, when the line is
  // nothing but the command itself, or when the page has lost the frame. `open` is the page's code-box book (a Set
  // of keys); `clamp` is how many lines the body shows while it is folded.
  function cardHtml(text, { key = "", scope = "", ref = null, open = null, clamp = 0, lid = null, lineKind = "", bullets = null } = {}) {
    const parsed = parseCommandLine(text);
    if (!parsed) return "";
    // A SPAWN whose TODOs are folded into it is a card even when its own payload is empty: the bullets are the body's
    // equal, and dropping the card would drop them with it.
    const list = (Array.isArray(bullets) ? bullets : []).filter(Boolean);
    // An id op (`TODO DONE 3`) carries no payload and no title: there is nothing a body could show, so the prose
    // line it has always been is the whole command.
    if (!parsed.title && !parsed.body && !list.length) return "";
    const box = frame();
    if (!box) return "";
    // The reader's preview rows (Settings > Display) unless the caller named its own number. The attribute and the
    // stylesheet's `--cmd-rows` are both written from the one setting, so the fold and the marker agree.
    const rows = Number(clamp) > 0 ? Number(clamp) : previewRows();
    const lines = String(parsed.body || "").split("\n");
    // The first row carries the bold label that names what the text is; every later row is the prompt's own text.
    // A card with no body at all (a SPAWN that only carries its TODOs) draws no label: a name over nothing is not a
    // prompt, and the reader would take the empty row for an unreadable one.
    const body = String(parsed.body || "").trim()
      ? lines
          .map((l, i) =>
            i === 0
              ? `<div class="jl jl-text"><b class="code-prompt-label">${COMMAND_PROMPT_LABEL}</b> ${escOf(l)}</div>`
              : `<div class="jl jl-text">${escOf(l)}</div>`,
          )
          .join("")
      : "";
    // The line itself travels on the card, the way it travels on a console row: the console's copy lifts the line,
    // not the card's chrome, and a reader of the DOM finds the source text where every other row keeps it.
    const id = lid != null && lid !== "" ? String(lid) : "";
    const attrs =
      ` data-ltext="${escOf(parsed.text)}" data-lkind="${escOf(lineKind || "text")}"` +
      (id ? ` data-lid="${escOf(id)}"` : "") +
      (list.length ? ` data-cmd-bullets="${list.length}"` : "");
    return box({
      kind: "cmd",
      at: 0,
      rows: Math.max(1, lines.length),
      what: headerOf(parsed),
      title: parsed.text.trim(),
      // The head says how many bullets the card carries, and the bullets ride BETWEEN the head and the body so a
      // folded card still shows them: they are not part of the body the clamp cuts.
      count: list.length ? todoCount(list.length) : "",
      bullets: bulletsHtml(list),
      body,
      opts: { key: key || keyOf(scope, ref) },
      open,
      clamp: rows,
      attrs,
    });
  }

  // A block of text (a reply, a transcript entry) as it reads: every readable command line is a card, every other
  // line is handed back to the caller's own renderer. "" when the text holds no command line at all, which is what
  // lets a caller keep its existing rendering untouched for every message that has none.
  function cardsHtml(text, { scope = "", keyPrefix = "", open = null, clamp = 0, renderText = null } = {}) {
    const source = String(text == null ? "" : text);
    if (!source) return "";
    // One pass decides which lines are cards and which are a SPAWN card's bullets: a TODO under a SPAWN is drawn
    // inside that card and draws nothing of its own, so it contributes no row to the block at all.
    const units = foldSpawnTodos(source.split("\n").map((line, i) => ({ text: line, i })));
    const cards = units.map((u) =>
      u.folded ? "" : cardHtml(u.text, { key: keyOf(scope || keyPrefix, u.i), open, clamp, bullets: u.todos }),
    );
    if (!cards.some(Boolean)) return "";
    return units
      .map((u, i) =>
        cards[i] ||
        (u.folded
          ? ""
          : typeof renderText === "function"
            ? renderText(u.text)
            : `<div class="jl jl-text">${escOf(u.text)}</div>`),
      )
      .join("");
  }

  root.wtAssistantCommand = {
    COMMAND_EMOJI,
    COMMAND_TITLE_MAX,
    COMMAND_PREVIEW_ROWS,
    COMMAND_PROMPT_LABEL,
    previewRows,
    KINDS,
    parseCommandLine,
    readTitle,
    todoBullet,
    bulletLabel,
    bulletText,
    foldSpawnTodos,
    bulletsHtml,
    headerOf,
    keyOf,
    cardHtml,
    cardsHtml,
  };
})(globalThis);
