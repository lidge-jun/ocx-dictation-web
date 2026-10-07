// Base prompts (3 layers) + per-course profiles, stored in data/prompts.json.
import fs from "node:fs";
import path from "node:path";
import { COURSE_RE } from "./util.mjs";

export const PROMPT_LAYERS = ["transcribe", "refine", "note"];

export const DEFAULT_PROMPTS = {
  transcribe: "대학 강의 녹음입니다. 한국어로 말하고 전문 용어는 영어를 섞어 씁니다. 문장 부호를 넣어 받아써 주세요.",
  refine: `너는 음성 인식(ASR) 대본을 교정하는 편집자다. 받은 대본을 읽기 좋게 다듬되 말한 내용은 그대로 둔다.

할 일:
- 잘못 들린 단어를 문맥과 과목 정보, 용어집에 맞춰 바로잡는다. (예: 핵사-올린 -> 헥셔-올린, 레온 티에프 -> 레온티에프)
- 띄어쓰기, 문장 부호, 문장 경계를 고친다.
- "음", "어", "그러니까 그" 같은 군말은 뜻을 해치지 않는 선에서만 가볍게 줄인다.

하지 말 것:
- 요약, 생략, 순서 바꾸기, 설명 덧붙이기, 존댓말/반말 바꾸기.
- 확실하지 않은 단어를 추측으로 바꾸기. 애매하면 원문 그대로 둔다.
- 원문에 없는 단어를 채워 넣기. 잘못 들린 말을 소리가 비슷한 올바른 말로 바꾸는 것만 허용한다.
- 용어집에 있는 표기를 다른 표기로 바꾸기. 용어집에 있으면 그 표기를 그대로 쓴다.
- 구간 사이로 문장을 옮기기. 각 구간의 글은 그 구간 안에서만 고친다.`,
  note: `너는 한국어 노트 정리 도우미다. 출력은 마크다운만 쓴다. 이모지를 쓰지 않는다.
규칙:
- 대본은 자동 음성 인식 결과라 오탈자와 잘못 들린 단어가 있다. 문맥과 과목 정보, 용어집으로 바로잡되, 대본에 없는 내용을 지어내지 않는다.
- 사용자 메모와 "(중요)" 표시는 사용자가 직접 남긴 신호다. 해당 시각 주변 대본을 우선해서 반영한다.
- 근거가 되는 대본 위치는 [mm:ss] 형식으로 붙인다.
- 전문 용어는 한국어(영어) 형태로 처음 한 번 병기한다.

대학 강의 녹음 대본으로 복습용 강의 노트를 만든다. 다음 섹션을 순서대로 쓴다.
## 오늘 한 줄
## 핵심 개념
## 정의·공식 (수식은 \\( \\) LaTeX로)
## 예시·사례
## 교수가 강조한 것 / 시험 힌트 (교수가 "시험", "퀴즈", "중요", "꼭" 등으로 강조한 부분을 [mm:ss]와 함께 거의 그대로 인용)
## 질문거리 (이해가 덜 된 부분, 다음 수업 전에 확인할 것)
해당 내용이 없으면 그 섹션은 "대본에서 확인되지 않음"이라고 쓴다.`,
};

export const REFINE_INTERVALS = [60, 180, 300, "end"];
export const DEFAULT_REFINE = { enabled: false, interval: 300 };
const COURSE_FIELDS = ["name", "professor", "topics", "glossary"];
const LIMITS = { name: 120, professor: 60, topics: 2000, glossary: 4000 };

export function createPromptStore({
  file,
  legacyCoursesFile,
  getSessions = () => [],
  saveMeta = async () => {},
  sessionContext = () => "",
  http,
  cfg,
  log,
}) {
  let cache = null;
  function read() {
    if (cache) return cache;
    let data = {};
    try {
      data = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {}
    const base = {};
    for (const k of PROMPT_LAYERS) base[k] = typeof data.base?.[k] === "string" ? data.base[k] : DEFAULT_PROMPTS[k];
    const courses = {};
    for (const [code, c] of Object.entries(data.courses || {})) {
      if (!COURSE_RE.test(code)) {
        log?.warn("prompts", "invalid_persisted_course");
        continue;
      }
      courses[code] = normCourse(c);
    }
    // migrate glossaries saved by earlier versions (data/courses.json)
    try {
      const legacy = JSON.parse(fs.readFileSync(legacyCoursesFile, "utf8"));
      for (const [code, c] of Object.entries(legacy || {})) {
        if (!COURSE_RE.test(code)) {
          log?.warn("prompts", "invalid_persisted_course");
          continue;
        }
        if (c?.glossary && !courses[code]?.glossary)
          courses[code] = {
            ...normCourse(courses[code] || {}),
            glossary: String(c.glossary).slice(0, LIMITS.glossary),
          };
      }
    } catch {}
    const refineDefaults = normRefine(data.refineDefaults || {});
    cache = { base, courses, refineDefaults };
    return cache;
  }
  function write(next) {
    cache = next;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
    fs.renameSync(tmp, file);
  }
  const api = {
    get: read,
    course(code) {
      if (!code) return normCourse({});
      return normCourse(read().courses[code] || {});
    },
    update(patch) {
      const cur = read();
      const next = { base: { ...cur.base }, courses: { ...cur.courses }, refineDefaults: { ...cur.refineDefaults } };
      if (patch.base)
        for (const k of PROMPT_LAYERS)
          if (typeof patch.base[k] === "string") next.base[k] = patch.base[k].slice(0, 12000);
      if (patch.courses)
        for (const [code, c] of Object.entries(patch.courses)) {
          if (!COURSE_RE.test(code)) throw Object.assign(new Error("Invalid course code"), { status: 400 });
          const key = code;
          if (c === null) {
            delete next.courses[key];
            continue;
          }
          next.courses[key] = normCourse({ ...(next.courses[key] || {}), ...c });
        }
      if (patch.refineDefaults) next.refineDefaults = normRefine({ ...next.refineDefaults, ...patch.refineDefaults });
      write(next);
      return next;
    },
    setGlossary(code, glossary) {
      if (!code) return;
      this.update({ courses: { [code]: { glossary } } });
    },
  };
  function applied(s) {
    const b = api.get().base,
      context = sessionContext(s);
    return {
      context,
      transcribe: {
        base: b.transcribe,
        custom: b.transcribe !== DEFAULT_PROMPTS.transcribe,
        sample: buildTranscribePrompt({ base: b.transcribe, context, prevTail: "" }),
      },
      refine: {
        base: b.refine,
        custom: b.refine !== DEFAULT_PROMPTS.refine,
        enabled: Boolean(s.meta.refine?.enabled),
        model: cfg.refineModel,
      },
      note: { base: b.note, custom: b.note !== DEFAULT_PROMPTS.note },
    };
  }
  api.handlers = {
    courses({ res }) {
      const stored = api.get().courses,
        used = new Set([...getSessions()].map((s) => s.meta.course).filter(Boolean));
      const all = [...new Set([...(cfg.courses || []), ...Object.keys(stored), ...used])];
      return http.send(res, 200, {
        courses: all.map((c) => ({ code: c, wiki: false, glossary: api.course(c).glossary, profile: api.course(c) })),
      });
    },
    getPrompts({ res }) {
      const cur = api.get();
      return http.send(res, 200, {
        base: cur.base,
        defaults: DEFAULT_PROMPTS,
        courses: cur.courses,
        refineDefaults: cur.refineDefaults,
        intervals: REFINE_INTERVALS,
        refineModel: cfg.refineModel,
        presets: cfg.courses,
      });
    },
    async putPrompts({ res, body }) {
      const next = api.update(body);
      if (body.courses)
        for (const [code, c] of Object.entries(body.courses))
          if (c && typeof c.glossary === "string")
            for (const s of getSessions())
              if (s.meta.course === code && ["recording", "paused"].includes(s.meta.state)) {
                s.meta.glossary = c.glossary;
                await saveMeta(s);
              }
      return http.send(res, 200, { base: next.base, courses: next.courses, refineDefaults: next.refineDefaults });
    },
    appliedPrompts({ res, params, requestId }) {
      const s = [...getSessions()].find((x) => x.meta.id === params[0]);
      return s ? http.send(res, 200, applied(s)) : http.send(res, 404, { error: "녹음을 찾을 수 없어요", requestId });
    },
  };
  return api;
}

export function normCourse(c) {
  const o = {};
  for (const f of COURSE_FIELDS) o[f] = typeof c?.[f] === "string" ? c[f].slice(0, LIMITS[f]) : "";
  return o;
}
export function normRefine(r) {
  const interval = REFINE_INTERVALS.includes(r.interval)
    ? r.interval
    : REFINE_INTERVALS.includes(Number(r.interval))
      ? Number(r.interval)
      : DEFAULT_REFINE.interval;
  return { enabled: Boolean(r.enabled), interval };
}

// Course context block shared by the three layers.
export function courseContext(code, profile, sessionGlossary) {
  const lines = [];
  if (code || profile.name) lines.push(`과목: ${[code, profile.name].filter(Boolean).join(" ")}`);
  if (profile.professor) lines.push(`교수: ${profile.professor}`);
  if (profile.topics) lines.push(`주제/키워드: ${profile.topics}`);
  const gl = [sessionGlossary, profile.glossary].map((x) => (x || "").trim()).filter(Boolean);
  const merged = [
    ...new Set(
      gl
        .join(", ")
        .split(/[,\n、]+/)
        .map((t) => t.trim())
        .filter(Boolean),
    ),
  ].join(", ");
  if (merged) lines.push(`용어집: ${merged}`);
  return lines.join("\n");
}

// ASR prompt: base + course context, then the previous segment's tail (continuity).
// gpt-4o-transcribe caps prompt at 16 KiB; keep well under by character budget and a byte check.
export function buildTranscribePrompt({ base, context, prevTail }) {
  let head = [base, context]
    .map((x) => (x || "").trim())
    .filter(Boolean)
    .join("\n");
  if (head.length > 3000) head = head.slice(0, 3000);
  const tail = (prevTail || "").slice(-400);
  let out = [head, tail].filter(Boolean).join("\n").trim();
  while (Buffer.byteLength(out, "utf8") > 15000) out = out.slice(0, Math.floor(out.length * 0.9));
  return out;
}
