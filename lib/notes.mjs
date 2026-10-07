import crypto from "node:crypto";
import { fmtTime } from "./time.mjs";
export function notesToMarkdown(s) {
  return `<!-- notes revision ${noteRevision(s.notes)} -->\n${notesBody(s)}`;
}
export function notesBody(s) {
  return (s.notes.lines || [])
    .filter((l) => (l.text || "").trim() || l.important)
    .map((l) => `- [${fmtTime(l.t || 0)}]${l.important ? " **(중요)**" : ""} ${(l.text || "").trim()}`.trimEnd())
    .join("\n");
}
export function noteRevision(notes) {
  return Number.isSafeInteger(notes?.revision) && notes.revision >= 0 ? notes.revision : 0;
}
export function createNotes({ store, sse, http, log }) {
  async function save(id, body, tabId = null) {
    if (!Array.isArray(body?.lines) || body.lines.length > 5000)
      throw Object.assign(new Error("lines"), { status: 400 });
    const hasBase = Object.hasOwn(body, "baseRevision");
    if (hasBase && (!Number.isSafeInteger(body.baseRevision) || body.baseRevision < 0))
      throw Object.assign(new Error("baseRevision"), { status: 400 });
    const lines = body.lines.map((l) => {
      if (
        !l ||
        typeof l !== "object" ||
        Array.isArray(l) ||
        Object.keys(l).some((k) => !["id", "t", "text", "important"].includes(k)) ||
        (l.id !== undefined && (typeof l.id !== "string" || l.id.length > 40)) ||
        typeof l.text !== "string" ||
        l.text.length > 4000 ||
        typeof l.t !== "number" ||
        !Number.isFinite(l.t) ||
        l.t < 0 ||
        (l.important !== undefined && typeof l.important !== "boolean")
      )
        throw Object.assign(new Error("line"), { status: 400 });
      return { id: l.id || crypto.randomUUID(), t: l.t, text: l.text, important: l.important || false };
    });
    const s = store.get(id);
    if (!s) throw Object.assign(new Error("missing"), { status: 404 });
    return store.withLock(id, async () => {
      const current = noteRevision(s.notes);
      if (hasBase && body.baseRevision !== current)
        return { status: 409, body: { error: "conflict", revision: current, lines: s.notes.lines } };
      const previous = s.notes;
      s.notes = { revision: current + 1, lines };
      try { await store.saveNotes(s, notesToMarkdown(s)); }
      catch (error) {
        if (!error.jsonCommitted) { s.notes = previous; throw error; }
        log?.warn("notes", "notes_md_write_failed", { error });
      }
      const savedAt = new Date().toISOString();
      sse.emit(id, { type: "notes", revision: s.notes.revision, lines, by: tabId });
      return { status: 200, body: { ok: true, revision: s.notes.revision, savedAt } };
    });
  }
  async function putNotes({ req, res, params, body }) {
    const tabId = req.headers["x-tab-id"];
    if (tabId !== undefined && (typeof tabId !== "string" || !tabId || tabId.length > 128))
      throw Object.assign(new Error("invalid tab id"), { status: 400 });
    const result = await save(params[0], body, tabId ?? null);
    return http.send(res, result.status, result.body);
  }
  return { save, notesToMarkdown, notesBody, handlers: { putNotes } };
}
