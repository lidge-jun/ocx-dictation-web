import { $, api, esc, toast, confirmDialog } from "./util.js";

export async function openVaultDialog(id) {
  const dlg = $("#vaultDlg"), body = $("#vaultBody"), submit = $("#vaultSubmit");
  let preview;
  try { preview = await api(`/api/sessions/${id}/vault`); }
  catch (err) { toast(err.message, { error: true }); return; }
  body.innerHTML = `
    <p class="muted">설정한 노트 폴더 안의 상대 경로예요.</p>
    <p class="path mono">${esc(preview.notePath)}</p>
    ${preview.exists.note ? '<p class="warn">이 이름의 노트가 이미 있어요.</p>' : ""}
    ${preview.rawPath ? `<label class="check"><input type="checkbox" id="vaultRaw"> 원문 대본도 저장
      <span class="mono small muted">${esc(preview.rawPath)}</span></label>` : ""}
    ${preview.exists.raw ? '<p class="warn small">원문 대본 파일도 이미 있어요.</p>' : ""}`;
  submit.disabled = false;
  dlg.showModal();
  $("#vaultCancel").onclick = () => dlg.close();
  $("#vaultForm").onsubmit = async (event) => {
    event.preventDefault();
    const includeRaw = $("#vaultRaw")?.checked || false;
    let overwrite = false;
    if (preview.exists.note || (includeRaw && preview.exists.raw)) {
      overwrite = await confirmDialog("기존 파일을 덮어쓸까요?",
        "같은 경로의 파일이 있어요. 계속하면 기존 내용을 덮어써요.", "덮어쓰기");
      if (!overwrite) return;
    }
    submit.disabled = true;
    try {
      const result = await api(`/api/sessions/${id}/vault`, {
        method: "POST", json: { includeRaw, overwrite },
      });
      dlg.close();
      toast(`노트 폴더에 저장했어요: ${result.notePath}`, { ms: 5000 });
    } catch (err) {
      if (err.status === 409) toast("그 사이 파일이 생겼어요. 다시 열어 경로를 확인해 주세요.", { error: true });
      else toast(err.message, { error: true, ms: 6000 });
    } finally { submit.disabled = false; }
  };
}
