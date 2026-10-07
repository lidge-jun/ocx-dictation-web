import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { once } from "node:events";

export const DEFAULT_LIMITS = Object.freeze({
  json: 2 * 1024 * 1024,
  segment: 12 * 1024 * 1024,
  upload: 4 * 1024 * 1024 * 1024,
});
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "media-src 'self'",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join("; ");
const HEADERS = Object.freeze({
  "Content-Security-Policy": CSP,
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "microphone=(self), camera=(), geolocation=()",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
});
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
};
const limitError = () => Object.assign(new Error("limit"), { status: 413, closeConnection: true });
export function createHttp({ log, limits = DEFAULT_LIMITS }) {
  limits = { ...DEFAULT_LIMITS, ...limits };
  function error(status, requestId) {
    return {
      error:
        status === 413
          ? "요청이 너무 커요"
          : status === 415
            ? "지원하지 않는 형식이에요"
            : status === 404
              ? "찾을 수 없어요"
              : "요청을 처리하지 못했어요",
      requestId,
    };
  }
  function send(res, status, body, headers = {}) {
    const isBytes = typeof body === "string" || Buffer.isBuffer(body);
    res.writeHead(status, {
      "Content-Type": isBytes ? "text/plain; charset=utf-8" : "application/json; charset=utf-8",
      ...headers,
    });
    return res.end(res.req?.method === "HEAD" ? undefined : isBytes ? body : JSON.stringify(body));
  }
  function consume(req, limit, onChunk) {
    return new Promise((resolve, reject) => {
      let size = 0,
        failed = false;
      req.on("data", (chunk) => {
        if (failed) return;
        size += chunk.length;
        if (size > limit) {
          failed = true;
          reject(limitError());
          return;
        }
        try {
          const r = onChunk(chunk);
          if (r && typeof r.then === "function") {
            req.pause();
            r.then(
              () => req.resume(),
              (e) => {
                failed = true;
                reject(e);
                req.resume();
              },
            );
          }
        } catch (e) {
          failed = true;
          reject(e);
        }
      });
      req.once("end", () => {
        if (!failed) resolve(size);
      });
      req.once("error", (e) => {
        if (!failed) {
          failed = true;
          reject(e);
        }
      });
      req.once("close", () => {
        if (!req.complete && !failed) {
          failed = true;
          reject(new Error("client_closed"));
        }
      });
    });
  }
  async function readBody(req, limit) {
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > limit) throw limitError();
    const chunks = [];
    await consume(req, limit, (c) => chunks.push(c));
    return Buffer.concat(chunks);
  }
  async function readJson(req) {
    if (!/^application\/json(?:\s*;|\s*$)/i.test(String(req.headers["content-type"] || "")))
      throw Object.assign(new Error("media"), { status: 415 });
    const bytes = await readBody(req, limits.json);
    let value;
    try {
      value = bytes.length ? JSON.parse(bytes.toString("utf8")) : {};
    } catch {
      throw Object.assign(new Error("json"), { status: 400 });
    }
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw Object.assign(new Error("json_shape"), { status: 400 });
    return value;
  }
  async function receiveUpload(req, dest) {
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > limits.upload) throw limitError();
    const out = fs.createWriteStream(dest, { flags: "wx" });
    let outError = null;
    const outFailed = new Promise((_, reject) =>
      out.on("error", (e) => {
        outError = e;
        reject(e);
      }),
    );
    outFailed.catch(() => {});
    try {
      const size = await Promise.race([
        consume(req, limits.upload, (chunk) => {
          if (outError) throw outError;
          return out.write(chunk) ? undefined : Promise.race([once(out, "drain"), outFailed]);
        }),
        outFailed,
      ]);
      await Promise.race([new Promise((resolve) => out.end(resolve)), outFailed]);
      if (outError) throw outError;
      return size;
    } catch (err) {
      out.destroy();
      await fsp.rm(dest, { force: true });
      throw err;
    }
  }
  function guard(req, port) {
    const host = String(req.headers.host || "").toLowerCase();
    if (!new Set([`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]).has(host)) return 421;
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      if (req.headers.origin !== undefined && req.headers.origin !== `http://${host}`) return 403;
      if (String(req.headers["sec-fetch-site"] || "").toLowerCase() === "cross-site") return 403;
    }
    return 0;
  }
  async function staticPath(root, pathname) {
    const raw = pathname === "/" ? "index.html" : pathname.replace(/^\//, "");
    let parts;
    try {
      parts = raw.split("/").map((part) => decodeURIComponent(part));
    } catch {
      return null;
    }
    if (
      parts.some(
        (part) =>
          !part ||
          part === "." ||
          part === ".." ||
          part.includes("/") ||
          part.includes("\\") ||
          part.includes("%") ||
          part.includes("\0"),
      )
    )
      return null;
    let realRoot;
    try {
      realRoot = await fsp.realpath(root);
    } catch {
      return undefined;
    }
    const candidate = path.resolve(root, ...parts);
    if (!candidate.startsWith(path.resolve(root) + path.sep)) return null;
    let real;
    try {
      real = await fsp.realpath(candidate);
    } catch {
      return undefined;
    }
    return real.startsWith(realRoot + path.sep) ? real : null;
  }
  async function serveFile(req, res, file, mime, root) {
    let fd;
    try {
      if (!file) return send(res, 404, error(404, res.getHeader("X-Request-Id")));
      const real = await fsp.realpath(file);
      if (root) {
        const realRoot = await fsp.realpath(root);
        if (!real.startsWith(realRoot + path.sep)) return send(res, 404, error(404, res.getHeader("X-Request-Id")));
      }
      fd = await fsp.open(real, "r");
      const stat = await fd.stat();
      if (!stat.isFile()) {
        await fd.close();
        return send(res, 404, error(404, res.getHeader("X-Request-Id")));
      }
      const type = mime || MIME[path.extname(real).toLowerCase()] || "application/octet-stream";
      const range = req.headers.range;
      let start = 0,
        end = stat.size - 1,
        status = 200;
      if (range) {
        const m = /^bytes=(\d*)-(\d*)$/.exec(String(range));
        if (!m || (!m[1] && !m[2])) {
          await fd.close();
          return send(res, 416, "Range Not Satisfiable", { "Content-Range": `bytes */${stat.size}` });
        }
        if (!m[1]) {
          const suffix = Number(m[2]);
          if (!Number.isSafeInteger(suffix) || suffix <= 0) {
            await fd.close();
            return send(res, 416, "Range Not Satisfiable", { "Content-Range": `bytes */${stat.size}` });
          }
          start = Math.max(0, stat.size - suffix);
        } else {
          start = Number(m[1]);
          if (m[2]) end = Math.min(Number(m[2]), stat.size - 1);
        }
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= stat.size) {
          await fd.close();
          return send(res, 416, "Range Not Satisfiable", { "Content-Range": `bytes */${stat.size}` });
        }
        status = 206;
      }
      const headers = {
        "Content-Type": type,
        "Accept-Ranges": "bytes",
        "Content-Length": Math.max(0, end - start + 1),
      };
      if (status === 206) headers["Content-Range"] = `bytes ${start}-${end}/${stat.size}`;
      res.writeHead(status, headers);
      if (req.method === "HEAD" || stat.size === 0) {
        await fd.close();
        return res.end();
      }
      const stream = fd.createReadStream({ start, end, autoClose: true });
      fd = null;
      stream.on("error", () => {
        if (!res.headersSent) send(res, 500, error(500, res.getHeader("X-Request-Id")));
        else res.destroy();
      });
      stream.pipe(res);
      return;
    } catch {
      if (fd) await fd.close().catch(() => {});
      if (!res.headersSent) return send(res, 404, error(404, res.getHeader("X-Request-Id")));
      if (!res.writableEnded) res.destroy();
    }
  }
  async function handle(req, res, { port, publicDir, paths, routes }) {
    const requestId = crypto.randomUUID();
    res.setHeader("X-Request-Id", requestId);
    for (const [k, v] of Object.entries(HEADERS)) res.setHeader(k, v);
    const rawPath = String(req.url || "").split("?", 1)[0];
    if (/%(?:2e|2f|5c)/i.test(rawPath) || rawPath.split("/").some((p) => p === ".." || p === "."))
      return send(res, 404, error(404, requestId));
    let url;
    try {
      url = new URL(req.url, "http://localhost");
    } catch {
      return send(res, 400, error(400, requestId));
    }
    if (url.pathname.startsWith("/api/")) res.setHeader("Cache-Control", "no-store");
    const denied = guard(req, port);
    if (denied) return send(res, denied, error(denied, requestId));
    const started = Date.now();
    try {
      if (req.method === "OPTIONS") return send(res, 204, "");
      if (url.pathname.startsWith("/api/")) return await routes.dispatch({ req, res, url, requestId });
      const debug = url.pathname === "/debug/sample.wav",
        root = debug ? paths.debugDir : publicDir;
      const target = await staticPath(root, debug ? "/sample.wav" : url.pathname);
      if (target === null) return send(res, 404, error(404, requestId));
      if (target === undefined) {
        if (!debug && !path.extname(url.pathname))
          return serveFile(req, res, await staticPath(publicDir, "/index.html"), undefined, publicDir);
        return send(res, 404, error(404, requestId));
      }
      return serveFile(req, res, target, undefined, root);
    } catch (err) {
      log.error("http", "request_failed", {
        requestId,
        method: req.method,
        route: url.pathname,
        status: err.status || 500,
        error: err,
      });
      if (err.closeConnection && !res.headersSent) res.setHeader("Connection", "close");
      if (!res.headersSent) return send(res, err.status || 500, error(err.status || 500, requestId));
      if (!res.writableEnded) res.end();
    } finally {
      log.info("http", "request", {
        requestId,
        method: req.method,
        route: url.pathname,
        status: res.statusCode,
        ms: Date.now() - started,
      });
    }
  }
  return { send, readBody, readJson, receiveUpload, staticPath, serveFile, handle, limits };
}
