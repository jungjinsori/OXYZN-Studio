// v793: pdf.js의 CMap·표준폰트를 public/pdfjs/ 로 복사한다.
//   이 파일들은 번들러가 자동으로 끌어오지 않는 '런타임에 URL로 요청하는 데이터'다.
//   CMap이 없으면 폰트가 임베드되지 않은 한글·일본어 PDF에서 텍스트 추출이 실패한다.
//   node_modules에서 파생되는 자산이라 git에는 넣지 않고 postinstall로 만든다.
const fs = require('fs')
const path = require('path')

const SRC = path.join(__dirname, '..', 'node_modules', 'pdfjs-dist')
const DEST = path.join(__dirname, '..', 'public', 'pdfjs')

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true })
  for (const name of fs.readdirSync(from)) {
    const s = path.join(from, name)
    const d = path.join(to, name)
    const st = fs.statSync(s)
    if (st.isDirectory()) copyDir(s, d)
    else fs.copyFileSync(s, d)
  }
}

try {
  if (!fs.existsSync(SRC)) {
    console.warn('[pdfjs-assets] pdfjs-dist를 찾을 수 없어 건너뜁니다.')
    process.exit(0)
  }
  let n = 0
  for (const dir of ['cmaps', 'standard_fonts']) {
    const from = path.join(SRC, dir)
    if (!fs.existsSync(from)) { console.warn(`[pdfjs-assets] ${dir} 없음 — 건너뜀`); continue }
    const to = path.join(DEST, dir)
    fs.rmSync(to, { recursive: true, force: true })
    copyDir(from, to)
    const c = fs.readdirSync(to).length
    n += c
    console.log(`[pdfjs-assets] ${dir}: ${c}개 복사`)
  }
  if (n === 0) throw new Error('복사된 파일이 없습니다')
} catch (err) {
  // 빌드를 막지는 않지만, 이 상태로 배포하면 한글 PDF 추출이 실패한다
  console.error('[pdfjs-assets] 복사 실패:', err.message)
  process.exit(1)
}
