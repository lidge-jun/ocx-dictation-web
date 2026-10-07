export const TAB_CHANNEL = 'ocx-dictation';
export const OWNER_STALE_MS = 3000;
const STATES = new Set(['starting', 'recording', 'paused', 'stopping']);
const ACTIONS = new Set(['pause', 'resume', 'stop', 'mark']);
const TYPES = new Set(['owner-state', 'owner-gone', 'command', 'command-ack', 'notes-saved']);
const idOk = (s) => typeof s === 'string' && s.length > 0 && s.length <= 128;
const revOk = (n) => Number.isSafeInteger(n) && n >= 0;

export function validMessage(m) {
  if (!m || typeof m !== 'object' || Array.isArray(m) || m.v !== 1 || !TYPES.has(m.type)
      || !idOk(m.tabId) || !idOk(m.sessionId) || !idOk(m.epoch)
      || !revOk(m.seq) || m.seq === 0 || !Number.isFinite(m.at)
      || !m.payload || typeof m.payload !== 'object' || Array.isArray(m.payload)) return false;
  const p = m.payload;
  if (m.type === 'owner-state') return STATES.has(p.state) && Number.isFinite(p.elapsed)
    && p.elapsed >= 0 && Number.isFinite(p.level) && p.level >= 0 && p.level <= 1
    && typeof p.device === 'string';
  if (m.type === 'owner-gone') return Object.keys(p).length === 0;
  if (m.type === 'command') return ACTIONS.has(p.action) && idOk(p.requestId)
    && idOk(p.ownerEpoch) && idOk(p.toTabId);
  if (m.type === 'command-ack') return idOk(p.requestId) && idOk(p.toTabId)
    && typeof p.ok === 'boolean' && (p.error === undefined || typeof p.error === 'string');
  return revOk(p.revision);
}

export function createTabSync({ channel, now = () => Date.now(), makeId = () => crypto.randomUUID(),
  setEvery = (f, ms) => setInterval(f, ms), clearEvery = (id) => clearInterval(id),
  setLater = (f, ms) => setTimeout(f, ms), clearLater = (id) => clearTimeout(id) }) {
  if (!channel?.postMessage || !channel?.addEventListener) throw new TypeError('BroadcastChannel required');
  const tabId = makeId();
  let epoch = makeId(), seq = 0, owned = null, owner = null, heartbeat = null, commandHandler = null;
  let ownerExpiry = null;
  let lastOwnerSeenAt = now();
  const seen = new Map(), gone = new Set(), listeners = new Set(), pending = new Map();
  const processedCommands = new Map();
  const key = (m) => `${m.tabId}:${m.epoch}`;
  const notify = (message) => { for (const fn of listeners) fn(getOwner(), message); };
  function send(type, sessionId, payload) {
    const m = { v: 1, type, tabId, sessionId, epoch, seq: ++seq, at: now(), payload };
    channel.postMessage(m);
    return m;
  }
  function getOwner() {
    if (owner && now() - owner.receivedAt > OWNER_STALE_MS) { owner = null; notify(); }
    return owner && { message: owner.message, receivedAt: owner.receivedAt };
  }
  function quietFor(ms = OWNER_STALE_MS) { return !getOwner() && now() - lastOwnerSeenAt >= ms; }
  function receive(ev) {
    const m = ev.data;
    if (!validMessage(m) || m.tabId === tabId) return;
    const k = key(m), previous = seen.get(k) ?? 0;
    if (m.seq <= previous || (gone.has(k) && m.type === 'owner-state')) return;
    seen.set(k, m.seq);
    if (m.type === 'owner-state') {
      lastOwnerSeenAt = now(); owner = { message: m, receivedAt: now() }; notify();
      if (ownerExpiry) clearLater(ownerExpiry);
      ownerExpiry = setLater(() => {
        ownerExpiry = null;
        if (owner && now() - owner.receivedAt >= OWNER_STALE_MS) { owner = null; notify(); }
      }, OWNER_STALE_MS);
    } else if (m.type === 'owner-gone') {
      gone.add(k); lastOwnerSeenAt = now();
      if (owner?.message.tabId === m.tabId && owner.message.epoch === m.epoch) {
        if (ownerExpiry) { clearLater(ownerExpiry); ownerExpiry = null; }
        owner = null; notify();
      }
    } else if (m.type === 'command' && owned?.sessionId === m.sessionId
        && m.payload.ownerEpoch === epoch && m.payload.toTabId === tabId && commandHandler) {
      if (processedCommands.has(m.payload.requestId)) return;
      processedCommands.set(m.payload.requestId, now());
      Promise.resolve().then(() => commandHandler(m.payload.action, m.sessionId))
        .then(() => send('command-ack', m.sessionId, { requestId: m.payload.requestId, toTabId: m.tabId, ok: true }),
          (error) => send('command-ack', m.sessionId, { requestId: m.payload.requestId,
            toTabId: m.tabId, ok: false, error: String(error?.message || error) }));
    } else if (m.type === 'command-ack' && m.payload.toTabId === tabId) {
      const p = pending.get(m.payload.requestId);
      if (p && p.sessionId === m.sessionId && p.ownerTabId === m.tabId && p.ownerEpoch === m.epoch) {
        clearLater(p.timer); pending.delete(m.payload.requestId);
        m.payload.ok ? p.resolve() : p.reject(new Error(m.payload.error || 'Command failed'));
      }
    } else if (m.type === 'notes-saved') notify(m);
  }
  channel.addEventListener('message', receive);
  function publishOwner(snapshot) {
    if (!owned) return;
    send('owner-state', owned.sessionId, { state: snapshot.state, elapsed: snapshot.elapsed,
      level: snapshot.level, device: snapshot.device });
  }
  function startOwner(sessionId, snapshot) {
    if (owned) throw new Error('Already owner');
    epoch = makeId(); seq = 0; owned = { sessionId, snapshot };
    publishOwner(snapshot());
    heartbeat = setEvery(() => publishOwner(snapshot()), 1000);
  }
  function stopOwner() {
    if (!owned) return;
    clearEvery(heartbeat); heartbeat = null;
    send('owner-gone', owned.sessionId, {}); owned = null;
  }
  function sendCommand(sessionId, action, timeoutMs = 2000) {
    const target = getOwner()?.message;
    if (!ACTIONS.has(action) || !target || target.sessionId !== sessionId)
      return Promise.reject(new Error('Recording owner is unavailable'));
    const requestId = makeId();
    return new Promise((resolve, reject) => {
      const timer = setLater(() => { pending.delete(requestId); reject(new Error('Command timed out')); }, timeoutMs);
      pending.set(requestId, { resolve, reject, timer, sessionId,
        ownerTabId: target.tabId, ownerEpoch: target.epoch });
      send('command', sessionId, { action, requestId, ownerEpoch: target.epoch, toTabId: target.tabId });
    });
  }
  function close() {
    stopOwner(); channel.removeEventListener('message', receive);
    if (ownerExpiry) { clearLater(ownerExpiry); ownerExpiry = null; }
    for (const p of pending.values()) { clearLater(p.timer); p.reject(new Error('Tab closed')); }
    pending.clear(); channel.close();
  }
  return { tabId, getOwner, quietFor, startOwner, publishOwner, stopOwner, sendCommand,
    notesSaved: (sessionId, revision) => send('notes-saved', sessionId, { revision }),
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    onCommand(fn) { commandHandler = fn; return () => { if (commandHandler === fn) commandHandler = null; }; },
    close };
}
