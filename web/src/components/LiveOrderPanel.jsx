// 紙上指令面板 — 以現價重跑進出場規則後,該下什麼單。
//
// 邏輯全在 utils/liveOrders.js(純函式、有單元測試),這裡只負責呈現。
// 明確定位:這是建議清單,不是委託。專案硬規則 —— 不自動下單、不接下單 API。

const UP = 'var(--ios-red)'      // 台股慣例:紅漲綠跌
const DOWN = 'var(--ios-green)'
const pctStr = (v, d = 2) => v == null || isNaN(v) ? '—' : `${v >= 0 ? '+' : ''}${Number(v).toFixed(d)}%`
const colorOf = (v) => v == null ? 'var(--ios-label3)' : v >= 0 ? UP : DOWN

const EXIT_LABEL = {
  take_profit: { t: '觸及停利', c: UP, icon: '🎯' },
  stop: { t: '跌破停損', c: DOWN, icon: '🛑' },
  time: { t: '持有到期', c: 'var(--ios-orange)', icon: '⏱' },
}

function OrderRow({ o }) {
  const isSell = o.action === 'sell'
  const meta = isSell ? EXIT_LABEL[o.reason] : { t: '突破買點', c: UP, icon: '🚀' }
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10, padding: '9px 11px',
      background: 'var(--ios-fill4)', borderRadius: 10,
      opacity: o.blocked ? 0.62 : 1,
    }}>
      <span style={{ fontSize: 15 }}>{meta?.icon}</span>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--ios-label)' }}>
          <span style={{ color: isSell ? DOWN : UP }}>{isSell ? '賣出' : '買進'}</span>
          {' '}{o.stock_id} {o.name}
        </div>
        <div style={{ fontSize: 10, color: 'var(--ios-label3)', marginTop: 1 }}>
          {meta?.t}
          {o.trigger != null && <>（觸發價 {o.trigger}）</>}
          {isSell && o.hold_days != null && <>・持有 {o.hold_days} 日</>}
          {!isSell && o.reward_risk != null && <>・賺賠比 {o.reward_risk}</>}
          {o.blocked === 'no_slot' && <span style={{ color: 'var(--ios-orange)' }}>・持股已滿,需先出場</span>}
        </div>
      </div>
      <div style={{ textAlign: 'right', flexShrink: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 700, fontFamily: 'var(--font-mono)', color: 'var(--ios-label)' }}>{o.price}</div>
        {isSell
          ? <div style={{ fontSize: 10, fontFamily: 'var(--font-mono)', color: colorOf(o.ret_pct) }}>{pctStr(o.ret_pct)}</div>
          : o.expectancy_pct != null && <div style={{ fontSize: 10, fontFamily: 'var(--font-mono)', color: colorOf(o.expectancy_pct) }}>期望 {pctStr(o.expectancy_pct)}</div>}
      </div>
    </div>
  )
}

export default function LiveOrderPanel({ orders, watchFive, priceOf }) {
  if (!orders) return null
  const { exits = [], entries = [], rules, stale, priced, total } = orders
  const has = exits.length > 0 || entries.length > 0

  return (
    <div style={{ background: 'var(--ios-bg2)', borderRadius: 18, padding: '14px 14px 12px', marginBottom: 12, boxShadow: 'var(--shadow-card)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
        <span style={{ fontSize: 14 }}>📋</span>
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--ios-label)' }}>現價紙上指令</span>
        <span style={{ marginLeft: 'auto', fontSize: 9.5, color: 'var(--ios-label4)', fontFamily: 'var(--font-mono)' }}>
          停利 {rules?.takeProfitPct ?? '—'}% / 停損 {rules?.stopLossPct ?? '—'}%
        </span>
      </div>
      <div style={{ fontSize: 10, color: 'var(--ios-label3)', lineHeight: 1.6, marginBottom: 10 }}>
        拿當下的即時價,套用與夜間重播<b>完全相同</b>的進出場規則,列出「照規則現在該做什麼」。
        <b style={{ color: 'var(--ios-orange)' }}>這是建議不是委託</b> —— 系統不會、也不能自動下單,執行與否由你決定。
      </div>

      {stale && (
        <div style={{ fontSize: 10, color: 'var(--ios-orange)', background: 'rgba(255,159,10,0.12)', borderRadius: 8, padding: '6px 9px', marginBottom: 8 }}>
          ⚠️ 只取得 {priced}/{total} 檔的現價,這張清單可能漏掉該出場的部位。盤中請確認報價來源是否正常。
        </div>
      )}

      {!has && (
        <div style={{ fontSize: 11.5, color: 'var(--ios-label3)', padding: '10px 2px', lineHeight: 1.7 }}>
          目前沒有任何規則被觸發 —— 持倉未觸及停利/停損,盯盤前五檔也還沒突破買點。
          <div style={{ fontSize: 10, color: 'var(--ios-label4)', marginTop: 3 }}>沒有指令是常態,不是故障。</div>
        </div>
      )}

      {exits.length > 0 && (
        <>
          <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--ios-label3)', margin: '6px 0 5px' }}>
            出場指令（{exits.length}）
          </div>
          <div style={{ display: 'grid', gap: 6 }}>
            {exits.map(o => <OrderRow key={`x${o.stock_id}`} o={o} />)}
          </div>
        </>
      )}

      {entries.length > 0 && (
        <>
          <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--ios-label3)', margin: '10px 0 5px' }}>
            進場指令（{entries.length}）・剩餘空位 {orders.open_slots}
          </div>
          <div style={{ display: 'grid', gap: 6 }}>
            {entries.map(o => <OrderRow key={`e${o.stock_id}`} o={o} />)}
          </div>
        </>
      )}

      {/* 盯盤前五檔的現況:即使沒觸發也看得到距離買點還有多遠 */}
      {watchFive?.items?.length > 0 && (
        <>
          <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--ios-label3)', margin: '12px 0 5px' }}>
            盯盤前五檔・依期望報酬排序
            <span style={{ fontWeight: 500, color: 'var(--ios-label4)', marginLeft: 6 }}>
              {watchFive.basis === 'expectancy' ? '期望值 = 勝率×上檔 − 敗率×下檔' : '資料不足,暫用選股分數排序'}
            </span>
          </div>
          <div style={{ display: 'grid', gap: 4 }}>
            {watchFive.items.map(w => {
              const live = priceOf ? priceOf(w.stock_id) : null
              const px = live ?? w.close
              const toBo = (w.breakout_price && px) ? (w.breakout_price / px - 1) * 100 : null
              return (
                <div key={w.stock_id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, padding: '5px 9px', background: 'var(--ios-fill4)', borderRadius: 8 }}>
                  <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--ios-label4)', fontSize: 9.5, width: 12 }}>{w.rank}</span>
                  <span style={{ fontWeight: 600, color: 'var(--ios-label)', minWidth: 0, flex: 1 }}>
                    {w.stock_id} {w.name}
                    {live != null && <span style={{ color: '#66D4CF', marginLeft: 4, fontSize: 9 }}>⚡</span>}
                  </span>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: colorOf(w.expectancy_pct) }}>
                    {w.expectancy_pct == null ? '—' : `期望 ${pctStr(w.expectancy_pct)}`}
                  </span>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--ios-label3)', width: 78, textAlign: 'right' }}>
                    {toBo == null ? '—' : (toBo <= 0 ? '已突破' : `距買點 ${toBo.toFixed(1)}%`)}
                  </span>
                </div>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}
