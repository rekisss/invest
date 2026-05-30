import { useState } from 'react'

const FM_TOKENS_KEY = 'fm_live_tokens'

function loadSavedTokens() {
  try { return JSON.parse(sessionStorage.getItem(FM_TOKENS_KEY) || '[]') } catch { return [] }
}

async function queryFinMindQuota(token) {
  const url = `https://api.finmindtrade.com/api/v4/user_info?token=${encodeURIComponent(token)}`
  const r = await fetch(url, { method: 'GET', headers: { 'Accept': 'application/json' } })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  const j = await r.json()
  if (j.status !== 200) throw new Error(j.msg || `status ${j.status}`)
  const d = j.data || {}
  // Handle both old (api_request_count) and new (user_count) field names
  const used = d.api_request_count ?? d.user_count ?? d.request_count ?? null
  const limit = d.api_request_limit ?? d.user_count_limit ?? d.request_limit ?? null
  if (used === null || limit === null) throw new Error(`欄位格式異常: ${JSON.stringify(Object.keys(d))}`)
  return { used: Number(used), limit: Number(limit), email: d.email || d.user_id || '' }
}

function QuotaBar({ used, limit, label, email }) {
  const pct = limit > 0 ? used / limit : 0
  const color = pct >= 0.9 ? '#ef4444' : pct >= 0.6 ? '#f59e0b' : '#4ade80'
  return (
    <div style={{ marginBottom: 8, padding: '8px 10px', background: 'var(--bg)', borderRadius: 6, border: '1px solid var(--border)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>
          {label}{email && <span style={{ fontWeight: 400, color: 'var(--muted)', marginLeft: 6, fontSize: 11 }}>{email}</span>}
        </span>
        <span style={{ fontSize: 12, fontFamily: 'monospace', color }}>
          {used.toLocaleString()} / {limit.toLocaleString()} ({Math.round(pct * 100)}%)
        </span>
      </div>
      <div style={{ height: 5, background: 'var(--border)', borderRadius: 3, overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${Math.min(pct * 100, 100)}%`, background: color, borderRadius: 3 }} />
      </div>
      <div style={{ marginTop: 3, fontSize: 10, color: 'var(--muted)' }}>
        剩餘可掃約 <b style={{ color: 'var(--text)' }}>{Math.floor((limit - used) / 2).toLocaleString()}</b> 支股票
      </div>
    </div>
  )
}

function LiveQuotaCheck() {
  const [show, setShow] = useState(false)
  const [newToken, setNewToken] = useState('')
  const [tokens, setTokens] = useState(loadSavedTokens)
  const [querying, setQuerying] = useState(false)

  function saveTokens(list) {
    sessionStorage.setItem(FM_TOKENS_KEY, JSON.stringify(list.map(x => ({ token: x.token, label: x.label }))))
  }

  function addToken() {
    const t = newToken.trim()
    if (!t || tokens.some(x => x.token === t)) return
    const idx = tokens.length + 1
    const updated = [...tokens, { token: t, label: `帳號${idx}`, result: null, loading: false, error: null }]
    setTokens(updated)
    saveTokens(updated)
    setNewToken('')
  }

  function removeToken(idx) {
    const updated = tokens.filter((_, i) => i !== idx)
    setTokens(updated)
    saveTokens(updated)
  }

  async function queryAll() {
    if (tokens.length === 0) return
    setQuerying(true)
    const results = await Promise.allSettled(tokens.map(t => queryFinMindQuota(t.token)))
    setTokens(prev => prev.map((t, i) => {
      const r = results[i]
      return r.status === 'fulfilled'
        ? { ...t, result: r.value, error: null, loading: false }
        : { ...t, result: null, error: r.reason?.message || '查詢失敗', loading: false }
    }))
    setQuerying(false)
  }

  async function querySingle(idx) {
    setTokens(prev => prev.map((t, i) => i === idx ? { ...t, loading: true, error: null } : t))
    try {
      const r = await queryFinMindQuota(tokens[idx].token)
      setTokens(prev => prev.map((t, i) => i === idx ? { ...t, result: r, loading: false } : t))
    } catch (e) {
      setTokens(prev => prev.map((t, i) => i === idx ? { ...t, error: e.message, loading: false } : t))
    }
  }

  return (
    <div style={{ marginBottom: 16, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}>
      <button
        onClick={() => setShow(p => !p)}
        style={{ width: '100%', background: 'none', border: 'none', cursor: 'pointer', padding: '10px 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
      >
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>
          🔑 即時查詢 FinMind 配額
          {tokens.length > 0 && <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--muted)', fontWeight: 400 }}>({tokens.length} 個 Token)</span>}
        </span>
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>{show ? '▲' : '▼'}</span>
      </button>

      {show && (
        <div style={{ padding: '0 14px 14px' }}>
          <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 10 }}>
            貼入 FinMind Token，可加入多個帳號同時查詢。Token 僅存在本分頁，不上傳。
          </div>

          <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
            <input
              type="password"
              value={newToken}
              onChange={e => setNewToken(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && addToken()}
              placeholder="貼上 FinMind Token 後按 Enter 或 + 加入…"
              style={{ flex: 1, padding: '7px 10px', fontSize: 12, borderRadius: 6, background: 'var(--bg)', border: '1px solid var(--border)', color: 'var(--text)', outline: 'none' }}
            />
            <button onClick={addToken} disabled={!newToken.trim()} style={{
              padding: '7px 14px', fontSize: 12, fontWeight: 700, borderRadius: 6, border: 'none',
              background: newToken.trim() ? 'var(--accent)' : 'var(--surface2)',
              color: newToken.trim() ? '#fff' : 'var(--muted)', cursor: newToken.trim() ? 'pointer' : 'default',
            }}>+ 加入</button>
            {tokens.length > 0 && (
              <button onClick={queryAll} disabled={querying} style={{
                padding: '7px 14px', fontSize: 12, fontWeight: 700, borderRadius: 6, border: 'none',
                background: querying ? 'var(--surface2)' : '#3fb950',
                color: querying ? 'var(--muted)' : '#fff', cursor: querying ? 'default' : 'pointer', whiteSpace: 'nowrap',
              }}>{querying ? '查詢中…' : '全部查詢'}</button>
            )}
          </div>

          {tokens.map((t, idx) => (
            <div key={idx} style={{ marginBottom: 8 }}>
              {t.result ? (
                <QuotaBar used={t.result.used} limit={t.result.limit} label={t.label} email={t.result.email} />
              ) : (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', background: 'var(--bg)', borderRadius: 6, border: '1px solid var(--border)' }}>
                  <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)', flex: 1 }}>{t.label}</span>
                  {t.error && <span style={{ fontSize: 11, color: 'var(--red)' }}>❌ {t.error}</span>}
                  {!t.error && !t.loading && <span style={{ fontSize: 11, color: 'var(--muted)' }}>未查詢</span>}
                  <button onClick={() => querySingle(idx)} disabled={t.loading} style={{
                    fontSize: 11, padding: '2px 9px', borderRadius: 4, border: 'none',
                    background: 'var(--surface2)', color: 'var(--text)', cursor: 'pointer',
                  }}>{t.loading ? '查詢中…' : '查詢'}</button>
                  <button onClick={() => removeToken(idx)} style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 13, padding: '0 2px' }}>✕</button>
                </div>
              )}
            </div>
          ))}

          {tokens.length === 0 && (
            <div style={{ fontSize: 12, color: 'var(--muted)', textAlign: 'center', padding: '12px 0' }}>
              尚未加入任何 Token。FinMind Token 可在 <b>finmindtrade.com</b> 登入後取得。
            </div>
          )}
        </div>
      )}
    </div>
  )
}

const ACCOUNT_META = {
  '帳號1': { limit_hr: 600 }, '帳號2': { limit_hr: 600 }, '帳號3': { limit_hr: 600 },
  '帳號4': { limit_hr: 600 }, '帳號5': { limit_hr: 600 },
  '帳號6': { limit_hr: 300 }, '帳號7': { limit_hr: 300 }, '帳號8': { limit_hr: 300 },
  '帳號9': { limit_hr: 300 },
}

function statusColor(pct) {
  if (pct >= 0.9) return '#ef4444'
  if (pct >= 0.6) return '#f59e0b'
  return '#4ade80'
}

function statusLabel(pct) {
  if (pct >= 0.9) return '危險'
  if (pct >= 0.6) return '警告'
  return '正常'
}

export default function QuotaPanel({ quota }) {
  const allAccounts = Array.from({ length: 9 }, (_, i) => {
    const label = `帳號${i + 1}`
    const labelFull = i < 5 ? `${label}（600/hr）` : `${label}（300/hr）`
    const hrLimit = i < 5 ? 600 : 300
    const found = (quota || []).find(q => q.label.includes(label))
    return {
      label, labelFull, hrLimit,
      used: found?.used ?? null,
      limit: found?.limit ?? null,
    }
  })

  const totalUsed = allAccounts.filter(a => a.used != null).reduce((s, a) => s + a.used, 0)
  const totalLimit = allAccounts.filter(a => a.limit != null).reduce((s, a) => s + a.limit, 0)
  const responding = allAccounts.filter(a => a.used != null).length

  return (
    <div style={{ height: '100%', overflowY: 'auto', padding: '16px' }}>
      <div style={{ maxWidth: 640, margin: '0 auto' }}>

        {/* Live token check */}
        <LiveQuotaCheck />

        {/* Summary cards */}
        <div style={{ display: 'flex', gap: 10, marginBottom: 20, flexWrap: 'wrap' }}>
          {[
            { label: '回應帳號', value: `${responding} / 9 個` },
            { label: '今日已用（各帳號合計）', value: totalLimit > 0 ? `${totalUsed.toLocaleString()} 次` : '—' },
            { label: '剩餘可用', value: totalLimit > 0 ? `${(totalLimit - totalUsed).toLocaleString()} 次` : '—' },
          ].map(c => (
            <div key={c.label} style={{
              flex: 1, minWidth: 140, background: 'var(--surface)', border: '1px solid var(--border)',
              borderRadius: 8, padding: '10px 14px',
            }}>
              <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 4 }}>{c.label}</div>
              <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--text)', fontFamily: 'var(--font-mono)' }}>{c.value}</div>
            </div>
          ))}
        </div>

        {/* Per-account rows */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {allAccounts.map(acc => {
            const pct = (acc.used != null && acc.limit != null && acc.limit > 0) ? acc.used / acc.limit : null
            const color = pct != null ? statusColor(pct) : 'var(--muted)'
            const isOffline = acc.used == null

            return (
              <div key={acc.label} style={{
                background: 'var(--surface)', border: '1px solid var(--border)',
                borderRadius: 10, padding: '12px 16px',
                opacity: isOffline ? 0.5 : 1,
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontWeight: 700, fontSize: 14, color: 'var(--text)' }}>{acc.label}</span>
                    <span style={{ fontSize: 11, color: 'var(--muted)', background: 'var(--surface2)', borderRadius: 4, padding: '1px 6px' }}>
                      {acc.hrLimit}/hr
                    </span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    {!isOffline && (
                      <span style={{ fontSize: 12, fontFamily: 'var(--font-mono)', color: 'var(--muted)' }}>
                        {acc.used?.toLocaleString()} / {acc.limit?.toLocaleString()}
                      </span>
                    )}
                    <span style={{
                      fontSize: 11, fontWeight: 700, color: '#fff',
                      background: isOffline ? '#475569' : color,
                      borderRadius: 4, padding: '2px 7px',
                    }}>
                      {isOffline ? '未回應' : `${Math.round(pct * 100)}%  ${statusLabel(pct)}`}
                    </span>
                  </div>
                </div>

                <div style={{ height: 8, background: 'var(--border)', borderRadius: 4, overflow: 'hidden' }}>
                  {!isOffline && (
                    <div style={{
                      height: '100%',
                      width: `${Math.min(pct * 100, 100)}%`,
                      background: color,
                      borderRadius: 4,
                      transition: 'width 0.5s',
                    }} />
                  )}
                </div>

                {!isOffline && pct != null && (
                  <div style={{ marginTop: 6, fontSize: 11, color: 'var(--muted)' }}>
                    剩餘可掃約 <b style={{ color: 'var(--text)' }}>
                      {Math.floor((acc.limit - acc.used) / 2).toLocaleString()}
                    </b> 支股票
                    （每支 2 次 API）
                  </div>
                )}
              </div>
            )
          })}
        </div>

        <div style={{ marginTop: 20, fontSize: 11, color: 'var(--muted)', lineHeight: 1.7 }}>
          • 每小時上限：帳號1~5 各 600 次，帳號6~9 各 300 次<br />
          • 每支股票掃描需 2 次 API 呼叫<br />
          • 「未回應」表示該帳號金鑰未設定或 FinMind API 暫時無法連線
        </div>
      </div>
    </div>
  )
}
