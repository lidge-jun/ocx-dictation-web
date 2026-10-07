// Line-based notes editor. Each line keeps the recording time at which it was started.
import { esc, fmtTime } from "./util.js";

let uid = 0;
const newId = () => `n${Date.now().toString(36)}${(uid++).toString(36)}`;

export class NotesEditor {
  constructor(root, { getTime, onChange, onSeek, canSeek }) {
    this.root = root;
    this.getTime = getTime; // () => seconds or null when not recording
    this.onChange = onChange;
    this.onSeek = onSeek;
    this.canSeek = canSeek || (() => false);
    this.lines = [];
    root.classList.add("notes-list");
    root.setAttribute("role", "list");
    root.addEventListener("keydown", (e) => this.onKey(e));
    root.addEventListener("input", (e) => this.onInput(e));
    root.addEventListener("click", (e) => this.onClick(e));
    root.addEventListener("paste", (e) => this.onPaste(e));
  }
  setLines(lines) {
    this.lines = (lines || []).map((l) => ({
      id: l.id || newId(),
      t: l.t || 0,
      text: l.text || "",
      important: !!l.important,
    }));
    if (!this.lines.length) this.lines.push(this.blank());
    this.render();
  }
  blank(t = null) {
    return { id: newId(), t: t ?? this.now(), text: "", important: false, fresh: true };
  }
  now() {
    const t = this.getTime();
    return t == null ? 0 : t;
  }
  data() {
    return this.lines
      .filter((l) => l.text.trim() || l.important)
      .map(({ id, t, text, important }) => ({ id, t, text, important }));
  }

  rowHtml(l) {
    return `<div class="note-row${l.important ? " important" : ""}" role="listitem" data-id="${l.id}">
      <button type="button" class="note-ts mono" data-act="seek" title="이 시점 듣기" \
aria-label="${fmtTime(l.t)} 시점으로 이동">${fmtTime(l.t)}</button>
      <textarea rows="1" class="note-input" aria-label="메모" \
placeholder="${this.lines.length === 1 && !l.text ? "들으면서 적어보세요. 줄마다 녹음 시각이 붙어요" : ""}">${esc(l.text)}</textarea>
      <button type="button" class="note-star" data-act="star" \
aria-pressed="${l.important}" title="중요 표시 (Ctrl+J)"><span class="sr-only">중요 \
표시</span><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.8l1.9 3.9 4.3.6-3.1 3 \
.7 4.3L8 11.6l-3.8 2 .7-4.3-3.1-3 4.3-.6z"/></svg></button>
    </div>`;
  }
  render() {
    this.root.innerHTML = this.lines.map((l) => this.rowHtml(l)).join("");
    this.root.querySelectorAll("textarea").forEach(autoGrow);
  }
  rowOf(el) {
    const row = el.closest(".note-row");
    return row ? { row, line: this.lines.find((l) => l.id === row.dataset.id) } : {};
  }
  focusLine(id, atEnd = true) {
    const ta = this.root.querySelector(`.note-row[data-id="${id}"] textarea`);
    if (!ta) return;
    ta.focus();
    const p = atEnd ? ta.value.length : 0;
    ta.setSelectionRange(p, p);
  }
  insertAfter(line, newLine) {
    const i = this.lines.indexOf(line);
    this.lines.splice(i + 1, 0, newLine);
    const row = this.root.querySelector(`.note-row[data-id="${line.id}"]`);
    row.insertAdjacentHTML("afterend", this.rowHtml(newLine));
    autoGrow(this.root.querySelector(`.note-row[data-id="${newLine.id}"] textarea`));
  }
  updateStamp(line) {
    const btn = this.root.querySelector(`.note-row[data-id="${line.id}"] .note-ts`);
    if (btn) {
      btn.textContent = fmtTime(line.t);
      btn.setAttribute("aria-label", `${fmtTime(line.t)} 시점으로 이동`);
    }
  }
  onInput(e) {
    if (e.target.tagName !== "TEXTAREA") return;
    const { line } = this.rowOf(e.target);
    if (!line) return;
    if (line.fresh && !line.text && e.target.value) {
      line.t = this.now();
      this.updateStamp(line);
    }
    line.fresh = false;
    line.text = e.target.value;
    autoGrow(e.target);
    this.onChange();
  }
  onPaste(e) {
    if (e.target.tagName !== "TEXTAREA") return;
    const text = e.clipboardData?.getData("text/plain") || "";
    if (!text.includes("\n")) return;
    e.preventDefault();
    const { line } = this.rowOf(e.target);
    const ta = e.target;
    const before = ta.value.slice(0, ta.selectionStart),
      after = ta.value.slice(ta.selectionEnd);
    const parts = text.replace(/\r\n?/g, "\n").split("\n");
    line.text = before + parts[0];
    if (!line.t || line.fresh) line.t = this.now();
    line.fresh = false;
    ta.value = line.text;
    autoGrow(ta);
    let prev = line;
    for (let i = 1; i < parts.length; i++) {
      const nl = { ...this.blank(line.t), fresh: false, text: parts[i] + (i === parts.length - 1 ? after : "") };
      this.insertAfter(prev, nl);
      prev = nl;
    }
    this.focusLine(prev.id);
    this.onChange();
  }
  onKey(e) {
    if (e.target.tagName !== "TEXTAREA") return;
    const ta = e.target;
    const { line } = this.rowOf(ta);
    if (!line) return;
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      const before = ta.value.slice(0, ta.selectionStart),
        after = ta.value.slice(ta.selectionEnd);
      line.text = before;
      ta.value = before;
      autoGrow(ta);
      const nl = this.blank();
      if (after) {
        nl.text = after;
        nl.fresh = false;
      }
      this.insertAfter(line, nl);
      this.focusLine(nl.id, false);
      this.onChange();
      return;
    }
    if (e.key === "Backspace" && ta.selectionStart === 0 && ta.selectionEnd === 0) {
      const i = this.lines.indexOf(line);
      if (i > 0) {
        e.preventDefault();
        const prev = this.lines[i - 1];
        const caret = prev.text.length;
        prev.text += line.text;
        prev.important = prev.important || line.important;
        this.lines.splice(i, 1);
        this.root.querySelector(`.note-row[data-id="${line.id}"]`).remove();
        const pta = this.root.querySelector(`.note-row[data-id="${prev.id}"] textarea`);
        pta.value = prev.text;
        autoGrow(pta);
        this.root.querySelector(`.note-row[data-id="${prev.id}"]`).classList.toggle("important", prev.important);
        pta.focus();
        pta.setSelectionRange(caret, caret);
        this.onChange();
      }
      return;
    }
    if (e.key === "ArrowUp" && ta.selectionStart === 0) {
      const i = this.lines.indexOf(line);
      if (i > 0) {
        e.preventDefault();
        this.focusLine(this.lines[i - 1].id);
      }
      return;
    }
    if (e.key === "ArrowDown" && ta.selectionStart === ta.value.length) {
      const i = this.lines.indexOf(line);
      if (i < this.lines.length - 1) {
        e.preventDefault();
        this.focusLine(this.lines[i + 1].id, false);
      }
      return;
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === "j" || e.key === "J")) {
      e.preventDefault();
      this.toggleImportant(line);
    }
  }
  onClick(e) {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    const { line } = this.rowOf(btn);
    if (!line) return;
    if (btn.dataset.act === "star") this.toggleImportant(line);
    if (btn.dataset.act === "seek") this.onSeek(line.t);
  }
  toggleImportant(line) {
    line.important = !line.important;
    if (line.fresh && !line.text) {
      line.t = this.now();
      this.updateStamp(line);
      line.fresh = false;
    }
    const row = this.root.querySelector(`.note-row[data-id="${line.id}"]`);
    row.classList.toggle("important", line.important);
    row.querySelector(".note-star").setAttribute("aria-pressed", String(line.important));
    this.onChange();
  }
  // Adds a new important mark at the current recording time (from the record bar button/hotkey).
  markNow(label = "") {
    const last = this.lines[this.lines.length - 1];
    const t = this.now();
    let target;
    if (last && !last.text.trim() && !last.important) {
      target = last;
      target.t = t;
      target.fresh = false;
      target.important = true;
      target.text = label;
      this.render();
    } else {
      target = { ...this.blank(t), fresh: false, important: true, text: label };
      this.lines.push(target);
      this.root.insertAdjacentHTML("beforeend", this.rowHtml(target));
    }
    this.focusLine(target.id);
    this.onChange();
    return target;
  }
}

export function autoGrow(ta) {
  if (!ta) return;
  ta.style.height = "auto";
  ta.style.height = `${ta.scrollHeight}px`;
}
