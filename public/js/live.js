// Global recording controller. Survives navigation between views; one recording at a time.
import { Recorder, encodeWav, SAMPLE_RATE } from "./recorder.js";
import { idb } from "./store.js";
import { enqueueSegment, counts, kick } from "./uploader.js";
import { api, emit, on, toast } from "./util.js";
import { TAB_CHANNEL, createTabSync } from "./tabsync.js";
import { createRecovery } from "./recovery.js";
import { createLocalLockQueue } from "./local-lock-queue.js";
import { stopRecorderUnderLock } from "./stop-ownership.js";

const SEGMENT_SECONDS = 30;
const RECORDER_LOCK = "ocx-dictation:recorder";
export const tabSync = typeof BroadcastChannel === "function"
  ? createTabSync({ channel: new BroadcastChannel(TAB_CHANNEL) }) : null;
let releaseRecorderLock = null, recorderLockTask = null, startPending = false, markHandler = null;
const pendingSegments = new Set();
const localLocks = createLocalLockQueue();
let segmentWriteError = null;
const recovery = createRecovery({ idb, api, enqueueSegment, locks: navigator.locks,
  encodeWav, sampleRate: SAMPLE_RATE });
export const recorderSupported = () => Boolean(navigator.locks?.request && tabSync);
export const recorderOwner = () => tabSync?.getOwner()?.message || null;
export async function recorderLockFree() {
  if (!recorderSupported()) return false;
  return localLocks.run(() => navigator.locks.request(RECORDER_LOCK,
    { ifAvailable: true }, (lock) => Boolean(lock)));
}
export function setOwnerMarkHandler(fn) {
  markHandler = fn;
  return () => { if (markHandler === fn) markHandler = null; };
}

export const live = {
  sid: null,
  rec: null,
  state: "idle", // idle | starting | recording | paused | stopping
  level: 0,
  wakeLock: null,
  deviceLabel: "",
  get elapsed() {
    return this.rec ? this.rec.elapsed : 0;
  },
  isActive(sid) {
    return this.sid === sid && this.state !== "idle";
  },
};

async function requestWake() {
  try {
    if ("wakeLock" in navigator && !live.wakeLock) {
      live.wakeLock = await navigator.wakeLock.request("screen");
      live.wakeLock.addEventListener("release", () => {
        live.wakeLock = null;
      });
    }
  } catch {}
}
function releaseWake() {
  try {
    live.wakeLock?.release();
  } catch {}
  live.wakeLock = null;
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && live.state === "recording") requestWake();
});

function setState(s) {
  live.state = s;
  tabSync?.publishOwner(snapshot());
  emit("live-state", { sid: live.sid, state: s });
}
const snapshot = () => ({ state: live.state, elapsed: live.elapsed,
  level: Math.max(0, Math.min(1, live.level)), device: live.deviceLabel || "" });

function recorderStartError(err) {
  if (err.name === "NotAllowedError") return new Error("마이크 권한이 없어요. 주소창 왼쪽 자물쇠에서 마이크를 허용해주세요.");
  if (err.name === "NotFoundError" || err.name === "OverconstrainedError")
    return new Error("선택한 마이크를 찾지 못했어요. 다른 마이크를 골라주세요.");
  return err;
}

function makeRecorder(sid, deviceId, fake) {
  return new Recorder({
    segmentSeconds: SEGMENT_SECONDS, deviceId, fakeUrl: fake ? "/debug/sample.wav" : null,
    onLevel: (rms, peak) => { live.level = peak; emit("live-level", { rms, peak }); },
    onSegment: (seg) => {
      const task = (async () => {
        await enqueueSegment({ sid, index: seg.index, start: seg.start, duration: seg.duration,
          silent: seg.silent, wav: seg.wav, createdAt: Date.now() });
        await idb.putActive({ sid, nextIndex: seg.index + 1,
          offset: seg.start + seg.duration, updatedAt: Date.now() });
        await idb.deletePartial(sid).catch(() => {});
        emit("live-segment", { sid, index: seg.index, start: seg.start,
          duration: seg.duration, silent: seg.silent });
      })();
      pendingSegments.add(task);
      task.catch((error) => { segmentWriteError = error; emit("live-error", { sid, error }); })
        .finally(() => pendingSegments.delete(task));
      return task;
    },
    onPartial: (p) => { idb.putPartial({ sid, ...p, savedAt: Date.now() }).catch(() => {}); },
    onDevice: (ev) => {
      if (ev.type === "switched") { live.deviceLabel = ev.label;
        toast(`마이크가 바뀌었어요. ${ev.label}(으)로 계속 녹음해요`, { ms: 6000 });
        setState(live.state); }
    },
    onEnded: (why) => {
      if (why === "device") { setState("paused"); releaseWake();
        toast("마이크 연결이 끊겼어요. 다시 연결한 뒤 이어서 녹음할 수 있어요.", { error: true, ms: 10000 });
        api(`/api/sessions/${sid}`, { method: "PATCH", json: { state: "paused" } }).catch(() => {});
      } else queueMicrotask(() => stopRecording().catch((error) => emit("live-error", { sid, error })));
    },
  });
}

export async function startRecording(sid, { deviceId, fake, index = 0, offset = 0 } = {}) {
  if (!recorderSupported()) throw new Error("탭 간 녹음 보호를 사용할 수 없는 브라우저예요.");
  if (live.state !== "idle" || recorderLockTask || startPending) throw new Error("이미 녹음 중이에요.");
  startPending = true;
  let settled = false, resolveStart, rejectStart;
  const started = new Promise((resolve, reject) => { resolveStart = resolve; rejectStart = reject; });
  try {
  await localLocks.run(() => new Promise((acquired) => {
  recorderLockTask = navigator.locks.request(RECORDER_LOCK, { ifAvailable: true }, async (lock) => {
    acquired();
    if (!lock) {
      const owner = recorderOwner();
      rejectStart(new Error(owner ? `다른 탭에서 ${owner.sessionId} 녹음 중이에요.` : "다른 탭에서 녹음 중이에요."));
      return;
    }
    try {
      segmentWriteError = null;
      live.sid = sid; setState("starting"); tabSync.startOwner(sid, snapshot);
      const rec = makeRecorder(sid, deviceId, fake);
      live.rec = rec;
      await rec.start({ index, offset });
      live.deviceLabel = rec.label;
      await idb.putActive({ sid, nextIndex: index, offset, updatedAt: Date.now() });
      if (fake) {
        window.__lnsDeviceLoss = (options) => rec.simulateDeviceLoss(options);
        window.__lnsCrash = async () => {
          clearInterval(rec.partialTimer);
          rec.state = "stopped";
          rec.stream?.getTracks().forEach((track) => track.stop());
          await rec.ctx?.close().catch(() => {});
          tabSync.stopOwner();
          releaseRecorderLock?.();
        };
      }
      requestWake(); setState("recording");
      api(`/api/sessions/${sid}`, { method: "PATCH", json: { state: "recording" } }).catch(() => {});
      settled = true; resolveStart();
      await new Promise((resolve) => { releaseRecorderLock = resolve; });
    } catch (err) {
      if (!settled) {
        live.rec?.stream?.getTracks().forEach((track) => track.stop());
        if (live.rec?.ctx) await live.rec.ctx.close().catch(() => {});
        rejectStart(recorderStartError(err));
      } else emit("live-error", { sid, error: err });
    } finally {
      tabSync?.stopOwner(); releaseWake(); releaseRecorderLock = null;
      live.rec = null; live.sid = null; live.deviceLabel = "";
      setState("idle"); emit("live-stopped", { sid });
    }
  }).catch((err) => { acquired(); if (!settled) rejectStart(err); else emit("live-error", { sid, error: err });
  }).finally(() => { recorderLockTask = null; });
  }));
  await started;
  } finally { startPending = false; }
}

export async function pauseRecording() {
  if (live.state !== "recording") return;
  await live.rec.pause();
  setState("paused");
  releaseWake();
  api(`/api/sessions/${live.sid}`, { method: "PATCH", json: { state: "paused" } }).catch(() => {});
}
export async function resumeRecording() {
  if (live.state !== "paused") return;
  await live.rec.resume();
  setState("recording");
  requestWake();
  api(`/api/sessions/${live.sid}`, { method: "PATCH", json: { state: "recording" } }).catch(() => {});
}

export async function stopRecording() {
  if (live.state === "idle" || live.state === "stopping") return;
  const sid = live.sid, rec = live.rec;
  setState("stopping");
  await stopRecorderUnderLock(rec, async () => {
    if (segmentWriteError) throw segmentWriteError;
    await recovery.cleanupStopped(sid, pendingSegments);
  }, () => releaseRecorderLock?.(), recorderLockTask);
  await api(`/api/sessions/${sid}`, { method: "PATCH", json: { state: "processing" } });
  await finalizeWhenUploaded(sid);
}

// Merge audio on the server once every local segment for this session has been uploaded.
const needFinalize = new Set(JSON.parse(localStorage.getItem("lns.needFinalize") || "[]"));
const saveNF = () => localStorage.setItem("lns.needFinalize", JSON.stringify([...needFinalize]));
export async function finalizeWhenUploaded(sid) {
  needFinalize.add(sid);
  saveNF();
  kick();
  await tryFinalize(sid);
}
async function tryFinalize(sid) {
  if (!needFinalize.has(sid) || live.sid === sid) return;
  const c = await counts();
  if (c.bySid[sid]) return; // still uploading; retried on 'segment-uploaded'
  try {
    const s = await api(`/api/sessions/${sid}/finalize`, { method: "POST" });
    needFinalize.delete(sid);
    saveNF();
    emit("session-updated", s);
  } catch (err) {
    if (err.status === 404) {
      needFinalize.delete(sid);
      saveNF();
    }
  }
}
on("segment-uploaded", ({ sid }) => {
  if (needFinalize.has(sid)) tryFinalize(sid);
});
on("upload-queue", () => {
  for (const sid of needFinalize) tryFinalize(sid);
});

// After a crash or closed tab: turn any leftover partial audio into a final segment and report what was recovered.
export async function recoverInterrupted() {
  if (!recorderSupported()) return [];
  const recovered = await localLocks.run(() => recovery.recoverInterrupted());
  for (const entry of recovered) if (!entry.orphan && !entry.needsAttention) tryFinalize(entry.sid);
  for (const sid of needFinalize) tryFinalize(sid);
  return recovered;
}
export const discardOrphan = (sid) => localLocks.run(() => recovery.discardOrphan(sid));

tabSync?.onCommand(async (action, sid) => {
  if (sid !== live.sid) throw new Error("이 탭의 녹음이 아니에요.");
  if (action === "pause" && live.state === "recording") return pauseRecording();
  if (action === "resume" && live.state === "paused") return resumeRecording();
  if (action === "stop" && ["recording", "paused"].includes(live.state)) return stopRecording();
  if (action === "mark" && live.state === "recording")
    return markHandler ? markHandler() : appendMarkToServer(sid, live.elapsed);
  throw new Error("현재 녹음 상태에서 사용할 수 없는 명령이에요.");
});
async function appendMarkToServer(sid, elapsed) {
  const markId = crypto.randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    const current = (await api(`/api/sessions/${sid}`)).notes;
    const lines = [...current.lines, { id: markId, t: elapsed, text: "", important: true }];
    try { await api(`/api/sessions/${sid}/notes`, { method: "PUT",
      headers: { "X-Tab-Id": tabSync.tabId },
      json: { lines, baseRevision: current.revision ?? 0 } }); return; }
    catch (err) { if (err.status !== 409 || attempt === 1) throw err; }
  }
}
window.addEventListener("pagehide", () => { if (live.state !== "idle") tabSync?.stopOwner(); });

window.addEventListener("beforeunload", (e) => {
  if (live.state === "recording" || live.state === "paused" || live.state === "stopping") {
    e.preventDefault();
    e.returnValue = "";
  }
});
