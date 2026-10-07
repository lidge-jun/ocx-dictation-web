import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer } from "../server.mjs";
import { resolvePaths } from "../lib/paths.mjs";
import { loadConfig } from "../lib/config.mjs";

test("startServer resolves { server, close } after listening; close stops it", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocxd-start-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = { OCX_DICTATION_HOME: path.join(dir, "home") };
  const paths = resolvePaths({ env, appDir: dir, homedir: dir });
  const cfg = { ...loadConfig({ paths, env }), port: 0, ocxBase: "http://127.0.0.1:1" };
  const runtime = await startServer(cfg, paths);
  t.after(() => (runtime.server.listening ? runtime.close() : undefined));
  assert.equal(typeof runtime.close, "function");
  assert.equal(runtime.server.listening, true);
  const port = runtime.server.address().port;
  const res = await fetch(`http://127.0.0.1:${port}/api/health`);
  assert.equal(res.status, 200);
  await runtime.close();
  assert.equal(runtime.server.listening, false);
  await assert.rejects(fetch(`http://127.0.0.1:${port}/api/health`));
});

test("public config is allowlisted and legacy wiki routes are disabled", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocxd-http-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = { OCX_DICTATION_HOME: path.join(dir, "home"), OCX_KEY: "dummy-secret" };
  const paths = resolvePaths({ env, appDir: dir, homedir: dir });
  fs.mkdirSync(paths.home, { recursive: true });
  fs.writeFileSync(
    paths.configFile,
    JSON.stringify({ noteModel: "configured-note", refineModel: "configured-refine", courses: ["BIO101"] }),
  );
  const id = "20260101-000000-abcd",
    sessionDir = path.join(paths.sessionsDir, id);
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(
    path.join(sessionDir, "meta.json"),
    JSON.stringify({ id, title: "Example", course: "BIO101", createdAt: "2026-01-01T00:00:00Z", state: "done" }),
  );
  const before = fs.readdirSync(sessionDir);
  const cfg = { ...loadConfig({ paths, env }), port: 0, ocxBase: "http://127.0.0.1:1" };
  const runtime = await startServer(cfg, paths);
  t.after(() => runtime.close());
  const base = `http://127.0.0.1:${runtime.server.address().port}`;
  const pub = await (await fetch(`${base}/api/config`)).json();
  assert.deepEqual(Object.keys(pub), [
    "version",
    "transcribeModel",
    "noteModel",
    "refineModel",
    "timezone",
    "courses",
    "vaultEnabled",
  ]);
  assert.equal(pub.noteModel, "configured-note");
  assert.equal(pub.refineModel, "configured-refine");
  assert.deepEqual(pub.courses, ["BIO101"]);
  assert.equal(pub.vaultEnabled, false);
  assert.equal(JSON.stringify(pub).includes("dummy-secret"), false);
  assert.equal(JSON.stringify(pub).includes(dir), false);
  const models = await (await fetch(`${base}/api/models`)).json();
  assert.deepEqual(models.models, ["configured-note"]);
  const courses = await (await fetch(`${base}/api/courses`)).json();
  assert.equal(courses.courses[0].wiki, false);
  for (const [route, method] of [
    [`/api/prompts/wiki/BIO101`, "GET"],
    [`/api/sessions/${id}/wiki`, "GET"],
    [`/api/sessions/${id}/wiki`, "POST"],
  ]) {
    const res = await fetch(base + route, { method });
    assert.equal(res.status, 404);
    assert.equal(typeof (await res.json()).error, "string");
  }
  assert.deepEqual(fs.readdirSync(sessionDir), [...before, "notes.md"]);
  assert.match(fs.readFileSync(path.join(sessionDir, "notes.md"), "utf8"), /^<!-- notes revision 0 -->\n/);
});
