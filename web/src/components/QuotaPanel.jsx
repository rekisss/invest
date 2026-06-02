function statusColor(pct) {
  if (pct >= 0.9) return 'var(--ios-red)'
  if (pct >= 0.6) return 'var(--ios-yellow)'
  return 'var(--ios-green)'
}
function statusLabel(pct) {
  if (pct >= 0.9) return '危險'
  if (pct >= 0.6) return '警告'
  return '正常'
}

export default function QuotaPanel({ quota, generatedAt }) {
  const accountDefs = [
    ...Array.from({ length: 5 }, (_, i) => ({ label: `帳號${i + 1}`, hrLimit: 600, tag: '掃描' })),
    ...Array.from({ length: 4 }, (_, i) => ({ label: `帳號${i + 6}`, hrLimit: 300, tag: '掃描' })),
    { label: '帳號10', hrLimit: null, tag: 'K線' },
  ]

  const allAccounts = accountDefs.map(({ label, hrLimit, tag }) => {
    const found = (quota || []).find(q => q.label.includes(label))
    const resolvedLimit = found?.limit ?? hrLimit
    return { label, tag, hrLimit: resolvedLimit, used: found?.used ?? null, limit: found?.limit ?? null }
  })

  const totalUsed  = allAccounts.filter(a => a.used != null).reduce((s, a) => s + a.used, 0)
  const totalLimit = allAccounts.filter(a => a.limit != null).reduce((s, a) => s + a.limit, 0)
  const responding = allAccounts.filter(a => a.used != null).length

  return (
    <div style={{ height: '100%', overflowY: 'auto', WebkitOverflowScrolling: 'touch' }}>
      <div style={{ padding: '0 16px', maxWidth: 680, margin: '0 auto' }}>

        {/* Summary cards */}
        <div style={{ display: 'flex', gap: 10, marginBottom: 20, flexWrap: 'wrap' }}>
          {[
            { label: '回應帳號', value: `${responding} / 10` },
            { label: '今日已用', value: totalLimit > 0 ? totalUsed.toLocaleString() : '—' },
            { label: '剩餘可用', value: totalLimit > 0 ? (totalLimit - totalUsed).toLocaleString() : '—' },
          ].map(c => (
            <div key={c.label} className="ios-stat" style={{ flex: 1, minWidth: 100 }}>
              <div className="ios-stat-label">{c.label}</div>
              <div className="ios-stat-value" style={{ fontSize: 22 }}>{c.value}</div>
            </div>
          ))}
        </div>

        {/* Per-account list */}
        <div style={{ background: 'var(--ios-bg2)', borderRadius: 16, overflow: 'hidden', boxShadow: 'var(--shadow-card)', marginBottom: 16 }}>
          {allAccounts.map((acc, idx) => {
            const pct = (acc.used != null && acc.limit != null && acc.limit > 0) ? acc.used / acc.limit : null
            const color = pct != null ? statusColor(pct) : 'var(--ios-label3)'
            const isOffline = acc.used == null

            return (
              <div key={acc.label} style={{
                borderBottom: idx < allAccounts.length - 1 ? '0.5px solid var(--ios-sep)' : 'none',
                padding: '12px 16px',
                opacity: isOffline ? 0.45 : 1,
              }}>
                {/* Title row */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: isOffline ? 0 : 8 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontWeight: 600, fontSize: 15, color: 'var(--ios-label)' }}>{acc.label}</span>
                    {acc.hrLimit != null && (
                      <span style={{ fontSize: 11, color: 'var(--ios-label3)', background: 'var(--ios-bg3)', borderRadius: 6, padding: '1px 7px' }}>
                        {acc.hrLimit}/hr
                      </span>
                    )}
                    <span style={{
                      fontSize: 11, color: acc.tag === 'K線' ? 'var(--ios-blue)' : 'var(--ios-label3)',
                      background: 'var(--ios-bg3)', borderRadius: 6, padding: '1px 7px', fontWeight: 500,
                    }}>{acc.tag}</span>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    {!isOffline && (
                      <span style={{ fontSize: 12, fontFamily: 'var(--font-mono)', color: 'var(--ios-label2)' }}>
                        {acc.used?.toLocaleString()} / {acc.limit?.toLocaleString()}
                      </span>
                    )}
                    <span style={{
                      fontSize: 11, fontWeight: 700,
                      color: '#fff',
                      background: isOffline ? 'rgba(120,120,128,0.3)' : color,
                      borderRadius: 8, padding: '3px 9px',
                    }}>
                      {isOffline ? '未回應' : `${Math.round(pct * 100)}% ${statusLabel(pct)}`}
                    </span>
                  </div>
                </div>

                {/* Progress bar */}
                {!isOffline && (
                  <>
                    <div className="ios-progress-track">
                      <div className="ios-progress-fill" style={{ width: `${Math.min(pct * 100, 100)}%`, background: color }} />
                    </div>
                    <div style={{ marginTop: 5, fontSize: 12, color: 'var(--ios-label2)' }}>
                      剩餘可掃約 <b style={{ color: 'var(--ios-label)' }}>{Math.floor((acc.limit - acc.used) / 2).toLocaleString()}</b> 支
                    </div>
                  </>
                )}
              </div>
            )
          })}
        </div>

        {/* Freshness note */}
        {generatedAt && (() => {
          const tw = new Intl.DateTimeFormat('zh-TW', {
            timeZone: 'Asia/Taipei', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', hour12: false,
          }).format(new Date(generatedAt))
          return (
            <div style={{
              background: 'var(--ios-bg2)', borderRadius: 12,
              padding: '12px 16px', fontSize: 13, color: 'var(--ios-label2)',
              boxShadow: 'var(--shadow-card)', marginBottom: 12, display: 'flex', gap: 8,
            }}>
              <span>🕐</span>
              <span>快照時間：<b style={{ color: 'var(--ios-label)' }}>{tw} 台灣時間</b>
                — 按右上角刷新可取得最新；工作流執行後才更新。
              </span>
            </div>
          )
        })()}

        {/* Info notes */}
        <div style={{ background: 'var(--ios-bg2)', borderRadius: 12, padding: '12px 16px', boxShadow: 'var(--shadow-card)', marginBottom: 24 }}>
          {[
            '帳號 1~5 每小時限 600 次，帳號 6~9 各 300 次',
            '帳號 10 專用於 K 線預取，不參與股票掃描',
            '每支股票掃描約需 2 次 API 呼叫',
            '「未回應」表示金鑰未設定或 FinMind 暫時無法連線',
          ].map((note, i, arr) => (
            <div key={i} style={{
              fontSize: 13, color: 'var(--ios-label2)', padding: '6px 0',
              borderBottom: i < arr.length - 1 ? '0.5px solid var(--ios-sep)' : 'none',
            }}>· {note}</div>
          ))}
        </div>
      </div>
    </div>
  )
}
