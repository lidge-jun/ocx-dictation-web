import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { runCli } from "../bin/ocx-dictation.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ocx-cli-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const appDir = path.join(root, "app"),
    homedir = path.join(root, "user");
  fs.mkdirSync(appDir, { recursive: true });
  return { root, appDir, homedir, env: {}, out: [], err: [] };
}
const hash = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const run = (f, argv, doctorDeps = {}, migrateDeps = {}) =>
  runCli({
    argv,
    env: f.env,
    appDir: f.appDir,
    homedir: f.homedir,
    out: (s) => f.out.push(s),
    err: (s) => f.err.push(s),
    doctorDeps,
    migrateDeps,
  });

test("paths --json reports a temp HOME/appDir and performs no writes", async (t) => {
  const f = fixture(t);
  assert.equal(await run(f, ["paths", "--json"]), 0);
  const p = JSON.parse(f.out[0]);
  assert.equal(p.home, path.join(f.homedir, ".ocx-dictation"));
  assert.equal(p.appDir, f.appDir);
  assert.equal(fs.existsSync(p.home), false);
});
test("migrate dry-run and copy verify; source untouched", async (t) => {
  const f = fixture(t);
  const old = path.join(f.appDir, "data", "sessions", "20260101-000000-abcd");
  fs.mkdirSync(old, { recursive: true });
  const src = path.join(old, "meta.json"),
    cfg = path.join(f.appDir, "config.local.json");
  fs.writeFileSync(src, '{"title":"BIO101"}');
  fs.writeFileSync(cfg, '{"ocxKey":"dummy"}');
  const before = [hash(src), hash(cfg)];
  assert.equal(await run(f, ["migrate", "--dry-run"]), 0);
  const home = path.join(f.homedir, ".ocx-dictation");
  assert.equal(fs.existsSync(home), false);
  assert.equal(await run(f, ["migrate"]), 0);
  assert.equal(hash(path.join(home, "data", "sessions", "20260101-000000-abcd", "meta.json")), before[0]);
  assert.equal(hash(path.join(home, "config.json")), before[1]);
  assert.deepEqual([hash(src), hash(cfg)], before);
  if (process.platform !== "win32") assert.equal(fs.statSync(path.join(home, "config.json")).mode & 0o777, 0o600);
});
test("migrate refuses non-empty destination before any copy", async (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.appDir, "data"));
  fs.writeFileSync(path.join(f.appDir, "data", "item.txt"), "source");
  const dest = path.join(f.homedir, ".ocx-dictation", "data");
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(dest, "keep.txt"), "keep");
  assert.equal(await run(f, ["migrate"]), 1);
  assert.equal(fs.readFileSync(path.join(dest, "keep.txt"), "utf8"), "keep");
  assert.equal(fs.existsSync(path.join(dest, "item.txt")), false);
  assert.equal(fs.readFileSync(path.join(f.appDir, "data", "item.txt"), "utf8"), "source");
});
test("migrate --from copies from a separate old checkout; source untouched", async (t) => {
  const f = fixture(t);
  const old = fs.mkdtempSync(path.join(os.tmpdir(), "ocxd-old-"));
  t.after(() => fs.rmSync(old, { recursive: true, force: true }));
  const sdir = path.join(old, "data", "sessions", "20260101-000000-abcd");
  fs.mkdirSync(sdir, { recursive: true });
  const src = path.join(sdir, "meta.json"),
    cfg = path.join(old, "config.local.json");
  fs.writeFileSync(src, '{"title":"BIO101"}');
  fs.writeFileSync(cfg, '{"ocxKey":"dummy"}');
  const before = [hash(src), hash(cfg)];
  assert.equal(await run(f, ["migrate", "--from", old]), 0);
  const home = path.join(f.homedir, ".ocx-dictation");
  assert.equal(hash(path.join(home, "data", "sessions", "20260101-000000-abcd", "meta.json")), before[0]);
  assert.equal(hash(path.join(home, "config.json")), before[1]);
  assert.deepEqual([hash(src), hash(cfg)], before);
});
test("migrate --from a missing directory exits 1 and creates nothing", async (t) => {
  const f = fixture(t);
  assert.equal(await run(f, ["migrate", "--from", path.join(f.root, "missing")]), 1);
  assert.equal(fs.existsSync(path.join(f.homedir, ".ocx-dictation")), false);
});
test("migrate refuses a destination nested anywhere inside the source tree (incl. via symlink)", async (t) => {
  const f = fixture(t);
  const old = path.join(f.root, "old");
  fs.mkdirSync(path.join(old, "data", "sessions"), { recursive: true });
  fs.writeFileSync(path.join(old, "config.local.json"), "{}");
  // destination home inside the source checkout but outside its data/
  f.env = { OCX_DICTATION_HOME: path.join(old, "nested-home") };
  assert.equal(await run(f, ["migrate", "--from", old]), 1);
  assert.match(f.err.join("\n"), /overlaps legacy source/);
  assert.equal(fs.existsSync(path.join(old, "nested-home")), false);
  // same, reached through a symlinked alias of the source
  const alias = path.join(f.root, "alias");
  fs.symlinkSync(old, alias);
  f.env = { OCX_DICTATION_HOME: path.join(alias, "nested-home") };
  assert.equal(await run(f, ["migrate", "--from", old]), 1);
  assert.equal(fs.existsSync(path.join(old, "nested-home")), false);
});
test("doctor never emits a configured key", async (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.appDir, "config.local.json"), '{"ocxKey":"dummy-secret"}');
  assert.equal(await run(f, ["doctor"], { commandExists: async () => false, fetch: async () => ({ ok: false }) }), 1);
  assert.equal(f.out.join("\n").includes("dummy-secret"), false);
  assert.match(f.out.join("\n"), /key: configured/);
});
test("CLI rejects unknown option and invalid port without binding", async (t) => {
  const f = fixture(t);
  assert.equal(await run(f, ["paths", "--unknown"]), 2);
  assert.equal(await run(f, ["start", "--port", "0"]), 2);
  assert.match(f.err.join("\n"), /Unknown option.*Invalid port/s);
});
test("migrate refuses symlink source before writing", async (t) => {
  const f = fixture(t),
    target = path.join(f.root, "target.txt");
  fs.writeFileSync(target, "source");
  fs.symlinkSync(target, path.join(f.appDir, "config.local.json"));
  assert.equal(await run(f, ["migrate"]), 1);
  assert.equal(fs.existsSync(path.join(f.homedir, ".ocx-dictation")), false);
  assert.equal(fs.readFileSync(target, "utf8"), "source");
});
test("copy mismatch fails, retains source and partial destination, retry refuses", async (t) => {
  const f = fixture(t),
    old = path.join(f.appDir, "data");
  fs.mkdirSync(old);
  fs.writeFileSync(path.join(old, "item.txt"), "source");
  const before = hash(path.join(old, "item.txt"));
  const copyFile = async (src, dest, flags) => {
    await fs.promises.copyFile(src, dest, flags);
    await fs.promises.writeFile(dest, "broken");
  };
  await assert.rejects(run(f, ["migrate"], {}, { copyFile }), /Copy verification failed/);
  assert.equal(
    f.out.some((s) => s.startsWith("Verified")),
    false,
  );
  assert.equal(hash(path.join(old, "item.txt")), before);
  assert.equal(fs.readFileSync(path.join(f.homedir, ".ocx-dictation", "data", "item.txt"), "utf8"), "broken");
  assert.equal(await run(f, ["migrate"]), 1);
});
