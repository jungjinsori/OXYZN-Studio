// v808: macOS 애드혹(ad-hoc) 서명 — "앱이 손상되었기 때문에 열 수 없습니다" 해결
//
// 왜 필요한가:
//   Apple Silicon(arm64)은 모든 실행 파일에 유효한 코드 서명을 요구한다.
//   Developer ID 인증서가 없으면 electron-builder 는 서명을 통째로 건너뛰는데,
//   그러면 arm64 앱은 실행 자체가 거부되고 macOS 가 "손상됨"으로 안내한다.
//   (x64 는 서명이 없어도 우클릭→열기로 넘어갈 수 있지만 arm64 는 불가)
//
//   빌드 직후 상태를 확인해보면:
//     arm64 → adhoc, linker-signed / Sealed Resources=none  (번들 미봉인)
//     x64   → code object is not signed at all
//   링커가 붙인 임시 서명은 리소스를 교체하면 무효가 되므로, 번들 전체를
//   애드혹으로 다시 서명해 봉인해야 한다.
//
// 이 서명으로 무엇이 달라지는가:
//   · "손상됨"으로 실행이 막히는 문제가 사라진다.
//   · 다만 Developer ID 가 아니므로 Gatekeeper 경고("확인되지 않은 개발자")는
//     여전히 뜬다 → 첫 실행만 우클릭 → 열기 로 통과할 수 있게 된다.
//   · 완전히 경고 없이 열려면 Apple Developer Program 가입 후 서명·공증이 필요하다.

const { execFileSync, spawnSync } = require('child_process')

// codesign -dv 는 정보를 stdout 이 아니라 stderr 로 출력한다.
// execFileSync 의 반환값은 stdout 이므로 그것만 읽으면 항상 빈 문자열이 된다.
const codesignInfo = (appPath) => {
  const r = spawnSync('codesign', ['-dv', '--verbose=2', appPath], { encoding: 'utf8' })
  return `${r.stdout || ''}${r.stderr || ''}`
}
const fs = require('fs')
const path = require('path')

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return

  const appName = `${context.packager.appInfo.productFilename}.app`
  const appPath = path.join(context.appOutDir, appName)
  if (!fs.existsSync(appPath)) {
    console.warn(`[adhoc-sign] 앱을 찾을 수 없어 건너뜁니다: ${appPath}`)
    return
  }

  // 이미 정식 인증서로 서명됐다면 덮어쓰지 않는다
  if (/TeamIdentifier=(?!not set)/.test(codesignInfo(appPath))) {
    console.log('[adhoc-sign] 정식 서명이 이미 있어 건너뜁니다.')
    return
  }

  // 내려받은 파일에 붙는 격리 속성이 남아 있으면 서명이 실패할 수 있어 먼저 제거
  try { execFileSync('xattr', ['-cr', appPath], { stdio: 'ignore' }) } catch {}

  // 번들 전체를 애드혹 서명(--sign -). --deep 은 프레임워크·헬퍼까지 포함한다.
  // Apple 은 배포용으로 --deep 을 권장하지 않지만, 내부 배포용 애드혹 서명에는
  // 헬퍼를 개별 서명하는 것과 결과가 같고 훨씬 단순하다.
  try {
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' })
  } catch (err) {
    console.error('[adhoc-sign] 서명 실패:', err && err.message)
    throw err // 서명 없이 배포하면 arm64 에서 열리지 않으므로 빌드를 멈춘다
  }

  // 검증 — 서명 방식과 리소스 봉인을 모두 확인한다
  const verify = codesignInfo(appPath)
  const adhoc = /Signature=adhoc/.test(verify)
  const sealed = /Sealed Resources version=/.test(verify) && !/Sealed Resources=none/.test(verify)
  const ident = (verify.match(/Identifier=(\S+)/) || [])[1] || '?'
  const archName = String(context.arch) === '1' ? 'x64' : 'arm64'
  console.log(`[adhoc-sign] ${archName} — adhoc=${adhoc} sealed=${sealed} identifier=${ident}`)
  if (!adhoc || !sealed) {
    console.error(verify)
    throw new Error('[adhoc-sign] 서명이 정상적으로 봉인되지 않았습니다.')
  }
  // 실제로 실행 가능한 서명인지 최종 확인 (Gatekeeper 판정과 별개로 서명 무결성만 본다)
  const v = spawnSync('codesign', ['--verify', '--deep', '--strict', appPath], { encoding: 'utf8' })
  if (v.status !== 0) {
    console.error(v.stderr || v.stdout)
    throw new Error('[adhoc-sign] codesign --verify 실패')
  }
  console.log(`[adhoc-sign] ${archName} — 서명 무결성 검증 통과`)
}
