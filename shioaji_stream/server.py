#!/usr/bin/env python3
"""Shioaji 即時報價 streaming 服務 (read-only).

A small always-on service (deploy to Railway) that holds a Shioaji streaming
connection and pushes tick-level quotes to the frontend over WebSocket — true
real-time, no polling delay.

Security:
  * Logs into Shioaji with API key + secret ONLY (no CA certificate) → it can
    read market data but CANNOT place orders.
  * The WebSocket / REST endpoints are gated by STREAM_TOKEN so randoms can't
    connect and burn your Shioaji subscription quota. The token is NOT a broker
    secret; the frontend stores it client-side (user-entered), never bundled.

Endpoints:
  GET  /healthz            → {"ok": true, "logged_in": bool, "subscribed": n}
  GET  /prices?token=...   → current snapshot {id: entry, "_idx_t00": idx}
  WS   /ws?token=...       → client sends {"action":"subscribe","ids":[...]};
                             server pushes {"type":"snapshot"|"tick","prices":{...}}

Entry schema matches web/src/hooks/useLivePrices.js:
  {price, prevClose, pct, high, low, open, volume, time, isSnapshot}

Env:
  SHIOAJI_API_KEY, SHIOAJI_SECRET_KEY   (required to stream; else read-only no-op)
  STREAM_TOKEN                          (required to accept clients; if unset, open)
  MAX_SUBSCRIPTIONS                     (default 190; Shioaji stock sub cap ~200)
  ALLOWED_ORIGINS                       (CSV; default '*')
  PORT                                  (Railway injects this)
"""

from __future__ import annotations

import asyncio
import os
import threading
import time
from contextlib import asynccontextmanager
from datetime import datetime, timezone

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

MAX_SUBSCRIPTIONS = int(os.getenv("MAX_SUBSCRIPTIONS", "190"))
STREAM_TOKEN = os.getenv("STREAM_TOKEN", "").strip()
BROADCAST_INTERVAL = 0.7  # seconds — batch ticks to avoid flooding clients


# ── Shared state (written from Shioaji's callback thread, read by asyncio) ──────
class State:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.latest: dict[str, dict] = {}   # code -> entry
        self.dirty: set[str] = set()        # codes changed since last broadcast
        self.subscribed: set[str] = set()   # codes we've asked Shioaji to stream
        self.logged_in = False
        self.api = None


state = State()


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _num(v):
    try:
        f = float(v)
        return f if f == f else None
    except (TypeError, ValueError):
        return None


def _tick_to_entry(tick) -> dict | None:
    """Map a Shioaji TickSTKv1 to the shared price-entry schema."""
    price = _num(getattr(tick, "close", None))
    if not price:
        return None
    price_chg = _num(getattr(tick, "price_chg", None))
    prev = (price - price_chg) if price_chg is not None else None
    if prev and prev > 0:
        pct = (price - prev) / prev
    else:
        pc = _num(getattr(tick, "pct_chg", None))  # percent
        pct = (pc / 100.0) if pc is not None else None
    dt = getattr(tick, "datetime", None)
    try:
        time_iso = dt.astimezone(timezone.utc).isoformat() if dt else _now_iso()
    except Exception:  # noqa: BLE001
        time_iso = _now_iso()
    return {
        "price": price,
        "prevClose": prev,
        "pct": pct,
        "high": _num(getattr(tick, "high", None)),
        "low": _num(getattr(tick, "low", None)),
        "open": _num(getattr(tick, "open", None)),
        "volume": int(_num(getattr(tick, "total_volume", None)) or 0),
        "time": time_iso,
        "isSnapshot": False,
    }


def _login() -> None:
    api_key = os.getenv("SHIOAJI_API_KEY", "").strip()
    secret_key = os.getenv("SHIOAJI_SECRET_KEY", "").strip()
    if not api_key or not secret_key:
        print("SHIOAJI_API_KEY / SHIOAJI_SECRET_KEY not set — streaming disabled.")
        return
    try:
        import shioaji as sj
    except ImportError:
        print("shioaji not installed — streaming disabled.")
        return

    api = sj.Shioaji()
    try:
        try:
            api.login(api_key=api_key, secret_key=secret_key, contracts_timeout=15000)
        except TypeError:
            api.login(api_key, secret_key)
    except Exception as e:  # noqa: BLE001
        print(f"Shioaji login failed: {e}")
        return

    # Tick callback (runs on Shioaji's own thread).
    def on_tick(_exchange, tick):
        code = str(getattr(tick, "code", "") or "")
        entry = _tick_to_entry(tick)
        if not code or not entry:
            return
        with state.lock:
            state.latest[code] = entry
            state.dirty.add(code)

    try:
        api.quote.set_on_tick_stk_v1_callback(on_tick)
    except Exception as e:  # noqa: BLE001
        print(f"Failed to register tick callback: {e}")
        return

    state.api = api
    state.logged_in = True
    print("Shioaji login OK — streaming ready.")


def _resolve_contract(api, sid: str):
    stocks = api.Contracts.Stocks
    try:
        c = stocks[sid]
        if c is not None:
            return c
    except Exception:  # noqa: BLE001
        pass
    for ex_name in ("TSE", "OTC"):
        ex = getattr(stocks, ex_name, None)
        if ex is None:
            continue
        try:
            c = ex[sid]
            if c is not None:
                return c
        except Exception:  # noqa: BLE001
            continue
    return None


def subscribe_ids(ids: list[str]) -> None:
    """Subscribe to tick streams for any new ids (bounded by MAX_SUBSCRIPTIONS)."""
    api = state.api
    if api is None:
        return
    try:
        import shioaji as sj
    except ImportError:
        return
    for sid in ids:
        sid = str(sid)
        with state.lock:
            if sid in state.subscribed or len(state.subscribed) >= MAX_SUBSCRIPTIONS:
                continue
        c = _resolve_contract(api, sid)
        if c is None:
            continue
        try:
            api.quote.subscribe(c, quote_type=sj.constant.QuoteType.Tick,
                                 version=sj.constant.QuoteVersion.v1)
            with state.lock:
                state.subscribed.add(sid)
        except Exception as e:  # noqa: BLE001
            print(f"subscribe {sid} failed: {e}")


# ── WebSocket client registry + broadcast loop ─────────────────────────────────
clients: set[WebSocket] = set()


async def _broadcast_loop():
    while True:
        await asyncio.sleep(BROADCAST_INTERVAL)
        if not clients:
            continue
        with state.lock:
            if not state.dirty:
                continue
            changed = {c: state.latest[c] for c in state.dirty if c in state.latest}
            state.dirty.clear()
        if not changed:
            continue
        msg = {"type": "tick", "prices": changed}
        dead = []
        for ws in list(clients):
            try:
                await ws.send_json(msg)
            except Exception:  # noqa: BLE001
                dead.append(ws)
        for ws in dead:
            clients.discard(ws)


def _auto_shutdown_watch():
    """Optional cost saver: exit cleanly after market close so Railway stops
    billing. Pair with a cron-job.org call to serviceInstanceRedeploy each
    trading morning to start back up. With restartPolicyType=ON_FAILURE, a
    clean exit(0) is NOT auto-restarted.

    Set AUTO_SHUTDOWN_CST="HH:MM" (Taipei time, e.g. "13:40"). Unset → run 24/7.
    """
    target = os.getenv("AUTO_SHUTDOWN_CST", "").strip()
    if not target:
        return
    try:
        th, tm = (int(x) for x in target.split(":"))
        target_min = th * 60 + tm
    except Exception:  # noqa: BLE001
        print(f"invalid AUTO_SHUTDOWN_CST={target!r} — ignoring")
        return
    from zoneinfo import ZoneInfo
    tz = ZoneInfo("Asia/Taipei")
    print(f"AUTO_SHUTDOWN armed for {target} CST (and weekends).")
    while True:
        now = datetime.now(tz)
        cur = now.hour * 60 + now.minute
        weekend = now.weekday() >= 5
        # Exit after close on weekdays (target..20:00 window so a late manual
        # deploy to reconfigure isn't killed instantly), or any time on weekends.
        if weekend or (target_min <= cur < 20 * 60):
            print(f"AUTO_SHUTDOWN: CST {now:%Y-%m-%d %H:%M} — exiting (Railway billing stops).")
            os._exit(0)
        time.sleep(30)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    # Login in a thread so a slow contracts download doesn't block startup.
    threading.Thread(target=_login, daemon=True).start()
    threading.Thread(target=_auto_shutdown_watch, daemon=True).start()
    task = asyncio.create_task(_broadcast_loop())
    yield
    task.cancel()
    api = state.api
    if api is not None:
        try:
            api.logout()
        except Exception:  # noqa: BLE001
            pass


app = FastAPI(lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in os.getenv("ALLOWED_ORIGINS", "*").split(",")],
    allow_methods=["*"],
    allow_headers=["*"],
)


def _check_token(token: str | None) -> bool:
    return (not STREAM_TOKEN) or (token == STREAM_TOKEN)


@app.get("/healthz")
def healthz():
    with state.lock:
        return {"ok": True, "logged_in": state.logged_in, "subscribed": len(state.subscribed)}


@app.get("/prices")
def prices(token: str | None = Query(default=None)):
    if not _check_token(token):
        return JSONResponse({"error": "unauthorized"}, status_code=401)
    with state.lock:
        return {"updatedAt": _now_iso(), "source": "shioaji-stream", "prices": dict(state.latest)}


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket, token: str | None = Query(default=None)):
    if not _check_token(token):
        await ws.close(code=4401)
        return
    await ws.accept()
    clients.add(ws)
    # Send current snapshot immediately so the client paints without waiting for a tick.
    with state.lock:
        snapshot = {"type": "snapshot", "prices": dict(state.latest)}
    try:
        await ws.send_json(snapshot)
        while True:
            data = await ws.receive_json()
            if isinstance(data, dict) and data.get("action") == "subscribe":
                ids = [str(x) for x in (data.get("ids") or [])][:MAX_SUBSCRIPTIONS]
                # Subscribe off the event loop (Shioaji calls are blocking).
                await asyncio.to_thread(subscribe_ids, ids)
                with state.lock:
                    have = {c: state.latest[c] for c in ids if c in state.latest}
                if have:
                    await ws.send_json({"type": "snapshot", "prices": have})
    except WebSocketDisconnect:
        pass
    except Exception:  # noqa: BLE001
        pass
    finally:
        clients.discard(ws)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", "8000")))
