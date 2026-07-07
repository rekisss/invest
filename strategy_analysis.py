#!/usr/bin/env python3
"""Strategy diagnostic analysis (read-only, stdlib-only, no network).

Standalone tool — imports nothing from the scanning pipeline and modifies no
strategy code. It measures, from the daily scan CSVs (output/full_scan) and the
local k-line cache (output/kline_cache.json), two things that matter for the
real pick win rate:

  1. FACTOR EFFICACY — each factor's cross-sectional rank-IC and each boolean
     signal's win-rate lift over 1/5/10-day forward returns. Ranking stocks
     within each day removes the market's daily move, isolating what each
     factor actually predicts.

  2. EXIT-RULE BACKTEST — for the top-decile picks (by entry_score), simulates
     stop / take-profit / trailing / time exits over the forward bars and
     reports win rate AND average return (a take-profit inflates win rate while
     capping upside, so win rate alone is misleading). A time-based train/test
     split guards against fitting one regime.

Usage:  python3 strategy_analysis.py [--since YYYY-MM-DD] [--json out.json]

Interpretation is intentionally left to the reader: small samples / single
regimes make any single number noisy. Re-run as the outcome history grows.
"""
import argparse, csv, glob, json, math, os, re
from collections import defaultdict

REPO = os.path.dirname(os.path.abspath(__file__))
HORIZONS = [1, 5, 10]

SOFT_COLS = ['foreign_buy_3d', 'invest_trust_buy_2d', 'dealer_buy_3d', 'hist_turn_positive',
             'kd_golden_cross', 'obv_uptrend', 'adx_trending', 'stronger_than_market',
             'bb_squeeze_breakout', 'breakout_volume_confirm', 'williams_r_recovery',
             'cci_momentum', 'mfi_strong', 'above_ichimoku_cloud', 'ma5_above_ma10']
BOOL_FACTORS = SOFT_COLS + ['macd_golden_cross', 'volume_break', 'rsi_strong',
                            'breakout_20d', 'above_ema60', 'ema60_gt_ema120']
CONT_FACTORS = ['entry_score', 'condition_count', 'momentum_score', 'rsi14', 'adx14', 'atr14',
                'macd_hist', 'bb_pct_b', 'bb_bandwidth', 'stoch_k', 'mfi14', 'cci20', 'williams_r',
                'relative_strength_5d', 'return_5d', 'day_return', 'lr_slope_20', 'lr_slope_60',
                'volume_ratio', 'f_score', 'foreign_net', 'invest_trust_net', 'dealer_net',
                'foreign_buy_streak', 'invest_trust_streak', 'dealer_buy_streak']


def to_f(x):
    try:
        v = float(x)
        return v if math.isfinite(v) else None
    except Exception:
        return None


def to_b(x):
    s = str(x).strip().lower()
    if s in ('true', '1', '1.0'):
        return True
    if s in ('false', '0', '0.0', ''):
        return False
    return None


def load_kline():
    kl = json.load(open(f'{REPO}/output/kline_cache.json'))
    out = {}
    for sid, obj in kl.items():
        bars = obj.get('1d') if isinstance(obj, dict) else None
        if not bars:
            continue
        bars = [b for b in bars if b.get('close') not in (None, 0)]
        bars.sort(key=lambda b: b['time'])
        out[str(sid)] = (bars, {b['time']: i for i, b in enumerate(bars)})
    return out


def load_scans(since):
    by_date = defaultdict(dict)
    for fp in glob.glob(f'{REPO}/output/full_scan/batch_seq*_*.csv'):
        m = re.search(r'_(\d{4}-\d{2}-\d{2})\.csv$', fp)
        if not m:
            continue
        date = m.group(1)
        if date < since:
            continue
        try:
            for row in csv.DictReader(open(fp, encoding='utf-8-sig')):
                if row.get('date') != date:      # drop stale/halted residue rows
                    continue
                sid = row.get('stock_id')
                if sid and sid not in by_date[date]:
                    by_date[date][sid] = row
        except Exception as e:
            print(f'  skip {fp}: {e}')
    return by_date


def fwd_ret(KL, sid, date, h):
    rec = KL.get(str(sid))
    if not rec:
        return None
    bars, idx = rec
    i = idx.get(date)
    if i is None or i + h >= len(bars):
        return None
    c0, c1 = bars[i]['close'], bars[i + h]['close']
    if not c0 or c0 <= 0 or not c1 or c1 <= 0:
        return None
    return (c1 - c0) / c0


# ── Spearman helpers ────────────────────────────────────────────────────────
def _ranks(vals):
    order = sorted(range(len(vals)), key=lambda i: vals[i])
    r = [0.0] * len(vals)
    i = 0
    while i < len(order):
        j = i
        while j + 1 < len(order) and vals[order[j + 1]] == vals[order[i]]:
            j += 1
        avg = (i + j) / 2.0 + 1.0
        for k in range(i, j + 1):
            r[order[k]] = avg
        i = j + 1
    return r


def _pearson(a, b):
    n = len(a)
    if n < 3:
        return None
    ma, mb = sum(a) / n, sum(b) / n
    num = sum((a[i] - ma) * (b[i] - mb) for i in range(n))
    da = math.sqrt(sum((a[i] - ma) ** 2 for i in range(n)))
    db = math.sqrt(sum((b[i] - mb) ** 2 for i in range(n)))
    return num / (da * db) if da and db else None


def _spearman(x, y):
    return _pearson(_ranks(x), _ranks(y)) if len(x) >= 5 else None


def factor_efficacy(by_date, KL, dates):
    out = {}
    for h in HORIZONS:
        cont_ics = defaultdict(list)
        bool_lift = defaultdict(list)
        for date in dates:
            rows = by_date[date]
            rets = {s: fwd_ret(KL, s, date, h) for s in rows}
            rets = {s: r for s, r in rets.items() if r is not None}
            if len(rets) < 10:
                continue
            sids = list(rets)
            for f in CONT_FACTORS:
                xs, ys = [], []
                for s in sids:
                    v = to_f(rows[s].get(f))
                    if v is not None:
                        xs.append(v); ys.append(rets[s])
                ic = _spearman(xs, ys)
                if ic is not None:
                    cont_ics[f].append(ic)
            for f in BOOL_FACTORS:
                ut = tt = uf = tf = 0
                for s in sids:
                    b = to_b(rows[s].get(f))
                    if b is None:
                        continue
                    if b:
                        tt += 1; ut += rets[s] > 0
                    else:
                        tf += 1; uf += rets[s] > 0
                if tt >= 3 and tf >= 3:
                    bool_lift[f].append(ut / tt - uf / tf)

        def summ(ics):
            ics = [v for v in ics if v is not None]
            if len(ics) < 3:
                return None
            m = sum(ics) / len(ics)
            sd = math.sqrt(sum((v - m) ** 2 for v in ics) / (len(ics) - 1))
            t = m / (sd / math.sqrt(len(ics))) if sd else 0
            return {'ic': round(m, 4), 't': round(t, 2), 'days': len(ics)}

        out[h] = {
            'continuous': {f: summ(v) for f, v in cont_ics.items() if summ(v)},
            'boolean': {f: {'winrate_lift_pct': round(sum(v) / len(v) * 100, 2), 'days': len(v)}
                        for f, v in bool_lift.items() if v},
        }
    return out


# ── Exit-rule backtest ──────────────────────────────────────────────────────
def top_picks(by_date, KL, date, topfrac):
    rows = [(s, to_f(r.get('entry_score'))) for s, r in by_date[date].items()]
    rows = [(s, sc) for s, sc in rows if sc is not None]
    rows.sort(key=lambda t: t[1], reverse=True)
    k = max(1, math.ceil(len(rows) * topfrac))
    out = []
    for s, _ in rows[:k]:
        rec = KL.get(str(s))
        if not rec:
            continue
        bars, idx = rec
        i = idx.get(date)
        if i is None or i + 1 >= len(bars):
            continue
        out.append((s, i, bars[i]['close']))
    return out


def sim_exit(by_date, KL, day_list, topfrac, maxhold, stop=None, take=None, trail=None):
    rets = []
    for date in day_list:
        for s, i, entry in top_picks(by_date, KL, date, topfrac):
            if entry <= 0:
                continue
            bars = KL[str(s)][0]
            peak = entry
            ret = None
            last = min(i + maxhold, len(bars) - 1)
            for j in range(i + 1, last + 1):
                b = bars[j]
                cl = b['close']
                hi = b.get('high') or cl
                lo = b.get('low') or cl
                if stop is not None and lo <= entry * (1 - stop):
                    ret = -stop; break
                if trail is not None:
                    peak = max(peak, hi)
                    if lo <= peak * (1 - trail):
                        ret = peak * (1 - trail) / entry - 1; break
                if take is not None and hi >= entry * (1 + take):
                    ret = take; break
                if j == last:
                    ret = cl / entry - 1
            if ret is not None:
                rets.append(ret)
    if not rets:
        return None
    n = len(rets)
    return {'win_rate_pct': round(sum(r > 0 for r in rets) / n * 100, 1),
            'avg_return_pct': round(sum(rets) / n * 100, 2), 'n': n}


EXIT_RULES = [
    ('hold Nd (baseline)', {}),
    ('take +8%', {'take': 0.08}),
    ('take +10%', {'take': 0.10}),
    ('stop -8%', {'stop': 0.08}),
    ('stop -8% + take +10%', {'stop': 0.08, 'take': 0.10}),
    ('trail -8%', {'trail': 0.08}),
]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--since', default='2026-05-01')
    ap.add_argument('--topfrac', type=float, default=0.10)
    ap.add_argument('--maxhold', type=int, default=10)
    ap.add_argument('--json', default='')
    args = ap.parse_args()

    print('loading k-line + scans...')
    KL = load_kline()
    by_date = load_scans(args.since)
    dates = sorted(by_date)
    if not dates:
        print('no scan data found under output/full_scan — nothing to analyze')
        return
    print(f'  {len(KL)} kline stocks, {len(dates)} scan days ({dates[0]}..{dates[-1]})')

    fe = factor_efficacy(by_date, KL, dates)
    for h in HORIZONS:
        print(f'\n===== FACTOR EFFICACY d{h} =====')
        cont = sorted(fe[h]['continuous'].items(), key=lambda x: x[1]['ic'], reverse=True)
        print('  continuous rank-IC (higher = better predictor):')
        for f, d in cont:
            print(f'    {f:22} IC={d["ic"]:+.4f}  t={d["t"]:+.2f}  days={d["days"]}')
        bl = sorted(fe[h]['boolean'].items(), key=lambda x: x[1]['winrate_lift_pct'], reverse=True)
        print('  boolean win-rate lift  P(up|on)-P(up|off), %pts:')
        for f, d in bl:
            print(f'    {f:22} {d["winrate_lift_pct"]:+6.2f}  days={d["days"]}')

    usable = [d for d in dates if any(fwd_ret(KL, s, d, 5) is not None for s in by_date[d])]
    split = int(len(usable) * 0.55)
    train, test = usable[:split], usable[split:]
    exit_report = {}
    for name, dl in [('TRAIN', train), ('TEST', test)]:
        print(f'\n===== EXIT-RULE BACKTEST · {name} ({len(dl)} days, top {int(args.topfrac*100)}%, hold {args.maxhold}d) =====')
        exit_report[name] = {}
        for label, kw in EXIT_RULES:
            r = sim_exit(by_date, KL, dl, args.topfrac, args.maxhold, **kw)
            exit_report[name][label] = r
            if r:
                print(f'    {label:26} win_rate={r["win_rate_pct"]:>5}%  avg_return={r["avg_return_pct"]:>6}%  n={r["n"]}')

    if args.json:
        json.dump({'factor_efficacy': fe, 'exit_rules': exit_report}, open(args.json, 'w'), indent=1)
        print(f'\nsaved -> {args.json}')


if __name__ == '__main__':
    main()
