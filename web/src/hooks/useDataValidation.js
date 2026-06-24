// Runtime data-quality validation.
// Reads build-time dataQuality from data.json and surfaces structured issues + severity.
// Used by ValidationPanel DataQualityBanner.

import { useMemo, useState, useEffect } from 'react'

// Taiwan market calendar: Mon-Fri, skip weekends.
// Holidays are NOT accounted for (no static list) — gaps that look like 1-day lags are OK.
function weekdaysBehind(latestDateStr, todayStr) {
  if (!latestDateStr || !todayStr) return null
  if (latestDateStr >= todayStr) return 0
  const d1 = new Date(latestDateStr + 'T00:00:00Z')
  const d2 = new Date(todayStr + 'T00:00:00Z')
  let count = 0, cur = new Date(d1)
  cur.setUTCDate(cur.getUTCDate() + 1)
  while (cur <= d2) {
    const dow = cur.getUTCDay()
    if (dow !== 0 && dow !== 6) count++
    cur.setUTCDate(cur.getUTCDate() + 1)
  }
  return count
}

export function useDataValidation(data) {
  const [runtimePriceIssues, setRuntimePriceIssues] = useState(null)

  // Runtime TWSE price cross-check for the latest scan's top stocks.
  // Only runs when market is closed and scan is from today (so TWSE has today's close).
  useEffect(() => {
    if (!data?.dataQuality?.is_fresh) return
    const todayTW = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date())
    const hourTW = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Taipei', hour: 'numeric', hour12: false }).format(new Date())
    const hour = parseInt(hourTW, 10)
    // Only cross-check after close (13:30) and before midnight (22:00) — TWSE data is available
    if (hour < 14 || hour >= 22) return

    const latestDate = data.dates?.[0]
    if (!latestDate || latestDate !== todayTW) return

    const topStocks = data.scans?.[latestDate]?.top_stocks || []
    const twseStocks = topStocks.filter(s => /^\d{4}$/.test(String(s.stock_id))).slice(0, 15)
    if (!twseStocks.length) return

    let cancelled = false
    fetch('https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL', {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    })
      .then(r => r.ok ? r.json() : null)
      .then(arr => {
        if (cancelled || !Array.isArray(arr)) return
        const priceMap = {}
        for (const row of arr) {
          const sid = (row.Code || row['證券代號'] || '').trim()
          const raw = (row.ClosingPrice || row['收盤價'] || '').replace(/,/g, '')
          const p = parseFloat(raw)
          if (sid && !isNaN(p) && p > 0) priceMap[sid] = p
        }
        const mismatches = []
        for (const s of twseStocks) {
          const twse = priceMap[String(s.stock_id)]
          if (!twse || !s.close) continue
          const diffPct = Math.abs(s.close - twse) / twse * 100
          if (diffPct > 2) mismatches.push({
            stock_id: s.stock_id,
            name: s.name,
            scan_close: s.close,
            twse_close: twse,
            diff_pct: Math.round(diffPct * 10) / 10,
          })
        }
        if (!cancelled) setRuntimePriceIssues(mismatches)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [data])

  return useMemo(() => {
    if (!data) return null
    const dq = data.dataQuality || {}
    const issues = []

    // 1. Date freshness
    const todayTW = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date())
    const daysBehind = dq.days_behind ?? weekdaysBehind(dq.latest_data_date, todayTW)
    if (daysBehind != null && daysBehind > 1) {
      const severity = daysBehind >= 3 ? 'error' : 'warning'
      issues.push({
        type: 'stale',
        severity,
        label: '資料過舊',
        detail: `落後 ${daysBehind} 個交易日（最後：${dq.latest_data_date}，今日：${todayTW}）`,
      })
    }

    // 2. Stock count
    const totalStocks = dq.total_stocks ?? 0
    if (totalStocks > 0 && totalStocks < 500) {
      issues.push({
        type: 'count',
        severity: totalStocks < 100 ? 'error' : 'warning',
        label: '掃描不完整',
        detail: `僅掃描 ${totalStocks} 支（預期 ≥ 500）`,
      })
    }

    // 3. Technical field validity
    if (dq.fields_ok === false && dq.top_valid_ratio != null) {
      issues.push({
        type: 'fields',
        severity: 'warning',
        label: '技術指標缺失',
        detail: `僅 ${dq.top_valid_ratio}% 股票有完整 RSI/ADX`,
      })
    }

    // 4. Institutional data
    if (dq.institutional_ok === false && dq.institutional_ratio != null) {
      issues.push({
        type: 'institutional',
        severity: 'warning',
        label: '法人資料不完整',
        detail: `${dq.institutional_ratio}% 股票有法人買賣紀錄（預期 ≥ 15%）`,
      })
    }

    // 5. Build-time price cross-validation
    const bv = dq.price_validation
    if (bv?.mismatches?.length > 0) {
      const worst = bv.mismatches[0]
      issues.push({
        type: 'price',
        severity: 'warning',
        label: '收盤價異常',
        detail: `${bv.mismatches.length} 支收盤價與 TWSE 差異 >2%（最大：${worst.stock_id} ${worst.name} 掃描${worst.scan_close} vs TWSE${worst.twse_close}，差 ${worst.diff_pct}%）`,
        mismatches: bv.mismatches,
      })
    }

    // 6. Runtime price cross-check (post-close TWSE live comparison)
    if (runtimePriceIssues?.length > 0) {
      const worst = runtimePriceIssues[0]
      issues.push({
        type: 'price_runtime',
        severity: 'warning',
        label: '即時價格核對異常',
        detail: `${runtimePriceIssues.length} 支與 TWSE 即時收盤價差異 >2%（${worst.stock_id} 掃描${worst.scan_close} vs TWSE${worst.twse_close}）`,
        mismatches: runtimePriceIssues,
      })
    }

    const hasError = issues.some(i => i.severity === 'error')
    return {
      status: hasError ? 'error' : issues.length > 0 ? 'warning' : 'ok',
      issues,
      daysBehind,
      latestDataDate: dq.latest_data_date,
      totalStocks,
      buildTime: data.generated_at,
      institutionalRatio: dq.institutional_ratio,
      priceValidation: bv,
    }
  }, [data, runtimePriceIssues])
}
