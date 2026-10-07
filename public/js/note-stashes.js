export function noteStashKey(sessionId, tabId) {
  return `lns.notes.${sessionId}.${tabId}`;
}

// Adopt another tab's draft into this tab without losing this tab's unsaved notes: the current draft (if any) is
// first set aside under its own "kept-N" key, which later mounts offer like any other draft. The adopted foreign
// key is removed only after the copy into this tab's key succeeded.
export function adoptDraft(storage, { sessionId, ownKey, foreignKey, current, adopted }) {
  let keptKey = null;
  // Same "worth keeping" rule as the editor/markdown: a line with text OR an important mark (marks can be empty).
  if (current && Array.isArray(current.lines) && current.lines.some((l) => (l.text || "").trim() || l.important)) {
    for (let n = 1; keptKey === null || storage.getItem(keptKey) !== null; n++) {
      keptKey = noteStashKey(sessionId, `kept-${n}`);
    }
    storage.setItem(keptKey, JSON.stringify(current));
  }
  storage.setItem(ownKey, JSON.stringify(adopted));
  if (foreignKey !== ownKey) storage.removeItem(foreignKey);
  return keptKey;
}

export function listNoteStashes(storage, sessionId, tabId) {
  const legacy = `lns.notes.${sessionId}`;
  const own = noteStashKey(sessionId, tabId);
  const old = storage.getItem(legacy);
  if (old !== null) {
    let destination = storage.getItem(own) === null ? own : noteStashKey(sessionId, 'legacy');
    for (let suffix = 2; storage.getItem(destination) !== null; suffix++)
      destination = noteStashKey(sessionId, `legacy-${suffix}`);
    storage.setItem(destination, old);
    storage.removeItem(legacy);
  }
  const prefix = `${legacy}.`;
  const drafts = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (!key?.startsWith(prefix)) continue;
    try {
      const raw = JSON.parse(storage.getItem(key));
      const draft = Array.isArray(raw) ? { revision: 0, lines: raw } : raw;
      if (Array.isArray(draft?.lines)) drafts.push({ key, revision: draft.revision,
        lines: draft.lines, legacy: Array.isArray(raw) });
    } catch { /* retain malformed data for manual recovery */ }
  }
  return { own, drafts };
}
