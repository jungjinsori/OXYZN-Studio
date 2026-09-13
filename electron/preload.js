const { contextBridge, ipcRenderer } = require('electron');

// v850: window.electron 브리지를 제거했다.
//   getApiPort 는 'get-api-port' 를 invoke 하는데 그 핸들러가 main.js 에 없다 —
//   누가 부르면 "No handler registered" 로 던진다. 실제로 부르는 곳은 없었지만,
//   노출된 API 가 호출하면 죽는 상태로 남아 있는 것 자체가 함정이다.
//   isElectron 도 쓰이지 않았다. 렌더러는 window.electronAPI 존재로 판별한다
//   (App.jsx 의 isElectronEnv).

// v333: window.electronAPI — 렌더러가 실제로 쓰는 브리지
contextBridge.exposeInMainWorld('electronAPI', {
  // yt-dlp YouTube 스트림 URL 추출
  ytdlpExtract: (url) => ipcRenderer.invoke('ytdlp-extract', url),
  // v809: YouTube 영상 길이만 조회 (바이너리 불필요) — 영상 분석 해상도 결정용
  youtubeDuration: (url) => ipcRenderer.invoke('youtube-duration', url),
  // v832: BytePlus OpenAPI 서명 호출 (배우 인증 — Assets API). 서명은 메인에서 만든다
  arkOpenapi: (payload) => ipcRenderer.invoke('ark-openapi', payload),
  // HTML → PDF 직접 저장 (Electron printToPDF, 텍스트 검색 가능)
  exportPdf: (payload) => ipcRenderer.invoke('export-pdf', payload),
  // 아카이브 폴더 목록 / 파일 열기 / 다운로드 카테고리 설정
  // v914: 작업 내역 자동 보관 (userData/session.json)
  sessionSave: (data) => ipcRenderer.invoke('session-save', data),
  sessionLoad: () => ipcRenderer.invoke('session-load'),
  sessionClear: () => ipcRenderer.invoke('session-clear'),
  // v879: 프로젝트 저장 (userData/projects)
  projectList: () => ipcRenderer.invoke('project-list'),
  projectSave: (id, data) => ipcRenderer.invoke('project-save', id, data),
  projectLoad: (id) => ipcRenderer.invoke('project-load', id),
  projectRename: (id, name) => ipcRenderer.invoke('project-rename', id, name),
  projectDelete: (id) => ipcRenderer.invoke('project-delete', id),
  // v934: 생성한 클립을 userData 에 받아 둔다 (결과 URL 은 24시간이면 죽는다)
  clipSave: (payload) => ipcRenderer.invoke('clip-save', payload),
  clipCheck: (paths) => ipcRenderer.invoke('clip-check', paths),
  clipUsage: (projectId) => ipcRenderer.invoke('clip-usage', projectId),
  // v974: 라이브러리 자산(캐릭터 시트 원본) — localStorage 대신 userData 파일
  assetSave: (payload) => ipcRenderer.invoke('asset-save', payload),
  assetRead: (payload) => ipcRenderer.invoke('asset-read', payload),
  assetDelete: (payload) => ipcRenderer.invoke('asset-delete', payload),
  assetUsage: (kind) => ipcRenderer.invoke('asset-usage', kind),
  // v976: 생성 결과를 앱 데이터 폴더에 받아 둔다 (히스토리를 되살리기 위해)
  genSave: (payload) => ipcRenderer.invoke('gen-save', payload),
  genCheck: (paths) => ipcRenderer.invoke('gen-check', paths),
  genUsage: () => ipcRenderer.invoke('gen-usage'),
  localRead: (payload) => ipcRenderer.invoke('local-read', payload),
  archiveList: () => ipcRenderer.invoke('archive-list'),
  archiveOpen: (filePath) => ipcRenderer.invoke('archive-open', filePath),
  archiveDownload: (filePath) => ipcRenderer.invoke('archive-download', filePath),
  archiveDelete: (filePath) => ipcRenderer.invoke('archive-delete', filePath),
  archiveTrash: (paths) => ipcRenderer.invoke('archive-trash', paths),
  archiveRestore: (paths) => ipcRenderer.invoke('archive-restore', paths),
  archivePurge: (paths) => ipcRenderer.invoke('archive-purge', paths),
  archiveTrashList: () => ipcRenderer.invoke('archive-trash-list'),
  setDownloadCategory: (cat) => ipcRenderer.invoke('set-download-category', cat),
  // 다운로드 폴더 실시간 미러 (우측 패널)
  downloadsList: () => ipcRenderer.invoke('downloads-list'),
  // 파일명 버전 계산 (OXYZN_ 앞머리) (다운로드+아카이브에서 다음 버전 번호 부여)
  ffsName: (base) => ipcRenderer.invoke('ffs-name', base),
  downloadsReveal: () => ipcRenderer.invoke('downloads-reveal'),
  // v855: 다운로드 항목 이름 바꾸기 (실제 파일도 rename)
  downloadsRename: (payload) => ipcRenderer.invoke('downloads-rename', payload),
  openPath: (filePath) => ipcRenderer.invoke('open-path', filePath),
  // OS 네이티브 파일 드래그 시작 (그리드 → 드롭존)
  startFileDrag: (filePath) => ipcRenderer.send('ff-file-drag', filePath),
  // 다운로드 폴더 변경 구독 (해제 함수 반환)
  onDownloadsChanged: (cb) => {
    const h = () => { try { cb(); } catch {} };
    ipcRenderer.on('downloads-changed', h);
    return () => ipcRenderer.removeListener('downloads-changed', h);
  },
});
