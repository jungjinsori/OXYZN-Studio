// v821: 빌드가 끝나면 압축 해제된 중간산출물을 지운다 (afterAllArtifactBuild 훅)
//
// 왜 필요한가:
//   electron-builder 는 DMG/exe 를 만들기 전에 먼저 '풀어놓은 앱'을 만든다.
//     dist-electron/mac-arm64/OXYZN Studio.app   (arm64)
//     dist-electron/mac/OXYZN Studio.app         (x64)
//     dist-electron/win-unpacked/
//   포장이 끝나도 이게 남아서, 같은 이름·같은 아이콘·같은 번들 ID(com.oxyzn.studio)를
//   가진 앱이 디스크에 여러 벌 존재한다. 프로젝트 폴더가 바탕화면 같은 인덱싱 대상에
//   있으면 Spotlight·Launchpad 검색에 앱이 3개로 잡힌다.
//
//   더 위험한 건 아키텍처를 착각하는 것이다. dist-electron/mac 은 Intel(x86_64)
//   빌드라 M 시리즈에서 실수로 실행하면 Rosetta 로 느리게 돌고, 앱 데이터는
//   ~/Library/Application Support/OXYZN Studio 를 공유해 구분도 안 된다.
//
// 배포에 쓰는 것은 .dmg / .exe 뿐이므로 풀어놓은 앱은 지워도 무해하다.
//
// 빌드 직후 풀린 앱으로 바로 테스트하고 싶으면:
//   FF_KEEP_UNPACKED=1 npm run build:mac

const fs = require('fs')
const path = require('path')

// 지울 대상 판별 — 이름 패턴에 기대지 않고 '풀린 빌드의 증거'가 있는지 본다.
//   macOS: 내부에 .app 번들       · Windows/Linux: resources/app.asar
// 이렇게 하면 electron-builder 가 폴더명을 바꾸거나 새 타깃이 추가돼도 따라가고,
// 산출물이 아닌 폴더를 실수로 지우지 않는다.
const isUnpackedBuild = (dir) => {
  try {
    const entries = fs.readdirSync(dir)
    if (entries.some(e => e.endsWith('.app') && fs.statSync(path.join(dir, e)).isDirectory())) return true
    if (fs.existsSync(path.join(dir, 'resources', 'app.asar'))) return true
  } catch {}
  return false
}

const dirSizeMB = (dir) => {
  let bytes = 0
  const walk = (d) => {
    let items = []
    try { items = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const it of items) {
      const p = path.join(d, it.name)
      if (it.isSymbolicLink()) continue
      if (it.isDirectory()) walk(p)
      else { try { bytes += fs.statSync(p).size } catch {} }
    }
  }
  walk(dir)
  return bytes / 1024 / 1024
}

exports.default = async function afterAllArtifactBuild(buildResult) {
  if (process.env.FF_KEEP_UNPACKED) {
    console.log('[clean-unpacked] FF_KEEP_UNPACKED 설정됨 — 중간산출물을 남깁니다.')
    return []
  }

  const outDir = buildResult && buildResult.outDir
  if (!outDir || !fs.existsSync(outDir)) return []

  let removed = 0
  let freedMB = 0
  for (const name of fs.readdirSync(outDir)) {
    const dir = path.join(outDir, name)
    let st
    try { st = fs.statSync(dir) } catch { continue }
    if (!st.isDirectory()) continue          // .dmg/.exe 등 파일은 건드리지 않는다
    if (!isUnpackedBuild(dir)) continue      // 풀린 빌드가 아니면 건너뛴다

    const mb = dirSizeMB(dir)
    try {
      fs.rmSync(dir, { recursive: true, force: true })
      removed++
      freedMB += mb
      console.log(`[clean-unpacked] 삭제 ${name}  (${mb.toFixed(0)}MB)`)
    } catch (e) {
      // 지우지 못해도 빌드를 실패시키지 않는다 — 배포물(.dmg/.exe)은 이미 완성됐다
      console.warn(`[clean-unpacked] ${name} 삭제 실패(무시): ${e && e.message}`)
    }
  }

  if (removed === 0) console.log('[clean-unpacked] 지울 중간산출물이 없습니다.')
  else console.log(`[clean-unpacked] ${removed}개 폴더 · ${freedMB.toFixed(0)}MB 정리. 배포물은 .dmg/.exe 입니다.`)

  cleanOldArtifacts(outDir)
  return []   // 추가 산출물 없음
}

// ─────────────────────────────────────────────────────────────
// v851: 이전 버전 배포물 정리
//
// 왜 훅에 넣는가:
//   빌드할 때마다 손으로 지우면 언젠가 잊는다. 실제로 dist-electron 에 2.0.8·2.0.9·
//   2.0.10 이 뒤섞여 남았고, exe 없이 dmg 만 있는 버전까지 생겨 팀원에게 어느 파일을
//   줘야 하는지 헷갈렸다. 매 빌드 후 자동으로 도는 이 훅이 제자리다.
//
// 판별 기준 — 보수적으로 잡는다:
//   · 파일만 본다 (디렉터리는 위에서 별도 처리)
//   · 확장자가 배포물 계열인 것만: .exe .dmg .zip .blockmap
//   · 파일명에 semver 가 있고 그 값이 '지금 빌드한 버전'과 다를 때만
//   그래서 latest.yml · latest-mac.yml · builder-debug.yml 은 건드리지 않는다.
//   버전이 없는 파일도 건드리지 않는다.
//
// 남기고 싶으면: FF_KEEP_OLD=1 npm run build:all
// ─────────────────────────────────────────────────────────────
function cleanOldArtifacts(outDir) {
  if (process.env.FF_KEEP_OLD) {
    console.log('[clean-unpacked] FF_KEEP_OLD 설정됨 — 이전 버전 배포물을 남깁니다.')
    return
  }
  let cur
  try {
    cur = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version
  } catch (e) {
    console.warn('[clean-unpacked] package.json 버전을 읽지 못해 이전 버전 정리를 건너뜁니다.')
    return
  }
  if (!/^\d+\.\d+\.\d+/.test(String(cur || ''))) {
    console.warn(`[clean-unpacked] 버전 형식을 해석할 수 없어 건너뜁니다: ${cur}`)
    return
  }

  const DIST_EXT = /\.(exe|dmg|zip|blockmap)$/i
  let n = 0
  let mb = 0
  for (const name of fs.readdirSync(outDir)) {
    const f = path.join(outDir, name)
    let st
    try { st = fs.statSync(f) } catch { continue }
    if (!st.isFile()) continue
    if (!DIST_EXT.test(name)) continue           // yml·기타 파일은 그대로
    const m = name.match(/(\d+\.\d+\.\d+)/)
    if (!m) continue                             // 버전이 없는 파일은 판단하지 않는다
    if (m[1] === cur) continue                   // 이번 빌드 산출물은 남긴다

    try {
      const size = st.size / 1024 / 1024
      fs.rmSync(f, { force: true })
      n++
      mb += size
      console.log(`[clean-unpacked] 이전 버전 삭제 ${name}  (${size.toFixed(0)}MB)`)
    } catch (e) {
      console.warn(`[clean-unpacked] ${name} 삭제 실패(무시): ${e && e.message}`)
    }
  }
  if (n === 0) console.log(`[clean-unpacked] 이전 버전 배포물 없음 (현재 ${cur}).`)
  else console.log(`[clean-unpacked] 이전 버전 ${n}개 · ${mb.toFixed(0)}MB 정리. 남은 배포물은 ${cur} 뿐입니다.`)
}
