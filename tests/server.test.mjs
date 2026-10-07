import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { startServer } from "../server.mjs";
import { resolvePaths } from "../lib/paths.mjs";
import { loadConfig } from "../lib/config.mjs";
import { startFakeOcx } from "./fake-ocx.mjs";

function wav() {
  const samples = 16000,
    b = Buffer.alloc(44 + samples * 2);
  b.write("RIFF", 0);
  b.writeUInt32LE(b.length - 8, 4);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24);
  b.writeUInt32LE(32000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) b.writeInt16LE(i % 2 ? 5000 : -5000, 44 + i * 2);
  return b;
}
async function setup(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocxd-server-"));
  const fake = await startFakeOcx();
  const env = { OCX_DICTATION_HOME: path.join(dir, "home"), DATA_DIR: path.join(dir, "data") };
  const paths = resolvePaths({ env, appDir: dir, homedir: dir });
  const cfg = { ...loadConfig({ paths, env }), port: 0, ocxBase: fake.url, ocxKey: "test-key", ...options };
  const runtime = await startServer(cfg, paths);
  t.after(async () => {
    await runtime.close();
    await fake.close();
    await fsp.rm(dir, { recursive: true, force: true });
  });
  return { dir, paths, cfg, fake, runtime, base: `http://127.0.0.1:${runtime.server.address().port}` };
}
async function post(base, route, data) {
  return fetch(base + route, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: base },
    body: JSON.stringify(data),
  });
}
async function session(base) {
  const r = await post(base, "/api/sessions", { title: "Example lecture", course: "BIO101" });
  assert.equal(r.status, 201);
  return r.json();
}
async function segment(base, id) {
  const r = await fetch(`${base}/api/sessions/${id}/segments?index=0&start=0`, {
    method: "POST",
    headers: { "Content-Type": "audio/wav", Origin: base },
    body: wav(),
  });
  assert.equal(r.status, 202);
}
async function done(base, id) {
  const deadline = Date.now() + 5000;
  for (;;) {
    const r = await fetch(`${base}/api/sessions/${id}`),
      s = await r.json();
    if (s.segments[0]?.status === "done") return s;
    if (Date.now() > deadline) throw new Error(`segment did not finish: ${JSON.stringify(s.segments)}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

test("health and public config", async (t) => {
  const { base, paths } = await setup(t);
  const health = await (await fetch(base + "/api/health")).json();
  assert.equal(health.ok, true);
  assert.equal(health.ocx, "ok");
  const conf = await (await fetch(base + "/api/config")).json();
  assert.deepEqual(Object.keys(conf), [
    "version",
    "transcribeModel",
    "noteModel",
    "refineModel",
    "timezone",
    "courses",
    "vaultEnabled",
  ]);
  assert.equal(JSON.stringify(conf).includes("test-key"), false);
  assert.equal(JSON.stringify(conf).includes(paths.dataDir), false);
});

test("session to transcript lifecycle", async (t) => {
  const { base, fake, paths } = await setup(t);
  const s = await session(base);
  const controller = new AbortController();
  t.after(() => controller.abort());
  const events = await fetch(`${base}/api/sessions/${s.id}/events`, { signal: controller.signal });
  assert.equal(events.status, 200);
  assert.match(
    await events.body
      .getReader()
      .read()
      .then((x) => new TextDecoder().decode(x.value)),
    /"type":"hello"/,
  );
  await segment(base, s.id);
  const final = await done(base, s.id);
  assert.match(final.segments[0].text, /Example transcript 1/);
  assert.equal(fake.calls(), 1);
  const disk = JSON.parse(await fsp.readFile(path.join(paths.sessionsDir, s.id, "transcript.json"), "utf8"));
  assert.equal(disk.segments[0].status, "done");
  controller.abort();
});

test("notes, exports and delete", async (t) => {
  const { base, paths } = await setup(t);
  const s = await session(base);
  await segment(base, s.id);
  await done(base, s.id);
  const notes = await fetch(`${base}/api/sessions/${s.id}/notes`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Origin: base },
    body: JSON.stringify({ lines: [{ id: "a", t: 0.5, text: "Important note", important: true }] }),
  });
  assert.equal(notes.status, 200);
  assert.equal((await notes.json()).ok, true);
  const md = await fetch(`${base}/api/sessions/${s.id}/export?format=md`);
  assert.match(md.headers.get("content-type"), /text\/markdown/);
  const markdown = await md.text();
  assert.match(markdown, /Example transcript/);
  assert.match(markdown, /Important note/);
  const txt = await fetch(`${base}/api/sessions/${s.id}/export?format=txt`);
  assert.match(txt.headers.get("content-type"), /text\/plain/);
  assert.match(await txt.text(), /Example transcript/);
  const srt = await fetch(`${base}/api/sessions/${s.id}/export?format=srt`);
  assert.match(srt.headers.get("content-type"), /application\/x-subrip/);
  assert.match(await srt.text(), /00:00:00,000 --> 00:00:01,000/);
  const bad = await fetch(`${base}/api/sessions/${s.id}/export?format=pdf`);
  assert.equal(bad.status, 400);
  const del = await fetch(`${base}/api/sessions/${s.id}`, { method: "DELETE", headers: { Origin: base } });
  assert.equal(del.status, 200);
  assert.equal((await fetch(`${base}/api/sessions/${s.id}`)).status, 404);
  assert.equal(fs.existsSync(path.join(paths.sessionsDir, s.id)), false);
});

test("two starts are isolated", async (t) => {
  const a = await setup(t),
    b = await setup(t);
  const s = await session(a.base);
  const list = await (await fetch(b.base + "/api/sessions")).json();
  assert.equal(list.sessions.length, 0);
  await a.runtime.close();
  assert.equal((await fetch(b.base + "/api/health")).status, 200);
  assert.ok(s.id);
});

test("debug sample absent and applied prompts", async (t) => {
  const { base } = await setup(t);
  const s = await session(base);
  assert.equal((await fetch(base + "/debug/sample.wav")).status, 404);
  const p = await (await fetch(`${base}/api/sessions/${s.id}/prompts`)).json();
  assert.equal(typeof p.transcribe.base, "string");
});

test("upload pipeline and AI streams keep route shapes", async (t) => {
  const { base, paths, fake } = await setup(t);
  const uploaded = await fetch(`${base}/api/upload?filename=lecture.wav&course=BIO101`, {
    method: "POST",
    headers: { Origin: base, "Content-Type": "audio/wav" },
    body: wav(),
  });
  assert.equal(uploaded.status, 201);
  const s = await uploaded.json();
  const final = await done(base, s.id);
  assert.equal(final.meta.source, "upload");
  assert.equal(final.meta.audioFile, "audio.ogg");
  assert.equal(fake.calls(), 1);
  assert.equal(fs.existsSync(path.join(paths.sessionsDir, s.id, "audio.ogg")), true);
  const generated = await fetch(`${base}/api/sessions/${s.id}/generate`, {
    method: "POST",
    headers: { Origin: base, "Content-Type": "application/json" },
    body: JSON.stringify({ template: "lecture" }),
  });
  assert.equal(generated.status, 200);
  const genFrames = await generated.text();
  assert.match(genFrames, /"type":"start"/);
  assert.match(genFrames, /"type":"done"/);
  const aiNote = await (await fetch(`${base}/api/sessions/${s.id}`)).json();
  assert.equal(aiNote.aiNote, "Example note");
  const asked = await fetch(`${base}/api/sessions/${s.id}/ask`, {
    method: "POST",
    headers: { Origin: base, "Content-Type": "application/json" },
    body: JSON.stringify({ question: "Summarize" }),
  });
  assert.equal(asked.status, 200);
  assert.match(await asked.text(), /"type":"done"/);
});

test("prompt glossary persists and session patch starts refinement", async (t) => {
  const { base, paths } = await setup(t);
  const s = await session(base);
  await segment(base, s.id);
  await done(base, s.id);
  const prompts = await fetch(`${base}/api/prompts`, {
    method: "PUT",
    headers: { Origin: base, "Content-Type": "application/json" },
    body: JSON.stringify({ courses: { BIO101: { glossary: "Updated terms" } } }),
  });
  assert.equal(prompts.status, 200);
  const meta = JSON.parse(await fsp.readFile(path.join(paths.sessionsDir, s.id, "meta.json"), "utf8"));
  assert.equal(meta.glossary, "Updated terms");
  const patched = await fetch(`${base}/api/sessions/${s.id}`, {
    method: "PATCH",
    headers: { Origin: base, "Content-Type": "application/json" },
    body: JSON.stringify({ state: "processing", refine: { enabled: true, interval: "end" } }),
  });
  assert.equal(patched.status, 200);
  assert.equal((await patched.json()).meta.refine.enabled, true);
  const deadline = Date.now() + 3000;
  for (;;) {
    const current = await (await fetch(`${base}/api/sessions/${s.id}`)).json();
    if (current.meta.refineWindows?.end?.[0]?.status === "error") break;
    if (Date.now() > deadline) throw new Error("patch did not trigger refinement");
    await new Promise((r) => setTimeout(r, 25));
  }
});

test("failed bind starts no background work", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocxd-bind-")),
    fake = await startFakeOcx();
  const occupied = net.createServer();
  await new Promise((resolve) => occupied.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve) => occupied.close(resolve));
    await fake.close();
    await fsp.rm(dir, { recursive: true, force: true });
  });
  const env = { OCX_DICTATION_HOME: path.join(dir, "home"), DATA_DIR: path.join(dir, "data") },
    paths = resolvePaths({ env, appDir: dir, homedir: dir });
  const id = "20260101-000000-abcd",
    root = path.join(paths.sessionsDir, id);
  await fsp.mkdir(path.join(root, "segments"), { recursive: true });
  await fsp.writeFile(
    path.join(root, "meta.json"),
    JSON.stringify({ id, state: "processing", course: "", title: "Pending" }),
  );
  await fsp.writeFile(
    path.join(root, "transcript.json"),
    JSON.stringify({ segments: [{ index: 0, file: "s00000.wav", status: "pending", start: 0, end: 1 }] }),
  );
  await fsp.writeFile(path.join(root, "segments", "s00000.wav"), wav());
  const cfg = { ...loadConfig({ paths, env }), port: occupied.address().port, ocxBase: fake.url };
  await assert.rejects(startServer(cfg, paths), { code: "EADDRINUSE" });
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(fake.calls(), 0);
});
