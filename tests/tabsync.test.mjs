import test from 'node:test';
import assert from 'node:assert/strict';
import { createTabSync, validMessage } from '../public/js/tabsync.js';

function pair() {
  const listeners = [new Set(), new Set()];
  const endpoint = (i) => ({
    sent: [],
    postMessage(data) { this.sent.push(data); for (const fn of listeners[1 - i]) fn({ data }); },
    inject(data) { for (const fn of listeners[i]) fn({ data }); },
    addEventListener(type, fn) { if (type === 'message') listeners[i].add(fn); },
    removeEventListener(type, fn) { if (type === 'message') listeners[i].delete(fn); },
    close() { listeners[i].clear(); },
  });
  return [endpoint(0), endpoint(1)];
}
function harness() {
  let ms = 1000, id = 0;
  const intervals = new Map(), timeouts = new Map();
  const clock = { now: () => ms, advance: (n) => { ms += n; },
    tick: () => { for (const fn of intervals.values()) fn(); },
    fireTimeouts: () => { for (const [key, fn] of [...timeouts]) { timeouts.delete(key); fn(); } } };
  const timers = {
    now: clock.now, makeId: () => `id-${++id}`,
    setEvery: (fn) => { const key = ++id; intervals.set(key, fn); return key; },
    clearEvery: (key) => intervals.delete(key),
    setLater: (fn) => { const key = ++id; timeouts.set(key, fn); return key; },
    clearLater: (key) => timeouts.delete(key),
  };
  const [a, b] = pair();
  return { clock, rawA: a, rawB: b,
    a: createTabSync({ channel: a, ...timers }), b: createTabSync({ channel: b, ...timers }) };
}

test('validMessage rejects unknown type, action and missing envelope fields', () => {
  const base = { v: 1, type: 'command', tabId: 'a', sessionId: 's', epoch: 'e', seq: 1,
    at: 1000, payload: { action: 'pause', requestId: 'r', ownerEpoch: 'e', toTabId: 'owner' } };
  assert.equal(validMessage(base), true);
  assert.equal(validMessage({ ...base, v: 2 }), false);
  assert.equal(validMessage({ ...base, type: 'takeover' }), false);
  assert.equal(validMessage({ ...base, payload: { ...base.payload, action: 'delete' } }), false);
  assert.equal(validMessage({ ...base, seq: -1 }), false);
});

test('owner heartbeat mirrors state and expires without polling', () => {
  const h = harness();
  h.a.startOwner('session-a', () => ({ state: 'recording', elapsed: 4, level: .2, device: 'Mic' }));
  assert.equal(h.b.getOwner().message.payload.elapsed, 4);
  h.clock.advance(1000); h.clock.tick();
  let changes = 0; h.b.onChange(() => changes++);
  h.clock.advance(3001); h.clock.fireTimeouts();
  assert.equal(changes, 1);
  assert.equal(h.b.getOwner(), null);
  assert.equal(h.b.quietFor(3000), true);
  h.a.stopOwner(); h.a.close(); h.b.close();
});

test('command ack resolves, owner errors reject, timeout rejects', async () => {
  const h = harness();
  h.a.startOwner('session-a', () => ({ state: 'paused', elapsed: 5, level: 0, device: 'Mic' }));
  const actions = [];
  h.a.onCommand(async (action) => { actions.push(action); if (action === 'stop') throw new Error('busy'); });
  await h.b.sendCommand('session-a', 'resume');
  assert.deepEqual(actions, ['resume']);
  await assert.rejects(h.b.sendCommand('session-a', 'stop'), /busy/);
  h.a.onCommand(() => new Promise(() => {}));
  const pending = h.b.sendCommand('session-a', 'mark');
  h.clock.fireTimeouts();
  await assert.rejects(pending, /timed out/);
  h.a.close(); h.b.close();
});

test('owner-gone tombstones old epoch', () => {
  const h = harness();
  h.a.startOwner('session-a', () => ({ state: 'recording', elapsed: 1, level: 0, device: 'Mic' }));
  const old = h.rawA.sent[0];
  let changes = 0; h.b.onChange(() => changes++);
  h.rawB.inject(old);
  assert.equal(changes, 0);
  h.a.stopOwner();
  h.rawB.inject({ ...old, seq: old.seq + 100 });
  assert.equal(h.b.getOwner(), null);
  assert.equal(changes, 1);
  h.a.close(); h.b.close();
});

test('notes-saved carries the revision', () => {
  const h = harness(); let seen = null;
  h.b.onChange((_owner, message) => { if (message?.type === 'notes-saved') seen = message; });
  h.a.notesSaved('session-a', 2);
  assert.equal(seen?.payload.revision, 2);
  h.a.close(); h.b.close();
});
