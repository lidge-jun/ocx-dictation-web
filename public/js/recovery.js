export function createRecovery({ idb, api, enqueueSegment, locks, encodeWav, sampleRate }) {
  const lockName = 'ocx-dictation:recorder';
  const keyOf = (sid, index) => `${sid}:${String(index).padStart(6, '0')}`;
  async function cleanupStopped(sid, pendingSegments = []) {
    await Promise.all([...pendingSegments]);
    await idb.deletePartial(sid);
    await idb.deleteActive(sid);
  }
  async function recoverInterrupted() {
    if (!locks?.request) return [];
    return locks.request(lockName, { ifAvailable: true }, async (lock) => {
      if (!lock) return [];
      const recovered = [];
      const queued = new Set((await idb.getSegments()).map((g) => g.key));
      for (const a of await idb.getActives()) {
        const p = await idb.getPartial(a.sid);
        const remote = await api(`/api/sessions/${a.sid}`).catch((e) => {
          if (e.status === 404) return null;
          throw e;
        });
        if (remote === null) {
          recovered.push({ sid: a.sid, at: a.updatedAt, orphan: true });
          continue;
        }
        const key = p ? keyOf(a.sid, p.index) : null;
        const persisted = (idx, k) => queued.has(k) || remote.segments?.some((g) => g.index === idx);
        if (!p?.pcm || p.pcm.length <= 8000 || p.index < a.nextIndex) {
          if (p?.pcm && p.pcm.length > 8000 && p.index < a.nextIndex && !persisted(p.index, key)) {
            recovered.push({ sid: a.sid, at: a.updatedAt, needsAttention: true });
            continue;
          }
          await idb.deletePartial(a.sid);
          await idb.deleteActive(a.sid);
          recovered.push({ sid: a.sid, nextIndex: a.nextIndex, offset: a.offset, at: a.updatedAt, cleared: true });
          continue;
        }
        const exists = queued.has(key) || remote.segments?.some((g) => g.index === p.index);
        const raced = !exists && (await idb.getSegments()).some((g) => g.key === key);
        if (!exists && !raced) {
          const duration = p.pcm.length / sampleRate;
          await enqueueSegment({ sid: a.sid, index: p.index, start: p.start, duration,
            silent: (p.peak || 0) < 0.004, wav: encodeWav(p.pcm), createdAt: Date.now() });
          queued.add(key);
        }
        await idb.deletePartial(a.sid);
        await idb.deleteActive(a.sid);
        recovered.push({ sid: a.sid, nextIndex: p.index + 1,
          offset: p.start + p.pcm.length / sampleRate, at: a.updatedAt });
      }
      return recovered;
    });
  }
  async function discardOrphan(sid) {
    if (!locks?.request) throw new Error('녹음 보호를 사용할 수 없어요.');
    return locks.request(lockName, { ifAvailable: true }, async (lock) => {
      if (!lock) throw new Error('다른 탭에서 녹음 중이에요.');
      let found = false;
      try { await api(`/api/sessions/${sid}`); found = true; }
      catch (e) { if (e.status !== 404) throw e; }
      if (found) throw new Error('서버에 녹음이 다시 나타났어요. 목록을 새로고침해주세요.');
      const queued = (await idb.getSegments()).filter((g) => g.sid === sid);
      for (const g of queued) await idb.deleteSegment(g.key);
      await idb.deletePartial(sid);
      await idb.deleteActive(sid);
    });
  }
  return { cleanupStopped, recoverInterrupted, discardOrphan };
}
