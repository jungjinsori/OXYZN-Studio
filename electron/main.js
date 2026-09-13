const { app, BrowserWindow, shell, ipcMain, dialog, nativeImage, protocol, net } = require('electron')
const { pathToFileURL } = require('url')
const path = require('path')
const os = require('os')
const { execFile } = require('child_process')
const fs = require('fs')
const crypto = require('crypto')
// v976: 앱 데이터 폴더의 파일을 ffs:// 로 읽는다.
//   file:// 은 <img>·<audio> 는 되지만 fetch 가 막힌다 — 저장·다운로드 코드가
//   전부 fetch 를 쓰므로 그때마다 IPC 로 읽어 오는 우회가 필요했다.
//   privileged 스킴으로 등록하면 <img>·<video>·fetch 가 모두 같은 주소를 쓴다.
//   반드시 app ready 전에 등록해야 한다.
protocol.registerSchemesAsPrivileged([{
  scheme: 'ffs',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true },
}])

// 패키징되지 않은 상태(개발 실행)면 Vite dev 서버를 로드, 패키징된 앱이면 dist 로드
const isDev = !app.isPackaged

function createWindow() {
  const win = new BrowserWindow({
    width: 1600,
    height: 1000,
    center: true,
    minWidth: 900,
    minHeight: 600,
    title: 'OXYZN Studio',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: false,  // Anthropic/Replicate API CORS 허용
      preload: path.join(__dirname, 'preload.js'),
    },
    // 타이틀바 기본 사용 (크로스플랫폼 호환)
    show: false,
  })

  // 외부 링크는 기본 브라우저로
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  // v1052: 렌더러가 죽으면 지금까지는 아무 기록 없이 창만 하얘졌다.
  //   패키징된 앱에는 개발자도구가 없어 사용자도 나도 원인을 알 방법이 없었다.
  //   죽은 이유를 userData/crash.log 에 남기고, 창은 한 번 자동 복구한다.
  let reloadedAfterCrash = false
  win.webContents.on('render-process-gone', (_e, details) => {
    const line = `[${new Date().toISOString()}] render-process-gone reason=${details && details.reason} exitCode=${details && details.exitCode}`
    appendCrashLog(line)
    console.error(line)
    // 무한 재시작을 막기 위해 한 번만 되살린다
    if (!reloadedAfterCrash) {
      reloadedAfterCrash = true
      setTimeout(() => { try { win.reload() } catch {} }, 300)
    }
  })
  win.on('unresponsive', () => {
    appendCrashLog(`[${new Date().toISOString()}] window unresponsive`)
  })
  // 렌더러의 error/warning 을 메인 로그와 파일로 넘긴다 (level: 0 log · 1 warn · 2 error)
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    if (level < 2) return
    const t = `[${new Date().toISOString()}] renderer-error: ${message} (${sourceId}:${line})`
    appendCrashLog(t)
    console.error(t)
  })

  if (isDev) {
    win.loadURL('http://localhost:5173')
    win.webContents.openDevTools()
  } else {
    win.loadFile(path.join(__dirname, '../dist/index.html'))
  }

  win.once('ready-to-show', () => {
    win.show()
  })
}

// 크래시·렌더러 오류 기록. 앱을 껐다 켜도 남아야 해서 userData 에 쌓는다.
function appendCrashLog(text) {
  try {
    const p = path.join(app.getPath('userData'), 'crash.log')
    fs.appendFileSync(p, text + '\n')
    // 무한정 커지지 않게 상한을 둔다
    try {
      const st = fs.statSync(p)
      if (st.size > 512 * 1024) {
        const keep = fs.readFileSync(p, 'utf8').split('\n').slice(-500).join('\n')
        fs.writeFileSync(p, keep)
      }
    } catch {}
  } catch {}
}

// ─────────────────────────────────────────────────────────────
// v809: YouTube 영상 길이 조회 (바이너리 불필요)
//
// 왜 yt-dlp 를 안 쓰는가:
//   yt-dlp 는 번들에 포함돼 있지 않아 팀원 PC 에 없으면 실패한다.
//   길이는 영상 분석에서 해상도 모드를 결정하는 값이라 반드시 필요하다
//   (1시간 초과 → 저해상도로 내려야 1M 컨텍스트에 들어간다).
//
// 방식: watch 페이지 HTML 의 "lengthSeconds":"7200" 을 읽는다.
//   메인 프로세스에서 받으므로 CORS 제약이 없다.
//   실패해도 렌더러가 yt-dlp → 자동 재시도로 이어받으므로 치명적이지 않다.
// ─────────────────────────────────────────────────────────────
ipcMain.handle('youtube-duration', async (event, url) => {
  try {
    if (!url || typeof url !== 'string') return { success: false, error: 'invalid url' }
    // 신뢰 경계: 렌더러가 준 URL 을 그대로 요청하지 않고 영상 ID 만 뽑아 재조립한다
    const m = String(url).match(/(?:[?&]v=|\/shorts\/|\/embed\/|youtu\.be\/)([A-Za-z0-9_-]{11})/)
    if (!m) return { success: false, error: 'video id not found' }
    const watchUrl = `https://www.youtube.com/watch?v=${m[1]}`

    const ac = new AbortController()
    const t = setTimeout(() => ac.abort(), 15000)
    let html = ''
    try {
      const res = await fetch(watchUrl, {
        signal: ac.signal,
        headers: {
          // 축약 모바일 페이지가 아닌 전체 페이지를 받기 위한 최소 헤더
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      })
      if (!res.ok) return { success: false, error: `http ${res.status}` }
      html = await res.text()
    } finally {
      clearTimeout(t)
    }

    // v815: 공개 상태도 함께 읽는다.
    //   Gemini 는 공개 영상만 분석할 수 있고, 일부공개·비공개 영상에는
    //   403 PERMISSION_DENIED "The caller does not have permission" 을 돌려준다.
    //   이 응답에는 사유(details[].reason)가 없어서 키 문제와 구분되지 않는다.
    //   그래서 호출 전에 여기서 걸러 정확한 이유를 알려준다.
    //
    //   주의: 명시적으로 true 인 플래그만 신뢰한다. 로그인 없이 페이지를 받으면
    //   연령제한 영상은 status=ERROR 로 보이는데, 실제로 Gemini 는 그 영상을
    //   정상 분석한다(실측 확인). status 로 막으면 되는 영상을 막게 된다.
    const flag = (name) => {
      const mm = html.match(new RegExp(`"${name}"\\s*:\\s*(true|false)`))
      return mm ? mm[1] === 'true' : null
    }
    const isUnlisted = flag('isUnlisted')
    const isPrivate = flag('isPrivate')

    const dm = html.match(/"lengthSeconds"\s*:\s*"(\d+)"/)
    const duration = dm ? parseInt(dm[1], 10) : 0
    const ok = Number.isFinite(duration) && duration > 0

    console.log('[youtube-duration]', m[1], '→', ok ? `${duration}초` : '길이 미확인',
      `· unlisted=${isUnlisted} private=${isPrivate}`)
    // 길이를 못 읽어도 공개 상태만 확인됐으면 그것만이라도 돌려준다
    return { success: ok, duration: ok ? duration : 0, isUnlisted, isPrivate }
  } catch (e) {
    const msg = e && e.name === 'AbortError' ? 'timeout' : (e && e.message) || String(e)
    console.warn('[youtube-duration] 실패:', msg)
    return { success: false, error: msg }
  }
})

// ─────────────────────────────────────────────────────────────
// v832: BytePlus OpenAPI 서명 호출 (배우 인증 — Assets API)
//
// 왜 메인 프로세스에서 하는가:
//   1) 서명에 HMAC-SHA256 이 필요하다. Node crypto 는 개발 실행과 패키징 빌드에서
//      똑같이 동작한다. 렌더러의 crypto.subtle 은 secure context 를 요구해서
//      file:// 로 로드되는 패키징 빌드에서 보장된다고 볼 수 없다.
//   2) Secret Access Key 가 페이지 컨텍스트의 네트워크 경로를 타지 않는다.
//   3) 이 게이트웨이(byteplusapi.com)는 CORS 헤더를 주지 않는다. 기존 ARK 호출이
//      렌더러에서 되는 것은 bytepluses.com/api/v3 쪽이 OpenAI 호환 엔드포인트라서다.
//
// 서명 규격 (BytePlus Signature · HMAC-SHA256):
//   CanonicalRequest = METHOD \n URI \n Query \n CanonicalHeaders \n SignedHeaders \n hex(sha256(body))
//   StringToSign     = "HMAC-SHA256" \n X-Date \n {YYYYMMDD}/{region}/{service}/request \n hex(sha256(CanonicalRequest))
//   kDate=HMAC(SK,date) → kRegion=HMAC(kDate,region) → kService=HMAC(kRegion,service) → kSigning=HMAC(kService,"request")
//   Signature        = hex(HMAC(kSigning, StringToSign))
//   ※ AWS SigV4 와 달리 SK 에 "AWS4" 같은 접두어를 붙이지 않는다. 그대로 쓴다.
//   출처: docs.byteplus.com/en/docs/byteplus-platform/reference-how-to-calculate-a-signature
// ─────────────────────────────────────────────────────────────

// 리전 → 게이트웨이 호스트. 렌더러가 임의의 호스트로 서명 요청을 보내지 못하게 고정한다.
const ARK_OPENAPI_HOSTS = {
  'ap-southeast-1': 'ark.ap-southeast-1.byteplusapi.com',
}
// 허용 Action 화이트리스트 — 배우 인증에 필요한 것만.
//
// Delete* 는 넣지 않는다. 오작동으로 배우 자산이 지워지면 되돌릴 수 없고,
// 그 복구 비용(배우를 다시 불러 재인증)이 이 앱에서 가장 비싸다.
// CreateAsset 도 아직 넣지 않는다 — 공개 URL 이 필요해 별도 설계가 남아 있다.
//
// v840: UpdateAssetGroup 만 예외로 허용한다. 이 API 가 바꿀 수 있는 것은
//   문서상 Name 과 Description 뿐이고(자산 자체는 건드리지 못한다), 인증으로 만들어진
//   그룹 이름이 group-2026...-xxxxx 라서 콘솔에서 누가 누구인지 분간이 안 되기 때문이다.
const ARK_OPENAPI_ACTIONS = new Set([
  'CreateVisualValidateSession',
  'GetVisualValidateResult',
  'ListAssetGroups',
  'ListAssets',
  'GetAsset',
  'GetAssetGroup',
  'UpdateAssetGroup',
  // v1115: 캐릭터를 AIGC 자산으로 등록한다. Delete* 는 넣지 않는다 — 지워지면 되돌릴 수 없다.
  'CreateAssetGroup',
  'CreateAsset',
])

const arkSha256Hex = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex')
const arkHmac = (key, s) => crypto.createHmac('sha256', key).update(s, 'utf8').digest()

ipcMain.handle('ark-openapi', async (event, payload) => {
  const p = payload || {}
  const ak = String(p.ak || '').trim()
  const sk = String(p.sk || '').trim()
  const action = String(p.action || '').trim()
  const version = String(p.version || '2024-01-01').trim()
  const region = ARK_OPENAPI_HOSTS[p.region] ? String(p.region) : 'ap-southeast-1'
  const host = ARK_OPENAPI_HOSTS[region]
  const service = 'ark'

  if (!ak || !sk) return { success: false, error: 'Access Key ID / Secret Access Key 가 등록되지 않았습니다.' }
  if (!ARK_OPENAPI_ACTIONS.has(action)) return { success: false, error: `허용되지 않은 Action: ${action}` }

  try {
    const body = JSON.stringify(p.body && typeof p.body === 'object' ? p.body : {})
    const bodyHash = arkSha256Hex(body)

    // X-Date: UTC YYYYMMDD'T'HHMMSS'Z'  (예: 20260804T031204Z)
    const xDate = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
    const shortDate = xDate.slice(0, 8)
    const credentialScope = `${shortDate}/${region}/${service}/request`

    // 쿼리는 ASCII 정렬 — Action < Version 이라 이 순서가 곧 정렬 결과다
    const canonicalQuery = `Action=${encodeURIComponent(action)}&Version=${encodeURIComponent(version)}`
    const contentType = 'application/json'
    const signedHeaders = 'content-type;host;x-content-sha256;x-date'
    const canonicalHeaders =
      `content-type:${contentType}\n` +
      `host:${host}\n` +
      `x-content-sha256:${bodyHash}\n` +
      `x-date:${xDate}\n`

    const canonicalRequest = [
      'POST',
      '/',
      canonicalQuery,
      canonicalHeaders,      // 이미 \n 으로 끝난다. join 이 한 줄 더 넣어 빈 줄이 생기는 게 규격이다
      signedHeaders,
      bodyHash,
    ].join('\n')

    const stringToSign = ['HMAC-SHA256', xDate, credentialScope, arkSha256Hex(canonicalRequest)].join('\n')

    const kDate = arkHmac(sk, shortDate)
    const kRegion = arkHmac(kDate, region)
    const kService = arkHmac(kRegion, service)
    const kSigning = arkHmac(kService, 'request')
    const signature = crypto.createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex')

    const authorization =
      `HMAC-SHA256 Credential=${ak}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`

    const ac = new AbortController()
    const t = setTimeout(() => ac.abort(), 30000)
    let res, text
    try {
      res = await fetch(`https://${host}/?${canonicalQuery}`, {
        method: 'POST',
        signal: ac.signal,
        headers: {
          'Content-Type': contentType,
          'X-Date': xDate,
          'X-Content-Sha256': bodyHash,
          Authorization: authorization,
        },
        body,
      })
      text = await res.text()
    } finally {
      clearTimeout(t)
    }

    let json = null
    try { json = JSON.parse(text) } catch {}

    // 로그에는 Action 과 상태만 남긴다 — 키·토큰·H5 링크는 기록하지 않는다
    console.log('[ark-openapi]', action, '→ http', res.status)

    if (!res.ok) {
      // BytePlus 오류는 { ResponseMetadata: { Error: { CodeN, Code, Message } } } 형태로 온다.
      // Code 는 'InvalidAccessKey' 같은 문자열, CodeN 은 100009 같은 숫자다.
      // 렌더러에서 원인별 안내를 만들 때 문자열이 쓸모 있으므로 code 에는 Code 를 넣는다.
      const err = json && json.ResponseMetadata && json.ResponseMetadata.Error
      return {
        success: false,
        status: res.status,
        code: (err && err.Code) || '',
        codeN: (err && err.CodeN) || 0,
        error: (err && err.Message) || `http ${res.status}`,
        raw: text.slice(0, 2000),
      }
    }
    // 응답 본문은 { ResponseMetadata, Result } 로 감싸져 오는 경우와 평면인 경우가 모두 있다
    const result = (json && json.Result) ? json.Result : json
    return { success: true, status: res.status, result, raw: text.slice(0, 4000) }
  } catch (e) {
    const msg = e && e.name === 'AbortError' ? '요청 시간 초과(30초)' : (e && e.message) || String(e)
    console.warn('[ark-openapi]', action, '실패:', msg)
    return { success: false, error: msg }
  }
})

// ─────────────────────────────────────────────────────────────
// v333: yt-dlp IPC 핸들러
// YouTube URL → 직접 비디오 스트림 URL 추출
// ─────────────────────────────────────────────────────────────
ipcMain.handle('ytdlp-extract', async (event, url) => {
  return new Promise((resolve) => {
    if (!url || typeof url !== 'string') {
      return resolve({ success: false, error: 'URL이 유효하지 않습니다.' })
    }

    // yt-dlp 바이너리 경로 결정
    let ytdlpPath = 'yt-dlp' // PATH에서 찾기 (기본값)

    // 1순위: 앱과 함께 번들된 바이너리 (배포본)
    const bundledPath = app.isPackaged
      ? path.join(process.resourcesPath, 'bin', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp')
      : path.join(__dirname, 'bin', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp')

    if (fs.existsSync(bundledPath)) {
      ytdlpPath = bundledPath
    } else if (process.platform === 'darwin') {
      // 2순위: macOS Homebrew 경로 시도 (Apple Silicon / Intel)
      const brewPaths = [
        '/opt/homebrew/bin/yt-dlp',  // Apple Silicon
        '/usr/local/bin/yt-dlp',     // Intel Mac
      ]
      for (const p of brewPaths) {
        if (fs.existsSync(p)) {
          ytdlpPath = p
          break
        }
      }
    }

    console.log('[yt-dlp] 바이너리 경로:', ytdlpPath)
    console.log('[yt-dlp] 요청 URL:', url)

    const args = [
      '--no-warnings',
      '--no-playlist',
      '-f', 'best[ext=mp4][height<=720]/best[ext=mp4]/best',
      '--print', '%(title)s|||%(duration)s|||%(url)s',
      url,
    ]

    execFile(ytdlpPath, args, { timeout: 120000 }, (error, stdout, stderr) => {
      if (error) {
        const errMsg = (stderr || error.message || '').toString()
        console.error('[yt-dlp] 실패:', errMsg.slice(0, 500))

        if (errMsg.includes('Private video') || errMsg.includes('Sign in')) {
          return resolve({ success: false, error: 'private video (비공개 영상)' })
        }
        if (errMsg.includes('Video unavailable') || errMsg.includes('not available')) {
          return resolve({ success: false, error: 'video unavailable (영상을 사용할 수 없음)' })
        }
        if (errMsg.includes('not found') || error.code === 'ENOENT') {
          return resolve({ success: false, error: 'yt-dlp not found (yt-dlp가 설치되지 않음)' })
        }
        return resolve({ success: false, error: errMsg.slice(0, 300) })
      }

      const output = (stdout || '').trim()
      const parts = output.split('|||')
      if (parts.length < 3 || !parts[2]) {
        console.error('[yt-dlp] 출력 파싱 실패:', output.slice(0, 200))
        return resolve({ success: false, error: '스트림 URL 추출 실패: ' + output.slice(0, 200) })
      }

      const title = parts[0].trim()
      const duration = parseInt(parts[1].trim(), 10) || 0
      const streamUrl = parts[2].trim()

      console.log('[yt-dlp] 성공 — 제목:', title, '· 길이:', duration, '초')
      resolve({ success: true, title, duration, streamUrl })
    })
  })
})

// ─────────────────────────────────────────────
// 다운로드 폴더 기본 경로 + 아카이브 폴더 (작업영역별 하위폴더, 전체 최대 300개, FIFO)
// ─────────────────────────────────────────────
const ARCHIVE_MAX = 300
const ARCHIVE_CATS = ['plan', 'image', 'video', 'sound', 'etc']
let currentDownloadCategory = 'etc' // 렌더러가 활성 작업영역에 맞춰 설정

// 렌더러가 현재 작업영역 카테고리를 알려줌 (이후 다운로드는 이 하위폴더로 아카이브)
ipcMain.handle('set-download-category', (event, cat) => {
  currentDownloadCategory = ARCHIVE_CATS.includes(cat) ? cat : 'etc'
  return { success: true }
})

// ─────────────────────────────────────────────────────────────
// v879: 프로젝트 저장 — userData/projects/*.json
//
// 사용자가 고른 경로가 아니라 앱 내부에 둔다. 랜딩의 라이브러리 목록이 이 폴더를
// 그대로 읽고, 최초 저장에서 이름만 정하면 이후는 자동저장이다.
// ─────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────
// v914: 작업 내역 자동 보관 — userData/session.json
//
// 단일작업 워크스페이스 상태를 통째로 담는다. 저장 버튼을 누르지 않아도
// 앱을 껐다 켜면 하던 자리로 돌아오게 하는 용도다.
// 큰 바이너리(base64·data URL)는 렌더러에서 걸러 보내므로 파일은 작다.
// ─────────────────────────────────────────────────────────────
function sessionPath() {
  const dir = app.getPath('userData')
  try { fs.mkdirSync(dir, { recursive: true }) } catch {}
  return path.join(dir, 'session.json')
}

ipcMain.handle('session-save', (event, data) => {
  try {
    const full = sessionPath()
    const tmp = full + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(data), 'utf8')
    fs.renameSync(tmp, full)
    return { success: true, bytes: fs.statSync(full).size }
  } catch (e) { return { success: false, error: String(e && e.message || e) } }
})

ipcMain.handle('session-load', () => {
  try {
    const full = sessionPath()
    if (!fs.existsSync(full)) return { success: true, data: null }
    return { success: true, data: JSON.parse(fs.readFileSync(full, 'utf8')) }
  } catch (e) { return { success: false, error: String(e && e.message || e) } }
})

ipcMain.handle('session-clear', () => {
  try { fs.unlinkSync(sessionPath()) } catch {}
  return { success: true }
})

function getProjectRoot() {
  const dir = path.join(app.getPath('userData'), 'projects')
  try { fs.mkdirSync(dir, { recursive: true }) } catch {}
  return dir
}
// id 는 파일명이 된다 — 경로 탈출과 금지문자를 막는다
function safeProjectId(id) {
  const s = String(id || '').replace(/[^A-Za-z0-9_-]/g, '')
  return s.slice(0, 64)
}
function projectPath(id) {
  const safe = safeProjectId(id)
  if (!safe) return null
  return path.join(getProjectRoot(), safe + '.json')
}

ipcMain.handle('project-list', () => {
  try {
    const dir = getProjectRoot()
    const out = []
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue
      const full = path.join(dir, f)
      try {
        const st = fs.statSync(full)
        let name = f.replace(/\.json$/, '')
        let step = 1
        let reachedStep = 0
        let schema = 0
        try {
          const j = JSON.parse(fs.readFileSync(full, 'utf8'))
          if (j && typeof j.name === 'string' && j.name.trim()) name = j.name
          if (j && Number.isFinite(j.step)) step = j.step
          // v958: 단계 번호 이관 판정에 필요하다 — 렌더러가 옛 형식인지 가린다
          if (j && Number.isFinite(j.reachedStep)) reachedStep = j.reachedStep
          if (j && Number.isFinite(j.schema)) schema = j.schema
        } catch { /* 깨진 파일은 파일명으로 보여준다 */ }
        out.push({ id: f.replace(/\.json$/, ''), name, step, reachedStep, schema, updatedAt: st.mtimeMs, bytes: st.size })
      } catch { /* 한 건 실패는 건너뛴다 */ }
    }
    out.sort((a, b) => b.updatedAt - a.updatedAt)
    return { success: true, projects: out }
  } catch (e) { return { success: false, error: String(e && e.message || e) } }
})

ipcMain.handle('project-save', (event, id, data) => {
  const full = projectPath(id)
  if (!full) return { success: false, error: '잘못된 프로젝트 id 입니다.' }
  try {
    // 임시 파일에 쓰고 교체한다 — 저장 중 종료돼도 기존 파일이 깨지지 않는다
    const tmp = full + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(data), 'utf8')
    fs.renameSync(tmp, full)
    const st = fs.statSync(full)
    return { success: true, updatedAt: st.mtimeMs, bytes: st.size }
  } catch (e) { return { success: false, error: String(e && e.message || e) } }
})

// v1121: 라이브러리에서 이름 바꾸기. 파일명(id)은 그대로 두고 저장본 안의 name 만 고친다.
//   파일명을 바꾸면 받아둔 클립 폴더(clipDir)와 열려 있는 프로젝트의 id 가 어긋난다.
//   수정 시각은 원래대로 되돌린다 — 이름만 고친 것을 '최근 수정' 으로 올릴 이유가 없다.
ipcMain.handle('project-rename', (event, id, name) => {
  const full = projectPath(id)
  if (!full) return { success: false, error: '잘못된 프로젝트 id 입니다.' }
  const nm = String(name || '').trim().slice(0, 80)
  if (!nm) return { success: false, error: '이름이 비어 있습니다.' }
  try {
    const st0 = fs.statSync(full)
    const j = JSON.parse(fs.readFileSync(full, 'utf8'))
    j.name = nm
    const tmp = full + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(j), 'utf8')
    fs.renameSync(tmp, full)
    try { fs.utimesSync(full, st0.atime, st0.mtime) } catch { /* 시각 되돌리기는 실패해도 그만 */ }
    return { success: true, name: nm }
  } catch (e) { return { success: false, error: String(e && e.message || e) } }
})

ipcMain.handle('project-load', (event, id) => {
  const full = projectPath(id)
  if (!full) return { success: false, error: '잘못된 프로젝트 id 입니다.' }
  try {
    const data = JSON.parse(fs.readFileSync(full, 'utf8'))
    return { success: true, data }
  } catch (e) { return { success: false, error: String(e && e.message || e) } }
})

// ─────────────────────────────────────────────────────────────
// v934: 생성한 클립을 userData 에 받아 둔다.
//   ModelArk 결과 URL 은 24시간이면 죽는다. 그대로 두면 다음 날 프로젝트를
//   열었을 때 재생도 저장도 안 되고 히스토리도 빈 껍데기가 된다.
//   레퍼런스는 라이브러리에 원본이 있어 되살렸지만 영상은 되살릴 원본이 없다.
// ─────────────────────────────────────────────────────────────
function clipDir(projectId) {
  const safe = safeProjectId(projectId) || '_'
  const dir = path.join(app.getPath('userData'), 'clips', safe)
  try { fs.mkdirSync(dir, { recursive: true }) } catch {}
  return dir
}

// ─────────────────────────────────────────────────────────────
// v974: 라이브러리 자산(캐릭터 시트 원본 바이트)을 userData 에 둔다.
//   전에는 localStorage 에 base64 로 넣었다. 한 개가 3~8MB 라 한도(약 50MB)를
//   금방 채웠고, 6개로 32.6MB 를 먹어 새 캐릭터가 저장되지 않았다.
//   캐릭터는 오랫동안 두고두고 쓰는 자산이라 용량 한도가 있어선 안 된다.
// ─────────────────────────────────────────────────────────────
const ASSET_KINDS = { character: 'characters', voice: 'voices', upload: 'uploads' }
function assetDir(kind) {
  const sub = ASSET_KINDS[String(kind)] || 'misc'
  const dir = path.join(app.getPath('userData'), 'library', sub)
  try { fs.mkdirSync(dir, { recursive: true }) } catch {}
  return dir
}
const ASSET_EXT = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/webp': 'webp',
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav',
  'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm', 'video/x-matroska': 'mkv',
}
// 라이브러리 폴더 밖은 절대 건드리지 않는다 (읽기·삭제 모두 이 검사를 통과해야 한다)
function assetPathInside(p) {
  try {
    const root = path.join(app.getPath('userData'), 'library')
    const full = path.resolve(String(p || ''))
    const rel = path.relative(root, full)
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return ''
    return full
  } catch { return '' }
}
// v976: ffs:// 로 내줄 수 있는 범위 — 앱이 만든 폴더만. 그 밖은 전부 거부한다.
const LOCAL_READ_DIRS = ['library', 'gen', 'clips']
function localReadablePath(p) {
  try {
    const full = path.resolve(String(p || ''))
    for (const sub of LOCAL_READ_DIRS) {
      const root = path.join(app.getPath('userData'), sub)
      const rel = path.relative(root, full)
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return full
    }
    return ''
  } catch { return '' }
}

// ─────────────────────────────────────────────────────────────
// v976: 생성 결과 이미지를 앱 데이터 폴더에 받아 둔다.
//   생성 URL 은 24시간이면 죽는다. 그래서 여태 워크스페이스 히스토리를 저장할 때
//   비워서 넣었고(v589), 앱을 다시 켜면 작업 내역이 사라졌다.
//   파일로 받아두면 히스토리를 그대로 되살릴 수 있다.
// ─────────────────────────────────────────────────────────────
const GEN_CAP_BYTES = 8 * 1024 * 1024 * 1024   // 8GB — 3MB 이미지 2,600여 장
function genDir(ws) {
  const safe = String(ws || 'etc').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || 'etc'
  const dir = path.join(app.getPath('userData'), 'gen', safe)
  try { fs.mkdirSync(dir, { recursive: true }) } catch {}
  return dir
}
function genAll() {
  const root = path.join(app.getPath('userData'), 'gen')
  const out = []
  try {
    for (const ws of fs.readdirSync(root)) {
      const dir = path.join(root, ws)
      try {
        if (!fs.statSync(dir).isDirectory()) continue
        for (const f of fs.readdirSync(dir)) {
          try {
            const full = path.join(dir, f)
            const st = fs.statSync(full)
            if (st.isFile()) out.push({ full, t: st.mtimeMs, size: st.size })
          } catch {}
        }
      } catch {}
    }
  } catch {}
  return out
}
// 8GB 를 넘으면 오래된 것부터 지운다
function enforceGenCap() {
  try {
    const all = genAll()
    let total = all.reduce((n, x) => n + x.size, 0)
    if (total <= GEN_CAP_BYTES) return
    all.sort((a, b) => a.t - b.t)
    let freed = 0, n = 0
    for (const f of all) {
      if (total <= GEN_CAP_BYTES) break
      try { fs.unlinkSync(f.full); total -= f.size; freed += f.size; n++ } catch {}
    }
    if (n) console.info(`[gen] 상한(8GB) 초과 — 오래된 ${n}개 ${(freed / 1048576).toFixed(0)}MB 정리`)
  } catch {}
}
const GEN_EXT_OK = ['png', 'jpg', 'jpeg', 'webp', 'mp4', 'mp3', 'wav']
ipcMain.handle('gen-save', async (event, payload) => {
  const { ws, id, url } = payload || {}
  if (!url || !/^https?:\/\//i.test(String(url))) return { success: false, error: '내려받을 주소가 아닙니다.' }
  const safeId = String(id || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80) || `g${Date.now()}`
  let ext = String(String(url).split('?')[0].split('.').pop() || '').toLowerCase()
  if (!GEN_EXT_OK.includes(ext)) ext = 'png'
  const dest = path.join(genDir(ws), `${safeId}.${ext}`)
  try {
    if (fs.existsSync(dest)) {
      const st = fs.statSync(dest)
      if (st.size > 0) return { success: true, path: dest, bytes: st.size, cached: true }
    }
    const bytes = await downloadTo(String(url), dest)
    enforceGenCap()
    return { success: true, path: dest, bytes }
  } catch (e) { return { success: false, error: String(e && e.message || e) } }
})
ipcMain.handle('gen-check', (event, paths) => {
  const out = {}
  for (const p of (Array.isArray(paths) ? paths : [])) {
    try { out[p] = !!localReadablePath(p) && fs.existsSync(p) && fs.statSync(p).size > 0 }
    catch { out[p] = false }
  }
  return { success: true, alive: out }
})
// v976: 앱이 만든 폴더의 파일을 base64 로 읽는다 (모델 입력용 — ffs:// 는 외부가 못 읽는다)
ipcMain.handle('local-read', async (event, payload) => {
  const full = localReadablePath(payload && payload.path)
  if (!full) return { success: false, error: '앱 데이터 폴더 밖의 경로입니다.' }
  try {
    if (!fs.existsSync(full)) return { success: false, error: '파일이 없습니다.' }
    const buf = fs.readFileSync(full)
    const ext = path.extname(full).slice(1).toLowerCase()
    const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
      mp4: 'video/mp4', mp3: 'audio/mpeg', wav: 'audio/wav' }
    return { success: true, base64: buf.toString('base64'), mime: MIME[ext] || 'application/octet-stream', bytes: buf.length }
  } catch (e) { return { success: false, error: String(e && e.message || e) } }
})

ipcMain.handle('gen-usage', () => {
  try {
    const all = genAll()
    return { success: true, count: all.length, bytes: all.reduce((n, x) => n + x.size, 0),
      dir: path.join(app.getPath('userData'), 'gen'), capBytes: GEN_CAP_BYTES }
  } catch (e) { return { success: false, error: String(e && e.message || e) } }
})

ipcMain.handle('asset-save', async (event, payload) => {
  const { kind, id, base64, mime } = payload || {}
  if (!base64) return { success: false, error: '저장할 데이터가 없습니다.' }
  const safeId = String(id || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80)
  if (!safeId) return { success: false, error: '자산 id 가 없습니다.' }
  const ext = ASSET_EXT[String(mime || '').toLowerCase()] || 'bin'
  const dest = path.join(assetDir(kind), `${safeId}.${ext}`)
  try {
    const buf = Buffer.from(String(base64), 'base64')
    if (!buf.length) return { success: false, error: '데이터가 비어 있습니다.' }
    // 같은 id 의 다른 확장자 파일이 남아 있으면 지운다 (형식이 바뀐 경우)
    try {
      for (const f of fs.readdirSync(assetDir(kind))) {
        if (f.startsWith(`${safeId}.`) && f !== path.basename(dest)) {
          try { fs.unlinkSync(path.join(assetDir(kind), f)) } catch {}
        }
      }
    } catch {}
    const tmp = `${dest}.part`
    fs.writeFileSync(tmp, buf)
    fs.renameSync(tmp, dest)
    return { success: true, path: dest, bytes: buf.length, mime: String(mime || '') }
  } catch (e) { return { success: false, error: String(e && e.message || e) } }
})

ipcMain.handle('asset-read', async (event, payload) => {
  const full = assetPathInside(payload && payload.path)
  if (!full) return { success: false, error: '라이브러리 밖의 경로입니다.' }
  try {
    if (!fs.existsSync(full)) return { success: false, error: '파일이 없습니다.' }
    const buf = fs.readFileSync(full)
    const ext = path.extname(full).slice(1).toLowerCase()
    const mime = Object.keys(ASSET_EXT).find(k => ASSET_EXT[k] === ext) || 'application/octet-stream'
    return { success: true, base64: buf.toString('base64'), mime, bytes: buf.length }
  } catch (e) { return { success: false, error: String(e && e.message || e) } }
})

ipcMain.handle('asset-delete', async (event, payload) => {
  const full = assetPathInside(payload && payload.path)
  if (!full) return { success: false, error: '라이브러리 밖의 경로입니다.' }
  try { if (fs.existsSync(full)) fs.unlinkSync(full); return { success: true } }
  catch (e) { return { success: false, error: String(e && e.message || e) } }
})

ipcMain.handle('asset-usage', async (event, kind) => {
  try {
    const dir = assetDir(kind)
    let bytes = 0, count = 0
    for (const f of fs.readdirSync(dir)) {
      try { const st = fs.statSync(path.join(dir, f)); if (st.isFile()) { bytes += st.size; count++ } } catch {}
    }
    return { success: true, bytes, count, dir }
  } catch (e) { return { success: false, error: String(e && e.message || e) } }
})

// 리다이렉트를 따라가며 파일로 받는다. 실패하면 부분 파일을 남기지 않는다.
function downloadTo(url, dest, depth = 0) {
  return new Promise((resolve, reject) => {
    if (depth > 5) return reject(new Error('리다이렉트가 너무 많습니다.'))
    let mod
    try { mod = require(new URL(url).protocol === 'http:' ? 'http' : 'https') }
    catch { return reject(new Error('주소를 읽을 수 없습니다.')) }
    const req = mod.get(url, { timeout: 120000 }, (res) => {
      const code = res.statusCode || 0
      if (code >= 300 && code < 400 && res.headers.location) {
        res.resume()
        const next = new URL(res.headers.location, url).toString()
        return downloadTo(next, dest, depth + 1).then(resolve, reject)
      }
      if (code !== 200) { res.resume(); return reject(new Error(`서버가 ${code} 을 돌려줬습니다.`)) }
      const tmp = dest + '.part'
      const ws = fs.createWriteStream(tmp)
      res.pipe(ws)
      ws.on('finish', () => {
        ws.close(() => {
          try {
            const st = fs.statSync(tmp)
            if (!st.size) { fs.unlinkSync(tmp); return reject(new Error('빈 파일을 받았습니다.')) }
            fs.renameSync(tmp, dest)
            resolve(st.size)
          } catch (e) { reject(e) }
        })
      })
      ws.on('error', (e) => { try { fs.unlinkSync(tmp) } catch {} ; reject(e) })
    })
    req.on('timeout', () => { req.destroy(new Error('시간이 초과됐습니다.')) })
    req.on('error', reject)
  })
}

// 이미 받아둔 것이 있으면 다시 받지 않는다
ipcMain.handle('clip-save', async (event, payload) => {
  const { projectId, segId, url, ts } = payload || {}
  if (!url || !/^https?:\/\//i.test(String(url))) return { success: false, error: '내려받을 주소가 아닙니다.' }
  const safeSeg = String(segId || 'clip').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) || 'clip'
  const stamp = Number(ts) || Date.now()
  const dest = path.join(clipDir(projectId), `${safeSeg}-${stamp}.mp4`)
  try {
    if (fs.existsSync(dest)) {
      const st = fs.statSync(dest)
      if (st.size > 0) return { success: true, path: dest, bytes: st.size, cached: true }
    }
    const bytes = await downloadTo(String(url), dest)
    return { success: true, path: dest, bytes }
  } catch (e) { return { success: false, error: String(e && e.message || e) } }
})

// 받아둔 파일이 아직 있는지 (프로젝트를 열 때 확인용)
ipcMain.handle('clip-check', (event, paths) => {
  const out = {}
  for (const p of (Array.isArray(paths) ? paths : [])) {
    try { out[p] = fs.existsSync(p) && fs.statSync(p).size > 0 }
    catch { out[p] = false }
  }
  return { success: true, alive: out }
})

ipcMain.handle('clip-usage', (event, projectId) => {
  try {
    const dir = clipDir(projectId)
    let bytes = 0, count = 0
    for (const f of fs.readdirSync(dir)) {
      try { const st = fs.statSync(path.join(dir, f)); if (st.isFile()) { bytes += st.size; count++ } } catch {}
    }
    return { success: true, bytes, count, dir }
  } catch (e) { return { success: false, error: String(e && e.message || e) } }
})

ipcMain.handle('project-delete', (event, id) => {
  const full = projectPath(id)
  if (!full) return { success: false, error: '잘못된 프로젝트 id 입니다.' }
  try {
    fs.unlinkSync(full)
    // v934: 받아둔 클립도 같이 지운다 — 남겨두면 갈 곳 없는 파일이 쌓인다
    try { fs.rmSync(clipDir(id), { recursive: true, force: true }) } catch {}
    return { success: true }
  }
  catch (e) { return { success: false, error: String(e && e.message || e) } }
})

function getArchiveRoot() {
  const dir = path.join(app.getPath('userData'), 'archive')
  try { fs.mkdirSync(dir, { recursive: true }) } catch {}
  return dir
}
function getArchiveCatDir(cat) {
  const c = ARCHIVE_CATS.includes(cat) ? cat : 'etc'
  const dir = path.join(getArchiveRoot(), c)
  try { fs.mkdirSync(dir, { recursive: true }) } catch {}
  return dir
}
function getTrashRoot() {
  const dir = path.join(getArchiveRoot(), '.trash')
  try { fs.mkdirSync(dir, { recursive: true }) } catch {}
  return dir
}
// v788: Windows 파일명 규칙 — 금지문자 외에도 (a) 끝의 점/공백 금지,
//   (b) 예약 디바이스명(CON, PRN, AUX, NUL, COM1~9, LPT1~9) 금지, (c) 경로 길이 260 제한.
const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i
function safeFileName(filename, fallback = 'download') {
  let s = String(filename || '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
  s = s.replace(/[. ]+$/, '')            // 끝의 점·공백 제거 (Windows에서 접근 불가 파일이 됨)
  if (!s) s = fallback
  const ext = path.extname(s)
  let stem = s.slice(0, s.length - ext.length)
  if (WIN_RESERVED.test(stem)) stem = `_${stem}`
  // 이름 자체가 너무 길면 잘라낸다 (경로 전체 길이는 호출부에서 한 번 더 본다)
  if (Buffer.byteLength(stem, 'utf8') > 160) {
    while (Buffer.byteLength(stem, 'utf8') > 160) stem = stem.slice(0, -1)
  }
  return (stem || fallback) + ext
}
// destDir 안에서 MAX_PATH(260)를 넘지 않도록 이름을 더 줄인다
function fitPathLength(destDir, base) {
  if (process.platform !== 'win32') return base
  const room = 255 - destDir.length - 1
  if (room <= 8 || base.length <= room) return base
  const ext = path.extname(base)
  const stem = base.slice(0, base.length - ext.length)
  return stem.slice(0, Math.max(1, room - ext.length)) + ext
}
// Windows는 방금 쓰인 파일의 핸들이 잠깐 남아 EBUSY/EPERM이 난다 → 짧게 재시도
function retrySync(fn, tries = 5, waitMs = 120) {
  for (let i = 0; i < tries; i++) {
    try { return fn() } catch (err) {
      const code = err && err.code
      const retriable = code === 'EBUSY' || code === 'EPERM' || code === 'EACCES' || code === 'ENOENT'
      if (!retriable || i === tries - 1) throw err
      const until = Date.now() + waitMs * (i + 1)
      while (Date.now() < until) { /* 동기 대기 — done 핸들러 안에서만 쓰므로 짧게 */ }
    }
  }
}
// 이름 충돌을 피한 최종 경로
function collisionFreePath(destDir, base) {
  let name = fitPathLength(destDir, safeFileName(base))
  let dest = path.join(destDir, name)
  if (!fs.existsSync(dest)) return dest
  const ext = path.extname(name)
  const stem = name.slice(0, name.length - ext.length)
  for (let n = 1; n < 10000; n++) {
    const cand = fitPathLength(destDir, `${stem}_${n}${ext}`)
    dest = path.join(destDir, cand)
    if (!fs.existsSync(dest)) return dest
  }
  return path.join(destDir, `${stem}_${Date.now()}${ext}`)
}

// 파일을 destDir로 이동 → 최종 경로 반환
// v788: rename은 볼륨이 다르면 EXDEV로 실패한다. Windows에서 다운로드 폴더가
//   OneDrive나 다른 드라이브로 리다이렉트된 경우가 흔하므로 복사+삭제로 폴백한다.
function moveFileTo(src, destDir) {
  try { fs.mkdirSync(destDir, { recursive: true }) } catch {}
  const dest = collisionFreePath(destDir, path.basename(src))
  try {
    retrySync(() => fs.renameSync(src, dest))
  } catch (err) {
    if (err && (err.code === 'EXDEV' || err.code === 'EPERM' || err.code === 'EBUSY')) {
      retrySync(() => fs.copyFileSync(src, dest))
      try { retrySync(() => fs.unlinkSync(src)) } catch {}
    } else throw err
  }
  return dest
}

// 전체(모든 하위폴더 합산) 300개 초과 시 가장 오래된 파일부터 삭제
function enforceArchiveCap() {
  try {
    const root = getArchiveRoot()
    const all = []
    for (const cat of ARCHIVE_CATS) {
      const dir = path.join(root, cat)
      if (!fs.existsSync(dir)) continue
      for (const name of fs.readdirSync(dir)) {
        try { const full = path.join(dir, name); const st = fs.statSync(full); if (st.isFile()) all.push({ full, t: st.mtimeMs }) } catch {}
      }
    }
    all.sort((a, b) => a.t - b.t)
    if (all.length > ARCHIVE_MAX) {
      for (const f of all.slice(0, all.length - ARCHIVE_MAX)) { try { fs.unlinkSync(f.full) } catch {} }
    }
  } catch {}
}

// 다운로드한 파일을 카테고리 하위폴더에 복사 (+ 전체 300개 제한)
function archiveFile(srcPath, cat) {
  try {
    if (!srcPath) return
    // v788: 다운로드 직후엔 Windows가 아직 파일 핸들을 잡고 있어 존재 확인·복사가
    //   모두 실패할 수 있다. 존재 확인까지 재시도 대상에 넣는다.
    const dir = getArchiveCatDir(cat || currentDownloadCategory)
    const dest = collisionFreePath(dir, path.basename(srcPath))
    retrySync(() => {
      if (!fs.existsSync(srcPath)) { const e = new Error('아직 기록 중'); e.code = 'ENOENT'; throw e }
      fs.copyFileSync(srcPath, dest)
    })
    enforceArchiveCap()
  } catch (err) {
    console.error('[archive] 복사 실패:', srcPath, err && (err.code || err.message))
  }
}

// 다운로드 폴더 내 중복 없는 저장 경로
function uniqueDownloadPath(filename) {
  const dir = app.getPath('downloads')
  try { fs.mkdirSync(dir, { recursive: true }) } catch {}
  return collisionFreePath(dir, filename || 'download')
}

// 아카이브 파일 목록 (하위폴더별 카테고리 포함, 최신순)
ipcMain.handle('archive-list', async () => {
  try {
    const root = getArchiveRoot()
    const items = []
    const readDir = (dir, cat) => {
      if (!fs.existsSync(dir)) return
      for (const name of fs.readdirSync(dir)) {
        if (name.startsWith('.')) continue
        try {
          const full = path.join(dir, name)
          const st = fs.statSync(full)
          if (!st.isFile()) continue
          items.push({ name, path: full, ext: path.extname(name).slice(1).toLowerCase(), size: st.size, mtime: st.mtimeMs, category: cat })
        } catch {}
      }
    }
    for (const cat of ARCHIVE_CATS) readDir(path.join(root, cat), cat)
    readDir(root, 'etc') // 하위폴더 이전에 저장된 루트 파일 호환
    items.sort((a, b) => b.mtime - a.mtime)
    return { success: true, items }
  } catch (err) {
    return { success: false, error: err?.message || String(err), items: [] }
  }
})

// 아카이브 파일을 기본 앱으로 열기
ipcMain.handle('archive-open', async (event, filePath) => {
  try { await shell.openPath(filePath); return { success: true } }
  catch (err) { return { success: false, error: err?.message || String(err) } }
})

// 아카이브 파일을 다운로드 폴더로 복사 (다운로드 폴더에서 지워졌어도 아카이브에서 다시 받기)
ipcMain.handle('archive-download', async (event, filePath) => {
  try {
    const root = path.resolve(getArchiveRoot())
    const target = path.resolve(filePath || '')
    if (!target.startsWith(root + path.sep)) return { success: false, error: '아카이브 폴더 밖의 파일은 다운로드할 수 없습니다.' }
    if (!fs.existsSync(target)) return { success: false, error: '원본 파일을 찾을 수 없습니다.' }
    const dest = uniqueDownloadPath(path.basename(target))
    fs.copyFileSync(target, dest)
    return { success: true, path: dest }
  } catch (err) { return { success: false, error: err?.message || String(err) } }
})

// 아카이브 파일 삭제 (아카이브 폴더 안의 파일만 허용) — 레거시, 즉시 영구삭제
ipcMain.handle('archive-delete', async (event, filePath) => {
  try {
    const root = path.resolve(getArchiveRoot())
    const target = path.resolve(filePath || '')
    if (!target.startsWith(root + path.sep)) return { success: false, error: '아카이브 폴더 밖의 파일은 삭제할 수 없습니다.' }
    if (fs.existsSync(target)) fs.unlinkSync(target)
    return { success: true }
  } catch (err) { return { success: false, error: err?.message || String(err) } }
})

// 활성 아카이브 → 휴지통(.trash/<cat>)으로 이동
ipcMain.handle('archive-trash', async (event, paths) => {
  try {
    const root = path.resolve(getArchiveRoot())
    const troot = path.resolve(getTrashRoot())
    for (const p of (paths || [])) {
      const target = path.resolve(p || '')
      if (!target.startsWith(root + path.sep)) continue
      if (target.startsWith(troot + path.sep)) continue // 이미 휴지통
      if (!fs.existsSync(target)) continue
      const cat = path.basename(path.dirname(target))
      moveFileTo(target, path.join(getTrashRoot(), ARCHIVE_CATS.includes(cat) ? cat : 'etc'))
    }
    return { success: true }
  } catch (err) { return { success: false, error: err?.message || String(err) } }
})

// 휴지통 → 원래 카테고리로 복구
ipcMain.handle('archive-restore', async (event, paths) => {
  try {
    const troot = path.resolve(getTrashRoot())
    for (const p of (paths || [])) {
      const target = path.resolve(p || '')
      if (!target.startsWith(troot + path.sep)) continue
      if (!fs.existsSync(target)) continue
      const cat = path.basename(path.dirname(target))
      moveFileTo(target, getArchiveCatDir(cat))
    }
    enforceArchiveCap()
    return { success: true }
  } catch (err) { return { success: false, error: err?.message || String(err) } }
})

// 휴지통 파일 영구 삭제 (.trash 안의 파일만 허용)
ipcMain.handle('archive-purge', async (event, paths) => {
  try {
    const troot = path.resolve(getTrashRoot())
    for (const p of (paths || [])) {
      const target = path.resolve(p || '')
      if (!target.startsWith(troot + path.sep)) continue
      if (fs.existsSync(target)) fs.unlinkSync(target)
    }
    return { success: true }
  } catch (err) { return { success: false, error: err?.message || String(err) } }
})

// 휴지통 목록 (카테고리 포함, 최신순)
ipcMain.handle('archive-trash-list', async () => {
  try {
    const troot = getTrashRoot()
    const items = []
    for (const cat of ARCHIVE_CATS) {
      const dir = path.join(troot, cat)
      if (!fs.existsSync(dir)) continue
      for (const name of fs.readdirSync(dir)) {
        if (name.startsWith('.')) continue
        try {
          const full = path.join(dir, name)
          const st = fs.statSync(full)
          if (!st.isFile()) continue
          items.push({ name, path: full, ext: path.extname(name).slice(1).toLowerCase(), size: st.size, mtime: st.mtimeMs, category: cat })
        } catch {}
      }
    }
    items.sort((a, b) => b.mtime - a.mtime)
    return { success: true, items }
  } catch (err) { return { success: false, error: err?.message || String(err), items: [] } }
})

// HTML을 받아 printToPDF로 진짜 텍스트 PDF를 만들어 저장 (검색·복사 가능)
ipcMain.handle('export-pdf', async (event, payload) => {
  const html = payload?.html || ''
  const defaultName = (payload?.defaultName || 'scenario').replace(/[\\/:*?"<>|]/g, '_')
  if (!html) return { success: false, error: 'HTML이 비어 있습니다.' }
  let win
  const tmpHtml = path.join(os.tmpdir(), `oxyzn-pdf-${Date.now()}.html`)
  try {
    fs.writeFileSync(tmpHtml, html, 'utf-8')
    win = new BrowserWindow({ show: false, webPreferences: { offscreen: false } })
    await win.loadFile(tmpHtml)
    // 폰트/렌더 안정화 대기
    await new Promise((r) => setTimeout(r, 300))
    const pdfBuffer = await win.webContents.printToPDF({
      printBackground: true,
      preferCSSPageSize: true,
      pageSize: 'A4',
    })
    // v575: silent 모드 — 시스템 저장 대화상자 없이 다운로드 폴더에 바로 저장 (인앱 팝업에서 확인)
    if (payload?.silent) {
      const silentPath = uniqueDownloadPath(`${defaultName}.pdf`)
      fs.writeFileSync(silentPath, pdfBuffer)
      archiveFile(silentPath, payload?.category)
      return { success: true, path: silentPath }
    }
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: 'PDF로 저장',
      defaultPath: path.join(app.getPath('downloads'), `${defaultName}.pdf`),
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    })
    if (canceled || !filePath) return { success: false, canceled: true }
    fs.writeFileSync(filePath, pdfBuffer)
    archiveFile(filePath, payload?.category) // 아카이브(카테고리 하위폴더)에도 저장
    return { success: true, path: filePath }
  } catch (err) {
    return { success: false, error: err?.message || String(err) }
  } finally {
    if (win) { try { win.destroy() } catch {} }
    try { fs.unlinkSync(tmpHtml) } catch {}
  }
})

// ─────────────────────────────────────────────
// 다운로드 폴더 실시간 미러 (우측 패널) + 네이티브 파일 드래그
// ─────────────────────────────────────────────
// 다운로드 패널에 노출할 미디어 확장자 (이미지·비디오·오디오만)
const DL_MEDIA_EXT = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif', 'heic', 'heif', 'tiff', 'tif', // 이미지
  'mp4', 'mov', 'webm', 'm4v', 'mkv', 'avi', 'wmv', 'flv', // 비디오
  'mp3', 'wav', 'm4a', 'flac', 'aac', 'ogg', 'opus', 'aiff', 'aif', // 오디오
])
// 네이티브 드래그 폴백 아이콘 (문서 모양, 미디어가 아닐 때 사용)
const DRAG_FALLBACK_ICON = nativeImage.createFromDataURL('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAbUlEQVR42u3boQ0AIBAEwe+/MhSSKkgQFPAUgMMBs8k1MP4iJEnaKrXlSwNwCtDHvHoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIcJAJKkj1qh2I564U87ogAAAABJRU5ErkJggg==')

// 다운로드 폴더 파일 목록 (최신순, 부분 다운로드 임시파일 제외)
ipcMain.handle('downloads-list', async () => {
  try {
    const dir = app.getPath('downloads')
    const items = []
    for (const name of fs.readdirSync(dir)) {
      if (name.startsWith('.')) continue
      const ext = path.extname(name).slice(1).toLowerCase()
      if (!DL_MEDIA_EXT.has(ext)) continue // 이미지·비디오·오디오만 노출 (폴더·기타 파일 제외)
      try {
        const full = path.join(dir, name)
        const st = fs.statSync(full)
        if (!st.isFile()) continue
        items.push({ name, path: full, ext, size: st.size, mtime: st.mtimeMs, isDir: false })
      } catch {}
    }
    items.sort((a, b) => b.mtime - a.mtime)
    return { success: true, items }
  } catch (err) {
    return { success: false, error: err?.message || String(err), items: [] }
  }
})

// ─────────────────────────────────────────────────────────────
// v855: 다운로드 항목 이름 바꾸기 — 실제 파일을 rename 한다
//
// 렌더러가 준 경로를 그대로 믿지 않는다. 파일시스템을 쓰는 유일한 쓰기 경로라
// 경계를 좁게 잡았다.
//   · 대상 파일의 디렉터리가 다운로드 폴더와 정확히 같아야 한다 (하위 폴더도 거부)
//   · 실제 파일이어야 한다 (심볼릭 링크·폴더 거부)
//   · 확장자가 목록에 노출되는 미디어 확장자여야 한다 — 목록에 없는 파일은 손대지 않는다
//   · 확장자는 사용자가 못 바꾼다. 자동으로 원본 것을 붙인다 (mp4 를 잃으면 재생이 깨진다)
//
// 이름 검사는 Windows 기준으로 맞춘다. 배포 대상에 Windows 가 있고,
// macOS 에서만 되는 이름을 허용하면 파일을 옮길 때 깨진다.
// ─────────────────────────────────────────────────────────────
// 이름 후보를 검사해 { ok, base } 또는 { ok:false, error } 를 돌려준다
function sanitizeFileBase(raw) {
  let b = String(raw == null ? '' : raw)
  if (b.includes('\u0000')) return { ok: false, error: '이름에 쓸 수 없는 문자가 있습니다.' }
  // 경로 구분자·Windows 금지문자·제어문자 제거
  b = b.replace(/[\\/:*?"<>|]/g, '').replace(/[\x00-\x1f\x7f]/g, '')
  // Windows 는 끝의 점·공백을 잘라버린다 → 미리 잘라 예측 가능하게 만든다
  b = b.replace(/^[\s.]+|[\s.]+$/g, '').trim()
  if (!b) return { ok: false, error: '이름을 입력해주세요.' }
  if (b.length > 120) return { ok: false, error: '이름이 너무 깁니다. 120자 이내로 줄여주세요.' }
  // 373행의 기존 정규식을 그대로 쓴다 (같은 규칙을 두 곳에 두면 어긋난다)
  if (WIN_RESERVED.test(b)) return { ok: false, error: `"${b}" 는 Windows 예약어라 파일명으로 쓸 수 없습니다.` }
  return { ok: true, base: b }
}

ipcMain.handle('downloads-rename', async (event, payload) => {
  try {
    const p = payload || {}
    const target = String(p.path || '')
    if (!target) return { success: false, error: '대상 파일이 지정되지 않았습니다.' }

    const dir = app.getPath('downloads')
    const full = path.resolve(target)
    // 다운로드 폴더 직속 파일만 — 상위 탈출(..)과 하위 폴더를 모두 막는다
    if (path.dirname(full) !== path.resolve(dir)) {
      return { success: false, error: '다운로드 폴더의 파일만 이름을 바꿀 수 있습니다.' }
    }
    let st
    try { st = fs.lstatSync(full) } catch { return { success: false, error: '파일을 찾을 수 없습니다.' } }
    if (!st.isFile()) return { success: false, error: '파일만 이름을 바꿀 수 있습니다.' }

    const ext = path.extname(full)                       // '.mp4' 형태 (없을 수도 있다)
    const extKey = ext.slice(1).toLowerCase()
    if (!DL_MEDIA_EXT.has(extKey)) {
      return { success: false, error: '이 형식의 파일은 이름을 바꿀 수 없습니다.' }
    }

    const chk = sanitizeFileBase(p.newBase)
    if (!chk.ok) return { success: false, error: chk.error }

    // 사용자가 확장자까지 타이핑하는 건 자연스럽다 ('골목.mp4'). 그대로 붙이면
    // '골목.mp4.mp4' 가 되므로, 원본과 같은 확장자로 끝나면 한 번만 남긴다.
    // 다른 확장자를 적은 경우('a.png' 를 'b.mp4' 로)는 그대로 둔다 —
    // 확장자는 바꿀 수 없고, 이름의 일부로 취급하는 것이 맞다.
    let base = chk.base
    if (ext && base.toLowerCase().endsWith(ext.toLowerCase())) {
      const stripped = base.slice(0, base.length - ext.length).replace(/[\s.]+$/, '')
      if (stripped) base = stripped
    }
    const nextName = base + ext
    const next = path.join(path.resolve(dir), nextName)
    if (next === full) return { success: true, name: path.basename(full), path: full, unchanged: true }

    // 충돌 검사. macOS 는 기본이 대소문자 구분 없는 파일시스템이라 'A.mp4' → 'a.mp4' 는
    // existsSync 가 true 를 주지만 실제로는 같은 파일이다. 그 경우는 통과시킨다.
    if (fs.existsSync(next)) {
      let same = false
      try {
        const a = fs.statSync(full), b = fs.statSync(next)
        same = a.ino === b.ino && a.dev === b.dev
      } catch {}
      if (!same) return { success: false, error: `"${nextName}" 이 이미 있습니다. 다른 이름을 써주세요.` }
    }

    fs.renameSync(full, next)
    console.log('[downloads-rename]', path.basename(full), '→', nextName)
    return { success: true, name: nextName, path: next }
  } catch (err) {
    console.warn('[downloads-rename] 실패:', err && err.message)
    return { success: false, error: err?.message || String(err) }
  }
})

// 파일명 버전 계산 — base(OXYZN_유형_구분)와 동일한 파일이 다운로드 폴더+아카이브에
// 이미 있으면 최대 버전 +1을 붙여 최종 이름 반환 (예: OXYZN_각색_제목 → OXYZN_각색_제목_v003)
ipcMain.handle('ffs-name', (event, base) => {
  try {
    const safeBase = String(base || 'OXYZN_file').replace(/[\\/:*?"<>|\x00-\x1f]/g, '').replace(/[. ]+$/, '').trim() || 'OXYZN_file'
    // v965: 한글은 같은 글자를 NFC(조합형)와 NFD(분해형) 두 방식으로 담을 수 있고
    //   macOS 파일명에는 둘이 섞여 있다. 정규화하지 않으면 분해형으로 저장된
    //   파일을 못 찾아서 같은 번호를 다시 발급하고, OS 가 뒤에 _1 을 붙인다.
    //   실제로 그렇게 남아 있었다 — FFS_커스텀_골목집촬영_1080p_v001.mp4 (분해형).
    const nfc = (x) => { try { return String(x).normalize('NFC') } catch { return String(x) } }
    const re = new RegExp('^' + nfc(safeBase).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '_v(\\d{3})(?:\\.|$|_)', 'i')
    let max = 0
    const scanDir = (dir) => {
      if (!dir || !fs.existsSync(dir)) return
      let names
      try { names = fs.readdirSync(dir) } catch { return }
      for (const name of names) {
        const m = nfc(name).match(re)
        if (m) { const n = parseInt(m[1], 10); if (n > max) max = n }
      }
    }
    scanDir(app.getPath('downloads'))
    const root = getArchiveRoot()
    for (const cat of ARCHIVE_CATS) scanDir(path.join(root, cat))
    scanDir(root)
    const version = max + 1
    return { success: true, name: `${safeBase}_v${String(version).padStart(3, '0')}`, version }
  } catch (err) {
    return { success: false, error: err?.message || String(err), name: `${base}_v001`, version: 1 }
  }
})

// 다운로드 폴더를 파일 탐색기/파인더로 열기
ipcMain.handle('downloads-reveal', async () => {
  try { await shell.openPath(app.getPath('downloads')); return { success: true } }
  catch (err) { return { success: false, error: err?.message || String(err) } }
})

// 임의 경로를 기본 앱으로 열기
ipcMain.handle('open-path', async (event, filePath) => {
  try { await shell.openPath(filePath); return { success: true } }
  catch (err) { return { success: false, error: err?.message || String(err) } }
})

// 렌더러 그리드 → OS 네이티브 파일 드래그 시작 (드롭존이 Finder 드롭과 동일하게 인식)
ipcMain.on('ff-file-drag', (event, filePath) => {
  try {
    if (!filePath || !fs.existsSync(filePath)) return
    let icon = nativeImage.createFromPath(filePath)
    if (icon.isEmpty()) {
      icon = DRAG_FALLBACK_ICON
    } else {
      const { width } = icon.getSize()
      if (width > 96) icon = icon.resize({ width: 72 })
    }
    if (icon.isEmpty()) icon = DRAG_FALLBACK_ICON
    event.sender.startDrag({ file: filePath, icon })
  } catch (err) {
    console.error('[ff-file-drag] 실패:', err?.message || err)
  }
})

// 다운로드 폴더 실시간 감시 → 변경 시 렌더러에 알림 (디바운스)
let dlWatcher = null
let dlDebounce = null
function notifyDownloadsChanged() {
  if (dlDebounce) clearTimeout(dlDebounce)
  dlDebounce = setTimeout(() => {
    for (const w of BrowserWindow.getAllWindows()) {
      try { w.webContents.send('downloads-changed') } catch {}
    }
  }, 250)
}
// v788: fs.watch 단독으로는 Windows에서 신뢰할 수 없다.
//   · Windows의 다운로드 폴더는 OneDrive로 리다이렉트된 경우가 흔하고, 동기화
//     폴더에서는 변경 이벤트가 누락되거나 지연된다.
//   · 폴더가 일시적으로 사라지거나 권한이 바뀌면 watcher가 조용히 죽는다.
//   그래서 watcher는 그대로 두고 '주기 폴링'을 폴백으로 함께 돌린다.
//   폴링은 파일 수 + 최신 mtime + 총 용량만 비교하므로 비용이 낮다.
let dlPollTimer = null
let dlLastSig = ''
function downloadsSignature() {
  try {
    const dir = app.getPath('downloads')
    let count = 0, newest = 0, bytes = 0
    for (const name of fs.readdirSync(dir)) {
      if (name.startsWith('.')) continue
      const ext = path.extname(name).slice(1).toLowerCase()
      if (!DL_MEDIA_EXT.has(ext)) continue
      try {
        const st = fs.statSync(path.join(dir, name))
        if (!st.isFile()) continue
        count++; bytes += st.size
        if (st.mtimeMs > newest) newest = st.mtimeMs
      } catch {}
    }
    return `${count}:${Math.round(newest)}:${bytes}`
  } catch { return 'ERR' }
}
function startDownloadsPolling() {
  if (dlPollTimer) return
  dlLastSig = downloadsSignature()
  dlPollTimer = setInterval(() => {
    // 창이 없으면 알릴 대상도 없으므로 건너뛴다
    if (BrowserWindow.getAllWindows().length === 0) return
    const sig = downloadsSignature()
    if (sig !== dlLastSig) { dlLastSig = sig; notifyDownloadsChanged() }
  }, 4000)
  if (dlPollTimer.unref) dlPollTimer.unref()
}
function startDownloadsWatcher() {
  startDownloadsPolling()
  try {
    if (dlWatcher) { try { dlWatcher.close() } catch {} dlWatcher = null }
    const dir = app.getPath('downloads')
    try { fs.mkdirSync(dir, { recursive: true }) } catch {}
    dlWatcher = fs.watch(dir, { persistent: false }, () => notifyDownloadsChanged())
    dlWatcher.on('error', () => { try { dlWatcher.close() } catch {} dlWatcher = null; setTimeout(startDownloadsWatcher, 2000) })
    // Windows에서 폴더가 교체되면 watcher가 close만 되고 조용히 멈춘다 → 재연결
    dlWatcher.on('close', () => { if (dlWatcher) { dlWatcher = null; setTimeout(startDownloadsWatcher, 2000) } })
  } catch (err) {
    console.error('[downloads-watch] 실패 — 폴링으로 대체:', err?.message || err)
  }
}

app.whenReady().then(() => {
  // v976: ffs://local/<절대경로> — userData 안쪽만 내준다
  try {
    protocol.handle('ffs', async (req) => {
      try {
        const u = new URL(req.url)
        // standard 스킴이라 pathname 은 '//Users/...' 처럼 온다. 슬래시를 모두 떼면
        //   상대경로가 되어 CWD 기준으로 풀리므로, 하나는 반드시 남긴다.
        //   윈도우는 '/C:/...' 로 오므로 드라이브 문자면 떼고 쓴다.
        let raw = decodeURIComponent(u.pathname || '').replace(/^\/+/, '')
        if (!/^[A-Za-z]:/.test(raw)) raw = '/' + raw
        const full = localReadablePath(raw)
        if (!full) return new Response('forbidden', { status: 403 })
        if (!fs.existsSync(full)) return new Response('not found', { status: 404 })
        return net.fetch(pathToFileURL(full).toString())
      } catch (e) {
        return new Response(String(e && e.message || e), { status: 500 })
      }
    })
  } catch (e) { console.error('[ffs] 프로토콜 등록 실패:', e && e.message) }

  createWindow()
  startDownloadsWatcher()

  // 모든 다운로드: 기본 경로를 OS 다운로드 폴더로 지정 + 완료 시 아카이브 폴더에 복사
  const { session } = require('electron')
  session.defaultSession.on('will-download', (e, item) => {
    const savePath = uniqueDownloadPath(item.getFilename())
    item.setSavePath(savePath)
    item.once('done', (evt, state) => {
      if (state === 'completed') archiveFile(savePath, currentDownloadCategory)
    })
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
