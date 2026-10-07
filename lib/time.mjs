import crypto from "node:crypto";

function fields(value, timezone) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("Invalid date");
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  return Object.fromEntries(
    f
      .formatToParts(date)
      .filter((x) => x.type !== "literal")
      .map((x) => [x.type, x.value]),
  );
}
export function formatDate(value, timezone) {
  const p = fields(value, timezone);
  return `${p.year}-${p.month}-${p.day}`;
}
export function formatDateTime(value, timezone) {
  const p = fields(value, timezone);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} ${timezone}`;
}
export function newSessionId(timezone, now = new Date()) {
  const p = fields(now, timezone);
  return `${p.year}${p.month}${p.day}-${p.hour}${p.minute}${p.second}-${crypto.randomBytes(2).toString("hex")}`;
}
export const pad = (n, w = 2) => String(n).padStart(w, "0");
export function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600),
    m = Math.floor((sec % 3600) / 60),
    s = sec % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}
export function fmtSrt(sec) {
  const ms = Math.round(sec * 1000);
  const h = Math.floor(ms / 3600000),
    m = Math.floor((ms % 3600000) / 60000),
    s = Math.floor((ms % 60000) / 1000);
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms % 1000, 3)}`;
}
export function createTime(timezone) {
  return {
    pad,
    fmtTime,
    fmtSrt,
    localDate: (v) => formatDate(v, timezone),
    localDateTime: (v) => formatDateTime(v, timezone),
    newId: () => newSessionId(timezone),
  };
}
