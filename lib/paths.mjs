import fs from "node:fs";
import path from "node:path";
import os from "node:os";

function hasSessionDirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).some((d) => d.isDirectory());
  } catch (e) {
    if (e.code === "ENOENT") return false;
    throw e;
  }
}
export function resolvePaths({ env = process.env, appDir, homedir = os.homedir() }) {
  if (!appDir) throw new Error("appDir is required");
  const home = path.resolve(env.OCX_DICTATION_HOME || path.join(homedir, ".ocx-dictation"));
  const ownConfig = path.join(home, "config.json");
  const oldConfig = path.join(appDir, "config.local.json");
  const ownData = path.join(home, "data");
  const oldData = path.join(appDir, "data");
  const legacy = {
    data: hasSessionDirs(path.join(oldData, "sessions")),
    config: fs.existsSync(oldConfig),
  };
  const useLegacyData =
    !env.DATA_DIR && !env.OCX_DICTATION_HOME && !hasSessionDirs(path.join(ownData, "sessions")) && legacy.data;
  const dataDir = env.DATA_DIR ? path.resolve(env.DATA_DIR) : useLegacyData ? oldData : ownData;
  const configFile = !fs.existsSync(ownConfig) && legacy.config ? oldConfig : ownConfig;
  return {
    home,
    configFile,
    dataDir,
    sessionsDir: path.join(dataDir, "sessions"),
    promptsFile: path.join(dataDir, "prompts.json"),
    debugDir: path.join(dataDir, "debug"),
    appDir,
    legacy,
    source: {
      data: env.DATA_DIR ? "env" : useLegacyData ? "legacy" : "home",
      config: configFile === oldConfig ? "legacy" : "home",
    },
  };
}
