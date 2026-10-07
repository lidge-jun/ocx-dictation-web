// IndexedDB: segments waiting for upload, in-progress partial audio, and active-recording records.
const DB_NAME = "lecture-notes-studio";
const DB_VER = 1;
let dbp = null;
function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("segments")) db.createObjectStore("segments", { keyPath: "key" });
      if (!db.objectStoreNames.contains("partials")) db.createObjectStore("partials", { keyPath: "sid" });
      if (!db.objectStoreNames.contains("active")) db.createObjectStore("active", { keyPath: "sid" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}
async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    const r = fn(s);
    if (r && "onsuccess" in r)
      r.onsuccess = () => {
        result = r.result;
      };
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}
export const idb = {
  putSegment: (seg) =>
    tx("segments", "readwrite", (s) => s.put({ ...seg, key: `${seg.sid}:${String(seg.index).padStart(6, "0")}` })),
  getSegments: () => tx("segments", "readonly", (s) => s.getAll()),
  deleteSegment: (key) => tx("segments", "readwrite", (s) => s.delete(key)),
  putPartial: (p) => tx("partials", "readwrite", (s) => s.put(p)),
  getPartial: (sid) => tx("partials", "readonly", (s) => s.get(sid)),
  deletePartial: (sid) => tx("partials", "readwrite", (s) => s.delete(sid)),
  putActive: (a) => tx("active", "readwrite", (s) => s.put(a)),
  getActive: (sid) => tx("active", "readonly", (s) => s.get(sid)),
  getActives: () => tx("active", "readonly", (s) => s.getAll()),
  deleteActive: (sid) => tx("active", "readwrite", (s) => s.delete(sid)),
};
