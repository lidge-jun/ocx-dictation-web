import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { once } from "node:events";
import { startServer } from "../server.mjs";
import { resolvePaths } from "../lib/paths.mjs";
import { loadConfig } from "../lib/config.mjs";
import { createHttp } from "../lib/http.mjs";
import { createLogger } from "../lib/log.mjs";
import { startFakeOcx } from "./fake-ocx.mjs";
import { createSse } from "../lib/sse.mjs";
import { EventEmitter } from "node:events";

function wav() {
  const b = Buffer.alloc(32044);
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
  b.writeUInt32LE(32000, 40);
  for (let i = 0; i < 16000; i++) b.writeInt16LE(i % 2 ? 6000 : -6000, 44 + i * 2);
  return b;
}
async function setup(t, { limits, mode = "ok", secret = "test-key", errorBody, logs, beforeStart } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocxd-security-"));
  const fake = await startFakeOcx({ mode, errorBody });
  const env = { OCX_DICTATION_HOME: path.join(dir, "home"), DATA_DIR: path.join(dir, "data") };
  const paths = resolvePaths({ env, appDir: dir, homedir: dir });
  const cfg = { ...loadConfig({ paths, env }), port: 0, ocxBase: fake.url, ocxKey: secret };
  if (beforeStart) await beforeStart(paths);
  const log = logs
    ? createLogger({ secret, write: (line) => logs.push(line) })
    : createLogger({ level: "error", secret });
  const runtime = await startServer(cfg, paths, { limits, log });
  t.after(async () => {
    fake.release();
    await runtime.close();
    await fake.close();
    await fsp.rm(dir, { recursive: true, force: true });
  });
  return { dir, paths, cfg, fake, runtime, base: `http://127.0.0.1:${runtime.server.address().port}` };
}
async function legacySession(paths, { status = "error", autoRetry = false, marker = "LEGACY-UPSTREAM-BODY" } = {}) {
  const id = "20260101-000000-abcd";
  const dir = path.join(paths.sessionsDir, id);
  await fsp.mkdir(path.join(dir, "segments"), { recursive: true });
  await fsp.writeFile(
    path.join(dir, "meta.json"),
    JSON.stringify({
      id,
      title: "Legacy",
      course: "",
      state: "processing",
      error: marker,
      refineWindows: { end: { 0: { status: "error", error: marker } } },
    }),
  );
  await fsp.writeFile(
    path.join(dir, "transcript.json"),
    JSON.stringify({
      segments: [{ index: 0, file: "s00000.wav", status, autoRetry, start: 0, end: 1, error: marker }],
    }),
  );
  await fsp.writeFile(path.join(dir, "segments", "s00000.wav"), wav());
  return id;
}
async function raw(base, route, { method = "GET", headers = {}, chunks = [] } = {}) {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: route, method, headers: { Host: u.host, ...headers } },
      (res) => {
        const parts = [];
        res.on("data", (c) => parts.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts).toString("utf8") }),
        );
      },
    );
    req.on("error", reject);
    for (const chunk of chunks) req.write(chunk);
    req.end();
  });
}
const json = (body) => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  chunks: [Buffer.from(JSON.stringify(body))],
});
async function create(base) {
  const r = await raw(base, "/api/sessions", {
    ...json({ title: "Example lecture", course: "BIO101" }),
    headers: { ...json({}).headers, Origin: base },
  });
  assert.equal(r.status, 201);
  return JSON.parse(r.body);
}
async function waitSegment(base, id, index, status, timeout = 45000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const s = await (await fetch(`${base}/api/sessions/${id}`)).json();
    if (s.segments[index]?.status === status) return s;
    if (Date.now() > deadline) throw new Error(`segment ${index} did not reach ${status}`);
    await new Promise((r) => setTimeout(r, 30));
  }
}

test("foreign Host denied", async (t) => {
  const { base } = await setup(t);
  const r = await raw(base, "/api/health", { headers: { Host: "attacker.example:1234" } });
  assert.equal(r.status, 421);
  assert.ok(r.headers["x-request-id"]);
  assert.match(r.headers["content-security-policy"], /script-src 'self'/);
});

test("foreign Origin and cross-site metadata denied", async (t) => {
  const { base } = await setup(t);
  const request = json({ title: "Blocked", course: "BIO101" });
  const foreign = await raw(base, "/api/sessions", {
    ...request,
    headers: { ...request.headers, Origin: "http://attacker.example" },
  });
  assert.equal(foreign.status, 403);
  const cross = await raw(base, "/api/sessions", {
    ...request,
    headers: { ...request.headers, Origin: base, "Sec-Fetch-Site": "cross-site" },
  });
  assert.equal(cross.status, 403);
  assert.deepEqual((await (await fetch(base + "/api/sessions")).json()).sessions, []);
  const same = await raw(base, "/api/sessions", { ...request, headers: { ...request.headers, Origin: base } });
  assert.equal(same.status, 201);
});

test("JSON media type enforced", async (t) => {
  const { base } = await setup(t);
  const bytes = Buffer.from('{"course":"BIO101"}');
  const rejected = await raw(base, "/api/sessions", { method: "POST", headers: { Origin: base }, chunks: [bytes] });
  assert.equal(rejected.status, 415);
  assert.deepEqual((await (await fetch(base + "/api/sessions")).json()).sessions, []);
  const accepted = await raw(base, "/api/sessions", {
    method: "POST",
    headers: { Origin: base, "Content-Type": "application/json; charset=utf-8" },
    chunks: [bytes],
  });
  assert.equal(accepted.status, 201);
  const nullBody = await raw(base, "/api/sessions", {
    method: "POST",
    headers: { Origin: base, "Content-Type": "application/json" },
    chunks: [Buffer.from("null")],
  });
  assert.equal(nullBody.status, 400);
});

test("course and notes validation rejects before mutation", async (t) => {
  const { base, paths } = await setup(t);
  const bad = await raw(base, "/api/sessions", {
    ...json({ course: "../bad" }),
    headers: { "Content-Type": "application/json", Origin: base },
  });
  assert.equal(bad.status, 400);
  assert.equal(fs.readdirSync(paths.sessionsDir).length, 0);
  const upload = await raw(base, "/api/upload?course=../bad&filename=lecture.wav", {
    method: "POST",
    headers: { Origin: base },
    chunks: [wav()],
  });
  assert.equal(upload.status, 400);
  assert.equal(fs.readdirSync(paths.sessionsDir).length, 0);
  const prompts = await raw(base, "/api/prompts", {
    method: "PUT",
    headers: { Origin: base, "Content-Type": "application/json" },
    chunks: [Buffer.from(JSON.stringify({ courses: { "../bad": { glossary: "x" } } }))],
  });
  assert.equal(prompts.status, 400);
  const s = await create(base);
  const badNotes = await raw(base, `/api/sessions/${s.id}/notes`, {
    method: "PUT",
    headers: { Origin: base, "Content-Type": "application/json" },
    chunks: [Buffer.from(JSON.stringify({ lines: [{ t: -1, text: "invalid" }] }))],
  });
  assert.equal(badNotes.status, 400);
  assert.deepEqual(JSON.parse(await fsp.readFile(path.join(paths.sessionsDir, s.id, "notes.json"), "utf8")), {
    revision: 0,
    lines: [],
  });
});

test("JSON and segment actual-byte limits return readable 413", async (t) => {
  const { base, paths } = await setup(t, { limits: { json: 64, segment: 64 } });
  const overflow = await raw(base, "/api/sessions", {
    method: "POST",
    headers: { Origin: base, "Content-Type": "application/json", "Transfer-Encoding": "chunked" },
    chunks: [Buffer.alloc(80, 97)],
  });
  assert.equal(overflow.status, 413);
  assert.equal(overflow.headers.connection, "close");
  assert.equal((await (await fetch(base + "/api/sessions")).json()).sessions.length, 0);
  const s = await create(base);
  const segment = await raw(base, `/api/sessions/${s.id}/segments?index=0&start=0`, {
    method: "POST",
    headers: { Origin: base, "Transfer-Encoding": "chunked" },
    chunks: [wav()],
  });
  assert.equal(segment.status, 413);
  assert.equal(segment.headers.connection, "close");
  assert.equal(fs.existsSync(path.join(paths.sessionsDir, s.id, "segments", "s00000.wav")), false);
});

test("upload cap cleans partial file and client reads 413", async (t) => {
  const { base, paths, fake } = await setup(t, { limits: { upload: 64 } });
  const route = "/api/upload?filename=test.wav&course=BIO101";
  const chunked = await raw(base, route, {
    method: "POST",
    headers: { Origin: base, "Transfer-Encoding": "chunked" },
    chunks: [Buffer.alloc(32), Buffer.alloc(80)],
  });
  assert.equal(chunked.status, 413);
  assert.equal(chunked.headers.connection, "close");
  assert.equal(fs.readdirSync(paths.sessionsDir).length, 0);
  assert.equal(fake.calls(), 0);
  const declared = await raw(base, route, { method: "POST", headers: { Origin: base, "Content-Length": "1000" } });
  assert.equal(declared.status, 413);
  assert.equal(fs.readdirSync(paths.sessionsDir).length, 0);
});

test("upload backpressure and failing destination are handled", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocxd-upload-helper-"));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const log = createLogger({ level: "error", write: () => {} }),
    kit = createHttp({ log, limits: { upload: 3 * 1024 * 1024 } });
  const server = http.createServer(async (req, res) => {
    try {
      const bytes = await kit.receiveUpload(req, path.join(dir, req.url === "/fail" ? "missing" : "", "upload.bin"));
      kit.send(res, 200, { bytes });
    } catch {
      kit.send(res, 500, { error: "요청을 처리하지 못했어요" });
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  );
  const base = `http://127.0.0.1:${server.address().port}`;
  const bytes = Buffer.alloc(2 * 1024 * 1024, 7),
    chunks = Array.from({ length: 32 }, (_, i) => bytes.subarray(i * 65536, (i + 1) * 65536));
  const success = await raw(base, "/ok", { method: "POST", headers: { "Transfer-Encoding": "chunked" }, chunks });
  assert.equal(success.status, 200);
  assert.equal(JSON.parse(success.body).bytes, bytes.length);
  assert.equal((await fsp.stat(path.join(dir, "upload.bin"))).size, bytes.length);
  const fail = await raw(base, "/fail", {
    method: "POST",
    headers: { "Transfer-Encoding": "chunked" },
    chunks: [Buffer.alloc(10)],
  });
  assert.equal(fail.status, 500);
  assert.equal(fail.body.includes("ENOENT"), false);
  assert.equal(fs.existsSync(path.join(dir, "missing", "upload.bin")), false);
});

test("static and ID traversal are 404", async (t) => {
  const { base, dir } = await setup(t);
  for (const route of [
    "/../secret.txt",
    "/%2e%2e/secret.txt",
    "/%2fetc",
    "/%5cetc",
    "/api/sessions/nope",
    "/api/sessions/20260101-000000-abcd/segments/100001/audio",
    "/api/sessions/20260101-000000-abcd/segments/01/audio",
  ]) {
    const r = await raw(base, route);
    assert.equal(r.status, 404, route);
    assert.equal(r.body.includes("<!doctype"), false);
  }
  const publicRoot = path.join(dir, "public"),
    outside = path.join(dir, "secret.txt");
  await fsp.mkdir(publicRoot);
  await fsp.writeFile(outside, "OUTSIDE-MARKER");
  await fsp.symlink(outside, path.join(publicRoot, "leak.txt"));
  const kit = createHttp({ log: createLogger({ write: () => {} }) });
  assert.equal(await kit.staticPath(publicRoot, "/leak.txt"), null);
});

test("headers on HTML, API, SSE and static", async (t) => {
  const { base } = await setup(t);
  const s = await create(base);
  const accepted = await raw(base, `/api/sessions/${s.id}/segments?index=0&start=0`, {
    method: "POST",
    headers: { Origin: base },
    chunks: [wav()],
  });
  assert.equal(accepted.status, 202);
  for (const route of [
    "/",
    "/styles.css",
    "/api/health",
    `/api/sessions/${s.id}/events`,
    `/api/sessions/${s.id}/segments/0/audio`,
  ]) {
    const controller = new AbortController();
    const r = await fetch(base + route, { signal: controller.signal });
    assert.equal(r.status, 200, route);
    for (const h of [
      "content-security-policy",
      "x-content-type-options",
      "referrer-policy",
      "x-frame-options",
      "permissions-policy",
      "cross-origin-opener-policy",
      "cross-origin-resource-policy",
      "x-request-id",
    ])
      assert.ok(r.headers.get(h), `${route}: ${h}`);
    assert.match(r.headers.get("content-security-policy"), /script-src 'self'; style-src 'self' 'unsafe-inline'/);
    if (route.startsWith("/api/")) assert.equal(r.headers.get("cache-control")?.includes("no-store"), true);
    controller.abort();
  }
  const audio = await fetch(`${base}/api/sessions/${s.id}/segments/0/audio`, {
    headers: { Range: "bytes=0-15" },
  });
  assert.equal(audio.status, 206);
  assert.equal((await audio.arrayBuffer()).byteLength, 16);
  for (const h of ["content-security-policy", "x-content-type-options", "x-request-id"]) {
    assert.ok(audio.headers.get(h), `audio range: ${h}`);
  }
});

test("legacy disk errors are sanitized before session GET", async (t) => {
  let id;
  const { base } = await setup(t, {
    beforeStart: async (paths) => {
      id = await legacySession(paths);
    },
  });
  const response = await fetch(`${base}/api/sessions/${id}`);
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.equal(body.includes("LEGACY-UPSTREAM-BODY"), false);
  const session = JSON.parse(body);
  assert.equal(session.segments[0].status, "error");
  assert.equal(session.meta.refineWindows.end[0].status, "error");
});

test("SSE keeps a backpressured client open for later frames", (t) => {
  class FakeResponse extends EventEmitter {
    writableEnded = false;
    destroyed = false;
    writableLength = 0;
    frames = [];
    writeHead() {}
    write(frame) {
      this.frames.push(frame);
      this.writableLength += Buffer.byteLength(frame);
      return false;
    }
    end() {
      this.writableEnded = true;
      this.emit("close");
    }
  }
  const sse = createSse({ store: {}, http: {} });
  t.after(() => sse.shutdown());
  const res = new FakeResponse();
  const push = sse.stream(res);
  push({ type: "first" });
  assert.equal(res.writableEnded, false);
  push({ type: "second" });
  assert.match(res.frames.join(""), /"type":"second"/);
  res.writableLength = 1024 * 1024;
  push({ type: "over-cap" });
  assert.equal(res.writableEnded, true);
  sse.shutdown();
});

test("startup immediately resumes autoRetry error segments", async (t) => {
  let id;
  const { base, fake } = await setup(t, {
    beforeStart: async (paths) => {
      id = await legacySession(paths, { autoRetry: true });
    },
  });
  const session = await waitSegment(base, id, 0, "done", 2000);
  assert.equal(session.segments[0].error, null);
  assert.equal(fake.calls(), 1);
});

test("no key or upstream body in responses, stored errors, or logs", async (t) => {
  const secret = `secret-${crypto.randomBytes(8).toString("hex")}`,
    marker = `marker-${crypto.randomBytes(8).toString("hex")}`,
    logs = [];
  const { base, fake, paths } = await setup(t, { secret, errorBody: `${marker} ${secret}`, logs });
  const s = await create(base),
    first = await raw(base, `/api/sessions/${s.id}/segments?index=0&start=0`, {
      method: "POST",
      headers: { Origin: base },
      chunks: [wav()],
    });
  assert.equal(first.status, 202);
  await waitSegment(base, s.id, 0, "done");
  await fetch(`${fake.url}/__mode?m=502`);
  const refine = await raw(base, `/api/sessions/${s.id}/refine`, {
    ...json({}),
    headers: { "Content-Type": "application/json", Origin: base },
  });
  assert.equal(refine.status, 202);
  const deadline = Date.now() + 3000;
  for (;;) {
    const current = await (await fetch(`${base}/api/sessions/${s.id}`)).json();
    if (current.meta.refineWindows?.["300"]?.[0]?.status === "error") break;
    if (Date.now() > deadline) throw new Error("refine did not fail");
    await new Promise((r) => setTimeout(r, 25));
  }
  const second = await raw(base, `/api/sessions/${s.id}/segments?index=1&start=1`, {
    method: "POST",
    headers: { Origin: base },
    chunks: [wav()],
  });
  assert.equal(second.status, 202);
  const failed = await waitSegment(base, s.id, 1, "error");
  const generated = await fetch(`${base}/api/sessions/${s.id}/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: base },
    body: "{}",
  });
  const genText = await generated.text();
  assert.match(genText, /"type":"error"/);
  const exportText = await (await fetch(`${base}/api/sessions/${s.id}/export?format=md`)).text();
  const disk = await fsp.readFile(path.join(paths.sessionsDir, s.id, "transcript.json"), "utf8");
  for (const text of [refine.body, second.body, JSON.stringify(failed), genText, exportText, disk, logs.join("\n")]) {
    assert.equal(text.includes(secret), false);
    assert.equal(text.includes(marker), false);
  }
  assert.equal(logs.join("\n").includes("Example transcript"), false);
});

test("logger reduces Error messages to categories", () => {
  const lines = [],
    log = createLogger({ write: (x) => lines.push(x) });
  log.error("x", "y", { error: new Error("SECRET-MSG") });
  log.error("x", "y", { error: "SECRET-MSG" });
  assert.match(lines[0], /error=Error/);
  assert.match(lines[1], /error=unknown/);
  assert.equal(lines.join("\n").includes("SECRET-MSG"), false);
});

test("logger redacts a key crossing the 512-character limit", () => {
  const lines = [];
  const key = "SECRET-CROSS-BOUNDARY";
  const log = createLogger({ secret: key, write: (line) => lines.push(line) });
  log.info("log", "x".repeat(495) + key);
  assert.equal(lines[0].includes(key.slice(0, 7)), false);
  assert.match(lines[0], /\[redacted\]/);
});

test("shutdown drains and closes SSE", { timeout: 15000 }, async (t) => {
  const { base, runtime, fake } = await setup(t, { mode: "held" });
  const s = await create(base);
  const controller = new AbortController(),
    events = await fetch(`${base}/api/sessions/${s.id}/events`, { signal: controller.signal });
  const reader = events.body.getReader();
  await reader.read();
  const accepted = await raw(base, `/api/sessions/${s.id}/segments?index=0&start=0`, {
    method: "POST",
    headers: { Origin: base },
    chunks: [wav()],
  });
  assert.equal(accepted.status, 202);
  await fake.started;
  assert.equal(fake.calls(), 1);
  const closing = runtime.close();
  let frame = "";
  while (!frame.includes('"type":"shutdown"')) {
    const { value, done } = await reader.read();
    if (done) break;
    frame += new TextDecoder().decode(value);
  }
  assert.match(frame, /"type":"shutdown"/);
  controller.abort();
  fake.release();
  await closing;
  await runtime.close();
  await assert.rejects(fetch(base + "/api/health"));
});

test("shutdown cancels transcription retry backoff", async (t) => {
  const logs = [],
    { base, runtime, fake } = await setup(t, { mode: "502", logs });
  const s = await create(base);
  const accepted = await raw(base, `/api/sessions/${s.id}/segments?index=0&start=0`, {
    method: "POST",
    headers: { Origin: base },
    chunks: [wav()],
  });
  assert.equal(accepted.status, 202);
  const deadline = Date.now() + 2000;
  while (!logs.some((line) => line.includes("upstream_failed")) && Date.now() < deadline)
    await new Promise((r) => setTimeout(r, 10));
  assert.equal(fake.calls(), 1);
  const at = Date.now();
  await runtime.close();
  assert.ok(Date.now() - at < 1000, "retry delay should not extend shutdown");
  assert.equal(fake.calls(), 1);
});
