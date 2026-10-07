const ID = "[0-9]{8}-[0-9]{6}-[0-9a-f]{4}";
const SEG = "(?:0|[1-9][0-9]{0,5})";
const session = (suffix) => new RegExp(`^/api/sessions/(${ID})${suffix ? `/${suffix}` : ""}$`);
function buildSpec(h) {
  return [
    ["GET", /^\/api\/health$/, "none", h.health],
    ["GET", /^\/api\/config$/, "none", h.config],
    ["GET", /^\/api\/models$/, "none", h.models],
    ["GET", /^\/api\/courses$/, "none", h.courses],
    ["GET", /^\/api\/prompts$/, "none", h.getPrompts],
    ["PUT", /^\/api\/prompts$/, "json", h.putPrompts],
    ["GET", /^\/api\/sessions$/, "none", h.listSessions],
    ["POST", /^\/api\/sessions$/, "json", h.createSession],
    ["POST", /^\/api\/upload$/, "upload", h.upload],
    ["GET", session(""), "none", h.getSession],
    ["PATCH", session(""), "json", h.patchSession],
    ["DELETE", session(""), "none", h.deleteSession],
    ["GET", session("events"), "none", h.events],
    ["POST", session("segments"), "segment", h.segment],
    ["GET", session(`segments/(${SEG})/audio`), "none", h.segmentAudio],
    ["HEAD", session(`segments/(${SEG})/audio`), "none", h.segmentAudio],
    ["POST", session(`segments/(${SEG})/retry`), "none", h.retrySegment],
    ["POST", session("retry-failed"), "none", h.retryFailed],
    ["POST", session("refine"), "json", h.refine],
    ["GET", session("prompts"), "none", h.appliedPrompts],
    ["PATCH", session("transcript"), "json", h.patchTranscript],
    ["PUT", session("notes"), "json", h.putNotes],
    ["PUT", session("ai-note"), "json", h.putAiNote],
    ["POST", session("finalize"), "none", h.finalize],
    ["GET", session("audio"), "none", h.audio],
    ["HEAD", session("audio"), "none", h.audio],
    ["POST", session("generate"), "json", h.generate],
    ["POST", session("ask"), "json", h.ask],
    ["GET", session("export"), "none", h.export],
    ["GET", session("vault"), "none", h.vaultPreview, h.vaultGate],
    ["POST", session("vault"), "json", h.vaultWrite, h.vaultGate],
  ];
}
export function createRoutes({
  cfg,
  publicConfig,
  store,
  prompts,
  sse,
  audio,
  transcriber,
  notes,
  ai,
  exporter,
  http,
}) {
  const h = {
    ...transcriber.handlers,
    ...ai.handlers,
    ...prompts.handlers,
    ...store.handlers,
    ...sse.handlers,
    ...audio.handlers,
    ...notes.handlers,
    ...exporter.handlers,
    config: ({ res }) => http.send(res, 200, publicConfig(cfg)),
  };
  const table = buildSpec(h);
  return {
    async dispatch(ctx) {
      const row = table.find(([method, re]) => method === ctx.req.method && re.test(ctx.url.pathname));
      if (!row) return http.send(ctx.res, 404, { error: "찾을 수 없어요", requestId: ctx.requestId });
      const params = row[1].exec(ctx.url.pathname).slice(1);
      if (params[1] && Number(params[1]) > 100000)
        return http.send(ctx.res, 404, { error: "찾을 수 없어요", requestId: ctx.requestId });
      if (row[4] && await row[4]({ ...ctx, params })) return;
      const body =
        row[2] === "json"
          ? await http.readJson(ctx.req)
          : row[2] === "segment"
            ? await http.readBody(ctx.req, http.limits.segment)
            : undefined;
      return row[3]({ ...ctx, params, body });
    },
  };
}
