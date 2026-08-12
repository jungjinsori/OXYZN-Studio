// v812: 배포 빌드마다 package.json 의 패치 버전을 올린다 (2.0.0 → 2.0.1 → 2.0.2 …)
//
// 왜 필요한가:
//   산출물 파일명에 버전이 들어간다(OXYZN Studio Setup 2.0.0.exe).
//   버전이 그대로면 새로 빌드해도 파일명이 같아서, 팀원이 이전에 받은 파일과
//   구분할 수 없다. 실제로 v811 빌드가 직전 배포와 같은 파일명으로 나왔다.
//
// 어느 스크립트에 붙는가:
//   build:win / build:mac / build:all — 실제로 배포물을 만드는 명령에만.
//   `npm run build`(vite 만 도는 개발용)에는 붙이지 않는다. 개발 빌드마다
//   버전이 튀면 번호가 의미를 잃는다.
//
// 앞자리(major.minor)는 올리지 않는다. 사용자가 직접 지정하는 값이다.
// 올리려면 package.json 의 version 을 직접 고치면 그 다음부터 뒷자리가 이어진다.

const fs = require('fs')
const path = require('path')

const pkgPath = path.join(__dirname, '..', 'package.json')
const raw = fs.readFileSync(pkgPath, 'utf8')
const pkg = JSON.parse(raw)

const m = String(pkg.version || '').match(/^(\d+)\.(\d+)\.(\d+)(.*)$/)
if (!m) {
  console.error(`[bump-version] version 형식을 해석할 수 없습니다: ${pkg.version}`)
  process.exit(1)
}

const [, major, minor, patch, suffix] = m
const next = `${major}.${minor}.${Number(patch) + 1}${suffix}`

// 들여쓰기·줄바꿈을 원본 그대로 유지해 diff 가 version 한 줄만 남게 한다
const updated = raw.replace(
  new RegExp(`("version"\\s*:\\s*)"${pkg.version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`),
  `$1"${next}"`
)
if (updated === raw) {
  console.error('[bump-version] version 필드를 찾지 못했습니다.')
  process.exit(1)
}

fs.writeFileSync(pkgPath, updated)
console.log(`[bump-version] ${pkg.version} → ${next}`)
