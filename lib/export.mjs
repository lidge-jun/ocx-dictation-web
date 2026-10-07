import { slugify } from "./util.mjs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";

export class VaultExportError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const TOKENS = new Set(["date", "time", "year", "month", "day", "course", "slug", "id"]);
const inside = (root, file) => {
  const relative = path.relative(root, file);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
const exists = async (file) => fs.lstat(file).then(() => true, (e) => {
  if (e.code === "ENOENT") return false;
  throw e;
});

function safeToken(value) {
  return String(value ?? "").normalize("NFC").replace(/[\\/:\x00-\x1f\x7f]+/g, "-")
    .replace(/\.\.+/g, "-").replace(/^\.+/, "").trim() || "general";
}

function fillTemplate(template, tokens) {
  if (typeof template !== "string" || !template || template.startsWith("~") ||
      path.posix.isAbsolute(template) || /^[A-Za-z]:/.test(template) || /[\\\x00-\x1f\x7f]/.test(template))
    throw new VaultExportError(400, "Invalid vault template");
  const segments = template.split("/");
  if (segments.some((seg) => !seg || seg === "." || seg === ".." || seg.startsWith(".")))
    throw new VaultExportError(400, "Invalid vault template");
  const filled = segments.map((seg) => {
    const names = [...seg.matchAll(/\{([^{}]+)\}/g)].map((match) => match[1]);
    if (names.some((name) => !TOKENS.has(name)) || /[{}]/.test(seg.replace(/\{[^{}]+\}/g, "")))
      throw new VaultExportError(400, "Invalid vault template");
    const part = seg.replace(/\{([^{}]+)\}/g, (_, name) => safeToken(tokens[name])).normalize("NFC");
    if (!part || part === "." || part === ".." || part.startsWith("."))
      throw new VaultExportError(400, "Invalid vault template");
    return part;
  });
  return filled.join("/");
}

async function checkedPath(root, relative) {
  const file = path.resolve(root, relative);
  if (!inside(root, file)) throw new VaultExportError(403, "Vault path escapes root");
  let current = root;
  const parts = path.relative(root, file).split(path.sep);
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    let stat;
    try { stat = await fs.lstat(current); }
    catch (e) { if (e.code === "ENOENT") break; throw e; }
    if (i === parts.length - 1 && stat.isSymbolicLink())
      throw new VaultExportError(403, "Vault destination is a symlink");
    const real = await fs.realpath(current);
    if (!inside(root, real)) throw new VaultExportError(403, "Vault path escapes root");
    if (i < parts.length - 1 && !stat.isDirectory() && !stat.isSymbolicLink())
      throw new VaultExportError(400, "Vault parent is not a directory");
  }
  return file;
}

export async function renderVaultPaths(vault, session, timezone) {
  const configured = vault.root === "~" ? os.homedir() :
    vault.root.startsWith("~/") ? path.join(os.homedir(), vault.root.slice(2)) : vault.root;
  let root;
  try { root = await fs.realpath(configured); }
  catch (e) { if (e.code === "ENOENT") throw new VaultExportError(400, "Vault root does not exist"); throw e; }
  if (!(await fs.stat(root)).isDirectory()) throw new VaultExportError(400, "Vault root is not a directory");
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit",
    day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  const fields = Object.fromEntries(date.formatToParts(new Date(session.meta.createdAt))
    .filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  const tokens = { date: `${fields.year}-${fields.month}-${fields.day}`,
    time: `${fields.hour}${fields.minute}${fields.second}`, year: fields.year, month: fields.month,
    day: fields.day, course: session.meta.course || "general", slug: slugify(session.meta.title), id: session.meta.id };
  const notePath = fillTemplate(vault.notePath, tokens);
  const rawPath = vault.rawPath === null ? null : fillTemplate(vault.rawPath, tokens);
  if (rawPath === notePath) throw new VaultExportError(400, "Vault paths must differ");
  const noteFile = await checkedPath(root, notePath);
  const rawFile = rawPath === null ? null : await checkedPath(root, rawPath);
  return { root, notePath, rawPath, noteFile, rawFile,
    exists: { note: await exists(noteFile), raw: rawFile === null ? false : await exists(rawFile) } };
}

const temporary = (file, type) => `${file}.${type}-${crypto.randomBytes(12).toString("hex")}`;
const markdownLink = (relative) => relative.split("/").map(encodeURIComponent).join("/");

export async function writeVaultExport({ vault, session, timezone, toMarkdown, transcriptText,
  includeRaw, overwrite = false, log, hooks = {} }) {
  let target = await renderVaultPaths(vault, session, timezone);
  if (includeRaw && !target.rawPath) throw new VaultExportError(400, "Raw path is disabled");
  const staged = [], backups = [], published = [];
  const bestEffort = async (fn) => {
    try { await fn(); }
    catch { log.warn("vault", "cleanup_leftover", { error: "cleanup_failed" }); }
  };
  async function stage(file, content) {
    const n = staged.length;
    if (hooks.beforeStage) await hooks.beforeStage(n);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await checkedPath(target.root, file.slice(target.root.length + 1));
    const tmp = temporary(file, "tmp");
    const handle = await fs.open(tmp, "wx", 0o600);
    staged.push(tmp);
    try {
      await handle.writeFile(content);
      if (hooks.afterCreate) await hooks.afterCreate(n);
      if (hooks.beforeSync) await hooks.beforeSync(n);
      await handle.sync();
    } finally { await handle.close(); }
    return tmp;
  }
  async function publish(tmp, file) {
    if (hooks.beforePublish) await hooks.beforePublish(file, published.length);
    // C review: only a regular file may be replaced (never a directory, symlink, socket, ...), in both modes.
    const existing = await fs.lstat(file).catch((e) => (e.code === "ENOENT" ? null : Promise.reject(e)));
    if (existing && !existing.isFile()) throw new VaultExportError(409, "Vault target is not a regular file");
    if (overwrite && existing) {
      const bak = temporary(file, "bak");
      await fs.rename(file, bak);
      backups.push({ file, bak });
    }
    if (overwrite) await fs.rename(tmp, file);
    else await fs.link(tmp, file);
    published.push(file);
  }
  async function rollback() {
    for (const file of published.reverse()) await fs.rm(file, { force: true });
    for (const { file, bak } of backups.reverse()) {
      if (hooks.beforeRestore) await hooks.beforeRestore(file, bak);
      await fs.rename(bak, file);
    }
  }
  try {
    const rawLink = includeRaw ? markdownLink(path.posix.relative(path.posix.dirname(target.notePath),
      target.rawPath)) : undefined;
    const note = toMarkdown(session, { rawLink, source: "refined" });
    const noteTmp = await stage(target.noteFile, note);
    const rawTmp = includeRaw ? await stage(target.rawFile, `${transcriptText(session, true, "raw")}\n`) : null;
    target = await renderVaultPaths(vault, session, timezone);
    await publish(noteTmp, target.noteFile);
    if (includeRaw) await publish(rawTmp, target.rawFile);
  } catch (err) {
    try { await rollback(); }
    catch (rollbackError) {
      // C review: never log or throw absolute vault paths; report vault-relative recovery locations only.
      const retained = backups.map(({ bak }) => path.relative(target.root, bak).split(path.sep).join("/")).join(", ");
      log.error("vault", "publication_failed", { error: err });
      log.error("vault", "rollback_failed", { error: rollbackError });
      throw new VaultExportError(500, `Vault rollback failed; backups kept in the vault: ${retained}`);
    }
    if (err.code === "EEXIST") throw new VaultExportError(409, "Vault file already exists");
    throw err;
  } finally {
    for (const file of staged) await bestEffort(async () => {
      if (hooks.cleanup) await hooks.cleanup(file);
      await fs.rm(file, { force: true });
    });
  }
  for (const { bak } of backups) await bestEffort(() => fs.rm(bak, { force: true }));
  return { notePath: target.notePath, rawPath: includeRaw ? target.rawPath : null };
}

export function createExport({ cfg, store, notes, time, http, log, hooks = {} }) {
  let vaultQueue = Promise.resolve();
  function vaultGate({ res, params, requestId }) {
    if (!cfg.vault) {
      http.send(res, 404, { error: "vault export not configured" });
      return true;
    }
    if (!store.get(params[0])) {
      http.send(res, 404, { error: "녹음을 찾을 수 없어요", requestId });
      return true;
    }
    return false;
  }
  async function vaultPreview({ res, params }) {
    const paths = await renderVaultPaths(cfg.vault, store.get(params[0]), cfg.timezone);
    return http.send(res, 200, { enabled: true, notePath: paths.notePath,
      rawPath: paths.rawPath, exists: paths.exists });
  }
  function vaultWrite({ res, params, body }) {
    if (Object.keys(body).some((key) => !["includeRaw", "overwrite"].includes(key)) ||
        (body.includeRaw !== undefined && typeof body.includeRaw !== "boolean") ||
        (body.overwrite !== undefined && typeof body.overwrite !== "boolean"))
      return http.send(res, 400, { error: "Invalid vault options" });
    const includeRaw = body.includeRaw ?? cfg.vault.includeRaw;
    const overwrite = body.overwrite ?? false;
    const task = () => store.withLock(params[0], async () => {
      const s = store.get(params[0]);
      if (!s) return http.send(res, 404, { error: "녹음을 찾을 수 없어요" });
      try {
        const result = await writeVaultExport({ vault: cfg.vault, session: s, timezone: cfg.timezone,
          toMarkdown, transcriptText, includeRaw, overwrite, log, hooks });
        const previous = s.meta.vaultExport;
        s.meta.vaultExport = { ...result, savedAt: new Date().toISOString() };
        try { await store.saveMeta(s); }
        catch (err) { s.meta.vaultExport = previous; throw err; }
        return http.send(res, 200, { ok: true, ...result });
      } catch (err) {
        if (err.status === 409) return http.send(res, 409, { error: "Vault file already exists" });
        throw err;
      }
    });
    const next = vaultQueue.then(task, task);
    vaultQueue = next.catch(() => {});
    return next;
  }
  const segText = (g, source = "refined") => (source === "raw" ? g.text : (g.refined ?? g.text));
  function transcriptLines(s, source = "refined") {
    return s.transcript.segments
      .filter((g) => g && segText(g, source))
      .sort((a, b) => a.index - b.index)
      .map((g) => ({ ...g, text: segText(g, source) }));
  }
  function hasRefined(s) {
    return s.transcript.segments.some((g) => g && g.refined != null);
  }
  function transcriptText(s, withTime = true, source = "refined") {
    return transcriptLines(s, source)
      .map((g) => (withTime ? `[${time.fmtTime(g.start)}] ${g.text}` : g.text))
      .join(withTime ? "\n\n" : "\n");
  }
  function toSrt(s, source = "refined") {
    const cues = [];
    for (const g of transcriptLines(s, source)) {
      const parts = [];
      for (const sent of g.text
        .split(/(?<=[.?!。？！])\s+/)
        .map((p) => p.trim())
        .filter(Boolean)) {
        let cur = "";
        for (const w of sent.split(/\s+/)) {
          if (cur && (cur + " " + w).length > 42) {
            parts.push(cur);
            cur = w;
          } else cur = cur ? `${cur} ${w}` : w;
        }
        if (cur) parts.push(cur);
      }
      const total = parts.reduce((a, p) => a + p.length, 0) || 1;
      let t = g.start;
      for (const p of parts) {
        const d = ((g.end - g.start) * p.length) / total;
        cues.push({ start: t, end: t + d, text: p });
        t += d;
      }
    }
    return cues.map((c, i) => `${i + 1}\n${time.fmtSrt(c.start)} --> ${time.fmtSrt(c.end)}\n${c.text}\n`).join("\n");
  }
  function toMarkdown(s, { rawLink, source = "refined" } = {}) {
    const m = s.meta,
      date = time.localDate(m.createdAt),
      out = [];
    out.push(
      `# ${m.course ? `${m.course} — ` : ""}${m.title}`,
      "",
      `날짜: ${date}. 길이: ${time.fmtTime(store.durationOf(s))}.`,
    );
    const refinedUsed = source !== "raw" && hasRefined(s);
    out.push(
      `원문: ${date} Lecture Notes Studio 받아쓰기 (${cfg.transcribeModel}${refinedUsed ? `, \
${cfg.refineModel} 정제본` : ""}).${rawLink ? ` [원문 대본](${rawLink})` : ""}`,
    );
    if (m.aiNoteInfo)
      out.push(
        `강의노트: ${m.aiNoteInfo.model}, 템플릿 ${m.aiNoteInfo.templateLabel}, \
${time.localDateTime(m.aiNoteInfo.generatedAt)} 생성. 대본 기반 요약이므로 강의 자료와 대조가 필요함.`,
      );
    out.push("");
    if (s.aiNote.trim()) out.push("---", "", s.aiNote.trim(), "");
    const nm = notes.notesBody(s);
    if (nm) out.push("---", "", "## 내 메모", "", nm, "");
    if (!rawLink)
      out.push(
        "---",
        "",
        refinedUsed ? "## 대본 (정제본)" : "## 대본",
        "",
        transcriptText(s, true, source) || "(대본 없음)",
        "",
      );
    return out.join("\n");
  }
  function getExport({ res, url, params, requestId }) {
    const s = store.get(params[0]);
    if (!s) return http.send(res, 404, { error: "녹음을 찾을 수 없어요", requestId });
    const fmt = url.searchParams.get("format") || "md",
      source = url.searchParams.get("source") || "refined";
    if (!["md", "txt", "srt"].includes(fmt) || !["raw", "refined"].includes(source))
      return http.send(res, 400, { error: "잘못된 내보내기 형식이에요" });
    const base = `${time.localDate(s.meta.createdAt)}-${slugify(s.meta.title)}`;
    const disp = (ext) => ({
      "Content-Disposition": `attachment; filename="${base.replace(/[^\x20-\x7e]/g, "_")}.\
${ext}"; filename*=UTF-8''${encodeURIComponent(base)}.${ext}`,
    });
    if (fmt === "txt")
      return http.send(res, 200, transcriptText(s, true, source), {
        ...disp("txt"),
        "Content-Type": "text/plain; charset=utf-8",
      });
    if (fmt === "srt")
      return http.send(res, 200, toSrt(s, source), {
        ...disp("srt"),
        "Content-Type": "application/x-subrip; charset=utf-8",
      });
    return http.send(res, 200, toMarkdown(s, { source }), {
      ...disp("md"),
      "Content-Type": "text/markdown; charset=utf-8",
    });
  }
  return { transcriptLines, hasRefined, transcriptText, toSrt, toMarkdown,
    handlers: { export: getExport, vaultGate, vaultPreview, vaultWrite } };
}
