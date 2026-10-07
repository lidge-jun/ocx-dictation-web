import fsp from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";

export function wavDataOffset(buf) {
  let o = 12;
  while (o + 8 <= buf.length) {
    const id = buf.toString("ascii", o, o + 4),
      size = buf.readUInt32LE(o + 4);
    if (id === "data") return o + 8;
    o += 8 + size + (size & 1);
  }
  return 44;
}
export function wavLevel(buf) {
  const off = wavDataOffset(buf),
    n = Math.floor((buf.length - off) / 2);
  if (n <= 0) return { peak: 0, rms: 0 };
  let peak = 0,
    sq = 0;
  for (let i = 0; i < n; i++) {
    const v = buf.readInt16LE(off + i * 2) / 32768,
      a = Math.abs(v);
    if (a > peak) peak = a;
    sq += v * v;
  }
  return { peak, rms: Math.sqrt(sq / n) };
}
export function wavDuration(bytes) {
  return Math.max(0, (bytes - 44) / 32000);
}
export function createAudio({ cfg, store, sse, http, log }) {
  const children = new Set(),
    running = new Set(),
    finalizing = new Map();
  function exec(command, args) {
    let child;
    const job = new Promise((resolve, reject) => {
      child = execFile(command, args, { maxBuffer: 1 << 24 }, (error, stdout) =>
        error ? reject(error) : resolve({ stdout }),
      );
      children.add(child);
      child.once("exit", () => children.delete(child));
    });
    running.add(job);
    job.finally(() => running.delete(job)).catch(() => {});
    return job;
  }
  async function probeDuration(file) {
    try {
      const { stdout } = await exec(cfg.ffprobePath, [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=nw=1:nk=1",
        file,
      ]);
      return parseFloat(stdout.trim()) || 0;
    } catch {
      return 0;
    }
  }
  async function buildAudio(s) {
    const dir = store.sdir(s.meta.id),
      segs = s.transcript.segments.filter(Boolean).sort((a, b) => a.index - b.index);
    if (!segs.length) return null;
    const list = segs.map((g) => `file '${path.join(dir, "segments", g.file).replace(/'/g, "'\\''")}'`).join("\n");
    const listFile = path.join(dir, "concat.txt"),
      out = path.join(dir, "audio.ogg"),
      tmp = path.join(dir, "audio.tmp.ogg");
    await fsp.writeFile(listFile, list);
    try {
      await exec(cfg.ffmpegPath, [
        "-y",
        "-loglevel",
        "error",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        listFile,
        "-c:a",
        "libopus",
        "-b:a",
        "32k",
        "-ac",
        "1",
        "-application",
        "voip",
        "-compression_level",
        "5",
        tmp,
      ]);
      await fsp.rename(tmp, out);
    } finally {
      await fsp.rm(listFile, { force: true });
      await fsp.rm(tmp, { force: true });
    }
    return "audio.ogg";
  }
  async function splitUpload(s, srcPath, onSegments) {
    const segDir = path.join(store.sdir(s.meta.id), "segments");
    await exec(cfg.ffmpegPath, [
      "-y",
      "-loglevel",
      "error",
      "-i",
      srcPath,
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-c:a",
      "pcm_s16le",
      "-f",
      "segment",
      "-segment_time",
      "60",
      "-reset_timestamps",
      "1",
      path.join(segDir, "u%05d.wav"),
    ]);
    const files = (await fsp.readdir(segDir)).filter((f) => /^u\d{5}\.wav$/.test(f)).sort();
    await onSegments(files);
    const out = path.join(store.sdir(s.meta.id), "audio.ogg");
    await exec(cfg.ffmpegPath, [
      "-y",
      "-loglevel",
      "error",
      "-i",
      srcPath,
      "-vn",
      "-ac",
      "1",
      "-c:a",
      "libopus",
      "-b:a",
      "32k",
      out,
    ]);
    return files;
  }
  const missing = (res, requestId) => http.send(res, 404, { error: "녹음을 찾을 수 없어요", requestId });
  async function segmentAudio({ req, res, params, requestId }) {
    const s = store.get(params[0]);
    if (!s) return missing(res, requestId);
    const seg = s.transcript.segments[Number(params[1])];
    if (!seg || !/^[su]\d{5}\.wav$/.test(seg.file)) return http.send(res, 404, { error: "구간을 찾을 수 없어요" });
    const root = path.join(store.sdir(params[0]), "segments");
    return http.serveFile(req, res, path.join(root, seg.file), "audio/wav", root);
  }
  async function audio({ req, res, params, requestId }) {
    const s = store.get(params[0]);
    if (!s) return missing(res, requestId);
    if (!s.meta.audioFile) return http.send(res, 404, { error: "아직 합친 오디오가 없어요" });
    return http.serveFile(
      req,
      res,
      path.join(store.sdir(params[0]), s.meta.audioFile),
      "audio/ogg",
      store.sdir(params[0]),
    );
  }
  async function finalize({ res, params, requestId }) {
    const id = params[0],
      s = store.get(id);
    if (!s) return missing(res, requestId);
    try {
      let job = finalizing.get(id);
      if (!job) {
        job = buildAudio(s).finally(() => finalizing.delete(id));
        finalizing.set(id, job);
      }
      s.meta.audioFile = await job;
      s.meta.duration = store.durationOf(s);
      const st = store.segStats(s);
      s.meta.state = st.pending ? "processing" : "ready";
      await store.saveMeta(s);
      sse.emit(id, { type: "meta", meta: s.meta, stats: st });
      return http.send(res, 200, store.full(s));
    } catch (err) {
      log.warn("audio", "finalize_failed", { requestId, error: err });
      return http.send(res, 500, { error: "오디오를 합치지 못했어요" });
    }
  }
  return {
    probeDuration,
    buildAudio,
    splitUpload,
    wavDuration,
    wavLevel,
    drain: () => Promise.allSettled([...running]),
    terminate: () => {
      for (const child of children) child.kill("SIGTERM");
    },
    handlers: { segmentAudio, audio, finalize },
  };
}
