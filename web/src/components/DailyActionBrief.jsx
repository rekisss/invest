function fmtScore(v) {
  return v == null || Number.isNaN(Number(v)) ? '—' : Math.round(Number(v))
}

function fmtPct(v) {
  return v == null || Number.isNaN(Number(v)) ? '—' : `${Number(v).toFixed(1)}%`
}

function stockTitle(s) {
  return `${s.stock_id}${s.name ? ` ${s.name}` : ''}`
}

function compactTop(list, limit = 3) {
  return (list || []).slice(0, limit)
}

function BriefPill({ children, color = 'var(--ios-blue)' }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      fontSize: 10, fontWeight: 700, color,
      background: 'var(--ios-fill4)', border: `0.5px solid ${color}`,
      borderRadius: 9999, padding: '2px 7px', whiteSpace: 'nowrap',
    }}>
      {children}
    </span>
  )
}

function BriefStockButton({ stock, meta, color, onSelect }) {
  return (
    <button
      type="button"
      onClick={() => onSelect?.(stock)}
      style={{
        width: '100%', display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: 8,
        alignItems: 'center', padding: '8px 10px', borderRadius: 12,
        border: '0.5px solid var(--ios-sep)', background: 'var(--ios-fill4)',
        color: 'var(--ios-label)', textAlign: 'left', cursor: onSelect ? 'pointer' : 'default',
      }}
    >
      <span style={{ minWidth: 0 }}>
        <span style={{ display: 'block', fontSize: 12, fontWeight: 800, color, fontFamily: 'var(--font-mono)' }}>{stock.stock_id}</span>
        <span style={{ display: 'block', fontSize: 11, color: 'var(--ios-label2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{stock.name || '—'}</span>
      </span>
      <span style={{ fontSize: 11, color: 'var(--ios-label3)', fontWeight: 700, whiteSpace: 'nowrap' }}>{meta}</span>
    </button>
  )
}

function BriefSection({ title, hint, color, items, emptyText, onSelect }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 7 }}>
        <div style={{ fontSize: 11, fontWeight: 800, color, letterSpacing: 0.3 }}>{title}</div>
        {hint && <div style={{ fontSize: 10, color: 'var(--ios-label3)' }}>{hint}</div>}
      </div>
      {items.length ? (
        <div style={{ display: 'grid', gap: 6 }}>
          {items.map(item => (
            <BriefStockButton key={`${title}-${item.stock.stock_id}`} stock={item.stock} meta={item.meta} color={color} onSelect={onSelect} />
          ))}
        </div>
      ) : (
        <div style={{
          fontSize: 12, color: 'var(--ios-label3)', lineHeight: 1.5,
          background: 'var(--ios-fill4)', border: '0.5px dashed var(--ios-sep)',
          borderRadius: 12, padding: '10px 12px',
        }}>
          {emptyText}
        </div>
      )}
    </div>
  )
}

export default function DailyActionBrief({ scan, prevScan, allScanStocks = [], persistent = [], dataQuality, onSelect }) {
  const topStocks = scan?.top_stocks || []
  if (!scan || (!topStocks.length && !allScanStocks.length)) return null

  const prevEntryIds = new Set((prevScan?.top_stocks || []).filter(s => s.entry_signal).map(s => String(s.stock_id)))
  const todayEntry = allScanStocks.filter(s => s.entry_signal)
  const newEntry = todayEntry.filter(s => !prevEntryIds.has(String(s.stock_id)))
    .sort((a, b) => (b.entry_score || 0) - (a.entry_score || 0))

  const prevScores = new Map((prevScan?.top_stocks || []).map(s => [String(s.stock_id), s.entry_score || 0]))
  const scoreMovers = topStocks
    .map(s => ({ stock: s, delta: prevScores.has(String(s.stock_id)) ? (s.entry_score || 0) - prevScores.get(String(s.stock_id)) : null }))
    .filter(x => x.delta != null && Math.abs(x.delta) >= 50)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))

  const nearBreakout = allScanStocks
    .filter(s => !s.entry_signal && s.gap_to_20d_high_pct != null && s.gap_to_20d_high_pct >= 0 && s.gap_to_20d_high_pct <= 2)
    .sort((a, b) => (a.gap_to_20d_high_pct || 0) - (b.gap_to_20d_high_pct || 0))

  const caution = allScanStocks
    .filter(s => s.entry_signal && (s.long_upper_shadow || s.open_high_close_low || s.close_below_ema20 || s.macd_death_cross))
    .sort((a, b) => (b.entry_score || 0) - (a.entry_score || 0))

  const persistentMap = new Map((persistent || []).map(p => [String(p.stock_id), p]))
  const steadyLeaders = topStocks
    .filter(s => persistentMap.has(String(s.stock_id)))
    .map(s => ({ stock: s, days: persistentMap.get(String(s.stock_id))?.days_in_top || 0 }))
    .sort((a, b) => b.days - a.days || (b.stock.entry_score || 0) - (a.stock.entry_score || 0))

  const entryCount = scan.entry_count || todayEntry.length
  const totalScanned = scan.total_scanned || allScanStocks.length || topStocks.length
  const institutionalWeak = dataQuality?.institutional_ok === false
  const stale = dataQuality?.is_fresh === false

  const sections = [
    {
      title: '新進訊號', color: 'var(--ios-green)', hint: `${newEntry.length} 支`,
      emptyText: '今天沒有新的進場訊號，先觀察既有強勢股。',
      items: compactTop(newEntry).map(stock => ({ stock, meta: `分 ${fmtScore(stock.entry_score)}` })),
    },
    {
      title: '分數異動', color: 'var(--ios-blue)', hint: '±50+',
      emptyText: '主要候選分數變化不大，盤面暫時穩定。',
      items: compactTop(scoreMovers).map(({ stock, delta }) => ({ stock, meta: `${delta > 0 ? '+' : ''}${Math.round(delta)}` })),
    },
    {
      title: '近突破', color: 'var(--ios-orange)', hint: '距20高≤2%',
      emptyText: '目前沒有接近 20 日高點且尚未入場的候選。',
      items: compactTop(nearBreakout).map(stock => ({ stock, meta: fmtPct(stock.gap_to_20d_high_pct) })),
    },
    {
      title: '風險提醒', color: 'var(--ios-red)', hint: `${caution.length} 支`,
      emptyText: '進場訊號中未見明顯長上影 / 跌破 EMA20 / 死叉警示。',
      items: compactTop(caution).map(stock => ({
        stock,
        meta: stock.macd_death_cross ? '死叉' : stock.close_below_ema20 ? '破EMA20' : stock.long_upper_shadow ? '長上影' : '收低',
      })),
    },
  ]

  return (
    <section style={{
      margin: '12px 16px 0', padding: 14, borderRadius: 18,
      background: 'linear-gradient(135deg, rgba(10,132,255,0.12) 0%, var(--ios-bg2) 58%)',
      border: '0.5px solid rgba(10,132,255,0.24)', boxShadow: 'var(--shadow-card)',
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 12 }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 800, color: 'var(--ios-label)', display: 'flex', alignItems: 'center', gap: 7 }}>
            🧭 今日操作清單
          </div>
          <div style={{ fontSize: 11, color: 'var(--ios-label3)', marginTop: 4, lineHeight: 1.45 }}>
            只整理既有掃描訊號，方便人工優先檢查；不是自動交易建議。
          </div>
        </div>
        <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <BriefPill color="var(--ios-green)">{entryCount} 進場</BriefPill>
          <BriefPill color="var(--ios-blue)">{totalScanned} 掃描</BriefPill>
          {steadyLeaders.length > 0 && <BriefPill color="var(--ios-yellow)">{stockTitle(steadyLeaders[0].stock)} 連榜{steadyLeaders[0].days}天</BriefPill>}
          {institutionalWeak && <BriefPill color="var(--ios-orange)">法人資料不足</BriefPill>}
          {stale && <BriefPill color="var(--ios-red)">資料非最新</BriefPill>}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 }}>
        {sections.map(section => <BriefSection key={section.title} {...section} onSelect={onSelect} />)}
      </div>
    </section>
  )
}
