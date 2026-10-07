// Router, library sidebar, new-session screen, upload dialog, crash recovery.
import { $, $$, api, esc, fmtDay, fmtDuration, toast, on, emit, confirmDialog } from "./util.js";
import { mountSession, unmountSession } from "./session.js";
import { live, recoverInterrupted, discardOrphan, tabSync,
  recorderSupported, recorderLockFree, recorderOwner } from "./live.js";
import { kick } from "./uploader.js";
import { openSettings, loadPrompts, INTERVAL_LABEL } from "./settings.js";

const params = new URLSearchParams(location.search);
const FAKE = params.get("fake") === "1";
const state = { sessions: [], courses: [], filter: localStorage.getItem("lns.filter") || "", q: "" };

// ---------- library ----------
async function loadLibrary() {
  const qs = state.q ? `?q=${encodeURIComponent(state.q)}` : "";
  try {
    const r = await api(`/api/sessions${qs}`);
    state.sessions = r.sessions;
    renderLibrary();
  } catch {
    $("#library").innerHTML = `<p class="muted small pad">목록을 불러오지 못했어요</p>`;
  }
}
function currentId() {
  const m = location.hash.match(/^#\/s\/([^/?]+)/);
  return m ? m[1] : null;
}
function renderLibrary() {
  const cur = currentId();
  const list = state.sessions.filter((s) => !state.filter || (s.course || "") === state.filter);
  const el = $("#library");
  if (!list.length) {
    el.innerHTML = `<p class="muted small pad">\
${state.q ? "검색 결과가 없어요" : state.filter ? "이 과목의 녹음이 아직 없어요" : "녹음이 아직 없어요"}</p>`;
    return;
  }
  let lastDay = "";
  el.innerHTML = list
    .map((s) => {
      const day = fmtDay(s.createdAt);
      const head = day !== lastDay ? `<h2 class="day">${day}</h2>` : "";
      lastDay = day;
      const owner = recorderOwner();
      const live1 = (live.sid === s.id && live.state !== "idle") || owner?.sessionId === s.id;
      const busy = s.stats.pending > 0 && !live1;
      const badge = live1
        ? `<span class="badge rec">녹음 중</span>`
        : busy
          ? `<span class="badge">받아쓰는 중</span>`
          : s.stats.error
            ? `<span class="badge err">실패 ${s.stats.error}</span>`
            : "";
      return `${head}<a class="lib-item${s.id === cur ? " active" : ""}" href="#/s/\
${s.id}" ${s.id === cur ? 'aria-current="page"' : ""}>
      <span class="lib-title">${esc(s.title)}</span>
      <span class="lib-meta">${s.course ? `<span class="tag"\
>${esc(s.course)}</span>` : ""}<span>${fmtDuration(s.duration)}</span>${s.hasAiNote ? `<span>\
강의노트</span>` : ""}${badge}</span>
      ${s.hit ? `<span class="lib-hit"><span class="muted">${s.hit.where}</span> ${esc(s.hit.snippet)}</span>` : ""}
    </a>`;
    })
    .join("");
}
function renderFilter() {
  const used = new Set(state.sessions.map((s) => s.course).filter(Boolean));
  const codes = [...new Set([...state.courses.map((c) => c.code), ...used])].filter((c) => used.has(c));
  const el = $("#courseFilter");
  if (!codes.length) {
    el.innerHTML = "";
    return;
  }
  el.innerHTML = [["", "전체"], ...codes.map((c) => [c, c])]
    .map(
      ([v, l]) =>
        `<button type="button" class="chip${state.filter === v ? " on" : ""}" aria-pressed\
="${state.filter === v}" data-f="${esc(v)}">${esc(l)}</button>`,
    )
    .join("");
}
$("#settingsBtn").addEventListener("click", () =>
  openSettings({
    course: document.querySelector("#sCourse")?.value.trim() || localStorage.getItem("lns.lastCourse") || "",
  }),
);
$("#courseFilter").addEventListener("click", (e) => {
  const b = e.target.closest("[data-f]");
  if (!b) return;
  state.filter = b.dataset.f;
  localStorage.setItem("lns.filter", state.filter);
  renderFilter();
  renderLibrary();
});
let qTimer = null;
$("#searchInput").addEventListener("input", (e) => {
  clearTimeout(qTimer);
  qTimer = setTimeout(() => {
    state.q = e.target.value.trim();
    loadLibrary();
  }, 250);
});
let libTimer = null;
on("library-changed", () => {
  clearTimeout(libTimer);
  libTimer = setTimeout(async () => {
    await loadLibrary();
    renderFilter();
  }, 300);
});
on("live-state", () => { renderLibrary(); updateNewRecordingGuard(); });
tabSync?.onChange(() => { renderLibrary(); updateNewRecordingGuard(); });

function updateNewRecordingGuard() {
  const form = $("#newForm");
  if (!form) return;
  const owner = recorderOwner();
  const busySession = owner?.sessionId || (live.state !== "idle" ? live.sid : null);
  const start = form.querySelector('[type="submit"]');
  start.disabled = !recorderSupported() || Boolean(busySession);
  const notice = form.querySelector("#newRecNotice");
  notice.innerHTML = busySession
    ? `다른 녹음이 진행 중이에요. <a href="#/s/${encodeURIComponent(busySession)}">녹음 중인 노트 열기</a>`
    : !recorderSupported() ? "탭 간 녹음 보호를 사용할 수 없어 녹음을 시작할 수 없어요." : "";
  notice.hidden = !notice.textContent;
}

async function loadCourses() {
  try {
    state.courses = (await api("/api/courses")).courses;
  } catch {
    state.courses = [];
  }
  $("#courseList").innerHTML = state.courses.map((c) => `<option value="${esc(c.code)}">`).join("");
}

// ---------- new session screen ----------
function renderNew(root) {
  unmountSession();
  const lastCourse = localStorage.getItem("lns.lastCourse") || "";
  const now = new Date();
  const guess = guessCourse(now);
  const course = guess || lastCourse;
  root.innerHTML = `
  <div class="new-wrap">
    <form class="new-form" id="newForm">
      <h1>새 녹음</h1>
      <p class="muted lead">녹음하는 동안 30초마다 대본이 쌓이고, 오른쪽에 내 메모를 남길 수 있어요. 끝나면 대본과 메모를 합쳐 강의노트로 정리해요.</p>
      <div class="course-pick" role="group" aria-label="과목">
        ${state.courses.map((c) => `<button type="button" class="chip\
${c.code === course ? " on" : ""}" data-course="${esc(c.code)}" aria-pressed="\
${c.code === course}">${esc(c.code)}</button>`).join("")}
        <button type="button" class="chip${course ? "" : " on"}" data-course="" aria-pressed="${!course}">과목 없음</button>
      </div>
      <label class="field"><span>제목</span><input id="nTitle" type="text" maxlength="120" \
placeholder="${esc(defaultTitle(course, now))}" autocomplete="off"></label>
        <label class="field"><span>과목 직접 입력</span><input id="nCourse" type="text" \
list="courseList" value="${esc(course)}" maxlength="40" placeholder="예: BIO101, 팀 회의" autocomplete="off"></label>
      <details class="field-details"><summary>용어집</summary>
        <textarea id="nGlossary" rows="3" placeholder="수업에 자주 나오는 고유명사나 전문 용어를 적어두면 받아쓰기가 더 정확해져요"></textarea>
      </details>
      <div class="refine-new">
        <label class="switch"><input type="checkbox" id="nRefine"> <span>정제 켜기</span></label>
        <label class="compact slim"><span class="sr-only">정제 간격</span><select id="nRefInt">${Object.entries(
          INTERVAL_LABEL,
        )
          .map(([v, l]) => `<option value="${v}">${l}</option>`)
          .join("")}</select></label>
        <span class="muted small">받아쓴 대본을 설정된 모델로 한 번 더 다듬어요. 원문은 그대로 남아요.</span>
      </div>
      <div class="new-actions">
        <button class="rec-btn big" type="submit"><span class="rec-dot" aria-hidden="true"></span>녹음 시작</button>
        ${FAKE ? `<span class="badge">테스트 오디오 모드</span>` : ""}
      </div>
      <p class="rec-notice" id="newRecNotice" role="status" hidden></p>
      <p class="muted small">녹음은 이 컴퓨터에만 저장돼요. 받아쓰기와 노트 정리는 로컬 OpenCodex를 거쳐요.</p>
    </form>
  </div>`;
  const courseIn = $("#nCourse", root),
    gl = $("#nGlossary", root),
    title = $("#nTitle", root);
  loadPrompts()
    .then((d) => {
      $("#nRefine", root).checked = d.refineDefaults.enabled;
      $("#nRefInt", root).value = String(d.refineDefaults.interval);
      $("#nRefInt", root).disabled = !d.refineDefaults.enabled;
    })
    .catch(() => {});
  $("#nRefine", root).addEventListener("change", (e) => {
    $("#nRefInt", root).disabled = !e.target.checked;
  });
  const syncGlossary = () => {
    const c = state.courses.find((x) => x.code === courseIn.value.trim());
    gl.value = c?.glossary || "";
    title.placeholder = defaultTitle(courseIn.value.trim(), new Date());
  };
  syncGlossary();
  updateNewRecordingGuard();
  root.querySelector(".course-pick").addEventListener("click", (e) => {
    const b = e.target.closest("[data-course]");
    if (!b) return;
    courseIn.value = b.dataset.course;
    $$(".course-pick .chip", root).forEach((x) => {
      const on = x === b;
      x.classList.toggle("on", on);
      x.setAttribute("aria-pressed", String(on));
    });
    syncGlossary();
  });
  courseIn.addEventListener("input", () => {
    $$(".course-pick .chip", root).forEach((x) => {
      const on = x.dataset.course === courseIn.value.trim();
      x.classList.toggle("on", on);
      x.setAttribute("aria-pressed", String(on));
    });
    syncGlossary();
  });
  $("#newForm", root).addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!recorderSupported()) {
      toast("이 브라우저에서는 탭 간 녹음 보호를 사용할 수 없어 녹음을 시작할 수 없어요.", { error: true });
      return;
    }
    const owner = recorderOwner();
    if (live.state !== "idle" || owner || !(await recorderLockFree())) {
      toast(owner ? "다른 탭에서 녹음 중이에요. 녹음 중인 노트를 열어주세요." : "다른 탭에서 녹음 중이에요.",
        { error: true });
      return;
    }
    const c = courseIn.value.trim();
    localStorage.setItem("lns.lastCourse", c);
    try {
      const iv = $("#nRefInt", root).value;
      const s = await api("/api/sessions", {
        method: "POST",
        json: {
          title: title.value.trim() || title.placeholder,
          course: c,
          glossary: gl.value,
          refine: { enabled: $("#nRefine", root).checked, interval: iv === "end" ? "end" : Number(iv) },
        },
      });
      emit("library-changed");
      pendingAutostart = s.id;
      location.hash = `#/s/${s.id}`;
    } catch (err) {
      toast(err.message, { error: true });
    }
  });
}
function defaultTitle(course, d) {
  return `${d.getMonth() + 1}월 ${d.getDate()}일 ${course || "녹음"}`;
}
// Best-effort course guess from the saved weekly timetable.
// localStorage 'lns.timetable': [{day:2, start:"09:00", end:"10:15", code:"BIO101"}].
function guessCourse(now) {
  try {
    const tt = JSON.parse(localStorage.getItem("lns.timetable") || "[]");
    const hm = now.getHours() * 60 + now.getMinutes();
    const toM = (s) => {
      const [h, m] = s.split(":").map(Number);
      return h * 60 + m;
    };
    const hit = tt.find((x) => x.day === now.getDay() && hm >= toM(x.start) - 15 && hm <= toM(x.end));
    return hit?.code || "";
  } catch {
    return "";
  }
}

// ---------- upload ----------
const upDlg = $("#uploadDlg");
$("#uploadBtn").addEventListener("click", () => {
  $("#upErr").hidden = true;
  $("#upProgress").hidden = true;
  $("#upSubmit").disabled = false;
  $("#upCourse").value = localStorage.getItem("lns.lastCourse") || "";
  upDlg.showModal();
});
let upXhr = null;
$("#upCancel").addEventListener("click", () => {
  upXhr?.abort();
  upDlg.close();
});
$("#uploadForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const f = $("#upFile").files[0];
  if (!f) return;
  const qs = new URLSearchParams({
    filename: f.name,
    title: $("#upTitle").value.trim() || f.name.replace(/\.[^.]+$/, ""),
    course: $("#upCourse").value.trim(),
  });
  const c = state.courses.find((x) => x.code === $("#upCourse").value.trim());
  if (c?.glossary) qs.set("glossary", c.glossary);
  const xhr = new XMLHttpRequest();
  upXhr = xhr;
  xhr.open("POST", `/api/upload?${qs}`);
  $("#upProgress").hidden = false;
  $("#upSubmit").disabled = true;
  $("#upErr").hidden = true;
  xhr.upload.onprogress = (ev) => {
    if (ev.lengthComputable) {
      const p = Math.round((ev.loaded / ev.total) * 100);
      $("#upBar").style.transform = `scaleX(${p / 100})`;
      $("#upPct").textContent = `${p}%`;
    }
  };
  xhr.onload = () => {
    upXhr = null;
    let data = {};
    try {
      data = JSON.parse(xhr.responseText);
    } catch {}
    if (xhr.status >= 200 && xhr.status < 300) {
      upDlg.close();
      $("#upFile").value = "";
      $("#upTitle").value = "";
      emit("library-changed");
      location.hash = `#/s/${data.id}`;
      toast("올렸어요. 나눠서 받아쓰는 중이에요");
    } else {
      $("#upErr").textContent = data.error || "올리지 못했어요. 다시 시도해주세요.";
      $("#upErr").hidden = false;
      $("#upSubmit").disabled = false;
    }
  };
  xhr.onerror = () => {
    upXhr = null;
    $("#upErr").textContent = "서버에 연결하지 못했어요. 서버가 켜져 있는지 확인해주세요.";
    $("#upErr").hidden = false;
    $("#upSubmit").disabled = false;
  };
  xhr.send(f);
});

// ---------- health ----------
async function health() {
  const el = $("#healthLine");
  try {
    const h = await api("/api/health");
    el.innerHTML =
      h.ocx === "ok"
        ? `<span class="led ok" aria-hidden="true"></span>OpenCodex\
 ${esc(h.ocxVersion || "")} 연결됨${h.queue ? ` · 대기 ${h.queue}` : ""}`
        : `<span class="led bad" aria-hidden="true"></span>OpenCodex에 연결할 수 없어요. 녹음은 계속 저장돼요`;
    el.dataset.ok = h.ocx === "ok";
    if (!h.keyConfigured)
      el.innerHTML = `<span class="led bad" aria-hidden="true"></span>API 키가 없어요. ~/.ocx-dictation/config.json을 확인해주세요`;
  } catch {
    el.innerHTML = `<span class="led bad" aria-hidden="true"></span>앱 서버에 연결할 수 없어요. 녹음 구간은 이 브라우저에 쌓아둘게요`;
  }
}

// ---------- recovery ----------
const recoveryEntries = new Map();
const recoveryBar = $("#recoverBar");
function showRecovery(entries) {
  for (const entry of entries) recoveryEntries.set(entry.sid, entry);
  recoveryBar.innerHTML = [...recoveryEntries.values()].map((entry) => {
    const s = state.sessions.find((x) => x.id === entry.sid);
    const label = s ? `“${esc(s.title)}”` : `녹음 ${esc(entry.sid)}`;
    if (entry.orphan) return `<p role="alert">${label}의 서버 기록을 찾지 못했어요. 이 기기의 녹음 데이터는 보관 중이에요.</p>
      <button class="btn small ghost" type="button" data-discard="${esc(entry.sid)}">이 녹음 버리기</button>`;
    if (entry.needsAttention) return `<p role="alert">${label}의 일부 녹음 데이터를 확인해야 해요. 이 기기에 그대로 보관했어요.</p>`;
    return `<p>${label}의 마지막 구간을 복구해서 올리는 중이에요.</p>
      <a class="btn small primary" href="#/s/${encodeURIComponent(entry.sid)}">열기</a>`;
  }).join("") + '<button class="btn small ghost" type="button" id="recoverClose">닫기</button>';
  recoveryBar.hidden = recoveryEntries.size === 0;
}
async function recover() { showRecovery(await recoverInterrupted()); }
on("orphan-recording", ({ sid }) => showRecovery([{ sid, orphan: true }]));
recoveryBar.addEventListener("click", async (e) => {
  if (e.target.id === "recoverClose") { recoveryBar.hidden = true; return; }
  const sid = e.target.closest("[data-discard]")?.dataset.discard;
  if (!sid) return;
  if (!(await confirmDialog("이 녹음 버리기", "이 기기에 남은 녹음 데이터가 삭제돼요. 되돌릴 수 없어요.", "버리기"))) return;
  try { await discardOrphan(sid); recoveryEntries.delete(sid); showRecovery([]); }
  catch (err) { toast(err.message, { error: true }); }
});

// ---------- router ----------
let pendingAutostart = null;
async function route() {
  const root = $("#view");
  const id = currentId();
  document.body.dataset.view = id ? "session" : "new";
  if (id) {
    const autostart = pendingAutostart === id;
    pendingAutostart = null;
    await mountSession(root, id, { fake: FAKE, autostart });
    const s = state.sessions.find((x) => x.id === id);
    document.title = s ? `${s.title} · 강의 노트` : "강의 노트";
  } else {
    renderNew(root);
    document.title = "새 녹음 · 강의 노트";
  }
  renderLibrary();
  $("#main").focus({ preventScroll: true });
}
window.addEventListener("hashchange", route);

document.addEventListener("keydown", (e) => {
  if (e.key === "/" && !e.target.closest("input, textarea, select, [contenteditable]")) {
    e.preventDefault();
    $("#searchInput").focus();
  }
});

(async function boot() {
  await Promise.all([loadCourses(), loadLibrary()]);
  renderFilter();
  if (!location.hash) location.replace("#/new");
  await route();
  health();
  setInterval(health, 15000);
  recover();
  kick();
})();
