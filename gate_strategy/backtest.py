"""
Gate.io 策略回测模块
使用 Gate.io 历史K线数据回测 EMA+RSI 策略
本金：500 USDT，10倍杠杆
"""

import requests
import pandas as pd
import numpy as np
import time
from datetime import datetime, timedelta
import matplotlib
matplotlib.use('Agg')  # 无界面模式
import matplotlib.pyplot as plt
import matplotlib.dates as mdates

# ============================================================
# 回测配置
# ============================================================
SYMBOL = "BTC_USDT"
LEVERAGE = 10
TOTAL_CAPITAL = 500.0
RISK_PER_TRADE = 0.02       # 每笔最大亏损 2%
REWARD_RATIO = 2             # 盈亏比 1:2
POSITION_RATIO = 0.25        # 每次用本金 25%
STOP_PCT = 0.01              # 止损距离（价格的1%）
TAKER_FEE = 0.0005           # 吃单手续费 0.05%
MAKER_FEE = 0.0002           # 挂单手续费 0.02%

# 技术指标
EMA_FAST = 9
EMA_SLOW = 21
RSI_PERIOD = 14

# 回测时间（过去6个月）
BACKTEST_DAYS = 180
INTERVAL = "15m"             # K线周期

# ============================================================
# 获取历史数据（Gate.io 公开接口，无需 API Key）
# ============================================================

def fetch_klines(symbol=SYMBOL, interval=INTERVAL, days=BACKTEST_DAYS):
    """分批获取历史K线"""
    print(f"📥 正在从 Gate.io 获取 {symbol} {days}天 {interval} K线数据...")
    
    base_url = "https://fx.gate.io/api/v4/futures/usdt/candlesticks"
    
    # 计算起始时间戳
    end_time = int(time.time())
    start_time = end_time - days * 24 * 3600
    
    all_candles = []
    current_end = end_time
    limit = 1000  # 每次最多取1000根
    
    # 计算每根K线的秒数
    interval_seconds = {
        "1m": 60, "5m": 300, "15m": 900,
        "30m": 1800, "1h": 3600, "4h": 14400, "1d": 86400
    }[interval]
    
    while current_end > start_time:
        current_start = max(current_end - limit * interval_seconds, start_time)
        
        params = {
            "contract": symbol,
            "from": current_start,
            "to": current_end,
            "interval": interval,
            "limit": limit
        }
        
        resp = requests.get(base_url, params=params, timeout=15)
        resp.raise_for_status()
        data = resp.json()
        
        if not data:
            break
        
        all_candles.extend(data)
        current_end = current_start - 1
        time.sleep(0.3)  # 避免频率限制
        
        fetched_count = len(all_candles)
        print(f"  已获取 {fetched_count} 根K线...", end="\r")
    
    print(f"\n✅ 共获取 {len(all_candles)} 根K线")
    
    # 转为 DataFrame
    df = pd.DataFrame(all_candles)
    df["time"] = pd.to_datetime(df["t"].astype(int), unit="s")
    df["open"]   = df["o"].astype(float)
    df["high"]   = df["h"].astype(float)
    df["low"]    = df["l"].astype(float)
    df["close"]  = df["c"].astype(float)
    df["volume"] = df["v"].astype(float)
    df = df[["time","open","high","low","close","volume"]].sort_values("time").reset_index(drop=True)
    
    return df

# ============================================================
# 技术指标
# ============================================================

def add_indicators(df):
    df["ema_fast"] = df["close"].ewm(span=EMA_FAST, adjust=False).mean()
    df["ema_slow"] = df["close"].ewm(span=EMA_SLOW, adjust=False).mean()
    
    delta = df["close"].diff()
    gain = delta.clip(lower=0).ewm(com=RSI_PERIOD - 1, adjust=False).mean()
    loss = (-delta.clip(upper=0)).ewm(com=RSI_PERIOD - 1, adjust=False).mean()
    rs = gain / loss
    df["rsi"] = 100 - (100 / (1 + rs))
    
    return df

def get_signal(row, prev_row):
    """生成信号"""
    cross_up   = prev_row["ema_fast"] < prev_row["ema_slow"] and row["ema_fast"] > row["ema_slow"]
    cross_down = prev_row["ema_fast"] > prev_row["ema_slow"] and row["ema_fast"] < row["ema_slow"]
    rsi = row["rsi"]
    
    if cross_up and 40 < rsi < 65:
        return "LONG"
    elif cross_down and 35 < rsi < 60:
        return "SHORT"
    return "HOLD"

# ============================================================
# 回测引擎
# ============================================================

def run_backtest(df):
    capital = TOTAL_CAPITAL
    trades = []
    equity_curve = [capital]
    equity_times = [df.iloc[0]["time"]]
    
    in_position = False
    position = None  # dict: direction, entry, size, sl, tp, entry_time
    max_equity = capital
    max_drawdown = 0.0
    
    for i in range(1, len(df)):
        row  = df.iloc[i]
        prev = df.iloc[i - 1]
        
        # ---- 检查是否触发止损/止盈 ----
        if in_position:
            hit_sl = hit_tp = False
            
            if position["direction"] == "LONG":
                if row["low"] <= position["sl"]:
                    hit_sl = True
                elif row["high"] >= position["tp"]:
                    hit_tp = True
            else:  # SHORT
                if row["high"] >= position["sl"]:
                    hit_sl = True
                elif row["low"] <= position["tp"]:
                    hit_tp = True
            
            if hit_sl or hit_tp:
                exit_price = position["sl"] if hit_sl else position["tp"]
                direction  = position["direction"]
                entry      = position["entry"]
                size       = position["size"]
                
                # 计算盈亏
                if direction == "LONG":
                    pnl_pct = (exit_price - entry) / entry
                else:
                    pnl_pct = (entry - exit_price) / entry
                
                pnl = pnl_pct * size * LEVERAGE - size * (TAKER_FEE + MAKER_FEE) * LEVERAGE
                capital += pnl
                
                trades.append({
                    "entry_time":  position["entry_time"],
                    "exit_time":   row["time"],
                    "direction":   direction,
                    "entry_price": entry,
                    "exit_price":  exit_price,
                    "size":        size,
                    "pnl":         round(pnl, 4),
                    "result":      "WIN" if pnl > 0 else "LOSS",
                    "exit_reason": "止盈" if hit_tp else "止损"
                })
                
                in_position = False
                position = None
                
                # 更新最大回撤
                if capital > max_equity:
                    max_equity = capital
                dd = (max_equity - capital) / max_equity * 100
                if dd > max_drawdown:
                    max_drawdown = dd
                
                # 熔断
                if capital < TOTAL_CAPITAL * 0.5:
                    print(f"⛔ 熔断触发！资金跌破初始本金50%，停止回测。时间：{row['time']}")
                    break
        
        # ---- 没有持仓时检查新信号 ----
        if not in_position:
            sig = get_signal(row, prev)
            
            if sig in ("LONG", "SHORT"):
                entry_price = row["close"]
                size = round(capital * POSITION_RATIO, 2)  # 每次用 25% 本金
                
                stop_pct = STOP_PCT
                take_pct = stop_pct * REWARD_RATIO
                
                if sig == "LONG":
                    sl = round(entry_price * (1 - stop_pct), 2)
                    tp = round(entry_price * (1 + take_pct), 2)
                else:
                    sl = round(entry_price * (1 + stop_pct), 2)
                    tp = round(entry_price * (1 - take_pct), 2)
                
                position = {
                    "direction":  sig,
                    "entry":      entry_price,
                    "sl":         sl,
                    "tp":         tp,
                    "size":       size,
                    "entry_time": row["time"]
                }
                in_position = True
        
        equity_curve.append(capital)
        equity_times.append(row["time"])
    
    return trades, equity_curve, equity_times, max_drawdown

# ============================================================
# 统计报告
# ============================================================

def print_report(trades, equity_curve, max_drawdown):
    if not trades:
        print("❌ 没有任何交易记录")
        return
    
    df_t = pd.DataFrame(trades)
    wins  = df_t[df_t["result"] == "WIN"]
    losses = df_t[df_t["result"] == "LOSS"]
    
    total      = len(df_t)
    win_count  = len(wins)
    loss_count = len(losses)
    win_rate   = win_count / total * 100
    
    total_pnl       = df_t["pnl"].sum()
    avg_win         = wins["pnl"].mean()  if not wins.empty  else 0
    avg_loss        = losses["pnl"].mean() if not losses.empty else 0
    profit_factor   = wins["pnl"].sum() / abs(losses["pnl"].sum()) if not losses.empty else float("inf")
    
    final_capital = equity_curve[-1]
    roi = (final_capital - TOTAL_CAPITAL) / TOTAL_CAPITAL * 100
    
    # 夏普比率（简化版）
    pnl_series = df_t["pnl"]
    sharpe = pnl_series.mean() / pnl_series.std() * np.sqrt(252) if pnl_series.std() > 0 else 0

    print("\n" + "="*55)
    print("           📊 策略回测报告")
    print("="*55)
    print(f"  交易对       : {SYMBOL}")
    print(f"  K线周期      : {INTERVAL}")
    print(f"  初始本金     : {TOTAL_CAPITAL:.2f} USDT")
    print(f"  最终资金     : {final_capital:.2f} USDT")
    print(f"  总收益率     : {roi:+.2f}%")
    print(f"  总盈亏       : {total_pnl:+.4f} USDT")
    print("-"*55)
    print(f"  总交易次数   : {total}")
    print(f"  盈利次数     : {win_count}  ({win_rate:.1f}%)")
    print(f"  亏损次数     : {loss_count}  ({100-win_rate:.1f}%)")
    print(f"  平均盈利     : +{avg_win:.4f} USDT")
    print(f"  平均亏损     : {avg_loss:.4f} USDT")
    print(f"  盈亏比       : {profit_factor:.2f}")
    print(f"  最大回撤     : {max_drawdown:.2f}%")
    print(f"  夏普比率     : {sharpe:.2f}")
    print("="*55)
    
    # 最近10笔
    print("\n📋 最近10笔交易：")
    print(f"{'时间':<20} {'方向':<6} {'入场价':<12} {'出场价':<12} {'盈亏':<10} {'结果'}")
    print("-"*75)
    for _, t in df_t.tail(10).iterrows():
        print(f"{str(t['entry_time'])[:19]:<20} {t['direction']:<6} {t['entry_price']:<12.2f} {t['exit_price']:<12.2f} {t['pnl']:+<10.4f} {t['result']} ({t['exit_reason']})")
    
    return df_t

# ============================================================
# 绘图
# ============================================================

def plot_results(df, trades_df, equity_times, equity_curve):
    fig, axes = plt.subplots(3, 1, figsize=(14, 10), gridspec_kw={"height_ratios": [3, 1.5, 1.5]})
    fig.suptitle(f"Gate.io {SYMBOL} 策略回测 ({INTERVAL})", fontsize=14, fontweight="bold")
    
    # ---- 子图1：K线 + EMA ----
    ax1 = axes[0]
    ax1.plot(df["time"], df["close"], color="#888", linewidth=0.8, label="收盘价")
    ax1.plot(df["time"], df["ema_fast"], color="#f7931a", linewidth=1.2, label=f"EMA{EMA_FAST}")
    ax1.plot(df["time"], df["ema_slow"], color="#4285f4", linewidth=1.2, label=f"EMA{EMA_SLOW}")
    
    # 标注交易点
    if trades_df is not None and not trades_df.empty:
        longs  = trades_df[trades_df["direction"] == "LONG"]
        shorts = trades_df[trades_df["direction"] == "SHORT"]
        wins   = trades_df[trades_df["result"] == "WIN"]
        losses = trades_df[trades_df["result"] == "LOSS"]
        
        ax1.scatter(longs["entry_time"],  longs["entry_price"],  marker="^", color="#00c853", s=40, zorder=5, label="做多")
        ax1.scatter(shorts["entry_time"], shorts["entry_price"], marker="v", color="#ff1744", s=40, zorder=5, label="做空")
        ax1.scatter(wins["exit_time"],    wins["exit_price"],    marker="o", color="#00c853", s=25, alpha=0.7, zorder=5)
        ax1.scatter(losses["exit_time"],  losses["exit_price"],  marker="x", color="#ff1744", s=25, alpha=0.7, zorder=5)
    
    ax1.set_ylabel("价格 (USDT)")
    ax1.legend(loc="upper left", fontsize=8)
    ax1.grid(alpha=0.3)
    
    # ---- 子图2：资金曲线 ----
    ax2 = axes[1]
    eq_series = pd.Series(equity_curve, index=equity_times)
    color = "#00c853" if equity_curve[-1] >= TOTAL_CAPITAL else "#ff1744"
    ax2.plot(equity_times, equity_curve, color=color, linewidth=1.5)
    ax2.axhline(TOTAL_CAPITAL, color="#888", linestyle="--", linewidth=0.8, label="初始本金")
    ax2.fill_between(equity_times, TOTAL_CAPITAL, equity_curve,
                     where=[e >= TOTAL_CAPITAL for e in equity_curve],
                     alpha=0.2, color="#00c853")
    ax2.fill_between(equity_times, TOTAL_CAPITAL, equity_curve,
                     where=[e < TOTAL_CAPITAL for e in equity_curve],
                     alpha=0.2, color="#ff1744")
    ax2.set_ylabel("资金 (USDT)")
    ax2.legend(fontsize=8)
    ax2.grid(alpha=0.3)
    
    # ---- 子图3：RSI ----
    ax3 = axes[2]
    ax3.plot(df["time"], df["rsi"], color="#ab47bc", linewidth=1.0)
    ax3.axhline(70, color="#ff1744", linestyle="--", linewidth=0.7, alpha=0.7)
    ax3.axhline(30, color="#00c853", linestyle="--", linewidth=0.7, alpha=0.7)
    ax3.axhline(50, color="#888",    linestyle="--", linewidth=0.5, alpha=0.5)
    ax3.fill_between(df["time"], 70, 100, alpha=0.08, color="#ff1744")
    ax3.fill_between(df["time"], 0,  30,  alpha=0.08, color="#00c853")
    ax3.set_ylim(0, 100)
    ax3.set_ylabel("RSI")
    ax3.set_xlabel("时间")
    ax3.grid(alpha=0.3)
    
    for ax in axes:
        ax.xaxis.set_major_formatter(mdates.DateFormatter("%m/%d"))
        ax.xaxis.set_major_locator(mdates.WeekdayLocator(interval=2))
        plt.setp(ax.xaxis.get_majorticklabels(), rotation=30, ha="right", fontsize=7)
    
    plt.tight_layout()
    out_path = "/home/node/.openclaw/workspace/gate_strategy/backtest_result.png"
    plt.savefig(out_path, dpi=150, bbox_inches="tight")
    plt.close()
    print(f"\n📊 回测图表已保存: {out_path}")
    return out_path

# ============================================================
# 主函数
# ============================================================

def main():
    print("="*55)
    print("    Gate.io EMA+RSI 策略回测器")
    print(f"    本金: {TOTAL_CAPITAL}U  杠杆: {LEVERAGE}x  周期: {INTERVAL}")
    print("="*55)
    
    # 1. 获取数据
    df = fetch_klines()
    
    # 2. 计算指标
    df = add_indicators(df)
    df = df.dropna().reset_index(drop=True)
    print(f"📅 回测区间: {df.iloc[0]['time']} → {df.iloc[-1]['time']}")
    print(f"   共 {len(df)} 根K线")
    
    # 3. 运行回测
    print("\n⚙️  运行回测中...")
    trades, equity_curve, equity_times, max_dd = run_backtest(df)
    
    # 4. 打印报告
    trades_df = print_report(trades, equity_curve, max_dd)
    
    # 5. 画图
    try:
        plot_results(df, trades_df, equity_times, equity_curve)
    except Exception as e:
        print(f"⚠️  绘图失败（可能缺少 matplotlib）: {e}")
    
    # 6. 保存交易记录
    if trades_df is not None:
        csv_path = "/home/node/.openclaw/workspace/gate_strategy/trades.csv"
        trades_df.to_csv(csv_path, index=False)
        print(f"📁 交易记录已保存: {csv_path}")

if __name__ == "__main__":
    main()
