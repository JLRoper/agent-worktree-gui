// board/attachments.js — documents pasted or dropped into a prompt.
//
// Extracted from public/app.js as M14 in .agentboard/refactor-research/frontend-app-js.md (§2, §5 step 2),
// moved line for line: lines 9504-9523 and 9530-9625 of public/app.js at ae528c7. Nothing renamed, nothing
// rewritten, no call site touched.
//
// WHAT MOVED: spawnAttachments, attachmentsFor, setAttachments, attachmentChipsHtml, renderChips,
// attachmentBlock, clearAttachments, attachFiles, attachTarget — and the four document-level listeners that
// are their only callers (paste, dragover, dragleave, drop), which the plan records as belonging here even
// though its own range for the previous module swallowed them. Two deliberate differences from the plan's
// line table: fmtBytes is NOT here (it is a pure formatter and moved to core/dom-format.js in the first
// step, and this file calls it by name), and the two comment lines below this unit stay in app.js because
// they introduce the first-commit listener, which is not part of this module.
//
// LOADED AS A CLASSIC SCRIPT, BEFORE app.js (see index.html). The names stay page globals, exactly as they
// were in app.js, so the ~14 caller units there — and its four listeners, now registered one step earlier in
// the same tick — see no difference.
//
// TWO CONTRACTS WORTH KEEPING IN VIEW (both from the plan):
//   * setAttachments(ctx, list) special-cases ctx === "spawn" into the module-level spawnAttachments array
//     and everything else into state.replyAttachments, so it cannot be split from the reply state's Map.
//   * spawn-msg is the one element three modules write: this file on a failed upload, the spawn module in
//     its note, and the click dispatcher in the first-commit flow. The write on failure below is deliberate.
//
// WHAT IT STILL REACHES OUT FOR (by name, at call time, exactly as before): state (public/app.js, M1),
// apiFetch (M3, still in app.js), $ / esc / fmtBytes (core/dom-format.js).

// ---- documents pasted into a prompt ------------------------------------------------
// The gateway's runs API has no attachment field, so a document is stored by the panel and its absolute
// path is appended to the prompt at SEND time. On screen it is a chip above the box — `[name] ×` — so the
// thing you typed is not buried under a paragraph of machine text.
const spawnAttachments = []; // the New-agent box's list; it lives in static markup, so no re-render to survive

function attachmentsFor(ctx) {
  return ctx === "spawn" ? spawnAttachments : state.replyAttachments.get(ctx) || [];
}

function setAttachments(ctx, list) {
  if (ctx === "spawn") {
    spawnAttachments.length = 0;
    spawnAttachments.push(...list);
  } else if (list.length) {
    state.replyAttachments.set(ctx, list);
  } else {
    state.replyAttachments.delete(ctx);
  }
}

function attachmentChipsHtml(ctx) {
  return attachmentsFor(ctx)
    .map(
      (a) =>
        `<span class="attach-chip mono" data-open-path="${esc(a.path)}" title="open ${esc(a.path)} in Notepad++">[${esc(a.name)}]<button type="button" class="chip-x" data-chip-remove="${esc(a.path)}" data-chip-ctx="${esc(ctx)}" title="remove this attachment">\u00d7</button></span>`,
    )
    .join("");
}

function renderChips(ctx) {
  const el =
    ctx === "spawn"
      ? document.getElementById("spawn-chips")
      : document.querySelector(`.attach-chips[data-chips="${CSS.escape(ctx)}"]`);
  if (!el) return;
  el.innerHTML = attachmentChipsHtml(ctx);
}

// What the agent actually receives: the chip stays a chip, the path travels with the message.
function attachmentBlock(ctx) {
  return attachmentsFor(ctx)
    .map((a) => {
      const how = /^image\//.test(String(a.type)) ? "use vision_analyze on it" : "read_file it";
      return `\n\nAttachment: ${a.path} (${a.type || "unknown type"}, ${fmtBytes(a.bytes)}) — ${how} before answering.`;
    })
    .join("");
}

function clearAttachments(ctx) {
  setAttachments(ctx, []);
  renderChips(ctx);
}

async function attachFiles(files, box) {
  const ctx = box.id === "job-prompt" ? "spawn" : box.dataset.reply || null;
  if (!ctx) return;
  for (const file of files) {
    if (!file) continue;
    if (!file.size) {
      if (ctx === "spawn") $("spawn-msg").textContent = `${file.name || "file"} is empty`;
      continue;
    }
    try {
      const res = await apiFetch(
        "/api/attachments",
        {
          method: "POST",
          headers: {
            "Content-Type": file.type || "application/octet-stream",
            "x-filename": encodeURIComponent(file.name || "pasted-file"),
          },
          body: file,
        },
        { timeoutMs: 120000 },
      );
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
      setAttachments(ctx, [...attachmentsFor(ctx), d]);
      renderChips(ctx);
    } catch (e) {
      const warn = ctx === "spawn" ? $("spawn-msg") : document.querySelector(`[data-reply-warn="${CSS.escape(ctx)}"]`);
      if (warn) warn.textContent = `attachment failed: ${e.message}`;
    }
  }
}

function attachTarget(el) {
  return el && el.closest ? el.closest("#job-prompt, .reply-box") : null;
}

document.addEventListener("paste", (e) => {
  const box = attachTarget(e.target);
  const files = [...((e.clipboardData && e.clipboardData.files) || [])];
  if (!box || !files.length) return; // text pastes stay text
  e.preventDefault();
  void attachFiles(files, box);
});

document.addEventListener("dragover", (e) => {
  const box = attachTarget(e.target);
  if (!box || !e.dataTransfer || ![...(e.dataTransfer.types || [])].includes("Files")) return;
  e.preventDefault();
  box.classList.add("drop-target");
});
document.addEventListener("dragleave", (e) => {
  const box = attachTarget(e.target);
  if (box) box.classList.remove("drop-target");
});
document.addEventListener("drop", (e) => {
  const box = attachTarget(e.target);
  const files = [...((e.dataTransfer && e.dataTransfer.files) || [])];
  if (!box || !files.length) return;
  e.preventDefault();
  box.classList.remove("drop-target");
  void attachFiles(files, box);
});

window.WMApp = window.WMApp || {};
window.WMApp.board = window.WMApp.board || {};
// Published for the later steps of the split; nothing reads it yet.
window.WMApp.board.attachments = {
  attachmentsFor, setAttachments, attachmentChipsHtml, renderChips, attachmentBlock, clearAttachments,
  attachFiles, attachTarget,
};
