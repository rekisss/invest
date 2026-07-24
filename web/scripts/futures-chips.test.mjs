import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseFuturesInstitutional, fetchFuturesChips, parseFuturesDaily, computeBasis } from './futures-chips.mjs'

// Realistic FinMind TaiwanFuturesInstitutionalInvestors shape (long/short OI balance).
const mkRow = (date, inst, longOI, shortOI) => ({
  date,
  institutional_investors: inst,
  futures_id: 'TX',
  long_open_interest_balance_volume: longOI,
  short_open_interest_balance_volume: shortOI,
})

test('parse: computes latest-date net OI per institution (long − short)', () => {
  const rows = [
    mkRow('2026-07-22', '外資', 30000, 95000),
    mkRow('2026-07-22', '投信', 12000, 3000),
    mkRow('2026-07-22', '自營商', 8000, 9000),
    mkRow('2026-07-23', '外資', 32000, 100337),
    mkRow('2026-07-23', '投信', 13000, 2000),
    mkRow('2026-07-23', '自營商', 7000, 9500),
  ]
  const out = parseFuturesInstitutional(rows)
  assert.equal(out.as_of, '2026-07-23')
  const f = out.institutions.find(i => i.key === 'foreign')
  assert.equal(f.net, 32000 - 100337) // −68337 外資淨空
  assert.equal(f.long, 32000)
  assert.equal(f.short, 100337)
  assert.equal(out.institutions.find(i => i.key === 'trust').net, 11000)
  assert.equal(out.institutions.find(i => i.key === 'dealer').net, -2500)
  assert.equal(out.total_net, -68337 + 11000 - 2500)
})

test('parse: foreign net history is date-sorted ascending', () => {
  const rows = [
    mkRow('2026-07-23', '外資', 32000, 100000),
    mkRow('2026-07-21', '外資', 30000, 90000),
    mkRow('2026-07-22', '外資', 31000, 95000),
  ]
  const out = parseFuturesInstitutional(rows)
  assert.deepEqual(out.history.map(h => h.date), ['2026-07-21', '2026-07-22', '2026-07-23'])
  assert.equal(out.history[0].foreign_net, -60000)
  assert.equal(out.history[2].foreign_net, -68000)
})

test('parse: tolerates FinMind column-name drift (net column fallback)', () => {
  const rows = [
    { date: '2026-07-23', identity_type: '外資', net_open_interest: -68337 },
    { date: '2026-07-23', identity_type: '投信', net_open_interest: 11000 },
  ]
  const out = parseFuturesInstitutional(rows)
  assert.equal(out.institutions.find(i => i.key === 'foreign').net, -68337)
  assert.equal(out.institutions.find(i => i.key === 'trust').net, 11000)
})

test('parse: handles comma-formatted numbers and English institution labels', () => {
  const rows = [
    { date: '2026-07-23', name: 'Foreign Investor', long_open_interest_balance_volume: '32,000', short_open_interest_balance_volume: '100,337' },
  ]
  const out = parseFuturesInstitutional(rows)
  assert.equal(out.institutions.find(i => i.key === 'foreign').net, -68337)
})

test('parse: returns null on empty / unusable input', () => {
  assert.equal(parseFuturesInstitutional([]), null)
  assert.equal(parseFuturesInstitutional(null), null)
  assert.equal(parseFuturesInstitutional([{ date: '2026-07-23', foo: 1 }]), null) // no id column
})

test('fetch: returns null without token or fetchUrl (guarded)', async () => {
  assert.equal(await fetchFuturesChips({ token: '', fetchUrl: () => '{}' }), null)
  assert.equal(await fetchFuturesChips({ token: 't', fetchUrl: null }), null)
})

test('fetch: returns null on network/parse failure, never throws', async () => {
  const boom = async () => { throw new Error('network down') }
  assert.equal(await fetchFuturesChips({ token: 't', fetchUrl: boom }), null)
  const badJson = async () => 'Host not in allowlist'
  assert.equal(await fetchFuturesChips({ token: 't', fetchUrl: badJson }), null)
})

test('fetch: parses a successful FinMind response via injected fetchUrl', async () => {
  const stub = async () => JSON.stringify({
    status: 200,
    data: [mkRow('2026-07-23', '外資', 32000, 100337)],
  })
  const out = await fetchFuturesChips({ token: 't', fetchUrl: stub })
  assert.equal(out.institutions.find(i => i.key === 'foreign').net, -68337)
})

// ── parseFuturesDaily ────────────────────────────────────────────────────────
const mkDaily = (date, close, volume, extra = {}) => ({
  date, contract_date: '202607', close, volume, open_interest: 70000, ...extra,
})

test('daily: picks latest-date front month (highest volume)', () => {
  const rows = [
    mkDaily('2026-07-22', 22800, 50000),
    mkDaily('2026-07-23', 23010, 120000),           // 近月(量最大)
    { ...mkDaily('2026-07-23', 22500, 8000), contract_date: '202609' }, // 次月(量小)
  ]
  const out = parseFuturesDaily(rows)
  assert.equal(out.as_of, '2026-07-23')
  assert.equal(out.close, 23010)
  assert.equal(out.open_interest, 70000)
})

test('daily: excludes night/after-hours session rows', () => {
  const rows = [
    { ...mkDaily('2026-07-23', 23010, 120000), trading_session: 'position' },   // 日盤
    { ...mkDaily('2026-07-23', 23120, 200000), trading_session: 'after_market' }, // 夜盤(量更大但要排除)
  ]
  const out = parseFuturesDaily(rows)
  assert.equal(out.close, 23010) // 取日盤,不因夜盤量大而選到它
})

test('daily: returns null when no close column / empty', () => {
  assert.equal(parseFuturesDaily([]), null)
  assert.equal(parseFuturesDaily([{ date: '2026-07-23', foo: 1 }]), null)
})

// ── computeBasis ─────────────────────────────────────────────────────────────
test('basis: 正價差 when futures > spot', () => {
  const b = computeBasis(23010, 22950)
  assert.equal(b.basis, 60)
  assert.equal(b.kind, '正價差')
  assert.equal(b.basis_pct, round2(60 / 22950 * 100))
})

test('basis: 逆價差 when futures < spot', () => {
  const b = computeBasis(22900, 22950)
  assert.equal(b.basis, -50)
  assert.equal(b.kind, '逆價差')
})

test('basis: null on missing input', () => {
  assert.equal(computeBasis(null, 22950), null)
  assert.equal(computeBasis(23010, null), null)
  assert.equal(computeBasis(23010, 0), null)
})

// small local rounding helper mirroring the module's
function round2(v) { return Math.round(v * 100) / 100 }

test('fetch: attaches daily close via injected fetchUrl (two datasets)', async () => {
  const stub = async (url) => {
    if (url.includes('TaiwanFuturesInstitutionalInvestors')) {
      return JSON.stringify({ status: 200, data: [
        { date: '2026-07-23', institutional_investors: '外資', long_open_interest_balance_volume: 32000, short_open_interest_balance_volume: 100337 },
      ] })
    }
    if (url.includes('TaiwanFuturesDaily')) {
      return JSON.stringify({ status: 200, data: [mkDaily('2026-07-23', 23010, 120000)] })
    }
    return '{}'
  }
  const out = await fetchFuturesChips({ token: 't', fetchUrl: stub })
  assert.equal(out.institutions.find(i => i.key === 'foreign').net, -68337)
  assert.equal(out.daily.close, 23010)
})

test('fetch: daily failure does not sink the institutional result', async () => {
  const stub = async (url) => {
    if (url.includes('TaiwanFuturesInstitutionalInvestors')) {
      return JSON.stringify({ status: 200, data: [
        { date: '2026-07-23', name: '外資', net_open_interest: -68337 },
      ] })
    }
    throw new Error('daily endpoint down')
  }
  const out = await fetchFuturesChips({ token: 't', fetchUrl: stub })
  assert.equal(out.institutions.find(i => i.key === 'foreign').net, -68337)
  assert.equal(out.daily, undefined) // 沒有 daily 但主結果仍在
})
