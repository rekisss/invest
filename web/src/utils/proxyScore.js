// 盤前預測的「掃描池代理」打分(純函式,前端與日報共用)。
//
// 2026-08 診斷:MarketPredictor(horizon=5) 預測的是「5 個交易日後」,但這個代理
// 命中率原本拿**單日**報酬打分——跟真實收盤打分犯的是同一個錯(見 outcome-fix.mjs)。
// 拿五天後的預報去對隔天結果,命中率結構上就不可能對。這裡改成用同一段期距的
// 累積報酬打分,並把門檻對齊模型訓練時的定義(漲跌逾 0.3% 才算有方向)。
//
// benchCurve:[{date, ret_pct}] 的**累積**報酬曲線(掃描池等權),日期升冪。

export const PROXY_HORIZON = 5
export const FLAT_BAND = 0.3      // 與訓練 target 的 0.3% 門檻一致
export const NEUTRAL_BAND = 0.05  // |prob-0.5| 在此範圍內視為模型沒有方向,不計分

// 2026-08 決定:代理計分改用「模型自己的定義」,與 outcome_tracker.py 的真實計分一致。
//
// 為什麼原本的三分法是錯的:MarketPredictor 只輸出**一個**數字
// prob_up = P(5 個交易日後漲逾 0.3%),訓練 target 就是這個二元事件。
// 「看多/偏多/中性/偏空/看空」只是把同一個 prob 切成五段的**顯示標籤**,
// 模型從來沒有預測過「會跌」,也沒有預測過「會走平」。因此:
//   · 把「偏空」判成「要跌逾 0.3% 才算命中」= 要求模型預測它沒被訓練去預測的事,
//     大盤走平時模型明明說對了(沒漲逾 0.3%)卻被記成失敗 → 低估
//   · 把「中性」判成「走平才算命中」= 幫模型認領它沒宣稱過的預測 → 無意義
//
// 正確的二元判定(與 outcome_tracker.score_horizon_hits 逐字對應):
//   命中 ⟺ (prob > 0.5) === (該期距報酬 > +0.3%)
// 中性帶(|prob-0.5| ≤ 0.05)不計分,與真實計分同一條規則。
//
// ⚠ 這個改動會讓顯示的代理命中率「上升」——那是定義修正,不是模型變準了。
// 偏空預測在盤整日從此算命中(它本來就說對了)。UI 需標明門檻定義。

// 單筆判定:期距內累積報酬 ret(%) 對上模型機率 prob 是否命中。
// 中性(無方向)與資料不足回 null,代表「不計分」而非「未命中」。
export function hitForProb(prob, ret) {
  if (ret == null || !Number.isFinite(ret)) return null
  if (typeof prob !== 'number' || !Number.isFinite(prob)) return null
  if (Math.abs(prob - 0.5) <= NEUTRAL_BAND) return null
  return (prob > 0.5) === (ret > FLAT_BAND)
}

// 標籤→機率的回退。歷史紀錄若只留下標籤沒留 prob,用該標籤的區間中點代表它,
// 才不會整筆被丟掉(區間定義見 market_predictor.py 的 label 判定)。
const LABEL_PROB = { '看多': 0.72, '偏多': 0.58, '中性': 0.50, '偏空': 0.42, '看空': 0.28 }
export function probForLabel(label) {
  return LABEL_PROB[label] ?? null
}

// 每筆預測「起算 N 個交易日」的實際結果:Map<date, {ret, dir, end_date}>。
// dir:1 漲 / -1 跌 / 0 走平(以 ±FLAT_BAND 判定)。期距未到期者不列入。
// 校準圖、誤差分析、機率走勢圖都應該用這個,而不是「隔天夜盤」——模型看的是 N 日後。
export function horizonOutcomeMap(history, benchCurve, opts = {}) {
  const horizon = opts.horizon ?? PROXY_HORIZON
  const curve = Array.isArray(benchCurve) ? benchCurve : []
  const out = new Map()
  if (curve.length < horizon + 1 || !Array.isArray(history)) return out

  const asc = [...curve]
    .filter(p => p && p.date && typeof p.ret_pct === 'number')
    .sort((a, b) => String(a.date).localeCompare(String(b.date)))
  const idxOf = new Map(asc.map((p, i) => [p.date, i]))

  for (const p of history) {
    if (!p || !p.date) continue
    const i = idxOf.get(p.date)
    if (i == null) continue
    const j = i + horizon
    if (j >= asc.length) continue            // 期距未到期,先不打分
    // 累積曲線相減 = 這段期間的報酬(小數量級下近似區間報酬)
    const ret = Math.round((asc[j].ret_pct - asc[i].ret_pct) * 100) / 100
    out.set(p.date, {
      ret,
      dir: ret > FLAT_BAND ? 1 : ret < -FLAT_BAND ? -1 : 0,
      end_date: asc[j].date,
    })
  }
  return out
}

// 對每筆預測算出「期距內累積報酬」與命中與否。
// 回傳 [{date, label, prob, ret, hit, end_date}],僅含期距已到期的預測(新到舊)。
export function scoreProxyPredictions(history, benchCurve, opts = {}) {
  const limit = opts.limit ?? 14
  if (!Array.isArray(history) || history.length === 0) return []
  const outcomes = horizonOutcomeMap(history, benchCurve, opts)

  const out = []
  for (const p of history) {
    if (!p || !p.date || !p.xgb_label) continue
    const o = outcomes.get(p.date)
    if (!o) continue
    out.push({
      date: p.date,
      label: p.xgb_label,
      prob: p.xgb_prob_up,
      ret: o.ret,
      hit: hitForProb(
        typeof p.xgb_prob_up === 'number' ? p.xgb_prob_up : probForLabel(p.xgb_label),
        o.ret,
      ),
      end_date: o.end_date,
    })
  }
  out.sort((a, b) => String(b.date).localeCompare(String(a.date)))
  return out.slice(0, limit)
}

// 便利函式:回傳 {hits, total, pct} 或 null。
export function summarizeProxy(rows) {
  const scored = (rows || []).filter(r => r.hit != null)
  if (!scored.length) return null
  const hits = scored.filter(r => r.hit).length
  return { hits, total: scored.length, pct: Math.round(hits / scored.length * 100) }
}
