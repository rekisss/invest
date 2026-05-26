import { useState } from 'react'
import ApiKeyInput from './components/ApiKeyInput.jsx'
import AgentPanel from './components/AgentPanel.jsx'

export default function App() {
  const [apiKey, setApiKey] = useState(() => sessionStorage.getItem('anthropic_key') || '')

  function handleSave(key) {
    setApiKey(key)
  }

  function handleClearKey() {
    sessionStorage.removeItem('anthropic_key')
    setApiKey('')
  }

  if (!apiKey) {
    return <ApiKeyInput onSave={handleSave} />
  }

  return (
    <div style={{ height: '100%' }}>
      <AgentPanel apiKey={apiKey} onClearKey={handleClearKey} />
    </div>
  )
}
