import { useState } from 'react'
import Dashboard from './components/Dashboard.jsx'
import ApiKeyInput from './components/ApiKeyInput.jsx'
import AgentPanel from './components/AgentPanel.jsx'

const TAB_STYLE_BASE = {
  padding: '8px 18px',
  fontSize: 13,
  fontWeight: 600,
  border: 'none',
  borderBottom: '2px solid transparent',
  background: 'transparent',
  color: 'var(--muted)',
  cursor: 'pointer',
  transition: 'color 0.15s',
  whiteSpace: 'nowrap',
}

const TAB_STYLE_ACTIVE = {
  ...TAB_STYLE_BASE,
  color: 'var(--accent)',
  borderBottom: '2px solid var(--accent)',
}

export default function App() {
  const [tab, setTab] = useState('dashboard')
  const [apiKey, setApiKey] = useState(() => sessionStorage.getItem('anthropic_key') || '')

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Tab bar */}
      <div style={{
        display: 'flex',
        borderBottom: '1px solid var(--border)',
        background: 'var(--surface)',
        flexShrink: 0,
        overflowX: 'auto',
      }}>
        <button style={tab === 'dashboard' ? TAB_STYLE_ACTIVE : TAB_STYLE_BASE} onClick={() => setTab('dashboard')}>
          📊 掃描結果
        </button>
        <button style={tab === 'ai' ? TAB_STYLE_ACTIVE : TAB_STYLE_BASE} onClick={() => setTab('ai')}>
          🤖 AI 助手
        </button>
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        {tab === 'dashboard' && <Dashboard />}
        {tab === 'ai' && (
          apiKey
            ? <AgentPanel apiKey={apiKey} onClearKey={() => { sessionStorage.removeItem('anthropic_key'); setApiKey('') }} />
            : <ApiKeyInput onSave={key => { sessionStorage.setItem('anthropic_key', key); setApiKey(key) }} />
        )}
      </div>
    </div>
  )
}
