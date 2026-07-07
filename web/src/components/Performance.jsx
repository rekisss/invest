import { useMemo } from 'react'
import { useLivePrices } from '../hooks/useLivePrices'

// ── helpers ──────────────────────────────────────────────────────────────────
const POS_KEY = 'tw_portfolio_positions'
const UP = 'var(--ios-red)'      // Taiwan convention: red = up/gain
const DOWN = 'var(--ios-green)'  // green = down/loss

function loadPositions() {
  try { return JSON.parse(localStorage.getItem(POS_KEY) || '{}') } catch { return {} }
}
function fmt(v, d = 2) { return v == null || isNaN(v) ? '—' : Number(v).toFixed(d) }
function pctStr(v, d = 1) { return v == null || isNaN(v) ? '—' : `${v >= 0 ? '+' : ''}${Number(v).toFixed(d)}%` }
function colorOf(v) { return v == null ? 'var(--ios-label3)' : v >= 0 ? UP : DOWN }

function latestScan(data) {
  const scans = data?.scans || {}
  for (const d of Object.keys(scans).sort().reverse()) {
    const s = scans[d]
    if (s && ((s.top_stocks && s.top_stocks.length) || (s.filter_stocks && s.filter_stocks.length))) return s
  }
  return null
}
function scanLookup(data) {
  const s = latestScan(data)
  const rows = [...(data?.aggregateLatest?.top_stocks || []), ...(s?.top_stocks || []), ...(s?.filter_stocks || [])]
  const byId = {}
  for (const r of rows) {
    const id = String(r.stock_id)
    // keep the richest row (most fields) per stock
    if (!byId[id] || Object.keys(r).length > Object.keys(byId[id]).length) byId[id] = r
  }
  return byId
}

// ── small UI atoms ───────────────────────────────────────────────────────────
function Stat({ label, value, color, sub }) {
  return (
    <div style={{ flex: 1, minWidth: 92, background: 'var(--ios-bg3)', borderRadius: 12, padding: '10px 12px', textAlign: 'center' }}>
      <div style={{ fontSize: 11, color: 'var(--ios-label3)', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 19, fontWeight: 800, color: color || 'var(--ios-label)', fontFamily: 'var(--font-mono)' }}>{value}</div>
      {sub && <div style={{ fontSize: 9.5, color: 'var(--ios-label4)', marginTop: 2 }}>{sub}</div>}
    </div>
  )
}
function Card({ title, hint, children }) {
  return (
    <div style={{ background: 'var(--ios-bg2)', borderRadius: 16, padding: '14px 15px', marginBottom: 12, boxShadow: 'var(--shadow-card)' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 10 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--ios-label)' }}>{title}</div>
        {hint && <div style={{ fontSize: 10, color: 'var(--ios-label4)' }}>{hint}</div>}
      </div>
      {children}
    </div>
  )
}

// ── Part 1: strategy validation ──────────────────────────────────────────────
function StrategyValidation({ data }) {
  const sa = data?.strategyAccuracy
  const os = data?.outcomeStats
  const ro = data?.realOutcomes

  const top = sa?.top10?.d5
  const base = sa?.baseline?.d5
  const edge = (top?.win_rate != null && base?.win_rate != null) ? top.win_rate - base.win_rate : null
  const verdict = edge == null ? null : edge > 3 ? { t: '勝過大盤平均', c: UP } : edge < -3 ? { t: '落後大盤平均', c: DOWN } : { t: '與大盤持平', c: 'var(--ios-yellow)' }

  const rows = [['top10', 'TOP 10%'], ['top25', 'TOP 25%'], ['baseline', '全體平均']]
  const hs = ['d1', 'd5', 'd10']

  return (
    <>
      <Card title="策略實際績效" hint="以真實收盤回測,非夜盤代理">
        {top?.win_rate == null ? (
          <div style={{ fontSize: 12, color: 'var(--ios-label3)', lineHeight: 1.6 }}>
            📊 勝率資料累積中——需要掃描日累積足夠的前瞻交易日(每個 horizon ≥10 筆)才會顯示。再過幾個交易日回來看。
          </div>
        ) : (
          <>
            {verdict && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, padding: '10px 12px', borderRadius: 12,
                background: `${verdict.c}14`, border: `0.5px solid ${verdict.c}44` }}>
                <div style={{ fontSize: 22 }}>{edge > 3 ? '✅' : edge < -3 ? '⚠️' : '➖'}</div>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 800, color: verdict.c }}>近 5 日:選股{verdict.t}</div>
                  <div style={{ fontSize: 11, color: 'var(--ios-label3)' }}>
                    TOP 10% 勝率 {fmt(top.win_rate, 1)}% vs 全體 {fmt(base.win_rate, 1)}%（{edge >= 0 ? '+' : ''}{fmt(edge, 1)} 個百分點）
                  </div>
                </div>
              </div>
            )}
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ color: 'var(--ios-label3)', fontSize: 10.5 }}>
                    <th style={{ textAlign: 'left', padding: '4px 6px' }}>族群</th>
                    {hs.map(h => <th key={h} colSpan={2} style={{ textAlign: 'center', padding: '4px 6px' }}>{h === 'd1' ? '1日' : h === 'd5' ? '5日' : '10日'}</th>)}
                  </tr>
                  <tr style={{ color: 'var(--ios-label4)', fontSize: 9.5 }}>
                    <th />
                    {hs.map(h => [<th key={h + 'w'} style={{ padding: '0 4px' }}>勝率</th>, <th key={h + 'r'} style={{ padding: '0 4px' }}>均報</th>])}
                  </tr>
                </thead>
                <tbody>
                  {rows.map(([k, lbl]) => (
                    <tr key={k} style={{ borderTop: '0.5px solid var(--ios-sep)' }}>
                      <td style={{ padding: '6px', fontWeight: k === 'baseline' ? 400 : 700, color: k === 'baseline' ? 'var(--ios-label3)' : 'var(--ios-label)' }}>{lbl}</td>
                      {hs.map(h => {
                        const c = sa?.[k]?.[h]
                        return [
                          <td key={h + 'w'} style={{ textAlign: 'center', padding: '6px 4px', fontFamily: 'var(--font-mono)' }}>{c?.win_rate == null ? '—' : `${fmt(c.win_rate, 0)}%`}</td>,
                          <td key={h + 'r'} style={{ textAlign: 'center', padding: '6px 4px', fontFamily: 'var(--font-mono)', color: colorOf(c?.avg_return_pct) }}>{c?.avg_return_pct == null ? '—' : pctStr(c.avg_return_pct, 1)}</td>,
                        ]
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div style={{ fontSize: 9.5, color: 'var(--ios-label4)', marginTop: 8, lineHeight: 1.5 }}>
              ⚠️ 樣本仍在累積、可能受單一盤勢影響;跨過不同盤勢後數字才穩定。TOP 若長期落後全體,代表評分需要調整。
            </div>
          </>
        )}
      </Card>

      {os && (os.A?.total || os.B?.total || os.C?.total || os.D?.total) ? (
        <Card title="評級實際勝率" hint="A / B / C / D 進場評級的事後表現">
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {['A', 'B', 'C', 'D'].map(g => {
              const s = os[g]
              if (!s || !s.total) return null
              return <Stat key={g} label={`${g} 級`} value={s.win_rate == null ? '—' : `${fmt(s.win_rate, 0)}%`}
                color={colorOf(s.avg_return_pct)} sub={`${s.total} 筆 · 均報 ${pctStr(s.avg_return_pct, 1)}`} />
            })}
          </div>
        </Card>
      ) : null}

      {ro?.top20_summary && (
        <Card title="每日 TOP 20 真實報酬" hint={`已累積 ${ro.top20_snapshots || 0} 個交易日快照`}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {[1, 5, 10, 20].map(h => {
              const s = ro.top20_summary[`ret_${h}d`]
              if (!s) return null
              return <Stat key={h} label={`${h} 日`} value={s.win_rate == null ? '—' : `${fmt(s.win_rate * 100, 0)}%`}
                color={colorOf(s.avg)} sub={`均報 ${pctStr(s.avg * 100, 1)} · n=${s.count}`} />
            })}
          </div>
        </Card>
      )}
    </>
  )
}

// ── Part 2: holdings analysis + suggestions ──────────────────────────────────
function suggest({ pnlPct, scan, chipBull }) {
  if (pnlPct != null && pnlPct >= 8) return { t: '已達 +8% 高勝率停利點 — 建議分批獲利落袋', c: UP, icon: '🎯' }
  if (pnlPct != null && pnlPct >= 5) return { t: '接近 +8% 停利區 — 留意分批出場時機', c: 'var(--ios-yellow)', icon: '📈' }
  if (pnlPct != null && pnlPct <= -8) return { t: '虧損已逾 8% — 檢視基本面/技術面,考慮停損', c: DOWN, icon: '⚠️' }
  if (scan && scan.entry_signal === false && scan.entry_score != null && scan.entry_score < 500)
    return { t: '掃描訊號轉弱(分數 < 500)— 保護獲利或減碼', c: DOWN, icon: '🔻' }
  if (scan && scan.entry_signal) return { t: chipBull ? '仍在掃描榜且法人連買 — 籌碼偏多,可續抱' : '仍在掃描榜、訊號續強 — 可續抱', c: UP, icon: '✅' }
  if (chipBull) return { t: '法人近日連買,籌碼偏多 — 續抱觀察', c: UP, icon: '🏦' }
  return { t: '訊號中性 — 續抱觀察,守住停利/停損紀律', c: 'var(--ios-label3)', icon: '➖' }
}

function HoldingsAdvice({ data }) {
  const positions = useMemo(loadPositions, [])
  const posIds = useMemo(() => Object.keys(positions), [positions])
  const { prices } = useLivePrices(posIds)
  const scanMap = useMemo(() => scanLookup(data), [data])

  const rows = useMemo(() => posIds.map(id => {
    const p = positions[id]
    const scan = scanMap[String(id)] || null
    const live = prices[id]?.price
    const curPrice = live ?? scan?.close ?? null
    const pnlPct = (curPrice != null && p.buyPrice > 0) ? (curPrice - p.buyPrice) / p.buyPrice * 100 : null
    const chipBull = !!(scan && (scan.foreign_buy_3d === true || scan.dealer_buy_3d === true || scan.invest_trust_buy_2d === true))
    return { id, p, scan, curPrice, pnlPct, chipBull, s: suggest({ pnlPct, scan, chipBull }) }
  }).sort((a, b) => (b.pnlPct ?? -999) - (a.pnlPct ?? -999)), [posIds, positions, prices, scanMap])

  if (!posIds.length) {
    return (
      <Card title="持倉健檢與建議">
        <div style={{ fontSize: 12, color: 'var(--ios-label3)', lineHeight: 1.6 }}>
          尚未有持倉紀錄。到「持倉」分頁新增你的部位後,這裡會針對每檔給出停利/停損/訊號建議。
        </div>
      </Card>
    )
  }

  const known = rows.filter(r => r.pnlPct != null)
  const winners = known.filter(r => r.pnlPct >= 0).length
  const nearTP = rows.filter(r => r.pnlPct != null && r.pnlPct >= 5).length
  const weak = rows.filter(r => r.scan && r.scan.entry_signal === false && r.scan.entry_score != null && r.scan.entry_score < 500).length
  const avgPnl = known.length ? known.reduce((a, r) => a + r.pnlPct, 0) / known.length : null

  return (
    <>
      <Card title="持倉健檢" hint={`${posIds.length} 檔部位`}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
          <Stat label="平均損益" value={pctStr(avgPnl, 1)} color={colorOf(avgPnl)} />
          <Stat label="獲利中" value={`${winners}/${known.length}`} color={winners >= known.length - winners ? UP : DOWN} />
          <Stat label="近停利區" value={nearTP} color={nearTP ? 'var(--ios-yellow)' : 'var(--ios-label3)'} sub="≥ +5%" />
          <Stat label="訊號轉弱" value={weak} color={weak ? DOWN : 'var(--ios-label3)'} />
        </div>
        <div style={{ fontSize: 11, color: 'var(--ios-label3)', lineHeight: 1.6, padding: '8px 10px', background: 'var(--ios-fill4)', borderRadius: 8 }}>
          {nearTP > 0 && <div>🎯 有 {nearTP} 檔接近/超過 +8% 高勝率停利點 — 依「更常贏」策略,建議分批獲利。</div>}
          {weak > 0 && <div>🔻 有 {weak} 檔已跌出掃描強勢區,留意是否減碼保護獲利。</div>}
          {nearTP === 0 && weak === 0 && <div>目前無急迫訊號 — 續抱並守住停利(+8%)/停損紀律即可。</div>}
        </div>
      </Card>

      <Card title="逐檔建議" hint="依損益排序">
        {rows.map(r => (
          <div key={r.id} style={{ padding: '10px 0', borderTop: '0.5px solid var(--ios-sep)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <span style={{ fontSize: 13, fontWeight: 700, fontFamily: 'var(--font-mono)', color: 'var(--ios-blue)' }}>{r.id}</span>
              <span style={{ fontSize: 12, color: 'var(--ios-label)' }}>{r.p.name || r.scan?.name || ''}</span>
              <span style={{ marginLeft: 'auto', fontSize: 14, fontWeight: 800, fontFamily: 'var(--font-mono)', color: colorOf(r.pnlPct) }}>{pctStr(r.pnlPct, 1)}</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, fontSize: 11.5, color: r.s.c }}>
              <span>{r.s.icon}</span><span style={{ lineHeight: 1.5 }}>{r.s.t}</span>
            </div>
            <div style={{ fontSize: 10, color: 'var(--ios-label4)', marginTop: 3, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <span>成本 {fmt(r.p.buyPrice)}</span>
              <span>現價 {r.curPrice != null ? fmt(r.curPrice) : '—'}</span>
              <span>停利 {fmt(r.p.buyPrice * 1.08)}</span>
              {r.scan?.entry_score != null && <span>掃描分 {Math.round(r.scan.entry_score)}</span>}
              {r.chipBull && <span style={{ color: UP }}>法人連買</span>}
            </div>
          </div>
        ))}
      </Card>
    </>
  )
}

// ── page ─────────────────────────────────────────────────────────────────────
export default function Performance({ data }) {
  return (
    <div style={{ height: '100%', overflowY: 'auto', padding: '12px 12px 40px' }}>
      <StrategyValidation data={data} />
      <HoldingsAdvice data={data} />
      <div style={{ fontSize: 9.5, color: 'var(--ios-label4)', textAlign: 'center', lineHeight: 1.6, padding: '4px 12px' }}>
        本頁為策略參考,非投資建議。停利 +8% 為回測下的高勝率設定,會放棄少數大波段;<br />樣本累積越久越可靠。
      </div>
    </div>
  )
}
