const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const SAFE_FIELDS = new Set([
  "requestId",
  "method",
  "route",
  "status",
  "ms",
  "port",
  "sessions",
  "attempt",
  "job",
  "upstreamStatus",
  "error",
]);
export function createLogger({
  level = "info",
  format = "text",
  secret = "",
  write = (line) => process.stderr.write(line + "\n"),
} = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;
  const scrub = (value) => {
    let s = String(value ?? "");
    if (secret) s = s.split(secret).join("[redacted]");
    return s
      .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
      .replace(/Authorization\s*[:=]\s*\S+/gi, "Authorization=[redacted]")
      .replace(/(?:ocx_|sk-|github_pat_)[A-Za-z0-9_-]+/g, "[redacted]")
      .slice(0, 512);
  };
  function record(kind, scope, message, fields = {}) {
    if (LEVELS[kind] < threshold) return;
    const safe = {};
    const category = (v) =>
      v instanceof Error
        ? String(v.code || v.name || "Error")
            .replace(/[^A-Za-z0-9_]/g, "")
            .slice(0, 40) || "Error"
        : /^[a-z0-9_]{1,40}$/.test(String(v))
          ? String(v)
          : "unknown";
    for (const [key, value] of Object.entries(fields))
      if (SAFE_FIELDS.has(key)) safe[key] = key === "error" ? category(value) : scrub(value);
    const row = { at: new Date().toISOString(), level: kind, scope: scrub(scope), message: scrub(message), ...safe };
    write(
      format === "json"
        ? JSON.stringify(row)
        : `${row.at} ${kind.toUpperCase()} [${row.scope}] ${row.message}${Object.entries(safe)
            .map(([k, v]) => ` ${k}=${v}`)
            .join("")}`,
    );
  }
  return Object.fromEntries(
    Object.keys(LEVELS).map((kind) => [kind, (scope, message, fields) => record(kind, scope, message, fields)]),
  );
}
