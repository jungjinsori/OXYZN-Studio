import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'

// v1056: 앱에 표시할 버전을 package.json 에서 가져와 빌드 시점에 심는다.
//   전에는 App.jsx 에 'v1048' 이 손으로 박혀 있었다(전신 FLIMFILM 의 빌드 번호).
//   빌드할 때마다 bump-version.cjs 가 package.json 만 올려서 둘이 계속 어긋났다.
//   여기서 주입하면 손댈 일이 없다 — bump 가 먼저 돌고 그 값이 그대로 들어간다.
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))

export default defineConfig({
  plugins: [react()],
  base: './',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets'
  },
  server: {
    port: 5173
  }
})
