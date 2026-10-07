// Session screen: header, record bar, player, notes / AI / Q&A tabs, live transcript.
import { $, $$, api, esc, fmtTime, fmtDate, fmtDuration, toast, on, emit, confirmDialog, download } from "./util.js";
import { live, startRecording, pauseRecording, resumeRecording, stopRecording,
  tabSync, recorderOwner, recorderSupported, recorderLockFree, setOwnerMarkHandler } from "./live.js";
import { NotesEditor } from "./notes.js";
import { mountAiPanel, mountAskPanel } from "./ai.js";
import { listMics } from "./recorder.js";
import { counts } from "./uploader.js";
import { openVaultDialog } from "./vault.js";
import { diffHtml } from "./diff.js";
import { openSettings, INTERVAL_LABEL } from "./settings.js";
import { adoptDraft, listNoteStashes } from "./note-stashes.js";

const STATUS_TEXT = {
  pending: "받아쓰기 대기",
  transcribing: "받아쓰는 중",
  error: "받아쓰지 못했어요",
  silent: "소리 없음",
  uploading: "올리는 중",
};
// Wide screens: transcript | AI note tabs on the left, 내 메모 always on the right.
// Narrow screens: 내 메모 becomes a third tab.
const TABS = [
  ["transcript", "대본"],
  ["ai", "강의노트"],
  ["notes", "내 메모"],
];
const WIDE = window.matchMedia("(min-width: 1001px)");
const fallbackNotesTabId = crypto.randomUUID();
let current = null; // mounted view controller

export function unmountSession() {
  current?.destroy();
  current = null;
}

export async function mountSession(root, id, opts = {}) {
  unmountSession();
  let s;
  try {
    s = await api(`/api/sessions/${id}`);
  } catch (err) {
    root.innerHTML = `<div class="empty page"><p class="empty-title">녹음을 찾을 수 없어요</p><p \
class="muted">지워졌거나 주소가 잘못됐어요.</p><a class="btn" href="#/new">새 녹음</a></div>`;
    return;
  }
  const config = await api("/api/config").catch(() => ({ vaultEnabled: false }));
  const ctl = { destroyed: false, cleanups: [] };
  current = ctl;
  ctl.destroy = () => {
    ctl.destroyed = true;
    ctl.cleanups.forEach((f) => {
      try {
        f();
      } catch {}
    });
  };
  const segs = new Map(s.segments.map((g) => [g.index, g]));
  const localPending = new Map(); // index -> {start, duration}
  const player = $("#player");
  let tab = sessionStorage.getItem(`lns.tab.${id}`) || (s.aiNote ? "ai" : "transcript");
  if (!TABS.some(([k]) => k === tab)) tab = "transcript";
  if (tab === "notes" && WIDE.matches) tab = "transcript";

  root.innerHTML = `
  <div class="session" data-tab="${tab}">
    <header class="s-head">
      <h1 class="sr-only" id="sH1">${esc(s.title)}</h1>
      <div class="s-title-row">
        <label class="sr-only" for="sTitle">제목</label>
        <input id="sTitle" class="s-title" value="${esc(s.title)}" maxlength="120" autocomplete="off">
        <div class="s-actions">
          <div class="menu">
            <button class="btn ghost" type="button" id="exportBtn" aria-haspopup="menu" \
aria-expanded="false">내보내기</button>
            <div class="menu-list" role="menu" id="exportMenu" hidden>
              <button role="menuitem" type="button" data-fmt="md">마크다운 (.md)</button>
              <button role="menuitem" type="button" data-fmt="txt">대본만 (.txt)</button>
              <button role="menuitem" type="button" data-fmt="srt">자막 (.srt)</button>
              <button role="menuitem" type="button" data-fmt="copy">마크다운 복사</button>
              ${config.vaultEnabled ? `<hr class="menu-sep" aria-hidden="true">
              <button role="menuitem" type="button" data-fmt="vault">노트 폴더에 저장</button>` : ""}
            </div>
          </div>
          <button class="btn ghost danger-text" type="button" id="delBtn">삭제</button>
        </div>
      </div>
      <div class="s-sub">
        <label class="course-field"><span class="sr-only">과목</span><input id="sCourse" \
list="courseList" value="${esc(s.course || "")}" placeholder="과목 없음" maxlength="40" autocomplete="off"></label>
        <span class="dot-sep" aria-hidden="true"></span><span>${fmtDate(s.createdAt)}</span>
        <span class="dot-sep" aria-hidden="true"></span><span id="sDur">${fmtDuration(s.duration)}</span>
        <span class="dot-sep" aria-hidden="true"></span><span id="sState" class="state-text"></span>
        <span class="dot-sep" aria-hidden="true"></span>
        <span class="refine-ctl" id="refineCtl">
          <label class="switch small"><input type="checkbox" \
id="refOn"${s.meta.refine?.enabled ? " checked" : ""}> <span>정제</span></label>
          <label class="compact slim"><span class="sr-only">정제 간격</span><select id="refInt">${Object.entries(
            INTERVAL_LABEL,
          )
            .map(
              ([v, l]) =>
                `<option value="${v}"${String(s.meta.refine?.interval ?? 300) === v ? " selected" : ""}>${l}</option>`,
            )
            .join("")}</select></label>
        </span>
        <details class="glossary"><summary>용어집${s.meta.glossary ? " 있음" : ""}</summary>
          <textarea id="sGlossary" rows="3" placeholder="예: 리카도, 비교우위, 레온티에프, 헥셔-올린. \
받아쓰기가 이 단어들을 더 잘 알아들어요">${esc(s.meta.glossary || "")}</textarea>
          <p class="muted small">과목별로 저장돼서 다음 녹음에도 쓰여요.</p>
        </details>
        <details class="glossary applied" id="appliedDet"><summary>적용된 프롬프트</summary><div \
id="appliedBody" class="applied-body muted small">불러오는 중</div></details>
      </div>
    </header>

    <section class="recbar" id="recbar" aria-label="녹음"></section>

    <div class="s-body">
      <div class="main-col">
        <div class="tabs" role="tablist" aria-label="보기">
          ${TABS.map(([k, v]) => `<button role="tab" type="button" \
id="tab-${k}" data-tab="${k}" aria-selected="${k === tab}" aria-controls="panel-\
${k}" tabindex="${k === tab ? 0 : -1}"${k === "notes" ? ' class="narrow-only"' : ""}>\
${v}${k === "ai" ? `<span class="tab-dot" id="aiDot"${s.aiNote ? "" : " hidden"} aria-hidden="true"\
></span>` : ""}</button>`).join("")}
          <span class="spacer"></span>
          <span class="tab-tools" id="tTools">
            <span class="seg-switch" role="group" aria-label="대본 보기" id="viewSw" \
hidden><button type="button" data-v="refined" aria-pressed="true">정제본</button><button \
type="button" data-v="raw" aria-pressed="false">원문</button></span>
            <span class="muted small" id="refStat"></span>
            <span class="muted small" id="tStats"></span>
            <button class="btn small" type="button" id="retryAll" hidden>실패한 구간 다시 시도</button>
            <label class="follow"><input type="checkbox" id="followChk" checked> 따라가기</label>
          </span>
        </div>
        <section class="panel" id="panel-transcript" role="tabpanel" aria-labelledby="tab-transcript">
          <h2 class="sr-only">대본</h2>
          <ol class="transcript" id="transcript" aria-live="polite" aria-relevant="additions"></ol>
        </section>
        <section class="panel" id="panel-ai" role="tabpanel" aria-labelledby="tab-ai"><h2 \
class="sr-only">강의노트</h2><div id="aiPanel"></div></section>
      </div>
      <aside class="memo-col" id="panel-notes" role="tabpanel" aria-labelledby="memoH"><div class="memo-inner">
        <div class="memo-head"><h2 id="memoH">내 메모</h2><span class="muted small" id="notesSaved"></span>
          <span id="notesConflict" class="notes-conflict" role="alert" hidden></span></div>
        <div id="notesEditor"></div>
        <p class="muted small hint">줄을 쓰기 시작하면 녹음 시각이 붙어요. <kbd>Ctrl</kbd>+<kbd>J</kbd> 중요 표시</p>
        <details class="ask-dock" id="askDock"><summary>이 녹음에 질문하기</summary><div \
id="askPanel" class="ask-wrap"></div></details>
      </div></aside>
    </div>
  </div>`;

  // ---------- header ----------
  const patch = async (json) => {
    try {
      const r = await api(`/api/sessions/${id}`, { method: "PATCH", json });
      Object.assign(s, { title: r.title, course: r.course });
      $("#sH1", root).textContent = r.title;
      s.meta = r.meta;
      emit("library-changed");
    } catch (err) {
      toast(err.message, { error: true });
    }
  };
  const titleEl = $("#sTitle", root);
  titleEl.addEventListener("change", () => {
    if (titleEl.value.trim()) patch({ title: titleEl.value });
    else titleEl.value = s.title;
  });
  titleEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") titleEl.blur();
  });
  const courseEl = $("#sCourse", root);
  courseEl.addEventListener("change", () =>
    patch({
      course:
        courseEl.value.trim().toUpperCase() === courseEl.value.trim() ? courseEl.value.trim() : courseEl.value.trim(),
    }),
  );
  let gTimer = null;
  $("#sGlossary", root).addEventListener("input", (e) => {
    clearTimeout(gTimer);
    gTimer = setTimeout(() => patch({ glossary: e.target.value }), 600);
  });

  const exportBtn = $("#exportBtn", root),
    exportMenu = $("#exportMenu", root);
  const closeMenu = () => {
    exportMenu.hidden = true;
    exportBtn.setAttribute("aria-expanded", "false");
  };
  exportBtn.addEventListener("click", () => {
    const open = exportMenu.hidden;
    exportMenu.hidden = !open;
    exportBtn.setAttribute("aria-expanded", String(open));
    if (open) exportMenu.querySelector("button").focus();
  });
  exportMenu.addEventListener("keydown", (e) => {
    const items = $$("button", exportMenu);
    const i = items.indexOf(document.activeElement);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      items[(i + 1) % items.length].focus();
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      items[(i - 1 + items.length) % items.length].focus();
    }
    if (e.key === "Escape") {
      closeMenu();
      exportBtn.focus();
    }
  });
  const docClick = (e) => {
    if (!e.target.closest(".menu")) closeMenu();
  };
  document.addEventListener("click", docClick);
  ctl.cleanups.push(() => document.removeEventListener("click", docClick));
  exportMenu.addEventListener("click", async (e) => {
    const fmt = e.target.closest("button")?.dataset.fmt;
    if (!fmt) return;
    closeMenu();
    await flushNotes();
    if (fmt === "vault") {
      await openVaultDialog(id);
      return;
    }
    if (fmt === "copy") {
      const md = await fetch(`/api/sessions/${id}/export?format=md&source=${view}`).then((r) => r.text());
      await navigator.clipboard.writeText(md).then(
        () => toast("마크다운을 복사했어요"),
        () => toast("복사하지 못했어요. 파일로 내보내주세요.", { error: true }),
      );
    } else download(`/api/sessions/${id}/export?format=${fmt}&source=${view}`);
  });
  async function recordingMayBeDeleted() {
    const owner = recorderOwner();
    if (live.isActive(id) || owner?.sessionId === id) return false;
    if ((live.sid && live.sid !== id && live.state !== "idle") || (owner && owner.sessionId !== id)) return true;
    if (!recorderSupported()) return !["recording", "paused"].includes(s.state);
    return recorderLockFree();
  }
  $("#delBtn", root).addEventListener("click", async () => {
    if (!(await recordingMayBeDeleted())) { toast("녹음을 먼저 멈춰주세요"); return; }
    if (
      !(await confirmDialog(
        "이 녹음을 지울까요?",
        `"${s.title}"의 오디오, 대본, 메모, 강의노트가 모두 지워져요. 되돌릴 수 없어요.`,
        "지우기",
      ))
    )
      return;
    if (!(await recordingMayBeDeleted())) { toast("다른 탭에서 녹음이 시작됐어요.", { error: true }); return; }
    await api(`/api/sessions/${id}`, { method: "DELETE" });
    toast("지웠어요");
    emit("library-changed");
    location.hash = "#/new";
  });

  // ---------- tabs ----------
  const sessionEl = $(".session", root);
  function setTab(k, focus = false) {
    tab = k;
    sessionEl.dataset.tab = k;
    sessionStorage.setItem(`lns.tab.${id}`, k);
    $("#tTools", root).hidden = k !== "transcript";
    $$(".tabs [role=tab]", root).forEach((b) => {
      const on = b.dataset.tab === k;
      b.setAttribute("aria-selected", String(on));
      b.tabIndex = on ? 0 : -1;
      if (on && focus) b.focus();
    });
  }
  $(".tabs", root).addEventListener("click", (e) => {
    const b = e.target.closest("[role=tab]");
    if (b) setTab(b.dataset.tab);
  });
  $("#tTools", root).hidden = tab !== "transcript";
  const onWide = () => {
    if (WIDE.matches && tab === "notes") setTab("transcript");
  };
  WIDE.addEventListener("change", onWide);
  ctl.cleanups.push(() => WIDE.removeEventListener("change", onWide));
  $(".tabs", root).addEventListener("keydown", (e) => {
    const vis = $$(".tabs [role=tab]", root).filter((b) => b.offsetParent !== null);
    const i = vis.findIndex((b) => b.dataset.tab === tab);
    let n = null;
    if (e.key === "ArrowRight") n = vis[(i + 1) % vis.length];
    if (e.key === "ArrowLeft") n = vis[(i - 1 + vis.length) % vis.length];
    if (e.key === "Home") n = vis[0];
    if (e.key === "End") n = vis[vis.length - 1];
    if (n) {
      e.preventDefault();
      setTab(n.dataset.tab, true);
    }
  });

  // ---------- playback ----------
  let playingSeg = null;
  function seek(t) {
    if (!Number.isFinite(t)) return;
    if (s.meta.audioFile) {
      const src = `/api/sessions/${id}/audio`;
      if (!player.src.endsWith(src)) {
        player.src = src;
        playingSeg = null;
      }
      const go = () => {
        player.currentTime = Math.max(0, t - 1);
        player.play().catch(() => {});
      };
      if (player.readyState >= 1) go();
      else player.addEventListener("loadedmetadata", go, { once: true });
    } else {
      const seg =
        [...segs.values()].find((g) => t >= g.start && t < g.end) ||
        [...segs.values()].sort((a, b) => a.start - b.start).find((g) => g.start >= t);
      if (!seg) {
        toast("아직 재생할 오디오가 없어요");
        return;
      }
      playingSeg = seg;
      player.src = `/api/sessions/${id}/segments/${seg.index}/audio`;
      player.addEventListener(
        "loadedmetadata",
        () => {
          player.currentTime = Math.max(0, t - seg.start - 1);
          player.play().catch(() => {});
        },
        { once: true },
      );
    }
    playerUi.show();
  }
  const playerUi = mountPlayer(
    $("#recbar", root),
    player,
    () => (playingSeg ? playingSeg.start : 0),
    (t) => highlight(t),
  );
  ctl.cleanups.push(() => {
    player.pause();
    playerUi.destroy();
  });

  // ---------- refine ----------
  let view = localStorage.getItem("lns.view") === "raw" ? "raw" : "refined";
  let refWindows = (s.meta.refineWindows || {})[String(s.meta.refine?.interval ?? 300)] || {};
  const refineOn = () => Boolean(s.meta.refine?.enabled);
  const intervalSec = () => {
    const v = s.meta.refine?.interval ?? 300;
    return v === "end" ? Infinity : Number(v);
  };
  const pendingRefine = (g) => {
    const w = intervalSec() === Infinity ? 0 : Math.floor((g.start + 0.001) / intervalSec());
    const st = refWindows[w];
    return !st || st.status !== "done";
  };
  function paintRefine() {
    const any = [...segs.values()].some((g) => g.refined != null);
    $("#viewSw", root).hidden = !(refineOn() || any);
    $$("#viewSw button", root).forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.v === view)));
    $("#refInt", root).disabled = !refineOn();
    const vals = Object.values(refWindows);
    const run = vals.filter((w) => w.status === "running").length,
      err = vals.filter((w) => w.status === "error"),
      done = vals.filter((w) => w.status === "done");
    const el = $("#refStat", root);
    if (!refineOn()) {
      el.innerHTML = "";
      return;
    }
    const last = done
      .map((w) => w.ms)
      .filter(Boolean)
      .slice(-1)[0];
    el.innerHTML = run
      ? `<span class="ref-pill busy">정제 중</span>`
      : err.length
        ? `<span class="ref-pill err" title="${esc(err[0].error || "")}">정제 실패 \
${err.length}</span> <button class="btn small ghost" type="button" id="refRetry">다시 정제</button>`
        : done.length
          ? `<span class="ref-pill ok">정제 ${done.length}묶음 완료${last ? ` · \
${(last / 1000).toFixed(1)}초` : ""}</span> <button class="btn small ghost" type="button" \
id="refRetry">전체 다시 정제</button>`
          : `<span class="ref-pill">\
${s.meta.refine.interval === "end" ? "녹음이 끝나면 정제해요" : `${INTERVAL_LABEL[s.meta.refine.interval]} 정제 대기`}</span>${
              [...segs.values()].some((g) => g.text) && !live.isActive(id)
                ? ` <button class="btn small ghost" type="button" id="refRetry">지금 정제</button>`
                : ""
            }`;
    $("#refRetry", root)?.addEventListener("click", async (e) => {
      e.target.disabled = true;
      try {
        const r = await api(`/api/sessions/${id}/refine`, { method: "POST", json: {} });
        toast(r.started ? `${r.started}묶음을 정제해요` : "정제할 구간이 아직 없어요");
      } catch (err2) {
        toast(err2.message, { error: true });
        e.target.disabled = false;
      }
    });
  }
  async function setRefine(patchObj) {
    try {
      const r = await api(`/api/sessions/${id}`, { method: "PATCH", json: { refine: patchObj } });
      s.meta = r.meta;
      refWindows = (s.meta.refineWindows || {})[String(s.meta.refine.interval)] || {};
      if (patchObj.enabled && view !== "refined") {
        view = "refined";
        localStorage.setItem("lns.view", view);
      }
      paintRefine();
      renderAll();
      loadApplied();
    } catch (err) {
      toast(err.message, { error: true });
    }
  }
  $("#refOn", root).addEventListener("change", (e) => setRefine({ enabled: e.target.checked }));
  $("#refInt", root).addEventListener("change", (e) =>
    setRefine({ interval: e.target.value === "end" ? "end" : Number(e.target.value) }),
  );
  $("#viewSw", root).addEventListener("click", (e) => {
    const b = e.target.closest("[data-v]");
    if (!b) return;
    view = b.dataset.v;
    localStorage.setItem("lns.view", view);
    paintRefine();
    renderAll();
  });

  async function loadApplied() {
    const el = $("#appliedBody", root);
    try {
      const a = await api(`/api/sessions/${id}/prompts`);
      const tag = (x) => (x.custom ? `<span class="badge">수정됨</span>` : `<span class="muted">기본값</span>`);
      el.innerHTML = `
        <p><strong>과목 정보</strong> ${a.context ? "" : "<span class='muted'>없음</span>"}</p>\
${a.context ? `<pre class="pv">${esc(a.context)}</pre>` : ""}
        <p><strong>받아쓰기</strong> ${tag(a.transcribe)} <span class="muted">앞 구간 끝 400자가 뒤에 \
붙어요</span></p><pre class="pv">${esc(a.transcribe.sample)}</pre>
        <p><strong>정제</strong> ${a.refine.enabled ? `켜짐 · ${esc(a.refine.model)}` : "꺼짐"} ${tag(a.refine)}</p>
        <p><strong>강의노트</strong> ${tag(a.note)}</p>
        <button class="btn small" type="button" id="openSet">베이스 프롬프트 고치기</button>`;
      $("#openSet", root).addEventListener("click", () => openSettings({ tab: "base", course: s.course }));
    } catch {
      el.textContent = "불러오지 못했어요";
    }
  }
  $("#appliedDet", root).addEventListener("toggle", (e) => {
    if (e.target.open) loadApplied();
  });

  // ---------- transcript ----------
  const list = $("#transcript", root);
  const follow = $("#followChk", root);
  function rowHtml(g) {
    const st = g.status;
    const showRef = view === "refined" && g.refined != null && g.text;
    const textHtml = showRef ? (g.refinedEdited ? esc(g.refined) : diffHtml(g.text, g.refined)) : esc(g.text || "");
    const body =
      st === "done"
        ? g.text
          ? `<p class="t-text${showRef ? " refined" : ""}" data-idx=\
"${g.index}">${textHtml}</p>${
              !showRef && view === "refined" && refineOn() && pendingRefine(g)
                ? `<span class="ref-wait muted small">정제 대기</span>`
                : ""
            }`
          : `<p class="t-text muted">(말소리 없음)</p>`
        : st === "error"
          ? `<p class="t-status err">${STATUS_TEXT.error} <span class="muted small">\
${esc(g.error || "")}</span></p><button class="btn small" type="button" data-retry="${g.index}">다시 시도</button>`
          : `<p class="t-status${st === "silent" ? " muted" : " busy"}">${STATUS_TEXT[st] || st}</p>`;
    return `<li class="t-row s-${st}" data-idx="${g.index}" data-start="${g.start}" data-end="${g.end}">
      <button class="ts mono" type="button" data-t="${g.start}" aria-label="\
${fmtTime(g.start)}부터 듣기">${fmtTime(g.start)}</button>
      <div class="t-body">${body}</div>
      ${st === "done" && g.text ? `<button class="t-edit btn ghost small" type="button" \
data-edit="${g.index}">고치기</button>` : ""}
    </li>`;
  }
  function renderRow(g) {
    const existing = list.querySelector(`.t-row[data-idx="${g.index}"]`);
    const html = rowHtml(g);
    if (existing) {
      if (existing.querySelector("textarea")) return;
      existing.outerHTML = html;
      return;
    }
    const after = [...list.children].find((li) => Number(li.dataset.idx) > g.index);
    if (after) after.insertAdjacentHTML("beforebegin", html);
    else list.insertAdjacentHTML("beforeend", html);
    if (follow.checked && live.isActive(id)) list.lastElementChild?.scrollIntoView({ block: "nearest" });
  }
  function renderAll() {
    const all = [...segs.values()];
    for (const [idx, p] of localPending)
      if (!segs.has(idx)) all.push({ index: idx, start: p.start, end: p.start + p.duration, status: "uploading" });
    all.sort((a, b) => a.index - b.index);
    list.innerHTML = all.length ? all.map(rowHtml).join("") : "";
    updateStats();
  }
  function updateStats() {
    const v = [...segs.values()];
    const done = v.filter((g) => g.status === "done").length,
      err = v.filter((g) => g.status === "error").length;
    const busy =
      v.filter((g) => g.status === "pending" || g.status === "transcribing").length +
      [...localPending.keys()].filter((k) => !segs.has(k)).length;
    $("#tStats", root).textContent =
      v.length || busy ? `${done}개 구간 완료${busy ? ` · ${busy}개 처리 중` : ""}${err ? ` · 실패 ${err}` : ""}` : "";
    $("#retryAll", root).hidden = err === 0;
    const dur = Math.max(s.duration || 0, ...v.map((g) => g.end || 0), live.isActive(id) ? live.elapsed : 0);
    $("#sDur", root).textContent = fmtDuration(dur);
    if (!list.children.length) {
      list.innerHTML = `<li class="empty small"><p class="muted"\
>${
        live.isActive(id)
          ? "30초마다 대본이 여기에 쌓여요"
          : s.source === "upload" && s.state === "processing"
            ? "파일을 나누는 중이에요"
            : "대본이 없어요"
      }</p></li>`;
    } else if (list.querySelector(".empty") && list.children.length > 1) list.querySelector(".empty").remove();
  }
  function highlight(t) {
    const rows = list.querySelectorAll(".t-row");
    let hit = null;
    for (const r of rows) {
      if (t >= Number(r.dataset.start) && t < Number(r.dataset.end)) {
        hit = r;
        break;
      }
    }
    list.querySelectorAll(".t-row.playing").forEach((r) => r !== hit && r.classList.remove("playing"));
    if (hit && !hit.classList.contains("playing")) {
      hit.classList.add("playing");
      if (follow.checked) hit.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }
  list.addEventListener("click", async (e) => {
    const ts = e.target.closest(".ts");
    if (ts) return seek(Number(ts.dataset.t));
    const rb = e.target.closest("[data-retry]");
    if (rb) {
      rb.disabled = true;
      await api(`/api/sessions/${id}/segments/${rb.dataset.retry}/retry`, { method: "POST" }).catch((err) =>
        toast(err.message, { error: true }),
      );
      return;
    }
    const eb = e.target.closest("[data-edit]");
    if (eb) editRow(Number(eb.dataset.edit));
  });
  function editRow(idx) {
    const g = segs.get(idx);
    const li = list.querySelector(`.t-row[data-idx="${idx}"]`);
    if (!g || !li) return;
    const field = view === "refined" && g.refined != null ? "refined" : "text";
    li.querySelector(".t-body").innerHTML =
      `<textarea class="t-editor" aria-label="${fmtTime(g.start)} 구간 \
${field === "refined" ? "정제본" : "원문"} 고치기">${esc(g[field])}</textarea><div \
class="row-actions"><button class="btn small primary" type="button" data-save>저장</button><button \
class="btn small ghost" type="button" data-cancel>취소</button></div>`;
    li.querySelector(".t-edit")?.remove();
    const ta = li.querySelector("textarea");
    ta.style.height = `${ta.scrollHeight + 4}px`;
    ta.focus();
    li.querySelector("[data-cancel]").onclick = () => renderRowForce(g);
    li.querySelector("[data-save]").onclick = async () => {
      try {
        await api(`/api/sessions/${id}/transcript`, { method: "PATCH", json: { index: idx, text: ta.value, field } });
        if (field === "refined") {
          g.refined = ta.value;
          g.refinedEdited = true;
        } else g.text = ta.value;
        renderRowForce(g);
        toast(field === "refined" ? "정제본을 고쳤어요" : "원문을 고쳤어요");
      } catch (err) {
        toast(err.message, { error: true });
      }
    };
  }
  function renderRowForce(g) {
    const li = list.querySelector(`.t-row[data-idx="${g.index}"]`);
    if (li) li.outerHTML = rowHtml(g);
  }
  paintRefine();
  $("#retryAll", root).addEventListener("click", () =>
    api(`/api/sessions/${id}/retry-failed`, { method: "POST" })
      .then((r) => toast(`${r.retried}개 구간을 다시 받아써요`))
      .catch((err) => toast(err.message, { error: true })),
  );
  renderAll();

  // ---------- notes ----------
  let notesTimer = null, notesDirty = false, saving = false, editVersion = 0;
  let revision = Number.isSafeInteger(s.notes?.revision) ? s.notes.revision : 0;
  let remoteCurrent = null;
  const notesTabId = tabSync?.tabId ?? fallbackNotesTabId;
  const { own: stashKey, drafts } = listNoteStashes(localStorage, id, notesTabId);
  const savedEl = $("#notesSaved", root);
  const conflictEl = $("#notesConflict", root);
  const editor = new NotesEditor($("#notesEditor", root), {
    getTime: () => { const owner = tabSync?.getOwner()?.message;
      return live.sid === id ? live.elapsed : owner?.sessionId === id ? owner.payload.elapsed : null; },
    onChange: () => {
      notesDirty = true; editVersion++;
      if (remoteCurrent) stashDraft();
      savedEl.textContent = "저장 중";
      clearTimeout(notesTimer);
      notesTimer = setTimeout(flushNotes, 800);
    },
    onSeek: (t) => seek(t),
  });
  editor.setLines(s.notes?.lines || []);
  const ownDraft = drafts.find((draft) => draft.key === stashKey);
  if (ownDraft) {
    try {
      const draft = ownDraft;
      if (Array.isArray(draft.lines)) {
        const serverRevision = revision;
        editor.setLines(draft.lines);
        revision = Number.isSafeInteger(draft.revision) ? draft.revision : revision;
        notesDirty = true; editVersion++; savedEl.textContent = "임시 저장된 메모";
        if (revision !== serverRevision || draft.legacy)
          showConflict({ revision: serverRevision, lines: s.notes?.lines || [] });
        else notesTimer = setTimeout(flushNotes, 0);
      }
    } catch { /* preserve malformed stash for manual recovery */ }
  }
  const foreignDrafts = drafts.filter((draft) => draft.key !== stashKey);
  if (foreignDrafts.length) {
    const draftOffer = document.createElement("div");
    draftOffer.className = "rec-notice";
    draftOffer.setAttribute("role", "status");
    draftOffer.append("다른 탭의 임시 메모가 있어요. ");
    foreignDrafts.forEach((draft, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = `임시 메모 ${index + 1} 보기`;
      button.addEventListener("click", () => {
        // C re-review: never drop this tab's unsaved notes when adopting another tab's draft.
        const keptKey = adoptDraft(localStorage, { sessionId: id, ownKey: stashKey, foreignKey: draft.key,
          current: notesDirty || ownDraft ? { revision, lines: editor.data() } : null,
          adopted: { revision: Number.isSafeInteger(draft.revision) ? draft.revision : revision,
            lines: draft.lines } });
        if (keptKey) toast("지금 메모는 이 기기에 따로 보관했어요. 다시 열면 고를 수 있어요.");
        editor.setLines(draft.lines);
        revision = Number.isSafeInteger(draft.revision) ? draft.revision : revision;
        notesDirty = true; editVersion++;
        draftOffer.remove();
        if (revision !== (s.notes?.revision ?? 0) || draft.legacy)
          showConflict({ revision: s.notes?.revision ?? 0, lines: s.notes?.lines || [] });
        else { savedEl.textContent = "임시 저장된 메모"; notesTimer = setTimeout(flushNotes, 0); }
      });
      draftOffer.append(button);
    });
    conflictEl.after(draftOffer);
  }
  function stashDraft() {
    localStorage.setItem(stashKey, JSON.stringify({ revision, lines: editor.data() }));
  }
  function showConflict(current) {
    if (remoteCurrent && remoteCurrent.revision > current.revision) return;
    remoteCurrent = current; stashDraft();
    conflictEl.hidden = false;
    conflictEl.innerHTML = '<span>다른 탭에서 메모가 바뀌었어요.</span> '
      + '<button type="button" data-choice="mine">내 메모 유지</button> '
      + '<button type="button" data-choice="theirs">다른 탭 메모 사용</button>';
    savedEl.textContent = "저장 충돌";
  }
  async function flushNotes() {
    clearTimeout(notesTimer);
    notesTimer = null;
    if (!notesDirty || saving || remoteCurrent) return;
    saving = true;
    const captured = editVersion, lines = editor.data(), baseRevision = revision;
    try {
      const r = await api(`/api/sessions/${id}/notes`, { method: "PUT",
        headers: { "X-Tab-Id": notesTabId }, json: { lines, baseRevision } });
      revision = r.revision; s.notes = { revision, lines };
      if (captured === editVersion) { notesDirty = false; localStorage.removeItem(stashKey); }
      else { notesDirty = true; stashDraft(); }
      if (!ctl.destroyed)
        savedEl.textContent = `저장됨 ${new Date(r.savedAt).toLocaleTimeString("ko-KR",
          { hour: "2-digit", minute: "2-digit" })}`;
      tabSync?.notesSaved(id, revision);
    } catch (err) {
      notesDirty = true; stashDraft();
      if (err.status === 409) showConflict({ revision: err.data.revision, lines: err.data.lines });
      else {
        if (!ctl.destroyed) savedEl.textContent = "저장하지 못했어요. 이 기기에 임시 저장했어요";
        if (!ctl.destroyed) notesTimer = setTimeout(flushNotes, 5000);
      }
    } finally {
      saving = false;
      if (!ctl.destroyed && notesDirty && !remoteCurrent && !notesTimer) notesTimer = setTimeout(flushNotes, 0);
    }
  }
  conflictEl.addEventListener("click", (e) => {
    const choice = e.target.closest("[data-choice]")?.dataset.choice;
    if (!choice || !remoteCurrent) return;
    revision = remoteCurrent.revision;
    if (choice === "theirs") {
      editor.setLines(remoteCurrent.lines); s.notes = { revision, lines: remoteCurrent.lines };
      notesDirty = false; localStorage.removeItem(stashKey);
      savedEl.textContent = "다른 탭 메모를 불러왔어요";
    } else { notesDirty = true; stashDraft(); notesTimer = setTimeout(flushNotes, 0); }
    remoteCurrent = null; conflictEl.hidden = true;
  });
  function applyRemoteNotes(d) {
    if (!Number.isSafeInteger(d.revision) || d.revision <= revision || d.by === notesTabId) return;
    if (notesDirty || saving || remoteCurrent) { showConflict(d); return; }
    revision = d.revision; s.notes = { revision, lines: d.lines };
    editor.setLines(d.lines); savedEl.textContent = "다른 탭 메모를 불러왔어요";
  }
  async function refreshNotesIfNewer(remoteRevision) {
    if (remoteRevision <= revision || ctl.destroyed) return;
    try {
      const latest = await api(`/api/sessions/${id}`);
      if (!ctl.destroyed) applyRemoteNotes({ revision: latest.notes.revision,
        lines: latest.notes.lines, by: null });
    } catch (err) { if (!ctl.destroyed) toast(err.message, { error: true }); }
  }
  ctl.cleanups.push(() => { clearTimeout(notesTimer); if (notesDirty) stashDraft(); });

  // ---------- AI + Q&A ----------
  const hasSource = () => [...segs.values()].some((g) => g.text) || editor.data().length > 0;
  const aiCtl = mountAiPanel($("#aiPanel", root), {
    session: s,
    onSeek: seek,
    hasSource,
    onNote: (has) => {
      $("#aiDot", root).hidden = !has;
    },
    getSource: () => view,
    hasRefined: () => [...segs.values()].some((g) => g.refined != null),
  });
  const askCtl = mountAskPanel($("#askPanel", root), { session: s, onSeek: seek, hasSource });
  ctl.cleanups.push(
    () => aiCtl.destroy(),
    () => askCtl.destroy(),
  );

  // ---------- record bar ----------
  const recbar = $("#recbar", root);
  // Keep the sticky memo column tucked right under the sticky record bar.
  const ro = new ResizeObserver(() => sessionEl.style.setProperty("--recbar-h", `${recbar.offsetHeight}px`));
  ro.observe(recbar);
  ctl.cleanups.push(() => ro.disconnect());
  const recUi = document.createElement("div");
  recUi.className = "rec-ui";
  recbar.prepend(recUi);
  let mics = [];
  async function refreshMics() {
    mics = await listMics().catch(() => []);
    const sel = recUi.querySelector("#micSel");
    if (sel) {
      const saved = localStorage.getItem("lns.mic") || "";
      sel.innerHTML =
        `<option value="">기본 마이크</option>` +
        mics
          .filter((m) => m.deviceId && m.deviceId !== "default")
          .map(
            (m, i) =>
              `<option value="${esc(m.deviceId)}"\
${m.deviceId === saved ? " selected" : ""}>${esc(m.label || `마이크 ${i + 1}`)}</option>`,
          )
          .join("");
    }
  }
  const nextPosition = () => {
    let idx = -1,
      end = 0;
    for (const g of segs.values()) {
      if (g.index > idx) idx = g.index;
      if (g.end > end) end = g.end;
    }
    for (const [k, p] of localPending) {
      if (k > idx) idx = k;
      if (p.start + p.duration > end) end = p.start + p.duration;
    }
    return { index: idx + 1, offset: end };
  };
  let paintGeneration = 0, lockProbeRetry = null;
  async function paintRec() {
    const generation = ++paintGeneration;
    clearTimeout(lockProbeRetry); lockProbeRetry = null;
    const mine = live.sid === id && live.state !== "idle";
    const ownerInfo = tabSync?.getOwner();
    const owner = ownerInfo?.message;
    const mirror = !mine && owner?.sessionId === id;
    const otherSessionId = owner?.sessionId || (live.state !== "idle" ? live.sid : null);
    const elsewhere = !mine && otherSessionId && otherSessionId !== id;
    const state = mine ? live.state : mirror ? owner.payload.state : s.state;
    $("#sState", root).textContent = state === "recording" ? "녹음 중"
      : state === "paused" ? "일시정지" : state === "stopping" ? "마무리하는 중"
      : state === "starting" ? "마이크 켜는 중" : state === "processing" ? "받아쓰는 중"
      : state === "ready" ? "완료" : state === "error" ? "처리 실패" : "";
    $("#sState", root).dataset.state = state;
    if (mine) return paintOwnerControls(live.state, live.elapsed, false);
    if (mirror) return paintOwnerControls(owner.payload.state, owner.payload.elapsed, true);
    if (elsewhere) {
      recUi.innerHTML = `<p class="rec-notice" role="status">다른 녹음이 진행 중이에요. \
<a href="#/s/${encodeURIComponent(otherSessionId)}">녹음 중인 노트 열기</a></p>`;
      return;
    }
    if (!recorderSupported()) {
      recUi.innerHTML = `<button class="rec-btn" type="button" disabled>녹음 시작</button>
        <p class="rec-notice" role="status">탭 간 녹음 보호를 사용할 수 없어 녹음을 시작할 수 없어요.</p>`;
      return;
    }
    recUi.innerHTML = '<span class="muted small" role="status">녹음 상태 확인 중…</span>';
    let free;
    try { free = await recorderLockFree(); }
    catch (err) {
      if (!ctl.destroyed && generation === paintGeneration)
        recUi.innerHTML = `<p class="rec-notice" role="alert">${esc(err.message)}</p>`;
      return;
    }
    if (ctl.destroyed || generation !== paintGeneration) return;
    if (live.isActive(id)) return paintRec();
    if (tabSync.getOwner()) return paintRec();
    const serverRecording = (s.state === "recording" || s.state === "paused") && s.source !== "upload";
    const quiet = tabSync.quietFor(3000);
    const resumable = free && quiet && serverRecording;
    paintIdleControls({ free: free && (!serverRecording || quiet), resumable,
      isUpload: s.source === "upload", nextPosition });
    if (!free || (serverRecording && !quiet)) {
      lockProbeRetry = setTimeout(() => {
        lockProbeRetry = null;
        if (!ctl.destroyed && generation === paintGeneration && !tabSync.getOwner()) paintRec();
      }, free ? 3000 : 2000);
    }
  }
  function paintIdleControls({ free, resumable, isUpload }) {
    if (isUpload) { recUi.innerHTML = s.state === "error"
      ? `<p class="err">${esc(s.meta.error || "파일을 처리하지 못했어요")}</p>` : ""; return; }
    recUi.innerHTML = `<button class="rec-btn" type="button" id="recStart" ${free ? "" : "disabled"}>
      <span class="rec-dot" aria-hidden="true"></span>${resumable || segs.size ? "이어서 녹음" : "녹음 시작"}</button>
      <label class="compact mic"><span class="sr-only">마이크</span><select id="micSel">\
<option value="">기본 마이크</option></select></label>
      ${!free ? '<span class="rec-notice" role="status">다른 탭에서 녹음 중이에요</span>'
        : resumable ? `<span class="muted small">이어서 녹음하면 ${fmtTime(nextPosition().offset)}부터 붙어요</span>` : ""}`;
    refreshMics();
    recUi.querySelector("#micSel")?.addEventListener("change", (e) => localStorage.setItem("lns.mic", e.target.value));
    recUi.querySelector("#recStart")?.addEventListener("click", start);
  }
  function paintOwnerControls(state, elapsed, remote) {
    recUi.innerHTML = `<span class="rec-live${state === "recording" ? " on" : ""}" aria-hidden="true"></span>
      <span class="timer mono" id="recTimer" role="timer" aria-label="녹음 시간">${fmtTime(elapsed)}</span>
      <div class="meter" aria-hidden="true"><span id="meterBar"></span></div>
      <button class="btn" type="button" id="recPause" \
${["starting", "stopping"].includes(state) ? "disabled" : ""}>\
${state === "paused" ? "다시 녹음" : "일시정지"}</button>
      <button class="btn" type="button" id="recMark" \
${state !== "recording" ? "disabled" : ""} title="Ctrl+Shift+M">중요 표시</button>
      <button class="btn stop" type="button" id="recStop" \
${["starting", "stopping"].includes(state) ? "disabled" : ""}>끝내기</button>
      ${remote ? '<span class="muted small">다른 탭에서 녹음 중</span>'
        : '<span class="muted small queue" id="queueInfo"></span>'}`;
    if (remote) recUi.querySelector("#meterBar").style.transform =
      `scaleX(${Math.min(1, Math.sqrt(tabSync.getOwner()?.message?.payload.level || 0) * 1.2).toFixed(3)})`;
    const showCommandError = (err) => { toast(err.message, { error: true }); paintRec(); };
    recUi.querySelector("#recPause")?.addEventListener("click", () =>
      (remote ? tabSync.sendCommand(id, state === "paused" ? "resume" : "pause")
        : state === "paused" ? resumeRecording() : pauseRecording()).catch(showCommandError));
    recUi.querySelector("#recStop")?.addEventListener("click", () =>
      (remote ? tabSync.sendCommand(id, "stop") : stop()).catch(showCommandError));
    recUi.querySelector("#recMark")?.addEventListener("click", () =>
      (remote ? tabSync.sendCommand(id, "mark") : Promise.resolve(mark())).catch(showCommandError));
  }
  async function start() {
    if (!recorderSupported() || recorderOwner()) {
      toast("다른 탭에서 녹음 중이에요. 녹음 중인 노트를 열어주세요.", { error: true });
      paintRec();
      return;
    }
    const deviceId = recUi.querySelector("#micSel")?.value || "";
    const pos = nextPosition();
    try {
      await startRecording(id, { deviceId, fake: opts.fake, index: pos.index, offset: pos.offset });
      syncMarkHandler();
      s.state = "recording";
      refreshMics();
      if (tab === "ai") setTab("transcript");
      setTimeout(() => editor.focusLine(editor.lines[editor.lines.length - 1].id), 50);
    } catch (err) {
      toast(err.message, { error: true, ms: 7000 });
      paintRec();
    }
  }
  async function stop() {
    await stopRecording();
    flushNotes();
    toast("녹음을 끝냈어요. 남은 구간을 받아쓰면 강의노트를 만들 수 있어요", { ms: 4000 });
  }
  function mark() {
    if (!live.isActive(id)) return;
    if (!WIDE.matches) setTab("notes");
    editor.markNow("");
    toast(`${fmtTime(live.elapsed)}에 중요 표시를 남겼어요`, { ms: 1800 });
  }
  const hotkey = (e) => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === "m" || e.key === "M")) {
      e.preventDefault();
      if (tabSync?.getOwner()?.message.sessionId === id && !live.isActive(id))
        tabSync.sendCommand(id, "mark").catch((err) => toast(err.message, { error: true }));
      else mark();
    }
  };
  document.addEventListener("keydown", hotkey);
  ctl.cleanups.push(() => document.removeEventListener("keydown", hotkey));
  let offMark = null;
  function syncMarkHandler() {
    offMark?.();
    offMark = live.sid === id ? setOwnerMarkHandler(async () => { mark(); await flushNotes(); }) : null;
  }
  syncMarkHandler();
  ctl.cleanups.push(() => offMark?.());
  const offTab = tabSync?.onChange((_owner, message) => {
    if (message?.type === "notes-saved" && message.sessionId === id)
      refreshNotesIfNewer(message.payload.revision);
    else paintRec();
  });
  ctl.cleanups.push(() => offTab?.());
  ctl.cleanups.push(() => { clearTimeout(lockProbeRetry); lockProbeRetry = null; });
  paintRec();

  const tick = setInterval(() => {
    const t = recUi.querySelector("#recTimer");
    if (!t) return;
    const ownerInfo = tabSync?.getOwner();
    const owner = ownerInfo?.message;
    const elapsed = live.sid === id ? live.elapsed : owner?.sessionId === id
      ? owner.payload.elapsed + (owner.payload.state === "recording"
        ? Math.max(0, Math.min(3, (Date.now() - ownerInfo.receivedAt) / 1000)) : 0) : null;
    if (elapsed != null) t.textContent = fmtTime(elapsed);
  }, 250);
  ctl.cleanups.push(() => clearInterval(tick));

  // ---------- events ----------
  const offs = [];
  const sub = (type, fn) => {
    offs.push(
      on(type, (d) => {
        if (!ctl.destroyed) fn(d);
      }),
    );
  };
  sub("live-state", ({ sid }) => {
    syncMarkHandler();
    if (sid === id || !live.sid) paintRec();
  });
  sub("live-error", ({ sid, error }) => {
    if (sid === id) { toast(error.message, { error: true }); paintRec(); }
  });
  sub("live-level", ({ peak }) => {
    const bar = recUi.querySelector("#meterBar");
    if (bar && live.sid === id) bar.style.transform = `scaleX(${Math.min(1, Math.sqrt(peak) * 1.2).toFixed(3)})`;
  });
  sub("live-segment", (g) => {
    if (g.sid !== id) return;
    localPending.set(g.index, g);
    if (!segs.has(g.index))
      renderRow({ index: g.index, start: g.start, end: g.start + g.duration, status: "uploading" });
    updateStats();
  });
  sub("upload-queue", (c) => {
    const q = recUi.querySelector("#queueInfo");
    if (q)
      q.textContent = c.bySid[id]
        ? `${c.bySid[id]}개 구간 올리는 중${c.failed ? ", 서버 연결을 기다리는 중" : ""}`
        : "";
  });
  sub("session-updated", (ns) => {
    if (ns.id === id) {
      s.meta = ns.meta;
      s.state = ns.state;
      paintRec();
    }
  });

  const es = new EventSource(`/api/sessions/${id}/events`);
  es.onmessage = (ev) => {
    if (ctl.destroyed) return;
    const d = JSON.parse(ev.data);
    if (d.type === "segment") {
      const isNew = !segs.has(d.segment.index);
      segs.set(d.segment.index, d.segment);
      localPending.delete(d.segment.index);
      renderRow(d.segment);
      updateStats();
      if (isNew && !live.isActive(id)) paintRec();
    }
    if (d.type === "stats") {
      updateStats();
      emit("library-changed");
    }
    if (d.type === "meta") {
      s.meta = d.meta;
      s.state = d.meta.state;
      refWindows = (s.meta.refineWindows || {})[String(s.meta.refine?.interval ?? 300)] || refWindows;
      paintRec();
      updateStats();
      paintRefine();
      emit("library-changed");
    }
    if (d.type === "status") toast(d.message, { ms: 2500 });
    if (d.type === "notes") applyRemoteNotes(d);
    if (d.type === "refine") {
      s.meta.refine = d.refine;
      refWindows = d.windows || {};
      $("#refOn", root).checked = Boolean(d.refine?.enabled);
      paintRefine();
      renderAll();
    }
    if (d.type === "reload")
      api(`/api/sessions/${id}`).then((ns) => {
        ns.segments.forEach((g) => segs.set(g.index, g));
        s.meta = ns.meta;
        renderAll();
      });
    if (d.type === "deleted") location.hash = "#/new";
  };
  ctl.cleanups.push(
    () => es.close(),
    () => offs.forEach((f) => f && f()),
  );
  counts().then((c) => emit("upload-queue", c));
  if (opts.autostart && !live.isActive(id)) start();
  return ctl;
}

// Compact audio player living in the record bar area.
function mountPlayer(host, audio, baseOffset, onTime) {
  const el = document.createElement("div");
  el.className = "player";
  el.hidden = true;
  el.innerHTML = `<button class="btn small" type="button" data-p="toggle">일시정지</button><button \
class="btn small ghost" type="button" data-p="back" aria-label="10초 \
뒤로">-10초</button><button class="btn small ghost" type="button" data-p="fwd" \
aria-label="10초 앞으로">+10초</button><span class="mono small" data-p="time">00:00</span><label \
class="compact"><span class="sr-only">재생 속도</span><select data-p="rate"><option \
value="1">1배</option><option value="1.25">1.25배</option><option \
value="1.5">1.5배</option><option value="2">2배</option></select></label><button class="btn \
small ghost" type="button" data-p="close" aria-label="플레이어 닫기">닫기</button>`;
  host.append(el);
  const time = el.querySelector('[data-p="time"]'),
    toggle = el.querySelector('[data-p="toggle"]');
  const upd = () => {
    const t = baseOffset() + audio.currentTime;
    time.textContent = fmtTime(t);
    toggle.textContent = audio.paused ? "재생" : "일시정지";
    onTime(t);
  };
  const evs = ["timeupdate", "play", "pause"];
  evs.forEach((e) => audio.addEventListener(e, upd));
  el.addEventListener("click", (e) => {
    const p = e.target.closest("[data-p]")?.dataset.p;
    if (p === "toggle") audio.paused ? audio.play() : audio.pause();
    if (p === "back") audio.currentTime = Math.max(0, audio.currentTime - 10);
    if (p === "fwd") audio.currentTime = audio.currentTime + 10;
    if (p === "close") {
      audio.pause();
      el.hidden = true;
    }
  });
  el.querySelector('[data-p="rate"]').addEventListener("change", (e) => {
    audio.playbackRate = Number(e.target.value);
  });
  return {
    show() {
      el.hidden = false;
    },
    destroy() {
      evs.forEach((e) => audio.removeEventListener(e, upd));
      el.remove();
    },
  };
}
