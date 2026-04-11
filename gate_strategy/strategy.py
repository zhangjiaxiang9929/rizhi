"""
Gate.io 10x 合约自动化交易策略
策略：EMA交叉 + RSI过滤 + 严格风控
本金：500 USDT，10倍杠杆

风险提示：本代码仅供学习参考，实盘有亏损风险。
"""

import time
import hmac
import hashlib
import requests
import json
from datetime import datetime
import pandas as pd
import numpy as np

# ============================================================
# 配置区（修改这里）
# ============================================================
API_KEY = "your_api_key_here"
API_SECRET = "your_api_secret_here"
BASE_URL = "https://fx.gate.io"  # 合约 API

SYMBOL = "BTC_USDT"          # 交易对
LEVERAGE = 10                  # 杠杆倍数
TOTAL_CAPITAL = 500            # 总本金 USDT
RISK_PER_TRADE = 0.02          # 每笔最大亏损比例（2% = 10U）
REWARD_RATIO = 2               # 盈亏比 1:2
POSITION_RATIO = 0.25          # 每次用本金的 25% 开仓

# 技术指标参数
EMA_FAST = 9
EMA_SLOW = 21
RSI_PERIOD = 14
RSI_OVERBOUGHT = 70
RSI_OVERSOLD = 30

# ============================================================
# Gate.io API 请求工具
# ============================================================

def sign_request(method, path, query_string="", body=""):
    """生成 Gate.io API 签名"""
    t = str(int(time.time()))
    msg = f"{method}\n{path}\n{query_string}\n{hashlib.sha512(body.encode()).hexdigest()}\n{t}"
    sign = hmac.new(API_SECRET.encode(), msg.encode(), hashlib.sha512).hexdigest()
    return {
        "KEY": API_KEY,
        "Timestamp": t,
        "SIGN": sign,
        "Content-Type": "application/json"
    }

def api_get(path, params=None):
    """GET 请求"""
    query = "&".join([f"{k}={v}" for k, v in (params or {}).items()])
    headers = sign_request("GET", path, query)
    url = f"{BASE_URL}{path}"
    if query:
        url += f"?{query}"
    resp = requests.get(url, headers=headers, timeout=10)
    resp.raise_for_status()
    return resp.json()

def api_post(path, body: dict):
    """POST 请求"""
    body_str = json.dumps(body)
    headers = sign_request("POST", path, "", body_str)
    resp = requests.post(f"{BASE_URL}{path}", headers=headers, data=body_str, timeout=10)
    resp.raise_for_status()
    return resp.json()

# ============================================================
# 市场数据
# ============================================================

def get_klines(symbol=SYMBOL, interval="15m", limit=100):
    """获取K线数据"""
    path = "/api/v4/futures/usdt/candlesticks"
    params = {
        "contract": symbol,
        "interval": interval,
        "limit": limit
    }
    data = api_get(path, params)
    df = pd.DataFrame(data)
    df["close"] = df["c"].astype(float)
    df["high"] = df["h"].astype(float)
    df["low"] = df["l"].astype(float)
    df["volume"] = df["v"].astype(float)
    df["time"] = pd.to_datetime(df["t"].astype(int), unit="s")
    return df

def get_current_price(symbol=SYMBOL):
    """获取当前价格"""
    path = f"/api/v4/futures/usdt/contracts/{symbol}"
    data = api_get(path)
    return float(data["last_price"])

def get_account_balance():
    """获取合约账户余额"""
    path = "/api/v4/futures/usdt/accounts"
    data = api_get(path)
    return float(data["available"])

def get_open_positions(symbol=SYMBOL):
    """获取当前持仓"""
    path = f"/api/v4/futures/usdt/positions/{symbol}"
    try:
        data = api_get(path)
        return data
    except:
        return None

# ============================================================
# 技术指标计算
# ============================================================

def calc_ema(series, period):
    return series.ewm(span=period, adjust=False).mean()

def calc_rsi(series, period=RSI_PERIOD):
    delta = series.diff()
    gain = delta.clip(lower=0)
    loss = -delta.clip(upper=0)
    avg_gain = gain.ewm(com=period - 1, adjust=False).mean()
    avg_loss = loss.ewm(com=period - 1, adjust=False).mean()
    rs = avg_gain / avg_loss
    return 100 - (100 / (1 + rs))

def get_signal(df):
    """
    信号逻辑：
    - 做多：快线上穿慢线 + RSI 在 40-65 之间（避免追高）
    - 做空：快线下穿慢线 + RSI 在 35-60 之间（避免追低）
    - 无信号：RSI 超买/超卖区域不开新仓
    """
    df["ema_fast"] = calc_ema(df["close"], EMA_FAST)
    df["ema_slow"] = calc_ema(df["close"], EMA_SLOW)
    df["rsi"] = calc_rsi(df["close"])

    last = df.iloc[-1]
    prev = df.iloc[-2]

    ema_cross_up = prev["ema_fast"] < prev["ema_slow"] and last["ema_fast"] > last["ema_slow"]
    ema_cross_down = prev["ema_fast"] > prev["ema_slow"] and last["ema_fast"] < last["ema_slow"]

    rsi = last["rsi"]

    if ema_cross_up and 40 < rsi < 65:
        return "LONG", last["close"], rsi
    elif ema_cross_down and 35 < rsi < 60:
        return "SHORT", last["close"], rsi
    else:
        return "HOLD", last["close"], rsi

# ============================================================
# 风控计算
# ============================================================

def calc_position_size(price, capital=TOTAL_CAPITAL):
    """
    计算开仓手数
    - 最大亏损 = 本金 * RISK_PER_TRADE
    - 止损距离 = 价格 * 1% (杠杆下对应10%真实止损)
    """
    max_loss = capital * RISK_PER_TRADE          # 最大亏损金额（U）
    stop_distance_pct = 0.01                      # 止损距离：价格的 1%
    stop_distance = price * stop_distance_pct

    # 合约价值 = 手数 * 合约面值（BTC默认1U/张）
    # 亏损 = 手数 * 止损距离
    size = max_loss / stop_distance
    size = int(size)  # 取整

    # 不超过仓位上限
    max_size_by_ratio = int((capital * POSITION_RATIO * LEVERAGE) / price * 1000) / 1000
    size = min(size, int(max_size_by_ratio))

    return max(1, size)

def calc_sl_tp(direction, price):
    """计算止损和止盈价格"""
    stop_pct = 0.01  # 1% 止损（10倍杠杆下约10%权益损失）
    take_pct = stop_pct * REWARD_RATIO  # 2% 止盈

    if direction == "LONG":
        sl = round(price * (1 - stop_pct), 2)
        tp = round(price * (1 + take_pct), 2)
    else:
        sl = round(price * (1 + stop_pct), 2)
        tp = round(price * (1 - take_pct), 2)

    return sl, tp

# ============================================================
# 下单操作
# ============================================================

def set_leverage(symbol=SYMBOL, leverage=LEVERAGE):
    """设置杠杆"""
    path = f"/api/v4/futures/usdt/positions/{symbol}/leverage"
    api_post(path, {"leverage": str(leverage), "cross_leverage_limit": "0"})
    print(f"✅ 杠杆已设置为 {leverage}x")

def place_order(direction, size, price, sl, tp):
    """下单（限价单）"""
    path = "/api/v4/futures/usdt/orders"
    side = 1 if direction == "LONG" else -1  # 正数做多，负数做空

    order = {
        "contract": SYMBOL,
        "size": size * side,
        "price": str(price),
        "tif": "gtc",       # 一直有效
        "text": "ema_strategy",
        "reduce_only": False,
        "close": False
    }
    result = api_post(path, order)
    order_id = result.get("id")
    print(f"📝 开仓订单: {direction} {size}张 @ {price}, 止损={sl}, 止盈={tp}, ID={order_id}")

    # 挂止损单
    place_stop_order(direction, size, sl, is_stop=True)
    # 挂止盈单
    place_stop_order(direction, size, tp, is_stop=False)

    return order_id

def place_stop_order(direction, size, trigger_price, is_stop=True):
    """挂止损/止盈单"""
    path = "/api/v4/futures/usdt/price_orders"
    # 止损/止盈时，方向相反
    close_side = -1 if direction == "LONG" else 1

    order_type = "stop" if is_stop else "take_profit"
    order = {
        "initial": {
            "contract": SYMBOL,
            "size": size * close_side,
            "price": "0",    # 市价平仓
            "tif": "ioc",
            "reduce_only": True,
            "close": False,
            "text": order_type
        },
        "trigger": {
            "strategy_type": 0,
            "price_type": 0,
            "price": str(trigger_price),
            "rule": 2 if direction == "LONG" else 1,  # LONG止损=跌破，SHORT止损=涨破
        }
    }
    result = api_post(path, order)
    label = "止损" if is_stop else "止盈"
    print(f"  ↳ {label}单已挂: 触发价={trigger_price}, ID={result.get('id')}")

def close_position(symbol=SYMBOL):
    """平掉所有持仓"""
    path = "/api/v4/futures/usdt/orders"
    order = {
        "contract": symbol,
        "size": 0,
        "price": "0",
        "tif": "ioc",
        "reduce_only": False,
        "close": True
    }
    result = api_post(path, order)
    print(f"🔴 已平仓: {result}")

# ============================================================
# 主循环
# ============================================================

def log(msg):
    print(f"[{datetime.utcnow().strftime('%Y-%m-%d %H:%M:%S')} UTC] {msg}")

def run():
    log("🚀 策略启动")
    log(f"  交易对: {SYMBOL} | 杠杆: {LEVERAGE}x | 本金: {TOTAL_CAPITAL}U")
    log(f"  单笔最大亏损: {TOTAL_CAPITAL * RISK_PER_TRADE}U | 盈亏比: 1:{REWARD_RATIO}")

    # 设置杠杆
    set_leverage()

    while True:
        try:
            # 检查余额
            balance = get_account_balance()
            log(f"💰 可用余额: {balance:.2f} USDT")

            # 如果余额低于初始本金的 50%，停止交易
            if balance < TOTAL_CAPITAL * 0.5:
                log("⛔ 余额低于本金50%，触发熔断，停止交易！")
                break

            # 检查是否已有持仓
            position = get_open_positions()
            has_position = position and float(position.get("size", 0)) != 0

            if has_position:
                log(f"📊 当前有持仓: {position['size']}张, 未实现盈亏: {position.get('unrealised_pnl', 0)}")
            else:
                # 获取K线，计算信号
                df = get_klines(interval="15m", limit=100)
                signal, price, rsi = get_signal(df)
                log(f"📈 信号: {signal} | 价格: {price} | RSI: {rsi:.1f}")

                if signal in ("LONG", "SHORT"):
                    size = calc_position_size(price, balance)
                    sl, tp = calc_sl_tp(signal, price)
                    log(f"🎯 准备开仓: {signal} {size}张 @ {price}")
                    log(f"   止损: {sl} | 止盈: {tp}")
                    place_order(signal, size, price, sl, tp)
                else:
                    log("⏸  无信号，等待下一根K线...")

            # 等待15分钟（一根K线）
            log("⏳ 等待15分钟...")
            time.sleep(60 * 15)

        except KeyboardInterrupt:
            log("👋 手动停止策略")
            break
        except Exception as e:
            log(f"❌ 错误: {e}")
            time.sleep(30)  # 出错后等30秒重试

if __name__ == "__main__":
    run()
