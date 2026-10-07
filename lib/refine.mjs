// Opt-in transcript refinement ("정제") with a light LLM, in time windows.
// Raw segment text is never touched: refined text lives in seg.refined, keyed by the same segment index.
//
// Windowing: segments are grouped by recording time into windows of `interval` seconds
// (window k = segments whose start falls in [k*interval, (k+1)*interval)). A window is refined once
// every segment in it is final (done/silent) AND either the recording has moved past the window end
// or the session stopped. "end" interval = one window covering the whole session, run after stop.
// The previous window's refined tail (last 2 segments) is passed as read-only context.

export const REFINE_EFFORT = "low";
const TAIL_SEGMENTS = 2;
const MAX_CHARS_PER_CALL = 14000; // a 5-min window is ~2-3k chars; "end" windows are chunked by this

// ---------- pure helpers (unit-tested) ----------
export function windowOf(seg, interval) {
  if (interval === "end") return 0;
  return Math.floor((seg.start + 0.001) / interval);
}
export function groupWindows(segments, interval) {
  const m = new Map();
  for (const g of segments) {
    if (!g) continue;
    const w = windowOf(g, interval);
    if (!m.has(w)) m.set(w, []);
    m.get(w).push(g);
  }
  for (const list of m.values()) list.sort((a, b) => a.index - b.index);
  return m;
}
const FINAL = new Set(["done", "silent"]);
// Is window w ready to refine?
export function windowReady(list, w, interval, { recordedUntil, stopped }) {
  if (!list.length || !list.every((g) => FINAL.has(g.status))) return false;
  if (stopped) return true;
  if (interval === "end") return false;
  return recordedUntil >= (w + 1) * interval - 0.5;
}
// Split a long window into chunks under the char budget (keeps segment boundaries).
export function chunkForCall(list, max = MAX_CHARS_PER_CALL) {
  const out = [];
  let cur = [],
    n = 0;
  for (const g of list) {
    const len = (g.text || "").length + 20;
    if (cur.length && n + len > max) {
      out.push(cur);
      cur = [];
      n = 0;
    }
    cur.push(g);
    n += len;
  }
  if (cur.length) out.push(cur);
  return out;
}

// Validate model JSON against the segments we sent. Returns {ok, map|reason}.
// Guards: exact id set, no empty output for non-empty input, length ratio within [0.5, 1.6]
// (refinement may drop fillers or add punctuation, but must not summarize or pad).
export function validateRefined(raw, sent) {
  let obj = raw;
  if (typeof raw === "string") {
    const t = raw
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```\s*$/, "");
    try {
      obj = JSON.parse(t);
    } catch {
      return { ok: false, reason: "JSON이 아님" };
    }
  }
  const arr = Array.isArray(obj) ? obj : obj?.segments;
  if (!Array.isArray(arr)) return { ok: false, reason: "segments 배열 없음" };
  const want = new Map(sent.map((g) => [g.index, g]));
  if (arr.length !== want.size) return { ok: false, reason: `구간 수 불일치 (${arr.length}/${want.size})` };
  const map = new Map();
  for (const it of arr) {
    const id = Number(it?.id);
    if (!want.has(id) || map.has(id)) return { ok: false, reason: `알 수 없거나 중복된 id ${it?.id}` };
    if (typeof it.text !== "string") return { ok: false, reason: `id ${id} text 없음` };
    const src = (want.get(id).text || "").trim();
    const out = it.text.trim();
    if (!src) {
      map.set(id, "");
      continue;
    }
    if (!out) return { ok: false, reason: `id ${id} 빈 결과` };
    const r = out.length / src.length;
    if (src.length >= 30 && (r < 0.5 || r > 1.6)) return { ok: false, reason: `id ${id} 길이 비율 ${r.toFixed(2)}` };
    map.set(id, out);
  }
  return { ok: true, map };
}

export function buildRefineMessages({ systemBase, context, prevTail, segs }) {
  const payload = { segments: segs.filter((g) => (g.text || "").trim()).map((g) => ({ id: g.index, text: g.text })) };
  const user = [
    "아래 json의 각 구간 text를 교정해서, 같은 id와 같은 개수로 json 객체 하나만 돌려줘.",
    '형식: {"segments":[{"id":<숫자>,"text":"<교정된 문장>"}]}',
    "구간끼리 문장을 옮기지 말고, 각 id의 text는 그 구간에서 말한 내용만 담는다.",
    context ? `\n[과목 정보]\n${context}` : "",
    prevTail ? `\n[바로 앞 구간 (참고만, 출력하지 말 것)]\n${prevTail}` : "",
    `\n[교정할 구간 json]\n${JSON.stringify(payload)}`,
  ]
    .filter(Boolean)
    .join("\n");
  return {
    messages: [
      { role: "system", content: systemBase },
      { role: "user", content: user },
    ],
    sent: segs.filter((g) => (g.text || "").trim()),
  };
}

// ---------- engine ----------
export function createRefiner({
  getSession,
  allSessions,
  saveTranscript,
  saveMeta,
  emit,
  withLock,
  chat,
  outage,
  promptsFor,
  model,
  log,
}) {
  const running = new Set(); // `${id}:${w}` single-flight
  const timers = new Map();
  const inFlight = new Set();
  let stopped = false;
  function track(p) {
    inFlight.add(p);
    p.finally(() => inFlight.delete(p)).catch(() => {});
  }

  function cfg(s) {
    const r = s.meta.refine || {};
    return { enabled: Boolean(r.enabled), interval: r.interval || 300 };
  }
  function recordedUntil(s) {
    let e = 0;
    for (const g of s.transcript.segments) if (g && g.end > e) e = g.end;
    return e;
  }
  function isStopped(s) {
    return !["recording", "paused"].includes(s.meta.state);
  }

  function winState(s) {
    const { interval } = cfg(s);
    s.meta.refineWindows ||= {};
    return (s.meta.refineWindows[String(interval)] ||= {});
  }
  function publish(s) {
    emit(s.meta.id, { type: "refine", refine: s.meta.refine, windows: winState(s) });
  }

  // Scan a session and start any ready windows.
  function check(id) {
    if (stopped) return;
    const s = getSession(id);
    if (!s) return;
    const c = cfg(s);
    if (!c.enabled) return;
    if (outage.open) return; // healer's close triggers a sweep
    const groups = groupWindows(s.transcript.segments, c.interval);
    const ws = winState(s);
    const opts = { recordedUntil: recordedUntil(s), stopped: isStopped(s) };
    let changed = false;
    for (const [w, list] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
      const st = ws[w];
      const sig = list.map((g) => `${g.index}:${g.status}:${(g.text || "").length}`).join("|");
      if (st && (st.status === "done" || st.status === "running") && st.sig === sig) continue;
      // A manual rerun resets this exhausted state.
      if (st && st.status === "error" && st.sig === sig && !st.transient && (st.attempts || 0) >= 4) {
        continue;
      }
      if (st && st.status === "error" && st.sig === sig && (st.nextAt || 0) > Date.now()) {
        arm(id, st.nextAt - Date.now());
        continue;
      }
      if (!windowReady(list, w, c.interval, opts)) {
        if (!st || st.status !== "waiting") {
          ws[w] = { status: "waiting", sig: "" };
          changed = true;
        }
        continue;
      }
      track(run(s, w, list, sig));
    }
    if (changed) publish(s);
  }
  function arm(id, ms) {
    if (stopped || timers.has(id)) return;
    timers.set(
      id,
      setTimeout(
        () => {
          timers.delete(id);
          check(id);
        },
        Math.max(1000, ms),
      ),
    );
  }

  async function run(s, w, list, sig, { force = false } = {}) {
    if (stopped) return;
    const id = s.meta.id;
    const key = `${id}:${cfg(s).interval}:${w}`;
    if (running.has(key)) return;
    running.add(key);
    const ws = winState(s);
    const prevAttempts = ws[w]?.sig === sig ? ws[w]?.attempts || 0 : 0;
    ws[w] = { status: "running", sig, startedAt: new Date().toISOString(), attempts: prevAttempts + 1 };
    publish(s);
    const t0 = Date.now();
    try {
      const { interval } = cfg(s);
      const groups = groupWindows(s.transcript.segments, interval);
      const prev = groups.get(w - 1) || [];
      const prevTail = prev
        .slice(-TAIL_SEGMENTS)
        .map((g) => g.refined ?? g.text)
        .filter(Boolean)
        .join(" ")
        .slice(-800);
      const { base, context } = promptsFor(s);
      const results = new Map();
      let reasons = [];
      let rollingTail = prevTail;
      for (const chunk of chunkForCall(list.filter((g) => (g.text || "").trim()))) {
        const { messages, sent } = buildRefineMessages({
          systemBase: base,
          context,
          prevTail: rollingTail,
          segs: chunk,
        });
        if (!sent.length) continue;
        let v = null,
          lastErr = null;
        for (let attempt = 0; attempt < 2 && !(v && v.ok); attempt++) {
          try {
            const content = await chat({ model, effort: REFINE_EFFORT, messages, json: true });
            v = validateRefined(content, sent);
          } catch (err) {
            lastErr = err;
            if (err.transient) throw err;
          }
        }
        if (v?.ok) for (const [k, t] of v.map) results.set(k, t);
        else reasons.push(v ? v.reason : lastErr?.message || "알 수 없음");
        rollingTail = chunk
          .slice(-TAIL_SEGMENTS)
          .map((g) => results.get(g.index) ?? g.text)
          .join(" ")
          .slice(-800);
      }
      if (!getSession(id)) return;
      await withLock(id, async () => {
        const at = new Date().toISOString();
        for (const g of list) {
          const cur = s.transcript.segments[g.index];
          if (!cur) continue;
          if (results.has(g.index)) {
            cur.refined = results.get(g.index);
            cur.refinedAt = at;
            cur.refinedFrom = cur.text;
          } else if (!(cur.text || "").trim()) {
            delete cur.refined;
          }
        }
        await saveTranscript(s);
      });
      const ok = reasons.length === 0;
      ws[w] = ok
        ? { status: "done", sig, ms: Date.now() - t0, at: new Date().toISOString(), model, segs: list.length }
        : {
            status: "error",
            sig,
            ms: Date.now() - t0,
            error: "정제 결과를 검증하지 못해 원문을 유지했어요",
            attempts: prevAttempts + 1,
            nextAt: Date.now() + backoff(prevAttempts + 1),
          };
      log?.info("refine", ok ? "window_done" : "validation_failed", { ms: Date.now() - t0 });
      for (const g of list) {
        const cur = s.transcript.segments[g.index];
        if (cur) emit(id, { type: "segment", segment: cur });
      }
    } catch (err) {
      const transient = Boolean(err.transient);
      if (transient) outage.markDown?.();
      ws[w] = {
        status: "error",
        sig,
        error: transient ? "OpenCodex 연결이 끊겨 정제를 미뤘어요. 돌아오면 이어서 해요" : "정제하지 못했어요",
        attempts: prevAttempts + 1,
        nextAt: Date.now() + backoff(prevAttempts + 1),
        transient,
      };
      log?.warn("refine", "window_failed", { error: err });
    } finally {
      running.delete(key);
      if (getSession(id)) {
        await saveMeta(s).catch(() => {});
        publish(s);
      }
      const st = winState(s)[w];
      if (st?.status === "error" && !st.transient && (st.attempts || 0) < 4) arm(id, st.nextAt - Date.now());
    }
  }
  function backoff(n) {
    return Math.min(300000, 15000 * 2 ** (n - 1));
  }

  return {
    check,
    sweep() {
      for (const s of allSessions()) if (cfg(s).enabled) check(s.meta.id);
    },
    // Re-run every window (or one window) regardless of state.
    async rerun(id, { window } = {}) {
      const s = getSession(id);
      if (!s) return { started: 0 };
      const { interval } = cfg(s);
      const groups = groupWindows(s.transcript.segments, interval);
      const ws = winState(s);
      let started = 0;
      for (const [w, list] of groups) {
        if (window != null && w !== window) continue;
        if (!list.every((g) => FINAL.has(g.status))) continue;
        delete ws[w];
        const sig = list.map((g) => `${g.index}:${g.status}:${(g.text || "").length}`).join("|");
        track(run(s, w, list, sig, { force: true }));
        started++;
      }
      return { started };
    },
    running: () => running.size,
    winState,
    stop() {
      stopped = true;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    },
    drain: () => Promise.allSettled([...inFlight]),
  };
}
