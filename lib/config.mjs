import fs from "node:fs";

const DEFAULTS = Object.freeze({
  port: 10210,
  host: "127.0.0.1",
  ocxBase: "http://127.0.0.1:10100",
  ocxKey: "",
  transcribeModel: "gpt-4o-transcribe",
  noteModel: "gpt-6-luna",
  refineModel: "gpt-6-luna--fast",
  concurrency: 2,
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  courses: [],
  ffmpegPath: "ffmpeg",
  ffprobePath: "ffprobe",
  vault: null,
});
const KNOWN = new Set([...Object.keys(DEFAULTS), "defaultNoteModel"]);
const COURSE_RE = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,39}$/;
const VAULT_DEFAULTS = {
  notePath: "{course}/{date}-{slug}.md",
  rawPath: "_raw/{course}/{date}-transcript.txt",
  includeRaw: false,
};

function normalizeVault(value) {
  if (value == null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid vault");
  const ignored = Object.keys(value).filter((key) => !["root", ...Object.keys(VAULT_DEFAULTS)].includes(key));
  if (ignored.length) console.warn(`[config] ignored vault keys: ${ignored.join(", ")}`);
  const vault = { ...VAULT_DEFAULTS, ...value };
  if (typeof vault.root !== "string" || !vault.root.trim()) throw new Error("Invalid vault root");
  if (typeof vault.notePath !== "string" || !vault.notePath.trim()) throw new Error("Invalid vault notePath");
  if (vault.rawPath !== null && (typeof vault.rawPath !== "string" || !vault.rawPath.trim()))
    throw new Error("Invalid vault rawPath");
  if (typeof vault.includeRaw !== "boolean") throw new Error("Invalid vault includeRaw");
  return { root: vault.root, notePath: vault.notePath, rawPath: vault.rawPath, includeRaw: vault.includeRaw };
}

export function loadConfig({ paths, env = process.env }) {
  let local = {};
  try {
    local = JSON.parse(fs.readFileSync(paths.configFile, "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT")
      throw new Error(
        `Invalid config file (${e.code === "EACCES" ? "not readable" : "not valid JSON"}): ${paths.configFile}`,
      );
  }
  if (!local || typeof local !== "object" || Array.isArray(local)) throw new Error("Config must be an object");
  const ignored = Object.keys(local).filter((key) => !KNOWN.has(key));
  if (ignored.length) console.warn(`[config] ignored keys: ${ignored.join(", ")}`);
  if (Object.hasOwn(local, "defaultNoteModel")) console.warn("[config] defaultNoteModel is deprecated; use noteModel");
  const cfg = {
    ...DEFAULTS,
    ...local,
    noteModel: local.noteModel ?? local.defaultNoteModel ?? DEFAULTS.noteModel,
    port: env.PORT ?? local.port ?? DEFAULTS.port,
    host: env.HOST ?? local.host ?? DEFAULTS.host,
    ocxBase: env.OCX_BASE ?? local.ocxBase ?? DEFAULTS.ocxBase,
    ocxKey: env.OCX_KEY ?? local.ocxKey ?? DEFAULTS.ocxKey,
    timezone: env.OCX_DICTATION_TZ ?? local.timezone ?? DEFAULTS.timezone,
    ffmpegPath: env.FFMPEG_PATH ?? local.ffmpegPath ?? DEFAULTS.ffmpegPath,
    ffprobePath: env.FFPROBE_PATH ?? local.ffprobePath ?? DEFAULTS.ffprobePath,
    vault: local.vault ?? null,
  };
  for (const key of Object.keys(cfg)) if (!Object.hasOwn(DEFAULTS, key)) delete cfg[key];
  cfg.port = Number(cfg.port);
  cfg.concurrency = Number(cfg.concurrency);
  if (!Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535) throw new Error("Invalid port");
  if (!["127.0.0.1", "::1", "localhost"].includes(cfg.host)) throw new Error("Host must be loopback");
  if (!Number.isInteger(cfg.concurrency) || cfg.concurrency < 1 || cfg.concurrency > 16)
    throw new Error("Invalid concurrency");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: cfg.timezone });
  } catch {
    throw new Error("Invalid timezone");
  }
  if (!Array.isArray(cfg.courses) || cfg.courses.some((x) => typeof x !== "string" || !COURSE_RE.test(x)))
    throw new Error("Invalid courses");
  for (const key of ["ocxBase", "ocxKey", "transcribeModel", "noteModel", "refineModel", "ffmpegPath", "ffprobePath"]) {
    if (typeof cfg[key] !== "string" || (key !== "ocxKey" && !cfg[key])) throw new Error(`Invalid ${key}`);
  }
  let url;
  try {
    url = new URL(cfg.ocxBase);
  } catch {
    throw new Error("Invalid ocxBase");
  }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Invalid ocxBase");
  if (url.username || url.password) throw new Error("ocxBase must not contain credentials; use ocxKey");
  // C review (wp1): query strings/fragments can carry tokens and the base URL is logged at startup.
  if (url.search || url.hash) throw new Error("ocxBase must not contain a query string or fragment; use ocxKey");
  cfg.ocxBase = cfg.ocxBase.replace(/\/$/, "");
  cfg.vault = normalizeVault(cfg.vault);
  return cfg;
}

export function publicConfig(cfg) {
  return {
    version: "1.0.0",
    transcribeModel: cfg.transcribeModel,
    noteModel: cfg.noteModel,
    refineModel: cfg.refineModel,
    timezone: cfg.timezone,
    courses: [...cfg.courses],
    vaultEnabled: Boolean(cfg.vault),
  };
}
