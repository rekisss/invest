import { useState } from 'react'

const styles = {
  overlay: {
    position: 'fixed', inset: 0,
    background: 'var(--bg)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    padding: '20px',
    zIndex: 100,
  },
  card: {
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-lg)',
    padding: '32px',
    maxWidth: '420px',
    width: '100%',
  },
  title: {
    fontSize: '18px',
    fontWeight: 600,
    marginBottom: '8px',
  },
  subtitle: {
    color: 'var(--muted)',
    fontSize: '13px',
    marginBottom: '24px',
    lineHeight: 1.7,
  },
  label: {
    display: 'block',
    fontSize: '12px',
    fontWeight: 500,
    color: 'var(--muted)',
    marginBottom: '8px',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
  },
  input: {
    width: '100%',
    background: 'var(--surface2)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius)',
    padding: '10px 14px',
    color: 'var(--text)',
    fontSize: '13px',
    fontFamily: 'var(--font-mono)',
    outline: 'none',
    transition: 'border-color 0.15s',
  },
  btn: {
    marginTop: '16px',
    width: '100%',
    background: 'var(--accent)',
    color: '#fff',
    border: 'none',
    borderRadius: 'var(--radius)',
    padding: '11px',
    fontSize: '14px',
    fontWeight: 600,
    transition: 'opacity 0.15s',
  },
  note: {
    marginTop: '16px',
    fontSize: '11px',
    color: 'var(--muted)',
    textAlign: 'center',
  },
  error: {
    marginTop: '8px',
    fontSize: '12px',
    color: 'var(--red)',
  },
}

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
    <div style={styles.overlay}>
      <div style={styles.card}>
        <div style={styles.title}>台股 AI 助手</div>
        <div style={styles.subtitle}>
          請輸入您的 Anthropic API Key。<br />
          金鑰僅存於本次分頁，關閉後自動清除，不會上傳至任何伺服器。
        </div>
        <label style={styles.label}>Anthropic API Key</label>
        <input
          style={styles.input}
          type="password"
          placeholder="sk-ant-api03-..."
          value={key}
          onChange={e => { setKey(e.target.value); setError('') }}
          onKeyDown={handleKeyDown}
          autoFocus
        />
        {error && <div style={styles.error}>{error}</div>}
        <button
          style={{ ...styles.btn, opacity: key.trim() ? 1 : 0.5 }}
          onClick={handleSave}
          disabled={!key.trim()}
        >
          開始使用
        </button>
        <div style={styles.note}>
          金鑰存於 sessionStorage · 不持久化 · 不 commit
        </div>
      </div>
    </div>
  )
}
