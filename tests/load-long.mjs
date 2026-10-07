// Push N x 30 s WAV segments through the segment API like the browser does, then measure drain + finalize.
// usage: node tests/load-long.mjs <baseUrl> <segDir> [paceMs]
import fs from "node:fs";
import path from "node:path";
const [base, segDir, paceArg] = process.argv.slice(2);
const pace = Number(paceArg || 0);
const files = fs
  .readdirSync(segDir)
  .filter((f) => f.endsWith(".wav"))
  .sort();
const j = async (url, opt = {}) => {
  const r = await fetch(base + url, {
    ...opt,
    headers: { "content-type": "application/json", ...(opt.headers || {}) },
  });
  return r.json();
};
const s = await j("/api/sessions", {
  method: "POST",
  body: JSON.stringify({ title: "LOADTEST 90분", course: "BIO101" }),
});
console.log("session", s.id);
const t0 = Date.now();
let start = 0;
for (let i = 0; i < files.length; i++) {
  const buf = fs.readFileSync(path.join(segDir, files[i]));
  const r = await fetch(`${base}/api/sessions/${s.id}/segments?index=${i}&start=${start.toFixed(3)}&silent=0`, {
    method: "POST",
    body: buf,
    headers: { "content-type": "audio/wav" },
  });
  if (!r.ok) console.log("upload fail", i, r.status);
  start += (buf.length - 44) / 32000;
  if (pace) await new Promise((r) => setTimeout(r, pace));
}
console.log(`uploaded ${files.length} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
for (;;) {
  const f = await j(`/api/sessions/${s.id}`);
  const st = f.stats;
  process.stdout.write(
    `\r t=${((Date.now() - t0) / 1000).toFixed(0)}s done=${st.done} pending=${st.pending} err=${st.error}   `,
  );
  if (st.pending === 0) break;
  await new Promise((r) => setTimeout(r, 5000));
}
const tDrain = (Date.now() - t0) / 1000;
console.log(
  `\ndrained in ${tDrain.toFixed(1)}s (${(tDrain / files.length).toFixed(2)} s/segment, audio ${start.toFixed(0)}s)`,
);
const tf = Date.now();
const fin = await fetch(`${base}/api/sessions/${s.id}/finalize`, { method: "POST" });
console.log(`finalize HTTP ${fin.status} in ${((Date.now() - tf) / 1000).toFixed(1)}s`);
const full = await j(`/api/sessions/${s.id}`);
const empty = full.segments.filter((g) => g.status === "done" && !g.text).length;
console.log(
  JSON.stringify({
    stats: full.stats,
    empty,
    duration: full.duration,
    state: full.state,
    sample: full.segments[90]?.text?.slice(0, 120),
  }),
);
