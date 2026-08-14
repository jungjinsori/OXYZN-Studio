# OXYZN Studio — 개발자 인수 문서

전신 FLIMFILM Studio `v1048` / `2.0.98` 에서 갈라져 개인용으로 전환한 시점 기준.
2026-08-04 작성 · 2026-08-12 개인용 전환 반영.

드라마 제작 자동화 데스크톱 앱. Electron + Vite + React 18.
외부 생성 AI(BytePlus ModelArk · fal.ai · Anthropic · Google)를 묶어 18개 작업을 제공한다.
**서버가 없다** — 로그인·계정·서버 집계를 걷어낸 1인용 앱이고, 상태는 전부 이 PC 안에 있다.

---

## 1. 먼저 알아야 할 것 (설계상 특이점)

인수받는 사람이 가장 먼저 놀라는 부분이라 앞에 둔다.

### 1-1. `src/App.jsx` 단일 파일 — 36,700줄 / 2.1MB

**앱 전체가 한 파일의 한 컴포넌트다.** `DramaAutomation` 하나에 18개 작업의
상태·핸들러·JSX가 모두 들어 있다. 컴포넌트 분리가 되어 있지 않다.

| 파일 | 줄 수 | 역할 |
|---|---|---|
| `src/App.jsx` | 36,656 | 앱 전체 (모듈 스코프 헬퍼 279개 + 단일 컴포넌트) |
| `electron/main.js` | 827 | 메인 프로세스 · IPC 17개 |
| `electron/preload.js` | 44 | contextBridge 노출 19개 (`window.electronAPI` 하나) |
| `src/main.jsx` | 52 | React 마운트 |

구조는 대략 이렇게 나뉜다. (줄 번호는 v832 기준이며 수정 시 밀린다)

```
~1–4700      상수 · 프롬프트 룰북 · 유틸
~4700–5300   ARK/fal 모델 상수, 화면비·품질 옵션
~5300–8700   프롬프트 빌더 (룰북), callClaude
~8700–9900   문서 파싱, 도식/TSV 헬퍼, Files API 헬퍼
~9900–10350  카탈로그(SINGLE_TASK_CATALOG), 라우팅 테이블
~10350–13300 컴포넌트 시작 — useState 수백 개
~13300–15200 API 키 관리, 관리자 설정 동기화
~15200–21000 API 호출 함수 · 각 작업 핸들러
~21000–22700 진행상황 추적, 알림
~22700–35500 하나의 거대한 return — 전체 JSX
```

### 1-2. TDZ 함정 — 수정 시 가장 자주 터지는 곳

컴포넌트 안에 `useState`가 수백 개 순차 선언되어 있다.
**`useEffect`의 dependency array는 렌더 시점에 평가**되므로,
선언보다 위에 있는 effect가 아래 state를 참조하면 `ReferenceError`로 죽는다.

```js
// ✗ 죽는다 — deps가 렌더 시점에 평가된다
useEffect(() => { ... }, [fooData]);   // line 11000
const [fooData, setFooData] = useState({});  // line 13000

// ✓ 안전 — 핸들러 본문은 클릭 시점에 평가된다
const handleX = () => { fooData.bar };  // 선언 위에 있어도 무관
```

**규칙:** effect를 추가할 때는 참조하는 모든 state의 선언 줄 번호를 확인하고
그보다 아래에 배치한다. 핸들러 본문은 상관없다.

### 1-3. JSX 편집 시 고아 속성 사고

거대한 JSX를 정규식으로 일괄 수정하다가 **속성이 태그 밖으로 밀려나** 텍스트 자식이 되면
`Objects are not valid as a React child`로 런타임에 죽는다. 빌드는 통과한다.

편집 후 아래 스캐너를 돌린다. (v775 사고 이후 상시 사용)

```python
import re
lines = open('src/App.jsx', encoding='utf-8').read().split('\n')
bad = [i+2 for i in range(len(lines)-1)
       if lines[i].rstrip().endswith('>') and
          re.match(r'^\s*(style|onClick|className|onChange|value|placeholder|disabled|title|type|src|alt)=', lines[i+1])]
print('고아 속성:', bad or '없음')
```

### 1-4. 라우팅이 두 갈래로 남아 있다

`SINGLE_TASK_CATALOG`(카탈로그) → `singleTaskId`로 워크스페이스를 연다.
카탈로그 18개 중 **16개는 `singleTaskId === '...'` 분기로 직접 렌더**되고,
**2개는 구버전 view 상태로 우회**한다. 마이그레이션 잔재다.
(장소 탐색이 세 번째 우회였는데 개인용 전환에서 기능째 걷어냈다.)

| 작업 | id | `currentView` |
|---|---|---|
| TTS | `sound-tts` | `tool-sound` (+ `soundMode='tts'`) |
| SRT 번역 | `etc-srt` | `tool-translate` |

우회는 **`openSingleTask` 안에 하드코딩**되어 있다. 별도 라우팅 테이블은 없다 —
`SINGLE_TASK_ROUTE` 상수가 있었지만 아무도 참조하지 않는 죽은 코드였고 v850에서 지웠다.
(이 문서의 이전 판은 그 표가 라우팅을 한다고 적고 있었다. 사실이 아니었다.)

```js
const openSingleTask = (taskId) => {
  setAppScreen('single'); setSingleTaskId(taskId);
  if (taskId === 'sound-tts') { setCurrentViewRaw('tool-sound'); setSoundMode('tts'); }
  else if (taskId === 'etc-srt') { setCurrentViewRaw('tool-translate'); }
  else setCurrentViewRaw('single-blank');
  ...
```

#### 새 워크스페이스를 추가할 때의 함정

직접 렌더 워크스페이스를 추가하면 **빈 화면 폴백의 제외 목록에도 넣어야 한다.**
그 폴백은 `singleTaskId !== 'a' && singleTaskId !== 'b' && …` 를 손으로 나열하는
구조여서, 빠뜨리면 "왼쪽 목록에서 작업을 선택하세요" 화면이 새 워크스페이스 위에
겹쳐 그려진다(v829에서 실제로 발생).

우회 2종은 `currentView`가 `single-blank`이 아니게 되므로 목록에 없어도 무해하다
(현재 `etc-srt`는 들어 있고 `sound-tts`는 없다 — 둘 다 문제 없다).

정합성은 이렇게 확인한다.

```python
import re, io
s = io.open('src/App.jsx', encoding='utf-8').read()
direct = set(re.findall(r"singleTaskId === '([a-z-]+)'", s))
i = s.index('const openSingleTask')
detour = set(re.findall(r"taskId === '([a-z-]+)'\)", s[i:i+1200]))
j = s.index("currentView === 'single-blank' && (() =>")
excluded = set(re.findall(r"singleTaskId !== '([a-z-]+)'", s[j-2200:j]))
print('제외 목록에 빠진 직접 렌더:', sorted(direct - detour - excluded) or '없음')
```

---

## 2. 작업 18종

카탈로그는 `SINGLE_TASK_CATALOG`(App.jsx ~9820)에 정의된다.
`status: 'wire'`는 구 하네스를 새 UI에 연결한 것, `'new'`는 새로 만든 것이다.

| 분류 | id | 라벨 | 렌더 | 주 API |
|---|---|---|---|---|
| 기획 | `plan-adapt` | 시나리오 각색 | 직접 | Claude |
| 기획 | `plan-scenario-analyze` | 시나리오 분석 | 직접 | Claude (map-reduce) |
| 기획 | `plan-scenario-translate` | 시나리오 번역 | 직접 | Claude |
| 기획 | `plan-video-analyze` | 영상 분석 | 직접 | Gemini |
| 이미지 | `image-custom` | 커스텀 | 직접 | fal `gpt-image-2` |
| 이미지 | `image-sheet` | 턴어라운드 시트 | 직접 | fal `gpt-image-2` |
| 이미지 | `image-character` | 캐릭터 디자인 (R) | 직접 | ARK Seedream 5.0 Pro |
| 이미지 | `image-title` | 타이틀 디자인 | 직접 | fal `gpt-image-2` |
| 이미지 | `image-poster` | 포스터 디자인 | 직접 | fal `gpt-image-2` |
| 비디오 | `video-custom` | 커스텀 | 직접 | ARK Seedance 2.0 |
| 비디오 | `video-narrative` | 내러티브 (15s) | 직접 | Claude → ARK |
| 비디오 | `video-vfx` | AI VFX | 직접 | ARK |
| 비디오 | `video-upscale` | Upscale | 직접 | fal Topaz |
| 사운드 | `sound-music` | BGM | 직접 | fal ElevenLabs Music |
| 사운드 | `sound-tts` | TTS | **view 우회** | fal MiniMax |
| 사운드 | `sound-voice` | VOICE | 직접 | fal MiniMax voice-clone |
| 기타 | `etc-srt` | SRT 번역 | **view 우회** | Claude |
| 기타 | `etc-actor-auth` | 배우 인증 | 직접 | BytePlus Assets API |

---

## 3. 외부 API

### 3-1. BytePlus ModelArk — 영상·실사 이미지

`ARK_BASE = https://ark.ap-southeast.bytepluses.com/api/v3` (싱가포르 리전)
인증 `Authorization: Bearer <ARK_API_KEY>`

| 용도 | 모델 상수 | 엔드포인트 |
|---|---|---|
| 영상 | `dreamina-seedance-2-0-260128` (+ `-fast-`, `-mini-`) | `POST /contents/generations/tasks` → `GET .../{id}` 폴링 |
| 실사 이미지 | `dola-seedream-5-0-pro-260628` | `POST /images/generations` |

**프롬프트 토큰 규약이 fal과 다르다.** ARK는 레퍼런스를 `Image 1`(공백 + 순번)으로
지칭한다. fal의 `@Image1`과 다르므로 `arkRefTokens()`가 변환한다.

#### 신뢰 자산(trusted output) — 실사 얼굴 정책

Seedance 2.0은 **실인물 얼굴이 든 임의 이미지를 레퍼런스로 받지 않는다.**
같은 계정에서 생성한 출력물만 신뢰한다. 그래서 캐릭터 디자인(R)이 파이프라인의 시작점이다.

두 개의 시계가 있고 서로 다르다.

| 시계 | 값 | 상수 |
|---|---|---|
| 결과 URL 유효기간 | 24시간 | `ARK_URL_TTL_MS` (23시간 = 1시간 안전마진) |
| 신뢰 유효기간 | 30일 | `ARK_TRUST_TTL_MS` |

URL이 죽어도 **원본 바이트가 있으면** 레퍼런스로 쓸 수 있다.
`imageUrlToRef`가 `fetch → blob → readAsDataURL`로 **재인코딩 없이** 원본을 담으므로
base64 폴백도 "원본 그대로"에 해당한다. 문서가 금지하는 것은 압축·전달로 인한 변형이다.

**미해결 이슈 2건 (인수 시 확인 필요)**

1. 문서의 신뢰 목록에는 `Dola Seedream 5.0 **Lite** text to image`만 있고
   **Pro는 없다.** 앱은 Pro를 쓰는데 실측으로는 통과한다. 문서화된 범위 밖이므로
   BytePlus가 명세대로 조이면 캐릭터 파이프라인이 막힌다.
   대비책으로 `ARK_MODELS.imageLite`를 두었다 — 한 줄 교체로 내려갈 수 있다.
2. 30일 만료가 실제로 집행되는지 확인되지 않았다. v820에서 **하드 차단을 경고로 완화**해
   30일 지난 캐릭터로 시도할 수 있게 해 뒀다. 심의 거부되면 정책이 살아있는 것이다.

#### 오디오 레퍼런스 (`reference_audio`)

wav/mp3 · 개당 2~15초 · 최대 3개 · 합계 15초 이내 · 개당 15MB 이내.
**오디오 단독 입력 불가** — 이미지/영상 레퍼런스가 최소 1개 필요하다.
음색 지정 프롬프트 공식: `"Character" says: "lines", voice timbre references "Audio n".`

#### 비용 계산

이미지는 **장당 정액**이다(토큰 아님). Pro ≤2.36M px $0.045 / >2.36M px $0.09.
출력 픽셀 범위 `[921,600 ~ 4,624,220]`.

영상은 토큰제.
`tokens = (inputVideoDur + outputDur) × W × H × 24 / 1024`
USD/M tokens — 1080p 7.7(영상입력 없음) / 4.7(있음). 최소 청구 입력 길이 약 4초.

### 3-2. fal.ai — 이미지·사운드·업스케일

`https://rest.fal.ai` · 큐 API(`falRun`이 제출 → 상태 폴링 → 결과 취득).

```
music         fal-ai/elevenlabs/music
image         openai/gpt-image-2
imageEdit     openai/gpt-image-2/edit        (레퍼런스 첨부 시 부분 수정)
voiceClone    fal-ai/minimax/voice-clone
ttsMinimax    fal-ai/minimax/speech-2.8-turbo
upscaleVideo  fal-ai/topaz/upscale/video
```

**`falRun` 주의점:** fal은 실패 사유를 **status가 아니라 result 엔드포인트**에 담는다.
status만 보면 `failure`가 문자열 `'FAILED'`로만 잡혀 원인을 알 수 없다.
그래서 FAILED 시 result 본문을 다시 받아 로깅한다.

Topaz 업스케일 비용은 **출력 해상도 기준 초당 요금**($0.01/$0.02/$0.08),
60fps는 ×2, Gaia 2는 절반. 노출 모델은 `TOPAZ_VIDEO_MODELS`에서 관리하며
Topaz가 폐기한 3종(Starlight Precise 1/2, Starlight Fast 1)은 제외했다.

### 3-3. Anthropic Claude — 텍스트 전반

`callClaude(systemPrompt, userMessage, options)` — **모듈 스코프**(App.jsx 6599).
컴포넌트 밖이라 `isAdmin` 등 컴포넌트 상태에 접근할 수 없다. 수정 시 주의.

- 529(overload) 시 `[10s, 20s, 40s, 60s, 90s]` 백오프로 최대 5회 재시도
- 긴 문서는 map-reduce로 청크 분할. `ADAPT_MAX_CHUNK_CHARS = 50000`

### 3-4. Google Gemini — 영상 분석 전용

`gemini-2.5-flash` · 입력 컨텍스트 1M 토큰.
**키는 `x-goog-api-key` 헤더로 보낸다** (v813에서 URL 쿼리에서 이전 — 로그 유출 방지).

`fileUri`가 받는 것은 **두 가지뿐**이다: Files API URI, YouTube 공개 URL.
Drive·frame.io 등 임의 링크는 `400 Cannot fetch content from the provided URL`.

#### 영상 길이 상한 — 티어에 따라 다르다

영상 토큰 소모: 기본 해상도 **초당 300**(프레임 258 + 오디오 32), 저해상도 **초당 100**.

| 티어 | 기본 해상도 | 저해상도(`MEDIA_RESOLUTION_LOW`) | 막는 것 |
|---|---|---|---|
| 무료 | 약 12분 | 약 38분 | 분당 입력 25만 토큰 |
| 유료 | 약 53분 | 약 2시간 40분 | 1M 컨텍스트 |

무료 티어 실측 한도(429 응답이 알려준 값):

```
GenerateRequestsPerMinutePerProjectPerModel-FreeTier      = 5
GenerateContentInputTokensPerModelPerMinute-FreeTier      = 250000
```

일일 한도(RPD)는 미확인. 문서가 공개하지 않고 프로젝트마다 다르다.
태평양 자정(한국시간 오후 4~5시)에 갱신된다. 한도는 **키 단위가 아니라 프로젝트 단위**다.

`vaPlanFor()`가 길이·티어로 해상도·타임아웃·추정치를 계산한다.
무료 티어 429를 한 번 보면 `localStorage.flimfilm_gemini_tier = 'free'`로 기억해
이후에는 업로드 전에 걸러낸다.

#### Files API (파일 업로드 경로)

무료 · 파일당 2GB(문서) / 프로젝트 20GB · 48시간 후 자동 삭제.
**실측:** 업로드 세션 선언 크기는 10GB까지 발급되고 25GB는 429(할당량)다.
즉 실제로 막는 것은 프로젝트 20GB 쪽이라 앱은 20GB에서 차단하고 2GB 초과는 경고만 한다.

비공개성 확인: 키 없음 403 / 다른 키 403 / 정상 키 200. 공개 링크가 생기지 않는다.
`uploadVideoToGemini()`가 resumable start → 바이트 전송(XHR, 진행률용) → `ACTIVE` 폴링을 처리하고,
분석 후 `finally`에서 `deleteGeminiFile()`로 즉시 삭제한다.

**약관 주의:** 무료 티어는 Google이 제품 개선에 사용하고 사람이 검토할 수 있다
(`"Do not submit sensitive, confidential, or personal information to the Unpaid Services"`).
공개 전 자료를 다루려면 유료 티어가 전제다.

### 3-5. 기타

- `open.er-api.com` — 환율

---

## 4. 인증 · 데이터 — 없음 (개인용 전환)

전신 FLIMFILM Studio 에 있던 **Supabase 인증과 서버 데이터 계층은 전부 제거했다.**

| 제거한 것 | 대신 |
|---|---|
| 로그인 · 세션 · 자동로그인 | 없음. 앱을 켜면 바로 작업 화면 |
| 계정 · 팀 · 관리자 권한(`profiles`) | 없음. 쓰는 사람은 한 명 |
| 관리자 대시보드 · 계정별 크레딧 뷰 | 없음 |
| 서버 크레딧 집계(`usage_events`) | localStorage `oxyzn_credit_log` |
| API 키 서버 보관(`app_settings`) | localStorage (기기별) |

### 크레딧 집계는 남아 있다

`recordCreditUsage(costUsd, category, { workCat })` 가 localStorage 에 누적한다.
계정 개념이 없어져 저장 구조의 계정 키는 `localAccountKey()` 가 돌려주는 `'local'`
하나로 고정된다. 맵 구조 자체를 안 걷어낸 이유는 집계·복원 코드가 전부 그 형태를
전제로 짜여 있어서다.

`설정 → 크레딧 소모량` 에서 오늘/이번 주/이번 달/전체를 작업 영역별(기획·이미지·
비디오·사운드·기타)로 본다. `resetCreditLog()` 로 비운다.

번들 ID 가 `com.oxyzn.studio` 라 Electron `userData` 가 전신과 완전히 분리된다.

---

## 5. Electron 계층

### IPC 17개 (`electron/main.js`)

```
아카이브   archive-list · archive-open · archive-download · archive-delete
          archive-trash · archive-trash-list · archive-restore · archive-purge
다운로드   downloads-list · downloads-reveal · set-download-category
파일       open-path · ffs-name · export-pdf
영상       youtube-duration · ytdlp-extract
외부 API   ark-openapi
```

`preload.js`가 `contextBridge`로 `window.electronAPI`에 21개를 노출한다.
하위 호환용 `window.electron`도 남아 있다.

#### `ark-openapi` — BytePlus 서명 호출 (v832)

배우 인증(Assets API)만 이 경로를 쓴다. 나머지 외부 API는 전부 렌더러에서 직접 호출한다.
여기만 메인 프로세스인 이유는 세 가지다.

1. **HMAC-SHA256 서명이 필요하다.** Assets API는 Bearer 키를 받지 않고 AK/SK 서명만 받는다.
   Node `crypto`는 개발 실행과 패키징 빌드에서 동일하게 동작하지만, 렌더러의
   `crypto.subtle`은 secure context를 요구해 `file://`로 로드되는 패키징 빌드에서
   보장된다고 볼 수 없다.
2. Secret Access Key가 페이지 컨텍스트의 네트워크 경로를 타지 않는다.
3. 이 게이트웨이(`ark.ap-southeast-1.byteplusapi.com`)는 CORS 헤더를 주지 않는다.
   기존 ARK 호출이 렌더러에서 되는 건 `bytepluses.com/api/v3`가 OpenAI 호환
   엔드포인트라서다. 같은 회사 API지만 게이트웨이가 다르다.

신뢰 경계는 두 겹이다. 호스트는 리전 맵으로 고정하고(렌더러가 임의 호스트로 서명 요청을
보낼 수 없다), Action은 화이트리스트로 제한한다. `Delete*`/`Update*`/`CreateAsset`은
목록에 없어서 오작동으로 자산이 지워질 수 없다.

서명 규격(`docs.byteplus.com/en/docs/byteplus-platform/reference-how-to-calculate-a-signature`):

```
CanonicalRequest = METHOD \n URI \n Query \n CanonicalHeaders \n SignedHeaders \n hex(sha256(body))
StringToSign     = "HMAC-SHA256" \n X-Date \n {YYYYMMDD}/{region}/{service}/request \n hex(sha256(CanonicalRequest))
kDate=HMAC(SK,date) → kRegion → kService → kSigning=HMAC(kService,"request")
Signature        = hex(HMAC(kSigning, StringToSign))
```

AWS SigV4와 달리 SK에 `AWS4` 접두어를 붙이지 않는다. 구현은 문서의 공식 예제
(`reference-example`)에 실린 CanonicalRequest 해시
`4809ff4a...b6ae020`과 바이트 단위로 일치함을 확인했다 — 헤더 블록과 SignedHeaders
사이에 빈 줄이 하나 들어가는 규격까지 포함해서다.

### 아카이브

`ARCHIVE_MAX = 300` 전체 상한, 분류별 하위 폴더(`plan`/`image`/`video`/`sound`/`etc`),
초과 시 FIFO로 삭제. 렌더러가 활성 워크스페이스에 맞춰 `set-download-category`를 호출한다.

### Windows 하드닝 (v788)

Windows 파일시스템 제약을 정면으로 처리한다. 수정 시 이 함수들을 우회하지 말 것.

| 함수 | 처리하는 문제 |
|---|---|
| `safeFileName` | 예약어(CON/PRN/AUX/NUL/COM1-9/LPT1-9), 끝 점·공백, 160바이트 상한 |
| `fitPathLength` | MAX_PATH 260 |
| `retrySync` | EBUSY/EPERM/EACCES/ENOENT 백오프 재시도 (바이러스 검사·인덱서 충돌) |
| `collisionFreePath` | 동명 파일 |
| `moveFileTo` | EXDEV 시 copy+unlink 폴백 (다른 볼륨) |
| `downloadsSignature` + `startDownloadsPolling` | OneDrive 리디렉션 폴더에서 watcher가 안 먹어 4초 폴링 병행 |

### `file://` URL 생성 — `toFileUrl` (v807)

Windows 경로를 그대로 인코딩하면 깨진다. 백슬래시 때문에 전체가 한 세그먼트가 되고
드라이브 콜론이 퍼센트 인코딩된다(`file://C%3A%5CUsers%5C...`). 또 슬래시가 2개면
`C:`를 호스트로 해석한다.

```js
const toFileUrl = (p) => {
  const raw = String(p ?? '').replace(/\\/g, '/');
  if (!raw) return '';
  if (/^[a-z]+:\/\//i.test(raw)) return raw;
  const parts = raw.split('/').map(seg => (/^[A-Za-z]:$/.test(seg) ? seg : encodeURIComponent(seg)));
  let joined = parts.join('/');
  if (!joined.startsWith('/')) joined = '/' + joined;
  return 'file://' + joined;          // 슬래시 3개 보장
};
```

미리보기를 다루는 3곳(다운로드 그리드 · 아카이브 `toPreview` · 아카이브 그리드)에서 쓴다.

---

## 6. 빌드 · 배포

```bash
npm run dev            # Vite 만 (5173)
npm run electron:dev   # Vite + Electron (이미 5173 점유 중이면 충돌 — electron . 만 실행)
npm run build          # 렌더러만
npm run build:win      # 버전 bump + 렌더러 + Windows nsis
npm run build:mac      # 버전 bump + 렌더러 + macOS dmg (x64 + arm64)
npm run build:all      # 셋 다
```

### 버전 두 개를 따로 관리한다

| 값 | 위치 | 올리는 시점 |
|---|---|---|
| `APP_VERSION` | `src/App.jsx:30` | **커밋마다 수동으로** 올리고 커밋 메시지에 같은 번호를 쓴다 |
| `package.json version` | — | 배포 빌드마다 `scripts/bump-version.cjs`가 **패치 자리만 자동 증가** |

`APP_RELEASE`(`src/App.jsx:34`)는 사용자에게 보이는 표기(`베타 3.0`)다. 수동.

### macOS 애드혹 서명 — `scripts/adhoc-sign-mac.cjs` (afterPack)

Developer ID 인증서가 없으면 electron-builder가 서명을 건너뛴다.
그러면 **Apple Silicon에서 실행 자체가 거부되고 macOS가 "손상됨"으로 안내**한다.
우클릭 → 열기로도 통과되지 않는다.

빌드 직후 상태를 확인해 보면:
```
arm64 → adhoc, linker-signed / Sealed Resources=none   (번들 미봉인)
x64   → code object is not signed at all
```
링커가 붙인 임시 서명은 리소스를 교체하면 무효가 되므로 번들 전체를 다시 서명해야 한다.

훅이 하는 일: `xattr -cr` → `codesign --force --deep --sign -` → 검증
(`Signature=adhoc` + `Sealed Resources version` 존재 + `codesign --verify --deep --strict`).
검증 실패 시 **빌드를 중단**시킨다 — 서명 없이 배포하면 arm64에서 열리지 않으므로.
정식 서명(`TeamIdentifier` 존재)이 있으면 덮어쓰지 않으니, 인증서를 넣으면 그대로 동작한다.

애드혹 서명 후에도 `spctl`은 `rejected`다(공증이 없어서 정상).
"손상됨"이 아니라 "확인되지 않은 개발자"로 내려와 우클릭 → 열기로 통과할 수 있게 된 상태다.

> **디버깅 함정:** `codesign -dv`는 정보를 **stderr**로 출력한다.
> `execFileSync`의 반환값(stdout)만 읽으면 항상 빈 문자열이라 검증이 늘 실패한다.
> `spawnSync`로 `stdout + stderr`를 합쳐 읽는다.

### pdf.js 에셋 — `scripts/copy-pdfjs-assets.cjs`

`postinstall`·`prebuild`에 등록. cmaps 169개 + standard_fonts 16개를 `public/pdfjs/`로 복사한다.
(`public/pdfjs/`는 gitignore) 한국어·일본어 PDF 텍스트 추출에 필요하다.

**검증은 `file://` Electron 환경에서 해야 한다.** dev의 `http://`에서 통과해도
패키지된 앱의 `file://`에서 깨질 수 있다.

### 산출물 (v835)

배포 빌드는 **`npm run build:all`** 하나로 만든다 (Windows + macOS 동시).
macOS 에서 Windows NSIS 설치본까지 함께 나오는 것이 확인돼 있다.

| 파일 | 크기 | 대상 |
|---|---|---|
| `OXYZN Studio Setup 2.0.9.exe` | 75MB | Windows x64 |
| `OXYZN Studio-2.0.9-arm64.dmg` | 92MB | macOS Apple Silicon |

**Intel Mac(x64)은 빌드하지 않는다** (v835에서 `build.mac.target[].arch` 에서 제거).
사내에 Intel 맥 사용자가 없어서 산출물만 늘리고 혼란을 만들었다 —
`mac/` 과 `mac-arm64/` 가 같은 이름·아이콘·번들 ID 로 나오는 문제(아래 참고).
다시 필요해지면 `arch` 에 `"x64"` 를 되돌리면 된다.

`build.files`는 `dist/**/*` + `electron/main.js` + `electron/preload.js`로 **명시 지정**한다.
`electron/**/*`로 두면 `main.js.bak` 같은 파일까지 패키지에 섞인다(v812에서 수정).

### 산출물 정리 — `scripts/clean-unpacked.cjs` (afterAllArtifactBuild)

이 훅은 두 가지를 지운다: **풀어놓은 중간산출물**과 **이전 버전 배포물**.
`dist-electron`에는 항상 현재 버전 파일만 남는다.

이전 버전 판별은 보수적이다 — 파일이고, 확장자가 `.exe`/`.dmg`/`.zip`/`.blockmap`이고,
파일명의 semver가 `package.json`의 현재 버전과 다를 때만 지운다. 그래서
`latest.yml`·`latest-mac.yml`·`builder-debug.yml`과 버전이 없는 파일은 건드리지 않는다.
남기려면 `FF_KEEP_OLD=1`.

왜 자동화했는가: 2.0.8·2.0.9·2.0.10이 뒤섞여 남고 exe 없이 dmg만 있는 버전까지 생겨,
팀원에게 줄 파일을 헷갈리게 만들었다. 사람이 기억해서 지우는 방식은 언젠가 빠진다.

electron-builder 는 포장 전에 **풀어놓은 앱**을 먼저 만든다
(`mac-arm64/` · `mac/` · `win-unpacked/` — 합계 약 720MB).
포장 후에도 남아서, 같은 이름·아이콘·번들 ID 를 가진 앱이 디스크에 여러 벌 존재한다.
프로젝트가 인덱싱되는 위치에 있으면 **Spotlight·Launchpad 에 앱이 3개로 잡힌다.**

더 위험한 것은 아키텍처 혼동이다. `dist-electron/mac` 은 Intel(x86_64) 빌드인데
`~/Library/Application Support/OXYZN Studio` 를 공유하므로 실행해도 구분되지 않는다.

훅은 outDir 의 디렉터리 중 **풀린 빌드의 증거**가 있는 것만 지운다 —
내부에 `.app` 번들이 있거나 `resources/app.asar` 가 있는 경우. 이름 패턴에 기대지 않으므로
타깃이 추가돼도 따라가고 산출물이 아닌 폴더를 지우지 않는다. 삭제 실패는 빌드를 중단시키지
않는다(배포물은 이미 완성된 시점).

빌드 직후 풀린 앱으로 테스트하려면 `FF_KEEP_UNPACKED=1 npm run build:mac`.

---

## 7. 공통 메커니즘

### 진행도 — `jobProgress` 단일 시계 (v790~791)

이전에는 CSS 애니메이션과 계산된 경과시간이 따로 돌아 진행도가 어긋났다.
`jobProgress(job, nowMs)` 하나로 통일했다.

- `estSecFor` / `recordJobDuration` — 실제 소요시간을 학습한다.
  `localStorage.flimfilm_duration_stats`에 작업별 최근 8개 샘플을 넣고 **중앙값**을 쓴다.
- 키: `durKeyVideo` / `durKeyArkImage` / `durKeyUpscale` / `durKeyImage`
- `pct: null`은 0%로 렌더되면 안 된다(전체 진행도까지 끌어내린다).

### 크레딧 기록

`recordCreditUsage(costUsd, category, { workCat })` → localStorage `oxyzn_credit_log` 누적.
(서버 insert 는 개인용 전환에서 제거됐다.)
`workCat`으로 작업 분류별 집계(`byWorkCat`)를 만든다.

**미구현:** `callGoogleGemini`에는 `recordCreditUsage` 호출이 없다.
영상 분석 비용이 집계에서 빠진다. 응답의 `usageMetadata`에 실제 토큰이 오므로 연결 가능하다.

**중복 집계 주의:** 영상은 `callSeedanceVideo`가 `completion_tokens`로 기록한다.
워크스페이스 쪽에서 추정치를 또 기록하면 두 번 잡힌다(v764에서 제거).

### 인앱 다이얼로그

네이티브 `alert`/`confirm`/`prompt`는 쓰지 않는다. 전부 툴 디자인으로 대체됐다.

```js
showNotice(title, message)                    // 알림
askConfirm({ title, message, confirmLabel })  // Promise<boolean>
askText({ title, message, placeholder })      // Promise<string|null>
```

### 드롭다운 — `FFSelect` (필수)

**네이티브 `<select>`는 쓰지 않는다.** 모듈 스코프 `FFSelect`를 쓴다.
`options`는 그룹 형태를 지원한다: `{ group, items: [{ id, label, hint, hintAccent }] }`.

`fixedMenu` prop — 부모에 `overflow: auto`가 있으면(예: 표 래퍼) `position: absolute`
패널이 잘린다. 이 경우 `fixedMenu`를 켜면 `position: fixed` +
`getBoundingClientRect` + 캡처 단계 스크롤 리스너 + dropUp으로 처리한다.

### 오류 메시지 원칙

이번 릴리스에서 반복적으로 문제가 됐던 부분이다.

1. **원문을 버리지 않는다.** 상태 코드만 보고 문구를 갈아치우면 오진을 유도한다.
   403을 통째로 "API 활성화 확인"으로 바꿔 놔서, 실제 원인이 "영상 접근 불가"인데도
   키를 의심하며 시간을 버렸다(v813~815).
2. **제공자가 주는 구조화된 사유를 읽는다.** Google은 `error.details[].reason`과
   `violations[].quotaId/quotaValue`를 준다. 이걸 읽어 분류한다.
3. **어느 키가 쓰였는지 지문을 남긴다.** 값은 노출하지 않고 앞4…뒤4 + 출처만.
   Google 키는 종류가 달라도 전부 `AIza` + 39자라 눈으로 구분되지 않는다.
4. **UI 위치를 문구에 박을 때는 실제로 존재하는지 확인한다.** API 키 입력이
   공용 탭에서 관리자 전용 탭으로 옮겨졌는데 오류 메시지 18곳이 옛 위치를 안내하고 있었다(v814).
   권한도 갈린다 — 팀원에게 "입력하세요"는 잘못된 안내다.

---

## 8. 프롬프트 룰북

`src/App.jsx` ~5300–8700. 각 작업의 시스템 프롬프트를 조립한다.
**모델별 권장 프롬프트 길이가 다르다** (문서 확인값):

| 모델 | 권장 |
|---|---|
| Seedream (이미지) | 영어 600 단어 |
| Seedance (영상) | 1000 단어 |

둘 다 "정보가 분산되면 모델이 디테일을 무시한다"고 경고한다.
사용자 묘사가 길어지면 넘칠 수 있어 룰북을 압축해 뒀다.

### 캐릭터 · 의상 규칙

캐릭터 시트는 **몸에 붙는 무채색 원피스 바디수트**로 생성한다.
과거에는 일반 의상으로 뽑았는데, 다른 옷을 입히면 기존 옷이 내의처럼 남았다.

의상 첨부 시 규칙: **"의상 레퍼런스가 레이어 수의 유일한 권위"**.
`"a single layer, nothing underneath"`로 강하게 막았더니 자켓 안에 셔츠를 못 입는
과교정이 났다(v783). 여밈도 대칭으로 서술한다 — 열린 것은 열린 채, 잠근 것은 잠근 채.

### 영상 분석 — 화 경계

숏폼 드라마는 여러 화를 이어붙이고 사이에 블랙 매트를 넣는다.
**2초 이상 지속되는 완전한 검은 화면**을 화 경계로 판별하게 지시한다.
어두운 장면·밤 장면·0.5초 페이드는 경계가 아니라고 명시해야 한다(없으면 밤 장면에서 갈린다).

Gemini는 1초당 1프레임을 샘플링하므로 2~3초 블랙은 2~3프레임으로 잡힌다.
**1초 미만 블랙은 놓칠 수 있다.**

---

## 9. 알려진 이슈 · 다음 작업

### 구조

- [ ] `App.jsx` 35,500줄 분할. 작업별 컴포넌트 + 상태 분리가 필요하다.
      TDZ·고아 속성 사고가 전부 이 구조에서 나온다.
- [ ] 라우팅 이원화 정리 — `openSingleTask` 의 레거시 view 우회 3개를 직접 렌더로 통일,
      죽은 항목(`sound-clone`, `sound-vc`) 제거.
- [ ] `setMaxPromptChars`가 선언 외에 쓰이지 않는 죽은 setter다.
      `maxPromptChars`를 조절하는 UI가 없다.

### 기능

- [ ] 영상 분석 비용을 `recordCreditUsage`에 연결 (`usageMetadata` 사용)
- [ ] BytePlus에 Seedream **Pro**가 신뢰 자산인지 확인 → 아니면 `imageLite`로 전환
- [ ] 30일 신뢰 만료가 실제로 집행되는지 실측 (30일 지난 캐릭터로 영상 생성)
- [ ] Gemini 유료 티어 전환 — 길이 한도(38분 → 2시간 40분)와 기밀 보호가 함께 걸려 있다

### 배포

- [ ] Apple Developer Program 서명·공증 — 경고 없는 첫 실행
- [ ] Windows 검증 체크리스트 미완 (다운로드↔아카이브 동기화, 휴지통 복원,
      OneDrive 리디렉션 폴더, 한글 파일명, 한국어 PDF 추출)

---

## 10. 로컬 셋업

```bash
npm install                    # postinstall 이 pdf.js 에셋을 복사한다
cp .env.example .env.local     # 키를 채운다
npm run electron:dev
```

`.env.local` 변수 10개:

```
VITE_FAL_API_KEY            fal.ai
VITE_ARK_API_KEY            BytePlus ModelArk (Bearer — 영상·이미지 생성)
VITE_ARK_ACCESS_KEY_ID      BytePlus Access Key ID  (배우 인증 · Assets API)
VITE_ARK_SECRET_KEY         BytePlus Secret Key     (배우 인증 · Assets API)
VITE_CLAUDE_API_KEY         Anthropic
VITE_GOOGLE_API_KEY         Gemini (영상 분석)
```

개인용 전환에서 **장소 탐색(Google Places · Kakao Local)을 걷어냈다.**
`VITE_GOOGLE_PLACES_API_KEY` 와 `VITE_KAKAO_API_KEY` 는 더 이상 쓰지 않는다.
남은 Google 키는 Gemini(영상·YouTube 분석) 전용이라 키가 섞일 일도 없어졌다.

BytePlus 키는 **두 종류가 따로 필요하다.** `VITE_ARK_API_KEY`(Bearer)로는 Assets API를
호출할 수 없고, AK/SK로는 영상·이미지 생성을 호출할 수 없다. 문서 명시:
"To call the Assets API interface, you must use Access Key authentication."
AK/SK 발급은 콘솔 → 계정명 → IAM → Key management → Create access key이며,
Secret은 발급 시 한 번만 표시된다. 해당 계정에 프로젝트의 `ArkFullAccess` 권한이
있어야 하고, Advanced Creation Rights가 **Entry 이상**이어야 Assets API가 열린다.

**여기에 더해 계정에 Advanced 또는 Premium 구독 플랜이 필요하다.** 플랜이 없으면
키와 권한이 멀쩡해도 403 이 떨어진다 — 원문은 `This API requires an active
subscription. Please subscribe to an Advanced or Premium plan.` 이다.
**선불 리소스 팩을 사둔 것과는 별개다** (팩은 사용량, 이건 플랜 가입).
403 을 IAM 문제로만 안내하다가 엉뚱한 곳을 뒤지게 만든 적이 있어,
지금은 원문에 subscription/plan 이 있으면 요금제 안내로 갈라준다.

키를 하나도 넣지 않아도 앱은 켜지고 화면은 다 돌아본다. 실제 생성 호출만 실패한다.

---

*v859 / 2.0.15 · 2026-08-06*
