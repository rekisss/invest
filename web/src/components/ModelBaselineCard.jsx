import { useLayoutEffect, useRef } from 'react'
import { animate, stagger } from 'animejs'

// 「這個預測到底有沒有用?」—— 模型命中率 vs 兩種不用動腦的猜法。
// 資料來自 build 期的 realOutcomes.baseline(scripts/outcome-realign.mjs):
// 同一批已到期的日子、同樣的 5 日期距與 0.3% 門檻,才是公平比較。
// 模型如果連「一律猜漲」都贏不了,上面再漂亮的機率數字都沒有參考價值。

const VERDICT = {
  better:  { text: '模型贏過天真猜法', color: 'var(--ios-green)' },
  similar: { text: '跟天真猜法差不多(±5%)', color: 'var(--ios-yellow)' },
  worse:   { text: '模型輸給天真猜法', color: 'var(--ios-red)' },
}

const pct = v => (v == null ? '—' : `${Math.round(v * 100)}%`)

export default function ModelBaselineCard({ baseline, dataFix }) {
  const barsRef = useRef(null)

  useLayoutEffect(() => {
    const root = barsRef.current
    if (!root) return
    const bars = [...root.querySelectorAll('[data-bar]')]
    // 動畫前先指令式歸零,避免首幀閃一下滿格
    for (const el of bars) { el.style.transform = 'scaleX(0)'; el.style.transformOrigin = 'left center' }
    const anim = animate(bars, { scaleX: [0, 1], duration: 700, ease: 'outQuart', delay: stagger(90) })
    return () => anim.pause?.()
  }, [baseline])

  if (!baseline || !baseline.n) return null
  const v = VERDICT[baseline.verdict] || null
  const rows = [
    { label: '模型預測', value: baseline.model_rate, color: v?.color || 'var(--ios-blue)', bold: true },
    { label: '一律猜漲', value: baseline.always_up_rate, color: 'var(--ios-label3)' },
    { label: '一律猜跌', value: baseline.always_down_rate, color: 'var(--ios-label3)' },
  ]
  const brierWorse = baseline.brier > baseline.brier_naive

  return (
    <div style={{
      background: 'var(--ios-bg2)', borderRadius: 16, marginBottom: 12, overflow: 'hidden',
      boxShadow: 'var(--shadow-card)', borderLeft: `3px solid ${v?.color || 'var(--ios-blue)'}`,
    }}>
      <div style={{ padding: '14px 16px' }}>
        <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: 0.5, color: v?.color || 'var(--ios-label2)', marginBottom: 8 }}>
          ⚖️ 模型 vs 天真猜法({baseline.horizon} 日期距)
        </div>

        {v && (
          <div style={{ fontSize: 17, fontWeight: 700, color: v.color, marginBottom: 2 }}>
            {v.text}
            {baseline.edge != null && (
              <span style={{ fontSize: 13, marginLeft: 6, fontFamily: 'var(--font-mono)' }}>
                {baseline.edge >= 0 ? '+' : ''}{Math.round(baseline.edge * 100)} 個百分點
              </span>
            )}
          </div>
        )}
        <div style={{ fontSize: 11, color: 'var(--ios-label3)', marginBottom: 12 }}>
          {baseline.first_date} ~ {baseline.last_date} · 已到期 {baseline.n} 天(中性不計)
          {baseline.low_sample ? ' · 樣本偏少,僅供參考' : ''}
        </div>

        <div ref={barsRef}>
          {rows.map(r => (
            <div key={r.label} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <span style={{ width: 60, fontSize: 12, color: 'var(--ios-label2)', fontWeight: r.bold ? 700 : 400 }}>{r.label}</span>
              <div style={{ flex: 1, height: 10, borderRadius: 5, background: 'var(--ios-fill)', overflow: 'hidden' }}>
                <div data-bar style={{ width: `${Math.max(2, (r.value || 0) * 100)}%`, height: '100%', background: r.color, borderRadius: 5 }} />
              </div>
              <span style={{ width: 38, textAlign: 'right', fontSize: 13, fontWeight: r.bold ? 700 : 500, fontFamily: 'var(--font-mono)', color: r.bold ? r.color : 'var(--ios-label2)' }}>
                {pct(r.value)}
              </span>
            </div>
          ))}
        </div>

        <div style={{ fontSize: 11.5, color: 'var(--ios-label2)', marginTop: 10, lineHeight: 1.6 }}>
          機率準度(Brier,越低越好):模型 <b style={{ fontFamily: 'var(--font-mono)', color: brierWorse ? 'var(--ios-red)' : 'var(--ios-green)' }}>{baseline.brier}</b>
          {' '}vs 每天報同一個上漲率 <b style={{ fontFamily: 'var(--font-mono)' }}>{baseline.brier_naive}</b>
          {brierWorse ? ' → 機率數字比不報還差' : ''}
        </div>

        {baseline.buckets?.length > 0 && (
          <div style={{ marginTop: 10 }}>
            <div style={{ fontSize: 11, color: 'var(--ios-label3)', marginBottom: 4 }}>
              校準:模型說的上漲機率 vs 實際上漲比例(理想上應該越往下越高)
            </div>
            {baseline.buckets.map(b => (
              <div key={b.lo} style={{ display: 'flex', fontSize: 11.5, fontFamily: 'var(--font-mono)', padding: '3px 0', borderBottom: '0.5px solid var(--ios-sep)', color: 'var(--ios-label2)' }}>
                <span style={{ flex: 1 }}>{Math.round(b.lo * 100)}–{Math.round(b.hi * 100)}%</span>
                <span style={{ width: 52, textAlign: 'right' }}>n={b.n}</span>
                <span style={{ width: 70, textAlign: 'right' }}>實漲 {pct(b.up_rate)}</span>
              </div>
            ))}
          </div>
        )}

        {dataFix?.taiex_lag === 1 && (
          <div style={{ fontSize: 10.5, color: 'var(--ios-label3)', marginTop: 10, background: 'var(--ios-fill4, var(--ios-fill))', borderRadius: 6, padding: '6px 8px', lineHeight: 1.5 }}>
            🔧 資料已校正:原始紀錄的加權收盤晚了一個交易日(與 K 線大盤代理方向一致率 {pct(dataFix.lag_agree0)} → 校正後 {pct(dataFix.lag_agree1)}),
            已依真實交易日重新打分{dataFix.duplicates ? `,剔除 ${dataFix.duplicates} 筆疑似舊值` : ''}{dataFix.non_trading ? `,${dataFix.non_trading} 筆休市日紀錄不計分` : ''}。
          </div>
        )}

        <div style={{ fontSize: 10.5, color: 'var(--ios-label4, var(--ios-label3))', marginTop: 8 }}>
          過去命中率不代表未來表現;模型未贏過天真猜法前,不建議作為進出場依據。
        </div>
      </div>
    </div>
  )
}
