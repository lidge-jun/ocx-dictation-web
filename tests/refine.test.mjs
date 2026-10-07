// node --test tests/refine.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { validateRefined, groupWindows, windowReady, chunkForCall, buildRefineMessages } from "../lib/refine.mjs";
import { buildTranscribePrompt, courseContext, normRefine } from "../lib/prompts.mjs";

const seg = (index, text, status = "done") => ({ index, start: index * 30, end: index * 30 + 30, text, status });
const sent = [
  seg(3, "오늘은 핵사 올린 모형을 음 배웁니다 그러니까 요소 부존도가 중요하고요"),
  seg(4, "레온 티에프 역설도 같이 보겠습니다 이건 시험에 나와요"),
];

test("valid mapping passes", () => {
  const r = validateRefined(
    JSON.stringify({
      segments: [
        { id: 3, text: "오늘은 헥셔-올린 모형을 배웁니다. 그러니까 요소 부존도가 중요하고요." },
        { id: 4, text: "레온티에프 역설도 같이 보겠습니다. 이건 시험에 나와요." },
      ],
    }),
    sent,
  );
  assert.equal(r.ok, true);
  assert.equal(r.map.get(3).startsWith("오늘은 헥셔"), true);
});
test("code fences are tolerated", () => {
  const r = validateRefined(
    "```json\n" +
      JSON.stringify({
        segments: [
          { id: 4, text: "레온티에프 역설도 같이 보겠습니다. 이건 시험에 나와요." },
          { id: 3, text: "오늘은 헥셔-올린 모형을 배웁니다. 요소 부존도가 중요하고요." },
        ],
      }) +
      "\n```",
    sent,
  );
  assert.equal(r.ok, true);
});
test("count mismatch rejected", () => {
  const r = validateRefined({ segments: [{ id: 3, text: "x".repeat(30) }] }, sent);
  assert.equal(r.ok, false);
  assert.match(r.reason, /구간 수/);
});
test("unknown id rejected", () => {
  const r = validateRefined(
    {
      segments: [
        { id: 3, text: sent[0].text },
        { id: 9, text: sent[1].text },
      ],
    },
    sent,
  );
  assert.equal(r.ok, false);
  assert.match(r.reason, /id 9/);
});
test("duplicate id rejected", () => {
  const r = validateRefined(
    {
      segments: [
        { id: 3, text: sent[0].text },
        { id: 3, text: sent[0].text },
      ],
    },
    sent,
  );
  assert.equal(r.ok, false);
});
test("summarized (too short) rejected", () => {
  const r = validateRefined(
    {
      segments: [
        { id: 3, text: "헥셔-올린." },
        { id: 4, text: sent[1].text },
      ],
    },
    sent,
  );
  assert.equal(r.ok, false);
  assert.match(r.reason, /길이 비율/);
});
test("padded (too long) rejected", () => {
  const r = validateRefined(
    {
      segments: [
        { id: 3, text: sent[0].text + " 추가 설명: ".repeat(10) },
        { id: 4, text: sent[1].text },
      ],
    },
    sent,
  );
  assert.equal(r.ok, false);
});
test("empty output for non-empty input rejected", () => {
  const r = validateRefined(
    {
      segments: [
        { id: 3, text: "" },
        { id: 4, text: sent[1].text },
      ],
    },
    sent,
  );
  assert.equal(r.ok, false);
});
test("non-JSON rejected", () => {
  assert.equal(validateRefined("죄송하지만", sent).ok, false);
});
test("bare array accepted", () => {
  assert.equal(
    validateRefined(
      [
        { id: 3, text: sent[0].text },
        { id: 4, text: sent[1].text },
      ],
      sent,
    ).ok,
    true,
  );
});

test("windows group by start time", () => {
  const segs = Array.from({ length: 13 }, (_, i) => seg(i, "a"));
  const g = groupWindows(segs, 300);
  assert.deepEqual([...g.keys()], [0, 1]);
  assert.equal(g.get(0).length, 10);
  assert.equal(g.get(1).length, 3);
  assert.equal(groupWindows(segs, "end").get(0).length, 13);
  assert.equal(groupWindows(segs, 60).size, 7);
});
test("window readiness", () => {
  const list = Array.from({ length: 10 }, (_, i) => seg(i, "a"));
  assert.equal(windowReady(list, 0, 300, { recordedUntil: 300, stopped: false }), true);
  assert.equal(windowReady(list, 0, 300, { recordedUntil: 270, stopped: false }), false);
  assert.equal(windowReady(list.slice(0, 3), 1, 300, { recordedUntil: 390, stopped: false }), false);
  assert.equal(windowReady(list.slice(0, 3), 1, 300, { recordedUntil: 390, stopped: true }), true);
  const pending = [...list.slice(0, 9), seg(9, "", "transcribing")];
  assert.equal(windowReady(pending, 0, 300, { recordedUntil: 400, stopped: true }), false);
  assert.equal(windowReady(list, 0, "end", { recordedUntil: 900, stopped: false }), false);
  assert.equal(windowReady(list, 0, "end", { recordedUntil: 900, stopped: true }), true);
});
test("chunking keeps boundaries under budget", () => {
  const list = Array.from({ length: 30 }, (_, i) => seg(i, "가".repeat(900)));
  const ch = chunkForCall(list, 5000);
  assert.ok(ch.length > 1);
  assert.equal(ch.flat().length, 30);
  for (const c of ch) assert.ok(c.reduce((n, g) => n + g.text.length + 20, 0) <= 5000);
});
test("refine messages mention json and skip empty segments", () => {
  const { messages, sent: s2 } = buildRefineMessages({
    systemBase: "sys",
    context: "과목: BIO101",
    prevTail: "앞 문장",
    segs: [seg(1, "a b"), seg(2, "")],
  });
  assert.equal(s2.length, 1);
  assert.match(messages[1].content, /json/);
  assert.match(messages[1].content, /앞 문장/);
});

test("transcribe prompt stays under 16 KiB and keeps the tail", () => {
  const p = buildTranscribePrompt({ base: "기".repeat(10000), context: "용어집: 헥셔-올린", prevTail: "끝부분 문장" });
  assert.ok(Buffer.byteLength(p, "utf8") <= 15000);
  assert.ok(p.endsWith("끝부분 문장"));
});
test("course context merges glossaries without duplicates", () => {
  const c = courseContext(
    "BIO101",
    { name: "생물학", professor: "Prof. Example", topics: "세포", glossary: "DNA, RNA" },
    "DNA, ATP",
  );
  assert.match(c, /과목: BIO101 생물학/);
  assert.match(c, /교수: Prof. Example/);
  assert.equal((c.match(/DNA/g) || []).length, 1);
  assert.match(c, /ATP/);
});
test("normRefine", () => {
  assert.deepEqual(normRefine({}), { enabled: false, interval: 300 });
  assert.deepEqual(normRefine({ enabled: 1, interval: "180" }), { enabled: true, interval: 180 });
  assert.deepEqual(normRefine({ enabled: true, interval: "end" }), { enabled: true, interval: "end" });
  assert.deepEqual(normRefine({ interval: 7 }), { enabled: false, interval: 300 });
});
