// v1266: 챌린지 영상 — 결과 영상에 레퍼런스의 원본 소리를 합치는 데 ffmpeg 가 필요하다.
//   npm 공식 패키지(@ffmpeg-installer/<플랫폼>)의 tarball 에서 실행 파일만 꺼내 vendor/ffmpeg/<플랫폼>-<arch>/ 에 둔다.
//   vendor/ 는 git 에 넣지 않는다. 이미 있으면 아무것도 하지 않는다(빌드마다 다시 받지 않는다).
//   쓰는 법: node scripts/fetch-ffmpeg.cjs [win32-x64|darwin-arm64]   (기본 = 지금 기계)
//   설치 파일에는 package.json 의 build.*.extraResources 가 Resources/ffmpeg/ 로 넣는다.
const fs = require('fs');
const path = require('path');
const https = require('https');
const zlib = require('zlib');

const PKGS = {
  'win32-x64': { name: '@ffmpeg-installer/win32-x64', version: '4.1.0', exe: 'ffmpeg.exe' },   // GPLv3 빌드
  'darwin-arm64': { name: '@ffmpeg-installer/darwin-arm64', version: '4.1.5', exe: 'ffmpeg' },
};
const target = process.argv[2] || `${process.platform}-${process.arch}`;
const pkg = PKGS[target];
if (!pkg) { console.log(`[ffmpeg] ${target} 용 패키지가 없습니다 — 건너뜁니다.`); process.exit(0); }

const outDir = path.join(__dirname, '..', 'vendor', 'ffmpeg', target);
const outFile = path.join(outDir, pkg.exe);
if (fs.existsSync(outFile) && fs.statSync(outFile).size > 1024 * 1024) {
  console.log(`[ffmpeg] 이미 있습니다 — ${path.relative(path.join(__dirname, '..'), outFile)}`);
  process.exit(0);
}

const base = pkg.name.split('/')[1];
const url = `https://registry.npmjs.org/${pkg.name}/-/${base}-${pkg.version}.tgz`;

const get = (u, depth = 0) => new Promise((resolve, reject) => {
  https.get(u, (res) => {
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && depth < 5) {
      res.resume();
      resolve(get(new URL(res.headers.location, u).toString(), depth + 1));
      return;
    }
    if (res.statusCode !== 200) { res.resume(); reject(new Error(`HTTP ${res.statusCode}`)); return; }
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve(Buffer.concat(chunks)));
    res.on('error', reject);
  }).on('error', reject);
});

// tar 를 읽는다 — 512바이트 머리 + 512 단위로 채운 본문. 필요한 파일 하나만 꺼낸다.
const extractFromTar = (tar, wantBase) => {
  let off = 0;
  while (off + 512 <= tar.length) {
    const head = tar.subarray(off, off + 512);
    if (head.every((b) => b === 0)) break;
    const name = head.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
    const prefix = head.subarray(345, 500).toString('utf8').replace(/\0.*$/s, '');
    const size = parseInt(head.subarray(124, 136).toString('utf8').replace(/\0.*$/s, '').trim() || '0', 8);
    const full = prefix ? `${prefix}/${name}` : name;
    const body = tar.subarray(off + 512, off + 512 + size);
    if (path.posix.basename(full) === wantBase && size > 0) return body;
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return null;
};

(async () => {
  console.log(`[ffmpeg] ${pkg.name}@${pkg.version} 받는 중…`);
  const tgz = await get(url);
  const tar = zlib.gunzipSync(tgz);
  const bin = extractFromTar(tar, pkg.exe);
  if (!bin) throw new Error(`패키지 안에서 ${pkg.exe} 를 찾지 못했습니다.`);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outFile, bin);
  if (process.platform !== 'win32') fs.chmodSync(outFile, 0o755);
  console.log(`[ffmpeg] 준비됨 — ${path.relative(path.join(__dirname, '..'), outFile)} (${(bin.length / 1048576).toFixed(1)}MB)`);
})().catch((e) => {
  console.error(`[ffmpeg] 받지 못했습니다: ${e.message}`);
  process.exit(1);
});
