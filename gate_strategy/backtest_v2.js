/**
 * Gate.io 策略优化回测器 v2
 * 改进点：
 * 1. 4小时K线（过滤噪音）
 * 2. 200EMA趋势过滤（只做顺势）
 * 3. 止损1.5% + 盈亏比3:1
 * 4. 成交量确认（量能放大才开仓）
 * 5. 杠杆降为5x（控制风险）
 * 6. ADX过滤（只在趋势市场开仓，不做震荡）
 */

const https = require("https");
const fs = require("fs");

// ============================================================
// 对比配置：旧策略 vs 新策略
// ============================================================
const STRATEGIES = {
  "旧策略(15m/10x)": {
    INTERVAL: "15m", LEVERAGE: 10, EMA_FAST: 9, EMA_SLOW: 21,
    EMA_TREND: null,   // 无趋势过滤
    RSI_LOW: 40, RSI_HIGH: 65,
    STOP_PCT: 0.01, REWARD_RATIO: 2,
    VOL_FILTER: false, ADX_FILTER: false,
    POSITION_RATIO: 0.25,
  },
  "优化策略(4h/5x)": {
    INTERVAL: "4h",  LEVERAGE: 5,  EMA_FAST: 9, EMA_SLOW: 21,
    EMA_TREND: 200,  // 200EMA趋势过滤
    RSI_LOW: 45, RSI_HIGH: 60,
    STOP_PCT: 0.015, REWARD_RATIO: 3,
    VOL_FILTER: true,  ADX_FILTER: true,
    POSITION_RATIO: 0.20,
  },
  "中间策略(1h/7x)": {
    INTERVAL: "1h",  LEVERAGE: 7,  EMA_FAST: 9, EMA_SLOW: 21,
    EMA_TREND: 100,  // 100EMA趋势过滤
    RSI_LOW: 42, RSI_HIGH: 62,
    STOP_PCT: 0.012, REWARD_RATIO: 2.5,
    VOL_FILTER: true,  ADX_FILTER: false,
    POSITION_RATIO: 0.22,
  },
};

const CAPITAL = 500;
const DAYS = 180;
const TAKER_FEE = 0.0005;
const MAKER_FEE = 0.0002;

// ============================================================
// HTTP
// ============================================================
function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error("JSON parse error: " + data.slice(0, 100))); }
      });
    }).on("error", reject);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ============================================================
// 获取K线（按周期自动分批）
// ============================================================
async function fetchKlines(symbol, interval, days) {
  const intervalSec = {
    "1m": 60, "5m": 300, "15m": 900,
    "30m": 1800, "1h": 3600, "4h": 14400, "1d": 86400
  }[interval];

  const endTime = Math.floor(Date.now() / 1000);
  const startTime = endTime - days * 86400;
  // Gate每次from+to最多返回约1200根，按1200根分批
  const batchSec = 1200 * intervalSec;

  let all = [];
  let curEnd = endTime;

  while (curEnd > startTime) {
    const curStart = Math.max(curEnd - batchSec, startTime);
    const url = `https://api.gateio.ws/api/v4/futures/usdt/candlesticks` +
      `?contract=${symbol}&from=${curStart}&to=${curEnd}&interval=${interval}`;
    const data = await httpGet(url);
    if (!Array.isArray(data) || data.length === 0) break;
    all = all.concat(data);
    curEnd = curStart - 1;
    process.stdout.write(`    [${interval}] 已获取 ${all.length} 根...\r`);
    await sleep(350);
  }

  return all
    .map((c) => ({
      time: Number(c.t),
      open: parseFloat(c.o),
      high: parseFloat(c.h),
      low: parseFloat(c.l),
      close: parseFloat(c.c),
      volume: parseFloat(c.v),
    }))
    .sort((a, b) => a.time - b.time)
    .filter((c, i, arr) => i === 0 || c.time !== arr[i - 1].time); // 去重
}

// ============================================================
// 技术指标
// ============================================================
function calcEMA(arr, period) {
  const k = 2 / (period + 1);
  const result = new Array(arr.length).fill(null);
  let sum = 0;
  for (let i = 0; i < arr.length; i++) {
    if (i < period - 1) { sum += arr[i]; continue; }
    if (i === period - 1) { sum += arr[i]; result[i] = sum / period; continue; }
    result[i] = arr[i] * k + result[i - 1] * (1 - k);
  }
  return result;
}

function calcRSI(closes, period) {
  const rsi = new Array(closes.length).fill(null);
  let ag = 0, al = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) ag += d / period; else al += (-d) / period;
  }
  rsi[period] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (period - 1) + (d > 0 ? d : 0)) / period;
    al = (al * (period - 1) + (d < 0 ? -d : 0)) / period;
    rsi[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return rsi;
}

function calcATR(candles, period = 14) {
  const tr = candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    const prev = candles[i - 1];
    return Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close));
  });
  // 简单移动平均ATR
  const atr = new Array(candles.length).fill(null);
  for (let i = period - 1; i < candles.length; i++) {
    atr[i] = tr.slice(i - period + 1, i + 1).reduce((s, v) => s + v, 0) / period;
  }
  return atr;
}

function calcADX(candles, period = 14) {
  // 简化ADX：用ATR的相对变化近似趋势强度
  const atr = calcATR(candles, period);
  const adx = new Array(candles.length).fill(null);
  for (let i = period * 2; i < candles.length; i++) {
    // 用价格变化幅度/ATR作为趋势强度代理
    const priceRange = Math.abs(candles[i].close - candles[i - period].close);
    adx[i] = atr[i] > 0 ? (priceRange / (atr[i] * period)) * 100 : 0;
  }
  return adx;
}

function addIndicators(candles, cfg) {
  const closes = candles.map((c) => c.close);
  const volumes = candles.map((c) => c.volume);

  const emaFast = calcEMA(closes, cfg.EMA_FAST);
  const emaSlow = calcEMA(closes, cfg.EMA_SLOW);
  const emaTrend = cfg.EMA_TREND ? calcEMA(closes, cfg.EMA_TREND) : null;
  const rsi = calcRSI(closes, 14);
  const adx = calcADX(candles, 14);

  // 成交量20周期均线
  const volMA = calcEMA(volumes, 20);

  return candles.map((c, i) => ({
    ...c,
    emaFast: emaFast[i],
    emaSlow: emaSlow[i],
    emaTrend: emaTrend ? emaTrend[i] : null,
    rsi: rsi[i],
    adx: adx[i],
    volMA: volMA[i],
  }));
}

// ============================================================
// 信号逻辑
// ============================================================
function getSignal(cur, prev, cfg) {
  if (!cur.emaFast || !cur.emaSlow || !cur.rsi) return "HOLD";

  const crossUp = prev.emaFast < prev.emaSlow && cur.emaFast > cur.emaSlow;
  const crossDown = prev.emaFast > prev.emaSlow && cur.emaFast < cur.emaSlow;

  // 趋势过滤
  if (cfg.EMA_TREND && cur.emaTrend) {
    if (crossUp && cur.close < cur.emaTrend) return "HOLD";   // 价格在趋势均线下方，不做多
    if (crossDown && cur.close > cur.emaTrend) return "HOLD"; // 价格在趋势均线上方，不做空
  }

  // RSI 过滤
  if (crossUp && (cur.rsi < cfg.RSI_LOW || cur.rsi > cfg.RSI_HIGH)) return "HOLD";
  if (crossDown && (cur.rsi < (100 - cfg.RSI_HIGH) || cur.rsi > (100 - cfg.RSI_LOW))) return "HOLD";

  // 成交量过滤：当前量 > 均量的1.2倍
  if (cfg.VOL_FILTER && cur.volMA && cur.volume < cur.volMA * 1.2) return "HOLD";

  // ADX过滤：趋势强度 > 20 才开仓
  if (cfg.ADX_FILTER && cur.adx !== null && cur.adx < 20) return "HOLD";

  if (crossUp) return "LONG";
  if (crossDown) return "SHORT";
  return "HOLD";
}

// ============================================================
// 回测引擎
// ============================================================
function runBacktest(candles, cfg) {
  let capital = CAPITAL;
  const trades = [];
  const equity = [{ time: candles[0].time, v: capital }];
  let pos = null;
  let maxEq = capital, maxDD = 0;

  for (let i = 1; i < candles.length; i++) {
    const cur = candles[i];
    const prev = candles[i - 1];

    if (pos) {
      let hitSL = false, hitTP = false;
      if (pos.dir === "LONG") {
        if (cur.low <= pos.sl) hitSL = true;
        else if (cur.high >= pos.tp) hitTP = true;
      } else {
        if (cur.high >= pos.sl) hitSL = true;
        else if (cur.low <= pos.tp) hitTP = true;
      }

      if (hitSL || hitTP) {
        const exitPrice = hitSL ? pos.sl : pos.tp;
        const pnlPct = pos.dir === "LONG"
          ? (exitPrice - pos.entry) / pos.entry
          : (pos.entry - exitPrice) / pos.entry;
        const fee = pos.size * (TAKER_FEE + MAKER_FEE) * cfg.LEVERAGE;
        const pnl = pnlPct * pos.size * cfg.LEVERAGE - fee;
        capital = Math.max(capital + pnl, 0);

        trades.push({
          entryTime: new Date(pos.t * 1000).toISOString().slice(0, 16),
          exitTime: new Date(cur.time * 1000).toISOString().slice(0, 16),
          dir: pos.dir, entry: pos.entry, exit: exitPrice,
          size: pos.size, pnl: +pnl.toFixed(4),
          win: pnl > 0, reason: hitTP ? "止盈" : "止损",
        });

        if (capital > maxEq) maxEq = capital;
        const dd = ((maxEq - capital) / maxEq) * 100;
        if (dd > maxDD) maxDD = dd;
        pos = null;
        if (capital < CAPITAL * 0.3) break; // 熔断70%
      }
    }

    if (!pos) {
      const sig = getSignal(cur, prev, cfg);
      if (sig === "LONG" || sig === "SHORT") {
        const size = +(capital * cfg.POSITION_RATIO).toFixed(2);
        const takePct = cfg.STOP_PCT * cfg.REWARD_RATIO;
        const sl = sig === "LONG"
          ? +(cur.close * (1 - cfg.STOP_PCT)).toFixed(2)
          : +(cur.close * (1 + cfg.STOP_PCT)).toFixed(2);
        const tp = sig === "LONG"
          ? +(cur.close * (1 + takePct)).toFixed(2)
          : +(cur.close * (1 - takePct)).toFixed(2);
        pos = { dir: sig, entry: cur.close, sl, tp, size, t: cur.time };
      }
    }

    equity.push({ time: cur.time, v: +capital.toFixed(2) });
  }

  return { trades, equity, maxDD: +maxDD.toFixed(2) };
}

// ============================================================
// 统计
// ============================================================
function calcStats(trades, equity, maxDD, name) {
  if (!trades.length) return null;
  const wins = trades.filter((t) => t.win);
  const losses = trades.filter((t) => !t.win);
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const winPnl = wins.reduce((s, t) => s + t.pnl, 0);
  const lossPnl = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const winRate = (wins.length / trades.length) * 100;
  const finalCap = equity[equity.length - 1].v;
  const roi = ((finalCap - CAPITAL) / CAPITAL) * 100;
  const pnls = trades.map((t) => t.pnl);
  const mean = pnls.reduce((s, v) => s + v, 0) / pnls.length;
  const std = Math.sqrt(pnls.map((v) => (v - mean) ** 2).reduce((s, v) => s + v, 0) / pnls.length);
  const sharpe = std > 0 ? (mean / std) * Math.sqrt(252) : 0;
  const pf = lossPnl > 0 ? winPnl / lossPnl : Infinity;

  return {
    name,
    total: trades.length,
    winCount: wins.length,
    winRate: +winRate.toFixed(1),
    avgWin: wins.length ? +(winPnl / wins.length).toFixed(4) : 0,
    avgLoss: losses.length ? +(lossPnl / losses.length).toFixed(4) : 0,
    profitFactor: pf === Infinity ? 999 : +pf.toFixed(2),
    maxDD,
    sharpe: +sharpe.toFixed(2),
    finalCap: +finalCap.toFixed(2),
    roi: +roi.toFixed(2),
    totalPnl: +totalPnl.toFixed(4),
    equity,
  };
}

// ============================================================
// 打印对比报告
// ============================================================
function printCompare(results) {
  const sep = "=".repeat(65);
  const dash = "-".repeat(65);
  console.log("\n" + sep);
  console.log("              📊 策略对比回测报告");
  console.log(sep);
  console.log(
    "指标".padEnd(18) +
    results.map((r) => r.name.padEnd(22)).join("")
  );
  console.log(dash);

  const rows = [
    ["初始本金", () => `${CAPITAL} USDT`],
    ["最终资金", (r) => `${r.finalCap} USDT`],
    ["总收益率", (r) => `${r.roi >= 0 ? "+" : ""}${r.roi}%`],
    ["总盈亏", (r) => `${r.totalPnl >= 0 ? "+" : ""}${r.totalPnl} U`],
    ["总交易次数", (r) => `${r.total}`],
    ["胜率", (r) => `${r.winRate}%`],
    ["平均盈利", (r) => `+${r.avgWin} U`],
    ["平均亏损", (r) => `-${r.avgLoss} U`],
    ["盈亏比", (r) => `${r.profitFactor === 999 ? "∞" : r.profitFactor}`],
    ["最大回撤", (r) => `${r.maxDD}%`],
    ["夏普比率", (r) => `${r.sharpe}`],
  ];

  for (const [label, fn] of rows) {
    const line = label.padEnd(18) + results.map((r) => {
      const val = typeof fn === "function" ? fn(r) : fn();
      return val.padEnd(22);
    }).join("");
    console.log(line);
  }
  console.log(sep);

  // 找出最佳策略
  const best = results.reduce((a, b) => a.roi > b.roi ? a : b);
  console.log(`\n🏆 最优策略: ${best.name}  ROI: ${best.roi >= 0 ? "+" : ""}${best.roi}%  胜率: ${best.winRate}%`);

  // 最近5笔对比
  for (const r of results) {
    console.log(`\n📋 ${r.name} 最近5笔：`);
    console.log("入场时间         方向  入场价        出场价        盈亏       结果");
    console.log("-".repeat(68));
    const last5 = r.equity.length > 0 ? [] : [];
    // 从trades里取（需要传入）
  }
}

function printAllTrades(allResults) {
  for (const { stats, trades } of allResults) {
    const last5 = trades.slice(-5);
    if (!last5.length) continue;
    console.log(`\n📋 ${stats.name} 最近5笔交易：`);
    console.log("入场时间          方向   入场价        出场价        盈亏(U)   结果");
    console.log("-".repeat(72));
    for (const t of last5) {
      console.log(
        t.entryTime.padEnd(18) +
        t.dir.padEnd(7) +
        String(t.entry).padEnd(14) +
        String(t.exit).padEnd(14) +
        ((t.pnl >= 0 ? "+" : "") + t.pnl).toString().padEnd(10) +
        (t.win ? "✅ WIN" : "❌ LOSS") + ` (${t.reason})`
      );
    }
  }
}

function asciiEquity(equity, label) {
  const step = Math.max(1, Math.floor(equity.length / 50));
  const sample = equity.filter((_, i) => i % step === 0).map((e) => e.v);
  const minV = Math.min(...sample);
  const maxV = Math.max(...sample);
  const H = 6, W = sample.length;
  const grid = Array.from({ length: H }, () => Array(W).fill(" "));
  sample.forEach((v, x) => {
    const y = H - 1 - Math.round(((v - minV) / (maxV - minV || 1)) * (H - 1));
    grid[y][x] = v >= CAPITAL ? "█" : "░";
  });
  console.log(`\n  ${label} 资金曲线：`);
  console.log(`  ${maxV.toFixed(0)}U ┐`);
  grid.forEach((row) => console.log("       │" + row.join("")));
  console.log(`  ${minV.toFixed(0)}U ┘`);
}

// ============================================================
// 主函数
// ============================================================
async function main() {
  console.log("=".repeat(65));
  console.log("     Gate.io 策略优化对比回测器 v2");
  console.log(`     本金: ${CAPITAL}U  回测天数: ${DAYS}天`);
  console.log("=".repeat(65));

  // 缓存已下载的K线，避免重复请求
  const klineCache = {};

  const allResults = [];

  for (const [name, cfg] of Object.entries(STRATEGIES)) {
    console.log(`\n⚙️  回测策略: ${name}`);
    console.log(`   周期=${cfg.INTERVAL} 杠杆=${cfg.LEVERAGE}x 止损=${cfg.STOP_PCT*100}% 盈亏比=1:${cfg.REWARD_RATIO}`);

    if (!klineCache[cfg.INTERVAL]) {
      klineCache[cfg.INTERVAL] = await fetchKlines("BTC_USDT", cfg.INTERVAL, DAYS);
    }
    const raw = klineCache[cfg.INTERVAL];
    const candles = addIndicators(raw, cfg).filter(
      (c) => c.emaFast && c.emaSlow && c.rsi !== null
    );

    const start = new Date(candles[0].time * 1000).toISOString().slice(0, 10);
    const end = new Date(candles[candles.length - 1].time * 1000).toISOString().slice(0, 10);
    console.log(`   区间: ${start} → ${end}  共 ${candles.length} 根K线`);

    const { trades, equity, maxDD } = runBacktest(candles, cfg);
    const stats = calcStats(trades, equity, maxDD, name);
    allResults.push({ stats, trades });
    console.log(`   ✅ 完成: ${trades.length}笔交易  ROI: ${stats.roi >= 0 ? "+" : ""}${stats.roi}%  胜率: ${stats.winRate}%`);
  }

  // 打印对比表
  printCompare(allResults.map((r) => r.stats));
  printAllTrades(allResults);

  // ASCII资金曲线
  for (const { stats } of allResults) {
    asciiEquity(stats.equity, stats.name);
  }

  // 保存CSV
  const dir = "/home/node/.openclaw/workspace/gate_strategy";
  for (const { stats, trades } of allResults) {
    if (!trades.length) continue;
    const safeName = stats.name.replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, "_");
    const header = "entryTime,exitTime,dir,entry,exit,size,pnl,win,reason\n";
    const rows = trades.map((t) =>
      `${t.entryTime},${t.exitTime},${t.dir},${t.entry},${t.exit},${t.size},${t.pnl},${t.win},${t.reason}`
    ).join("\n");
    fs.writeFileSync(`${dir}/trades_${safeName}.csv`, header + rows);
  }

  // 汇总JSON
  const summary = allResults.map(({ stats }) => ({
    name: stats.name,
    roi: stats.roi,
    winRate: stats.winRate,
    sharpe: stats.sharpe,
    maxDD: stats.maxDD,
    profitFactor: stats.profitFactor,
    totalTrades: stats.total,
    finalCap: stats.finalCap,
  }));
  fs.writeFileSync(`${dir}/backtest_summary.json`, JSON.stringify(summary, null, 2));
  console.log(`\n📁 结果已保存至: ${dir}/`);
}

main().catch((e) => { console.error("❌ 错误:", e.message); process.exit(1); });
