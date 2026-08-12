# OXYZN Studio

개인용 영상 제작 자동화 스튜디오 (Electron + React).
팀 배포용 FLIMFILM Studio 에서 갈라져 나온 개인 전용 앱입니다.

## 전신과 다른 점

- **로그인 없음.** 앱을 켜면 바로 작업 화면입니다. Supabase 인증·계정·팀·관리자 개념을 모두 걷어냈습니다.
- **서버 없음.** 크레딧 서버 집계(`usage_events`)와 API 키 서버 보관(`app_settings`)을 제거했습니다.
- **크레딧 집계는 유지.** 다만 서버가 아니라 이 PC 의 localStorage 에만 쌓입니다.
  `설정 → 크레딧 소모량` 에서 오늘/이번 주/이번 달/전체를 작업 영역별로 볼 수 있습니다.
- **메인 배경 애니메이션 제거.** 성능을 위해 흐르는 곡선(path 72개)과 글라스 블러를 걷어냈습니다.
- **번들 ID 가 `com.oxyzn.studio`** 라 전신과 데이터 폴더가 완전히 분리됩니다.

## 빌드 전 필요한 것

- **Node.js 18 이상** — https://nodejs.org (LTS 권장)
- 빌드 대상 OS 에서 실행 권장
  - Windows `.exe` → Windows 에서
  - macOS `.dmg` → macOS 에서

## API 키

`.env.example` 을 복사해 `.env.local` 을 만들고 키를 채웁니다.

```bash
cp .env.example .env.local
```

`.env.local` 은 `.gitignore` 로 커밋되지 않습니다. 앱 `설정 → API 관리` 에서 직접 입력한 값이
빌드에 내장된 값보다 우선합니다.

> 개인용 전환 시점에 기존 FLIMFILM 팀 키는 전부 비워두었습니다. 새 키를 넣어야 동작합니다.

## 빌드

```bash
npm install
npm run build:win
```

macOS 는 `npm run build:mac`, 양쪽 동시는 `npm run build:all` 입니다.
산출물은 `dist-electron/` 에 생깁니다.

## 개발

```bash
npm run electron:dev
```
