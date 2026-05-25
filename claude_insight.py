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
