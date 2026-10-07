// Durable upload queue: every segment is written to IndexedDB first, then uploaded.
// It is removed from IndexedDB only after the server has stored it.
import { idb } from "./store.js";
import { emit } from "./util.js";
import { drainSegments } from "./upload-drain.js";

const inflight = new Set();
let timer = null;
let backoff = 0;
let running = false;

export async function enqueueSegment(seg) {
  await idb.putSegment(seg);
  emit("upload-queue", await counts());
  kick();
}

export async function counts() {
  const all = await idb.getSegments().catch(() => []);
  const bySid = {};
  for (const s of all) bySid[s.sid] = (bySid[s.sid] || 0) + 1;
  return { total: all.length, bySid };
}

export function kick(delay = 0) {
  clearTimeout(timer);
  timer = setTimeout(run, delay);
}

async function run() {
  if (running) return;
  running = true;
  try {
    const all = (await idb.getSegments()).sort((a, b) => a.key.localeCompare(b.key));
    const failed = await drainSegments(all, {
      inflight,
      upload: async (seg) => {
        const qs = new URLSearchParams({
          index: seg.index,
          start: seg.start.toFixed(3),
          silent: seg.silent ? "1" : "0",
        });
        return fetch(`/api/sessions/${seg.sid}/segments?${qs}`, {
          method: "POST",
          body: seg.wav,
          headers: { "content-type": "audio/wav" },
        });
      },
      deleteSegment: (key) => idb.deleteSegment(key),
      onUploaded: (seg) => emit("segment-uploaded", { sid: seg.sid, index: seg.index }),
      onOrphan: (seg) => emit("orphan-recording", { sid: seg.sid }),
    });
    const c = await counts();
    emit("upload-queue", { ...c, failed });
    if (failed) {
      backoff = Math.min(30000, backoff ? backoff * 2 : 2000);
      kick(backoff);
    } else {
      backoff = 0;
    }
  } finally {
    running = false;
  }
}

window.addEventListener("online", () => kick());
