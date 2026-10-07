import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
export async function startFakeOcx({ port = 0, mode = "ok", errorBody = "upstream failure marker" } = {}) {
  let calls = 0;
  let markStarted, releaseHeld;
  const started = new Promise((resolve) => {
    markStarted = resolve;
  });
  const held = new Promise((resolve) => {
    releaseHeld = resolve;
  });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/__mode") {
      mode = url.searchParams.get("m") || mode;
      res.end(JSON.stringify({ mode, calls }));
      return;
    }
    if (url.pathname === "/healthz") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ status: mode === "ok" ? "ok" : "degraded", version: "fake" }));
      return;
    }
    if (url.pathname === "/v1/models") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: [{ id: "example-chat", api_types: ["chat_completions"] }] }));
      return;
    }
    if (url.pathname === "/v1/audio/transcriptions") {
      calls++;
      markStarted();
      for await (const _ of req) {
      }
      if (mode === "down504" || mode === "502") {
        res.writeHead(mode === "502" ? 502 : 504);
        res.end(errorBody);
        return;
      }
      if (mode === "hang") return;
      if (mode === "slow") await new Promise((resolve) => setTimeout(resolve, 8000));
      if (mode === "held") await held;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ text: `Example transcript ${calls}` }));
      return;
    }
    if (url.pathname === "/v1/chat/completions") {
      let body = "";
      for await (const chunk of req) body += chunk;
      if (mode === "down504" || mode === "502") {
        res.writeHead(mode === "502" ? 502 : 504);
        res.end(errorBody);
        return;
      }
      if (JSON.parse(body).stream) {
        res.setHeader("content-type", "text/event-stream");
        res.end('data: {"choices":[{"delta":{"content":"Example note"}}]}\n\ndata: [DONE]\n\n');
        return;
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: "Example note" } }] }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
    calls: () => calls,
    started,
    release: () => releaseHeld(),
  };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const fake = await startFakeOcx({ port: Number(process.argv[2] || 10299), mode: process.argv[3] || "ok" });
  console.log("fake ocx", fake.url);
}
