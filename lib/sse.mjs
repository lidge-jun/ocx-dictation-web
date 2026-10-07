export function createSse({ store, http }) {
  const bySession = new Map(),
    all = new Set(),
    timers = new Map();
  const MAX_CLIENT_BUFFER = 1024 * 1024;
  function writeRaw(res, bytes) {
    if (res.writableEnded || res.destroyed) return;
    res.write(bytes);
    if (res.writableLength > MAX_CLIENT_BUFFER) res.end();
  }
  function write(res, event) {
    writeRaw(res, `data: ${JSON.stringify(event)}\n\n`);
  }
  function stream(res, id = null) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    all.add(res);
    if (id) {
      if (!bySession.has(id)) bySession.set(id, new Set());
      bySession.get(id).add(res);
    }
    const timer = setInterval(() => writeRaw(res, ": ping\n\n"), 20_000);
    timers.set(res, timer);
    res.once("close", () => {
      clearInterval(timer);
      timers.delete(res);
      all.delete(res);
      if (id) {
        bySession.get(id)?.delete(res);
        if (!bySession.get(id)?.size) bySession.delete(id);
      }
    });
    res.once("error", () => res.end());
    return (event) => write(res, event);
  }
  function start(id, req, res, hello) {
    const push = stream(res, id);
    push(hello);
    return push;
  }
  function emit(id, event) {
    for (const res of bySession.get(id) || []) write(res, event);
  }
  function shutdown() {
    for (const res of all) {
      write(res, { type: "shutdown" });
      res.end();
    }
    for (const timer of timers.values()) clearInterval(timer);
    timers.clear();
    all.clear();
    bySession.clear();
  }
  function events({ req, res, params, requestId }) {
    const s = store.get(params[0]);
    if (!s) return http.send(res, 404, { error: "찾을 수 없어요", requestId });
    return start(params[0], req, res, {
      type: "hello",
      stats: store.segStats(s),
      duration: store.durationOf(s),
      state: s.meta.state,
    });
  }
  return { start, stream, emit, shutdown, count: () => all.size, handlers: { events } };
}
