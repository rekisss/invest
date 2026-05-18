"""
discord_bot.py – Interactive Discord bot for Taiwan stock AI analysis.

Commands:
  /top          – Today's top momentum stocks (from last scan or fresh fetch)
  /ai [stock]   – Single stock analysis with entry/stop/target
  /market       – Market regime + AI prediction + breadth
  /watch [stock] – Schedule end-of-day analysis pushes at 13:00/13:20/13:29

Deploy: Render / Railway / any VPS
  Set env vars: DISCORD_BOT_TOKEN, FUGLE_API_KEY, FINMIND_TOKEN, DISCORD_CHANNEL_ID
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path

import discord
from discord import app_commands
from discord.ext import tasks
import pandas as pd

# ── Logging ───────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
log = logging.getLogger("discord_bot")

# ── .env loader (local dev) ───────────────────────────────────────────────────
_env_path = Path(__file__).parent / ".env"
if _env_path.exists():
    for _line in _env_path.read_text(encoding="utf-8").splitlines():
        _line = _line.strip()
        if _line and not _line.startswith("#") and "=" in _line:
            _k, _, _v = _line.partition("=")
            os.environ.setdefault(_k.strip(), _v.strip())

# ── Project imports ───────────────────────────────────────────────────────────
from data_loader import FinMindClient, fetch_market_index, fetch_stock_info, fetch_stock_prices, fetch_institutional_data
from fugle_client import FugleClient, fetch_watch_quotes
from market_predictor import MarketPredictor, fetch_us_features, format_prediction_block, generate_analysis_text
from strategy import StrategyConfig, compute_market_breadth, compute_market_regime, latest_signal_snapshot, prepare_market_frame, prepare_stock_signals, rank_candidates
from universe import build_auto_universe

_CST = timezone(timedelta(hours=8))
_SCAN_CACHE_PATH = Path("output/bot_scan_cache.json")
_SCAN_CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)

# Shared clients (created once)
_finmind = FinMindClient(cache_dir=Path("output/cache"))
_fugle   = FugleClient()
_config  = StrategyConfig()


# ── Helpers ───────────────────────────────────────────────────────────────────

def _cst_now() -> str:
    return datetime.now(_CST).strftime("%H:%M")

def _cst_date() -> str:
    return datetime.now(_CST).strftime("%Y-%m-%d")

def _lookback_start(days: int = 420) -> str:
    return (datetime.now(_CST) - timedelta(days=days)).strftime("%Y-%m-%d")


def _momentum_emoji(score: float) -> str:
    if score >= 70: return "🟢"
    if score >= 40: return "🟡"
    return "🔴"


def _label_color(label: str) -> discord.Color:
    return {
        "看多": discord.Color.green(),
        "偏多": discord.Color.from_str("#7CFC00"),
        "看空": discord.Color.red(),
        "偏空": discord.Color.orange(),
    }.get(label, discord.Color.greyple())


# ── Scan runner (sync, run in executor) ──────────────────────────────────────

def _run_scan(max_universe: int = 15) -> dict:
    """Run a fresh mini-scan and return candidates + breadth as a serialisable dict."""
    today = _cst_date()
    start = _lookback_start(420)
    try:
        market_raw = fetch_market_index(_finmind, start, today)
        if market_raw.empty:
            return {"error": "無法取得大盤資料（FinMind）"}
        market = prepare_market_frame(market_raw, _config)

        stock_info = fetch_stock_info(_finmind)
        universe   = build_auto_universe(stock_info, max_symbols=max_universe)

        signals: dict[str, pd.DataFrame] = {}
        for _, row in universe.iterrows():
            sid = str(row["stock_id"])
            try:
                prices = fetch_stock_prices(_finmind, sid, start, today)
                if prices.empty:
                    continue
                inst = fetch_institutional_data(_finmind, sid, start, today)
                frame = prepare_stock_signals(row.to_dict(), prices, market, inst, _config)
                signals[sid] = frame
            except Exception as exc:
                log.warning("skip %s: %s", sid, exc)

        snapshot  = latest_signal_snapshot(signals)
        breadth   = compute_market_breadth(snapshot)
        breadth["market_regime"] = compute_market_regime(market)
        candidates, watchlist = rank_candidates(snapshot, top_n=10)

        result: dict = {
            "date": today,
            "breadth": {k: (int(v) if isinstance(v, (int, float)) else str(v)) for k, v in breadth.items()},
            "candidates": candidates.head(10).to_dict("records") if not candidates.empty else [],
            "watchlist":  watchlist.head(5).to_dict("records")  if not watchlist.empty  else [],
        }
        _SCAN_CACHE_PATH.write_text(json.dumps(result, ensure_ascii=False, default=str))
        return result
    except Exception as exc:
        log.exception("scan failed")
        return {"error": str(exc)}


def _run_stock_analysis(stock_id: str) -> dict:
    """Analyse a single stock. Returns serialisable dict."""
    today = _cst_date()
    start = _lookback_start(420)
    try:
        market_raw = fetch_market_index(_finmind, start, today)
        if market_raw.empty:
            return {"error": "無法取得大盤資料"}
        market = prepare_market_frame(market_raw, _config)

        prices = fetch_stock_prices(_finmind, stock_id, start, today)
        if prices.empty:
            return {"error": f"{stock_id} 無價格資料（可能代碼錯誤或 FinMind 不支援）"}
        inst   = fetch_institutional_data(_finmind, stock_id, start, today)

        stock_info_row = {"stock_id": stock_id, "name": stock_id, "industry_category": ""}
        frame  = prepare_stock_signals(stock_info_row, prices, market, inst, _config)
        latest = frame.iloc[-1].to_dict()
        return {"stock_id": stock_id, "data": {k: (None if pd.isna(v) else v) for k, v in latest.items()}}
    except Exception as exc:
        log.exception("stock analysis failed for %s", stock_id)
        return {"error": str(exc)}


def _run_market_ai() -> dict:
    """Return AI prediction + market regime for the current day."""
    today = _cst_date()
    start = _lookback_start(365)
    try:
        market_raw = fetch_market_index(_finmind, start, today)
        if market_raw.empty:
            return {"error": "無法取得大盤資料"}
        us_df = fetch_us_features(start, today)
        pred  = MarketPredictor(horizon=5)
        pred.fit(market_raw, us_df if not us_df.empty else None)
        result = pred.predict_proba(market_raw, us_df if not us_df.empty else None)
        result["regime"] = compute_market_regime(prepare_market_frame(market_raw, _config))
        return result
    except Exception as exc:
        log.exception("market AI failed")
        return {"error": str(exc)}


# ── Discord Bot ───────────────────────────────────────────────────────────────

intents = discord.Intents.default()
client  = discord.Client(intents=intents)
tree    = app_commands.CommandTree(client)

_CHANNEL_ID = int(os.getenv("DISCORD_CHANNEL_ID", "0"))

# stocks being watched (stock_id → True)
_watched: set[str] = set()


@client.event
async def on_ready() -> None:
    await tree.sync()
    log.info("Bot ready as %s", client.user)
    if _CHANNEL_ID:
        eod_monitor.start()


# ── /top ─────────────────────────────────────────────────────────────────────

@tree.command(name="top", description="今日動能前 10 強股票")
async def cmd_top(interaction: discord.Interaction) -> None:
    await interaction.response.defer(thinking=True)

    # Try cache first (< 1 hour old)
    cache: dict = {}
    if _SCAN_CACHE_PATH.exists():
        try:
            cache = json.loads(_SCAN_CACHE_PATH.read_text())
            if cache.get("date") != _cst_date():
                cache = {}
        except Exception:
            cache = {}

    if not cache:
        cache = await asyncio.get_event_loop().run_in_executor(None, _run_scan)

    if "error" in cache:
        await interaction.followup.send(f"❌ {cache['error']}")
        return

    candidates = cache.get("candidates", [])
    watchlist  = cache.get("watchlist", [])
    breadth    = cache.get("breadth", {})

    embed = discord.Embed(
        title=f"🔥 今日動能排行 · {cache.get('date', _cst_date())}",
        color=discord.Color.gold(),
    )

    regime = str(breadth.get("market_regime", ""))
    regime_emoji = {"牛市": "🐂", "盤整": "🦀", "熊市": "🐻"}.get(regime, "❓")
    total  = breadth.get("total_stocks", 0)
    above  = breadth.get("above_ema60", 0)
    embed.add_field(
        name="大盤概況",
        value=f"{regime_emoji} `{regime}` | 總覽 `{total}` 支 | EMA60以上 `{above}%`",
        inline=False,
    )

    if candidates:
        lines = []
        for i, row in enumerate(candidates[:10], 1):
            score = row.get("momentum_score") or row.get("entry_score", 0)
            score_int = int(float(score)) if score else 0
            em = _momentum_emoji(score_int)
            cond  = int(row.get("condition_count", 0))
            close = row.get("close", 0)
            lines.append(f"{i}. **{row['stock_id']}** {row.get('name','')} `{close:.1f}` | 動能 `{score_int}` {em} | `{cond}/23`")
        embed.add_field(name="✅ 全條件候選", value="\n".join(lines), inline=False)

    if watchlist:
        lines = []
        for row in watchlist[:5]:
            score = row.get("momentum_score") or row.get("entry_score", 0)
            score_int = int(float(score)) if score else 0
            lines.append(f"• **{row['stock_id']}** {row.get('name','')} 動能 `{score_int}` {_momentum_emoji(score_int)}")
        embed.add_field(name="👀 觀察名單", value="\n".join(lines), inline=False)

    if not candidates and not watchlist:
        embed.add_field(name="結果", value="今日無候選，市場偏弱或資料不足", inline=False)

    embed.set_footer(text=f"資料來源：FinMind · {_cst_now()} CST")
    await interaction.followup.send(embed=embed)


# ── /ai [stock] ───────────────────────────────────────────────────────────────

@tree.command(name="ai", description="分析單一股票（例：/ai 2330）")
@app_commands.describe(stock="股票代碼（4碼，例：2330）")
async def cmd_ai(interaction: discord.Interaction, stock: str) -> None:
    await interaction.response.defer(thinking=True)
    stock = stock.strip().lstrip("0").zfill(4) if stock.strip().isdigit() else stock.strip()
    result = await asyncio.get_event_loop().run_in_executor(None, _run_stock_analysis, stock)

    if "error" in result:
        await interaction.followup.send(f"❌ {result['error']}")
        return

    d = result["data"]
    close    = float(d.get("close") or 0)
    atr      = float(d.get("atr14") or 0)
    rsi      = float(d.get("rsi14") or 0)
    adx      = float(d.get("adx14") or 0)
    vol_r    = float(d.get("volume_ratio") or 0)
    cond     = int(d.get("condition_count") or 0)
    score    = int(float(d.get("momentum_score") or d.get("entry_score") or 0))
    entry_ok = bool(d.get("entry_signal"))
    fb_str   = int(d.get("foreign_buy_streak") or 0)
    it_str   = int(d.get("invest_trust_streak") or 0)
    reason   = str(d.get("entry_reason") or "")
    skip_r   = str(d.get("skip_reason") or "")

    stop   = round(close * 0.95, 2)
    target = round(close * 1.10, 2)
    if atr > 0:
        stop   = round(close - 2 * atr, 2)
        target = round(close + 3 * atr, 2)
    rr = round((target - close) / max(close - stop, 0.01), 1)

    color = discord.Color.green() if entry_ok else discord.Color.greyple()
    embed = discord.Embed(
        title=f"{'✅' if entry_ok else '👀'} {stock} 分析 · {_cst_date()}",
        color=color,
    )
    embed.add_field(
        name="💰 價格 & 風控",
        value=f"收 `{close:.2f}` | 停損 `{stop}` | 目標 `{target}` | R:R `{rr}:1`",
        inline=False,
    )
    embed.add_field(
        name="📊 技術指標",
        value=f"RSI `{rsi:.1f}` | ADX `{adx:.1f}` | 量比 `{vol_r:.1f}x` | 動能 `{score}` {_momentum_emoji(score)}",
        inline=False,
    )
    embed.add_field(
        name="🏦 籌碼",
        value=f"外資連買 `{fb_str}d` | 投信連買 `{it_str}d`",
        inline=False,
    )
    embed.add_field(
        name="📋 條件",
        value=f"`{cond}/23` | {reason[:80] if reason else '—'}" + (f"\n⛔ {skip_r[:60]}" if skip_r else ""),
        inline=False,
    )
    embed.set_footer(text=f"資料來源：FinMind · {_cst_now()} CST")
    await interaction.followup.send(embed=embed)


# ── /market ───────────────────────────────────────────────────────────────────

@tree.command(name="market", description="大盤 AI 預測 + 市場情緒")
async def cmd_market(interaction: discord.Interaction) -> None:
    await interaction.response.defer(thinking=True)
    pred = await asyncio.get_event_loop().run_in_executor(None, _run_market_ai)

    if "error" in pred:
        await interaction.followup.send(f"❌ {pred['error']}")
        return

    label  = pred.get("label", "中性")
    prob   = float(pred.get("prob_up", 0.5))
    conf   = pred.get("confidence", "low")
    regime = str(pred.get("regime", ""))
    us_tag = "🌐 含美股特徵" if pred.get("us_features") else "僅台股技術"

    regime_emoji = {"牛市": "🐂", "盤整": "🦀", "熊市": "🐻"}.get(regime, "❓")
    conf_emoji   = {"high": "🟢", "medium": "🟡", "low": "⚪"}.get(conf, "⚪")
    label_emoji  = {"看多": "📈", "偏多": "↗", "看空": "📉", "偏空": "↘"}.get(label, "→")

    bull_bar = "█" * int(prob * 10) + "░" * (10 - int(prob * 10))

    embed = discord.Embed(
        title=f"🤖 AI 大盤預測 · {_cst_date()}",
        color=_label_color(label),
    )
    embed.add_field(
        name="市場狀態",
        value=f"{regime_emoji} `{regime}` | {us_tag}",
        inline=False,
    )
    embed.add_field(
        name=f"5日方向 {label_emoji}",
        value=f"`{label}` · 多方 `{prob*100:.0f}%` {conf_emoji}\n`{bull_bar}` 空方 `{(1-prob)*100:.0f}%`",
        inline=False,
    )
    analysis = generate_analysis_text(pred)
    if analysis:
        clean = analysis.replace("📝 **AI 分析**｜", "").strip()
        embed.add_field(name="AI 分析", value=clean[:800], inline=False)

    embed.set_footer(text=f"XGBoost · {_cst_now()} CST")
    await interaction.followup.send(embed=embed)


# ── /watch [stock] ────────────────────────────────────────────────────────────

@tree.command(name="watch", description="加入尾盤監控清單（13:00/13:20/13:29 推播）")
@app_commands.describe(stock="股票代碼（4碼）")
async def cmd_watch(interaction: discord.Interaction, stock: str) -> None:
    stock = stock.strip()
    _watched.add(stock)
    await interaction.response.send_message(
        f"✅ **{stock}** 已加入尾盤監控，今日 13:00 / 13:20 / 13:29 CST 將自動推播分析。",
        ephemeral=True,
    )


# ── End-of-day monitor task ───────────────────────────────────────────────────

@tasks.loop(minutes=1)
async def eod_monitor() -> None:
    """Push end-of-day analysis at 13:00 / 13:20 / 13:29 CST on weekdays."""
    now  = datetime.now(_CST)
    if now.weekday() >= 5:   # Saturday / Sunday
        return
    hm = now.strftime("%H:%M")
    if hm not in {"13:00", "13:20", "13:29"}:
        return

    channel = client.get_channel(_CHANNEL_ID)
    if channel is None:
        log.warning("DISCORD_CHANNEL_ID %s not found", _CHANNEL_ID)
        return

    label_map = {"13:00": "盤中 13:00", "13:20": "盤中 13:20", "13:29": "尾盤 13:29"}
    label = label_map.get(hm, hm)

    # Fetch quotes for watched stocks
    watch_list = list(_watched)
    if not watch_list:
        return
    if not _fugle.enabled:
        await channel.send(f"⚠️ `{label}` 尾盤監控：FUGLE_API_KEY 未設定，無法取得即時報價。")
        return

    quotes = await asyncio.get_event_loop().run_in_executor(
        None, fetch_watch_quotes, _fugle, watch_list
    )
    embed = discord.Embed(
        title=f"📡 尾盤監控 · {label} · {now.strftime('%Y-%m-%d')}",
        color=discord.Color.blurple(),
    )
    for _, row in quotes.iterrows():
        sym = row.get("symbol", "")
        if pd.notna(row.get("error")):
            embed.add_field(name=sym, value=f"❌ {row['error']}", inline=True)
            continue
        last    = row.get("last", "—")
        intra   = row.get("intraday_pct")
        intra_s = f"`{float(intra)*100:+.2f}%`" if pd.notna(intra) else "N/A"
        vol     = row.get("volume", "—")
        embed.add_field(
            name=f"**{sym}**",
            value=f"價 `{last}` | 漲跌 {intra_s} | 量 `{vol}`",
            inline=True,
        )
    await channel.send(embed=embed)


# ── Entry point ───────────────────────────────────────────────────────────────

def main() -> None:
    token = os.getenv("DISCORD_BOT_TOKEN", "").strip()
    if not token:
        sys.exit("❌ DISCORD_BOT_TOKEN 未設定，請在 .env 或環境變數設定後重新啟動。")
    client.run(token, log_handler=None)


if __name__ == "__main__":
    main()
