import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalLockQueue } from '../public/js/local-lock-queue.js';
import { drainSegments } from '../public/js/upload-drain.js';
import { adoptDraft, listNoteStashes, noteStashKey } from '../public/js/note-stashes.js';
import { Recorder } from '../public/js/recorder.js';
import { stopRecorderUnderLock } from '../public/js/stop-ownership.js';

test('local lock operations serialize recovery, probe, and start acquisition', async () => {
  const queue = createLocalLockQueue();
  const order = [];
  let finishRecovery;
  const recovery = queue.run(() => new Promise((resolve) => {
    order.push('recovery'); finishRecovery = resolve;
  }));
  const probe = queue.run(() => { order.push('probe'); return true; });
  const start = queue.run(() => { order.push('start'); });
  await Promise.resolve();
  assert.deepEqual(order, ['recovery']);
  finishRecovery();
  await Promise.all([recovery, probe, start]);
  assert.deepEqual(order, ['recovery', 'probe', 'start']);
});

test('local lock queue continues after a rejected operation', async () => {
  const queue = createLocalLockQueue();
  const first = queue.run(() => { throw new Error('recovery failed'); });
  const second = queue.run(() => 'probe ran');
  await assert.rejects(first, /recovery failed/);
  assert.equal(await second, 'probe ran');
});

test('orphan upload remains queued while a later session uploads', async () => {
  const segments = [{ key: 'a', sid: 'missing' }, { key: 'b', sid: 'valid' }];
  const deleted = [], orphans = [], uploaded = [];
  const failed = await drainSegments(segments, { inflight: new Set(),
    upload: async (seg) => seg.sid === 'missing' ? { status: 404, ok: false } : { status: 200, ok: true },
    deleteSegment: async (key) => deleted.push(key),
    onUploaded: (seg) => uploaded.push(seg.sid), onOrphan: (seg) => orphans.push(seg.sid),
  });
  assert.equal(failed, true);
  assert.deepEqual(deleted, ['b']);
  assert.deepEqual(uploaded, ['valid']);
  assert.deepEqual(orphans, ['missing']);
});

test('recorder drops mic source after final segment write rejects', async () => {
  const rec = new Recorder({ onSegment: () => {} });
  const stopped = [];
  rec.state = 'recording';
  rec.stream = { getTracks: () => [{ stop: () => stopped.push('mic') }] };
  rec.source = { disconnect: () => stopped.push('disconnect') };
  rec.ctx = { close: async () => stopped.push('context') };
  rec._flushWorklet = async () => {};
  rec._emit = async () => { throw new Error('segment write failed'); };
  await assert.rejects(rec.stop(), /segment write failed/);
  assert.deepEqual(stopped, ['disconnect', 'mic', 'context']);
  assert.equal(rec.sourceCleanupFailed, false);
});

test('recorder reports failed mic cleanup so caller retains the lock', async () => {
  const rec = new Recorder({ onSegment: () => {} });
  rec.state = 'paused';
  rec.stream = { getTracks: () => [{ stop: () => { throw new Error('stop failed'); } }] };
  rec.ctx = { close: async () => {} };
  rec._emit = async () => {};
  await assert.rejects(rec.stop(), /stop failed/);
  assert.equal(rec.sourceCleanupFailed, true);
});

test('stop ownership releases only after source cleanup, and retains lock on cleanup error', async () => {
  const order = [];
  await assert.rejects(stopRecorderUnderLock({ sourceCleanupFailed: false,
    stop: async () => { order.push('source cleaned'); throw new Error('segment failed'); } },
  async () => order.push('queue cleaned'), () => order.push('lock released'), Promise.resolve()),
  /segment failed/);
  assert.deepEqual(order, ['source cleaned', 'lock released']);
  await assert.rejects(stopRecorderUnderLock({ sourceCleanupFailed: true,
    stop: async () => { throw new Error('mic stop failed'); } },
  async () => {}, () => order.push('unsafe release'), Promise.resolve()), /mic stop failed/);
  assert.deepEqual(order, ['source cleaned', 'lock released']);
});

function fakeStorage(entries) {
  const map = new Map(entries);
  return { get length() { return map.size; }, key: (i) => [...map.keys()][i] ?? null,
    getItem: (key) => map.get(key) ?? null, setItem: (key, value) => map.set(key, value),
    removeItem: (key) => map.delete(key) };
}

test('note stash migration preserves other-tab drafts and scopes own key', () => {
  const legacy = 'lns.notes.session';
  const other = noteStashKey('session', 'tab-b');
  const storage = fakeStorage([[legacy, JSON.stringify([{ t: 1, text: 'legacy' }])],
    [other, JSON.stringify({ revision: 2, lines: [{ t: 2, text: 'other' }] })]]);
  const first = listNoteStashes(storage, 'session', 'tab-a');
  assert.equal(first.own, noteStashKey('session', 'tab-a'));
  assert.equal(storage.getItem(legacy), null);
  assert.deepEqual(first.drafts.map((draft) => draft.key).sort(), [first.own, other].sort());
  storage.removeItem(first.own);
  assert.ok(storage.getItem(other));
  assert.deepEqual(listNoteStashes(storage, 'session', 'tab-a').drafts.map((draft) => draft.key), [other]);
});

test('legacy migration retains both drafts when own and earlier legacy keys exist', () => {
  const own = noteStashKey('session', 'tab-a');
  const previous = noteStashKey('session', 'legacy');
  const storage = fakeStorage([[own, JSON.stringify({ revision: 1, lines: [{ text: 'mine' }] })],
    [previous, JSON.stringify({ revision: 0, lines: [{ text: 'older' }] })],
    ['lns.notes.session', JSON.stringify([{ text: 'new legacy' }])]]);
  const { drafts } = listNoteStashes(storage, 'session', 'tab-a');
  assert.deepEqual(drafts.map((draft) => draft.key).sort(),
    [own, previous, noteStashKey('session', 'legacy-2')].sort());
});

test('adopting another tab draft keeps this tab unsaved draft under a kept key', () => {
  const own = noteStashKey('session', 'tab-a');
  const other = noteStashKey('session', 'tab-b');
  const storage = fakeStorage([[own, JSON.stringify({ revision: 1, lines: [{ text: 'mine' }] })],
    [other, JSON.stringify({ revision: 2, lines: [{ text: 'theirs' }] })]]);
  const kept = adoptDraft(storage, { sessionId: 'session', ownKey: own, foreignKey: other,
    current: { revision: 1, lines: [{ text: 'mine' }] }, adopted: { revision: 2, lines: [{ text: 'theirs' }] } });
  assert.equal(kept, noteStashKey('session', 'kept-1'));
  assert.deepEqual(JSON.parse(storage.getItem(kept)).lines, [{ text: 'mine' }]);
  assert.deepEqual(JSON.parse(storage.getItem(own)).lines, [{ text: 'theirs' }]);
  assert.equal(storage.getItem(other), null);
  const offered = listNoteStashes(storage, 'session', 'tab-a').drafts.map((d) => d.key);
  assert.ok(offered.includes(kept)); // the set-aside draft is offered again on the next mount
});

test('adopting with an empty current draft does not create a kept key', () => {
  const own = noteStashKey('session', 'tab-a');
  const other = noteStashKey('session', 'tab-b');
  const storage = fakeStorage([[other, JSON.stringify({ revision: 0, lines: [{ text: 'theirs' }] })]]);
  assert.equal(adoptDraft(storage, { sessionId: 'session', ownKey: own, foreignKey: other,
    current: { revision: 0, lines: [{ text: '' }] }, adopted: { revision: 0, lines: [{ text: 'theirs' }] } }), null);
  assert.equal(storage.length, 1);
});

test('adopting keeps an unsaved important mark even when its text is empty', () => {
  const own = noteStashKey('session', 'tab-a');
  const other = noteStashKey('session', 'tab-b');
  const storage = fakeStorage([[other, JSON.stringify({ revision: 0, lines: [{ text: 'theirs' }] })]]);
  const kept = adoptDraft(storage, { sessionId: 'session', ownKey: own, foreignKey: other,
    current: { revision: 0, lines: [{ t: 12, text: '', important: true }] },
    adopted: { revision: 0, lines: [{ text: 'theirs' }] } });
  assert.equal(kept, noteStashKey('session', 'kept-1'));
  assert.equal(JSON.parse(storage.getItem(kept)).lines[0].important, true);
});
