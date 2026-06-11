from __future__ import annotations

import os
from typing import Any


def generate_daily_picks(
    top_stocks: list[dict[str, Any]],
    market_data: dict[str, Any] | None = None,
    max_stocks: int = 20,
) -> str:
    """Call Claude Haiku to generate a daily market insight + top-3 stock picks.

    Returns formatted Traditional Chinese text, or "" on failure/missing key.
    """
    api_key = os.getenv("ANTHROPIC_API_KEY", "").strip()
    if not api_key:
        return ""

    try:
        import anthropic
    except ImportError:
        print("[Claude] anthropic 套件未安裝，略過 AI 解讀")
        return ""

    md = market_data or {}
    market_text = ""
    if md:
        market_text = (
            f"上漲機率 {md.get('xgb_prob_up', 0.5):.0%} | "
            f"外資期貨 {md.get('futures_net', 0):+,.0f}口 | "
            f"VIX {md.get('vix', 20):.1f} | "
            f"夜盤 {md.get('night_change', 0):+.0f}點 | "
            f"廣度 {md.get('breadth_ratio', 0.5):.0%}"
        )

    stocks_text = "\n".join(
        f"{i+1:2d}. {s.get('stock_id','')} {s.get('name','')}  "
        f"分數{float(s.get('entry_score') or 0):.0f}  "
        f"RSI{float(s.get('rsi14') or 0):.0f}  "
        f"ADX{float(s.get('adx14') or 0):.0f}  "
        f"外資連買{int(s.get('foreign_buy_streak') or 0)}日  "
        f"F-Score{int(s.get('f_score') or -1)}"
        for i, s in enumerate(top_stocks[:max_stocks])
    )

    market_section = f"\n市場資料：{market_text}\n" if market_text else ""
    prompt = (
        "你是台股交易助手，請根據以下候選股清單，用繁體中文輸出兩個區塊：\n\n"
        "【今日操盤重點】2-3條（以「・」開頭，聚焦風險或機會，不要重複數字）\n\n"
        "【AI 精選 3 支】從清單中選出訊號最具說服力的 3 支，"
        "格式：「股號 名稱 — 一句理由 + 注意事項」\n"
        f"{market_section}"
        f"\n候選清單：\n{stocks_text}"
    )

    try:
        client = anthropic.Anthropic(api_key=api_key)
        msg = client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=350,
            messages=[{"role": "user", "content": prompt}],
        )
        return msg.content[0].text.strip()
    except Exception as exc:
        print(f"[Claude] AI 解讀生成失敗（graceful skip）: {exc}")
        return ""


def generate_premarket_insight(
    market_data: dict[str, Any],
    taiex_tech: dict[str, Any] | None = None,
) -> str:
    """Call Claude Haiku to generate 3-bullet pre-market trading points.

    Reads PREMARKET_AI_KEY env variable (set separately from aggregate's ANTHROPIC_API_KEY
    so each can be enabled/disabled independently in GitHub Actions).

    market_data keys: xgb_prob_up, futures_net, vix, night_change, night_trend,
                      cash_norm, pcr, nasdaq_ret, sox_ret, tsm_adr_ret
    taiex_tech keys:  rsi14, macd_hist, dist_ma60

    Returns Traditional Chinese bullet points, or "" on failure/missing key.
    """
    api_key = os.getenv("PREMARKET_AI_KEY", "").strip()
    if not api_key:
        return ""

    try:
        import anthropic
    except ImportError:
        return ""

    md = market_data or {}
    tech = taiex_tech or {}

    def _fmt(v: Any, fmt: str = ".1f", suffix: str = "") -> str:
        try:
            return f"{float(v):{fmt}}{suffix}" if v is not None else "-"
        except (TypeError, ValueError):
            return "-"

    prob_up = md.get("xgb_prob_up", 0.5)
    lines_ctx = [
        f"AI上漲機率 {prob_up:.0%}",
        f"外資期貨 {_fmt(md.get('futures_net'), '+,.0f', '口')}",
        f"VIX {_fmt(md.get('vix'), '.1f')}",
        f"夜盤 {_fmt(md.get('night_change'), '+.0f', '點')} {md.get('night_trend', '')}".strip(),
        f"外資現貨 {_fmt(md.get('cash_norm'), '+.0%')} | PCR {_fmt(md.get('pcr'), '.2f')}",
        f"NQ {_fmt(md.get('nasdaq_ret'), '+.1%')} | SOX {_fmt(md.get('sox_ret'), '+.1%')} | TSM {_fmt(md.get('tsm_adr_ret'), '+.1%')}",
    ]
    if md.get("market_revenue_yoy") is not None:
        lines_ctx.append(f"市場月營收YoY {_fmt(md.get('market_revenue_yoy'), '+.1%')}")
    if md.get("market_foreign_holding_chg") is not None:
        lines_ctx.append(f"外資持股5日變化 {_fmt(md.get('market_foreign_holding_chg'), '+.2f', '%')}")
    if md.get("buyback_count", 0) > 0:
        lines_ctx.append(f"庫藏股買回中 {md['buyback_count']} 支")
    if md.get("disposition_count", 0) > 0:
        lines_ctx.append(f"⚠️處置股 {md['disposition_count']} 支（風險警示）")
    if md.get("jpy_ret") is not None:
        lines_ctx.append(f"日圓 {_fmt(md.get('jpy_ret'), '+.1%')}（升值=亞洲避險）")
    if md.get("arkk_ret") is not None:
        lines_ctx.append(f"ARKK {_fmt(md.get('arkk_ret'), '+.1%')}（科技情緒）")
    if tech:
        lines_ctx.append(
            f"加權RSI {_fmt(tech.get('rsi14'), '.0f')} | "
            f"MACD直方 {_fmt(tech.get('macd_hist'), '+.1f')} | "
            f"距MA60 {_fmt(tech.get('dist_ma60'), '+.1f', '%')}"
        )
        if tech.get("dist_ma20") is not None:
            lines_ctx.append(f"距MA20 {_fmt(tech.get('dist_ma20'), '+.1f', '%')}")

    context = "\n".join(lines_ctx)
    prompt = (
        "你是台股盤前分析師。根據以下資料，用繁體中文輸出「今日操盤要點」，"
        "恰好 3 條，每條以「・」開頭，一行內完成。\n"
        "要求：聚焦「今天要注意什麼、如何應對」，避免重複數字，語氣簡潔專業。\n\n"
        f"{context}"
    )

    try:
        client = anthropic.Anthropic(api_key=api_key)
        msg = client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=200,
            messages=[{"role": "user", "content": prompt}],
        )
        return msg.content[0].text.strip()
    except Exception as exc:
        print(f"[Claude] 盤前解讀生成失敗（graceful skip）: {exc}")
        return ""
