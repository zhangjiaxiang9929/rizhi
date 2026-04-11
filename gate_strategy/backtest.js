/**
 * Gate.io EMA+RSI 策略回测器（Node.js 版）
 * 无需任何依赖，直接运行：node backtest.js
 * 本金：500 USDT，10倍杠杆，15分钟K线
 */

const https = require("https");

// ============================================================
// 配置
// ============================================================
const CONFIG = {
  SYMBOL: "BTC_USDT",
  LEVERAGE: 10,
  CAPITAL: 500,
  RISK_PCT: 0.02,          // 每笔最大亏损 2%
  REWARD_RATIO: 2,          // 盈亏比 1:2
  POSITION_RATIO: 0.25,     // 每次仓位 25% 本金
  STOP_PCT: 0.01,           // 止损距离 1%
  TAKER_FEE: 0.0005,
  MAKER_FEE: 0.0002,
  EMA_FAST: 9,
  EMA_SLOW: 21,
  RSI_PERIOD: 14,
  INTERVAL: "15m",
  DAYS: 180,                // 回测天数
};

// ============================================================
// 工具函数
// ============================================================
function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    }).on("error", reject);
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ============================================================
// 获取历史K线
// ============================================================
async function fetchKlines() {
  const intervalSec = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400 }[CONFIG.INTERVAL];
  const endTime = Math.floor(Date.now() / 1000);
  const startTime = endTime - CONFIG.DAYS * 86400;

  let allCandles = [];
  let currentEnd = endTime;
  const limit = 1000;

  console.log(`📥 获取 ${CONFIG.SYMBOL} ${CONFIG.DAYS}天 ${CONFIG.INTERVAL} K线...`);

  while (currentEnd > startTime) {
    const currentStart = Math.max(currentEnd - limit * intervalSec, startTime);
    // Gate API: from+to cannot be used with limit at the same time
    const url =
      `https://api.gateio.ws/api/v4/futures/usdt/candlesticks` +
      `?contract=${CONFIG.SYMBOL}&from=${currentStart}&to=${currentEnd}` +
      `&interval=${CONFIG.INTERVAL}`;

    const data = await httpGet(url);
    if (!data || !Array.isArray(data) || data.length === 0) break;

    allCandles = allCandles.concat(data);
    currentEnd = currentStart - 1;
    process.stdout.write(`  已获取 ${allCandles.length} 根K线...\r`);
    await sleep(350);
  }

  console.log(`\n✅ 共获取 ${allCandles.length} 根K线`);

  return allCandles
    .map((c) => ({
      time: Number(c.t),
      open: parseFloat(c.o),
      high: parseFloat(c.h),
      low: parseFloat(c.l),
      close: parseFloat(c.c),
      volume: parseFloat(c.v),
    }))
    .sort((a, b) => a.time - b.time);
}

// ============================================================
// 技术指标
// ============================================================
function calcEMA(closes, period) {
  const k = 2 / (period + 1);
  const ema = new Array(closes.length).fill(null);
  let sum = 0, count = 0;
  for (let i = 0; i < closes.length; i++) {
    if (i < period - 1) { sum += closes[i]; count++; continue; }
    if (i === period - 1) {
      sum += closes[i];
      ema[i] = sum / period;
      continue;
    }
    ema[i] = closes[i] * k + ema[i - 1] * (1 - k);
  }
  return ema;
}

function calcRSI(closes, period) {
  const rsi = new Array(closes.length).fill(null);
  let avgGain = 0, avgLoss = 0;

  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) avgGain += d / period;
    else avgLoss += (-d) / period;
  }

  rsi[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const gain = d > 0 ? d : 0;
    const loss = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    rsi[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return rsi;
}

function addIndicators(candles) {
  const closes = candles.map((c) => c.close);
  const emaFast = calcEMA(closes, CONFIG.EMA_FAST);
  const emaSlow = calcEMA(closes, CONFIG.EMA_SLOW);
  const rsi = calcRSI(closes, CONFIG.RSI_PERIOD);
  return candles.map((c, i) => ({ ...c, emaFast: emaFast[i], emaSlow: emaSlow[i], rsi: rsi[i] }));
}

// ============================================================
// 信号逻辑
// ============================================================
function getSignal(cur, prev) {
  if (!cur.emaFast || !cur.emaSlow || !cur.rsi) return "HOLD";
  const crossUp = prev.emaFast < prev.emaSlow && cur.emaFast > cur.emaSlow;
  const crossDown = prev.emaFast > prev.emaSlow && cur.emaFast < cur.emaSlow;
  if (crossUp && cur.rsi > 40 && cur.rsi < 65) return "LONG";
  if (crossDown && cur.rsi > 35 && cur.rsi < 60) return "SHORT";
  return "HOLD";
}

// ============================================================
// 回测引擎
// ============================================================
function runBacktest(candles) {
  let capital = CONFIG.CAPITAL;
  const trades = [];
  const equityCurve = [{ time: candles[0].time, equity: capital }];
  let position = null;
  let maxEquity = capital;
  let maxDrawdown = 0;

  for (let i = 1; i < candles.length; i++) {
    const cur = candles[i];
    const prev = candles[i - 1];

    // 检查止损/止盈
    if (position) {
      let hitSL = false, hitTP = false;
      if (position.direction === "LONG") {
        if (cur.low <= position.sl) hitSL = true;
        else if (cur.high >= position.tp) hitTP = true;
      } else {
        if (cur.high >= position.sl) hitSL = true;
        else if (cur.low <= position.tp) hitTP = true;
      }

      if (hitSL || hitTP) {
        const exitPrice = hitSL ? position.sl : position.tp;
        let pnlPct = position.direction === "LONG"
          ? (exitPrice - position.entry) / position.entry
          : (position.entry - exitPrice) / position.entry;

        const fee = position.size * (CONFIG.TAKER_FEE + CONFIG.MAKER_FEE) * CONFIG.LEVERAGE;
        const pnl = pnlPct * position.size * CONFIG.LEVERAGE - fee;

        capital += pnl;
        trades.push({
          entryTime: new Date(position.entryTime * 1000).toISOString().slice(0, 16),
          exitTime: new Date(cur.time * 1000).toISOString().slice(0, 16),
          direction: position.direction,
          entry: position.entry,
          exit: exitPrice,
          size: position.size,
          pnl: +pnl.toFixed(4),
          result: pnl > 0 ? "WIN" : "LOSS",
          reason: hitTP ? "止盈" : "止损",
        });

        if (capital > maxEquity) maxEquity = capital;
        const dd = ((maxEquity - capital) / maxEquity) * 100;
        if (dd > maxDrawdown) maxDrawdown = dd;

        position = null;

        if (capital < CONFIG.CAPITAL * 0.5) {
          console.log(`\n⛔ 熔断！资金跌破50%，停止回测`);
          break;
        }
      }
    }

    // 检查新信号
    if (!position) {
      const sig = getSignal(cur, prev);
      if (sig === "LONG" || sig === "SHORT") {
        const size = +(capital * CONFIG.POSITION_RATIO).toFixed(2);
        const stopPct = CONFIG.STOP_PCT;
        const takePct = stopPct * CONFIG.REWARD_RATIO;
        const sl = sig === "LONG"
          ? +(cur.close * (1 - stopPct)).toFixed(2)
          : +(cur.close * (1 + stopPct)).toFixed(2);
        const tp = sig === "LONG"
          ? +(cur.close * (1 + takePct)).toFixed(2)
          : +(cur.close * (1 - takePct)).toFixed(2);

        position = { direction: sig, entry: cur.close, sl, tp, size, entryTime: cur.time };
      }
    }

    equityCurve.push({ time: cur.time, equity: +capital.toFixed(4) });
  }

  return { trades, equityCurve, maxDrawdown: +maxDrawdown.toFixed(2) };
}

// ============================================================
// 打印报告
// ============================================================
function printReport(trades, equityCurve, maxDrawdown) {
  if (!trades.length) { console.log("❌ 无交易记录"); return; }

  const wins = trades.filter((t) => t.result === "WIN");
  const losses = trades.filter((t) => t.result === "LOSS");
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const winPnl = wins.reduce((s, t) => s + t.pnl, 0);
  const lossPnl = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const winRate = (wins.length / trades.length) * 100;
  const avgWin = wins.length ? winPnl / wins.length : 0;
  const avgLoss = losses.length ? lossPnl / losses.length : 0;
  const profitFactor = lossPnl > 0 ? winPnl / lossPnl : Infinity;
  const finalCapital = equityCurve[equityCurve.length - 1].equity;
  const roi = ((finalCapital - CONFIG.CAPITAL) / CONFIG.CAPITAL) * 100;

  // 夏普比率
  const pnls = trades.map((t) => t.pnl);
  const mean = pnls.reduce((s, v) => s + v, 0) / pnls.length;
  const std = Math.sqrt(pnls.map((v) => (v - mean) ** 2).reduce((s, v) => s + v, 0) / pnls.length);
  const sharpe = std > 0 ? (mean / std) * Math.sqrt(252) : 0;

  const sep = "=".repeat(55);
  const dash = "-".repeat(55);

  console.log("\n" + sep);
  console.log("           📊 策略回测报告");
  console.log(sep);
  console.log(`  交易对       : ${CONFIG.SYMBOL}`);
  console.log(`  K线周期      : ${CONFIG.INTERVAL}  杠杆: ${CONFIG.LEVERAGE}x`);
  console.log(`  回测天数     : ${CONFIG.DAYS} 天`);
  console.log(`  初始本金     : ${CONFIG.CAPITAL.toFixed(2)} USDT`);
  console.log(`  最终资金     : ${finalCapital.toFixed(2)} USDT`);
  console.log(`  总收益率     : ${roi >= 0 ? "+" : ""}${roi.toFixed(2)}%`);
  console.log(`  总盈亏       : ${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(4)} USDT`);
  console.log(dash);
  console.log(`  总交易次数   : ${trades.length}`);
  console.log(`  盈利次数     : ${wins.length}  (胜率 ${winRate.toFixed(1)}%)`);
  console.log(`  亏损次数     : ${losses.length}  (${(100 - winRate).toFixed(1)}%)`);
  console.log(`  平均盈利     : +${avgWin.toFixed(4)} USDT`);
  console.log(`  平均亏损     : -${avgLoss.toFixed(4)} USDT`);
  console.log(`  盈亏比       : ${profitFactor === Infinity ? "∞" : profitFactor.toFixed(2)}`);
  console.log(`  最大回撤     : ${maxDrawdown.toFixed(2)}%`);
  console.log(`  夏普比率     : ${sharpe.toFixed(2)}`);
  console.log(sep);

  console.log("\n📋 最近10笔交易：");
  console.log(
    "入场时间".padEnd(18) +
    "方向".padEnd(6) +
    "入场价".padEnd(12) +
    "出场价".padEnd(12) +
    "盈亏(U)".padEnd(10) +
    "结果"
  );
  console.log("-".repeat(68));
  trades.slice(-10).forEach((t) => {
    console.log(
      t.entryTime.padEnd(18) +
      t.direction.padEnd(6) +
      String(t.entry).padEnd(12) +
      String(t.exit).padEnd(12) +
      (t.pnl >= 0 ? "+" + t.pnl : t.pnl).toString().padEnd(10) +
      `${t.result} (${t.reason})`
    );
  });

  // 资金曲线（ASCII）
  console.log("\n📈 资金曲线（简化ASCII图）：");
  const step = Math.floor(equityCurve.length / 40) || 1;
  const sample = equityCurve.filter((_, i) => i % step === 0);
  const minEq = Math.min(...sample.map((s) => s.equity));
  const maxEq = Math.max(...sample.map((s) => s.equity));
  const height = 8;
  const width = sample.length;

  const grid = Array.from({ length: height }, () => Array(width).fill(" "));
  sample.forEach((s, x) => {
    const y = Math.round(((s.equity - minEq) / (maxEq - minEq || 1)) * (height - 1));
    const row = height - 1 - y;
    grid[row][x] = s.equity >= CONFIG.CAPITAL ? "▲" : "▼";
  });

  console.log(`  ${maxEq.toFixed(0)}U ┐`);
  grid.forEach((row) => console.log("        │" + row.join("")));
  console.log(`  ${minEq.toFixed(0)}U ┘`);
  console.log(`         ${"起".padEnd(Math.floor(width / 2))}终`);
}

// ============================================================
// 保存结果
// ============================================================
const fs = require("fs");

function saveResults(trades, equityCurve) {
  const dir = "/home/node/.openclaw/workspace/gate_strategy";

  // CSV
  const header = "entryTime,exitTime,direction,entry,exit,size,pnl,result,reason\n";
  const rows = trades.map((t) =>
    `${t.entryTime},${t.exitTime},${t.direction},${t.entry},${t.exit},${t.size},${t.pnl},${t.result},${t.reason}`
  ).join("\n");
  fs.writeFileSync(`${dir}/trades.csv`, header + rows);
  console.log(`\n📁 交易记录已保存: ${dir}/trades.csv`);

  // 资金曲线 JSON
  fs.writeFileSync(`${dir}/equity_curve.json`, JSON.stringify(equityCurve, null, 2));
  console.log(`📁 资金曲线已保存: ${dir}/equity_curve.json`);
}

// ============================================================
// 主函数
// ============================================================
async function main() {
  console.log("=".repeat(55));
  console.log(`  Gate.io EMA+RSI 策略回测器 (Node.js)`);
  console.log(`  本金: ${CONFIG.CAPITAL}U  杠杆: ${CONFIG.LEVERAGE}x  周期: ${CONFIG.INTERVAL}`);
  console.log("=".repeat(55));

  const raw = await fetchKlines();
  const candles = addIndicators(raw);
  const valid = candles.filter((c) => c.emaFast && c.emaSlow && c.rsi);

  const start = new Date(valid[0].time * 1000).toISOString().slice(0, 16);
  const end = new Date(valid[valid.length - 1].time * 1000).toISOString().slice(0, 16);
  console.log(`📅 回测区间: ${start} → ${end}  (${valid.length} 根K线)`);

  console.log("⚙️  运行回测中...");
  const { trades, equityCurve, maxDrawdown } = runBacktest(valid);

  printReport(trades, equityCurve, maxDrawdown);
  saveResults(trades, equityCurve);
}

main().catch((e) => { console.error("❌ 错误:", e.message); process.exit(1); });
