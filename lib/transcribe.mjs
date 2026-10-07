import fsp from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import { buildTranscribePrompt, normRefine } from "./prompts.mjs";
import { pad } from "./time.mjs";
import { wavLevel } from "./audio.mjs";
const JUNK_PATTERNS = [
  /^(오늘도\s*)?(끝까지\s*)?(시청|구독|청취)해\s*주셔서\s*(정말\s*)?감사합니다[.!]?$/,
  /^(감사합니다[.!]?\s*)+$/,
  /^(MBC|KBS|SBS|YTN|JTBC)\s*뉴스.*$/,
  /^자막\s*(제공|by|제작).*$/i,
  /^(구독|좋아요|알림\s*설정).{0,20}(부탁|눌러).*$/,
  /^다음\s*(영상|시간)에서\s*(만나요|뵙겠습니다)[.!]?$/,
  /^(Thank you( for watching)?[.!]?\s*)+$/i,
];
export function cleanTranscript(text, prompt) {
  let t = String(text || "").trim();
  if (!t) return "";
  t = (t + " ").replace(/((?:\S+\s+){1,6}?)(?:\1){4,}/gu, "$1").trim();
  if (JUNK_PATTERNS.some((re) => re.test(t))) return "";
  if (prompt && t.length > 8 && prompt.includes(t)) return "";
  return t;
}
export function createTranscriber({ cfg, store, prompts, audio, sse, refiner, http, log }) {
  const queue = [],
    queued = new Set(),
    inFlight = new Set(),
    controllers = new Set(),
    sleepers = new Set();
  const outage = { open: false, since: null, probeDelay: 30000, timer: null };
  let active = 0,
    stopped = false,
    sweepTimer = null;
  const PUBLIC_ERROR = "받아쓰지 못했어요. 다시 시도해주세요";
  function delay(ms) {
    return new Promise((resolve) => {
      const wait = { resolve, timer: null };
      wait.timer = setTimeout(() => {
        sleepers.delete(wait);
        resolve();
      }, ms);
      sleepers.add(wait);
    });
  }
  const autoRetrySegments = () =>
    [...store.values()].flatMap((s) =>
      s.transcript.segments.filter((seg) => seg && seg.status === "error" && seg.autoRetry).map((seg) => [s, seg]),
    );
  function scheduleHeal() {
    if (!stopped && !outage.timer)
      outage.timer = setTimeout(() => {
        const job = heal();
        inFlight.add(job);
        job.finally(() => inFlight.delete(job)).catch((e) => log.error("transcribe", "heal_failed", { error: e }));
      }, outage.probeDelay);
  }
  function openOutage() {
    if (!outage.open) {
      outage.open = true;
      outage.since = new Date().toISOString();
      outage.probeDelay = 30000;
      log.warn("transcribe", "outage_open");
    }
    scheduleHeal();
  }
  function closeOutage() {
    outage.open = false;
    outage.since = null;
    outage.probeDelay = 30000;
    for (const [s, seg] of autoRetrySegments()) {
      seg.status = "pending";
      seg.error = null;
      sse.emit(s.meta.id, { type: "segment", segment: seg });
      enqueue(s.meta.id, seg.index);
    }
    if (!stopped) {
      clearTimeout(sweepTimer);
      sweepTimer = setTimeout(() => {
        sweepTimer = null;
        refiner.sweep();
      }, 2000);
    }
  }
  async function transcribeFile(filePath, { language, prompt, requestId }, opts = {}) {
    const data = await fsp.readFile(filePath),
      delays = [0, 1500, 4000, 10000, 20000].slice(0, opts.attempts || 5);
    for (let attempt = 0; attempt < delays.length; attempt++) {
      if (stopped) return { ok: false, error: PUBLIC_ERROR, transient: true };
      if (delays[attempt]) await delay(delays[attempt]);
      if (stopped) return { ok: false, error: PUBLIC_ERROR, transient: true };
      const controller = new AbortController();
      controllers.add(controller);
      const timeout = setTimeout(() => controller.abort(), 130000);
      try {
        const form = new FormData();
        form.append("file", new Blob([data], { type: "audio/wav" }), path.basename(filePath));
        form.append("model", cfg.transcribeModel);
        if (language) form.append("language", language);
        if (prompt) form.append("prompt", prompt.slice(-4000));
        form.append("response_format", "json");
        const res = await fetch(`${cfg.ocxBase}/v1/audio/transcriptions`, {
          method: "POST",
          headers: { Authorization: `Bearer ${cfg.ocxKey}` },
          body: form,
          signal: controller.signal,
        });
        if (res.ok) {
          const json = await res.json();
          return { ok: true, text: String(json.text || "") };
        }
        log.warn("transcribe", "upstream_failed", {
          requestId,
          attempt: attempt + 1,
          upstreamStatus: res.status,
          error: "upstream_http",
        });
        await res.body?.cancel();
        if (res.status >= 400 && res.status < 500 && ![408, 409, 425, 429].includes(res.status))
          return { ok: false, error: PUBLIC_ERROR, transient: false };
      } catch (err) {
        log.warn("transcribe", "upstream_failed", {
          requestId,
          attempt: attempt + 1,
          error: err.name === "AbortError" ? "upstream_timeout" : "upstream_unreachable",
        });
      } finally {
        clearTimeout(timeout);
        controllers.delete(controller);
      }
      if (outage.open && !opts.probe) break;
    }
    return { ok: false, error: PUBLIC_ERROR, transient: true };
  }
  async function heal() {
    outage.timer = null;
    if (stopped) return;
    const list = autoRetrySegments();
    if (!list.length) {
      closeOutage();
      return;
    }
    if (active || queue.length) {
      scheduleHeal();
      return;
    }
    const [s, seg] = list[0];
    const r = await transcribeFile(
      path.join(store.sdir(s.meta.id), "segments", seg.file),
      { language: s.meta.language, prompt: buildPrompt(s, seg.index) },
      { probe: true, attempts: 1 },
    );
    if (r.ok || !r.transient) closeOutage();
    else {
      outage.probeDelay = Math.min(300000, outage.probeDelay * 2);
      scheduleHeal();
    }
  }
  function buildPrompt(s, index) {
    const prev = s.transcript.segments[index - 1];
    return buildTranscribePrompt({
      base: prompts.get().base.transcribe,
      context: store.sessionContext(s),
      prevTail: prev && (prev.refined ?? prev.text),
    });
  }
  async function runJob({ id, index, requestId }) {
    const s = store.get(id);
    if (!s) return;
    const seg = s.transcript.segments[index];
    if (!seg || ["done", "silent"].includes(seg.status)) return;
    seg.status = "transcribing";
    seg.error = null;
    sse.emit(id, { type: "segment", segment: seg });
    const file = path.join(store.sdir(id), "segments", seg.file);
    let level = null;
    try {
      level = wavLevel(await fsp.readFile(file));
    } catch {}
    if (level && level.peak < 0.01) {
      await store.withLock(id, async () => {
        seg.status = "silent";
        seg.silent = true;
        seg.text = "";
        seg.error = null;
        seg.autoRetry = false;
        seg.updatedAt = new Date().toISOString();
        await store.saveTranscript(s);
      });
    } else {
      const prompt = buildPrompt(s, index),
        result = await transcribeFile(file, { language: s.meta.language, prompt, requestId });
      if (!store.get(id)) return;
      if (result.ok && outage.open) closeOutage();
      else if (!result.ok && result.transient && !stopped) openOutage();
      await store.withLock(id, async () => {
        if (result.ok) {
          seg.text = cleanTranscript(result.text, prompt);
          seg.status = "done";
          seg.error = null;
          seg.autoRetry = false;
        } else {
          seg.status = "error";
          seg.error = PUBLIC_ERROR + (result.transient ? " (OpenCodex가 돌아오면 자동으로 다시 받아써요)" : "");
          seg.autoRetry = Boolean(result.transient);
        }
        seg.updatedAt = new Date().toISOString();
        await store.saveTranscript(s);
      });
    }
    sse.emit(id, { type: "segment", segment: seg });
    const stats = store.segStats(s);
    sse.emit(id, { type: "stats", stats, duration: store.durationOf(s) });
    if (s.meta.state === "processing" && !stats.pending) {
      s.meta.state = "ready";
      await store.saveMeta(s);
      sse.emit(id, { type: "meta", meta: s.meta, stats });
    }
    refiner.check(id);
  }
  function pump() {
    while (!stopped && active < cfg.concurrency && queue.length) {
      const job = queue.shift();
      active++;
      const p = runJob(job)
        .catch((e) => log.error("transcribe", "job_failed", { error: e }))
        .finally(() => {
          active--;
          queued.delete(job.key);
          inFlight.delete(p);
          pump();
        });
      inFlight.add(p);
    }
  }
  function enqueue(id, index, requestId) {
    if (stopped) return;
    const key = `${id}:${index}`;
    if (queued.has(key)) return;
    queued.add(key);
    queue.push({ id, index, key, requestId });
    pump();
  }
  function resume() {
    for (const s of store.values()) {
      for (const file of ["audio.tmp.ogg", "concat.txt"])
        fs.rmSync(path.join(store.sdir(s.meta.id), file), { force: true });
      for (const w of Object.values(s.meta.refineWindows || {}))
        for (const st of Object.values(w)) if (st.status === "running") st.status = "error";
      for (const seg of s.transcript.segments)
        if (seg && (["pending", "transcribing"].includes(seg.status) || (seg.status === "error" && seg.autoRetry))) {
          seg.status = "pending";
          seg.error = null;
          enqueue(s.meta.id, seg.index);
        }
    }
    if (autoRetrySegments().length) scheduleHeal();
  }
  function stopAccepting() {
    stopped = true;
    clearTimeout(outage.timer);
    outage.timer = null;
    clearTimeout(sweepTimer);
    sweepTimer = null;
    for (const wait of sleepers) {
      clearTimeout(wait.timer);
      wait.resolve();
    }
    sleepers.clear();
    queue.length = 0;
  }
  const drain = () => Promise.allSettled([...inFlight]);
  function abort() {
    for (const c of controllers) c.abort();
  }
  async function processUpload(s, srcPath) {
    const id = s.meta.id;
    try {
      sse.emit(id, { type: "status", message: "오디오를 나누는 중이에요" });
      const files = await audio.splitUpload(s, srcPath, async (splitFiles) => {
        let t = 0;
        await store.withLock(id, async () => {
          for (let i = 0; i < splitFiles.length; i++) {
            const st = await fsp.stat(path.join(store.sdir(id), "segments", splitFiles[i]));
            const dur = audio.wavDuration(st.size);
            s.transcript.segments[i] = {
              index: i,
              file: splitFiles[i],
              start: t,
              end: t + dur,
              status: "pending",
              text: "",
              error: null,
              silent: false,
            };
            t += dur;
          }
          s.meta.duration = t;
          await store.saveTranscript(s);
          await store.saveMeta(s);
        });
        sse.emit(id, { type: "reload" });
        sse.emit(id, { type: "status", message: "재생용 오디오를 만드는 중이에요" });
      });
      s.meta.audioFile = "audio.ogg";
      await store.saveMeta(s);
      await fsp.rm(srcPath, { force: true });
      sse.emit(id, { type: "meta", meta: s.meta, stats: store.segStats(s) });
      for (let i = 0; i < files.length; i++) enqueue(id, i);
    } catch (err) {
      log.error("upload", "process_failed", { error: err });
      s.meta.state = "error";
      s.meta.error = "오디오를 처리하지 못했어요";
      await store.saveMeta(s);
      sse.emit(id, { type: "meta", meta: s.meta, stats: store.segStats(s) });
    }
  }
  const missing = (res, requestId) => http.send(res, 404, { error: "녹음을 찾을 수 없어요", requestId });
  async function health({ res }) {
    let ocx = "down",
      version = null;
    try {
      const r = await fetch(`${cfg.ocxBase}/healthz`, { signal: AbortSignal.timeout(3000) });
      const j = await r.json();
      ocx = j.status === "ok" ? "ok" : "down";
      version = j.version || null;
    } catch {}
    return http.send(res, 200, {
      ok: true,
      ocx,
      ocxVersion: version,
      keyConfigured: Boolean(cfg.ocxKey),
      transcribeModel: cfg.transcribeModel,
      queue: queue.length + active,
      outage: outage.open ? { since: outage.since, waiting: autoRetrySegments().length } : null,
    });
  }
  async function segment({ res, url, params, body, requestId }) {
    const id = params[0],
      s = store.get(id);
    if (!s) return missing(res, requestId);
    const indexRaw = url.searchParams.get("index"),
      startRaw = url.searchParams.get("start"),
      index = Number(indexRaw),
      start = Number(startRaw),
      silent = url.searchParams.get("silent") === "1";
    if (
      !/^(?:0|[1-9][0-9]{0,5})$/.test(indexRaw || "") ||
      index > 100000 ||
      !Number.isFinite(start) ||
      startRaw === null ||
      start < 0
    )
      return http.send(res, 400, { error: "index와 start가 필요해요" });
    if (body.length < 44 || body.toString("ascii", 0, 4) !== "RIFF" || body.toString("ascii", 8, 12) !== "WAVE")
      return http.send(res, 400, { error: "WAV 형식이 아니에요" });
    const file = `s${pad(index, 5)}.wav`,
      dur = audio.wavDuration(body.length);
    let seg;
    await store.withLock(id, async () => {
      const existing = s.transcript.segments[index];
      if (existing && existing.bytes === body.length && ["done", "silent", "transcribing"].includes(existing.status)) {
        seg = existing;
        return;
      }
      await fsp.writeFile(path.join(store.sdir(id), "segments", file), body);
      seg = {
        index,
        file,
        start,
        end: start + dur,
        bytes: body.length,
        status: silent ? "silent" : "pending",
        text: "",
        error: null,
        silent,
        updatedAt: new Date().toISOString(),
      };
      s.transcript.segments[index] = seg;
      if (["ready", "stopped"].includes(s.meta.state)) s.meta.state = "processing";
      await store.saveTranscript(s);
    });
    sse.emit(id, { type: "segment", segment: seg });
    if (seg.status === "pending") enqueue(id, index, requestId);
    return http.send(res, 202, { stored: true, index, status: seg.status });
  }
  async function retrySegment({ res, params, requestId }) {
    const [id, n] = params,
      s = store.get(id);
    if (!s) return missing(res, requestId);
    const seg = s.transcript.segments[Number(n)];
    if (!seg) return http.send(res, 404, { error: "구간을 찾을 수 없어요" });
    seg.status = "pending";
    seg.error = null;
    await store.withLock(id, () => store.saveTranscript(s));
    sse.emit(id, { type: "segment", segment: seg });
    enqueue(id, seg.index, requestId);
    return http.send(res, 202, { ok: true });
  }
  async function retryFailed({ res, params, requestId }) {
    const id = params[0],
      s = store.get(id);
    if (!s) return missing(res, requestId);
    let n = 0;
    for (const seg of s.transcript.segments)
      if (seg && seg.status === "error") {
        seg.status = "pending";
        seg.error = null;
        enqueue(id, seg.index, requestId);
        n++;
        sse.emit(id, { type: "segment", segment: seg });
      }
    await store.withLock(id, () => store.saveTranscript(s));
    return http.send(res, 202, { retried: n });
  }
  async function refine({ res, params, body, requestId }) {
    const id = params[0],
      s = store.get(id);
    if (!s) return missing(res, requestId);
    if (!s.meta.refine?.enabled) {
      s.meta.refine = normRefine({ ...(s.meta.refine || {}), enabled: true });
      await store.saveMeta(s);
    }
    if (outage.open) return http.send(res, 503, { error: "OpenCodex가 응답하지 않아요. 돌아오면 자동으로 정제해요" });
    const r = await refiner.rerun(id, { window: Number.isInteger(body.window) ? body.window : undefined });
    sse.emit(id, { type: "refine", refine: s.meta.refine, windows: refiner.winState(s) });
    return http.send(res, 202, r);
  }
  async function upload({ req, res, url, requestId }) {
    const name = url.searchParams.get("filename") || "upload.bin",
      ext = (path
        .extname(name)
        .toLowerCase()
        .match(/^\.[a-z0-9]{1,6}$/) || [".bin"])[0];
    const s = await store.createSession({
      title: url.searchParams.get("title") || path.basename(name, path.extname(name)),
      course: url.searchParams.get("course") || "",
      glossary: url.searchParams.get("glossary") ?? undefined,
      language: url.searchParams.get("language") || "ko",
      source: "upload",
    });
    const src = path.join(store.sdir(s.meta.id), `source${ext}`);
    try {
      await http.receiveUpload(req, src);
    } catch (err) {
      await store.deleteSession(s.meta.id);
      if (err.status === 413) throw err;
      log.warn("upload", "receive_failed", { requestId, error: err });
      return http.send(res, 500, { error: "파일을 받지 못했어요" });
    }
    const dur = await audio.probeDuration(src);
    if (!dur) {
      await store.deleteSession(s.meta.id);
      return http.send(res, 415, {
        error: "오디오로 읽을 수 없는 파일이에요. mp3, m4a, wav, webm 같은 오디오 파일을 올려주세요.",
      });
    }
    s.meta.duration = dur;
    s.meta.originalName = name;
    await store.saveMeta(s);
    const job = processUpload(s, src).catch((e) => log.error("upload", "process_failed", { error: e }));
    inFlight.add(job);
    job.finally(() => inFlight.delete(job)).catch(() => {});
    return http.send(res, 201, store.full(s));
  }
  return {
    enqueue,
    resume,
    runJob,
    processUpload,
    openOutage,
    stopAccepting,
    drain,
    abort,
    get queueDepth() {
      return queue.length + active;
    },
    get outage() {
      return outage;
    },
    handlers: { health, segment, retrySegment, retryFailed, refine, upload },
  };
}
