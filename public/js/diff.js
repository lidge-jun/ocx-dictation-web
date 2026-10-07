// Word-level diff between raw ASR text and the refined text, rendered as the refined text with
// changed words underlined (hover shows what the raw transcript said). Punctuation-only changes are ignored.
import { esc } from "./markdown.js";

const key = (t) => t.replace(/[.,?!…·"'“”‘’()\[\]:;~\-]/g, "").toLowerCase();

function lcsOps(a, b) {
  const n = a.length,
    m = b.length;
  if (n * m > 250000) return null; // pathological size: skip highlighting
  const ka = a.map(key),
    kb = b.map(key);
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = ka[i] === kb[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ops = [];
  let i = 0,
    j = 0;
  while (i < n && j < m) {
    if (ka[i] === kb[j]) {
      ops.push(["=", a[i], b[j]]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push(["-", a[i]]);
      i++;
    } else {
      ops.push(["+", b[j]]);
      j++;
    }
  }
  while (i < n) ops.push(["-", a[i++]]);
  while (j < m) ops.push(["+", b[j++]]);
  return ops;
}

export function diffHtml(raw, refined) {
  const a = String(raw || "")
    .split(/\s+/)
    .filter(Boolean);
  const b = String(refined || "")
    .split(/\s+/)
    .filter(Boolean);
  const ops = lcsOps(a, b);
  if (!ops) return esc(refined);
  const out = [];
  let dels = [],
    ins = [];
  const flush = () => {
    if (ins.length)
      out.push(
        `<span class="chg" title="${esc(dels.length ? `원문: \
${dels.join(" ")}` : "원문에 없던 말")}">${esc(ins.join(" "))}</span>`,
      );
    else if (dels.length) out.push(`<span class="gone" title="${esc(`원문에서 뺀 말: ${dels.join(" ")}`)}"></span>`);
    dels = [];
    ins = [];
  };
  for (const op of ops) {
    if (op[0] === "=") {
      flush();
      out.push(esc(op[2]));
    } else if (op[0] === "-") dels.push(op[1]);
    else ins.push(op[1]);
  }
  flush();
  return out.join(" ").replace(/ (<span class="gone")/g, "$1");
}

export function changedCount(raw, refined) {
  const ops = lcsOps(
    String(raw || "")
      .split(/\s+/)
      .filter(Boolean),
    String(refined || "")
      .split(/\s+/)
      .filter(Boolean),
  );
  return ops ? ops.filter((o) => o[0] === "+").length : 0;
}
