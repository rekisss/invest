import { Component } from 'react'

// Contains a render/effect throw to a local fallback instead of letting it
// unmount the whole app to a blank white screen. `resetKey` clears the error
// when it changes (e.g. switching tabs or opening a different stock), so a
// one-off crash in one view doesn't wedge the rest of the UI.
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidUpdate(prevProps) {
    if (prevProps.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null })
    }
  }

  render() {
    if (this.state.error) {
      if (this.props.fallback === null) return null
      return this.props.fallback || (
        <div style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          height: '100%', gap: 10, padding: 24, textAlign: 'center',
        }}>
          <div style={{ fontSize: 32 }}>⚠️</div>
          <div style={{ fontSize: 14, color: 'var(--ios-label)', fontWeight: 600 }}>這個畫面暫時無法顯示</div>
          <div style={{ fontSize: 12, color: 'var(--ios-label3)', maxWidth: 280 }}>
            切換分頁或重新整理即可繼續，其他功能不受影響。
          </div>
          <button
            onClick={() => this.setState({ error: null })}
            style={{
              marginTop: 6, fontSize: 13, color: '#fff', background: 'var(--ios-blue)',
              border: 'none', borderRadius: 10, padding: '7px 20px', cursor: 'pointer', fontWeight: 600,
            }}
          >重試</button>
        </div>
      )
    }
    return this.props.children
  }
}
