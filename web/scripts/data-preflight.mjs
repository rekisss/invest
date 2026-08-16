// build 前置檢查:確認 public/data.json 真的存在且是這次 build 產生的。
//
// 背景:整個前端的資料都來自 build-data.mjs 產生的 public/data.json,而
// `vite build` 對它一無所知——檔案不存在照樣 build 成功,只是上線後儀表板
// 一片空白;檔案是舊的(例如 build-data 中途失敗、或本機殘留)也照樣打包,
// 上線後顯示的是過期資料而且不會有任何錯誤訊息。兩種都是「安靜的壞掉」。
//
// 這裡把它變成「大聲的壞掉」:缺檔直接讓 build 失敗並告訴你要先跑什麼,
// 過期則印警告(週末/連假本來就會有幾天沒新資料,不該擋 build)。

export const STALE_WARN_DAYS = 3

// 純函式,方便測試。回傳 { level: 'ok' | 'warn' | 'error', message }
//   exists      檔案是否存在
//   generatedAt data.json 的 generated_at 字串(可為 null/undefined)
//   now         現在時間(Date 或 ms)
//   sizeBytes   檔案大小
export function checkDataFile({ exists, generatedAt, now = Date.now(), sizeBytes = 0 } = {}) {
  if (!exists) {
    return {
      level: 'error',
      message: 'web/public/data.json 不存在——前端沒有任何資料可用。請先執行 `npm run data`(node scripts/build-data.mjs)再 build。',
    }
  }
  if (sizeBytes < 1024) {
    return {
      level: 'error',
      message: `web/public/data.json 只有 ${sizeBytes} bytes,顯然不是完整的資料檔(build-data 可能中途失敗)。請重跑 \`npm run data\`。`,
    }
  }
  const ts = generatedAt ? Date.parse(generatedAt) : NaN
  if (!Number.isFinite(ts)) {
    // 沒有 generated_at 就無從判斷新舊;不擋 build,只提醒。
    return { level: 'warn', message: 'data.json 沒有可解析的 generated_at,無法確認新舊。' }
  }
  const nowMs = now instanceof Date ? now.getTime() : now
  const ageDays = (nowMs - ts) / 86400000
  if (ageDays > STALE_WARN_DAYS) {
    return {
      level: 'warn',
      message: `data.json 產生於 ${generatedAt}(${ageDays.toFixed(1)} 天前)。若非連假,建議先跑 \`npm run data\` 取得最新資料。`,
    }
  }
  if (ageDays < -1) {
    return { level: 'warn', message: `data.json 的 generated_at (${generatedAt}) 在未來,時區或時鐘可能有問題。` }
  }
  return { level: 'ok', message: `data.json OK(${generatedAt}, ${(sizeBytes / 1e6).toFixed(1)} MB)` }
}

// CLI:被 npm run build 呼叫。error → exit 1,warn → 印出但放行。
if (import.meta.url === `file://${process.argv[1]}`) {
  const { existsSync, statSync, openSync, readSync, closeSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const { dirname, join } = await import('node:path')

  const here = dirname(fileURLToPath(import.meta.url))
  const file = join(here, '..', 'public', 'data.json')
  const exists = existsSync(file)
  let sizeBytes = 0
  let generatedAt = null
  if (exists) {
    sizeBytes = statSync(file).size
    // data.json 有 10~25 MB,只為了讀 generated_at 而全檔 JSON.parse 太浪費;
    // 該欄位是 build-data 寫在最前面的 key,讀開頭 4 KB 用字串比對就夠。
    const fd = openSync(file, 'r')
    try {
      const buf = Buffer.alloc(4096)
      const n = readSync(fd, buf, 0, 4096, 0)
      const m = buf.subarray(0, n).toString('utf8').match(/"generated_at"\s*:\s*"([^"]+)"/)
      if (m) generatedAt = m[1]
    } finally {
      closeSync(fd)
    }
  }

  const r = checkDataFile({ exists, generatedAt, sizeBytes })
  if (r.level === 'error') {
    console.error(`✗ build 前置檢查失敗:${r.message}`)
    process.exit(1)
  }
  console.log(r.level === 'warn' ? `⚠ ${r.message}` : `✓ ${r.message}`)
}
