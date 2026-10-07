import { esc } from "./markdown.js";
export { esc };

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600),
    m = Math.floor((sec % 3600) / 60),
    s = sec % 60;
  const p = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
}
export function fmtDuration(sec) {
  sec = Math.round(sec || 0);
  const h = Math.floor(sec / 3600),
    m = Math.floor((sec % 3600) / 60);
  if (h) return `${h}시간 ${m}분`;
  if (m) return `${m}분`;
  return `${sec}초`;
}
export function fmtDate(iso) {
  const d = new Date(iso);
  const days = ["일", "월", "화", "수", "목", "금", "토"];
  return `${d.getMonth() + 1}월 ${d.getDate()}일 (${days[d.getDay()]}) \
${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
export function fmtDay(iso) {
  const d = new Date(iso);
  const today = new Date();
  const y = new Date();
  y.setDate(today.getDate() - 1);
  const same = (a, b) => a.toDateString() === b.toDateString();
  if (same(d, today)) return "오늘";
  if (same(d, y)) return "어제";
  return `${d.getMonth() + 1}월 ${d.getDate()}일`;
}

let toastTimer = null;
export function toast(msg, { error = false, ms = 3200 } = {}) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.toggle("error", error);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, ms);
}

export async function api(path, { method = "GET", json, body, headers = {}, signal } = {}) {
  const opts = { method, headers: { ...headers }, signal };
  if (json !== undefined) {
    opts.body = JSON.stringify(json);
    opts.headers["content-type"] = "application/json";
  } else if (body !== undefined) opts.body = body;
  const res = await fetch(path, opts);
  const ct = res.headers.get("content-type") || "";
  const data = ct.includes("json") ? await res.json().catch(() => ({})) : await res.text();
  if (!res.ok) {
    const err = new Error((data && data.error) || `요청이 실패했어요 (${res.status})`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

// POST that returns an SSE stream; calls onEvent for each JSON event.
export async function streamPost(path, json, onEvent, signal) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(json),
    signal,
  });
  if (!res.ok || !(res.headers.get("content-type") || "").includes("event-stream")) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `요청이 실패했어요 (${res.status})`);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      for (const line of block.split("\n")) {
        if (line.startsWith("data:")) {
          try {
            onEvent(JSON.parse(line.slice(5)));
          } catch {}
        }
      }
    }
  }
}

export function confirmDialog(title, msg, yes = "확인") {
  const dlg = $("#confirmDlg");
  $("#confirmTitle").textContent = title;
  $("#confirmMsg").textContent = msg;
  $("#confirmYes").textContent = yes;
  dlg.returnValue = "";
  dlg.showModal();
  return new Promise((resolve) =>
    dlg.addEventListener("close", () => resolve(dlg.returnValue === "yes"), { once: true }),
  );
}

export function download(url) {
  const a = document.createElement("a");
  a.href = url;
  a.download = "";
  document.body.append(a);
  a.click();
  a.remove();
}

export const bus = new EventTarget();
export const emit = (type, detail) => bus.dispatchEvent(new CustomEvent(type, { detail }));
export const on = (type, fn) => {
  const h = (e) => fn(e.detail);
  bus.addEventListener(type, h);
  return () => bus.removeEventListener(type, h);
};
