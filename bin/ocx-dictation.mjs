#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { resolvePaths } from "../lib/paths.mjs";
import { loadConfig } from "../lib/config.mjs";
import { startServer } from "../server.mjs";

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HELP =
  "ocx-dictation [start [--port N] | paths [--json] | doctor | migrate [--from <old-app-dir>] " +
  "[--dry-run] | --help | --version]";

export async function runCli({
  argv = process.argv.slice(2),
  env = process.env,
  appDir = APP_DIR,
  homedir = os.homedir(),
  out = console.log,
  err = console.error,
  doctorDeps = {},
  migrateDeps = {},
} = {}) {
  const [command = "start", ...args] = argv;
  if (command === "--help" || command === "help") {
    out(HELP);
    return 0;
  }
  if (command === "--version") {
    out("1.0.0");
    return 0;
  }
  if (!["start", "paths", "doctor", "migrate"].includes(command)) {
    err(`Unknown command: ${command}`);
    return 2;
  }
  const allowed = { start: ["--port"], paths: ["--json"], doctor: [], migrate: ["--dry-run", "--from"] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!allowed[command].includes(a)) {
      err(`Unknown option: ${a}`);
      return 2;
    }
    if (a === "--port" && !args[++i]) {
      err("--port needs a number");
      return 2;
    }
    if (a === "--from" && !args[++i]) {
      err("--from needs a directory");
      return 2;
    }
  }
  const paths = resolvePaths({ env, appDir, homedir });
  if (command === "paths") {
    out(args.includes("--json") ? JSON.stringify(paths) : formatPaths(paths));
    return 0;
  }
  if (command === "migrate") {
    const fi = args.indexOf("--from");
    return migrate({
      paths,
      from: fi >= 0 ? path.resolve(args[fi + 1]) : undefined,
      dryRun: args.includes("--dry-run"),
      out,
      err,
      ...migrateDeps,
    });
  }
  const cfg = loadConfig({ paths, env });
  if (command === "doctor") return doctor({ cfg, paths, out, deps: doctorDeps });
  const i = args.indexOf("--port");
  if (i >= 0) {
    cfg.port = Number(args[i + 1]);
    if (!Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535) {
      err("Invalid port");
      return 2;
    }
  }
  if (paths.source.data === "legacy" || paths.source.config === "legacy")
    err("[paths] using legacy source; run migrate when ready");
  await startServer(cfg, paths);
  return 0;
}

function formatPaths(p) {
  return [
    `home: ${p.home}`,
    `config: ${p.configFile} (${p.source.config})`,
    `data: ${p.dataDir} (${p.source.data})`,
    `sessions: ${p.sessionsDir}`,
    `prompts: ${p.promptsFile}`,
    `debug: ${p.debugDir}`,
  ].join("\n");
}

async function doctor({ cfg, paths, out, deps = {} }) {
  const commandExists =
    deps.commandExists ||
    (async (name) => {
      try {
        await promisify(execFile)(name, ["-version"], { timeout: 3000 });
        return true;
      } catch {
        return false;
      }
    });
  const ffmpeg = await commandExists(cfg.ffmpegPath);
  const ffprobe = await commandExists(cfg.ffprobePath);
  let ocx = false;
  try {
    const r = await (deps.fetch || fetch)(`${cfg.ocxBase}/healthz`, { signal: AbortSignal.timeout(3000) });
    ocx = r.ok;
  } catch {}
  out(`data: ${paths.dataDir} (${paths.source.data})`);
  out(`config: ${paths.configFile} (${paths.source.config})`);
  out(`ffmpeg: ${ffmpeg ? "found" : "missing"}`);
  out(`ffprobe: ${ffprobe ? "found" : "missing"}`);
  out(`OpenCodex: ${ocx ? "reachable" : "unreachable"}`);
  out(`key: ${cfg.ocxKey ? "configured" : "missing"}`);
  return ffmpeg && ffprobe && ocx && cfg.ocxKey ? 0 : 1;
}

async function filesUnder(root) {
  const found = [];
  async function visit(dir) {
    for (const d of await fs.promises.readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, d.name);
      if (d.isSymbolicLink()) throw new Error(`Migration refuses symlink: ${file}`);
      if (d.isDirectory()) await visit(file);
      else if (d.isFile()) found.push(file);
      else throw new Error(`Migration refuses special file: ${file}`);
    }
  }
  await visit(root);
  return found.sort();
}
async function digest(file) {
  const bytes = await fs.promises.readFile(file);
  return { size: bytes.length, sha256: crypto.createHash("sha256").update(bytes).digest("hex") };
}
// Resolve symlinks for a path that may not exist yet: realpath of the nearest existing ancestor + the remainder.
function realish(p) {
  let cur = path.resolve(p);
  const rest = [];
  while (!fs.existsSync(cur)) {
    rest.unshift(path.basename(cur));
    const up = path.dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return path.join(fs.realpathSync(cur), ...rest);
}
const within = (child, parent) => child === parent || child.startsWith(parent + path.sep);
export async function migrate({
  paths,
  from,
  dryRun = false,
  out = console.log,
  err = console.error,
  copyFile = fs.promises.copyFile,
}) {
  const srcRoot = from ?? paths.appDir;
  if (!fs.existsSync(srcRoot) || !fs.statSync(srcRoot).isDirectory()) {
    err("--from is not a directory");
    return 1;
  }
  const srcData = path.join(srcRoot, "data");
  const srcConfig = path.join(srcRoot, "config.local.json");
  const destData = path.join(paths.home, "data");
  const destConfig = path.join(paths.home, "config.json");
  const dataPresent = fs.existsSync(srcData);
  const configPresent = fs.existsSync(srcConfig);
  if (!dataPresent && !configPresent) {
    err("No legacy data or config found");
    return 1;
  }
  // C review (wp1): the destination may not sit anywhere inside the source tree (or vice versa), symlinks resolved.
  const homeReal = realish(paths.home),
    srcReal = realish(srcRoot);
  if (
    path.resolve(paths.home) === path.resolve(paths.appDir) ||
    within(homeReal, srcReal) ||
    within(srcReal, homeReal)
  ) {
    err("Destination overlaps legacy source");
    return 1;
  }
  if (fs.existsSync(paths.home) && (await fs.promises.readdir(paths.home)).length) {
    err(`Destination is not empty: ${paths.home}`);
    return 1;
  }
  if (configPresent && (await fs.promises.lstat(srcConfig)).isSymbolicLink()) {
    err("Migration refuses config symlink");
    return 1;
  }
  if (dataPresent && (await fs.promises.lstat(srcData)).isSymbolicLink()) {
    err("Migration refuses data symlink");
    return 1;
  }
  for (const dest of [destConfig, destData]) {
    if (fs.existsSync(dest)) {
      if (dest === destConfig || (await fs.promises.readdir(dest)).length) {
        err(`Destination is not empty: ${dest}`);
        return 1;
      }
    }
  }
  const dataFiles = dataPresent ? await filesUnder(srcData) : [];
  const srcFiles = [...dataFiles, ...(configPresent ? [srcConfig] : [])];
  const expected = new Map();
  for (const file of srcFiles) expected.set(file, await digest(file));
  out(`Migration: ${srcFiles.length} files${dryRun ? " (dry run)" : ""}`);
  if (dryRun) return 0;
  await fs.promises.mkdir(paths.home, { recursive: true });
  if (dataPresent) {
    for (const file of dataFiles) {
      const dest = path.join(destData, path.relative(srcData, file));
      await fs.promises.mkdir(path.dirname(dest), { recursive: true });
      await copyFile(file, dest, fs.constants.COPYFILE_EXCL);
      const got = await digest(dest),
        want = expected.get(file);
      if (got.size !== want.size || got.sha256 !== want.sha256) throw new Error(`Copy verification failed: ${dest}`);
      const sourceNow = await digest(file);
      if (sourceNow.size !== want.size || sourceNow.sha256 !== want.sha256)
        throw new Error(`Source changed during copy: ${file}`);
    }
  }
  if (configPresent) {
    await copyFile(srcConfig, destConfig, fs.constants.COPYFILE_EXCL);
    await fs.promises.chmod(destConfig, 0o600);
    const got = await digest(destConfig),
      want = expected.get(srcConfig);
    if (got.size !== want.size || got.sha256 !== want.sha256) throw new Error("Config copy verification failed");
    const sourceNow = await digest(srcConfig);
    if (sourceNow.size !== want.size || sourceNow.sha256 !== want.sha256) throw new Error("Config changed during copy");
  }
  out(`Verified ${srcFiles.length} files by size and SHA-256; legacy source retained`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((e) => {
      console.error(e.message);
      process.exitCode = 1;
    });
}
