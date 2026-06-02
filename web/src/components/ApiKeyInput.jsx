import { useState } from 'react'

export default function ApiKeyInput({ onSave }) {
  const [key, setKey] = useState('')
  const [error, setError] = useState('')

  function handleSave() {
    const trimmed = key.trim()
    if (!trimmed.startsWith('sk-ant-')) {
      setError('金鑰格式不正確，應以 sk-ant- 開頭')
      return
    }
    sessionStorage.setItem('anthropic_key', trimmed)
    onSave(trimmed)
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter') handleSave()
  }

  return (
    <div style={{
      position: 'fixed', inset: 0,
      background: 'var(--ios-bg)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: '20px',
      zIndex: 100,
    }}>
      <div style={{
        background: 'var(--ios-bg2)',
        borderRadius: 20,
        padding: '32px 24px',
        maxWidth: '400px',
        width: '100%',
        boxShadow: 'var(--shadow-modal)',
      }}>
        <div style={{
          fontSize: 22, fontWeight: 700, marginBottom: 8,
          color: 'var(--ios-label)', letterSpacing: '-0.3px',
        }}>
          台股 AI 助手
        </div>
        <div style={{
          color: 'var(--ios-label2)', fontSize: 14,
          marginBottom: 28, lineHeight: 1.7,
        }}>
          請輸入您的 Anthropic API Key。<br />
          金鑰僅存於本次分頁，關閉後自動清除，不會上傳至任何伺服器。
        </div>

        <div style={{
          fontSize: 12, fontWeight: 600, color: 'var(--ios-label3)',
          marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.8,
        }}>
          Anthropic API Key
        </div>
        <input
          style={{
            width: '100%', boxSizing: 'border-box',
            background: 'var(--ios-bg3)',
            border: '0.5px solid var(--ios-sep)',
            borderRadius: 12,
            padding: '12px 14px',
            color: 'var(--ios-label)',
            fontSize: 13,
            fontFamily: 'var(--font-mono)',
            outline: 'none',
          }}
          type="password"
          placeholder="sk-ant-api03-..."
          value={key}
          onChange={e => { setKey(e.target.value); setError('') }}
          onKeyDown={handleKeyDown}
          autoFocus
        />
        {error && (
          <div style={{ marginTop: 8, fontSize: 13, color: 'var(--ios-red)' }}>{error}</div>
        )}
        <button
          className="ios-btn-primary"
          style={{
            marginTop: 20, width: '100%',
            opacity: key.trim() ? 1 : 0.4,
            cursor: key.trim() ? 'pointer' : 'default',
          }}
          onClick={handleSave}
          disabled={!key.trim()}
        >
          開始使用
        </button>
        <div style={{
          marginTop: 14, fontSize: 11, color: 'var(--ios-label3)', textAlign: 'center',
        }}>
          金鑰存於 sessionStorage · 不持久化 · 不 commit
        </div>
      </div>
    </div>
  )
}
