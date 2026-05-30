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
                {/* Top row */}
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

                {/* Progress bar */}
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

                {/* Estimate remaining stocks */}
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
          • 「未回應」表示該帳號金鑰未設定或 FinMind API 暫時無法連線<br />
          • 資料每次部署自動更新
        </div>
      </div>
    </div>
  )
}
