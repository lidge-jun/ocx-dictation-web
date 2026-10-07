// Lecture Notes Studio: local recorder and OpenCodex client.
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePaths } from "./lib/paths.mjs";
import { loadConfig, publicConfig } from "./lib/config.mjs";
import { createLogger } from "./lib/log.mjs";
import { createTime } from "./lib/time.mjs";
import { createStore } from "./lib/store.mjs";
import { createSse } from "./lib/sse.mjs";
import { createAudio } from "./lib/audio.mjs";
import { createTranscriber } from "./lib/transcribe.mjs";
import { createNotes, notesToMarkdown } from "./lib/notes.mjs";
import { writeJsonAtomic, writeTextAtomic } from "./lib/util.mjs";
import { createAi } from "./lib/ai.mjs";
import { createExport } from "./lib/export.mjs";
import { createHttp } from "./lib/http.mjs";
import { createRoutes } from "./lib/routes.mjs";
import { createPromptStore } from "./lib/prompts.mjs";
import { createRefiner } from "./lib/refine.mjs";

export async function startServer(cfg, paths, internal = {}) {
  const log =
    internal.log || createLogger({ level: process.env.LOG_LEVEL, format: process.env.LOG_FORMAT, secret: cfg.ocxKey });
  const httpKit = createHttp({ log, limits: internal.limits });
  const time = createTime(cfg.timezone);
  let store, sse, transcriber, refiner;
  const prompts = createPromptStore({
    file: paths.promptsFile,
    legacyCoursesFile: path.join(paths.dataDir, "courses.json"),
    getSessions: () => store.values(),
    saveMeta: (s) => store.saveMeta(s),
    sessionContext: (s) => store.sessionContext(s),
    http: httpKit,
    cfg,
    log,
  });
  store = createStore({
    paths,
    prompts,
    time,
    http: httpKit,
    emit: (...args) => sse.emit(...args),
    onSessionPatched: (id, s, refineChanged) => {
      refiner.check(id);
      if (refineChanged) sse.emit(id, { type: "refine", refine: s.meta.refine, windows: refiner.winState(s) });
    },
    log,
    renderNotesMd: notesToMarkdown,
    writeJson: internal.writeJson ?? writeJsonAtomic,
    writeText: internal.writeText ?? writeTextAtomic,
  });
  sse = createSse({ store, http: httpKit, log });
  const audio = createAudio({ cfg, paths, store, sse, http: httpKit, log });
  const notes = createNotes({ store, sse, time, http: httpKit, log });
  const exporter = createExport({ cfg, store, notes, time, http: httpKit, log, hooks: internal.vaultHooks });
  const ai = createAi({ cfg, paths, store, prompts, sse, notes, exporter, http: httpKit, log });
  refiner = createRefiner({
    getSession: store.get,
    allSessions: store.values,
    saveTranscript: store.saveTranscript,
    saveMeta: store.saveMeta,
    emit: sse.emit,
    withLock: store.withLock,
    chat: ai.chatOnce,
    outage: {
      get open() {
        return transcriber.outage.open;
      },
      markDown: () => transcriber.openOutage(),
    },
    promptsFor: (s) => ({ base: prompts.get().base.refine, context: store.sessionContext(s) }),
    model: cfg.refineModel,
    log,
  });
  transcriber = createTranscriber({ cfg, store, prompts, audio, sse, refiner, http: httpKit, log });
  const routes = createRoutes({
    cfg,
    publicConfig,
    paths,
    store,
    prompts,
    sse,
    audio,
    transcriber,
    notes,
    ai,
    exporter,
    refiner,
    http: httpKit,
  });
  await store.loadAll();
  let actualPort = 0;
  const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");
  const server = http.createServer((req, res) =>
    httpKit.handle(req, res, { port: actualPort, publicDir, paths, routes }),
  );
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(cfg.port, cfg.host, () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (e) {
    transcriber.stopAccepting();
    refiner.stop();
    ai.stop();
    sse.shutdown();
    throw e;
  }
  actualPort = server.address().port;
  transcriber.resume();
  refiner.sweep();
  log.info("server", "listening", { port: actualPort, sessions: store.count() });
  let closing;
  async function close() {
    if (closing) return closing;
    closing = (async () => {
      const stopped = new Promise((resolve) => server.close(resolve));
      server.closeIdleConnections();
      sse.shutdown();
      transcriber.stopAccepting();
      ai.stop();
      refiner.stop();
      const settled = Promise.allSettled([transcriber.drain(), audio.drain(), refiner.drain(), ai.drain()]);
      let timeoutId;
      const timeout = new Promise((resolve) => {
        timeoutId = setTimeout(resolve, 10_000, "timeout");
      });
      const result = await Promise.race([settled.then(() => "drained"), timeout]);
      clearTimeout(timeoutId);
      if (result === "timeout") {
        log.warn("server", "drain_timeout");
        transcriber.abort();
        audio.terminate();
        server.closeAllConnections();
      }
      await stopped;
      log.info("server", "closed");
    })();
    return closing;
  }
  // The CLI imports startServer; only its direct invocation owns process signals.
  if (process.argv[1] && path.basename(process.argv[1]) === "ocx-dictation.mjs" && !internal.noSignals) {
    for (const signal of ["SIGINT", "SIGTERM"])
      process.once(signal, () =>
        close().then(
          () => {
            process.exitCode = 0;
          },
          (err) => {
            log.error("server", "shutdown_failed", { error: err });
            process.exitCode = 1;
          },
        ),
      );
  }
  return { server, close };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const paths = resolvePaths({
    env: process.env,
    appDir: path.dirname(fileURLToPath(import.meta.url)),
    homedir: os.homedir(),
  });
  const cfg = loadConfig({ paths, env: process.env });
  const runtime = await startServer(cfg, paths);
  const log = createLogger({ level: process.env.LOG_LEVEL, format: process.env.LOG_FORMAT, secret: cfg.ocxKey });
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () =>
      runtime.close().then(
        () => {
          process.exitCode = 0;
        },
        (err) => {
          log.error("server", "shutdown_failed", { error: err });
          process.exitCode = 1;
        },
      ),
    );
  process.on("unhandledRejection", (reason) => log.error("process", "unhandled_rejection", { error: reason }));
  process.on("uncaughtException", (err) => {
    log.error("process", "uncaught_exception", { error: err });
    runtime.close().finally(() => {
      process.exitCode = 1;
    });
  });
}
