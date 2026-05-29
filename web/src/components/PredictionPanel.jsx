const RISK_COLOR = { LOW: 'var(--green)', MEDIUM: 'var(--yellow)', HIGH: 'var(--orange)', EXTREME: 'var(--red)' }
const RISK_LABEL = { LOW: '低風險', MEDIUM: '中風險', HIGH: '高風險', EXTREME: '極高風險' }

function ProbBar({ prob }) {
  const pct = Math.round((prob ?? 0.5) * 100)
  const color = pct >= 60 ? 'var(--green)' : pct <= 40 ? 'var(--red)' : 'var(--yellow)'
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4, fontSize: 12, color: 'var(--muted)' }}>
        <span>空方</span>
        <span style={{ color, fontWeight: 700, fontSize: 20, fontFamily: 'var(--font-mono)' }}>{pct}%</span>
        <span>多方</span>
      </div>
      <div style={{ height: 10, background: 'var(--surface2)', borderRadius: 5, overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${pct}%`, background: color, borderRadius: 5, transition: 'width 0.6s ease' }} />
      </div>
    </div>
  )
}

function Card({ title, children, accent }) {
  return (
    <div style={{
      background: 'var(--surface)', border: `1px solid ${accent || 'var(--border)'}`,
      borderRadius: 'var(--radius-lg)', padding: 16, marginBottom: 12,
    }}>
      {title && <div style={{ fontSize: 11, fontWeight: 700, color: accent || 'var(--muted)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 10 }}>{title}</div>}
      {children}
    </div>
  )
}

function Tag({ text, color }) {
  return (
    <span style={{
      display: 'inline-block', padding: '2px 8px', borderRadius: 4, fontSize: 11,
      background: `${color}22`, color, fontWeight: 600, marginRight: 4, marginBottom: 4,
    }}>{text}</span>
  )
}

function MarketDataGrid({ data }) {
  if (!data) return null
  const items = [
    { label: 'VIX', value: data.vix?.toFixed(1), color: data.vix > 25 ? 'var(--red)' : data.vix > 18 ? 'var(--yellow)' : 'var(--green)' },
    { label: '那斯達克', value: data.nasdaq_ret != null ? `${(data.nasdaq_ret * 100).toFixed(2)}%` : '—', color: data.nasdaq_ret > 0 ? 'var(--green)' : 'var(--red)' },
    { label: '費城半導體', value: data.sox_ret != null ? `${(data.sox_ret * 100).toFixed(2)}%` : '—', color: data.sox_ret > 0 ? 'var(--green)' : 'var(--red)' },
    { label: '台積電 ADR', value: data.tsm_adr_ret != null ? `${(data.tsm_adr_ret * 100).toFixed(2)}%` : '—', color: data.tsm_adr_ret > 0 ? 'var(--green)' : 'var(--red)' },
    { label: '外資期貨', value: data.futures_net != null ? `${data.futures_net > 0 ? '+' : ''}${Math.round(data.futures_net).toLocaleString()}口` : '—', color: data.futures_net > 0 ? 'var(--green)' : 'var(--red)' },
    { label: '夜盤', value: data.night_change != null ? `${data.night_change > 0 ? '+' : ''}${Math.round(data.night_change)}` : '—', color: data.night_change > 0 ? 'var(--green)' : 'var(--red)' },
    { label: 'PCR', value: data.pcr?.toFixed(2), color: data.pcr > 1.2 ? 'var(--red)' : data.pcr < 0.8 ? 'var(--green)' : 'var(--text)' },
    { label: '加權 RSI', value: data.taiex_rsi?.toFixed(0) || data.rsi14?.toFixed(0), color: 'var(--text)' },
  ].filter(i => i.value && i.value !== 'undefined' && i.value !== 'NaN')
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(110px, 1fr))', gap: 8 }}>
      {items.map(({ label, value, color }) => (
        <div key={label} style={{ background: 'var(--surface2)', borderRadius: 6, padding: '8px 10px' }}>
          <div style={{ fontSize: 10, color: 'var(--muted)', marginBottom: 2 }}>{label}</div>
          <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color, fontSize: 14 }}>{value}</div>
        </div>
      ))}
    </div>
  )
}

export default function PredictionPanel({ prediction }) {
  if (!prediction) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--muted)', gap: 12, padding: 24, textAlign: 'center' }}>
        <div style={{ fontSize: 40 }}>🔮</div>
        <div style={{ fontSize: 16, color: 'var(--text)', fontWeight: 600 }}>尚無盤前預測</div>
        <div style={{ fontSize: 12, maxWidth: 280 }}>每個交易日盤前執行後，這裡會顯示 AI 預測分析、市場結構分析、風險評估</div>
      </div>
    )
  }

  const { xgb_prob_up, xgb_label, date, generated_at, regime, scenario, risk, news_sentiment, market_data } = prediction
  const riskLevel = risk?.level?.replace('RiskLevel.', '') || 'MEDIUM'

  return (
    <div style={{ height: '100%', overflowY: 'auto', padding: '0 0 32px' }}>
      {/* Header */}
      <div style={{ padding: '14px 16px 10px', borderBottom: '1px solid var(--border)', background: 'var(--surface)', position: 'sticky', top: 0, zIndex: 1 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ fontWeight: 700, fontSize: 15 }}>🔮 盤前預測</div>
          <div style={{ fontSize: 11, color: 'var(--muted)' }}>{date} · {generated_at} CST</div>
        </div>
      </div>

      <div style={{ padding: '16px 16px 0' }}>
        {/* Prediction prob */}
        <Card title="AI 大盤預測" accent="var(--accent)">
          <ProbBar prob={xgb_prob_up} />
          <div style={{ textAlign: 'center', marginTop: 10 }}>
            <Tag text={xgb_label || (xgb_prob_up >= 0.55 ? '偏多' : xgb_prob_up <= 0.45 ? '偏空' : '中性')}
              color={xgb_prob_up >= 0.55 ? 'var(--green)' : xgb_prob_up <= 0.45 ? 'var(--red)' : 'var(--yellow)'} />
            {regime && <Tag text={`勝率 ${regime.win_rate}%`} color="var(--accent)" />}
          </div>
          {regime?.label_zh && (
            <div style={{ marginTop: 10, padding: '8px 12px', background: 'var(--surface2)', borderRadius: 6, fontSize: 13, color: 'var(--text)' }}>
              {regime.label_zh}
            </div>
          )}
        </Card>

        {/* Market data */}
        {market_data && Object.keys(market_data).length > 0 && (
          <Card title="市場指標">
            <MarketDataGrid data={market_data} />
          </Card>
        )}

        {/* Scenario */}
        {scenario && (
          <Card title="市場結構分析" accent="var(--yellow)">
            {scenario.main_scenario && (
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 4 }}>主力劇本</div>
                <div style={{ fontSize: 13, lineHeight: 1.7 }}>{scenario.main_scenario}</div>
              </div>
            )}
            {scenario.best_strategy && (
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 4 }}>最佳策略</div>
                <div style={{ fontSize: 13, color: 'var(--accent)', lineHeight: 1.7 }}>{scenario.best_strategy}</div>
              </div>
            )}
            {scenario.danger_signals?.length > 0 && (
              <div style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 4 }}>⚠️ 危險訊號</div>
                {scenario.danger_signals.map((s, i) => (
                  <div key={i} style={{ fontSize: 12, color: 'var(--orange)', padding: '3px 0' }}>· {s}</div>
                ))}
              </div>
            )}
            {scenario.forbidden_actions?.length > 0 && (
              <div>
                <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 4 }}>🚫 禁止操作</div>
                {scenario.forbidden_actions.map((s, i) => (
                  <div key={i} style={{ fontSize: 12, color: 'var(--red)', padding: '3px 0' }}>· {s}</div>
                ))}
              </div>
            )}
          </Card>
        )}

        {/* Risk */}
        {risk && (
          <Card title="風險評估" accent={RISK_COLOR[riskLevel] || 'var(--muted)'}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
              <div style={{ fontSize: 24, fontWeight: 700, color: RISK_COLOR[riskLevel] || 'var(--text)' }}>
                {RISK_LABEL[riskLevel] || riskLevel}
              </div>
              <div style={{ flex: 1, height: 8, background: 'var(--surface2)', borderRadius: 4, overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${(risk.score || 0) * 100}%`, background: RISK_COLOR[riskLevel] || 'var(--accent)', borderRadius: 4 }} />
              </div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--muted)' }}>{((risk.score || 0) * 100).toFixed(0)}%</div>
            </div>
            {risk.factors?.length > 0 && risk.factors.map((f, i) => (
              <div key={i} style={{ fontSize: 12, color: 'var(--muted)', padding: '2px 0' }}>· {f}</div>
            ))}
          </Card>
        )}

        {/* News sentiment */}
        {news_sentiment && (
          <Card title="新聞情緒">
            <div style={{ display: 'flex', gap: 16, marginBottom: 8 }}>
              <div style={{ textAlign: 'center', flex: 1 }}>
                <div style={{ fontSize: 10, color: 'var(--muted)' }}>利多新聞</div>
                <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--green)', fontFamily: 'var(--font-mono)' }}>{news_sentiment.bullish_count}</div>
              </div>
              <div style={{ textAlign: 'center', flex: 1 }}>
                <div style={{ fontSize: 10, color: 'var(--muted)' }}>利空新聞</div>
                <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--red)', fontFamily: 'var(--font-mono)' }}>{news_sentiment.bearish_count}</div>
              </div>
              <div style={{ textAlign: 'center', flex: 1 }}>
                <div style={{ fontSize: 10, color: 'var(--muted)' }}>市場影響</div>
                <div style={{ fontSize: 22, fontWeight: 700, fontFamily: 'var(--font-mono)', color: news_sentiment.market_impact > 0 ? 'var(--green)' : news_sentiment.market_impact < 0 ? 'var(--red)' : 'var(--muted)' }}>
                  {news_sentiment.market_impact > 0 ? '+' : ''}{news_sentiment.market_impact?.toFixed(2)}
                </div>
              </div>
            </div>
            {news_sentiment.key_events?.length > 0 && (
              <div style={{ marginTop: 6 }}>
                {news_sentiment.key_events.slice(0, 5).map((e, i) => (
                  <div key={i} style={{ fontSize: 12, color: 'var(--text)', padding: '3px 0', borderBottom: '1px solid var(--border)' }}>· {e}</div>
                ))}
              </div>
            )}
          </Card>
        )}
      </div>
    </div>
  )
}
