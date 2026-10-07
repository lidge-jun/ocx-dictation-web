// 베이스 프롬프트 settings: three prompt layers, per-course profiles, and the global refine default.
import { $, $$, api, esc, toast } from "./util.js";

const LAYERS = [
  [
    "transcribe",
    "받아쓰기",
    "30초 구간마다 받아쓰기 모델에 함께 보내요. 앞 구간의 끝부분과 과목 정보가 자동으로 붙어요.",
  ],
  ["refine", "정제", "정제를 켠 녹음에서만 쓰여요. 원문은 그대로 두고 정제본을 따로 만들어요."],
  ["note", "강의노트", "강의노트를 만들 때 시스템 프롬프트로 써요. 회의록, 자유 요약 양식에는 쓰이지 않아요."],
];
export const INTERVAL_LABEL = { 60: "1분마다", 180: "3분마다", 300: "5분마다", end: "끝나고 한 번에" };

let data = null;
export async function loadPrompts(force = false) {
  if (!data || force) data = await api("/api/prompts");
  return data;
}

export function openSettings({ tab = "base", course = "" } = {}) {
  let dlg = $("#settingsDlg");
  if (!dlg) {
    document.body.insertAdjacentHTML(
      "beforeend",
      `
    <dialog id="settingsDlg" class="wide" aria-labelledby="setTitle">
      <div class="dlg set">
        <div class="set-head"><h2 id="setTitle">베이스 프롬프트</h2><button class="btn ghost \
small" type="button" id="setClose">닫기</button></div>
        <div class="tabs set-tabs" role="tablist" aria-label="설정">
          <button role="tab" type="button" data-st="base" aria-selected="true">공통 프롬프트</button>
          <button role="tab" type="button" data-st="course" aria-selected="false">과목별</button>
          <button role="tab" type="button" data-st="refine" aria-selected="false">정제 기본값</button>
        </div>
        <div id="setBody" class="set-body"></div>
        <p class="set-foot muted small" id="setFoot" role="status" aria-live="polite"></p>
      </div>
    </dialog>`,
    );
    dlg = $("#settingsDlg");
    $("#setClose").addEventListener("click", () => dlg.close());
    dlg.addEventListener("click", (e) => {
      if (e.target === dlg) dlg.close();
    });
    $(".set-tabs", dlg).addEventListener("click", (e) => {
      const b = e.target.closest("[data-st]");
      if (b) render(b.dataset.st);
    });
  }
  let courseSel = course;
  const foot = $("#setFoot");
  const saved = (msg = "저장했어요") => {
    const time = new Date().toLocaleTimeString("ko-KR", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    foot.textContent = `${msg} ${time}`;
  };

  async function render(which) {
    $$(".set-tabs [role=tab]", dlg).forEach((b) => b.setAttribute("aria-selected", String(b.dataset.st === which)));
    const d = await loadPrompts(true);
    const body = $("#setBody");
    foot.textContent = "";
    if (which === "base") {
      body.innerHTML = LAYERS.map(
        ([k, label, help]) => `
        <section class="layer">
          <div class="layer-head"><h3>${label}</h3>${d.base[k] !== d.defaults[k] ? `<span \
class="badge">수정됨</span>` : `<span class="muted small">기본값</span>`}<span class="spacer"></\
span><button class="btn ghost small" type="button" data-reset="${k}"\
${d.base[k] === d.defaults[k] ? " disabled" : ""}>기본값으로</button></div>
          <p class="muted small">${help}</p>
          <textarea data-layer="${k}" rows="${k === "transcribe" ? 3 : 8}" spellcheck="false"\
>${esc(d.base[k])}</textarea>
        </section>`,
      ).join("");
      body.querySelectorAll("textarea[data-layer]").forEach((ta) => {
        let t = null;
        ta.addEventListener("input", () => {
          clearTimeout(t);
          foot.textContent = "저장 중";
          t = setTimeout(async () => {
            await api("/api/prompts", { method: "PUT", json: { base: { [ta.dataset.layer]: ta.value } } });
            saved();
          }, 600);
        });
      });
      body.querySelectorAll("[data-reset]").forEach((b) =>
        b.addEventListener("click", async () => {
          await api("/api/prompts", {
            method: "PUT",
            json: { base: { [b.dataset.reset]: d.defaults[b.dataset.reset] } },
          });
          saved("기본값으로 되돌렸어요");
          render("base");
        }),
      );
    }
    if (which === "course") {
      const codes = [...new Set([...d.presets, ...Object.keys(d.courses)])];
      if (!courseSel || !codes.includes(courseSel)) courseSel = courseSel && courseSel.trim() ? courseSel : codes[0];
      if (!codes.includes(courseSel)) codes.push(courseSel);
      const c = d.courses[courseSel] || { name: "", professor: "", topics: "", glossary: "" };
      body.innerHTML = `
        <div class="course-pick" role="group" aria-label="과목"\
>${codes.map((x) => `<button type="button" class="chip${x === courseSel ? " on" : ""}" \
aria-pressed="${x === courseSel}" data-c="${esc(x)}">${esc(x)}</button>`).join("")}
          <input id="newCourse" class="chip-input" placeholder="과목 추가" maxlength="40" aria-label="과목 코드 추가"></div>
        <div class="grid2">
          <label class="field"><span>과목 이름</span><input data-f="name" \
value="${esc(c.name)}" maxlength="120" placeholder="예: 국제무역론"></label>
        <label class="field"><span>교수</span><input data-f="professor" \
value="${esc(c.professor)}" maxlength="60" placeholder="예: Prof. Example"></label>
        </div>
        <label class="field"><span>주제·키워드</span><textarea data-f="topics" rows="3" \
placeholder="이번 학기에 다루는 모형, 이론, 인물">${esc(c.topics)}</textarea></label>
        <label class="field"><span>용어집</span><textarea data-f="glossary" rows="3" \
placeholder="쉼표로 구분. 예: 헥셔-올린, 레온티에프, 립진스키">${esc(c.glossary)}</textarea></label>
        <p class="muted small">받아쓰기, 정제, 강의노트 세 곳 모두에 과목 정보로 붙어요. 용어집은 녹음 화면의 용어집과 같은 값이에요.</p>`;
      body.querySelector(".course-pick").addEventListener("click", (e) => {
        const b = e.target.closest("[data-c]");
        if (b) {
          courseSel = b.dataset.c;
          render("course");
        }
      });
      $("#newCourse").addEventListener("keydown", (e) => {
        if (e.key === "Enter" && e.target.value.trim()) {
          e.preventDefault();
          courseSel = e.target.value.trim().toUpperCase();
          render("course");
        }
      });
      let t = null;
      const push = () => {
        clearTimeout(t);
        foot.textContent = "저장 중";
        t = setTimeout(async () => {
          const o = {};
          body.querySelectorAll("[data-f]").forEach((el) => {
            o[el.dataset.f] = el.value;
          });
          await api("/api/prompts", { method: "PUT", json: { courses: { [courseSel]: o } } });
          saved(`${courseSel} 저장했어요`);
        }, 600);
      };
      body.querySelectorAll("[data-f]").forEach((el) => el.addEventListener("input", push));
    }
    if (which === "refine") {
      const r = d.refineDefaults;
      body.innerHTML = `
        <label class="switch"><input type="checkbox" id="refDef\
"${r.enabled ? " checked" : ""}> <span>새 녹음에서 정제를 기본으로 켜기</span></label>
        <label class="field narrow"><span>정제 간격</span><select \
id="refInt">${d.intervals.map((v) => `<option value="${v}"\
${String(v) === String(r.interval) ? " selected" : ""}>${INTERVAL_LABEL[v]}</option>`).join("")}</select></label>
        <div class="explain muted small">
          <p>받아쓰기는 지금처럼 30초마다 올라오고, 정제는 그 위에서 따로 돌아요. 간격을 5분으로 두면 5분 분량(구간 10개)이 모두 받아써진 \
뒤 한 번에 다듬어요. 짧을수록 빨리 보이지만 문맥이 짧아지고 호출이 늘어요.</p>
          <p>모델은 ${esc(d.refineModel)} (추론 낮음)이에요. 원문은 지우지 않고, 결과가 구간 수나 길이 검사를 통과하지 못하면 그 구간은 원문을 그대로 써요.</p>
        </div>`;
      const put = async () => {
        await api("/api/prompts", {
          method: "PUT",
          json: {
            refineDefaults: {
              enabled: $("#refDef").checked,
              interval: $("#refInt").value === "end" ? "end" : Number($("#refInt").value),
            },
          },
        });
        saved();
      };
      $("#refDef").addEventListener("change", put);
      $("#refInt").addEventListener("change", put);
    }
  }
  render(tab);
  if (!dlg.open) dlg.showModal();
}
