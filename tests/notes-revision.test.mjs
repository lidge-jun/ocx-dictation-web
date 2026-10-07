import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { startServer } from '../server.mjs';
import { resolvePaths } from '../lib/paths.mjs';
import { loadConfig } from '../lib/config.mjs';
import { createLogger } from '../lib/log.mjs';
import { writeJsonAtomic, writeTextAtomic } from '../lib/util.mjs';

async function setup(t, internal = {}) {
  const home = await mkdtemp(join(tmpdir(), 'ocx-notes-test-'));
  const env = { OCX_DICTATION_HOME: home };
  const paths = resolvePaths({ env, appDir: home, homedir: home });
  const cfg = { ...loadConfig({ paths, env }), port: 0, ocxBase: 'http://127.0.0.1:1' };
  const runtime = await startServer(cfg, paths, internal);
  const runtimes = [runtime];
  const base = `http://127.0.0.1:${runtime.server.address().port}`;
  t.after(async () => { for (const running of runtimes.reverse()) await running.close();
    await rm(home, { recursive: true, force: true }); });
  const created = await fetch(`${base}/api/sessions`, { method: 'POST',
    headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ title: 'BIO101 lecture', course: 'BIO101' }) });
  assert.equal(created.status, 201);
  const session = await created.json();
  assert.equal(session.notes.revision, 0);
  assert.match(await readFile(join(paths.sessionsDir, session.id, 'notes.md'), 'utf8'),
    /^<!-- notes revision 0 -->\n/);
  return { base, id: session.id, sessionsDir: paths.sessionsDir, runtime, runtimes, cfg, paths };
}
function put(base, id, body, tabId, extraHeaders = {}) {
  return fetch(`${base}/api/sessions/${id}/notes`, { method: 'PUT',
    headers: { 'content-type': 'application/json', origin: base,
      ...(tabId ? { 'X-Tab-Id': tabId } : {}), ...extraHeaders },
    body: JSON.stringify(body) });
}
async function nextNotes(reader) {
  const dec = new TextDecoder(); let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) throw new Error('SSE ended before notes event');
    buffer += dec.decode(value, { stream: true });
    let end;
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
      const line = block.split('\n').find((s) => s.startsWith('data:'));
      if (line) { const event = JSON.parse(line.slice(5)); if (event.type === 'notes') return event; }
    }
  }
}

test('stale baseRevision returns 409 with current revision and lines', async (t) => {
  const { base, id, sessionsDir } = await setup(t);
  const lines = [{ id: 'n1', t: 1, text: 'Example note', important: false }];
  const first = await put(base, id, { lines, baseRevision: 0 }, 'tab-a');
  assert.equal(first.status, 200); assert.equal((await first.json()).revision, 1);
  const disk = JSON.parse(await readFile(join(sessionsDir, id, 'notes.json'), 'utf8'));
  assert.equal(disk.revision, 1); assert.deepEqual(disk.lines, lines);
  assert.match(await readFile(join(sessionsDir, id, 'notes.md'), 'utf8'),
    /^<!-- notes revision 1 -->\n.*Example note/s);
  const exported = await fetch(`${base}/api/sessions/${id}/export?format=md`).then((r) => r.text());
  assert.doesNotMatch(exported, /<!-- notes revision \d+ -->/);
  const stale = await put(base, id, { lines: [], baseRevision: 0 }, 'tab-b');
  assert.equal(stale.status, 409);
  assert.deepEqual(await stale.json(), { error: 'conflict', revision: 1, lines });
  const read = await fetch(`${base}/api/sessions/${id}`).then((r) => r.json());
  assert.equal(read.notes.revision, 1); assert.deepEqual(read.notes.lines, lines);
});

test('legacy PUT increments revision and missing X-Tab-Id emits by:null', async (t) => {
  const { base, id } = await setup(t);
  const ac = new AbortController(); t.after(() => ac.abort());
  const events = await fetch(`${base}/api/sessions/${id}/events`, { signal: ac.signal });
  const reader = events.body.getReader();
  const waiting = nextNotes(reader);
  const legacy = await put(base, id, { lines: [{ id: 'n2', t: 0, text: 'Legacy', important: false }] });
  assert.equal(legacy.status, 200);
  assert.equal((await legacy.json()).revision, 1);
  assert.equal((await waiting).by, null);
  await reader.cancel();
});

test('empty generate retains the no-content error', async (t) => {
  const { base, id } = await setup(t);
  const response = await fetch(`${base}/api/sessions/${id}/generate`, { method: 'POST',
    headers: { 'content-type': 'application/json', origin: base }, body: '{}' });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, '정리할 대본이나 필기가 아직 없어요');
});

test('second SSE client receives notes event tagged with saving tab ID', async (t) => {
  const { base, id } = await setup(t);
  const acA = new AbortController(), acB = new AbortController();
  t.after(() => { acA.abort(); acB.abort(); });
  const url = `${base}/api/sessions/${id}/events`;
  const [a, b] = await Promise.all([
    fetch(url, { signal: acA.signal }),
    fetch(url, { signal: AbortSignal.any([acB.signal, AbortSignal.timeout(2000)]) })]);
  assert.equal(a.status, 200); assert.equal(b.status, 200);
  const readerB = b.body.getReader();
  const waiting = nextNotes(readerB);
  const lines = [{ id: 'n3', t: 3, text: 'Shared', important: true }];
  const saved = await put(base, id, { lines, baseRevision: 0 }, 'tab-a');
  assert.equal(saved.status, 200);
  assert.deepEqual(await waiting, { type: 'notes', revision: 1, lines, by: 'tab-a' });
  await readerB.cancel(); await a.body.cancel();
});

test('invalid tab ID and foreign requests are denied before note write', async (t) => {
  const { base, id } = await setup(t);
  const body = { lines: [], baseRevision: 0 };
  assert.equal((await put(base, id, body, 'x'.repeat(129))).status, 400);
  assert.equal((await put(base, id, body, 'valid', { origin: 'https://foreign.example' })).status, 403);
  assert.equal((await put(base, id, body, 'valid', { 'sec-fetch-site': 'cross-site' })).status, 403);
  const target = new URL(base);
  const wrongHost = await new Promise((resolve, reject) => {
    const req = http.request({ hostname: target.hostname, port: target.port,
      path: `/api/sessions/${id}/notes`, method: 'PUT',
      headers: { Host: 'foreign.example', Origin: base, 'Content-Type': 'application/json' } },
    (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject); req.end(JSON.stringify(body));
  });
  assert.equal(wrongHost, 421);
  const read = await fetch(`${base}/api/sessions/${id}`).then((r) => r.json());
  assert.equal(read.notes.revision, 0);
});

test('JSON write failure keeps old revision in memory and on disk', async (t) => {
  let failJson = false;
  const f = await setup(t, { writeJson: (file, value) => {
    if (failJson && file.endsWith('/notes.json')) throw new Error('json write failed');
    return writeJsonAtomic(file, value);
  } });
  failJson = true;
  const response = await put(f.base, f.id, { lines: [{ id: 'a', t: 0, text: 'New', important: false }],
    baseRevision: 0 }, 'tab-a');
  assert.equal(response.status, 500);
  const memory = await fetch(`${f.base}/api/sessions/${f.id}`).then((r) => r.json());
  assert.equal(memory.notes.revision, 0); assert.deepEqual(memory.notes.lines, []);
  const disk = JSON.parse(await readFile(join(f.sessionsDir, f.id, 'notes.json'), 'utf8'));
  assert.equal(disk.revision, 0); assert.deepEqual(disk.lines, []);
});

test('Markdown failure commits JSON and restart repairs derived stamp', async (t) => {
  let failMd = false;
  const logLines = [];
  const f = await setup(t, { log: createLogger({ format: 'json', write: (line) => logLines.push(JSON.parse(line)) }),
    writeText: (file, value) => {
    if (failMd && file.endsWith('/notes.md')) throw new Error('markdown write failed');
    return writeTextAtomic(file, value);
  } });
  failMd = true;
  const lines = [{ id: 'a', t: 0, text: 'Committed note', important: false }];
  const response = await put(f.base, f.id, { lines, baseRevision: 0 }, 'tab-a');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).revision, 1);
  assert.ok(logLines.some((row) => row.level === 'warn' && row.scope === 'notes'
    && row.message === 'notes_md_write_failed' && row.error === 'Error'));
  const disk = JSON.parse(await readFile(join(f.sessionsDir, f.id, 'notes.json'), 'utf8'));
  assert.equal(disk.revision, 1); assert.deepEqual(disk.lines, lines);
  const memory = await fetch(`${f.base}/api/sessions/${f.id}`).then((r) => r.json());
  assert.equal(memory.notes.revision, 1); assert.deepEqual(memory.notes.lines, lines);
  assert.match(await readFile(join(f.sessionsDir, f.id, 'notes.md'), 'utf8'),
    /^<!-- notes revision 0 -->\n/);
  await f.runtime.close();
  logLines.length = 0;
  const failedRepair = await startServer(f.cfg, f.paths, {
    writeText: (file, value) => file.endsWith('/notes.md')
      ? Promise.reject(new Error('repair failed')) : writeTextAtomic(file, value),
    log: createLogger({ format: 'json', write: (line) => logLines.push(JSON.parse(line)) }),
  });
  f.runtimes.push(failedRepair);
  assert.ok(failedRepair.server.listening);
  assert.ok(logLines.some((row) => row.level === 'warn' && row.scope === 'store'
    && row.message === 'notes_md_reconcile_failed' && row.error === 'Error'));
  await failedRepair.close();
  const restarted = await startServer(f.cfg, f.paths);
  f.runtimes.push(restarted);
  const repaired = await readFile(join(f.sessionsDir, f.id, 'notes.md'), 'utf8');
  assert.match(repaired, /^<!-- notes revision 1 -->\n/);
  assert.match(repaired, /Committed note/);
});
