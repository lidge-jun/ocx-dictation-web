import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolvePaths } from "../lib/paths.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ocx-paths-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, appDir: path.join(root, "app"), homedir: path.join(root, "user") };
}
test("home defaults and resolver has no writes", (t) => {
  const f = fixture(t),
    p = resolvePaths({ env: {}, appDir: f.appDir, homedir: f.homedir });
  assert.equal(p.home, path.join(f.homedir, ".ocx-dictation"));
  assert.equal(p.configFile, path.join(p.home, "config.json"));
  assert.equal(p.sessionsDir, path.join(p.home, "data", "sessions"));
  assert.equal(p.source.data, "home");
  assert.equal(fs.existsSync(p.home), false);
});
test("legacy detection and explicit data overrides", (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.appDir, "data", "sessions", "20260101-000000-abcd"), { recursive: true });
  fs.writeFileSync(path.join(f.appDir, "config.local.json"), "{}");
  const legacy = resolvePaths({ env: {}, appDir: f.appDir, homedir: f.homedir });
  assert.deepEqual(legacy.legacy, { data: true, config: true });
  assert.deepEqual(legacy.source, { data: "legacy", config: "legacy" });
  const explicit = resolvePaths({
    env: { DATA_DIR: path.join(f.root, "other") },
    appDir: f.appDir,
    homedir: f.homedir,
  });
  assert.equal(explicit.source.data, "env");
  assert.equal(explicit.dataDir, path.join(f.root, "other"));
  const home = resolvePaths({
    env: { OCX_DICTATION_HOME: path.join(f.root, "new") },
    appDir: f.appDir,
    homedir: f.homedir,
  });
  assert.equal(home.source.data, "home");
  assert.equal(home.source.config, "legacy");
  assert.equal(fs.existsSync(home.home), false);
});
test("home sessions and config win over legacy", (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.appDir, "data", "sessions", "20260101-000000-abcd"), { recursive: true });
  const home = path.join(f.homedir, ".ocx-dictation");
  fs.mkdirSync(path.join(home, "data", "sessions", "20260102-000000-abcd"), { recursive: true });
  fs.writeFileSync(path.join(home, "config.json"), "{}");
  assert.deepEqual(resolvePaths({ env: {}, appDir: f.appDir, homedir: f.homedir }).source, {
    data: "home",
    config: "home",
  });
});
test("empty legacy sessions do not override home data", (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.appDir, "data", "sessions"), { recursive: true });
  const p = resolvePaths({ env: {}, appDir: f.appDir, homedir: f.homedir });
  assert.equal(p.legacy.data, false);
  assert.equal(p.source.data, "home");
});
