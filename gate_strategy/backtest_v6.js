/**
 * Gate.io 双向高频复利策略 v6
 *
 * 核心思路：
 *  - 双向交易（多空都做），不预判方向
 *  - 15分钟线，高频信号
 *  - 小止盈 0.3%，止损 0.6%（盈亏比 1:0.5，靠胜率>67%盈利）
 *  - 复利滚仓：每笔盈利后仓位自动放大
 *  - ATR波动率过滤：无波动不开仓
 *  - EMA5/13交叉 + 布林带反转双重信号源
 */

const https = require("https");
const fs    = require("fs");

// ============================================================
// 配置
// ============================================================
const CFG = {
  LEVERAGE:        10,
  STOP_PCT:        0.006,   // 止损 0.6%
  TAKE_PCT:        0.003,   // 止盈 0.3%
  POSITION_RATIO:  0.30,    // 每笔用30%本金

  EMA_FAST:    5,
  EMA_SLOW:    13,
  RSI_PERIOD:  7,
  RSI_OB:      68,
  RSI_OS:      32,

  ATR_MIN_PCT: 0.002,       // ATR/价格 至少0.2%才开仓
  BB_PERIOD:   20,
  BB_STD:      2.0,

  INTERVAL:  "15m",
  DAYS:       180,
  COMPOUND:   true,         // 复利模式
};

const SYMBOLS       = ["BTC_USDT", "ETH_USDT", "SOL_USDT"];
const TOTAL_CAPITAL = 500;
const CAPITAL_PER   = TOTAL_CAPITAL / SYMBOLS.length;   // ≈166.67U
const FEE_RATE      = 0.0005 + 0.0002;                  // taker+maker

// ============================================================
// 网络 & 工具
// ============================================================
const httpGet = (url) => new Promise((resolve, reject) => {
  https.get(url, (res) => {
    let d = "";
    res.on("data", c => d += c);
    res.on("end", () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
  }).on("error", reject);
});
const sleep   = ms => new Promise(r => setTimeout(r, ms));
const fmt     = ts => new Date(ts * 1000).toISOString().slice(0, 16);
const fmtMon  = ts => new Date(ts * 1000).toISOString().slice(0, 7);

// ============================================================
// K线获取
// ============================================================
async function fetchKlines(symbol, interval, days) {
  const secMap = { "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400 };
  const iSec   = secMap[interval];
  const endTime   = Math.floor(Date.now() / 1000);
  const startTime = endTime - days * 86400;
  const batchSec  = 1200 * iSec;

  let all = [], curEnd = endTime;
  while (curEnd > startTime) {
    const curStart = Math.max(curEnd - batchSec, startTime);
    const url = `https://api.gateio.ws/api/v4/futures/usdt/candlesticks` +
      `?contract=${symbol}&from=${curStart}&to=${curEnd}&interval=${interval}`;
    try {
      const data = await httpGet(url);
      if (!Array.isArray(data) || !data.length) break;
      all = all.concat(data);
      curEnd = curStart - 1;
    } catch(e) { break; }
    await sleep(280);
  }
  return all
    .map(c => ({ time: +c.t, open: +c.o, high: +c.h, low: +c.l, close: +c.c, volume: +c.v }))
    .sort((a, b) => a.time - b.time)
    .filter((c, i, arr) => i === 0 || c.time !== arr[i-1].time);
}

// ============================================================
// 指标
// ============================================================
function calcEMA(arr, p) {
  const k = 2 / (p + 1), r = Array(arr.length).fill(null);
  let s = 0;
  for (let i = 0; i < arr.length; i++) {
    if (i < p-1) { s += arr[i]; continue; }
    if (i === p-1) { s += arr[i]; r[i] = s / p; continue; }
    r[i] = arr[i] * k + r[i-1] * (1 - k);
  }
  return r;
}

function calcRSI(closes, p) {
  const r = Array(closes.length).fill(null);
  let ag = 0, al = 0;
  for (let i = 1; i <= p; i++) {
    const d = closes[i] - closes[i-1];
    d > 0 ? (ag += d / p) : (al += -d / p);
  }
  r[p] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  for (let i = p+1; i < closes.length; i++) {
    const d = closes[i] - closes[i-1];
    ag = (ag * (p-1) + (d > 0 ? d : 0)) / p;
    al = (al * (p-1) + (d < 0 ? -d : 0)) / p;
    r[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return r;
}

function calcATR(candles, p = 14) {
  const tr = candles.map((c, i) =>
    i === 0 ? c.high - c.low
      : Math.max(c.high - c.low,
          Math.abs(c.high - candles[i-1].close),
          Math.abs(c.low  - candles[i-1].close))
  );
  const res = Array(candles.length).fill(null);
  for (let i = p-1; i < candles.length; i++)
    res[i] = tr.slice(i-p+1, i+1).reduce((s, v) => s + v, 0) / p;
  return res;
}

function calcBB(closes, p = 20, mult = 2) {
  const mid = calcEMA(closes, p);
  const upper = Array(closes.length).fill(null);
  const lower = Array(closes.length).fill(null);
  for (let i = p-1; i < closes.length; i++) {
    const sl = closes.slice(i-p+1, i+1);
    const mn = sl.reduce((s, v) => s + v, 0) / p;
    const sd = Math.sqrt(sl.map(v => (v-mn)**2).reduce((s, v) => s + v, 0) / p);
    upper[i] = mid[i] + mult * sd;
    lower[i] = mid[i] - mult * sd;
  }
  return { mid, upper, lower };
}

function buildIndicators(candles) {
  const closes = candles.map(c => c.close);
  const ef   = calcEMA(closes, CFG.EMA_FAST);
  const es   = calcEMA(closes, CFG.EMA_SLOW);
  const ri   = calcRSI(closes, CFG.RSI_PERIOD);
  const at   = calcATR(candles, 14);
  const bb   = calcBB(closes, CFG.BB_PERIOD, CFG.BB_STD);
  return candles.map((c, i) => ({
    ...c,
    emaFast: ef[i], emaSlow: es[i],
    rsi: ri[i], atr: at[i],
    bbUpper: bb.upper[i], bbLower: bb.lower[i], bbMid: bb.mid[i],
  }));
}

// ============================================================
// 双向信号
// ============================================================
function getSignal(cur, prev) {
  if (!cur.emaFast || cur.rsi === null || !cur.atr || !cur.bbUpper) return "HOLD";

  // 波动率过滤
  if (cur.atr / cur.close < CFG.ATR_MIN_PCT) return "HOLD";

  const crossUp   = prev.emaFast < prev.emaSlow && cur.emaFast > cur.emaSlow;
  const crossDown = prev.emaFast > prev.emaSlow && cur.emaFast < cur.emaSlow;

  // 布林带超卖/超买反转
  const bbLong  = cur.close < cur.bbLower && cur.rsi < CFG.RSI_OS + 8;
  const bbShort = cur.close > cur.bbUpper && cur.rsi > CFG.RSI_OB - 8;

  // 做多：EMA金叉(RSI<62) 或 布林下轨反弹
  if ((crossUp && cur.rsi > 30 && cur.rsi < 62) || bbLong)  return "LONG";
  // 做空：EMA死叉(RSI>38) 或 布林上轨反转
  if ((crossDown && cur.rsi > 38 && cur.rsi < 70) || bbShort) return "SHORT";

  return "HOLD";
}

// ============================================================
// 回测引擎（复利）
// ============================================================
function backtest(candles, initCap) {
  let cap = initCap;
  const trades  = [];
  const equity  = [{ time: candles[0].time, v: cap }];
  let pos = null, maxEq = initCap, maxDD = 0;
  let totalFee  = 0;

  for (let i = 1; i < candles.length; i++) {
    const cur = candles[i], prev = candles[i-1];

    // --- 检查止损/止盈 ---
    if (pos) {
      const hitSL = pos.dir === "LONG" ? cur.low  <= pos.sl : cur.high >= pos.sl;
      const hitTP = pos.dir === "LONG" ? cur.high >= pos.tp : cur.low  <= pos.tp;

      if (hitSL || hitTP) {
        const exit    = hitSL ? pos.sl : pos.tp;
        const pnlPct  = pos.dir === "LONG"
          ? (exit - pos.entry) / pos.entry
          : (pos.entry - exit) / pos.entry;
        const fee     = pos.size * FEE_RATE * CFG.LEVERAGE;
        const pnl     = pnlPct * pos.size * CFG.LEVERAGE - fee;
        totalFee     += fee;
        cap           = Math.max(cap + pnl, 0);

        trades.push({
          entryTime:  fmt(pos.t),
          exitTime:   fmt(cur.time),
          dir:        pos.dir,
          entry:      pos.entry,
          exit,
          size:       pos.size,
          pnl:        +pnl.toFixed(4),
          win:        pnl > 0,
          reason:     hitTP ? "止盈" : "止损",
          holdBars:   i - pos.startIdx,
          capAfter:   +cap.toFixed(2),
          month:      fmtMon(cur.time),
        });

        if (cap > maxEq) maxEq = cap;
        const dd = (maxEq - cap) / maxEq * 100;
        if (dd > maxDD) maxDD = dd;
        pos = null;
        if (cap < initCap * 0.3) { console.log("  ⛔ 熔断"); break; }
      }
    }

    // --- 新信号 ---
    if (!pos) {
      const sig = getSignal(cur, prev);
      if (sig !== "HOLD") {
        // 复利：仓位基于当前资金
        const size    = CFG.COMPOUND ? +(cap * CFG.POSITION_RATIO).toFixed(2)
                                     : +(initCap * CFG.POSITION_RATIO).toFixed(2);
        const sl = sig === "LONG"
          ? +(cur.close * (1 - CFG.STOP_PCT)).toFixed(4)
          : +(cur.close * (1 + CFG.STOP_PCT)).toFixed(4);
        const tp = sig === "LONG"
          ? +(cur.close * (1 + CFG.TAKE_PCT)).toFixed(4)
          : +(cur.close * (1 - CFG.TAKE_PCT)).toFixed(4);
        pos = { dir: sig, entry: cur.close, sl, tp, size, t: cur.time, startIdx: i };
      }
    }

    equity.push({ time: cur.time, v: +cap.toFixed(2) });
  }

  return { trades, equity, maxDD: +maxDD.toFixed(2), finalCap: +cap.toFixed(2), totalFee: +totalFee.toFixed(2) };
}

// ============================================================
// 统计
// ============================================================
function calcStats(trades, equity, maxDD, symbol, initCap, totalFee) {
  const wins   = trades.filter(t => t.win);
  const losses = trades.filter(t => !t.win);
  const winPnl  = wins.reduce((s, t) => s + t.pnl, 0);
  const lossPnl = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const final    = equity[equity.length - 1].v;
  const roi      = (final - initCap) / initCap * 100;
  const pf       = lossPnl > 0 ? winPnl / lossPnl : (winPnl > 0 ? 999 : 0);

  // 月度统计
  const monthly = {};
  trades.forEach(t => {
    if (!monthly[t.month]) monthly[t.month] = { pnl: 0, win: 0, loss: 0 };
    monthly[t.month].pnl  += t.pnl;
    t.win ? monthly[t.month].win++ : monthly[t.month].loss++;
  });

  // 最大连胜/连亏
  let maxWin = 0, maxLoss = 0, cw = 0, cl = 0;
  trades.forEach(t => {
    if (t.win) { cw++; cl = 0; maxWin  = Math.max(maxWin, cw); }
    else       { cl++; cw = 0; maxLoss = Math.max(maxLoss, cl); }
  });

  // 每日交易频次
  const days = new Set(trades.map(t => t.entryTime.slice(0, 10))).size || 1;
  const avgPerDay = +(trades.length / days).toFixed(1);

  // 夏普（日收益）
  const pnls = trades.map(t => t.pnl);
  const mean = pnls.length ? pnls.reduce((s, v) => s + v, 0) / pnls.length : 0;
  const std  = pnls.length > 1
    ? Math.sqrt(pnls.map(v => (v-mean)**2).reduce((s,v) => s+v, 0) / pnls.length) : 1;
  const sharpe = std > 0 ? (mean / std) * Math.sqrt(96 * 180) : 0; // 96根/天×180天

  return {
    symbol, total: trades.length,
    winCount: wins.length, lossCount: losses.length,
    winRate: trades.length ? +(wins.length / trades.length * 100).toFixed(1) : 0,
    avgWin:  wins.length   ? +(winPnl / wins.length).toFixed(4)    : 0,
    avgLoss: losses.length ? +(lossPnl / losses.length).toFixed(4)  : 0,
    profitFactor: +pf.toFixed(2),
    maxDD, sharpe: +sharpe.toFixed(2),
    finalCap: final, roi: +roi.toFixed(2),
    totalPnl: +totalPnl.toFixed(2), initCap,
    totalFee, monthly, maxWin, maxLoss, avgPerDay,
  };
}

// ============================================================
// 输出
// ============================================================
function printReport(allStats, allTrades) {
  const sep  = "═".repeat(78);
  const dash = "─".repeat(78);

  // 汇总表
  console.log("\n" + sep);
  console.log("   📊 双向高频复利策略 v6 — 回测报告（15m / 10x / 止盈0.3%）");
  console.log(sep);
  console.log(
    "  币种      收益率    盈亏(U)  交易  胜率   盈亏比  回撤  均频/天  夏普"
  );
  console.log(dash);

  for (const r of allStats) {
    const roi = (r.roi >= 0 ? "+" : "") + r.roi + "%";
    const pnl = (r.totalPnl >= 0 ? "+" : "") + r.totalPnl + "U";
    const pf  = r.profitFactor === 999 ? "∞" : String(r.profitFactor);
    const emj = r.roi >= 0 ? "🟢" : "🔴";
    console.log(
      `  ${emj} ${r.symbol.replace("_USDT","").padEnd(6)}` +
      roi.padEnd(10) + pnl.padEnd(10) +
      String(r.total).padEnd(6) + (r.winRate+"%").padEnd(7) +
      pf.padEnd(8) + (r.maxDD+"%").padEnd(6) +
      String(r.avgPerDay).padEnd(9) + r.sharpe
    );
  }
  console.log(dash);

  const ti    = allStats.reduce((s, r) => s + r.initCap, 0);
  const tf    = allStats.reduce((s, r) => s + r.finalCap, 0);
  const tp    = allStats.reduce((s, r) => s + r.totalPnl, 0);
  const fee   = allStats.reduce((s, r) => s + r.totalFee, 0);
  const troi  = (tf - ti) / ti * 100;
  const tt    = allStats.reduce((s, r) => s + r.total, 0);
  const tw    = allStats.reduce((s, r) => s + r.winCount, 0);
  const wr    = tt ? (tw / tt * 100).toFixed(1) : "0";
  const wdd   = Math.max(...allStats.map(r => r.maxDD));

  console.log(
    "  【合计】  " +
    ((troi >= 0 ? "+" : "") + troi.toFixed(2) + "%").padEnd(10) +
    ((tp >= 0 ? "+" : "") + tp.toFixed(2) + "U").padEnd(10) +
    String(tt).padEnd(6) + (wr + "%").padEnd(7)
  );
  console.log(sep);
  console.log(`  初始: ${ti.toFixed(0)}U → 最终: ${tf.toFixed(2)}U`);
  console.log(`  总ROI: ${troi >= 0 ? "+" : ""}${troi.toFixed(2)}%  |  综合胜率: ${wr}%  |  最大回撤: ${wdd}%`);
  console.log(`  总手续费消耗: ${fee.toFixed(2)}U  ⚠️  高频的最大成本`);

  // 月度明细
  console.log("\n  📅 各币种月度盈亏：");
  for (const r of allStats) {
    process.stdout.write(`\n  ${r.symbol.replace("_USDT","")}  `);
    const months = Object.entries(r.monthly).sort();
    for (const [m, v] of months) {
      const p = ((v.pnl >= 0 ? "+" : "") + v.pnl.toFixed(2)).padStart(8);
      const bar = v.pnl >= 0
        ? "█".repeat(Math.min(12, Math.round(v.pnl / 5)))
        : "░".repeat(Math.min(12, Math.round(-v.pnl / 5)));
      process.stdout.write(`\n    ${m}  ${p}U  ${v.win}盈${v.loss}亏  ${bar}`);
    }
    console.log(`\n    连胜最多: ${r.maxWin}次  连亏最多: ${r.maxLoss}次`);
  }

  // 复利推算
  const avgMonthlyROI = allStats.reduce((s, r) => s + r.roi, 0) / allStats.length / 6;
  console.log("\n" + sep);
  if (avgMonthlyROI > 0) {
    console.log(`  💰 复利推算（月均ROI: ${avgMonthlyROI.toFixed(2)}%）：`);
    let cap = 500;
    for (const m of [3, 6, 12, 24, 36]) {
      cap = 500 * Math.pow(1 + avgMonthlyROI / 100, m);
      console.log(`    ${String(m).padStart(2)}个月: ${cap.toFixed(2)}U  (+${(cap-500).toFixed(2)}U, ROI ${((cap-500)/500*100).toFixed(1)}%)`);
    }
  } else {
    console.log("  ⚠️  当前策略整体亏损，复利会加速亏损，不建议使用。");
  }
  console.log(sep);

  // 详细交易（每币种最近10笔）
  console.log("\n  📋 各币种最近10笔交易：");
  for (const { sym, trades } of allTrades) {
    if (!trades.length) { console.log(`\n  ${sym}: 无交易`); continue; }
    console.log(`\n  ── ${sym} (共${trades.length}笔  胜率${allStats.find(r=>r.symbol===sym).winRate}%) ──`);
    console.log("  入场时间         方向  入场价        出场价        盈亏(U)   结果     持仓");
    console.log("  " + "─".repeat(72));
    for (const t of trades.slice(-10)) {
      console.log("  " +
        t.entryTime.padEnd(18) + t.dir.padEnd(6) +
        String(t.entry).padEnd(14) + String(t.exit).padEnd(14) +
        ((t.pnl >= 0 ? "+" : "") + t.pnl).toString().padEnd(10) +
        (t.win ? "✅" : "❌").padEnd(5) +
        `${t.reason}  ${t.holdBars}根K线`
      );
    }
  }
}

// ============================================================
// 主
// ============================================================
async function main() {
  console.log("═".repeat(65));
  console.log("   Gate.io 双向高频复利策略 v6");
  console.log("   止盈0.3% | 止损0.6% | 15m | 10x | 复利滚仓");
  console.log("═".repeat(65));

  const allStats = [], allTrades = [];

  for (const sym of SYMBOLS) {
    process.stdout.write(`\n  [${SYMBOLS.indexOf(sym)+1}/${SYMBOLS.length}] ${sym} 获取K线...`);
    const raw      = await fetchKlines(sym, CFG.INTERVAL, CFG.DAYS);
    const candles  = buildIndicators(raw).filter(c => c.emaFast && c.rsi !== null && c.bbUpper);
    process.stdout.write(` ${candles.length}根 回测中...`);

    const { trades, equity, maxDD, finalCap, totalFee } = backtest(candles, CAPITAL_PER);
    const st = calcStats(trades, equity, maxDD, sym, CAPITAL_PER, totalFee);
    process.stdout.write(` ${trades.length}笔  ROI:${st.roi >= 0 ? "+" : ""}${st.roi}%\n`);

    allStats.push(st);
    allTrades.push({ sym, trades });
  }

  printReport(allStats, allTrades);

  // 保存
  const dir = "/home/node/.openclaw/workspace/gate_strategy";
  fs.writeFileSync(`${dir}/backtest_v6_summary.json`,
    JSON.stringify({ version:"v6-dual-hf-compound", cfg:CFG, symbols:SYMBOLS, results:allStats }, null, 2));
  for (const { sym, trades } of allTrades) {
    if (!trades.length) continue;
    const csv = "entryTime,exitTime,dir,entry,exit,size,pnl,win,reason,holdBars,capAfter\n" +
      trades.map(t => `${t.entryTime},${t.exitTime},${t.dir},${t.entry},${t.exit},${t.size},${t.pnl},${t.win},${t.reason},${t.holdBars},${t.capAfter}`).join("\n");
    fs.writeFileSync(`${dir}/trades_v6_${sym}.csv`, csv);
  }
  console.log(`\n📁 已保存: ${dir}/backtest_v6_summary.json`);
}

main().catch(e => { console.error("❌", e.message); process.exit(1); });
