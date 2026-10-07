import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { courseContext, normRefine } from "./prompts.mjs";
import { ID_RE, isCourseCode, readJsonSafe, writeJsonAtomic, writeTextAtomic } from "./util.mjs";

const PUBLIC_ERRORS = new Set([
  "받아쓰지 못했어요. 다시 시도해주세요",
  "받아쓰지 못했어요. 다시 시도해주세요 (OpenCodex가 돌아오면 자동으로 다시 받아써요)",
  "오디오를 처리하지 못했어요",
  "정제 결과를 검증하지 못해 원문을 유지했어요",
  "OpenCodex 연결이 끊겨 정제를 미뤘어요. 돌아오면 이어서 해요",
  "정제하지 못했어요",
]);
const GENERIC_PUBLIC_ERROR = "요청을 처리하지 못했어요";

function sanitizeStoredErrors(value) {
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    if (key === "error" && typeof entry === "string" && !PUBLIC_ERRORS.has(entry)) {
      value[key] = GENERIC_PUBLIC_ERROR;
    } else {
      sanitizeStoredErrors(entry);
    }
  }
}

export function createStore({ paths, prompts, time, http, emit, log,
  onSessionPatched = () => {}, renderNotesMd,
  writeJson = writeJsonAtomic, writeText = writeTextAtomic }) {
  const sessions = new Map(),
    locks = new Map();
  const sdir = (id) => {
    if (!ID_RE.test(id)) throw Object.assign(new Error("invalid id"), { status: 404 });
    return path.join(paths.sessionsDir, id);
  };
  const get = (id) => sessions.get(id);
  const values = () => sessions.values();
  function withLock(id, fn) {
    const next = (locks.get(id) || Promise.resolve()).then(fn, fn);
    locks.set(
      id,
      next.catch(() => {}),
    );
    return next;
  }
  async function loadAll() {
    fs.mkdirSync(paths.sessionsDir, { recursive: true });
    const reconcileMd = [];
    for (const id of fs.readdirSync(paths.sessionsDir)) {
      if (!ID_RE.test(id)) continue;
      const dir = sdir(id);
      if (!fs.lstatSync(dir).isDirectory()) {
        log.warn("store", "invalid_session_dir");
        continue;
      }
      const meta = readJsonSafe(path.join(dir, "meta.json"), null);
      if (!meta || meta.id !== id) continue;
      const transcript = readJsonSafe(path.join(dir, "transcript.json"), { segments: [] });
      const rawNotes = readJsonSafe(path.join(dir, "notes.json"), { lines: [] });
      if (!Array.isArray(transcript?.segments) || !Array.isArray(rawNotes?.lines)) continue;
      const revision = Number.isSafeInteger(rawNotes.revision) && rawNotes.revision >= 0
        ? rawNotes.revision : 0;
      const notes = { ...rawNotes, revision };
      sanitizeStoredErrors(meta);
      sanitizeStoredErrors(transcript.segments);
      let aiNote = "";
      try {
        aiNote = fs.readFileSync(path.join(dir, "ai-note.md"), "utf8");
      } catch {}
      const s = { meta, transcript, notes, aiNote };
      sessions.set(id, s);
      const mdFile = path.join(dir, "notes.md");
      let md = null;
      try { md = fs.readFileSync(mdFile, "utf8"); } catch {}
      const stamp = md && /^<!-- notes revision (\d+) -->\n/.exec(md);
      if (!stamp || Number(stamp[1]) !== revision) reconcileMd.push({ mdFile, s });
    }
    for (const { mdFile, s } of reconcileMd) {
      try {
        await writeText(mdFile, renderNotesMd(s));
        log.info("store", "notes_md_reconciled");
      } catch (error) {
        log.warn("store", "notes_md_reconcile_failed", { error });
      }
    }
  }
  async function saveMeta(s) {
    s.meta.updatedAt = new Date().toISOString();
    await writeJsonAtomic(path.join(sdir(s.meta.id), "meta.json"), s.meta);
  }
  async function saveTranscript(s) {
    await writeJsonAtomic(path.join(sdir(s.meta.id), "transcript.json"), s.transcript);
  }
  async function saveNotes(s, markdown) {
    await writeJson(path.join(sdir(s.meta.id), "notes.json"), s.notes);
    try { await writeText(path.join(sdir(s.meta.id), "notes.md"), markdown); }
    catch (error) { error.jsonCommitted = true; throw error; }
  }
  function segStats(s) {
    const st = { total: 0, done: 0, pending: 0, error: 0, silent: 0 };
    for (const seg of s.transcript.segments) {
      if (!seg) continue;
      st.total++;
      if (seg.status === "done") st.done++;
      else if (seg.status === "silent") st.silent++;
      else if (seg.status === "error") st.error++;
      else st.pending++;
    }
    return st;
  }
  function durationOf(s) {
    let d = 0;
    for (const seg of s.transcript.segments) if (seg && seg.end > d) d = seg.end;
    return Math.max(d, s.meta.duration || 0);
  }
  function summary(s) {
    return {
      id: s.meta.id,
      title: s.meta.title,
      course: s.meta.course,
      createdAt: s.meta.createdAt,
      updatedAt: s.meta.updatedAt,
      state: s.meta.state,
      source: s.meta.source,
      duration: durationOf(s),
      stats: segStats(s),
      hasAiNote: Boolean(s.aiNote),
      hasAudio: Boolean(s.meta.audioFile),
      refine: s.meta.refine || { enabled: false, interval: 300 },
      hasRefined: s.transcript.segments.some((g) => g && g.refined != null),
    };
  }
  function full(s) {
    return {
      ...summary(s),
      meta: s.meta,
      segments: s.transcript.segments.filter(Boolean),
      notes: s.notes,
      aiNote: s.aiNote,
    };
  }
  function sessionContext(s) {
    return courseContext(s.meta.course, prompts.course(s.meta.course), s.meta.glossary);
  }
  async function createSession({ title, course, glossary, language, source, refine } = {}) {
    course = course == null ? "" : course;
    if (!isCourseCode(course)) throw Object.assign(new Error("invalid course"), { status: 400 });
    const id = time.newId(),
      now = new Date().toISOString();
    const meta = {
      id,
      createdAt: now,
      updatedAt: now,
      title:
        String(title || "")
          .trim()
          .slice(0, 120) || `${time.localDate(now)} ${course || "녹음"}`,
      course,
      glossary: glossary != null ? String(glossary).slice(0, 4000) : prompts.course(course).glossary || "",
      language: String(language || "ko").slice(0, 8),
      state: source === "upload" ? "processing" : "recording",
      source: source || "live",
      duration: 0,
      audioFile: null,
      aiNoteInfo: null,
      refine: normRefine(refine && typeof refine === "object" ? refine : prompts.get().refineDefaults),
      refineWindows: {},
    };
    await fsp.mkdir(path.join(sdir(id), "segments"), { recursive: true });
    const s = { meta, transcript: { segments: [] }, notes: { revision: 0, lines: [] }, aiNote: "" };
    sessions.set(id, s);
    await saveMeta(s);
    await saveTranscript(s);
    await saveNotes(s, renderNotesMd(s));
    return s;
  }
  async function deleteSession(id) {
    const dir = sdir(id);
    const realRoot = await fsp.realpath(paths.sessionsDir),
      real = await fsp.realpath(dir);
    if (path.dirname(real) !== realRoot) throw Object.assign(new Error("invalid session dir"), { status: 404 });
    sessions.delete(id);
    await fsp.rm(real, { recursive: true, force: true });
    emit(id, { type: "deleted" });
  }
  const missing = (res, requestId) => http.send(res, 404, { error: "녹음을 찾을 수 없어요", requestId });
  async function listSessions({ res, url }) {
    const q = (url.searchParams.get("q") || "").trim().toLowerCase(),
      out = [];
    for (const s of sessions.values()) {
      let hit = null;
      if (q) {
        const hay = [s.meta.title, s.meta.course].join(" ").toLowerCase();
        if (!hay.includes(q)) {
          const seg = s.transcript.segments.find(
            (g) => g && ((g.text || "").toLowerCase().includes(q) || (g.refined || "").toLowerCase().includes(q)),
          );
          const note = !seg && (s.notes.lines || []).find((l) => (l.text || "").toLowerCase().includes(q));
          const ai = !seg && !note && s.aiNote.toLowerCase().includes(q);
          if (!seg && !note && !ai) continue;
          const src = seg
            ? (seg.refined || "").toLowerCase().includes(q)
              ? seg.refined
              : seg.text
            : note
              ? note.text
              : s.aiNote;
          const i = src.toLowerCase().indexOf(q);
          hit = {
            where: seg ? "대본" : note ? "메모" : "강의노트",
            t: seg ? seg.start : note ? note.t : null,
            snippet: src.slice(Math.max(0, i - 30), i + q.length + 40),
          };
        }
      }
      out.push({ ...summary(s), hit });
    }
    out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return http.send(res, 200, { sessions: out });
  }
  async function postSession({ res, body }) {
    return http.send(res, 201, full(await createSession({ ...body, source: "live" })));
  }
  function getSession({ res, params, requestId }) {
    const s = get(params[0]);
    return s ? http.send(res, 200, full(s)) : missing(res, requestId);
  }
  async function patchSession({ res, params, body, requestId }) {
    const id = params[0],
      s = get(id);
    if (!s) return missing(res, requestId);
    if (body.course !== undefined && !isCourseCode(body.course))
      throw Object.assign(new Error("invalid course"), { status: 400 });
    await withLock(id, async () => {
      if (typeof body.title === "string" && body.title.trim()) s.meta.title = body.title.trim().slice(0, 120);
      if (typeof body.course === "string") s.meta.course = body.course;
      if (typeof body.glossary === "string") s.meta.glossary = body.glossary.slice(0, 4000);
      if (typeof body.language === "string") s.meta.language = body.language.slice(0, 8);
      if (typeof body.state === "string" && ["recording", "paused", "processing"].includes(body.state))
        s.meta.state = body.state;
      if (body.refine && typeof body.refine === "object")
        s.meta.refine = normRefine({ ...(s.meta.refine || {}), ...body.refine });
      await saveMeta(s);
      if (typeof body.glossary === "string" && s.meta.course) prompts.setGlossary(s.meta.course, s.meta.glossary);
    });
    emit(id, { type: "meta", meta: s.meta, stats: segStats(s) });
    if (body.refine || body.state) onSessionPatched(id, s, Boolean(body.refine));
    return http.send(res, 200, full(s));
  }
  async function deleteSessionRoute({ res, params, requestId }) {
    if (!get(params[0])) return missing(res, requestId);
    await deleteSession(params[0]);
    return http.send(res, 200, { ok: true });
  }
  async function patchTranscript({ res, params, body, requestId }) {
    const id = params[0],
      s = get(id);
    if (!s) return missing(res, requestId);
    const seg = s.transcript.segments[body.index];
    if (!seg || typeof body.text !== "string") return http.send(res, 400, { error: "index와 text가 필요해요" });
    if (body.field === "refined") {
      seg.refined = body.text.slice(0, 20000);
      seg.refinedEdited = true;
    } else {
      seg.text = body.text.slice(0, 20000);
      seg.edited = true;
    }
    await withLock(id, () => saveTranscript(s));
    emit(id, { type: "segment", segment: seg });
    return http.send(res, 200, { ok: true });
  }
  return {
    loadAll,
    get,
    values,
    count: () => sessions.size,
    sdir,
    withLock,
    saveMeta,
    saveTranscript,
    saveNotes,
    segStats,
    durationOf,
    summary,
    full,
    createSession,
    deleteSession,
    sessionContext,
    handlers: {
      listSessions,
      createSession: postSession,
      getSession,
      patchSession,
      deleteSession: deleteSessionRoute,
      patchTranscript,
    },
  };
}
