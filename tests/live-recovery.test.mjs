import test from 'node:test';
import assert from 'node:assert/strict';
import { createRecovery } from '../public/js/recovery.js';

function fixture({ missing = false } = {}) {
  const sid = '20261007-120000-abcd';
  const active = new Map([[sid, { sid, nextIndex: 2, offset: 5, updatedAt: 100 }]]);
  const partial = new Map([[sid, { sid, index: 2, start: 5, pcm: new Float32Array(16000), peak: .1 }]]);
  const queue = new Map(), calls = [], enqueued = [];
  const idb = {
    getActives: async () => [...active.values()],
    getPartial: async (id) => partial.get(id),
    getSegments: async () => [...queue.values()],
    deletePartial: async (id) => { calls.push('partial'); partial.delete(id); },
    deleteActive: async (id) => { calls.push('active'); active.delete(id); },
    deleteSegment: async (key) => { calls.push('segment'); queue.delete(key); },
  };
  const locks = { request: async (name, opts, fn) => {
    assert.equal(name, 'ocx-dictation:recorder');
    assert.deepEqual(opts, { ifAvailable: true });
    return fn({ name });
  } };
  const api = async () => {
    if (missing) throw Object.assign(new Error('missing'), { status: 404 });
    return { segments: [] };
  };
  const enqueueSegment = async (seg) => {
    enqueued.push(seg);
    const key = `${seg.sid}:${String(seg.index).padStart(6, '0')}`;
    queue.set(key, { ...seg, key });
  };
  const recovery = createRecovery({ idb, api, enqueueSegment, locks,
    encodeWav: (pcm) => new Uint8Array(pcm.length), sampleRate: 16000 });
  return { sid, active, partial, queue, calls, enqueued, idb, recovery };
}

test('recovery is idempotent per segment index', async () => {
  const f = fixture();
  assert.deepEqual(await f.recovery.recoverInterrupted(),
    [{ sid: f.sid, nextIndex: 3, offset: 6, at: 100 }]);
  assert.equal(f.enqueued.length, 1);
  assert.deepEqual(f.calls, ['partial', 'active']);
  assert.deepEqual(await f.recovery.recoverInterrupted(), []);
  assert.equal(f.queue.size, 1);
});

test('stop cleanup leaves active marker when partial deletion fails', async () => {
  const f = fixture();
  f.idb.deletePartial = async () => { throw new Error('IDB delete failed'); };
  await assert.rejects(f.recovery.cleanupStopped(f.sid), /IDB delete failed/);
  assert.equal(f.active.has(f.sid), true);
  assert.equal(f.partial.has(f.sid), true);
  assert.deepEqual(f.calls, []);
});

test('recovery re-reads queue before enqueue', async () => {
  const f = fixture();
  const original = f.idb.getSegments;
  let reads = 0;
  f.idb.getSegments = async () => {
    if (++reads === 2) f.queue.set(`${f.sid}:000002`, { sid: f.sid, index: 2, key: `${f.sid}:000002` });
    return original();
  };
  const result = await f.recovery.recoverInterrupted();
  assert.equal(reads, 2);
  assert.equal(f.enqueued.length, 0);
  assert.equal(result[0].nextIndex, 3);
  assert.deepEqual(f.calls, ['partial', 'active']);
});

test('server 404 preserves PCM, marker and queue until explicit discard', async () => {
  const f = fixture({ missing: true });
  f.queue.set(`${f.sid}:000001`, { sid: f.sid, index: 1, key: `${f.sid}:000001` });
  assert.deepEqual(await f.recovery.recoverInterrupted(), [{ sid: f.sid, at: 100, orphan: true }]);
  assert.equal(f.active.has(f.sid), true);
  assert.equal(f.partial.get(f.sid).pcm.length, 16000);
  assert.equal(f.queue.size, 1);
  assert.deepEqual(f.calls, []);
  await f.recovery.discardOrphan(f.sid);
  assert.deepEqual(f.calls, ['segment', 'partial', 'active']);
});

test('stale partial already queued is cleared', async () => {
  const f = fixture();
  f.active.get(f.sid).nextIndex = 3;
  f.queue.set(`${f.sid}:000002`, { sid: f.sid, index: 2, key: `${f.sid}:000002` });
  const result = await f.recovery.recoverInterrupted();
  assert.equal(result[0].cleared, true);
  assert.equal(f.enqueued.length, 0);
  assert.deepEqual(f.calls, ['partial', 'active']);
  assert.deepEqual(await f.recovery.recoverInterrupted(), []);
});

test('stale partial not persisted is retained for attention', async () => {
  const f = fixture();
  f.active.get(f.sid).nextIndex = 3;
  const result = await f.recovery.recoverInterrupted();
  assert.equal(result[0].needsAttention, true);
  assert.equal(f.active.has(f.sid), true);
  assert.equal(f.partial.has(f.sid), true);
  assert.deepEqual(f.calls, []);
});

test('stale partial already on server is cleared', async () => {
  const f = fixture();
  f.active.get(f.sid).nextIndex = 3;
  const recovery = createRecovery({ idb: f.idb, api: async () => ({ segments: [{ index: 2 }] }),
    enqueueSegment: async () => { throw new Error('must not enqueue'); },
    locks: { request: async (_name, _opts, fn) => fn({}) },
    encodeWav: () => new Uint8Array(0), sampleRate: 16000 });
  const result = await recovery.recoverInterrupted();
  assert.equal(result[0].cleared, true);
  assert.deepEqual(f.calls, ['partial', 'active']);
});
