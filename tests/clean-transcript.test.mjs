// node tests/clean-transcript.test.mjs  -- checks the hallucination filter + WAV level parser in server.mjs
import assert from "node:assert/strict";
import { cleanTranscript } from "../lib/transcribe.mjs";
import { wavLevel } from "../lib/audio.mjs";
const junk = [
  "시청해주셔서 감사합니다.",
  "구독해 주셔서 감사합니다",
  "오늘도 시청해주셔서 정말 감사합니다!",
  "감사합니다. 감사합니다.",
  "MBC 뉴스 김철수입니다.",
  "자막 제공: 배달의 민족",
  "구독과 좋아요 부탁드립니다",
  "다음 영상에서 만나요",
  "Thank you for watching.",
];
for (const j of junk) assert.equal(cleanTranscript(j, ""), "", j);
const keep = [
  "오늘 수업 들어줘서 감사합니다. 다음 시간에는 헥셔-올린 모형을 봅니다.",
  "감사합니다라는 표현이 이 문맥에서 중요한 이유는 뭘까요?",
  "비교우위는 기회비용이 더 낮은 재화에 특화하는 것입니다.",
];
for (const k of keep) assert.equal(cleanTranscript(k, ""), k, k);
assert.equal(cleanTranscript("네 네 네 네 네 네 네 네", ""), "네");
assert.equal(cleanTranscript("립진스키 정리, 스톨퍼 사무엘슨", "용어집: 립진스키 정리, 스톨퍼 사무엘슨"), ""); // prompt echoed back on silence
assert.equal(cleanTranscript("립진스키 정리", "용어집: 립진스키 정리"), "립진스키 정리"); // short real term kept
const silent = Buffer.alloc(44 + 32000);
silent.write("RIFF", 0);
silent.write("WAVE", 8);
silent.write("data", 36);
silent.writeUInt32LE(32000, 40);
assert.equal(wavLevel(silent).peak, 0);
console.log("ok", junk.length + keep.length + 2, "cases");
