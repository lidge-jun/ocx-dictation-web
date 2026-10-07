import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { renderVaultPaths, writeVaultExport } from "../lib/export.mjs";
import { startServer } from "../server.mjs";
import { resolvePaths } from "../lib/paths.mjs";
import { loadConfig } from "../lib/config.mjs";

const fixtureVault = (root, extra = {}) => ({ root, notePath: "{course}/{date}-{slug}.md",
  rawPath: "_raw/{course}/{date}-transcript.txt", includeRaw: false, ...extra });
const session = (title = "Sample lecture", course = "BIO101") => ({
  meta: { id: "20260102-000102-abcd", title, course, createdAt: "2026-01-01T15:01:02.000Z" },
  transcript: { segments: [] }, aiNote: "", notes: { lines: [] },
});
const renderNote = (_s, { rawLink }) => `Memo${rawLink ? ` [raw](${rawLink})` : ""}`;
const renderRaw = () => "[00:00] spoken words";
const logger = { warn() {}, error() {} };
async function temp(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocx-vault-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
const files = async (dir) => readdir(dir, { recursive: true });

test("all path tokens use configured timezone and empty course becomes general", async (t) => {
  const root = await temp(t);
  const vault = fixtureVault(root, { notePath: "{year}/{month}/{day}/{date}-{time}-{course}-{slug}-{id}.md" });
  const result = await renderVaultPaths(vault, session("Field Notes", ""), "Asia/Seoul");
  assert.equal(result.notePath, "2026/01/02/2026-01-02-000102-general-field-notes-20260102-000102-abcd.md");
  assert.equal(result.exists.note, false);
});

test("bad template classes reject before any write", async (t) => {
  const root = await temp(t);
  for (const template of ["/x", "C:\\x", "../x.md", "a/../x.md", "a\\x.md", "a/\0x.md",
    "a/\u0007x.md", ".hidden/x.md", "a//x.md", "{unknown}.md", "~/x.md"]) {
    for (const field of ["notePath", "rawPath"]) {
      await assert.rejects(renderVaultPaths(fixtureVault(root, { [field]: template }), session(), "UTC"),
        (err) => err.status === 400);
    }
  }
  assert.deepEqual(await files(root), []);
});

test("title and course token values sanitize separators, controls, dot segments and Unicode", async (t) => {
  const root = await temp(t);
  const vault = fixtureVault(root, { notePath: "{course}/{slug}.md" });
  for (const value of ["/x", "C:\\x", "../x", "a\\b", "a\0b", "a\u0007b", ".hidden"]) {
    const title = await renderVaultPaths(vault, session(value, "BIO101"), "UTC");
    const course = await renderVaultPaths(vault, session("title", value), "UTC");
    assert.equal(title.notePath.startsWith("BIO101/"), true);
    assert.equal(course.notePath.endsWith("/title.md"), true);
    assert.equal(title.notePath.includes(".."), false);
    assert.equal(course.notePath.includes(".."), false);
    assert.equal(course.notePath.includes("\\"), false);
  }
  const composed = await renderVaultPaths(vault, session("Café", "BIO101"), "UTC");
  const decomposed = await renderVaultPaths(vault, session("Cafe\u0301", "BIO101"), "UTC");
  assert.equal(composed.notePath, decomposed.notePath);
});

test("missing/file root, same target, disabled raw and escaped ancestor reject", async (t) => {
  const root = await temp(t);
  await assert.rejects(renderVaultPaths(fixtureVault(path.join(root, "missing")), session(), "UTC"),
    (err) => err.status === 400);
  const fileRoot = path.join(root, "file");
  await writeFile(fileRoot, "x");
  await assert.rejects(renderVaultPaths(fixtureVault(fileRoot), session(), "UTC"),
    (err) => err.status === 400);
  await assert.rejects(renderVaultPaths(fixtureVault(root, { rawPath: "{course}/{date}-{slug}.md" }),
    session(), "UTC"), (err) => err.status === 400);
  await assert.rejects(writeVaultExport({ vault: fixtureVault(root, { rawPath: null }), session: session(),
    timezone: "UTC", toMarkdown: renderNote, transcriptText: renderRaw, includeRaw: true, log: logger }),
  (err) => err.status === 400);
  const outside = await temp(t);
  await symlink(outside, path.join(root, "BIO101"));
  await assert.rejects(renderVaultPaths(fixtureVault(root), session(), "UTC"), (err) => err.status === 403);
  assert.deepEqual(await files(outside), []);
});

test("final symlink rejects even when it points inside the root", async (t) => {
  const root = await temp(t);
  await mkdir(path.join(root, "BIO101"));
  await writeFile(path.join(root, "inside.md"), "safe");
  await symlink(path.join(root, "inside.md"), path.join(root, "BIO101", "2026-01-02-sample-lecture.md"));
  await assert.rejects(renderVaultPaths(fixtureVault(root), session(), "Asia/Seoul"),
    (err) => err.status === 403);
  assert.equal(await readFile(path.join(root, "inside.md"), "utf8"), "safe");
});

test("pair publication, no-overwrite collision, overwrite and rollback preserve bytes", async (t) => {
  const root = await temp(t), vault = fixtureVault(root), input = { vault, session: session(),
    timezone: "Asia/Seoul", toMarkdown: renderNote, transcriptText: renderRaw, includeRaw: true, log: logger };
  const first = await writeVaultExport(input);
  const noteFile = path.join(root, first.notePath), rawFile = path.join(root, first.rawPath);
  assert.match(await readFile(noteFile, "utf8"), /\[raw\]\(\.\.\/_raw\/BIO101\/2026-01-02-transcript.txt\)/);
  assert.equal(await readFile(rawFile, "utf8"), "[00:00] spoken words\n");
  await assert.rejects(writeVaultExport(input), (err) => err.status === 409);
  assert.equal(await readFile(noteFile, "utf8"), "Memo [raw](../_raw/BIO101/2026-01-02-transcript.txt)");
  for (const overwrite of [false, true]) {
    const beforeNote = await readFile(noteFile, "utf8"), beforeRaw = await readFile(rawFile, "utf8");
    await assert.rejects(writeVaultExport({ ...input, overwrite,
      hooks: { beforePublish: (_file, n) => { if (n === 1) throw new Error("injected"); } } }));
    assert.equal(await readFile(noteFile, "utf8"), beforeNote);
    assert.equal(await readFile(rawFile, "utf8"), beforeRaw);
    assert.equal((await files(root)).some((file) => /\.(?:bak|tmp)-/.test(file)), false);
  }
  await writeVaultExport({ ...input, overwrite: true, toMarkdown: () => "new memo" });
  assert.equal(await readFile(noteFile, "utf8"), "new memo");
});

test("concurrent no-overwrite writes leave exactly one published file", async (t) => {
  const root = await temp(t), input = { vault: fixtureVault(root), session: session(),
    timezone: "UTC", toMarkdown: renderNote, transcriptText: renderRaw, includeRaw: false, log: logger };
  const results = await Promise.allSettled([writeVaultExport(input), writeVaultExport(input)]);
  assert.deepEqual(results.map((result) => result.status).sort(), ["fulfilled", "rejected"]);
  assert.equal(results.find((result) => result.status === "rejected").reason.status, 409);
});

test("raw link encodes URL special characters while files keep readable names", async (t) => {
  const root = await temp(t), vault = fixtureVault(root, { rawPath: "_raw/{course}/A #1?.txt" });
  const saved = await writeVaultExport({ vault, session: session(), timezone: "UTC",
    toMarkdown: renderNote, transcriptText: renderRaw, includeRaw: true, log: logger });
  assert.equal(saved.rawPath, "_raw/BIO101/A #1?.txt");
  const note = await readFile(path.join(root, saved.notePath), "utf8");
  assert.match(note, /A%20%231%3F\.txt/);
});

test("failed rollback reports and retains a recoverable backup without absolute paths", async (t) => {
  const root = await temp(t), vault = fixtureVault(root), input = { vault, session: session(),
    timezone: "UTC", toMarkdown: renderNote, transcriptText: renderRaw, includeRaw: true, log: logger };
  const lines = [];
  const capture = { warn: (...a) => lines.push(JSON.stringify(a)), error: (...a) => lines.push(JSON.stringify(a)) };
  const saved = await writeVaultExport(input);
  const noteFile = path.join(root, saved.notePath), rawFile = path.join(root, saved.rawPath);
  await writeFile(noteFile, "prior note");
  await writeFile(rawFile, "prior raw");
  await assert.rejects(writeVaultExport({ ...input, log: capture, overwrite: true, hooks: {
    beforePublish: (_file, index) => { if (index === 1) throw new Error("second publication"); },
    beforeRestore: () => { throw new Error("restore unavailable"); },
  } }), (err) => err.status === 500 && /backups kept in the vault: BIO101\/.*\.bak-/.test(err.message)
    && !err.message.includes(root));
  assert.equal(lines.some((l) => l.includes(root)), false); // no absolute vault path in logs
  const leftovers = (await files(root)).filter((file) => /\.bak-/.test(file));
  assert.equal(leftovers.length, 1);
  assert.equal(await readFile(path.join(root, leftovers[0]), "utf8"), "prior note");
  assert.equal(await readFile(rawFile, "utf8"), "prior raw");
});

test("overwrite never replaces a directory or other non-regular target", async (t) => {
  const root = await temp(t);
  const vault = fixtureVault(root, { notePath: "target" });
  await mkdir(path.join(root, "target"));
  await writeFile(path.join(root, "target", "existing.md"), "keep me");
  for (const overwrite of [false, true]) {
    await assert.rejects(writeVaultExport({ vault, session: session(), timezone: "UTC", toMarkdown: renderNote,
      transcriptText: renderRaw, includeRaw: false, overwrite, log: logger }), (err) => err.status === 409);
    assert.equal(await readFile(path.join(root, "target", "existing.md"), "utf8"), "keep me");
    assert.equal((await files(root)).some((file) => /\.(?:bak|tmp)-/.test(file)), false);
  }
});

test("staging failures remove all half-written temp files", async (t) => {
  const root = await temp(t), input = { vault: fixtureVault(root), session: session(),
    timezone: "UTC", toMarkdown: renderNote, transcriptText: renderRaw, includeRaw: true, log: logger };
  for (const hooks of [
    { beforeStage: (n) => { if (n === 1) throw new Error("before stage"); } },
    { afterCreate: (n) => { if (n === 1) throw new Error("after create"); } },
    { beforeSync: (n) => { if (n === 1) throw new Error("sync failed"); } },
  ]) {
    await assert.rejects(writeVaultExport({ ...input, hooks }));
    assert.equal((await files(root)).some((file) => /\.(?:bak|tmp)-/.test(file)), false);
    assert.equal((await files(root)).some((file) => file.endsWith(".md") || file.endsWith(".txt")), false);
  }
});

async function routeFixture(t, { enabled = true, hooks = {}, warnings = [] } = {}) {
  const home = await temp(t), vaultRoot = path.join(home, "vault");
  await mkdir(vaultRoot);
  const env = { OCX_DICTATION_HOME: home }, paths = resolvePaths({ env, appDir: home, homedir: home });
  await writeFile(paths.configFile, JSON.stringify({ vault: enabled ? fixtureVault(vaultRoot) : null }));
  const cfg = { ...loadConfig({ paths, env }), port: 0, ocxBase: "http://127.0.0.1:1" };
  const runtime = await startServer(cfg, paths, { vaultHooks: hooks,
    log: { info() {}, error() {}, warn(...args) { warnings.push(args); } } });
  t.after(() => runtime.close());
  return { home, vaultRoot, paths, base: `http://127.0.0.1:${runtime.server.address().port}` };
}
const post = (base, url, body) => fetch(base + url, { method: "POST",
  headers: { "content-type": "application/json", origin: base }, body });

test("disabled and missing session gates precede malformed JSON parsing", async (t) => {
  const disabled = await routeFixture(t, { enabled: false });
  const made = await post(disabled.base, "/api/sessions", JSON.stringify({ title: "Sample", course: "BIO101" }));
  const id = (await made.json()).id, url = `/api/sessions/${id}/vault`;
  assert.deepEqual(await (await fetch(disabled.base + url)).json(), { error: "vault export not configured" });
  const bad = await post(disabled.base, url, "{");
  assert.equal(bad.status, 404);
  assert.deepEqual(await bad.json(), { error: "vault export not configured" });
  const enabled = await routeFixture(t);
  const missing = await post(enabled.base, url, "{");
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error, "녹음을 찾을 수 없어요");
});

test("route preview, notes, collision, overwrite, metadata and sanitized public errors", async (t) => {
  const f = await routeFixture(t);
  const created = await post(f.base, "/api/sessions", JSON.stringify({ title: "Sample lecture", course: "BIO101" }));
  const id = (await created.json()).id, url = `/api/sessions/${id}/vault`;
  const put = await fetch(`${f.base}/api/sessions/${id}/notes`, { method: "PUT",
    headers: { "content-type": "application/json", origin: f.base },
    body: JSON.stringify({ baseRevision: 0, lines: [{ id: "n1", t: 0, text: "Disposable memo",
      important: false }] }) });
  assert.equal(put.status, 200);
  const preview = await (await fetch(f.base + url)).json();
  assert.equal(preview.enabled, true);
  assert.equal(preview.notePath.includes(f.home), false);
  assert.deepEqual(preview.exists, { note: false, raw: false });
  assert.equal((await post(f.base, url, JSON.stringify({ unexpected: true }))).status, 400);
  assert.equal((await post(f.base, url, "{")).status, 400);
  const saved = await post(f.base, url, JSON.stringify({ includeRaw: true }));
  assert.equal(saved.status, 200);
  const result = await saved.json();
  const note = await readFile(path.join(f.vaultRoot, result.notePath), "utf8");
  assert.match(note, /Disposable memo/);
  assert.doesNotMatch(note, /<!-- notes revision/);
  assert.equal((await post(f.base, url, JSON.stringify({ includeRaw: true }))).status, 409);
  assert.equal((await post(f.base, url, JSON.stringify({ includeRaw: true, overwrite: true }))).status, 200);
  const meta = await (await fetch(`${f.base}/api/sessions/${id}`)).json();
  assert.equal(meta.meta.vaultExport.notePath, result.notePath);
  assert.equal(meta.meta.vaultExport.rawPath, result.rawPath);
  const persisted = JSON.parse(await readFile(path.join(f.paths.sessionsDir, id, "meta.json"), "utf8"));
  assert.equal(persisted.vaultExport.notePath, result.notePath);
  assert.equal((await fetch(`${f.base}/api/sessions/${id}/wiki`)).status, 404);
  assert.equal((await fetch(`${f.base}/api/prompts/wiki/BIO101`)).status, 404);
});

test("missing vault root gets sanitized HTTP error without leaking its path", async (t) => {
  const f = await routeFixture(t);
  const made = await post(f.base, "/api/sessions", JSON.stringify({ title: "Sample", course: "BIO101" }));
  const id = (await made.json()).id;
  await rm(f.vaultRoot, { recursive: true });
  const response = await fetch(`${f.base}/api/sessions/${id}/vault`);
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(JSON.stringify(body).includes(f.vaultRoot), false);
  assert.ok(body.requestId);
});

test("two sessions sharing a destination cannot both export without overwrite", async (t) => {
  const f = await routeFixture(t);
  const create = () => post(f.base, "/api/sessions", JSON.stringify({ title: "Same title", course: "BIO101" }))
    .then((response) => response.json());
  const [a, b] = await Promise.all([create(), create()]);
  const write = (id) => post(f.base, `/api/sessions/${id}/vault`, JSON.stringify({ includeRaw: true }));
  const responses = await Promise.all([write(a.id), write(b.id)]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
  const preview = await (await fetch(`${f.base}/api/sessions/${a.id}/vault`)).json();
  assert.deepEqual(preview.exists, { note: true, raw: true });
});

test("cleanup failure after publication still returns 200 and saves metadata", async (t) => {
  const warnings = [], f = await routeFixture(t, { warnings,
    hooks: { cleanup: (_file) => { if (warnings.length === 0) throw new Error("injected cleanup failure"); } } });
  const made = await post(f.base, "/api/sessions", JSON.stringify({ title: "Sample", course: "BIO101" }));
  const id = (await made.json()).id;
  const saved = await post(f.base, `/api/sessions/${id}/vault`, JSON.stringify({ includeRaw: true }));
  assert.equal(saved.status, 200);
  const body = await saved.json();
  assert.equal(await readFile(path.join(f.vaultRoot, body.notePath), "utf8") !== "", true);
  assert.equal(await readFile(path.join(f.vaultRoot, body.rawPath), "utf8"), "\n");
  const meta = await (await fetch(`${f.base}/api/sessions/${id}`)).json();
  assert.equal(meta.meta.vaultExport.notePath, body.notePath);
  assert.deepEqual(warnings, [["vault", "cleanup_leftover", { error: "cleanup_failed" }]]);
  assert.equal((await files(f.vaultRoot)).filter((file) => /\.tmp-/.test(file)).length, 1);
});
