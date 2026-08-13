import { StrictMode, Component } from 'react'
import { createRoot } from 'react-dom/client'
// Pretendard 가변 폰트 — 번들에 포함한다(CDN 아님).
//   전에는 CSS 에서 'Pretendard' 를 첫 순위로 부르면서 정작 폰트를 싣지 않았다.
//   맥에서는 -apple-system 이 받아줘서 티가 안 났지만, Windows 에서는 Segoe UI 로
//   갔다가 한글 글리프가 없어 맑은 고딕으로 재폴백해 자간·굵기가 어색했다.
//   woff2 한 장(2MB)에 45~920 굵기가 다 들어 있어 굵기별 파일이 필요 없다.
import 'pretendard/dist/web/variable/pretendardvariable.css'
import App from './App.jsx'

// v712: 앱 전역 에러 바운더리 — 렌더 중 예외로 화면이 하얗게 죽는 대신
// 에러 내용 + 새로고침 버튼을 보여준다. (원인 진단 + 복구 용이)
class RootErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null, info: null }
  }
  static getDerivedStateFromError(error) {
    return { error }
  }
  componentDidCatch(error, info) {
    // 콘솔에도 남겨 개발자도구에서 스택 확인 가능
    console.error('[RootErrorBoundary] 렌더 중 예외:', error, info)
    this.setState({ info })
  }
  render() {
    if (this.state.error) {
      const err = this.state.error
      const msg = (err && (err.message || String(err))) || '알 수 없는 오류'
      const stack = (err && err.stack) || (this.state.info && this.state.info.componentStack) || ''
      return (
        <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, fontFamily: 'system-ui, -apple-system, sans-serif', background: '#0b0b0c', color: '#e5e7eb' }}>
          <div style={{ maxWidth: 720, width: '100%', background: '#161618', border: '1px solid #2a2a2e', borderRadius: 12, padding: '24px 28px' }}>
            <div style={{ fontSize: 18, fontWeight: 800, marginBottom: 8, color: '#f87171' }}>화면 표시 중 오류가 발생했습니다</div>
            <div style={{ fontSize: 13, lineHeight: 1.6, color: '#cbd5e1', marginBottom: 16 }}>
              작업 상태는 저장되지 않는 항목이 많아, 새로고침하면 대개 복구됩니다. 아래 오류 내용을 공유해 주시면 원인을 수정하겠습니다.
            </div>
            <div style={{ fontSize: 12, fontWeight: 700, color: '#fca5a5', marginBottom: 6 }}>{msg}</div>
            <pre style={{ maxHeight: 260, overflow: 'auto', fontSize: 11, lineHeight: 1.5, background: '#0b0b0c', border: '1px solid #2a2a2e', borderRadius: 8, padding: '12px 14px', color: '#9ca3af', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{stack}</pre>
            <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
              <button onClick={() => window.location.reload()} style={{ padding: '9px 18px', fontSize: 13, fontWeight: 700, borderRadius: 8, border: 'none', cursor: 'pointer', background: '#22c55e', color: '#052e16' }}>새로고침</button>
              <button onClick={() => { try { navigator.clipboard.writeText(msg + '\n\n' + stack) } catch {} }} style={{ padding: '9px 18px', fontSize: 13, fontWeight: 600, borderRadius: 8, border: '1px solid #2a2a2e', cursor: 'pointer', background: 'transparent', color: '#e5e7eb' }}>오류 복사</button>
            </div>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <RootErrorBoundary>
      <App />
    </RootErrorBoundary>
  </StrictMode>,
)
