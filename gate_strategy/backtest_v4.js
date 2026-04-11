/**
 * Gate.io 平衡型策略 — 10币种扩展回测 v4
 * 策略: 4h K线 | 5x杠杆 | 200EMA趋势 | RSI 40-65 | ADX≥15 | 量能×1.1
 * 币种: BTC ETH SOL BNB XRP DOGE LINK AVAX DOT ADA
 * 资金: 500U 平均分配，每币50U
 */

const https = require("https");
const fs = require("fs");

// ============================================================
// 配置
// ============================================================
const CFG = {
  LEVERAGE: 5,
  EMA_FAST: 9, EMA_SLOW: 21, EMA_TREND: 200,
  RSI_LOW: 40, RSI_HIGH: 65,
  STOP_PCT: 0.015, REWARD_RATIO: 3,
  VOL_MULT: 1.1,
  ADX_THRESHOLD: 15,
  POSITION_RATIO: 0.20,
  INTERVAL: "4h",
  DAYS: 180,
};

const SYMBOLS = [
  "BTC_USDT", "ETH_USDT", "SOL_USDT", "BNB_USDT",
  "XRP_USDT", "DOGE_USDT", "LINK_USDT", "AVAX_USDT",
  "DOT_USDT", "ADA_USDT",
];

const TOTAL_CAPITAL = 500;
const CAPITAL_PER = TOTAL_CAPITAL / SYMBOLS.length; // 50U 每币
const TAKER_FEE = 0.0005, MAKER_FEE = 0.0002;

// ============================================================
// 网络
// ============================================================
const httpGet = (url) => new Promise((resolve, reject) => {
  https.get(url, (res) => {
    let d = "";
    res.on("data", (c) => (d += c));
    res.on("end", () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
  }).on("error", reject);
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (ts) => new Date(ts * 1000).toISOString().slice(0, 16);

// ============================================================
// 获取K线
// ============================================================
async function fetchKlines(symbol) {
  const batchSec = 1200 * 14400;
  const endTime = Math.floor(Date.now() / 1000);
  const startTime = endTime - CFG.DAYS * 86400;
  let all = [], curEnd = endTime;

  while (curEnd > startTime) {
    const curStart = Math.max(curEnd - batchSec, startTime);
    const url = `https://api.gateio.ws/api/v4/futures/usdt/candlesticks` +
      `?contract=${symbol}&from=${curStart}&to=${curEnd}&interval=${CFG.INTERVAL}`;
    try {
      const data = await httpGet(url);
      if (!Array.isArray(data) || data.length === 0) break;
      all = all.concat(data);
      curEnd = curStart - 1;
    } catch (e) {
      // 某些小币种可能不支持合约，跳过
      return null;
    }
    await sleep(300);
  }

  if (all.length === 0) return null;
  return all
    .map((c) => ({
      time: Number(c.t), open: +c.o, high: +c.h, low: +c.l, close: +c.c, volume: +c.v,
    }))
    .sort((a, b) => a.time - b.time)
    .filter((c, i, arr) => i === 0 || c.time !== arr[i - 1].time);
}

// ============================================================
// 指标
// ============================================================
function ema(arr, p) {
  const k = 2 / (p + 1), r = Array(arr.length).fill(null);
  let s = 0;
  for (let i = 0; i < arr.length; i++) {
    if (i < p - 1) { s += arr[i]; continue; }
    if (i === p - 1) { s += arr[i]; r[i] = s / p; continue; }
    r[i] = arr[i] * k + r[i - 1] * (1 - k);
  }
  return r;
}

function rsi(closes, p = 14) {
  const r = Array(closes.length).fill(null);
  let ag = 0, al = 0;
  for (let i = 1; i <= p; i++) {
    const d = closes[i] - closes[i - 1];
    d > 0 ? (ag += d / p) : (al += -d / p);
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

function adxProxy(candles, p = 14) {
  // ATR
  const tr = candles.map((c, i) =>
    i === 0 ? c.high - c.low
      : Math.max(c.high - c.low, Math.abs(c.high - candles[i-1].close), Math.abs(c.low - candles[i-1].close))
  );
  const atr = Array(candles.length).fill(null);
  for (let i = p - 1; i < candles.length; i++)
    atr[i] = tr.slice(i - p + 1, i + 1).reduce((s, v) => s + v, 0) / p;

  const adx = Array(candles.length).fill(null);
  for (let i = p * 2; i < candles.length; i++) {
    const range = Math.abs(candles[i].close - candles[i - p].close);
    adx[i] = atr[i] > 0 ? (range / (atr[i] * p)) * 100 : 0;
  }
  return adx;
}

function buildCandles(raw) {
  const closes = raw.map((c) => c.close);
  const vols   = raw.map((c) => c.volume);
  const ef = ema(closes, CFG.EMA_FAST);
  const es = ema(closes, CFG.EMA_SLOW);
  const et = ema(closes, CFG.EMA_TREND);
  const ri = rsi(closes, 14);
  const ad = adxProxy(raw, 14);
  const vm = ema(vols, 20);
  return raw.map((c, i) => ({
    ...c, emaFast: ef[i], emaSlow: es[i], emaTrend: et[i],
    rsi: ri[i], adx: ad[i], volMA: vm[i],
  }));
}

// ============================================================
// 信号
// ============================================================
function signal(cur, prev) {
  if (!cur.emaFast || !cur.emaTrend || cur.rsi === null) return "HOLD";
  const up   = prev.emaFast < prev.emaSlow && cur.emaFast > cur.emaSlow;
  const down = prev.emaFast > prev.emaSlow && cur.emaFast < cur.emaSlow;
  if (up   && cur.close < cur.emaTrend) return "HOLD";
  if (down && cur.close > cur.emaTrend) return "HOLD";
  if (up   && (cur.rsi < CFG.RSI_LOW || cur.rsi > CFG.RSI_HIGH)) return "HOLD";
  if (down && (cur.rsi < (100 - CFG.RSI_HIGH) || cur.rsi > (100 - CFG.RSI_LOW))) return "HOLD";
  if (cur.volMA && cur.volume < cur.volMA * CFG.VOL_MULT) return "HOLD";
  if (cur.adx !== null && cur.adx < CFG.ADX_THRESHOLD) return "HOLD";
  if (up)   return "LONG";
  if (down) return "SHORT";
  return "HOLD";
}

// ============================================================
// 回测
// ============================================================
function backtest(candles, initCap) {
  let cap = initCap, pos = null, maxEq = initCap, maxDD = 0;
  const trades = [], equity = [{ time: candles[0].time, v: cap }];

  for (let i = 1; i < candles.length; i++) {
    const cur = candles[i], prev = candles[i - 1];

    if (pos) {
      const hitSL = pos.dir === "LONG" ? cur.low  <= pos.sl : cur.high >= pos.sl;
      const hitTP = pos.dir === "LONG" ? cur.high >= pos.tp : cur.low  <= pos.tp;
      if (hitSL || hitTP) {
        const exit = hitSL ? pos.sl : pos.tp;
        const pnlPct = pos.dir === "LONG"
          ? (exit - pos.entry) / pos.entry
          : (pos.entry - exit) / pos.entry;
        const fee = pos.size * (TAKER_FEE + MAKER_FEE) * CFG.LEVERAGE;
        const pnl = pnlPct * pos.size * CFG.LEVERAGE - fee;
        cap = Math.max(cap + pnl, 0);
        trades.push({
          sym: pos.sym,
          entryTime: fmt(pos.t), exitTime: fmt(cur.time),
          dir: pos.dir, entry: pos.entry, exit,
          size: pos.size, pnl: +pnl.toFixed(4),
          win: pnl > 0, reason: hitTP ? "止盈" : "止损",
          holdBars: i - pos.startIdx,
        });
        if (cap > maxEq) maxEq = cap;
        const dd = (maxEq - cap) / maxEq * 100;
        if (dd > maxDD) maxDD = dd;
        pos = null;
        if (cap < initCap * 0.3) break;
      }
    }

    if (!pos) {
      const sig = signal(cur, prev);
      if (sig !== "HOLD") {
        const size = +(cap * CFG.POSITION_RATIO).toFixed(2);
        const takePct = CFG.STOP_PCT * CFG.REWARD_RATIO;
        const sl = sig === "LONG"
          ? +(cur.close * (1 - CFG.STOP_PCT)).toFixed(4)
          : +(cur.close * (1 + CFG.STOP_PCT)).toFixed(4);
        const tp = sig === "LONG"
          ? +(cur.close * (1 + takePct)).toFixed(4)
          : +(cur.close * (1 - takePct)).toFixed(4);
        pos = { sym: "?", dir: sig, entry: cur.close, sl, tp, size, t: cur.time, startIdx: i };
      }
    }
    equity.push({ time: cur.time, v: +cap.toFixed(2) });
  }
  return { trades, equity, maxDD: +maxDD.toFixed(2), finalCap: +cap.toFixed(2) };
}

// ============================================================
// 统计
// ============================================================
function calcStats(trades, equity, maxDD, symbol, initCap) {
  const wins = trades.filter((t) => t.win);
  const losses = trades.filter((t) => !t.win);
  const winPnl = wins.reduce((s, t) => s + t.pnl, 0);
  const lossPnl = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const final = equity[equity.length - 1].v;
  const roi = (final - initCap) / initCap * 100;
  const pf = lossPnl > 0 ? winPnl / lossPnl : (winPnl > 0 ? 999 : 0);
  const pnls = trades.map((t) => t.pnl);
  const mean = pnls.length ? pnls.reduce((s, v) => s + v, 0) / pnls.length : 0;
  const std  = pnls.length > 1
    ? Math.sqrt(pnls.map((v) => (v - mean) ** 2).reduce((s, v) => s + v, 0) / pnls.length) : 1;
  const sharpe = std > 0 ? (mean / std) * Math.sqrt(365 * 6) : 0; // 4h = 6根/天

  return {
    symbol, total: trades.length,
    winCount: wins.length, lossCount: losses.length,
    winRate: trades.length ? +(wins.length / trades.length * 100).toFixed(1) : 0,
    avgWin:  wins.length   ? +(winPnl / wins.length).toFixed(2)   : 0,
    avgLoss: losses.length ? +(lossPnl / losses.length).toFixed(2) : 0,
    profitFactor: +pf.toFixed(2),
    maxDD, sharpe: +sharpe.toFixed(2),
    finalCap: final, roi: +roi.toFixed(2),
    totalPnl: +totalPnl.toFixed(2), initCap,
  };
}

// ============================================================
// 输出
// ============================================================
function bar(v, max, width = 20) {
  const filled = Math.round((Math.abs(v) / (max || 1)) * width);
  const ch = v >= 0 ? "█" : "░";
  return ch.repeat(Math.min(filled, width));
}

function printSummaryTable(results) {
  const sep = "═".repeat(80);
  console.log("\n" + sep);
  console.log("   📊 10币种平衡型策略回测汇总表（4h/5x/止损1.5%/盈亏比1:3）");
  console.log(sep);
  console.log(
    "  币种        ".padEnd(14) +
    "收益率  ".padEnd(10) +
    "盈亏(U)".padEnd(10) +
    "交易次".padEnd(8) +
    "胜率  ".padEnd(8) +
    "盈亏比".padEnd(8) +
    "回撤  ".padEnd(8) +
    "图示"
  );
  console.log("─".repeat(80));

  const maxAbsROI = Math.max(...results.map((r) => Math.abs(r.roi)), 0.01);

  for (const r of results) {
    const roiStr  = (r.roi >= 0 ? "+" : "") + r.roi + "%";
    const pnlStr  = (r.totalPnl >= 0 ? "+" : "") + r.totalPnl + "U";
    const pfStr   = r.profitFactor === 999 ? "∞" : String(r.profitFactor);
    const chart   = bar(r.roi, maxAbsROI, 18);
    console.log(
      ("  " + r.symbol.replace("_USDT","")).padEnd(14) +
      roiStr.padEnd(10) +
      pnlStr.padEnd(10) +
      String(r.total).padEnd(8) +
      (r.winRate + "%").padEnd(8) +
      pfStr.padEnd(8) +
      (r.maxDD + "%").padEnd(8) +
      chart
    );
  }
  console.log("─".repeat(80));

  const totalInit  = results.reduce((s, r) => s + r.initCap, 0);
  const totalFinal = results.reduce((s, r) => s + r.finalCap, 0);
  const totalPnl   = results.reduce((s, r) => s + r.totalPnl, 0);
  const totalROI   = (totalFinal - totalInit) / totalInit * 100;
  const totalTrades= results.reduce((s, r) => s + r.total, 0);
  const totalWins  = results.reduce((s, r) => s + r.winCount, 0);
  const overallWR  = totalTrades ? (totalWins / totalTrades * 100).toFixed(1) : "0";
  const worstDD    = Math.max(...results.map((r) => r.maxDD));

  console.log(
    "  【组合合计】".padEnd(14) +
    ((totalROI >= 0 ? "+" : "") + totalROI.toFixed(2) + "%").padEnd(10) +
    ((totalPnl >= 0 ? "+" : "") + totalPnl.toFixed(2) + "U").padEnd(10) +
    String(totalTrades).padEnd(8) +
    (overallWR + "%").padEnd(8)
  );
  console.log(sep);
  console.log(`  初始: ${totalInit.toFixed(0)}U → 最终: ${totalFinal.toFixed(2)}U`);
  console.log(`  组合ROI: ${totalROI >= 0 ? "+" : ""}${totalROI.toFixed(2)}%  |  综合胜率: ${overallWR}%  |  最大单币回撤: ${worstDD}%`);

  // 排行榜
  const sorted = [...results].sort((a, b) => b.roi - a.roi);
  console.log("\n  🥇 收益排行：");
  sorted.forEach((r, i) => {
    const medal = ["🥇","🥈","🥉"][i] || `  ${i+1}.`;
    const status = r.roi >= 0 ? "🟢" : "🔴";
    console.log(`  ${medal} ${status} ${r.symbol.replace("_USDT","").padEnd(6)}  ${(r.roi >= 0 ? "+" : "") + r.roi}%  (${r.total}笔, 胜率${r.winRate}%)`);
  });
  console.log(sep);

  return { totalROI: +totalROI.toFixed(2), totalFinal: +totalFinal.toFixed(2), totalPnl: +totalPnl.toFixed(2), totalTrades, overallWR, worstDD };
}

function printTrades(sym, trades) {
  if (!trades.length) {
    console.log(`  ${sym}: 无触发信号`);
    return;
  }
  console.log(`\n  ── ${sym} (共${trades.length}笔) ──`);
  console.log("  " + "入场时间         方向  入场价          出场价          盈亏(U)   结果");
  console.log("  " + "─".repeat(72));
  for (const t of trades) {
    const pstr = ((t.pnl >= 0 ? "+" : "") + t.pnl).padEnd(10);
    console.log("  " +
      t.entryTime.padEnd(18) + t.dir.padEnd(6) +
      String(t.entry).padEnd(16) + String(t.exit).padEnd(16) +
      pstr + (t.win ? "✅" : "❌") + ` ${t.reason}`
    );
  }
}

// ============================================================
// 主函数
// ============================================================
async function main() {
  console.log("═".repeat(65));
  console.log("   Gate.io 平衡型策略 — 10币种扩展回测 v4");
  console.log(`   4h/5x | 止损1.5% | 盈亏比1:3 | RSI40-65 | ADX≥15`);
  console.log(`   总资金 ${TOTAL_CAPITAL}U，每币 ${CAPITAL_PER}U`);
  console.log(`   币种: ${SYMBOLS.map(s=>s.replace("_USDT","")).join(" | ")}`);
  console.log("═".repeat(65));

  const allResults = [], allTrades = [];

  for (const sym of SYMBOLS) {
    process.stdout.write(`\n  [${SYMBOLS.indexOf(sym)+1}/10] ${sym} ... `);
    const raw = await fetchKlines(sym);
    if (!raw) {
      console.log("⚠️ 跳过（无数据）");
      continue;
    }
    const candles = buildCandles(raw).filter((c) => c.emaFast && c.emaTrend && c.rsi !== null);
    const { trades, equity, maxDD } = backtest(candles, CAPITAL_PER);
    const st = calcStats(trades, equity, maxDD, sym, CAPITAL_PER);
    console.log(`完成 | ${trades.length}笔 | ROI: ${st.roi >= 0 ? "+" : ""}${st.roi}%`);
    allResults.push(st);
    allTrades.push({ sym, trades });
  }

  // 汇总表
  const overall = printSummaryTable(allResults);

  // 详细交易记录
  console.log("\n\n📋 各币种详细交易记录：");
  for (const { sym, trades } of allTrades) printTrades(sym, trades);

  // 保存
  const dir = "/home/node/.openclaw/workspace/gate_strategy";
  const summary = {
    version: "v4-balanced-10symbols",
    strategy: { ...CFG, symbols: SYMBOLS },
    overall,
    perSymbol: allResults,
    generatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(`${dir}/backtest_v4_summary.json`, JSON.stringify(summary, null, 2));

  for (const { sym, trades } of allTrades) {
    if (!trades.length) continue;
    const csv = "entryTime,exitTime,dir,entry,exit,size,pnl,win,reason,holdBars\n" +
      trades.map((t) =>
        `${t.entryTime},${t.exitTime},${t.dir},${t.entry},${t.exit},${t.size},${t.pnl},${t.win},${t.reason},${t.holdBars}`
      ).join("\n");
    fs.writeFileSync(`${dir}/trades_v4_${sym}.csv`, csv);
  }
  console.log(`\n\n📁 结果已保存: ${dir}/backtest_v4_summary.json`);
  console.log("✅ 回测完成！");
}

main().catch((e) => { console.error("❌", e.message); process.exit(1); });
