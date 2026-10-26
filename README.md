# autoguide

에이전트가 웹사이트를 직접 탐색하고, 만들 가이드를 고르고, 실제로 수행해 본 뒤 그 실행을 네 가지 가이드로 만드는 프로토타입이야. 네 가지는 내레이션 영상, 단계별 캡처 글, 클릭해 보는 데모, Reflow 화면 위 가이드야.

기획 문서는 [docs/PLAN.md](docs/PLAN.md), 최신 실행 결과는 [runs/results.md](runs/results.md), 결과물 갤러리는 `runs/index.html`에 있어.

## 파이프라인

```
explore → plan → perform → compile(+verify) → film → narrate → render → docs → reflow
```

| 단계 | 하는 일 | 코드 |
|---|---|---|
| explore | LLM 없이 도는 읽기 전용 크롤링이야. 링크를 따라가고, 생성·설정·메뉴·탭·접힌 버튼은 열어 본 뒤 닫아(제출하지 않음). 결과는 화면 지도와 API 엔드포인트 목록이야 | `src/explore.mjs` |
| plan | 화면별 요약을 만들고, 근거 화면 ID가 붙은 워크플로우 카탈로그를 뽑아. 성공 기준과 샘플 데이터는 실행 전에 정해 | `src/plan.mjs` |
| perform | LLM 에이전트가 브라우저를 조작해. 액션마다 로케이터 묶음, 스크린샷, 네트워크 변경을 기록하고 안전 게이트를 거쳐. 별도 판정 모델이 성공 여부를 정해 | `src/perform.mjs`, `src/safety.mjs` |
| compile | 헛걸음을 지우고, 형식별 문구(제목·안내문·내레이션)를 써. 그다음 DB를 복원하고 모델 없이 결정론적으로 재실행해서 검증해 | `src/compile.mjs`, `src/replay.mjs` |
| film | 스톱모션 촬영이야. 동작 단위마다 DPR 2 스틸을 찍고, 대상·영역 좌표를 기록해 | `src/replay.mjs` |
| narrate | 문장별 TTS를 만들어(OpenAI 또는 ElevenLabs). 실제 길이를 재서 쓰고 캐시해 | `src/tts.mjs`, `src/narrate.mjs` |
| render | 영상을 합성해. 가상 카메라, 커서, 클릭 효과, 강조, 자막(SRT/VTT), 챕터가 들어가 | `render/video.py` |
| docs | 캡처 글(HTML·Markdown)과 인터랙티브 데모 HTML을 만들어 | `src/docs.mjs`, `src/py/stills.py` |
| reflow | Reflow 녹화기 코드(`content.js buildTargetRef`)로 대상을 기술해서 Reflow 가이드 패키지를 만들어. 그다음 Reflow 실제 플레이어(임베드 런타임)를 주입해서 재생을 검증해 | `src/reflow.mjs` |

## 실행

```bash
export OPENAI_API_KEY=...            # ELEVENLABS_API_KEY는 --voice elevenlabs 쓸 때만
./testapps/ctl.sh start vikunja      # 로컬 테스트 앱 (gitea도 같은 방식)

node src/cli.mjs explore vikunja --max 30
node src/cli.mjs plan vikunja [--focus "고객이 자주 묻는 업무"]
node src/cli.mjs run vikunja top:5   # perform→compile→film→narrate→render→docs→reflow
node src/report.mjs                  # runs/results.md, runs/index.html 갱신
```

- 문의 한 건에서 가이드 만들기: `node src/cli.mjs ask vikunja "팀원들이랑 같은 프로젝트를 같이 보고 싶은데 어떻게 공유하나요?"`. 질문을 업무 명세로 바꿔 `run`까지 이어서 해.
- 최신화(Replay): `node src/cli.mjs maintain gitea top:5`. 모델 없이 다시 실행해서 단계마다 같음/이름 바뀜/사라짐을 판정해. 바뀐 가이드는 문구를 갱신하고 4형식을 다시 만든 뒤 `REVIEW_REQUIRED`로 멈춰(`maintenance.json`, `script.vN.json`).
- 워크플로우 선택: `top:N`(가치 순), `all`, 또는 `id1,id2`.
- 고객이 직접 지정한 업무는 `sites/<site>.workflows.json`에 두면 플래너 카탈로그 대신 그걸 써. 홈택스 예시가 이 방식이야.
- 단계 하나만 돌리려면 `node src/cli.mjs <perform|compile|film|narrate|render|docs|reflow|refs> <site> <spec>`.
- 모델 비교: `perform ... --model gpt-6-luna --tag luna`로 하면 결과가 `perform-luna/`에 따로 쌓여.

## 사이트 설정 (`sites/*.json`)

- `siteMode: "sandbox"`: 테스트 앱이나 테스트 계정이야. 승인된 생성·수정을 허용하고, 실행 전에 DB 스냅샷을 복원해(`reset`).
- `siteMode: "live"`: 실서비스야. 읽기 업무만 해. 비가역 동작은 실행하지 않고 ghost 단계로만 찍어.
- `login`: 세션을 시작할 때 로그인 상태를 확인해. 풀려 있으면 다시 로그인하고 최신 상태를 저장해. refresh 토큰을 회전시키는 앱 대응이야.

## 처음 받았을 때 준비

저장소에는 앱 실행 파일과 DB, 실행 산출물(`runs/`)이 들어 있지 않아. 처음 한 번 아래를 실행해.

```bash
npm install                                   # playwright, openai
npx playwright install chromium
# Vikunja 2.7.1, Gitea 28.2 실행 파일 받기
curl -sL -o /tmp/vikunja.zip https://github.com/go-vikunja/vikunja/releases/download/v2.7.1/vikunja-v2.7.1-linux-amd64-full.zip
unzip -o /tmp/vikunja.zip -d testapps/vikunja
curl -sL -o testapps/gitea/gitea https://dl.gitea.com/gitea/28.2.0/gitea-28.2.0-linux-amd64 && chmod +x testapps/gitea/gitea
# DB 초기화, demo 계정, 샘플 데이터, 기준 스냅샷
(cd testapps/vikunja && source env.sh && export VIKUNJA_SERVICE_SECRET=$VIKUNJA_SERVICE_JWTSECRET && ./vikunja-v2.7.1-linux-amd64 migrate && ./vikunja-v2.7.1-linux-amd64 user create -u demo -e demo@example.com -p 'DemoPass!2026')
(cd testapps/gitea && ./gitea --config custom/conf/app.ini migrate && ./gitea --config custom/conf/app.ini admin user create --admin --username demo --password 'DemoPass!2026' --email demo@example.com --must-change-password=false)
./testapps/ctl.sh start vikunja && ./testapps/ctl.sh start gitea
node testapps/seed.mjs all
./testapps/ctl.sh snapshot vikunja base && ./testapps/ctl.sh snapshot gitea base
```

- `env.sh`와 `app.ini` 안의 경로는 이 머신 기준(`/home/jay/...`)이야. 다른 위치에 받았으면 그 부분만 고쳐.
- 환경 변수: `OPENAI_API_KEY`는 필수야. ElevenLabs 음성을 쓸 때만 `ELEVENLABS_API_KEY`가 필요해. Reflow 연동은 `REFLOW_SRC`(Reflow 확장 소스 경로)를 써.

## 테스트 앱 (`testapps/`)

- Vikunja 2.7.1(할 일·프로젝트 관리, Vue SPA)과 Gitea 28.2(코드 호스팅, 서버 렌더)를 sqlite로 로컬에서 돌려.
- `seed.mjs`로 한국어 샘플 데이터를 넣어.
- `ctl.sh snapshot|restore <app>`로 초기 상태를 저장하고 복원해. WAL 체크포인트까지 포함해.
- 계정은 `demo` / `DemoPass!2026`(로컬 전용)이야.

## 의존성

Node 22, Playwright 1.64(Chromium 1248), openai SDK 7, Python 3.12, OpenCV, Pillow, ffmpeg 6, 그리고 Pretendard 또는 Nanum 폰트가 필요해. Reflow 연동은 `REFLOW_SRC`(기본 `/home/jay/Business/Dev/Reflow-CTO/reflowguide`)의 `content.js`, `content-player.js`, `embed/*`를 읽기만 하고 수정하지 않아.
