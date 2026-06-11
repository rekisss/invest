import { useState, useMemo } from 'react'

const HIST_PAGE_SIZE = 20

const RISK_COLOR = { LOW: 'var(--ios-green)', MEDIUM: 'var(--ios-yellow)', HIGH: 'var(--ios-orange)', EXTREME: 'var(--ios-red)' }
const RISK_LABEL = { LOW: '低風險', MEDIUM: '中風險', HIGH: '高風險', EXTREME: '極高風險' }

function ProbBar({ prob }) {
  const pct = Math.round((prob ?? 0.5) * 100)
  const color = pct >= 60 ? 'var(--ios-green)' : pct <= 40 ? 'var(--ios-red)' : 'var(--ios-yellow)'
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <span style={{ fontSize: 13, color: 'var(--ios-label2)' }}>空方</span>
        <span style={{ color, fontWeight: 700, fontSize: 34, fontFamily: 'var(--font-mono)', letterSpacing: '-0.3px' }}>{pct}%</span>
        <span style={{ fontSize: 13, color: 'var(--ios-label2)' }}>多方</span>
      </div>
      <div className="ios-prob-bar">
        <div className="ios-prob-fill" style={{ width: `${pct}%`, background: color }} />
      </div>
    </div>
  )
}

function Card({ title, accent, children }) {
  return (
    <div style={{
      background: 'var(--ios-bg2)', borderRadius: 16,
      marginBottom: 12, overflow: 'hidden',
      boxShadow: 'var(--shadow-card)',
      ...(accent ? { borderLeft: `3px solid ${accent}` } : {}),
    }}>
      {title && (
        <div style={{
          fontSize: 12, fontWeight: 700, letterSpacing: 0.5,
          color: accent || 'var(--ios-label2)',
          textTransform: 'uppercase',
          padding: '12px 16px 0',
        }}>{title}</div>
      )}
      <div style={{ padding: '12px 16px 14px' }}>{children}</div>
    </div>
  )
}

function Tag({ text, color }) {
  return (
    <span style={{
      display: 'inline-block', padding: '4px 12px', borderRadius: 9999,
      fontSize: 13, background: `${color}20`, color, fontWeight: 600,
      marginRight: 6, marginBottom: 4,
    }}>{text}</span>
  )
}

function MarketDataGrid({ data }) {
  if (!data) return null
  const items = [
    { label: 'VIX', value: data.vix?.toFixed(1), color: data.vix > 25 ? 'var(--ios-red)' : data.vix > 18 ? 'var(--ios-yellow)' : 'var(--ios-green)' },
    { label: '那斯達克', value: data.nasdaq_ret != null ? `${(data.nasdaq_ret * 100).toFixed(2)}%` : '—', color: data.nasdaq_ret > 0 ? 'var(--ios-green)' : 'var(--ios-red)' },
    { label: '費半', value: data.sox_ret != null ? `${(data.sox_ret * 100).toFixed(2)}%` : '—', color: data.sox_ret > 0 ? 'var(--ios-green)' : 'var(--ios-red)' },
    { label: 'TSM ADR', value: data.tsm_adr_ret != null ? `${(data.tsm_adr_ret * 100).toFixed(2)}%` : '—', color: data.tsm_adr_ret > 0 ? 'var(--ios-green)' : 'var(--ios-red)' },
    { label: '外資期貨', value: data.futures_net != null ? `${data.futures_net > 0 ? '+' : ''}${Math.round(data.futures_net).toLocaleString()}口` : '—', color: data.futures_net > 0 ? 'var(--ios-green)' : 'var(--ios-red)' },
    { label: '夜盤', value: data.night_change != null ? `${data.night_change > 0 ? '+' : ''}${Math.round(data.night_change)}` : '—', color: data.night_change > 0 ? 'var(--ios-green)' : 'var(--ios-red)' },
    { label: 'PCR', value: data.pcr?.toFixed(2), color: data.pcr > 1.2 ? 'var(--ios-red)' : data.pcr < 0.8 ? 'var(--ios-green)' : 'var(--ios-label)' },
    { label: 'TAIEX RSI', value: data.taiex_rsi?.toFixed(0) || data.rsi14?.toFixed(0), color: 'var(--ios-label)' },
    { label: 'MACD 直方', value: data.macd_hist != null ? `${data.macd_hist > 0 ? '+' : ''}${data.macd_hist.toFixed(1)}` : null, color: data.macd_hist > 0 ? 'var(--ios-green)' : 'var(--ios-red)' },
    { label: '距 MA60', value: data.dist_ma60 != null ? `${data.dist_ma60 > 0 ? '+' : ''}${data.dist_ma60.toFixed(1)}%` : null, color: data.dist_ma60 > 0 ? 'var(--ios-green)' : 'var(--ios-red)' },
    { label: '夜盤趨勢', value: data.night_trend || null, color: 'var(--ios-label)' },
  ].filter(i => i.value && i.value !== 'undefined' && i.value !== 'NaN')

  return (
    <div className="ios-data-grid">
      {items.map(({ label, value, color }) => (
        <div key={label} className="ios-data-cell">
          <div className="ios-data-cell-label">{label}</div>
          <div className="ios-data-cell-value" style={{ color }}>{value}</div>
        </div>
      ))}
    </div>
  )
}

function HistoryRow({ entry }) {
  const [open, setOpen] = useState(false)
  const pct = Math.round((entry.xgb_prob_up ?? 0.5) * 100)
  const color = pct >= 60 ? 'var(--ios-green)' : pct <= 40 ? 'var(--ios-red)' : 'var(--ios-yellow)'
  const riskLevel = entry.risk?.level?.replace('RiskLevel.', '') || 'MEDIUM'

  return (
    <div style={{ borderBottom: '0.5px solid var(--ios-sep)' }}>
      <div
        onClick={() => setOpen(o => !o)}
        style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', cursor: 'pointer' }}
      >
        <div style={{ minWidth: 76, fontSize: 13, color: 'var(--ios-label2)', fontFamily: 'var(--font-mono)' }}>{entry.date}</div>
        <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color, fontSize: 17, minWidth: 48 }}>{pct}%</div>
        <div style={{ flex: 1, fontSize: 14, color: 'var(--ios-label)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {entry.xgb_label || (pct >= 55 ? '偏多' : pct <= 45 ? '偏空' : '中性')}
          {entry.regime?.label_zh ? ` · ${entry.regime.label_zh.slice(0, 20)}` : ''}
        </div>
        <div style={{ fontSize: 12, color: RISK_COLOR[riskLevel] || 'var(--ios-label2)', flexShrink: 0, fontWeight: 600 }}>
          {RISK_LABEL[riskLevel] || riskLevel}
        </div>
        <span style={{ color: 'var(--ios-label3)', fontSize: 12 }}>{open ? '▲' : '▼'}</span>
      </div>

      {open && (
        <div style={{ padding: '0 16px 14px', background: 'var(--ios-bg3)' }}>
          {entry.scenario?.main_scenario && (
            <div style={{ fontSize: 13, color: 'var(--ios-label2)', lineHeight: 1.6, marginBottom: 8 }}>{entry.scenario.main_scenario}</div>
          )}
          {entry.scenario?.best_strategy && (
            <div style={{ fontSize: 13, color: 'var(--ios-blue)', marginBottom: 8 }}>策略：{entry.scenario.best_strategy}</div>
          )}
          {entry.market_data && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {[
                ['VIX', entry.market_data.vix?.toFixed(1)],
                ['那斯達克', entry.market_data.nasdaq_ret != null ? `${(entry.market_data.nasdaq_ret * 100).toFixed(2)}%` : null],
                ['外資期貨', entry.market_data.futures_net != null ? `${Math.round(entry.market_data.futures_net).toLocaleString()}口` : null],
                ['夜盤', entry.market_data.night_change != null ? `${entry.market_data.night_change > 0 ? '+' : ''}${Math.round(entry.market_data.night_change)}` : null],
              ].filter(([, v]) => v).map(([label, val]) => (
                <span key={label} style={{ fontSize: 12, background: 'var(--ios-bg2)', borderRadius: 8, padding: '3px 9px', color: 'var(--ios-label)' }}>
                  {label} <b>{val}</b>
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default function PredictionPanel({ prediction, history = [] }) {
  if (!prediction) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 12, padding: 24, textAlign: 'center' }}>
        <div style={{ fontSize: 48 }}>🔮</div>
        <div style={{ fontSize: 17, fontWeight: 600, color: 'var(--ios-label)' }}>尚無盤前預測</div>
        <div style={{ fontSize: 14, color: 'var(--ios-label2)', maxWidth: 280, lineHeight: 1.6 }}>每個交易日盤前執行後，這裡會顯示 AI 預測分析、市場結構分析、風險評估</div>
      </div>
    )
  }

  const { xgb_prob_up, xgb_label, date, generated_at, regime, scenario, risk, news_sentiment, market_data, ai_insight } = prediction
  const riskLevel = risk?.level?.replace('RiskLevel.', '') || 'MEDIUM'
  const [histPage, setHistPage] = useState(0)
  const histTotalPages = Math.ceil(history.length / HIST_PAGE_SIZE)
  const pagedHistory = useMemo(
    () => history.slice(histPage * HIST_PAGE_SIZE, (histPage + 1) * HIST_PAGE_SIZE),
    [history, histPage]
  )

  return (
    <div style={{ height: '100%', overflowY: 'auto', WebkitOverflowScrolling: 'touch' }}>
      {/* Sticky date line */}
      <div style={{
        position: 'sticky', top: 0, zIndex: 2,
        padding: '6px 20px',
        background: 'var(--ios-bg)',
        borderBottom: '0.5px solid var(--ios-sep)',
        fontSize: 13, color: 'var(--ios-label2)',
        display: 'flex', justifyContent: 'space-between',
      }}>
        <span>{date}</span>
        <span>{generated_at} CST</span>
      </div>

      <div style={{ padding: '14px 16px 0' }}>
        {/* Prediction probability */}
        <Card title="AI 大盤預測" accent="var(--ios-blue)">
          <ProbBar prob={xgb_prob_up} />
          <div style={{ marginTop: 12, display: 'flex', flexWrap: 'wrap' }}>
            <Tag text={xgb_label || (xgb_prob_up >= 0.55 ? '偏多' : xgb_prob_up <= 0.45 ? '偏空' : '中性')}
              color={xgb_prob_up >= 0.55 ? 'var(--ios-green)' : xgb_prob_up <= 0.45 ? 'var(--ios-red)' : 'var(--ios-yellow)'} />
            {regime && <Tag text={`勝率 ${regime.win_rate > 1 ? regime.win_rate : Math.round(regime.win_rate * 100)}%`} color="var(--ios-blue)" />}
          </div>
          {regime?.label_zh && (
            <div style={{ marginTop: 10, padding: '10px 12px', background: 'var(--ios-bg3)', borderRadius: 10, fontSize: 14, color: 'var(--ios-label)', lineHeight: 1.5 }}>
              {regime.label_zh}
            </div>
          )}
        </Card>

        {/* AI Insight */}
        {ai_insight && (
          <Card title="🤖 AI 操盤要點" accent="var(--ios-purple)">
            <div style={{ fontSize: 14, lineHeight: 1.9, whiteSpace: 'pre-line', color: 'var(--ios-label)' }}>
              {ai_insight}
            </div>
          </Card>
        )}

        {/* Market data */}
        {market_data && (market_data.vix != null || market_data.nasdaq_ret != null || market_data.futures_net != null || market_data.night_change != null) && (
          <Card title="市場指標">
            <MarketDataGrid data={market_data} />
          </Card>
        )}

        {/* Scenario */}
        {scenario && (
          <Card title="市場結構分析" accent="var(--ios-yellow)">
            {scenario.main_scenario && (
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 11, color: 'var(--ios-label2)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 600 }}>主力劇本</div>
                <div style={{ fontSize: 14, lineHeight: 1.7, color: 'var(--ios-label)' }}>{scenario.main_scenario}</div>
              </div>
            )}
            {scenario.best_strategy && (
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 11, color: 'var(--ios-label2)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 600 }}>最佳策略</div>
                <div style={{ fontSize: 14, color: 'var(--ios-blue)', lineHeight: 1.7 }}>{scenario.best_strategy}</div>
              </div>
            )}
            {scenario.danger_signals?.length > 0 && (
              <div style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 11, color: 'var(--ios-label2)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 600 }}>⚠️ 危險訊號</div>
                {scenario.danger_signals.map((s, i) => (
                  <div key={i} style={{ fontSize: 13, color: 'var(--ios-orange)', padding: '3px 0' }}>· {s}</div>
                ))}
              </div>
            )}
            {scenario.forbidden_actions?.length > 0 && (
              <div>
                <div style={{ fontSize: 11, color: 'var(--ios-label2)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 600 }}>🚫 禁止操作</div>
                {scenario.forbidden_actions.map((s, i) => (
                  <div key={i} style={{ fontSize: 13, color: 'var(--ios-red)', padding: '3px 0' }}>· {s}</div>
                ))}
              </div>
            )}
          </Card>
        )}

        {/* Risk */}
        {risk && (
          <Card title="風險評估" accent={RISK_COLOR[riskLevel]}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 12 }}>
              <div style={{ fontSize: 22, fontWeight: 700, color: RISK_COLOR[riskLevel], letterSpacing: '-0.3px' }}>
                {RISK_LABEL[riskLevel] || riskLevel}
              </div>
              <div className="ios-prob-bar" style={{ flex: 1 }}>
                <div className="ios-prob-fill" style={{ width: `${(risk.score || 0) * 100}%`, background: RISK_COLOR[riskLevel] }} />
              </div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--ios-label2)', minWidth: 32 }}>{((risk.score || 0) * 100).toFixed(0)}%</div>
            </div>
            {risk.factors?.length > 0 && risk.factors.map((f, i) => (
              <div key={i} style={{ fontSize: 13, color: 'var(--ios-label2)', padding: '3px 0' }}>
                · {typeof f === 'string' ? f : (f.description || f.name || '')}
                {typeof f !== 'string' && f.action && <span style={{ color: 'var(--ios-blue)', marginLeft: 6 }}>→ {f.action}</span>}
              </div>
            ))}
          </Card>
        )}

        {/* News sentiment */}
        {news_sentiment && (
          <Card title="新聞情緒">
            <div style={{ display: 'flex', gap: 12, marginBottom: 10 }}>
              {[
                { label: '利多', val: news_sentiment.bullish_count, color: 'var(--ios-green)' },
                { label: '利空', val: news_sentiment.bearish_count, color: 'var(--ios-red)' },
                { label: '市場影響', val: `${news_sentiment.market_impact > 0 ? '+' : ''}${news_sentiment.market_impact?.toFixed(2)}`, color: news_sentiment.market_impact > 0 ? 'var(--ios-green)' : news_sentiment.market_impact < 0 ? 'var(--ios-red)' : 'var(--ios-label2)' },
              ].map(({ label, val, color }) => (
                <div key={label} style={{ flex: 1, background: 'var(--ios-bg3)', borderRadius: 12, padding: '10px 12px', textAlign: 'center' }}>
                  <div style={{ fontSize: 11, color: 'var(--ios-label2)', marginBottom: 4 }}>{label}</div>
                  <div style={{ fontSize: 20, fontWeight: 700, color, fontFamily: 'var(--font-mono)' }}>{val}</div>
                </div>
              ))}
            </div>
            {news_sentiment.key_events?.length > 0 && (
              <div>
                {news_sentiment.key_events.slice(0, 5).map((e, i) => (
                  <div key={i} style={{ fontSize: 13, color: 'var(--ios-label)', padding: '6px 0', borderBottom: '0.5px solid var(--ios-sep)' }}>· {e}</div>
                ))}
              </div>
            )}
          </Card>
        )}

        {/* History with pagination */}
        {history.length > 0 && (
          <Card title={`歷史記錄（${history.length} 筆）`}>
            <div style={{ margin: '0 -16px' }}>
              {pagedHistory.map((entry, i) => <HistoryRow key={entry.date || i} entry={entry} />)}
            </div>
            {histTotalPages > 1 && (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12, paddingTop: 12 }}>
                <button
                  onClick={() => setHistPage(p => Math.max(0, p - 1))}
                  disabled={histPage === 0}
                  style={{
                    background: histPage === 0 ? 'var(--ios-fill2)' : 'var(--ios-blue)',
                    color: histPage === 0 ? 'var(--ios-label3)' : '#fff',
                    border: 'none', borderRadius: 9999, padding: '5px 14px', fontSize: 12,
                    cursor: histPage === 0 ? 'default' : 'pointer',
                  }}
                >上一頁</button>
                <span style={{ fontSize: 12, color: 'var(--ios-label3)' }}>
                  {histPage + 1} / {histTotalPages}
                </span>
                <button
                  onClick={() => setHistPage(p => Math.min(histTotalPages - 1, p + 1))}
                  disabled={histPage >= histTotalPages - 1}
                  style={{
                    background: histPage >= histTotalPages - 1 ? 'var(--ios-fill2)' : 'var(--ios-blue)',
                    color: histPage >= histTotalPages - 1 ? 'var(--ios-label3)' : '#fff',
                    border: 'none', borderRadius: 9999, padding: '5px 14px', fontSize: 12,
                    cursor: histPage >= histTotalPages - 1 ? 'default' : 'pointer',
                  }}
                >下一頁</button>
              </div>
            )}
          </Card>
        )}
      </div>

      <div style={{ height: 24 }} />
    </div>
  )
}
