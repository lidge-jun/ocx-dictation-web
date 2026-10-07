// AI note panel and Q&A panel for a session.
import { renderMarkdown } from "./markdown.js";
import { $, api, esc, streamPost, toast, fmtDate } from "./util.js";

let modelCache = null;
const PREF_KEY = "lns.aiPref.v2";
export async function getModels() {
  if (!modelCache)
    modelCache = (async () => {
      const config = await api("/api/config");
      let remote;
      try {
        remote = await api("/api/models");
      } catch {
        remote = { models: [config.noteModel], default: config.noteModel };
      }
      const models = Array.isArray(remote.models) ? remote.models.filter((m) => typeof m === "string" && m) : [];
      return { models, default: remote.default, noteModel: config.noteModel };
    })().catch((e) => {
      modelCache = null;
      throw e;
    });
  return modelCache;
}
const TEMPLATE_LABEL = { lecture: "강의 노트", meeting: "회의록", free: "자유 요약" };

export function mountAiPanel(root, ctx) {
  // ctx: { session, onSeek, hasSource: () => bool }
  const s = ctx.session;
  const pref = JSON.parse(localStorage.getItem(PREF_KEY) || "{}");
  const defTpl = s.meta.aiNoteInfo?.template || pref.template || "lecture";
  root.innerHTML = `
    <div class="ai-toolbar">
      <button class="btn primary" type="button" id="aiGo"></button>
      <label class="compact slim"><span class="sr-only">양식</span>
        <select id="aiTemplate">${Object.entries(TEMPLATE_LABEL)
          .map(([k, v]) => `<option value="${k}"${k === defTpl ? " selected" : ""}>${v}</option>`)
          .join("")}</select>
      </label>
      <label class="compact slim"><span class="sr-only">모델</span><select \
id="aiModel"><option value="">모델 불러오는 중</option></select></label>
      <label class="compact slim" id="aiSrcWrap" hidden><span \
class="sr-only">대본</span><select id="aiSrc"><option value="refined">정제본으로</option><option \
value="raw">원문으로</option></select></label>
      <span class="spacer"></span>
      <button class="btn ghost small" type="button" id="aiEdit" aria-pressed="false">직접 고치기</button>
    </div>
    <p class="notice" id="aiNotice" role="status" hidden></p>
    <details class="ai-extra"><summary>요청 덧붙이기</summary>
      <textarea id="aiExtra" rows="2" placeholder="예: 그래프 설명은 단계별로, 시험 힌트는 따로 모아줘">${esc(pref.extra || "")}</textarea>
    </details>
    <p class="ai-meta muted" id="aiMeta"></p>
    <article class="md" id="aiView" aria-live="off"></article>
    <textarea class="md-edit" id="aiEditor" hidden aria-label="강의노트 편집"></textarea>
  `;
  const view = $("#aiView", root),
    editor = $("#aiEditor", root),
    go = $("#aiGo", root),
    meta = $("#aiMeta", root),
    editBtn = $("#aiEdit", root);
  let text = s.aiNote || "";
  let busy = false,
    ctrl = null,
    editing = false,
    saveTimer = null;

  let modelReady = false;
  go.disabled = true;
  getModels()
    .then(({ models, default: remoteDefault, noteModel }) => {
      const sel = $("#aiModel", root);
      const want = [pref.model, noteModel, remoteDefault].find((m) => m && models.includes(m)) || models[0];
      sel.innerHTML = models.length
        ? models.map((m) => `<option value="${esc(m)}"${m === want ? " selected" : ""}>${esc(m)}</option>`).join("")
        : '<option value="">사용 가능한 모델이 없어요</option>';
      modelReady = Boolean(want);
      go.disabled = !modelReady;
    })
    .catch((e) => {
      $("#aiModel", root).innerHTML = '<option value="">모델을 불러오지 못했어요</option>';
      go.disabled = true;
      toast(e.message, { error: true });
    });

  function paintMeta() {
    const info = s.meta.aiNoteInfo;
    meta.textContent = info
      ? `${info.templateLabel} · ${info.model} · \
${info.source === "refined" ? "정제본 기반" : "원문 기반"}${
            info.customPrompt ? " · 수정한 프롬프트" : ""
          } · ${fmtDate(info.generatedAt)}${info.edited ? " · 직접 고침" : ""}`
      : "";
    const hr = ctx.hasRefined?.();
    $("#aiSrcWrap", root).hidden = !hr;
  }
  function paint() {
    go.textContent = busy ? "멈추기" : text ? "다시 만들기" : "강의노트 만들기";
    ctx.onNote?.(Boolean(text));
    go.classList.toggle("primary", !busy);
    editBtn.disabled = busy || !text;
    if (!text && !busy) {
      view.innerHTML = `<div class="empty"><p class="empty-title">아직 강의노트가 없어요</p><p \
class="muted">대본과 내 메모, 중요 표시를 합쳐 핵심 개념, 정의와 공식, 교수님이 강조한 부분 순서로 정리해요. 녹음 중에도 지금까지의 내용으로 만들 수 있어요.</p></div>`;
    } else {
      view.innerHTML = renderMarkdown(text) + (busy ? `<span class="caret" aria-hidden="true"></span>` : "");
    }
    paintMeta();
  }
  paint();
  if (ctx.getSource) $("#aiSrc", root).value = ctx.getSource();

  let raf = 0;
  const schedulePaint = () => {
    if (!raf)
      raf = requestAnimationFrame(() => {
        raf = 0;
        paint();
      });
  };

  go.addEventListener("click", async () => {
    if (busy) {
      ctrl?.abort();
      return;
    }
    if (!modelReady) {
      toast("모델을 불러오는 중이에요", { error: true });
      return;
    }
    if (!ctx.hasSource()) {
      toast("정리할 대본이나 메모가 아직 없어요");
      return;
    }
    if (editing) toggleEdit(false);
    const template = $("#aiTemplate", root).value,
      extra = $("#aiExtra", root).value;
    const source = ctx.hasRefined?.() ? $("#aiSrc", root).value : "raw";
    const model = $("#aiModel", root).value;
    const notice = $("#aiNotice", root);
    notice.hidden = true;
    localStorage.setItem(PREF_KEY, JSON.stringify({ template, model, extra }));
    const prev = text;
    busy = true;
    text = "";
    ctrl = new AbortController();
    view.setAttribute("aria-busy", "true");
    paint();
    const run = (m) =>
      streamPost(
        `/api/sessions/${s.id}/generate`,
        { template, model: m, extra, source },
        (ev) => {
          if (ev.type === "delta") {
            text += ev.text;
            schedulePaint();
          }
          if (ev.type === "done") {
            s.meta.aiNoteInfo = ev.info;
            s.aiNote = text;
          }
          if (ev.type === "error") throw new Error(ev.message);
        },
        ctrl.signal,
      );
    try {
      await run(model);
      if (!text.trim()) {
        text = prev;
        toast("모델이 빈 답을 보냈어요. 다시 시도해주세요.", { error: true });
      }
    } catch (err) {
      if (err.name === "AbortError") {
        toast("멈췄어요. 이전 노트는 그대로 있어요");
        text = prev;
      } else {
        toast(err.message, { error: true, ms: 6000 });
        if (!text.trim()) text = prev;
      }
    } finally {
      busy = false;
      ctrl = null;
      view.removeAttribute("aria-busy");
      paint();
    }
  });

  function toggleEdit(on) {
    editing = on;
    editBtn.setAttribute("aria-pressed", String(on));
    editBtn.textContent = on ? "다 고쳤어요" : "직접 고치기";
    editor.hidden = !on;
    view.hidden = on;
    if (on) {
      editor.value = text;
      editor.style.height = "auto";
      editor.style.height = `${Math.max(320, editor.scrollHeight)}px`;
      editor.focus();
    } else paint();
  }
  editBtn.addEventListener("click", () => toggleEdit(!editing));
  editor.addEventListener("input", () => {
    text = editor.value;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try {
        await api(`/api/sessions/${s.id}/ai-note`, { method: "PUT", json: { text } });
        if (s.meta.aiNoteInfo) s.meta.aiNoteInfo.edited = true;
        paintMeta();
        s.aiNote = text;
      } catch {
        toast("노트를 저장하지 못했어요. 잠시 후 다시 시도해주세요.", { error: true });
      }
    }, 700);
  });
  view.addEventListener("click", (e) => {
    const b = e.target.closest(".ts");
    if (b) ctx.onSeek(Number(b.dataset.t));
  });

  return {
    destroy() {
      ctrl?.abort();
      clearTimeout(saveTimer);
    },
  };
}

export function mountAskPanel(root, ctx) {
  const s = ctx.session;
  const history = [];
  root.innerHTML = `
    <div class="qa-log" id="qaLog" aria-live="polite"><div class="empty small"><p \
class="muted">녹음 내용에 대해 물어보세요. 답에는 근거가 된 시각이 붙어요.</p>
      <div class="chips"><button type="button" class="chip" data-q="교수가 시험에 나온다고 한 부분만 \
모아줘">시험 언급 모아보기</button><button type="button" class="chip" data-q="오늘 수업에서 이해하기 어려운 부분을 \
쉽게 다시 설명해줘">어려운 부분 풀어주기</button><button type="button" class="chip" data-q="다음 수업 전에 해야 할 \
과제나 공지가 있었어?">공지·과제 확인</button></div></div></div>
    <form class="qa-form" id="qaForm">
      <label class="sr-only" for="qaInput">질문</label>
      <textarea id="qaInput" rows="1" placeholder="예: 교환효과와 특화효과 차이를 다시 설명해줘" required></textarea>
      <button class="btn primary" type="submit" id="qaSend">묻기</button>
    </form>`;
  const log = $("#qaLog", root),
    input = $("#qaInput", root),
    form = $("#qaForm", root),
    send = $("#qaSend", root);
  let ctrl = null;
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      form.requestSubmit();
    }
  });
  root.addEventListener("click", (e) => {
    const chip = e.target.closest(".chip[data-q]");
    if (chip) {
      input.value = chip.dataset.q;
      form.requestSubmit();
    }
    const ts = e.target.closest(".ts");
    if (ts) ctx.onSeek(Number(ts.dataset.t));
  });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (ctrl) {
      ctrl.abort();
      return;
    }
    const q = input.value.trim();
    if (!q) return;
    if (!ctx.hasSource()) {
      toast("아직 대본이 없어요");
      return;
    }
    log.querySelector(".empty")?.remove();
    log.insertAdjacentHTML("beforeend", `<div class="qa-q">${esc(q)}</div>`);
    const a = document.createElement("div");
    a.className = "qa-a md";
    a.innerHTML = `<span class="muted">생각하는 중</span>`;
    log.append(a);
    input.value = "";
    let text = "";
    ctrl = new AbortController();
    send.textContent = "멈추기";
    try {
      const { models, noteModel } = await getModels();
      const prefModel = JSON.parse(localStorage.getItem(PREF_KEY) || "{}").model;
      const model = [prefModel, noteModel].find((m) => models.includes(m)) || models[0];
      if (!model) throw new Error("사용 가능한 모델이 없어요");
      await streamPost(
        `/api/sessions/${s.id}/ask`,
        { question: q, history, model },
        (ev) => {
          if (ev.type === "delta") {
            text += ev.text;
            a.innerHTML = renderMarkdown(text);
            log.scrollTop = log.scrollHeight;
          }
          if (ev.type === "error") throw new Error(ev.message);
        },
        ctrl.signal,
      );
      history.push({ role: "user", content: q }, { role: "assistant", content: text });
    } catch (err) {
      if (err.name !== "AbortError") a.innerHTML = `<p class="err">${esc(err.message)}</p>`;
    } finally {
      ctrl = null;
      send.textContent = "묻기";
    }
  });
  return {
    destroy() {
      ctrl?.abort();
    },
  };
}
