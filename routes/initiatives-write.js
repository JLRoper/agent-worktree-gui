// The initiative writes: the tag registry, create, the words, the note log, the reader's order, the one move that
// asks, archive and restore, and the GET this prefix answers with - moved line for line out of routes/initiatives.js by
// row 515, the module-separation plan's entry 18. Nothing below was renamed or rewritten: every line of the dispatcher
// is the line the parent carried, at the same indentation, composed by routes/initiatives.js's create factory.
//
// WHAT STAYED: the prefix, its guard, and the read the tab draws - initiativesView, the archive blockers, the memo
// (cachedView) and the wave-key rebuild. They are handed in below (view, cachedView, rebuildView, dropView), so a
// write's answer is the whole document the next GET would answer, built from the same fold.
//
// WHY ONE DISPATCHER AND NOT ONE EXPORT PER ROUTE. The routes share the guard above them (the prefix, the token, the
// method, the body parse) and the memo each answer carries. Exporting them separately would rewrite every sendJson
// call and every `return true` into a different shape, which is not a move. The dispatcher is handed the same names it
// read from the parent's closure, so the cut stays byte-identical.
import { TITLE_MAX } from "../lib/initiatives.js";
import { tagsView } from "../lib/initiative-tags.js";
import { initiativeAsks } from "../lib/initiative-permissions.js";
// The read's own phase clock, used by the GET's ?profile=1 branch.
import { profileReport, withProfile } from "../lib/read-profile.js";

/** The write half of /api/initiatives, composed by createInitiativesRoutes with the read it answers with. */
export function createInitiativeWrites({
  INITIATIVES_PATH,
  TAGS_PATH,
  initiatives,
  tags = null,
  remoteWrites,
  projectForPath,
  sendJson,
  readBody,
  authorised,
  onChange = () => {},
  log = () => {},
  tierOf,
  actorOf,
  unreadable,
  view,
  cachedView,
  rebuildView,
  dropView,
  nameOf,
  archiveBlockers,
} = {}) {
  return async function initiativeWrites(req, res, route, url, config, params) {
    // ---- the board's tag registry (lib/initiative-tags.js) ---------------------------------------------------------
    // ABOVE THE READ AND ITS METHOD GUARDS, because this is the one path on the prefix that answers GET, POST, PATCH
    // and DELETE - a second method set than the rest of the prefix, and the reason the guard below says "GET on the
    // bare path" rather than "GET anywhere".
    //
    // ONE DOCUMENT FOR BOTH STORES. The registry answers alone here (and inside GET /api/initiatives as `tags`), and
    // the ids on an initiative resolve against it in the tab. That is what makes a rename follow every card and every
    // saved filter in one write: nothing copied a tag's words onto a card in the first place.
    //
    // THE THREE WRITES ARE THE READER'S ALONE. `by` is the actor the page never sends (it means the reader) and an
    // assistant always does; an assistant may APPLY an existing tag through the initiative routes, but the vocabulary
    // itself is the reader's. 403 rather than a silent no-op, because a worker that thought it had named a tag should
    // be told it did not.
    if (route === TAGS_PATH) {
      if (!tags || typeof tags.statusOf !== "function") {
        sendJson(res, 503, { ok: false, error: "no tag registry is configured for this panel" });
        return true;
      }
      if (req.method === "GET") {
        sendJson(res, 200, { ok: true, ...tagsView(tags) });
        return true;
      }
      if (req.method !== "POST" && req.method !== "PATCH" && req.method !== "DELETE") {
        sendJson(res, 405, { error: `${req.method} is not allowed on ${route} - the registry answers GET, POST, PATCH and DELETE` });
        return true;
      }
      if (!authorised(req, config.token)) {
        sendJson(res, 403, { error: "bad or missing x-panel-token" });
        return true;
      }
      let body;
      try {
        body = await readBody(req);
      } catch (err) {
        sendJson(res, 400, { error: String((err && err.message) || err) });
        return true;
      }
      const payload = body && typeof body === "object" ? body : {};
      const by = actorOf(payload);
      if (by !== "reader") {
        sendJson(res, 403, {
          ok: false,
          error: `tags are the reader's to create, rename and delete - ${by} may only apply an existing tag to an initiative (tagIds on the create/update routes)`,
        });
        return true;
      }
      // An unreadable registry refuses every write with the store's own sentence, BEFORE anything is parked or written:
      // the bytes stay where they are for the reader to fix.
      const refusedTags = typeof tags.refuse === "function" ? tags.refuse() : null;
      if (refusedTags) {
        sendJson(res, 409, refusedTags);
        return true;
      }
      // The registry rides the tab's cached read, so a write here must drop that document or the next GET answers the
      // vocabulary from before the change.
      dropView();

      if (req.method === "POST") {
        const out = tags.create({ ident: payload.ident, name: payload.name, description: payload.description, color: payload.color, by });
        if (!out.ok) {
          sendJson(res, 400, out);
          return true;
        }
        log(`initiative-tags: created "${out.tag.ident}" (${out.tag.name}) as ${by}`);
        sendJson(res, 201, { ok: true, asked: false, changed: true, tag: out.tag, registry: tagsView(tags) });
        return true;
      }
      if (req.method === "PATCH") {
        const id = String(payload.id || "").trim();
        if (!id) {
          sendJson(res, 400, { ok: false, error: "a rename needs the tag id" });
          return true;
        }
        const out = tags.rename({ id, ident: payload.ident, name: payload.name, description: payload.description, color: payload.color, by });
        if (!out.ok) {
          sendJson(res, out.notFound ? 404 : 400, out);
          return true;
        }
        if (out.changed !== false) log(`initiative-tags: renamed "${out.tag.ident}" (${id}) by ${by} - ${(out.fields || []).join(" and ")}`);
        sendJson(res, 200, { ok: true, asked: false, changed: out.changed !== false, tag: out.tag, fields: out.fields || [], registry: tagsView(tags) });
        return true;
      }

      // DELETE. Refused while any initiative carries the tag unless the reader confirmed, and the refusal's sentence
      // names the COUNT (lib/initiative-tags.js). A confirmed delete takes the id off every initiative FIRST, in one
      // save, and only then drops the entry: if the second write failed, the tag would still exist and be unused, which
      // a second press fixes - the other order would leave cards naming a tag the registry had already lost.
      if (req.method !== "DELETE") {
        sendJson(res, 405, { error: `${req.method} is not allowed on ${route} - the registry answers GET, POST, PATCH and DELETE` });
        return true;
      }
      const id = String(payload.id || "").trim();
      if (!id) {
        sendJson(res, 400, { ok: false, error: "a delete needs the tag id" });
        return true;
      }
      const confirm = payload.confirm === true || payload.confirm === "true" || payload.confirm === 1;
      const carried = typeof initiatives.carriersOfTag === "function" ? initiatives.carriersOfTag(id) : [];
      let removedFrom = 0;
      if (carried.length && confirm) {
        const dropped = initiatives.dropTag({ id, by });
        if (!dropped.ok) {
          sendJson(res, dropped.refused === "unreadable" ? 409 : 500, dropped);
          return true;
        }
        removedFrom = Number(dropped.removed) || 0;
      }
      const out = tags.remove({ id, confirm, carried, by });
      if (!out.ok) {
        sendJson(res, out.notFound ? 404 : out.refused === "carried" || out.refused === "unreadable" ? 409 : 400, out);
        return true;
      }
      if (removedFrom) onChange("tag deleted");
      log(`initiative-tags: deleted "${out.deleted.ident}" (${id}) by ${by}${out.carried ? ` - taken off ${out.carried} initiative${out.carried === 1 ? "" : "s"}` : ""}`);
      sendJson(res, 200, { ok: true, asked: false, changed: true, deleted: out.deleted, carried: Number(out.carried) || 0, removedFrom, registry: tagsView(tags) });
      return true;
    }

    // One read, at the bare path: the whole document the tab draws. Every other route on this prefix is a write.
    if (req.method === "GET") {
      if (route !== INITIATIVES_PATH) {
        sendJson(res, 405, { error: `GET is not allowed on ${route}` });
        return true;
      }
      // THE TAB GETS THE CACHED DOCUMENT; AN OPERATOR ASKING FOR PHASES GETS A REAL BUILD. `?profile=1` is a
      // measurement request (lib/read-profile.js), so it must not be answered from a cache - the phases of a cache hit
      // describe the hit, not the read. The tab never sends it, and the document it draws is the one `cachedView`
      // keeps, with no new key.
      if (String(params.get("profile") || "") === "1") {
        sendJson(
          res,
          200,
          await withProfile(true, async () => {
            const document = await view();
            document.profile = profileReport();
            return document;
          }),
        );
        return true;
      }
      sendJson(res, 200, await cachedView());
      return true;
    }
    if (req.method !== "POST") {
      sendJson(res, 405, { error: `${req.method} is not allowed on ${route}` });
      return true;
    }
    if (!authorised(req, config.token)) {
      sendJson(res, 403, { error: "bad or missing x-panel-token" });
      return true;
    }
    let body;
    try {
      body = await readBody(req);
    } catch (err) {
      sendJson(res, 400, { error: String((err && err.message) || err) });
      return true;
    }
    const payload = body && typeof body === "object" ? body : {};
    // A write is about to change the map: the memoised read must not answer the next GET with the state from before it.
    dropView();

    // ---- create ----------------------------------------------------------------------------------------------------
    if (route === INITIATIVES_PATH) {
      const refused = unreadable();
      if (refused) {
        sendJson(res, 409, refused);
        return true;
      }
      const title = String(payload.title ?? "").replace(/\s+/g, " ").trim();
      if (!title) {
        sendJson(res, 400, { ok: false, error: "an initiative needs a title - one line saying what the work is" });
        return true;
      }
      const by = actorOf(payload);
      // The level decides whether this asks. At `all` it does, and the card names the proposed initiative - there is no
      // tree yet, so the tree line is empty rather than invented. The resume creates it, on the same store the plain
      // path writes, so an answered card and an unasked create cannot diverge.
      if (initiativeAsks(tierOf(), "create", { actor: by })) {
        const request = remoteWrites.request({
          kind: "initiative",
          worktree: "",
          project: "",
          title: `Create initiative "${title.slice(0, TITLE_MAX)}"`,
          command: `create initiative "${title.slice(0, TITLE_MAX)}"`,
          description: `${by === "reader" ? "you are" : `${by} is`} adding an initiative to your map of the work. Nothing is created until you answer; Deny leaves the map exactly as it is.`,
          allowed: ["once", "deny"],
          grants: false,
          resume: () => {
            const out = initiatives.create({ title: payload.title, description: payload.description, tagIds: payload.tagIds, by });
            if (out.ok) onChange("created");
            return out;
          },
        });
        log(`initiatives: asked (${request.id}) to create "${title.slice(0, TITLE_MAX)}" as ${by}`);
        sendJson(res, 202, {
          ok: true,
          asked: true,
          id: request.id,
          deadline: request.deadline,
          timeoutSeconds: request.timeoutSeconds,
          action: "create",
          title: title.slice(0, TITLE_MAX),
          tier: tierOf(),
          note: "the question is in the dock, bottom right - the initiative is created when you answer it",
        });
        return true;
      }
      const out = initiatives.create({ title: payload.title, description: payload.description, tagIds: payload.tagIds, by });
      if (!out.ok) {
        sendJson(res, out.refused === "unreadable" ? 409 : 400, out);
        return true;
      }
      log(`initiatives: "${out.initiative.title}" created (${out.initiative.id}) by ${by}, not asked (tier ${tierOf()})`);
      onChange("created");
      sendJson(res, 201, { ok: true, asked: false, changed: true, initiative: out.initiative, ...(await rebuildView()) });
      return true;
    }

    // ---- edit the words ---------------------------------------------------------------------------------------------
    if (route === `${INITIATIVES_PATH}/update`) {
      const refused = unreadable();
      if (refused) {
        sendJson(res, 409, refused);
        return true;
      }
      const id = String(payload.id || "").trim();
      const existing = initiatives.initiativeById(id);
      if (!existing) {
        sendJson(res, 404, { error: `no such initiative: ${id || "(none)"}` });
        return true;
      }
      if (payload.title === undefined && payload.description === undefined && payload.tagIds === undefined) {
        sendJson(res, 400, { ok: false, error: "nothing to change: send a title, a description, a tag list, or several" });
        return true;
      }
      const by = actorOf(payload);
      if (initiativeAsks(tierOf(), "edit", { actor: by })) {
        const bits = [payload.title !== undefined ? "the title" : "", payload.description !== undefined ? "the description" : "", payload.tagIds !== undefined ? "the tags" : ""].filter(Boolean);
        const request = remoteWrites.request({
          kind: "initiative",
          worktree: "",
          project: "",
          title: `Edit initiative "${existing.title}"`,
          command: `edit initiative "${existing.title}" (${bits.join(" and ")})`,
          description: `${by === "reader" ? "you are" : `${by} is`} changing the words of an initiative on your map of the work. Nothing changes until you answer; Deny leaves it exactly as it is.`,
          allowed: ["once", "deny"],
          grants: false,
          resume: () => {
            const out = initiatives.update({ id: existing.id, title: payload.title, description: payload.description, tagIds: payload.tagIds, by });
            if (out.ok && out.changed !== false) onChange("edited");
            return out;
          },
        });
        log(`initiatives: asked (${request.id}) to edit "${existing.title}" as ${by}`);
        sendJson(res, 202, {
          ok: true,
          asked: true,
          id: request.id,
          deadline: request.deadline,
          timeoutSeconds: request.timeoutSeconds,
          action: "edit",
          initiative: { id: existing.id, title: existing.title },
          tier: tierOf(),
          note: "the question is in the dock, bottom right - the words change when you answer it",
        });
        return true;
      }
      const out = initiatives.update({ id: existing.id, title: payload.title, description: payload.description, tagIds: payload.tagIds, by });
      if (!out.ok) {
        sendJson(res, out.refused === "unreadable" ? 409 : 400, out);
        return true;
      }
      if (out.changed !== false) onChange("edited");
      log(`initiatives: "${out.initiative.title}" edited (${out.initiative.id}) by ${by}, not asked (tier ${tierOf()})`);
      sendJson(res, 200, { ok: true, asked: false, changed: out.changed !== false, initiative: out.initiative, ...(await rebuildView()) });
      return true;
    }

    // ---- the note log: add, edit, delete ---------------------------------------------------------------------------
    // One entry is appended, one is amended, one is removed, and every answer carries the whole document the next GET
    // would answer (the rebuild below), so a caller never has to re-read to find the note it just wrote. The store's
    // own refusals are the answers: 400 with its sentence for an empty note or an over-cap one, 404 for an initiative
    // or a note that does not exist.
    if (route === `${INITIATIVES_PATH}/notes/add` || route === `${INITIATIVES_PATH}/notes/edit` || route === `${INITIATIVES_PATH}/notes/delete`) {
      const refused = unreadable();
      if (refused) {
        sendJson(res, 409, refused);
        return true;
      }
      const id = String(payload.id || payload.initiative || "").trim();
      const existing = initiatives.initiativeById(id);
      if (!existing) {
        sendJson(res, 404, { ok: false, error: `no such initiative: ${id || "(none)"}` });
        return true;
      }
      const by = actorOf(payload);
      const verb = route.slice(`${INITIATIVES_PATH}/notes/`.length);
      const noteId = String(payload.note || payload.noteId || "").trim();
      if (verb !== "add" && !noteId) {
        sendJson(res, 400, { ok: false, error: `a note ${verb} needs the note id` });
        return true;
      }
      const out =
        verb === "add"
          ? initiatives.addNote({ initiative: id, text: payload.text, url: payload.url, label: payload.label, by })
          : verb === "edit"
            ? initiatives.editNote({ initiative: id, note: noteId, text: payload.text, label: payload.label, by })
            : initiatives.deleteNote({ initiative: id, note: noteId, by });
      if (!out.ok) {
        sendJson(res, out.notFound ? 404 : 400, out);
        return true;
      }
      const changed = out.changed !== false;
      if (changed) onChange(`note ${verb === "add" ? "added" : verb === "edit" ? "edited" : "deleted"}`);
      const did = verb === "add" ? "noted" : verb === "edit" ? "edited" : "deleted";
      const what = verb === "add" ? `${did} "${String(out.note?.text || "").replace(/\s+/g, " ").slice(0, 80)}" on` : `${did} a note on`;
      log(`initiatives: ${what} "${existing.title}" (${existing.id}) by ${by}${changed ? "" : " - nothing changed"}`);
      sendJson(res, verb === "add" && changed ? 201 : 200, {
        ok: true,
        asked: false,
        changed,
        ...(verb === "add" ? { duplicate: Boolean(out.duplicate), note: out.note } : {}),
        ...(verb === "edit" ? { note: out.note } : {}),
        ...(verb === "delete" ? { deleted: out.deleted } : {}),
        ...(await rebuildView()),
      });
      return true;
    }

    // ---- the reader's order -------------------------------------------------------------------------------------------
    // A REORDER IS NOT A MOVE. `/move` above attaches or detaches a TREE and can park a permission card; this route
    // moves the CARD, saves at once (the reader asked for no Save button), and never asks: the tier is about the map's
    // membership, not about the order the reader keeps his own list in. `to` is 1-based in the ACTIVE list, exactly the
    // waves route's contract, and the answer is the whole document the next GET would answer plus a plain `order` list
    // a caller can assert against without reading the fold.
    if (route === `${INITIATIVES_PATH}/reorder`) {
      const refused = unreadable();
      if (refused) {
        sendJson(res, 409, refused);
        return true;
      }
      const id = String(payload.id || "").trim();
      if (!id) {
        sendJson(res, 400, { ok: false, error: "a reorder needs the initiative id" });
        return true;
      }
      const existing = initiatives.initiativeById(id);
      if (!existing) {
        sendJson(res, 404, { ok: false, error: `no such initiative: ${id}` });
        return true;
      }
      if (existing.archivedAt) {
        sendJson(res, 409, { ok: false, error: `"${existing.title}" is archived - restore it before moving it in the list` });
        return true;
      }
      const by = actorOf(payload);
      const out = initiatives.reorder({ id, to: payload.to, by });
      if (out.notFound) {
        sendJson(res, 404, out);
        return true;
      }
      if (!out.ok) {
        sendJson(res, out.refused === "unreadable" ? 409 : 400, out);
        return true;
      }
      if (out.changed !== false) onChange("reordered");
      const view = await rebuildView();
      log(`initiatives: "${existing.title}" (${id}) moved to position ${out.to} by ${by}${out.changed === false ? " - already there" : ""}`);
      sendJson(res, 200, {
        ok: true,
        asked: false,
        changed: out.changed !== false,
        to: out.to,
        // The new order, plainly: the document below carries the same list folded, and this is the one line a caller
        // can assert a reorder against without reading the fold (the waves route's own answer shape).
        order: view.initiatives.map((init, at) => ({ id: init.id, position: at + 1 })),
        ...view,
      });
      return true;
    }

    // ---- the one write that asks ------------------------------------------------------------------------------------
    if (route === `${INITIATIVES_PATH}/move`) {
      const tree = String(payload.tree || payload.path || "").trim();
      const initiativeId = String(payload.initiative || payload.initiativeId || "").trim();
      const action = String(payload.action || "add").trim().toLowerCase();
      if (!tree) {
        sendJson(res, 400, { error: "a move needs the worktree's path" });
        return true;
      }
      if (action !== "add" && action !== "remove") {
        sendJson(res, 400, { error: `a move is add or remove, not ${action || "(none)"}` });
        return true;
      }
      // The store is re-read before a question: an unreadable file is a 409 now, not a card whose only answer is a
      // failure, and a membership that is already what was asked for changes nothing and asks nothing.
      const refusedMove = unreadable();
      if (refusedMove) {
        sendJson(res, 409, refusedMove);
        return true;
      }
      const rec = initiatives.initiativeById(initiativeId);
      if (!rec) {
        sendJson(res, 404, { error: `no such initiative: ${initiativeId || "(none)"}` });
        return true;
      }
      // An archived initiative is out of the map: a tree cannot be attached to it or taken out of it until it is back
      // in the list, so its saved membership is exactly what Restore returns.
      if (rec.archivedAt) {
        sendJson(res, 409, { ok: false, error: `"${rec.title}" is archived - restore it before moving a worktree in or out of it` });
        return true;
      }
      const has = initiatives.forTree(tree).some((i) => i.id === rec.id);
      if ((action === "add" && has) || (action === "remove" && !has)) {
        sendJson(res, 200, {
          ok: true,
          changed: false,
          initiative: { id: rec.id, title: rec.title },
          tree,
          note: action === "add" ? "that worktree is already in this initiative" : "that worktree is not in this initiative",
          ...(await rebuildView()),
        });
        return true;
      }
      const project = String(projectForPath(tree)?.name || "");
      const by = actorOf(payload);
      // WHO PUT THE TREE THERE decides the `own` level, so a detach reads the attachment's actor before it decides
      // whether to ask. An attach has no earlier attachment to judge; the level reads only the action.
      const attachedBy = action === "remove" ? initiatives.attachmentInfo(tree, rec.id)?.by || null : null;
      if (!initiativeAsks(tierOf(), action === "add" ? "attach" : "detach", { actor: by, attachedBy })) {
        const out = initiatives.move({ tree, initiative: rec.id, action, by });
        if (!out.ok) {
          sendJson(res, out.refused === "unreadable" ? 409 : 400, out);
          return true;
        }
        if (out.changed) onChange("moved");
        log(
          `initiatives: ${action === "add" ? "attached" : "detached"} ${tree.replace(/\\/g, "/")} ${action === "add" ? "to" : "from"} "${rec.title}" as ${by}, not asked (tier ${tierOf()})`,
        );
        sendJson(res, 200, {
          ok: true,
          asked: false,
          changed: out.changed !== false,
          initiative: { id: rec.id, title: rec.title },
          tree,
          action,
          ...(await rebuildView()),
        });
        return true;
      }
      const title = `${action === "add" ? "Add" : "Remove"} ${nameOf(tree)} ${action === "add" ? "to" : "from"} "${rec.title}"`;
      const request = remoteWrites.request({
        kind: "initiative",
        worktree: tree,
        project,
        title,
        command: `${action} ${tree.replace(/\\/g, "/")} ${action === "add" ? "to" : "from"} initiative "${rec.title}"`,
        description:
          "an initiative is your map of the work an assistant's task is only a proposal about: nothing changes until you answer. Deny leaves the map exactly as it is.",
        allowed: ["once", "deny"],
        // The answer is permission for THIS change, not a remote write: no push grant may be left behind by it.
        grants: false,
        resume: () => {
          const out = initiatives.move({ tree, initiative: rec.id, action, by });
          if (out.ok && out.changed) onChange("moved");
          return out;
        },
      });
      log(`initiatives: asked (${request.id}) to ${action} ${tree.replace(/\\/g, "/")} ${action === "add" ? "to" : "from"} "${rec.title}" as ${by}`);
      sendJson(res, 202, {
        ok: true,
        asked: true,
        id: request.id,
        deadline: request.deadline,
        timeoutSeconds: request.timeoutSeconds,
        initiative: { id: rec.id, title: rec.title },
        tree,
        action,
        note: "the question is in the dock, bottom right - the tree moves when you answer it",
      });
      return true;
    }

    // ---- archive: put it away, but only when nothing under it is open ----------------------------------------------
    // THE REFUSAL IS THE POINT OF THIS ROUTE (the reader's answer 2). The blocking rows are read from the SAME fold
    // the tab draws and the wave drive closes a wave from (archiveBlockers -> lib/waves.js waveIsOpen/waveMemberOpen),
    // built fresh for this request rather than from the memoised read: a task that started a second ago must refuse
    // the archive, and a document up to two seconds old would let it through. The answer names every blocking row by
    // id and title, so the reader knows exactly which card to close.
    if (route === `${INITIATIVES_PATH}/archive`) {
      const refused = unreadable();
      if (refused) {
        sendJson(res, 409, refused);
        return true;
      }
      const id = String(payload.id || "").trim();
      if (!id) {
        sendJson(res, 400, { ok: false, error: "an archive needs the initiative id" });
        return true;
      }
      const existing = initiatives.initiativeById(id);
      if (!existing) {
        sendJson(res, 404, { ok: false, error: `no such initiative: ${id}` });
        return true;
      }
      const by = actorOf(payload);
      if (existing.archivedAt) {
        sendJson(res, 200, { ok: true, asked: false, changed: false, note: `"${existing.title}" is already archived`, ...(await cachedView()) });
        return true;
      }
      // One fresh fold, used twice: its lanes are the rows the refusal names, and the write below is what the answer's
      // document draws. The document that answers is rebuilt after the write, so an archived initiative is absent from
      // the list the tab gets back in the very same breath.
      const fresh = await rebuildView();
      const entry = fresh.initiatives.find((init) => init.id === id) || null;
      if (!entry) {
        sendJson(res, 404, { ok: false, error: `no such initiative: ${id}` });
        return true;
      }
      const blockers = archiveBlockers(entry);
      if (blockers.length) {
        const names = blockers.map((b) => (b.kind === "wave" ? `wave ${b.id} "${b.title}"` : `#${b.id} "${b.title}"`));
        const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join("; ")} and ${names[names.length - 1]}`;
        const error = `"${existing.title}" cannot be archived while ${blockers.length === 1 ? "this is" : "these are"} still open: ${list} - close ${blockers.length === 1 ? "it" : "them"}, then archive again`;
        log(`initiatives: refused to archive "${existing.title}" (${id}) - ${blockers.map((b) => b.why).join("; ")}`);
        sendJson(res, 409, { ok: false, asked: false, changed: false, blocked: blockers, error, initiative: { id, title: existing.title } });
        return true;
      }
      const out = initiatives.archive({ id, by });
      if (!out.ok) {
        sendJson(res, out.refused === "unreadable" ? 409 : 400, out);
        return true;
      }
      if (out.changed) onChange("archived");
      log(`initiatives: archived "${existing.title}" (${id}) by ${by} - no wave or task under it was open`);
      sendJson(res, 200, {
        ok: true,
        asked: false,
        changed: out.changed !== false,
        archived: { id, title: existing.title, archivedAt: out.initiative?.archivedAt || null, archivedBy: out.initiative?.archivedBy || null },
        ...(await rebuildView()),
      });
      return true;
    }

    // ---- restore: back to the place the number names ---------------------------------------------------------------
    if (route === `${INITIATIVES_PATH}/restore`) {
      const refused = unreadable();
      if (refused) {
        sendJson(res, 409, refused);
        return true;
      }
      const id = String(payload.id || "").trim();
      if (!id) {
        sendJson(res, 400, { ok: false, error: "a restore needs the initiative id" });
        return true;
      }
      const existing = initiatives.initiativeById(id);
      if (!existing) {
        sendJson(res, 404, { ok: false, error: `no such initiative: ${id}` });
        return true;
      }
      const by = actorOf(payload);
      const out = initiatives.restore({ id, by });
      if (!out.ok) {
        sendJson(res, out.refused === "unreadable" ? 409 : 400, out);
        return true;
      }
      if (out.changed) onChange("restored");
      const view = await rebuildView();
      const back = view.initiatives.find((init) => init.id === id) || null;
      log(`initiatives: restored "${existing.title}" (${id}) by ${by}${back ? ` at position ${back.position}` : ""}`);
      sendJson(res, 200, {
        ok: true,
        asked: false,
        changed: out.changed !== false,
        restored: { id, title: existing.title, position: back ? back.position : null },
        ...view,
      });
      return true;
    }

    sendJson(res, 404, { error: `no such initiatives route: ${route}` });
    return true;
  };
}
