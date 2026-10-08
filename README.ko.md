<p><img src="assets/logo.svg" alt="" width="72" height="72"></p>

# Lecture Notes Studio

내 컴퓨터에서 녹음하고, 받아쓰고, 필기를 정리하는 웹 앱입니다. 화면은 한국어로 제공됩니다. [English README](README.md).

![가상 세션 화면](assets/screenshot.png)

Node.js 22 이상, `ffmpeg`/`ffprobe`, 실행 중인 OpenCodex 또는 호환 가능한 받아쓰기·채팅 API가 필요합니다. 기본 모델은 설정에서 바꿀 수 있습니다.

```sh
git clone https://github.com/lidge-jun/ocx-dictation-web.git
cd ocx-dictation-web
npm start
```

<http://127.0.0.1:10210>을 여세요. 서버는 로컬 주소에서만 연결을 받습니다. 설정 파일은 `~/.ocx-dictation/config.json`, 녹음 파일은 `~/.ocx-dictation/data/sessions/`에 저장됩니다. `node bin/ocx-dictation.mjs paths [--json]`으로 실제 경로를 확인하세요. `doctor`는 도구·서버·키 설정을 점검합니다. `start --port N`은 이번 실행의 포트를 바꿉니다. 기존 설치는 백업하고 중지한 뒤 `node bin/ocx-dictation.mjs migrate --from <예전-폴더> --dry-run`으로 먼저 확인하고, `--dry-run` 없이 복사·검증하세요. 이전 파일은 삭제하지 않습니다.

받아쓰기와 AI 노트 내용은 지정한 모델 서버로 전송됩니다. 별도의 사용량 수집 기능은 없습니다. API 키는 브라우저로 보내지 않습니다. 자세한 설정은 [configuration](docs/configuration.md), 보안 신고는 [SECURITY](SECURITY.md)를 참고하세요.
