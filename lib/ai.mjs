import crypto from "node:crypto";
import path from "node:path";
import { writeTextAtomic } from "./util.mjs";
import { DEFAULT_PROMPTS } from "./prompts.mjs";
const TEMPLATES = {
  lecture: {
    label: "강의 노트",
    instructions: `대학 강의 녹음 대본으로 복습용 강의 노트를 만든다. 다음 섹션을 순서대로 쓴다.\n## 오늘 한 줄\n## 핵심 개념\n## \
정의·공식 (수식은 \\( \\) LaTeX로)\n## 예시·사례\n## 교수가 강조한 것 / 시험 힌트 (교수가 "시험", "퀴즈", "중요", "꼭" 등으로 \
강조한 부분을 [mm:ss]와 함께 거의 그대로 인용)\n## 질문거리 (이해가 덜 된 부분, 다음 수업 전에 확인할 것)\n해당 내용이 없으면 그 섹션은 "대본에서 확인되지 않음"이라고 쓴다.`,
  },
  meeting: {
    label: "회의록",
    instructions: `회의 녹음 대본으로 회의록을 만든다. 다음 섹션을 순서대로 쓴다.\n## 한 줄 요약\n## 결정사항\n## 액션 아이템 (- \
[ ] 할 일 — 담당자 — 기한. 담당이나 기한이 대본에 없으면 "미정")\n## 논의 요약 (주제별 소제목)\n## 열린 질문\n발언자가 명확하지 않으면 추측하지 말고 "발언자 미상"으로 쓴다.`,
  },
  free: {
    label: "자유 요약",
    instructions:
      "녹음 대본을 읽기 쉬운 요약 노트로 정리한다. 주제 흐름에 맞춰 소제목을 스스로 정하고, 핵심 문장은 [mm:ss] 근거를 붙인다.",
  },
};
const SYSTEM_BASE = `너는 한국어 노트 정리 도우미다. 출력은 마크다운만 쓴다. 이모지를 쓰지 않는다.\n규칙:\n- 대본은 자동 음성 인식 \
결과라 오탈자와 잘못 들린 단어가 있다. 문맥과 사용자 용어집으로 바로잡되, 대본에 없는 내용을 지어내지 않는다.\n- 사용자 필기와 "(중요)" 표시는 \
사용자가 직접 남긴 신호다. 해당 시각 주변 대본을 우선해서 반영한다.\n- 근거가 되는 대본 위치는 [mm:ss] 형식으로 붙인다.\n- 전문 용어는 한국어(영어) 형태로 처음 한 번 병기한다.`;
export function createAi({ cfg, store, prompts, sse, notes, exporter, http, log }) {
  const generations = new Map(),
    controllers = new Set(),
    inFlight = new Set();
  let stopped = false;
  const headers = { Authorization: `Bearer ${cfg.ocxKey}`, "content-type": "application/json" };
  function track(p) {
    inFlight.add(p);
    p.finally(() => inFlight.delete(p)).catch(() => {});
    return p;
  }
  function sourceBlock(s, source = "refined") {
    const parts = [`제목: ${s.meta.title}`],
      ctx = store.sessionContext(s);
    if (ctx) parts.push(ctx);
    const nm = notes.notesBody(s);
    parts.push(`\n[사용자 메모]\n${nm || "(없음)"}`);
    const refinedUsed = source !== "raw" && exporter.hasRefined(s);
    parts.push(
      `\n[녹음 대본${refinedUsed ? " (정제본: 받아쓰기 오류를 교정한 버전)" : ""}]\n\
${exporter.transcriptText(s, true, source) || "(대본 없음)"}`,
    );
    return parts.join("\n");
  }
  function systemPrompt(key) {
    return !key || key === "lecture"
      ? prompts.get().base.note
      : `${SYSTEM_BASE}\n\n${(TEMPLATES[key] || TEMPLATES.free).instructions}`;
  }
  async function request(url, init, requestId) {
    const controller = new AbortController();
    controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), 180000);
    try {
      const res = await fetch(url, { ...init, signal: controller.signal });
      if (!res.ok) {
        log.warn("ai", "upstream_failed", { requestId, upstreamStatus: res.status, error: "upstream_http" });
        await res.body?.cancel();
        throw Object.assign(new Error("OpenCodex 요청에 실패했어요"), {
          transient: res.status >= 500 || res.status === 429,
        });
      }
      return {
        res,
        cleanup: () => {
          clearTimeout(timer);
          controllers.delete(controller);
        },
      };
    } catch (err) {
      clearTimeout(timer);
      controllers.delete(controller);
      if (err.message === "OpenCodex 요청에 실패했어요") throw err;
      log.warn("ai", "upstream_failed", {
        requestId,
        error: err.name === "AbortError" ? "upstream_timeout" : "upstream_unreachable",
      });
      throw Object.assign(new Error("OpenCodex 요청에 실패했어요"), { transient: true });
    }
  }
  async function chatOnce({ model, effort, messages, json, requestId }) {
    const { res, cleanup } = await request(
      `${cfg.ocxBase}/v1/chat/completions`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          model,
          messages,
          ...(effort ? { reasoning_effort: effort } : {}),
          ...(json ? { response_format: { type: "json_object" } } : {}),
        }),
      },
      requestId,
    );
    try {
      const j = await res.json();
      return j.choices?.[0]?.message?.content || "";
    } finally {
      cleanup();
    }
  }
  async function streamChat({ model, messages, onDelta, requestId }) {
    const { res, cleanup } = await request(
      `${cfg.ocxBase}/v1/chat/completions`,
      { method: "POST", headers, body: JSON.stringify({ model, messages, stream: true }) },
      requestId,
    );
    try {
      const reader = res.body.getReader(),
        dec = new TextDecoder();
      let buf = "",
        full = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload === "[DONE]") continue;
          try {
            const j = JSON.parse(payload),
              d = j.choices?.[0]?.delta?.content;
            if (d) {
              full += d;
              onDelta(d);
            }
          } catch {}
        }
      }
      return full;
    } finally {
      cleanup();
    }
  }
  async function models({ res }) {
    try {
      const r = await fetch(`${cfg.ocxBase}/v1/models`, {
        headers: { Authorization: `Bearer ${cfg.ocxKey}` },
        signal: AbortSignal.timeout(5000),
      });
      const j = await r.json();
      const ids = (j.data || [])
        .filter((x) => (x.api_types || ["chat_completions"]).includes("chat_completions"))
        .map((x) => x.id);
      return http.send(res, 200, {
        models: ids,
        default: ids.includes(cfg.noteModel) ? cfg.noteModel : ids[0] || cfg.noteModel,
      });
    } catch {
      return http.send(res, 200, {
        models: [cfg.noteModel],
        default: cfg.noteModel,
        error: "모델 목록을 불러오지 못했어요",
      });
    }
  }
  async function putAiNote({ res, params, body, requestId }) {
    const s = store.get(params[0]);
    if (!s) return http.send(res, 404, { error: "녹음을 찾을 수 없어요", requestId });
    if (typeof body.text !== "string") return http.send(res, 400, { error: "text가 필요해요" });
    s.aiNote = body.text.slice(0, 500000);
    await store.withLock(params[0], () => writeTextAtomic(path.join(store.sdir(params[0]), "ai-note.md"), s.aiNote));
    if (s.meta.aiNoteInfo) {
      s.meta.aiNoteInfo.edited = true;
      await store.saveMeta(s);
    }
    return http.send(res, 200, { ok: true });
  }
  async function generate({ res, params, body, requestId }) {
    const id = params[0],
      s = store.get(id);
    if (!s) return http.send(res, 404, { error: "녹음을 찾을 수 없어요", requestId });
    const tpl = TEMPLATES[body.template] || TEMPLATES.lecture,
      model = String(body.model || cfg.noteModel);
    if (!exporter.transcriptLines(s).length && !notes.notesBody(s))
      return http.send(res, 400, { error: "정리할 대본이나 필기가 아직 없어요" });
    const token = crypto.randomUUID();
    generations.set(id, token);
    const write = sse.stream(res);
    let gone = false;
    res.once("close", () => {
      gone = true;
    });
    const extra = String(body.extra || "")
        .trim()
        .slice(0, 2000),
      source = body.source === "raw" ? "raw" : "refined";
    const messages = [
      { role: "system", content: systemPrompt(body.template || "lecture") },
      { role: "user", content: `${sourceBlock(s, source)}${extra ? `\n\n[추가 요청]\n${extra}` : ""}` },
    ];
    write({ type: "start", model, template: tpl.label });
    const job = (async () => {
      try {
        const text = await streamChat({
          model,
          messages,
          onDelta: (d) => {
            if (!gone) write({ type: "delta", text: d });
          },
          requestId,
        });
        if (generations.get(id) === token && store.get(id)) {
          s.aiNote = text;
          s.meta.aiNoteInfo = {
            model,
            template: body.template || "lecture",
            templateLabel: tpl.label,
            generatedAt: new Date().toISOString(),
            edited: false,
            source: source === "raw" || !exporter.hasRefined(s) ? "raw" : "refined",
            customPrompt: prompts.get().base.note !== DEFAULT_PROMPTS.note,
          };
          await store.withLock(id, async () => {
            await writeTextAtomic(path.join(store.sdir(id), "ai-note.md"), text);
            await store.saveMeta(s);
          });
        }
        if (!gone) write({ type: "done", info: s.meta.aiNoteInfo });
      } catch {
        if (!gone) write({ type: "error", message: "노트를 만들지 못했어요", requestId });
      } finally {
        res.end();
      }
    })();
    return track(job);
  }
  async function ask({ res, params, body, requestId }) {
    const s = store.get(params[0]);
    if (!s) return http.send(res, 404, { error: "녹음을 찾을 수 없어요", requestId });
    const q = String(body.question || "")
      .trim()
      .slice(0, 2000);
    if (!q) return http.send(res, 400, { error: "질문을 입력해주세요" });
    const model = String(body.model || cfg.noteModel),
      write = sse.stream(res);
    let gone = false;
    res.once("close", () => {
      gone = true;
    });
    const history = Array.isArray(body.history)
      ? body.history
          .slice(-6)
          .filter((h) => h && ["user", "assistant"].includes(h.role) && typeof h.content === "string")
          .map((h) => ({ role: h.role, content: h.content.slice(0, 6000) }))
      : [];
    const messages = [
      {
        role: "system",
        content: `${SYSTEM_BASE}\n\n아래 녹음 자료만 근거로 질문에 짧고 정확하게 답한다. 근거 위치를 [mm:ss]로 붙인다. \
자료에 없으면 "녹음에서 찾지 못했어요"라고 말한 뒤, 필요하면 일반 지식임을 밝히고 짧게 보충한다.\n\n${sourceBlock(s)}`,
      },
      ...history,
      { role: "user", content: q },
    ];
    const job = (async () => {
      try {
        await streamChat({
          model,
          messages,
          onDelta: (d) => {
            if (!gone) write({ type: "delta", text: d });
          },
          requestId,
        });
        if (!gone) write({ type: "done" });
      } catch {
        if (!gone) write({ type: "error", message: "답을 받지 못했어요", requestId });
      } finally {
        res.end();
      }
    })();
    return track(job);
  }
  return {
    chatOnce,
    streamChat,
    stop() {
      stopped = true;
      for (const c of controllers) c.abort();
    },
    drain: () => Promise.allSettled([...inFlight]),
    handlers: { models, generate, ask, putAiNote },
  };
}
