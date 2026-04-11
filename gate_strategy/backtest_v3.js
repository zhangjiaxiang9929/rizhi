/**
 * Gate.io 平衡型策略回测器 v3
 * 基于优化策略(4h/5x)放宽条件，提高信号频率同时保持质量
 * 改动：
 *   - ADX阈值 20 → 15
 *   - RSI范围 45-60 → 40-65
 *   - 同时回测 BTC / ETH / SOL 三个币种
 *   - 汇总多币种总收益
 */

const https = require("https");
const fs = require("fs");

// ============================================================
// 平衡型策略参数
// ============================================================
const CFG = {
  LEVERAGE: 5,
  EMA_FAST: 9,
  EMA_SLOW: 21,
  EMA_TREND: 200,
  RSI_LOW: 40,       // 放宽（原45）
  RSI_HIGH: 65,      // 放宽（原60）
  STOP_PCT: 0.015,
  REWARD_RATIO: 3,
  VOL_FILTER: true,
  ADX_THRESHOLD: 15, // 放宽（原20）
  POSITION_RATIO: 0.20,
  INTERVAL: "4h",
  DAYS: 180,
};

const SYMBOLS = ["BTC_USDT", "ETH_USDT", "SOL_USDT"];
const CAPITAL_PER_SYMBOL = 500 / SYMBOLS.length; // 每币种分配资金
const TAKER_FEE = 0.0005;
const MAKER_FEE = 0.0002;

// ============================================================
// 网络
// ============================================================
function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => {
        try { resolve(JSON.parse(d)); }
        catch (e) { reject(new Error("JSON err: " + d.slice(0, 80))); }
      });
    }).on("error", reject);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ============================================================
// 获取K线
// ============================================================
async function fetchKlines(symbol) {
  const intervalSec = 14400; // 4h
  const endTime = Math.floor(Date.now() / 1000);
  const startTime = endTime - CFG.DAYS * 86400;
  const batchSec = 1200 * intervalSec;

  let all = [], curEnd = endTime;
  process.stdout.write(`  📥 ${symbol} K线获取中...`);
  while (curEnd > startTime) {
    const curStart = Math.max(curEnd - batchSec, startTime);
    const url = `https://api.gateio.ws/api/v4/futures/usdt/candlesticks` +
      `?contract=${symbol}&from=${curStart}&to=${curEnd}&interval=${CFG.INTERVAL}`;
    const data = await httpGet(url);
    if (!Array.isArray(data) || data.length === 0) break;
    all = all.concat(data);
    curEnd = curStart - 1;
    await sleep(350);
  }
  console.log(` ${all.length}根`);

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
    .filter((c, i, arr) => i === 0 || c.time !== arr[i - 1].time);
}

// ============================================================
// 指标
// ============================================================
function calcEMA(arr, p) {
  const k = 2 / (p + 1), r = new Array(arr.length).fill(null);
  let s = 0;
  for (let i = 0; i < arr.length; i++) {
    if (i < p - 1) { s += arr[i]; continue; }
    if (i === p - 1) { s += arr[i]; r[i] = s / p; continue; }
    r[i] = arr[i] * k + r[i - 1] * (1 - k);
  }
  return r;
}

function calcRSI(closes, p) {
  const r = new Array(closes.length).fill(null);
  let ag = 0, al = 0;
  for (let i = 1; i <= p; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) ag += d / p; else al += (-d) / p;
  }
  r[p] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  for (let i = p + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (p - 1) + (d > 0 ? d : 0)) / p;
    al = (al * (p - 1) + (d < 0 ? -d : 0)) / p;
    r[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return r;
}

function calcATR(candles, p = 14) {
  const tr = candles.map((c, i) =>
    i === 0 ? c.high - c.low
      : Math.max(c.high - c.low, Math.abs(c.high - candles[i - 1].close), Math.abs(c.low - candles[i - 1].close))
  );
  const atr = new Array(candles.length).fill(null);
  for (let i = p - 1; i < candles.length; i++)
    atr[i] = tr.slice(i - p + 1, i + 1).reduce((s, v) => s + v, 0) / p;
  return atr;
}

function calcADX(candles, p = 14) {
  const atr = calcATR(candles, p);
  const adx = new Array(candles.length).fill(null);
  for (let i = p * 2; i < candles.length; i++) {
    const range = Math.abs(candles[i].close - candles[i - p].close);
    adx[i] = atr[i] > 0 ? (range / (atr[i] * p)) * 100 : 0;
  }
  return adx;
}

function addIndicators(candles) {
  const closes = candles.map((c) => c.close);
  const vols = candles.map((c) => c.volume);
  const emaFast = calcEMA(closes, CFG.EMA_FAST);
  const emaSlow = calcEMA(closes, CFG.EMA_SLOW);
  const emaTrend = calcEMA(closes, CFG.EMA_TREND);
  const rsi = calcRSI(closes, 14);
  const adx = calcADX(candles, 14);
  const volMA = calcEMA(vols, 20);
  return candles.map((c, i) => ({
    ...c, emaFast: emaFast[i], emaSlow: emaSlow[i],
    emaTrend: emaTrend[i], rsi: rsi[i], adx: adx[i], volMA: volMA[i],
  }));
}

// ============================================================
// 信号
// ============================================================
function getSignal(cur, prev) {
  if (!cur.emaFast || !cur.emaSlow || cur.rsi === null || !cur.emaTrend) return "HOLD";

  const crossUp = prev.emaFast < prev.emaSlow && cur.emaFast > cur.emaSlow;
  const crossDown = prev.emaFast > prev.emaSlow && cur.emaFast < cur.emaSlow;

  // 200EMA趋势过滤
  if (crossUp && cur.close < cur.emaTrend) return "HOLD";
  if (crossDown && cur.close > cur.emaTrend) return "HOLD";

  // RSI过滤（放宽版）
  if (crossUp && (cur.rsi < CFG.RSI_LOW || cur.rsi > CFG.RSI_HIGH)) return "HOLD";
  if (crossDown && (cur.rsi < (100 - CFG.RSI_HIGH) || cur.rsi > (100 - CFG.RSI_LOW))) return "HOLD";

  // 成交量确认
  if (cur.volMA && cur.volume < cur.volMA * 1.1) return "HOLD"; // 放宽到1.1倍

  // ADX趋势强度（放宽版）
  if (cur.adx !== null && cur.adx < CFG.ADX_THRESHOLD) return "HOLD";

  if (crossUp) return "LONG";
  if (crossDown) return "SHORT";
  return "HOLD";
}

// ============================================================
// 回测引擎
// ============================================================
function runBacktest(candles, initCapital) {
  let capital = initCapital;
  const trades = [];
  const equity = [{ time: candles[0].time, v: capital }];
  let pos = null, maxEq = capital, maxDD = 0;

  for (let i = 1; i < candles.length; i++) {
    const cur = candles[i], prev = candles[i - 1];

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
        const fee = pos.size * (TAKER_FEE + MAKER_FEE) * CFG.LEVERAGE;
        const pnl = pnlPct * pos.size * CFG.LEVERAGE - fee;
        capital = Math.max(capital + pnl, 0);

        trades.push({
          entryTime: fmtTime(pos.t),
          exitTime: fmtTime(cur.time),
          dir: pos.dir,
          entry: pos.entry,
          exit: exitPrice,
          size: pos.size,
          pnl: +pnl.toFixed(4),
          win: pnl > 0,
          reason: hitTP ? "止盈" : "止损",
          holdBars: i - pos.startIdx,
        });

        if (capital > maxEq) maxEq = capital;
        const dd = ((maxEq - capital) / maxEq) * 100;
        if (dd > maxDD) maxDD = dd;
        pos = null;
        if (capital < initCapital * 0.3) { console.log("  ⛔ 熔断触发"); break; }
      }
    }

    if (!pos) {
      const sig = getSignal(cur, prev);
      if (sig === "LONG" || sig === "SHORT") {
        const size = +(capital * CFG.POSITION_RATIO).toFixed(2);
        const takePct = CFG.STOP_PCT * CFG.REWARD_RATIO;
        const sl = sig === "LONG"
          ? +(cur.close * (1 - CFG.STOP_PCT)).toFixed(2)
          : +(cur.close * (1 + CFG.STOP_PCT)).toFixed(2);
        const tp = sig === "LONG"
          ? +(cur.close * (1 + takePct)).toFixed(2)
          : +(cur.close * (1 - takePct)).toFixed(2);
        pos = { dir: sig, entry: cur.close, sl, tp, size, t: cur.time, startIdx: i };
      }
    }

    equity.push({ time: cur.time, v: +capital.toFixed(2) });
  }

  return { trades, equity, maxDD: +maxDD.toFixed(2) };
}

// ============================================================
// 工具
// ============================================================
function fmtTime(ts) { return new Date(ts * 1000).toISOString().slice(0, 16); }

function stats(trades, equity, maxDD, symbol, initCapital) {
  const wins = trades.filter((t) => t.win);
  const losses = trades.filter((t) => !t.win);
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const winPnl = wins.reduce((s, t) => s + t.pnl, 0);
  const lossPnl = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const winRate = trades.length ? (wins.length / trades.length * 100) : 0;
  const final = equity[equity.length - 1].v;
  const roi = ((final - initCapital) / initCapital) * 100;
  const pf = lossPnl > 0 ? winPnl / lossPnl : (winPnl > 0 ? 999 : 0);
  const avgHold = trades.length ? trades.reduce((s, t) => s + t.holdBars, 0) / trades.length : 0;
  const pnls = trades.map((t) => t.pnl);
  const mean = pnls.length ? pnls.reduce((s, v) => s + v, 0) / pnls.length : 0;
  const std = pnls.length > 1
    ? Math.sqrt(pnls.map((v) => (v - mean) ** 2).reduce((s, v) => s + v, 0) / pnls.length) : 1;
  const sharpe = std > 0 ? (mean / std) * Math.sqrt(252) : 0;

  return {
    symbol, total: trades.length,
    winCount: wins.length, lossCount: losses.length,
    winRate: +winRate.toFixed(1),
    avgWin: wins.length ? +(winPnl / wins.length).toFixed(2) : 0,
    avgLoss: losses.length ? +(lossPnl / losses.length).toFixed(2) : 0,
    profitFactor: +pf.toFixed(2),
    maxDD, sharpe: +sharpe.toFixed(2),
    finalCap: +final.toFixed(2), roi: +roi.toFixed(2),
    totalPnl: +totalPnl.toFixed(2),
    avgHoldBars: +avgHold.toFixed(1),
    initCapital,
  };
}

function printSymbolReport(st, trades) {
  const sep = "─".repeat(55);
  const emoji = st.roi >= 0 ? "🟢" : "🔴";
  console.log(`\n${sep}`);
  console.log(`  ${emoji} ${st.symbol}   (分配资金: ${st.initCapital}U)`);
  console.log(sep);
  console.log(`  最终资金     : ${st.finalCap} USDT`);
  console.log(`  总收益率     : ${st.roi >= 0 ? "+" : ""}${st.roi}%  (${st.roi >= 0 ? "+" : ""}${st.totalPnl}U)`);
  console.log(`  交易次数     : ${st.total}次  (平均持仓 ${st.avgHoldBars} 根K线 ≈ ${(st.avgHoldBars * 4).toFixed(0)}h)`);
  console.log(`  胜率         : ${st.winRate}%  (盈${st.winCount} / 亏${st.lossCount})`);
  console.log(`  平均盈利     : +${st.avgWin}U  | 平均亏损: -${st.avgLoss}U`);
  console.log(`  盈亏比       : ${st.profitFactor === 999 ? "∞" : st.profitFactor}`);
  console.log(`  最大回撤     : ${st.maxDD}%`);
  console.log(`  夏普比率     : ${st.sharpe}`);

  if (trades.length > 0) {
    console.log(`\n  📋 所有交易记录：`);
    console.log("  " + "入场时间         方向   入场价          出场价          盈亏(U)    结果");
    console.log("  " + "─".repeat(75));
    for (const t of trades) {
      const pnlStr = (t.pnl >= 0 ? "+" + t.pnl : String(t.pnl)).padEnd(10);
      const result = t.win ? "✅ WIN" : "❌ LOSS";
      console.log(
        "  " +
        t.entryTime.padEnd(18) +
        t.dir.padEnd(7) +
        String(t.entry).padEnd(16) +
        String(t.exit).padEnd(16) +
        pnlStr +
        `${result} (${t.reason})`
      );
    }
  } else {
    console.log("  ⚠️  本币种无触发信号（条件未满足）");
  }
}

function asciiChart(equity, label, initCapital) {
  const step = Math.max(1, Math.floor(equity.length / 55));
  const s = equity.filter((_, i) => i % step === 0).map((e) => e.v);
  const lo = Math.min(...s), hi = Math.max(...s);
  const H = 7, W = s.length;
  const grid = Array.from({ length: H }, () => Array(W).fill(" "));
  s.forEach((v, x) => {
    const y = H - 1 - Math.round(((v - lo) / (hi - lo || 1)) * (H - 1));
    grid[Math.max(0, Math.min(H - 1, y))][x] = v >= initCapital ? "█" : "░";
  });
  const roiLine = `  ${label}`;
  console.log(`\n${roiLine}`);
  console.log(`  ${hi.toFixed(0)}U ┐`);
  grid.forEach((row) => console.log("       │" + row.join("")));
  console.log(`  ${lo.toFixed(0)}U ┘`);
}

// ============================================================
// 主函数
// ============================================================
async function main() {
  console.log("=".repeat(60));
  console.log("   Gate.io 平衡型策略 — 多币种回测 v3");
  console.log(`   参数: 4h K线 | 5x杠杆 | 止损1.5% | 盈亏比1:3`);
  console.log(`   RSI: ${CFG.RSI_LOW}-${CFG.RSI_HIGH} | ADX≥${CFG.ADX_THRESHOLD} | 量能×1.1 | 200EMA趋势`);
  console.log(`   币种: ${SYMBOLS.join(" / ")}  (各分 ${CAPITAL_PER_SYMBOL.toFixed(0)}U)`);
  console.log("=".repeat(60));

  const allStats = [], allTrades = [], allEquity = [];

  for (const sym of SYMBOLS) {
    const raw = await fetchKlines(sym);
    const candles = addIndicators(raw).filter((c) => c.emaFast && c.emaTrend && c.rsi !== null);
    const { trades, equity, maxDD } = runBacktest(candles, CAPITAL_PER_SYMBOL);
    const st = stats(trades, equity, maxDD, sym, CAPITAL_PER_SYMBOL);
    allStats.push(st);
    allTrades.push(trades);
    allEquity.push(equity);
  }

  // 单币种报告
  allStats.forEach((st, i) => printSymbolReport(st, allTrades[i]));

  // 汇总
  const totalInit = CAPITAL_PER_SYMBOL * SYMBOLS.length;
  const totalFinal = allStats.reduce((s, st) => s + st.finalCap, 0);
  const totalPnl = allStats.reduce((s, st) => s + st.totalPnl, 0);
  const totalROI = ((totalFinal - totalInit) / totalInit * 100);
  const totalTrades = allStats.reduce((s, st) => s + st.total, 0);
  const totalWins = allStats.reduce((s, st) => s + st.winCount, 0);
  const overallWR = totalTrades ? (totalWins / totalTrades * 100) : 0;
  const worstDD = Math.max(...allStats.map((st) => st.maxDD));

  console.log("\n" + "=".repeat(60));
  console.log("   🏦 多币种组合汇总");
  console.log("=".repeat(60));
  console.log(`  初始总资金   : ${totalInit.toFixed(0)} USDT`);
  console.log(`  最终总资金   : ${totalFinal.toFixed(2)} USDT`);
  console.log(`  组合总收益   : ${totalROI >= 0 ? "+" : ""}${totalROI.toFixed(2)}%  (${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(2)}U)`);
  console.log(`  总交易次数   : ${totalTrades}`);
  console.log(`  综合胜率     : ${overallWR.toFixed(1)}%`);
  console.log(`  最大单币回撤 : ${worstDD}%`);
  const winner = allStats.reduce((a, b) => a.roi > b.roi ? a : b);
  console.log(`  最佳表现币种 : ${winner.symbol}  ROI ${winner.roi >= 0 ? "+" : ""}${winner.roi}%`);
  console.log("=".repeat(60));

  // ASCII资金曲线
  allStats.forEach((st, i) => {
    asciiChart(allEquity[i], `${st.symbol}  ROI: ${st.roi >= 0 ? "+" : ""}${st.roi}%`, st.initCapital);
  });

  // 保存结果
  const dir = "/home/node/.openclaw/workspace/gate_strategy";
  const summary = {
    strategy: "平衡型 4h/5x",
    params: CFG,
    symbols: SYMBOLS,
    totalInit, totalFinal: +totalFinal.toFixed(2),
    totalROI: +totalROI.toFixed(2),
    totalPnl: +totalPnl.toFixed(2),
    results: allStats,
  };
  fs.writeFileSync(`${dir}/backtest_v3_summary.json`, JSON.stringify(summary, null, 2));

  for (let i = 0; i < SYMBOLS.length; i++) {
    if (!allTrades[i].length) continue;
    const header = "entryTime,exitTime,dir,entry,exit,size,pnl,win,reason,holdBars\n";
    const rows = allTrades[i].map((t) =>
      `${t.entryTime},${t.exitTime},${t.dir},${t.entry},${t.exit},${t.size},${t.pnl},${t.win},${t.reason},${t.holdBars}`
    ).join("\n");
    fs.writeFileSync(`${dir}/trades_v3_${SYMBOLS[i]}.csv`, header + rows);
  }
  console.log(`\n📁 结果已保存: ${dir}/backtest_v3_summary.json`);
}

main().catch((e) => { console.error("❌ 错误:", e.message, e.stack); process.exit(1); });
