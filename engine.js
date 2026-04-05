"use strict";
const https = require("https");
const crypto = require("crypto");
const { aiAdvise, aiAdviseOscillation, aiCheckPosition } = require("./ai-advisor");

class TradingEngine {
 constructor(config, emit) {
  this.consecutiveLosses = 0;
 this.cfg = config;
 this.emit = emit;
 this.pos = null;
 this.timer = null;
 this.running = false;
 this.lastSlot = 0;
 this.cooldownUntilSlot = 0;
 this.startBal = null;
 this.contractInfo = null;
 this._connOk = true;
 this.exchangeRate = 7.25;
 this.rateLastUpdate = 0;
 this.lastAiCheckSlot = 0;
 this.aiCheckInterval = 1;
 this.simBalance = null;
 this.simAvail = null;
 this.simMargin = 0;
 this.simTotalPnl = 0;
 this.simFile = null;
 this.spikeUntil = 0;
 this.dailyPnl = 0;
 this.dailyDate = "";
 this.dailyStartBal = null;
 this.lastSigDir = null;
 this.lastSigCount = 0;
 this._closing = false;
 this.marketMode = "trend"; // "trend" | "oscillation"
 this.oscCheckSlot = 0;
 this._reportSentToday = false;
 this.tradeHistory = [];
 this.historyFile = null;

 if (config.dryRun) {
  const path = require("path");
  const os = require("os");
  const fs = require("fs");
  const dir = path.join(__dirname, "..", "data");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  this.simFile = path.join(dir, "sim_state_" + (config.contract || "BTC_USDT") + ".json");
 }

 {
  const path = require("path");
  const os = require("os");
  const fs = require("fs");
  const dir = path.join(__dirname, "..", "data");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  this.historyFile = path.join(dir, "trade_history_" + (config.contract || "BTC_USDT") + ".json");
 }
 }

 async fetchExchangeRate() {
 try {
  if (Date.now() - this.rateLastUpdate < 3600000) return this.exchangeRate;
  const rate = await new Promise((resolve) => {
   https.get("https://api.frankfurter.app/latest?from=USD&to=CNY", (res) => {
    let data = "";
    res.on("data", chunk => data += chunk);
    res.on("end", () => {
     try { resolve(JSON.parse(data).rates.CNY); } catch { resolve(7.25); }
    });
   }).on("error", () => resolve(7.25));
  });
  this.exchangeRate = rate;
  this.rateLastUpdate = Date.now();
  this.log("info", "💱 汇率已更新: 1 USD = " + rate.toFixed(4) + " CNY");
  this.emit("rate", { rate: this.exchangeRate });
  return rate;
 } catch { return 7.25; }
 }

 async start() {
 console.log("API Key:", this.cfg.apiKey ? "已设置" : "未设置");
 console.log("API Secret:", this.cfg.apiSecret ? "已设置" : "未设置");
 this.running = true;
 this.log("info", `机器人启动 | ${this.cfg.dryRun ? "【模拟模式】" : "【真实交易】"}`);
 this.log("info", `止盈${this.cfg.takePct}% 止损${this.cfg.stopPct}% ${this.cfg.leverage}x 仓位${this.cfg.posRatio}%`);
 this.log("info", `🤖 AI辅助决策已启用 | 模型: Qwen3-Max | 超时12s不开仓`);
 this.loadTradeHistory();
 if (this.cfg.dryRun) {
  const hasState = this.loadSimState();
  if (!hasState) {
   this.simBalance = this.cfg.capital;
   this.simAvail = this.cfg.capital;
   this.simMargin = 0;
   this.simTotalPnl = 0;
   this.consecutiveLosses = 0;
   this.log("info", `💰 模拟账户初始化: 总额 ${this.simBalance.toFixed(2)} USDT`);
  }
  setTimeout(() => { this.fetchExchangeRate().catch(() => {}); }, 100);
  this.startBal = this.simBalance || this.cfg.capital;
 } else {
  // ✅ P1修复：实盘模式恢复连亏计数
  this.loadLiveState();
  const balResult = await this.getBalance();
this.startBal = balResult ? balResult.available : 0;
 }

 try {
  if (!this.cfg.dryRun) {
   await this.setLeverage();
   this.log("info", `杠杆已设置: ${this.cfg.leverage}x`);
  }
  this.contractInfo = await this.getContractInfo();
  this.log("info", `合约: BTC_USDT | 每张=${this.contractInfo.mult} BTC`);
  let liveBalance = this.startBal;
  if (!this.cfg.dryRun) {
   try {
    const balData = await this.getBalance();
    if (balData && balData.available > 0) {
     liveBalance = balData.available;
     this.startBal = liveBalance;
    }
   } catch(e) {
    this.log("warn", "获取实时余额失败，使用配置余额");
   }
  }

  // ✅ 启动时发送余额（含simBalance）
  this.emit("balance", {
   balance: this.cfg.dryRun ? this.simAvail : liveBalance,
   start: this.cfg.dryRun ? this.simAvail : this.startBal,
   total: this.cfg.dryRun ? this.simBalance : liveBalance,
   margin: this.cfg.dryRun ? this.simMargin : 0,
   pnl: 0,
   totalPnl: this.simTotalPnl,
   simBalance: this.cfg.dryRun ? this.simBalance : null,
  });

  this.log("info", `账户余额: ${this.cfg.dryRun ? this.simBalance.toFixed(2) : (this.startBal || 0).toFixed(2)} USDT`);
  if (typeof this.getPrice !== "function") {
   this.log("error", "getPrice 方法未定义");
   this._setConn(false);
   return;
  }
  this._setConn(true);
  this.tick();
  this.startPriceTicker();
  this.startOrderBookWatcher();
  this.startDailyReportTimer();
 } catch (e) {
  this._setConn(false);
  this.log("error", "启动失败: " + e.message);
 }
 }

 updateConfig(newCfg) {
 ["takePct","stopPct","posRatio","maxLoss","leverage","trailPct","partialPct","volMult",
  "atrMult","tp1Pct","tp2Pct","trendMode","dailyTpPct","dailySlPct"]
  .forEach(k => { if (newCfg[k] != null) this.cfg[k] = newCfg[k]; });
 this.log("open", "⚙️ 参数已热更新，新配置生效");
 this.emit("configUpdated", this.cfg);
 }

 stop() {
 this.running = false;
 if (this.timer) { clearTimeout(this.timer); this.timer = null; }
 if (this.priceTimer) { clearInterval(this.priceTimer); this.priceTimer = null; }
 if (this.obTimer) { clearInterval(this.obTimer); this.obTimer = null; }
 if (this.reportTimer) { clearInterval(this.reportTimer); this.reportTimer = null; }
 this.log("info", "机器人已停止");
 }

 async tick() {
 if (!this.running) return;
 try { await this.run(); this._setConn(true); }
 catch (e) {
   if (e.code === "ECONNRESET" || e.code === "ETIMEDOUT" || (e.message && e.message.includes("超时"))) {
     this._setConn(false);
   } else if (e.message) {
     // ✅ 不因策略内部变量错误触发连接异常
     this.log("warn", "策略运行异常(非网络): " + e.message);
   }
 }
 if (this.running) this.timer = setTimeout(() => this.tick(), 60_000);
 }

 startPriceTicker() {
 this.priceTimer = setInterval(async () => {
  if (!this.running) return;
  try {
   const price = await this.getPrice(this.cfg.contract || "BTC_USDT");
   // ✅ 修复：price为0时跳过，不触发后续逻辑也不报连接异常
   if (!price || price <= 0) return;
   this.emit("price", { price });
   this._setConn(true);

   // ✅ 修复：每次进入前重新取pos引用并完整校验，防止竞态导致sl undefined
   const pos = this.pos;
   if (!pos || !pos.sl || !pos.tp || !pos.dir || !pos.entry) return;

   const { dir, entry, sl, tp } = pos;
   const pPct = dir === "LONG"
     ? (price - entry) / entry * 100
     : (entry - price) / entry * 100;

    if (this.cfg.trailPct > 0) {
     const tr = this.cfg.trailPct / 100;
     const nsl = +(price * (dir === "LONG" ? 1 - tr : 1 + tr)).toFixed(2);
     const better = dir === "LONG" ? nsl > this.pos.sl : nsl < this.pos.sl;
     if (better) {
      this.pos.sl = nsl;
      this.log("scan", `📐 动态止损更新 → ${nsl} (盈利${pPct.toFixed(2)}%)`);
      this.emit("position", { ...this.pos, price, pPct: +pPct.toFixed(2) });
     }
    }

    // ✅ 动态分阶段止损：根据开仓时EMA差距判断行情类型，自动调整止损追踪松紧
    const _ema = this.pos.emaDiffAtOpen || 0;
    // 震荡(<0.1%): 紧止损快保利；弱趋势(0.1~0.3%): 中等；强趋势(>0.3%): 宽止损跑更远
    const _s1 = _ema > 0.3 ? 0.5  : _ema > 0.1 ? 0.35 : 0.25; // 阶段1触发浮盈%
    const _s2 = _ema > 0.3 ? 1.0  : _ema > 0.1 ? 0.8  : 0.6;  // 阶段2触发浮盈%
    const _s3 = _ema > 0.3 ? 1.8  : _ema > 0.1 ? 1.4  : 1.2;  // 阶段3触发浮盈%
    const _l2 = _ema > 0.3 ? 0.002 : _ema > 0.1 ? 0.0015 : 0.001; // 阶段2锁利比例
    const _l3 = _ema > 0.3 ? 0.005 : _ema > 0.1 ? 0.004  : 0.003; // 阶段3锁利比例
    const trendLabel = _ema > 0.3 ? "强趋势" : _ema > 0.1 ? "弱趋势" : "震荡";

    if (pPct >= _s1 && !this.pos._stage1) {
      const breakeven = entry;
      const better1 = dir === "LONG" ? breakeven > this.pos.sl : breakeven < this.pos.sl;
      if (better1) {
        this.pos.sl = breakeven;
        this.pos._stage1 = true;
        this.log("open", `🔒 [阶段1/${trendLabel}] 浮盈${pPct.toFixed(2)}% → 止损移至保本 ${breakeven}`);
        this.emit("position", { ...this.pos, price, pPct: +pPct.toFixed(2) });
      }
    }
    if (pPct >= _s2 && !this.pos._stage2) {
      const lockSL = dir === "LONG"
        ? +(entry * (1 + _l2)).toFixed(2)
        : +(entry * (1 - _l2)).toFixed(2);
      const better2 = dir === "LONG" ? lockSL > this.pos.sl : lockSL < this.pos.sl;
      if (better2) {
        this.pos.sl = lockSL;
        this.pos._stage2 = true;
        this.log("open", `🔒 [阶段2/${trendLabel}] 浮盈${pPct.toFixed(2)}% → 止损锁定+${(_l2*100).toFixed(2)}% ${lockSL}`);
        this.emit("position", { ...this.pos, price, pPct: +pPct.toFixed(2) });
      }
    }
    if (pPct >= _s3 && !this.pos._stage3) {
      const lockSL3 = dir === "LONG"
        ? +(entry * (1 + _l3)).toFixed(2)
        : +(entry * (1 - _l3)).toFixed(2);
      const better3 = dir === "LONG" ? lockSL3 > this.pos.sl : lockSL3 < this.pos.sl;
      if (better3) {
        this.pos.sl = lockSL3;
        this.pos._stage3 = true;
        this.log("open", `🔒 [阶段3/${trendLabel}] 浮盈${pPct.toFixed(2)}% → 止损锁定+${(_l3*100).toFixed(2)}% ${lockSL3}`);
        this.emit("position", { ...this.pos, price, pPct: +pPct.toFixed(2) });
      }
    }

    if (this.pos && !this.pos._movedToBreakeven && pPct >= 1.0) {
     this.pos._movedToBreakeven = true;
     // 已被阶段3覆盖，仅保留标记
    }
    // ✅ 再次检查pos，防止上方异步操作导致pos被清空
    if (!this.pos) return;
    const hitSL = dir === "LONG" ? price <= this.pos.sl : price >= this.pos.sl;
    const hitTP = dir === "LONG" ? price >= this.pos.tp : price <= this.pos.tp;

    if ((hitSL || hitTP) && !this._closing) {
     this._closing = true;
     // ✅ 区分出场原因：止损价在盈利位=移动止损锁利，否则=真正止损
     let reason;
     if (hitTP) {
       reason = "止盈";
     } else if (dir === "LONG" && this.pos.sl >= entry) {
       reason = "移动止损锁利";
     } else if (dir === "SHORT" && this.pos.sl <= entry) {
       reason = "移动止损锁利";
     } else {
       reason = "止损";
     }
     // 只扣平仓手续费（开仓手续费开仓时已扣）
const feeClose = this.pos.feeClose || +(this.pos.notional * 0.0005).toFixed(4);
const pnl = this.pos.notional * pPct / 100 - feeClose;
// ✅ 连亏计数（保本出场也算赢，重置计数）
if (hitTP || reason === "移动止损锁利") {
this.consecutiveLosses = 0;
} else if (pnl < 0) {
this.consecutiveLosses = (this.consecutiveLosses || 0) + 1;
this.log("warn", `📊 连亏计数: ${this.consecutiveLosses}次`);
} else {
this.consecutiveLosses = 0;
}

     this.log(pnl >= 0 ? "win" : "loss",
      `⚡ 实时${reason} | ${dir} | 盈亏${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}U (${pPct.toFixed(2)}%)`);

     if (this.cfg.dryRun) {
      this.simAvail += this.simMargin;
      this.simBalance += pnl;
      this.simTotalPnl += pnl;
      this.simMargin = 0;
      // ✅ 平仓后：pnl=0，totalPnl=累计
      this.emit("balance", {
       balance: this.simAvail,
       start: this.startBal,
       total: this.simBalance,
       margin: this.simMargin,
       pnl: 0,
       totalPnl: this.simTotalPnl,
       simBalance: this.simBalance,
      });
     } else {
      const livePos = await this.getPosition().catch(() => null);
      if (livePos) await this.closePosition(livePos.size, dir).catch(() => {});
     }

     // ✅ 推送最新余额给UI
     this.emit("balance", {
      balance: this.cfg.dryRun ? this.simAvail : this.startBal,
      start: this.startBal,
      total: this.cfg.dryRun ? this.simBalance : this.startBal,
      margin: 0,
      pnl: 0,
      totalPnl: this.simTotalPnl,
      simBalance: this.cfg.dryRun ? this.simBalance : null,
     });
     this.emit("trade", {
      time: Date.now(), dir, entry, exit: price,
      contracts: this.pos.contracts, notional: this.pos.notional,
      pPct: +pPct.toFixed(2), pnl: +pnl.toFixed(2),
      reason, result: pnl >= 0 ? "win" : "loss"
     });
     this.tradeHistory.push({
      time: Date.now(), dir, entry, exit: price,
      openTime: this.pos.openTime || this.pos.time,
      closeTime: Date.now(),
      pPct: +pPct.toFixed(2), pnl: +pnl.toFixed(2),
      reason, result: pnl >= 0 ? "win" : "loss",
      hour: new Date().getUTCHours(),
     });
     this.saveTradeHistory();
     const stats = this.getWinStats();
     if (stats) {
      this.log("info", `📊 历史统计 | 总${stats.total}次 胜率${stats.winRate}% 累计${stats.totalPnl}U | 多头${stats.longWinRate}% 空头${stats.shortWinRate}% | ${stats.recentTrend}`);
      if (stats.badHours.length > 0) {
       this.log("warn", `⚠️ 低胜率时段(北京时间): ${stats.badHours.map(h => (parseInt(h)+8)%24 + "点").join(" ")}`);
      }
     }
     if (!hitTP) {
      const curSlot2 = Math.floor(Date.now() / (5 * 60 * 1000));
      const lossPct2 = Math.abs(pPct);
     const coolSlots = lossPct2 > 3 ? 6 : lossPct2 > 2 ? 4 : lossPct2 > 1 ? 3 : 2;
this.cooldownUntilSlot = curSlot2 + coolSlots; // ✅ 统一用 coolSlots
this.log("warn", `⏸ 实时止损冷却期: ${coolSlots * 5}分钟`);
   
     }
     this.pos = null;
     this._closing = false;
     this.emit("position", null);
     if (this.cfg.dryRun) this.saveSimState();
    }
  } catch(e) {
    // ✅ 只有真正的网络错误才触发连接异常，其他错误静默记录
    if (e.code === "ECONNRESET" || e.code === "ETIMEDOUT" || e.message?.includes("超时")) {
      this._setConn(false);
    } else if (e.message && e.message !== "sl is not defined") {
      this.log("warn", "价格监控异常: " + e.message);
    }
  }
 }, 500);
 }

 startOrderBookWatcher() {
 let lastRatio = 50;
 let lastBidVol = 0;
 let lastAskVol = 0;

 this.obTimer = setInterval(async () => {
  if (!this.running || this.pos) return;
  try {
   const ob = await this.getOrderBook();
   if (!ob) return;
   const ratio = parseFloat(ob.ratio);
   const bidVol = parseFloat(ob.bidVol);
   const askVol = parseFloat(ob.askVol);
   // ✅ 加确认计数，避免单次假信号
if (!this._bidSurgeCount) this._bidSurgeCount = 0;
if (!this._askSurgeCount) this._askSurgeCount = 0;
const bidSurgeRaw = ratio > 75 && bidVol > lastBidVol * 1.5;
const askSurgeRaw = ratio < 25 && askVol > lastAskVol * 1.5;
if (bidSurgeRaw) this._bidSurgeCount++; else this._bidSurgeCount = 0;
if (askSurgeRaw) this._askSurgeCount++; else this._askSurgeCount = 0;
const bidSurge = this._bidSurgeCount >= 2 && lastRatio < 45;
const askSurge = this._askSurgeCount >= 2 && lastRatio > 55;

   if (bidSurge || askSurge) {
    const dir = bidSurge ? "LONG" : "SHORT";
 const price = await this.getPrice(this.cfg.contract || "BTC_USDT");
 // ✅ 震荡过滤：最近10根K线振幅<150U时跳过
 try {
   const kFilter = await this.fetchKlines("5m", 12, this.cfg.contract);
   const kLast10 = kFilter.slice(-10);
   const highMax = Math.max(...kLast10.map(c => c.high));
   const lowMin = Math.min(...kLast10.map(c => c.low));
   if (highMax - lowMin < 150) {
     this.log("scan", `⏸ 震荡过滤：近10根K线振幅${(highMax-lowMin).toFixed(0)}U<150U，跳过`);
     lastRatio = ratio; return;
   }
 } catch(e) {}

    try {
     const trendTF = this.cfg.trendMode === "30m" ? "30m"
: this.cfg.trendMode === "auto"
? (this.currentAdx > 30 ? "1h" : "30m")
: "1h";
const rawTrend = await this.fetchKlines(trendTF, 50, this.cfg.contract);
const csTrend = this.buildIndicators(rawTrend).filter(c => c.ef && c.rsi !== null);
// ✅ 使用最新K线(含当前未收盘)以即时反映价格突破，避免大涨行情EMA差滞后
const curTrend = csTrend[csTrend.length - 1] || csTrend[csTrend.length - 2];
if (curTrend) {
const ema_diff = (curTrend.ef - curTrend.es) / curTrend.es * 100;
const trendDir = ema_diff > 0.07 ? "LONG" : ema_diff < -0.07 ? "SHORT" : "HOLD";
if (trendDir === "HOLD") { this.log("scan", `⏸ ${trendTF}趋势不明朗(EMA差${ema_diff.toFixed(3)}%)，跳过`); return; }
if (trendDir !== dir) {
this.log("scan", `⛔ 大单信号${dir}与${trendTF}趋势${trendDir}相反，跳过`);
lastRatio = ratio; return;
}
}
    } catch(e) {}

    const curSlot = Math.floor(Date.now() / (5 * 60 * 1000));
    if (curSlot < this.cooldownUntilSlot) {
     this.log("scan", "⏸ 冷却期内，跳过大单信号");
     lastRatio = ratio; return;
    }

    const nowUtc = new Date();
    const hh = nowUtc.getUTCHours(), mm = nowUtc.getUTCMinutes();
    const isNewsTime = (hh === 12 && mm >= 25 && mm <= 35) ||
     (hh === 14 && mm >= 25 && mm <= 35) ||
     (hh === 8 && mm >= 25 && mm <= 35);
    if (isNewsTime) { lastRatio = ratio; return; }

    if (this.dailyStartBal) {
     const curBal = this.cfg.dryRun ? this.simBalance : this.startBal;
     const dailyPct = (curBal - this.dailyStartBal) / this.dailyStartBal * 100;
     const dailyTpLimit = this.cfg.dailyTpPct != null ? this.cfg.dailyTpPct : 3;
     const dailySlLimit = this.cfg.dailySlPct != null ? this.cfg.dailySlPct : 2;
     if (dailyTpLimit > 0 && dailyPct >= dailyTpLimit) { lastRatio = ratio; return; }
     if (dailySlLimit > 0 && dailyPct <= -dailySlLimit) { lastRatio = ratio; return; }
    }
    // ✅ 大单信号走AI快速确认（AI主导模式也参与，置信度门槛降到50）
    this.log("open", `🔥 订单簿大单信号！${dir} | 买方${ratio}% 上根${lastRatio}% | 价格${price.toFixed(2)}`);
    try {
      const raw5mOb = await this.fetchKlines("5m", 60, this.cfg.contract);
      const raw1hOb = await this.fetchKlines("1h", 40, this.cfg.contract);
      const cs5mOb = this.buildIndicators(raw5mOb).filter(c => c.ef && c.rsi !== null);
      const curOb = cs5mOb[cs5mOb.length - 2];
      const prevOb = cs5mOb[cs5mOb.length - 3];
      if (curOb && prevOb) {
        const obAiResult = await aiAdvise({
          sig: dir, price, rsi: curOb.rsi, ef: curOb.ef, es: curOb.es, em: curOb.em,
          atr: curOb.atr, adx: 25, trend: dir, score: 60,
          recentCandles: raw5mOb, candles1h: raw1hOb, candles4h: null, candles1d: null,
          orderBook, fundingRate,
        }, this.log.bind(this));
        // ✅ 大单AI门槛50%（低于策略模式的65%）
        if (!obAiResult.allow && obAiResult.confidence < 50) {
          this.log("warn", `❌ 大单AI确认未通过 | 置信度${obAiResult.confidence}% | ${obAiResult.reason}`);
          lastRatio = ratio; return;
        }
        this.log("open", `✅ 大单AI确认通过 | 置信度${obAiResult.confidence}% | ${obAiResult.reason}`);
      }
    } catch(e) {
      this.log("warn", `⚠️ 大单AI确认失败，直接开仓 | ${e.message}`);
    }

    // ✅ 改为快进快出：止损0.5% 止盈1.0%，盈亏比2:1
const fixedSLob = +(price * 0.005).toFixed(2); // 0.5%止损
const fixedTPob = +(price * 0.010).toFixed(2); // 1.0%止盈，盈亏比2:1

let sl = dir === "LONG" ? +(price - fixedSLob).toFixed(2) : +(price + fixedSLob).toFixed(2);
let tp = dir === "LONG" ? +(price + fixedTPob).toFixed(2) : +(price - fixedTPob).toFixed(2);

this.log("open", `📐 大单止损:${sl} 止盈:${tp} (0.5%/1.0% 盈亏比2:1)`);

    const info = this.contractInfo || { mult: 0.0001 };
    const balance = this.cfg.dryRun
     ? this.simAvail
     : (await this.getBalance().catch(() => null))?.available || this.startBal;
    // ✅ 连亏降仓：连亏2次→30%，连亏3次→20%
 const lossRatio = this.consecutiveLosses >= 3 ? 0.2 : this.consecutiveLosses >= 2 ? 0.3 : 0.4;
 if (this.consecutiveLosses >= 2) this.log("warn", `⚠️ 连亏${this.consecutiveLosses}次，仓位降至${lossRatio*100}%`);
 const contracts = Math.max(1, Math.floor(
   balance * (this.cfg.posRatio / 100) * lossRatio * this.cfg.leverage / (price * info.mult)
 ));
    const notional = +(contracts * price * info.mult).toFixed(2);
    const margin = +(notional / this.cfg.leverage).toFixed(2);

    if (this.cfg.dryRun) {
     if (this.simAvail < margin) {
      this.log("error", "💰 资金不足，跳过大单信号");
      lastRatio = ratio; return;
     }
     this.simAvail -= margin;
     this.simMargin += margin;
     this.emit("balance", {
      balance: this.simAvail,
      start: this.startBal,
      total: this.simBalance,
      margin: this.simMargin,
      pnl: 0,
      totalPnl: this.simTotalPnl,
      simBalance: this.simBalance,
     });
    }

    this.log("open", `🔥 大单开仓 ${dir} ${contracts}张 | 名义${notional}U 保证金${margin.toFixed(2)}U | 入:${price.toFixed(2)} SL:${sl} TP:${tp}`);
    if (!this.cfg.dryRun) await this.placeOrder(dir, contracts);

    this.pos = {
     dir, entry: price, sl, tp, contracts, notional, margin,
     time: Date.now(), _movedToBreakeven: false,
     _tp1Hit: false, _tp2Hit: false,
     feeOpen: notional * 0.0005,
     feeClose: notional * 0.0005,
     source: "orderbook",
    };

    this.emit("position", { ...this.pos, price, pPct: 0 });
    this.emit("trade", {
     time: Date.now(), dir, entry: price, exit: null,
     contracts, notional, pPct: null, pnl: null,
     reason: "大单信号开仓", result: "open"
    });
    if (this.cfg.dryRun) this.saveSimState();
    this.emit("aiDecision", {
     time: Date.now(), sig: dir, confidence: 70,
     reason: `大单信号：买方${ratio}%跳变，趋势顺势`,
     action: "open", price, source: "orderbook",
    });
   }

   lastRatio = ratio;
   lastBidVol = bidVol;
   lastAskVol = askVol;
  } catch(e) {}
 }, 5000);
 }

 _setConn(ok) {
 if (this._connOk === ok) return;
 this._connOk = ok;
 this.emit("conn", { ok });
 this.log(ok ? "info" : "warn", ok ? "✅ API 连接已恢复" : "⚠️ API 连接异常");
 }

 scoreSignal(cur, prev, sig) {
 if (sig === "HOLD") return 0;
 let s = 50;
 if (sig === "LONG") {
  s += cur.rsi < 35 ? 15 : cur.rsi < 45 ? 10 : cur.rsi < 55 ? 5 : 0;
 } else {
  s += cur.rsi > 65 ? 15 : cur.rsi > 55 ? 10 : cur.rsi > 50 ? 3 : 0;
 }
 const ed = Math.abs(cur.ef - cur.es) / cur.close * 100;
 s += ed > 0.3 ? 15 : ed > 0.15 ? 8 : ed > 0.05 ? 3 : 0;
 const ap = cur.atr / cur.close * 100;
 s += ap > 0.4 ? 10 : ap > 0.25 ? 5 : 0;
 if (sig === "LONG" && (this.isBullC(cur) || this.isBullE(cur, prev))) s += 10;
 if (sig === "SHORT" && (this.isBearC(cur) || this.isBearE(cur, prev))) s += 10;
 return Math.min(100, s);
 }

 async run() {
 let trend1h = "HOLD";
 let trendTimeframe = "1h";
 let currentAdx = 25;
 let cur5m = null;
 let prev5m = null;
 // ✅ 防止ReferenceError：提前声明所有开仓变量
 let sl, tp, slPct, tpPct, fixedSL, fixedTP, notional, margin, contracts;

 const price = await this.getPrice();
 if (!this._lastPrice) this._lastPrice = price;
 const priceChgPct = Math.abs(price - this._lastPrice) / this._lastPrice * 100;
 if (priceChgPct > 1.0 && !this.pos) {
  this.spikeUntil = Date.now() + 10 * 60 * 1000;
  this.log("warn", `⚡ 检测到异常波动！1分钟内价格变化${priceChgPct.toFixed(2)}%，暂停开仓10分钟`);
 }
 this._lastPrice = price;

 const [orderBook, fundingRate, lsRatio] = await Promise.all([
  this.getOrderBook(),
  this.getFundingRate(),
  this.getLongShortRatio().catch(() => null),
]);

 this.emit("marketData", { orderBook, fundingRate, lsRatio: null, openInterest: null });

 if (orderBook) {
  this.log("scan", `📖 订单簿 买方${orderBook.ratio}% | ${orderBook.pressure} | 支撑${orderBook.topBid} 压力${orderBook.topAsk}`);
 }
 if (fundingRate) {
  this.log("scan", `💰 资金费率 ${fundingRate.rate}% | ${fundingRate.sentiment} | 下次结算${fundingRate.nextTime}`);
  if (lsRatio) {
  this.log("scan", `👥 多空比 多${lsRatio.longRatio}% 空${lsRatio.shortRatio}% | ${lsRatio.sentiment}`);
}
 }

 const hour = new Date().getUTCHours();
 const isLowLiquidity = (hour >= 22 || hour <= 1) || (hour >= 6 && hour <= 8);
 if (isLowLiquidity && !this.pos) {
  this.log("scan", `⏸ 低流动性时段(UTC ${hour}:00)，建议谨慎交易`);
 }

 const balData = await this.getBalance().catch(() => null);
 const balance = this.cfg.dryRun ? this.simAvail : (balData ? balData.available : this.startBal);
 if (!this.cfg.dryRun) this.emit("realBalance", { balance });

 const curSlot = Math.floor(Date.now() / (5 * 60 * 1000));
 

if (this.cfg.aiDriven && !this.pos && curSlot !== this.lastSlot) {
if (!this.running) return;
this.lastSlot = curSlot;
await this.runAiDriven(price, balance, curSlot);
return;
}

 // ✅ run()中无持仓时发送余额
 this.emit("balance", {
  balance,
  start: this.cfg.dryRun ? this.simAvail : this.startBal,
  total: this.cfg.dryRun ? this.simBalance : balance,
  margin: this.cfg.dryRun ? this.simMargin : 0,
  pnl: 0,
  totalPnl: this.simTotalPnl,
  simBalance: this.cfg.dryRun ? this.simBalance : null,
 });

 if (!this.cfg.dryRun && this.startBal) {
  const loss = (this.startBal - balance) / this.startBal;
  if (loss > this.cfg.maxLoss / 100) {
   this.log("error", `🚨 风控触发！亏损 ${(loss * 100).toFixed(1)}%`);
   this.stop();
   this.emit("stopped", { reason: "风控熔断" });
   return;
  }
 }

 const livePos = this.cfg.dryRun ? this.pos : await this.getPosition();

 // ── 持仓管理 ──
 if (livePos && this.pos) {
  const { dir, margin } = this.pos;
  const entry = this.pos.entry;
  let pPct = 0;
  let floatPnl = 0;

  pPct = dir === "LONG" ? (price - entry) / entry * 100 : (entry - price) / entry * 100;
  floatPnl = this.pos.notional * pPct / 100;
  const feeOpen = this.pos.notional * 0.0005;
  const feeClose = this.pos.notional * 0.0005;
  const totalFee = feeOpen + feeClose;
  const netPnl = floatPnl - totalFee;

  if (this.cfg.dryRun) {
   const totalAsset = this.simAvail + this.simMargin + floatPnl;
   // ✅ 持仓中：pnl=浮动盈亏（含手续费估算），totalPnl=历史累计
   this.emit("balance", {
    balance: this.simAvail,
    start: this.startBal,
    total: totalAsset,
    margin: this.simMargin,
    pnl: netPnl,
    totalPnl: this.simTotalPnl,
    simBalance: this.simBalance,
   });
   this.log("info",
`持仓 ${dir} | 入:${entry.toFixed(2)} 现:${price.toFixed(2)} ${pPct>=0?"+":""}${pPct.toFixed(2)}% SL:${this.pos.sl} TP:${this.pos.tp}${this.pos._movedToBreakeven?" 🔒保本":""}`);
this.log("info",
`💰 浮动盈亏:${floatPnl>=0?"+":""}${floatPnl.toFixed(2)}U | 手续费:~${totalFee.toFixed(2)}U | 净利:${netPnl>=0?"+":""}${netPnl.toFixed(2)}U`);
} else {
this.log("info",
`持仓 ${dir} | 入:${entry.toFixed(2)} 现:${price.toFixed(2)} ${pPct>=0?"+":""}${pPct.toFixed(2)}% SL:${this.pos.sl} TP:${this.pos.tp}`);
}
this.emit("position", { ...this.pos, price, pPct: +pPct.toFixed(2) });


// 分批止盈
if (!this.pos._tp1Hit && pPct >= (this.cfg.tp1Pct || 3)) {
this.pos._tp1Hit = true;
await this.partialClose(0.3);
this.log("open", `第一止盈位命中！平仓30%`);
}
if (!this.pos._tp2Hit && pPct >= (this.cfg.tp2Pct || 6)) {
this.pos._tp2Hit = true;
await this.partialClose(0.3);
this.log("open", `第二止盈位命中！再平仓30%`);
}

// AI持仓巡检
const checkInterval = 120000; // 统一2分钟
const curMinSlot = Math.floor(Date.now() / checkInterval);
const shouldAiCheck = curMinSlot !== this.lastAiCheckSlot;
if (shouldAiCheck && this.pos.contracts > 0) {
this.lastAiCheckSlot = curMinSlot;
const [obCheck, frCheck, lsCheck, oiCheck] = await Promise.all([
this.getOrderBook().catch(() => null),
this.getFundingRate().catch(() => null),
this.getLongShortRatio().catch(() => null),
this.getOpenInterest().catch(() => null),
]);
if (!this.pos) return;
const holdMinutes = Math.floor((Date.now() - this.pos.time) / 60000);
const checkResult = await aiCheckPosition({
dir, entry, price, pPct,
sl: this.pos.sl, tp: this.pos.tp, holdMinutes,
orderBook: obCheck, fundingRate: frCheck,
lsRatio: lsCheck,
openInterest: oiCheck,
}, this.log.bind(this));

// ✅ AI趋势反转保利平仓：浮盈≥0.35%且AI建议close → 立即平仓锁住利润
if (checkResult.action === "close" && pPct >= 0.35) {
  this.log("warn", `🤖 AI趋势反转保利平仓 | 浮盈${pPct.toFixed(2)}%≥0.35% | ${checkResult.reason}`);
  // 直接走下面的 close 逻辑（不修改checkResult，已是close）
} else if (checkResult.action === "close" && pPct < 0.35 && pPct > -0.1) {
  // 浮盈不足0.35%时，close降级为hold，避免过早平仓
  this.log("scan", `🤖 AI建议平仓但浮盈${pPct.toFixed(2)}%<0.35%，降级为hold | ${checkResult.reason}`);
  checkResult.action = "hold";
}

if (checkResult.action === "reduce") {
this.log("warn", "🤖 AI执行减仓50% | " + checkResult.reason);
await this.partialClose(0.5);
if (this.cfg.dryRun) {
const releasedMargin = this.pos.margin * 0.5;
this.simMargin -= releasedMargin;
this.simAvail += releasedMargin;
}
this.emit("trade", {
time: Date.now(), dir, entry, exit: price,
contracts: Math.floor(this.pos.contracts * 0.5),
notional: +(this.pos.notional * 0.5).toFixed(2),
pPct: +pPct.toFixed(2),
pnl: +(this.pos.notional * 0.5 * pPct / 100 - this.pos.notional * 0.5 * 0.001).toFixed(2),
reason: "AI减仓-" + checkResult.reason,
result: pPct >= 0 ? "win" : "loss"
});
}

// ── 本地兜底：AI巡检超时时持仓过久自动平仓 ──
if (!checkResult || checkResult.reason === "巡检失败") {
    const holdMinutesFb = Math.floor((Date.now() - this.pos.time) / 60000);
    const netPnlFb = this.pos.notional * pPct / 100 - (this.pos.feeOpen || 0) - (this.pos.feeClose || 0);
    if (holdMinutesFb >= 150 && netPnlFb < 0) {
        this.log("warn", `⏰ 本地兜底：持仓${holdMinutesFb}分钟且净亏损，强制平仓`);
        checkResult = { action: "close", reason: "超时横盘，浮盈不足" };
    }
}

if (checkResult.action === "close") {
    this.log("warn", "🤖 AI执行平仓 | " + checkResult.reason);
// 只扣平仓手续费（开仓手续费开仓时已扣）
const feeClose = this.pos.feeClose || +(this.pos.notional * 0.0005).toFixed(4);
const pnl = this.pos.notional * pPct / 100 - feeClose;
if (pnl < 0) {
  this.consecutiveLosses = (this.consecutiveLosses || 0) + 1;
  this.log("warn", `📊 AI平仓连亏计数: ${this.consecutiveLosses}次`);
} else {
  this.consecutiveLosses = 0;
}
if (this.cfg.dryRun) {
this.simAvail += this.simMargin;
this.simBalance += pnl;
this.simTotalPnl += pnl;
this.simMargin = 0;
// ✅ AI平仓后
this.emit("balance", {
balance: this.simAvail,
start: this.startBal,
total: this.simBalance,
margin: this.simMargin,
pnl: 0,
totalPnl: this.simTotalPnl,
simBalance: this.simBalance,
});
this.log(pnl >= 0 ? "win" : "loss",
"🤖 AI平仓结算 | " + checkResult.reason +
" | 盈亏 " + (pnl >= 0 ? "+" : "") + pnl.toFixed(2) + "U" +
" | 总资产 " + this.simBalance.toFixed(2) + "U");
} else {
await this.closePosition(livePos.size, dir);
}
this.emit("trade", {
time: Date.now(), dir, entry, exit: price,
contracts: this.pos.contracts, notional: this.pos.notional,
pPct: +pPct.toFixed(2), pnl: +pnl.toFixed(2),
reason: "AI平仓-" + checkResult.reason,
result: pnl >= 0 ? "win" : "loss"
});
this.pos = null;
this.emit("position", null);
if (this.cfg.dryRun) this.saveSimState();
return;
}
}

// 移动止损
if (this.pos.contracts > 0 && this.cfg.trailPct > 0) {
const tr = this.cfg.trailPct / 100;
const nsl = +(price * (dir === "LONG" ? 1 - tr : 1 + tr)).toFixed(2);
const better = dir === "LONG" ? nsl > this.pos.sl : nsl < this.pos.sl;
if (better) { this.pos.sl = nsl; this.log("scan", `📐 移动止损 → ${nsl}`); }
}
if (!this.pos || !this.pos.sl || !this.pos.tp) return;
const hitSL = dir === "LONG" ? price <= this.pos.sl : price >= this.pos.sl;
const hitTP = dir === "LONG" ? price >= this.pos.tp : price <= this.pos.tp;

if ((hitTP || hitSL) && !this._closing && this.pos) {
this._closing = true;
const reason = hitTP ? "止盈" : (this.pos._movedToBreakeven ? "保本出场" : "止损");
const feeClose = this.pos.feeClose || +(this.pos.notional * 0.0005).toFixed(4);
const pnl = this.pos.notional * pPct / 100 - feeClose;
// ✅ 连亏计数（保本出场也算赢，重置计数）
if (hitTP || reason === "移动止损锁利") {
this.consecutiveLosses = 0;
} else if (pnl < 0) {
this.consecutiveLosses = (this.consecutiveLosses || 0) + 1;
this.log("warn", `📊 连亏计数: ${this.consecutiveLosses}次`);
} else {
this.consecutiveLosses = 0;
}

if (this.cfg.dryRun) {
this.simAvail += this.simMargin;
this.simBalance += pnl;
this.simTotalPnl += pnl;
this.simMargin = 0;
// ✅ run()平仓后
this.emit("balance", {
balance: this.simAvail,
start: this.startBal,
total: this.simBalance,
margin: this.simMargin,
pnl: 0,
totalPnl: this.simTotalPnl,
simBalance: this.simBalance,
});
this.log(pnl >= 0 ? "win" : "loss",
`💰 平仓结算 | ${reason} | 盈亏 ${pnl>=0?"+":""}${pnl.toFixed(2)}U | 总资产 ${this.simBalance.toFixed(2)}U | 累计 ${this.simTotalPnl>=0?"+":""}${this.simTotalPnl.toFixed(2)}U`);
} else {
this.log(pnl >= 0 ? "win" : "loss",
`💰 平仓结算 | ${reason} | 净盈亏 ${pnl>=0?"+":""}${pnl.toFixed(2)}U（含手续费）`);
}

if (!this.cfg.dryRun) await this.closePosition(livePos.size, dir);

if (!hitTP) {
const lossPct = Math.abs(pPct);
// ✅ 差异化冷却：<1%=5min，1-2%=10min，2-3%=20min，>3%=30min
const coolSlots = lossPct > 3 ? 6 : lossPct > 2 ? 4 : lossPct > 1 ? 2 : 1;
// 6×5=30min，4×5=20min，2×5=10min，1×5=5min
this.cooldownUntilSlot = curSlot + coolSlots;
this.log("warn", "⏸ 冷却期启动，" + (coolSlots*5) + "分钟内不开新仓（亏损" + lossPct.toFixed(1) + "%）");
}

this.emit("trade", {
time: Date.now(), dir, entry, exit: price,
contracts: this.pos.contracts, notional: this.pos.notional,
pPct: +pPct.toFixed(2), pnl: +pnl.toFixed(2), reason,
result: pnl >= 0 ? "win" : "loss"
});

this._closing = false;
this.pos = null;
this.emit("position", null);
if (this.cfg.dryRun) this.saveSimState();
return;
}

if (!this.cfg.dryRun) {
this.emit("position", { ...this.pos, price, pPct: +pPct.toFixed(2) });
}
return;
}
// ── 开仓 ──
if (!this.pos && curSlot !== this.lastSlot) {
this.lastSlot = curSlot;
if (Date.now() < this.spikeUntil) {
const remain = Math.ceil((this.spikeUntil - Date.now()) / 60000);
this.log("scan", `⚡ 异常行情保护中，剩余${remain}分钟`); return;
}

const todayDate = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
if (this.dailyDate !== todayDate) {
this.dailyDate = todayDate;
this.dailyStartBal = this.cfg.dryRun ? this.simBalance : (await this.getBalance().catch(() => null))?.available || this.startBal;
this.dailyPnl = 0;
this.log("info", `📅 新的一天 | 起始余额: ${this.dailyStartBal?.toFixed(2)}U`);
}
const curBal = this.cfg.dryRun ? this.simBalance : (await this.getBalance().catch(() => null))?.available || this.startBal;
if (this.dailyStartBal) {
this.dailyPnl = curBal - this.dailyStartBal;
const dailyPct = (this.dailyPnl / this.dailyStartBal * 100);
const dailyTpLimit = this.cfg.dailyTpPct != null ? this.cfg.dailyTpPct : 3;
const dailySlLimit = this.cfg.dailySlPct != null ? this.cfg.dailySlPct : 2;
if (dailyTpLimit > 0 && dailyPct >= dailyTpLimit) {
this.log("win", `🎯 今日盈利已达${dailyPct.toFixed(2)}%，自动停止开新仓！`); return;
}
if (dailySlLimit > 0 && dailyPct <= -dailySlLimit) {
this.log("error", `🛑 今日亏损已达${Math.abs(dailyPct).toFixed(2)}%，自动停止开新仓！`); return;
}
this.log("scan", `📅 今日盈亏: ${this.dailyPnl>=0?"+":""}${this.dailyPnl.toFixed(2)}U (${dailyPct>=0?"+":""}${dailyPct.toFixed(2)}%)`);
}
const raw5m = await this.fetchKlines("5m", 300, this.cfg.contract);
const raw1h = await this.fetchKlines("1h", 100, this.cfg.contract);
const raw4h = await this.fetchKlines("4h", 60, this.cfg.contract);
const raw1d = await this.fetchKlines("1d", 30, this.cfg.contract);
if (curSlot < this.cooldownUntilSlot) {
this.log("scan", `⏸ 冷却期 剩余约${(this.cooldownUntilSlot - curSlot) * 5}分钟，跳过本次扫描`); return;
}



let rawTrend;
if (this.cfg.trendMode === "auto") {
const adx5m = this.adxCalc(raw5m, 14);
currentAdx = adx5m[adx5m.length - 1] || 25;
trendTimeframe = currentAdx > 30 ? "1h" : "30m";
rawTrend = await this.fetchKlines(trendTimeframe, trendTimeframe === "1h" ? 60 : 100);
this.log("scan", `📊 自适应模式 ADX:${currentAdx.toFixed(1)} → ${trendTimeframe}`);
} else if (this.cfg.trendMode === "30m") {
trendTimeframe = "30m"; rawTrend = await this.fetchKlines("30m", 100);
this.log("scan", `⚡ 激进模式: 30分钟趋势过滤`);
} else {
trendTimeframe = "1h"; rawTrend = await this.fetchKlines("1h", 60);
this.log("scan", `🛡️ 保守模式: 1小时趋势过滤`);
}

const cs5m = this.buildIndicators(raw5m).filter(c => c.ef && c.rsi !== null && c.bbUp);
const csTrend = this.buildIndicators(rawTrend).filter(c => c.ef && c.rsi !== null);
// ✅ 5m信号用倒数第二根(已收盘)保证信号准确；趋势判断用最新根(含未收盘)即时反映价格突破
cur5m = cs5m[cs5m.length - 2];
prev5m = cs5m[cs5m.length - 3];

if (!cur5m || !prev5m) { this.log("warn", "5分钟数据不足，跳过"); return; }

// ── 行情模式识别（每5分钟检测一次）──
const raw30mForMode = trendTimeframe === "30m" ? rawTrend : await this.fetchKlines("30m", 16).catch(() => null);
const raw30mInd = raw30mForMode ? this.buildIndicators(raw30mForMode).filter(c => c.ef && c.rsi !== null) : null;
if (raw30mInd && raw30mInd.length >= 8) {
  const newMode = this.detectMarketMode(raw30mInd);
  if (newMode !== this.marketMode) {
    this.marketMode = newMode;
    this.log("scan", `🔄 行情模式切换: ${newMode === "oscillation" ? "⬜ 震荡模式" : "📈 趋势模式"}`);
  }
}
this.emit("marketMode", { mode: this.marketMode });

const sig = this.getSignal(cur5m, prev5m);
if (csTrend.length >= 2) {
// ✅ 趋势EMA用最新K线(含当前未收盘)，即时捕获价格突破，避免30m EMA差滞后
const cTrend = csTrend[csTrend.length - 1] || csTrend[csTrend.length - 2];
const ema_diff_trend = (cTrend.ef - cTrend.es) / cTrend.es * 100;
trend1h = ema_diff_trend > 0.07 ? "LONG" : ema_diff_trend < -0.07 ? "SHORT" : "HOLD";
if (trend1h === "HOLD") {
  // ── 震荡模式：EMA差不足时尝试震荡策略 ──
  if (this.marketMode === "oscillation") {
    const oscSig = this.getOscSignal(cur5m, orderBook);
    if (oscSig !== "HOLD") {
      const oscSigCN = oscSig === "LONG" ? "做多📈" : "做空📉";
      this.log("scan", `⬜ 震荡模式 [5m] 价格:${price} RSI:${cur5m.rsi.toFixed(1)} | 【${oscSigCN}】 区间反转信号`);
      // 调用震荡专用AI判断
      const oscAi = await aiAdviseOscillation({
        sig: oscSig, price, rsi: cur5m.rsi, ef: cur5m.ef, es: cur5m.es,
        orderBook, fundingRate,
        lsRatio: typeof lsRatio !== "undefined" ? lsRatio : null,
      }, this.log.bind(this));
      if (!oscAi.allow) {
        this.log("scan", `⬜ 震荡模式 AI拒绝 | ${oscAi.reason}`);
        return;
      }
      // 震荡模式参数：止盈0.5%，止损0.3%，固定仓位50%
      const oscSlPct = 0.003;
      const oscTpPct = 0.005;
      let oscSL, oscTP;
      if (oscAi.suggestSL && oscAi.suggestTP) {
        oscSL = oscAi.suggestSL;
        oscTP = oscAi.suggestTP;
        this.log("open", `🤖 震荡模式使用AI止损:${oscSL} 止盈:${oscTP}`);
      } else {
        oscSL = oscSig === "LONG" ? +(price * (1 - oscSlPct)).toFixed(2) : +(price * (1 + oscSlPct)).toFixed(2);
        oscTP = oscSig === "LONG" ? +(price * (1 + oscTpPct)).toFixed(2) : +(price * (1 - oscTpPct)).toFixed(2);
      }
      const info2 = this.contractInfo || { mult: 0.0001 };
      const bal2 = this.cfg.dryRun ? this.simBalance : (await this.getBalance().catch(() => null))?.available || this.startBal;
      const oscContracts = Math.max(1, Math.floor(bal2 * (this.cfg.posRatio / 100) * 0.5 * this.cfg.leverage / (price * info2.mult)));
      const oscNotional = +(oscContracts * price * info2.mult).toFixed(2);
      const oscMargin = +(oscNotional / this.cfg.leverage).toFixed(2);
      this.log("open", `⬜ 震荡开仓 | 方向:${oscSig} 入场:${price} 止损:${oscSL}(${(oscSlPct*100).toFixed(1)}%) 止盈:${oscTP}(${(oscTpPct*100).toFixed(1)}%) 仓位50% AI置信:${oscAi.confidence}%`);
      const emaDiffForOpen = Math.abs((cur5m.ef - cur5m.es) / cur5m.es * 100);
      await this._executeOpen(oscSig, price, oscSL, oscTP, oscContracts, oscNotional, oscMargin, bal2, emaDiffForOpen, "oscillation");
    } else {
      this.log("scan", `⬜ 震荡模式 | RSI:${cur5m.rsi.toFixed(1)} 未达反转条件(需RSI<32或>68)，等待`);
    }
  } else {
    this.log("scan", `⏸ 趋势不明朗(EMA差${ema_diff_trend.toFixed(3)}%)，跳过`);
  }
  return;
}
}

const score = this.scoreSignal(cur5m, prev5m, sig);
const mtfOk = sig !== "HOLD" && sig === trend1h;
const sigCN = sig === "LONG" ? "做多📈" : sig === "SHORT" ? "做空📉" : "观望";
const mtfStr = sig === "HOLD" ? "" : (mtfOk ? ` ✅${trendTimeframe}顺势(${trend1h})` : ` ⚠️${trendTimeframe}逆势(${trend1h})`);
this.log("scan", `[5m] 价格:${price} RSI:${cur5m.rsi.toFixed(1)} EMA9/21:${cur5m.ef.toFixed(0)}/${cur5m.es.toFixed(0)} | 【${sigCN}】${mtfStr} 评分:${score}`);
this.emit("signal", { sig, price, rsi: cur5m.rsi, ef: cur5m.ef, es: cur5m.es, em: cur5m.em, bbUp: cur5m.bbUp, bbLo: cur5m.bbLo, score, mtfOk, trend1h });

if (sig !== "HOLD") {
if (sig === this.lastSigDir) {
this.lastSigCount++;
// ✅ 连续信号过滤：3-5次跳过震荡，但EMA差>0.1%时为真趋势，允许进入AI决策
const emaDiffNow = Math.abs((cur5m.ef - cur5m.es) / cur5m.es * 100);
const isStrongTrend = emaDiffNow > 0.10; // EMA差超过0.1%认为是真趋势突破
if (this.lastSigCount >= 3 && this.lastSigCount < 6) {
  if (isStrongTrend) {
    this.log("scan", `✅ ${sig}信号连续${this.lastSigCount}次，EMA差${emaDiffNow.toFixed(3)}%>0.1%确认趋势突破，进入AI决策`);
    // 不return，继续往下走AI决策
  } else {
    this.log("scan", `🔄 ${sig}信号连续${this.lastSigCount}次，EMA差${emaDiffNow.toFixed(3)}%偏小，震荡行情跳过`); return;
  }
} else if (this.lastSigCount >= 6 && score < 60) {
  this.log("scan", `🔄 ${sig}信号连续${this.lastSigCount}次，趋势持续但评分${score}<60，跳过`); return;
} else if (this.lastSigCount >= 6) {
  this.log("scan", `✅ ${sig}信号连续${this.lastSigCount}次，确认趋势持续，允许开仓`);
}
} else { this.lastSigDir = sig; this.lastSigCount = 1; }
}

if (sig !== "HOLD" && score >= 45) {
const stats = this.getWinStats();
// ✅ 超卖保护：RSI<20时不做空（急跌后反弹风险）
if (sig === "SHORT" && cur5m.rsi < 20) {
  this.log("scan", `⛔ RSI${cur5m.rsi.toFixed(1)}<20 极度超卖，禁止做空（防止追空急跌反弹）`);
  return;
}
// ✅ 超买保护：RSI>80时不做多（急涨后回调风险）
if (sig === "LONG" && cur5m.rsi > 80) {
  this.log("scan", `⛔ RSI${cur5m.rsi.toFixed(1)}>80 极度超买，禁止做多（防止追多急涨回调）`);
  return;
}
// ✅ 空头胜率保护：历史空头胜率低于40%时，连亏状态下跳过SHORT
if (sig === "SHORT" && stats && parseFloat(stats.shortWinRate) < 40 && this.consecutiveLosses >= 2) {
  this.log("scan", `⛔ 空头胜率${stats.shortWinRate}%偏低+连亏${this.consecutiveLosses}次，跳过SHORT信号`);
  return;
}

// ✅ 连亏保护：连亏3次以上提高评分门槛，减少开仓
const minScore = this.consecutiveLosses >= 3 ? 60 : 45;
if (score < minScore) {
this.log("scan", `⚠️ 连亏${this.consecutiveLosses}次，评分门槛提升至${minScore}，当前${score}分跳过`);
return;
}
const aiResult = await aiAdvise({
sig, price, rsi: cur5m.rsi, ef: cur5m.ef, es: cur5m.es, em: cur5m.em,
atr: cur5m.atr, adx: currentAdx, trend: trend1h, score,
sigCount: this.lastSigCount, score,
recentCandles: raw5m, candles1h: raw1h, candles4h: raw4h, candles1d: raw1d,
orderBook, fundingRate,
}, this.log.bind(this));
this.log("scan", `🤖 AI决策依据: ${aiResult.reason || JSON.stringify(aiResult).slice(0, 200)}`);

this.emit("aiDecision", {
time: Date.now(), sig, confidence: aiResult.confidence, reason: aiResult.reason,
action: aiResult.allow ? "open" : "skip", price,
suggestSL: aiResult.suggestSL, suggestTP: aiResult.suggestTP, source: "strategy",
});

if (!aiResult.allow) {
const emaDiffNowAdj = Math.abs((cur5m.ef - cur5m.es) / cur5m.es * 100);
const isAiTimeout = aiResult.error && aiResult.confidence === 0;
const isAiUncertain = !isAiTimeout && aiResult.confidence < 60; // AI不确定（置信<60%）
const isStrongSignal = score >= 63 && emaDiffNowAdj >= 0.1 && mtfOk; // 高质量顺势信号

// ✅ AI不确定（置信<60%）或超时，且技术面强（评分≥65 + EMA差≥0.1% + 顺势）→ 缩仓50%开仓
// ✅ v17: score门槛63→65；低流动性时段禁止bypass；bypass前验证K线方向
if (isStrongSignal && (isAiUncertain || isAiTimeout)) {
  // 禁止条件1：低流动性时段不允许bypass
  const nowH = new Date().getUTCHours();
  const isLowLiqHour = (nowH >= 22 || nowH <= 1) || (nowH >= 6 && nowH <= 8);
  if (isLowLiqHour) {
    this.log("warn", `❌ Bypass拒绝：低流动性时段(UTC ${nowH}:00)，不允许bypass开仓`);
    return;
  }
  // 禁止条件2：检查最近3根5m蜡烛是否与信号方向一致（防止开仓在反向突破中）
  const recentCandles = cs5m.slice(-4, -1); // 取最近3根已收盘K线
  if (recentCandles.length >= 3) {
    const bullishCount = recentCandles.filter(c => c.close > c.open).length;
    const bearishCount = recentCandles.filter(c => c.close < c.open).length;
    if (sig === "SHORT" && bullishCount >= 2) {
      this.log("warn", `❌ Bypass拒绝：最近3根K线${bullishCount}根阳线，做空信号方向与K线走势矛盾`);
      return;
    }
    if (sig === "LONG" && bearishCount >= 2) {
      this.log("warn", `❌ Bypass拒绝：最近3根K线${bearishCount}根阴线，做多信号方向与K线走势矛盾`);
      return;
    }
  }
  const reason = isAiTimeout ? "AI超时" : `AI置信度${aiResult.confidence}%<60%`;
  this.log("warn", `⚠️ ${reason}但技术面强(评分${score} EMA差${emaDiffNowAdj.toFixed(3)}%)，缩仓50%开仓 | ${aiResult.reason}`);
  // 继续往下执行，posRatioAdj改为0.5
// ❌ 逆势bypass已关闭（容易在反弹/回调中被套）
} else {
  this.emit("signal", { sig, price, rsi: cur5m.rsi, ef: cur5m.ef, es: cur5m.es,
  em: cur5m.em, bbUp: cur5m.bbUp, bbLo: cur5m.bbLo, score, mtfOk, trend1h,
  aiConfidence: aiResult.confidence, aiReason: aiResult.reason, aiAllow: false });
  return;
}
}

const info = this.contractInfo || { mult: 0.0001 };
// ✅ 仓位调整：AI不确定/超时但技术面强（顺势bypass）→ 缩仓50%；其他（AI放行）→ 正常仓位
const emaDiffNowAdj2 = Math.abs((cur5m.ef - cur5m.es) / cur5m.es * 100);
const isAiTimeoutAdj = aiResult.error && aiResult.confidence === 0;
const isAiUncertainAdj = !isAiTimeoutAdj && aiResult.confidence < 60;
const isHalfPos = !aiResult.allow && (
  (score >= 65 && emaDiffNowAdj2 >= 0.1 && mtfOk && (isAiUncertainAdj || isAiTimeoutAdj))
);
const posRatioAdj = isHalfPos ? 0.5 : 1.0;
contracts = Math.max(1, Math.floor(
balance * (this.cfg.posRatio / 100) * posRatioAdj * this.cfg.leverage / (price * info.mult)
));
this.log("open", `💰 仓位调整: ${posRatioAdj < 1 ? "逆势缩仓" + (posRatioAdj*100).toFixed(0) + "%" : "置信度" + aiResult.confidence + "%"} → ${contracts}张`);
notional = +(contracts * price * info.mult).toFixed(2);
margin = +(notional / this.cfg.leverage).toFixed(2);

// ✅ 根据趋势强度动态调整止损/止盈
const uiSlPct = (this.cfg.stopPct || 1.0) / 100;
// ✅ 震荡行情参数：止盈止损跟随UI配置，动态倍数缩小避免被大波动止损
const uiTpPct = Math.max((this.cfg.takePct || 1.5) / 100, 0.015);
const emaDiffAbs = Math.abs((cur5m.ef - cur5m.es) / cur5m.es * 100);
// slPct, tpPct already declared at top of run()
if (emaDiffAbs > 0.6) {
slPct = uiSlPct * 1.5; tpPct = uiTpPct * 2.0; // 强趋势：止损1.2% 止盈3%
this.log("open", `📊 强趋势 → 止损${(slPct*100).toFixed(1)}% 止盈${(tpPct*100).toFixed(1)}%`);
} else if (emaDiffAbs > 0.3) {
slPct = uiSlPct * 1.2; tpPct = uiTpPct * 1.5; // 中趋势：止损1% 止盈2.25%
this.log("open", `📊 中趋势 → 止损${(slPct*100).toFixed(1)}% 止盈${(tpPct*100).toFixed(1)}%`);
} else {
slPct = uiSlPct; tpPct = uiTpPct; // 弱趋势/震荡：直接用UI设定
this.log("open", `📊 弱趋势 → 止损${(slPct*100).toFixed(1)}% 止盈${(tpPct*100).toFixed(1)}%`);
}

fixedSL = +(price * slPct).toFixed(2);
fixedTP = +(price * tpPct).toFixed(2);

const aiSLValid = aiResult.suggestSL &&
Math.abs(aiResult.suggestSL - price) / price >= 0.003 &&
Math.abs(aiResult.suggestSL - price) / price <= 0.03;
const aiTPValid = aiResult.suggestTP &&
Math.abs(aiResult.suggestTP - price) / price >= 0.008 &&
Math.abs(aiResult.suggestTP - price) / price <= 0.08;

// ✅ sl/tp在run()顶部已声明，直接赋值
sl = sig === "LONG" ? +(price - fixedSL).toFixed(2) : +(price + fixedSL).toFixed(2);
tp = sig === "LONG" ? +(price + fixedTP).toFixed(2) : +(price - fixedTP).toFixed(2);

if (aiSLValid && aiTPValid) {
// 验证盈亏比 >= 1.5:1 才使用AI建议
const aiSlDist = Math.abs(aiResult.suggestSL - price);
const aiTpDist = Math.abs(aiResult.suggestTP - price);
if (aiTpDist / aiSlDist >= 1.5) {
sl = aiResult.suggestSL;
tp = aiResult.suggestTP;
this.log("open", `🤖 使用AI止损:${sl} 止盈:${tp} 盈亏比:${(aiTpDist/aiSlDist).toFixed(1)}`);
} else {
// AI盈亏比不达标，用固定标准
sl = sig === "LONG" ? +(price - fixedSL).toFixed(2) : +(price + fixedSL).toFixed(2);
tp = sig === "LONG" ? +(price + fixedTP).toFixed(2) : +(price - fixedTP).toFixed(2);
this.log("open", `📐 AI盈亏比不足，用固定标准 SL:${sl} TP:${tp}`);
}
} else {
// AI无效，用固定标准
sl = sig === "LONG" ? +(price - fixedSL).toFixed(2) : +(price + fixedSL).toFixed(2);
tp = sig === "LONG" ? +(price + fixedTP).toFixed(2) : +(price - fixedTP).toFixed(2);
this.log("open", `📐 固定止损:${sl} 止盈:${tp} (0.3%/0.6%)`);
}

// 最终安全验证（用固定标准兜底）
if (sig === "LONG") {
if (sl >= price) sl = +(price - fixedSL).toFixed(2);
if (tp <= price) tp = +(price + fixedTP).toFixed(2);
} else {
if (sl <= price) sl = +(price + fixedSL).toFixed(2);
if (tp >= price) tp = +(price - fixedTP).toFixed(2);
}
this.log("open", `🤖 使用AI止损:${sl} 止盈:${tp}`);
// ✅ 修复：移除多余的"}"，让以下开仓代码继续在 if(sig!="HOLD"&&score>=45) 块内执行

if (this.cfg.dryRun) {
if (this.simAvail < margin) {
this.log("error", `💰 模拟账户资金不足！需要 ${margin.toFixed(2)}U，可用 ${this.simAvail.toFixed(2)}U`); return;
}

const feeOpen = +(notional * 0.0005).toFixed(4);
this.simAvail -= margin + feeOpen;
this.simMargin += margin;
this.simBalance -= feeOpen;
this.log("open", `💸 开仓手续费: ${feeOpen.toFixed(4)}U`);

// ✅ 开仓时
this.emit("balance", {
balance: this.simAvail, start: this.startBal,
total: this.simBalance, margin: this.simMargin,
pnl: 0, totalPnl: this.simTotalPnl,
simBalance: this.simBalance,
});
this.log("open", `💰 扣除保证金 ${margin.toFixed(2)}U，可用 ${this.simAvail.toFixed(2)}U，冻结 ${this.simMargin.toFixed(2)}U`);
}

this.log("open", `开仓 ${sig} ${contracts}张 (~${notional}U) 评分${score} AI置信度${aiResult.confidence}% | 入:${price.toFixed(2)} SL:${sl} TP:${tp}`);
if (!this.cfg.dryRun) await this.placeOrder(sig, contracts);

this.emit("trade", { time: Date.now(), dir: sig, entry: price, exit: null, contracts, notional, pPct: null, pnl: null, reason: "开仓", result: "open" });
this.pos = {
dir: sig, entry: price, sl, tp, contracts, notional, margin,
time: Date.now(), openTime: Date.now(),
_movedToBreakeven: false, _tp1Hit: false, _tp2Hit: false,
feeOpen: notional * 0.0005, feeClose: notional * 0.0005,
emaDiffAtOpen: emaDiffAbs, posType: "trend",
};
this.emit("position", { ...this.pos, price, pPct: 0 });
if (this.cfg.dryRun) this.saveSimState();
 } // closes if(sig !== "HOLD" && score >= 45)
 } // closes if(!this.pos && curSlot !== this.lastSlot) or outer block
 } // closes async run()

saveSimState() {
if (!this.cfg.dryRun || !this.simFile) return;
const state = {
pos: this.pos, simBalance: this.simBalance, simAvail: this.simAvail,
simMargin: this.simMargin, simTotalPnl: this.simTotalPnl,
startBal: this.startBal, lastSaveTime: Date.now(),
consecutiveLosses: this.consecutiveLosses
};
try {
const fs = require("fs");
fs.writeFileSync(this.simFile, JSON.stringify(state, null, 2), "utf8");
} catch (e) { this.log("error", "保存模拟状态失败: " + e.message); }
}

// ✅ P1修复：实盘模式连亏计数持久化
saveLiveState() {
if (this.cfg.dryRun) return;
try {
const fs = require("fs"), path = require("path");
const dir = path.join(__dirname, "..", "data");
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
const liveFile = path.join(dir, "live_state_" + (this.cfg.contract || "BTC_USDT") + ".json");
fs.writeFileSync(liveFile, JSON.stringify({ consecutiveLosses: this.consecutiveLosses, lastSaveTime: Date.now() }, null, 2), "utf8");
} catch(e) {}
}

loadLiveState() {
if (this.cfg.dryRun) return;
try {
const fs = require("fs"), path = require("path");
const liveFile = path.join(__dirname, "..", "data", "live_state_" + (this.cfg.contract || "BTC_USDT") + ".json");
if (!fs.existsSync(liveFile)) return;
const state = JSON.parse(fs.readFileSync(liveFile, "utf8"));
this.consecutiveLosses = state.consecutiveLosses || 0;
if (this.consecutiveLosses > 0) this.log("warn", `📊 恢复连亏计数: ${this.consecutiveLosses}次`);
} catch(e) {}
}

startDailyReportTimer() {
this.reportTimer = setInterval(() => {
if (!this.running) return;
const now = new Date(Date.now() + 8 * 3600000);
const h = now.getUTCHours(), m = now.getUTCMinutes();
if (h === 15 && m === 55 && !this._reportSentToday) { this._reportSentToday = true; this.generateDailyReport(); }
if (h === 16 && m === 0) { this._reportSentToday = false; }
}, 60000);
}

loadSimState() {
if (!this.cfg.dryRun || !this.simFile) return false;
try {
const fs = require("fs");
if (!fs.existsSync(this.simFile)) return false;
const state = JSON.parse(fs.readFileSync(this.simFile, "utf8"));
if (state.simBalance != null) {
this.simBalance = state.simBalance;
this.simAvail = state.simAvail || state.simBalance;
this.simMargin = state.simMargin || 0;
this.simTotalPnl = state.simTotalPnl || 0;
this.consecutiveLosses = state.consecutiveLosses || 0; 
this.startBal = state.simAvail || state.simBalance || this.cfg.capital;
}
if (state.pos) {
this.pos = state.pos;
if (this.simMargin > 0) {
this.simAvail = this.simBalance - this.simMargin;
}
this.log("info", `📂 恢复模拟持仓: ${this.pos.dir} ${this.pos.contracts}张 @ ${this.pos.entry}`);
this.log("info", `💰 恢复资金状态: 总额${this.simBalance.toFixed(2)}U 可用${this.simAvail.toFixed(2)}U 累计${this.simTotalPnl.toFixed(2)}U`);
this.emit("position", { ...this.pos, price: this.pos.entry, pPct: 0 });
return true;
} else if (state.simBalance != null) {
this.log("info", `💰 恢复资金状态: 总额${this.simBalance.toFixed(2)}U 可用${this.simAvail.toFixed(2)}U 累计${this.simTotalPnl.toFixed(2)}U`);
return true;
}
} catch (e) { this.log("error", "加载模拟状态失败: " + e.message); }

return false;

}

clearSimState() {
if (!this.simFile) return;
try {
const fs = require("fs");
if (fs.existsSync(this.simFile)) { fs.unlinkSync(this.simFile); this.log("info", "🗑️ 模拟状态已清除"); }
} catch (e) { this.log("error", "清除模拟状态失败: " + e.message); }
}

// ── 历史胜率存储 ──
loadTradeHistory() {
  try {
    const fs = require("fs");
    if (!this.historyFile || !fs.existsSync(this.historyFile)) return;
    this.tradeHistory = JSON.parse(fs.readFileSync(this.historyFile, "utf8")) || [];
    this.log("info", `📊 加载历史交易记录: ${this.tradeHistory.length}条`);
  } catch(e) {
    this.tradeHistory = [];
  }
}

saveTradeHistory() {
  try {
    if (!this.historyFile) return;
    const fs = require("fs");
    // 只保留最近200条
    if (this.tradeHistory.length > 200) {
      this.tradeHistory = this.tradeHistory.slice(-200);
    }
    fs.writeFileSync(this.historyFile, JSON.stringify(this.tradeHistory, null, 2), "utf8");
  } catch(e) {}
}

// ── 每日报告 ──
generateDailyReport() {
  const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  const todayTrades = this.tradeHistory.filter(t => {
    const d = new Date(t.time + 8 * 3600000).toISOString().slice(0, 10);
    return d === today;
  });

  if (todayTrades.length === 0) {
    this.log("info", `📊 今日报告 | 暂无交易记录`);
    return;
  }

  const closed = todayTrades.filter(t => t.result === "win" || t.result === "loss");
  const wins = closed.filter(t => t.result === "win").length;
  const losses = closed.filter(t => t.result === "loss").length;
  const winRate = closed.length > 0 ? (wins / closed.length * 100).toFixed(1) : "0";
  const totalPnl = closed.reduce((s, t) => s + (t.pnl || 0), 0);
  const maxWin = closed.length > 0 ? Math.max(...closed.map(t => t.pnl || 0)) : 0;
  const maxLoss = closed.length > 0 ? Math.min(...closed.map(t => t.pnl || 0)) : 0;
  const longTrades = closed.filter(t => t.dir === "LONG");
  const shortTrades = closed.filter(t => t.dir === "SHORT");
  const longWinRate = longTrades.length > 0
    ? (longTrades.filter(t => t.result === "win").length / longTrades.length * 100).toFixed(1) : "N/A";
  const shortWinRate = shortTrades.length > 0
    ? (shortTrades.filter(t => t.result === "win").length / shortTrades.length * 100).toFixed(1) : "N/A";

  const report = [
    `📊 ═══ 每日交易报告 ${today} ═══`,
    `📈 总交易: ${closed.length}次 | 盈: ${wins}次 | 亏: ${losses}次`,
    `🎯 胜率: ${winRate}% | 多头胜率: ${longWinRate}% | 空头胜率: ${shortWinRate}%`,
    `💰 总盈亏: ${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(2)}U`,
    `🏆 最大单笔盈利: +${maxWin.toFixed(2)}U`,
    `💔 最大单笔亏损: ${maxLoss.toFixed(2)}U`,
    `📊 ════════════════════`,
  ];

  report.forEach(line => this.log("info", line));

  // 存到文件
  try {
    const fs = require("fs");
    const path = require("path");
    try {
  const os = require("os");
  const dataDir = process.env.APPDATA || path.join(os.homedir(), ".config");
  const reportFile = path.join(__dirname, "..", "data", `report_${today}.txt`);
  fs.writeFileSync(reportFile, report.join("\n"), "utf8");
  this.log("info", `📁 报告已保存: ${reportFile}`);
} catch(e) {}
  } catch(e) {}
}

getWinStats() {
  if (this.tradeHistory.length < 3) return null;
  const closed = this.tradeHistory.filter(t => t.result === "win" || t.result === "loss");
  if (closed.length < 3) return null;
  const wins = closed.filter(t => t.result === "win").length;
  const winRate = (wins / closed.length * 100).toFixed(1);
  const totalPnl = closed.reduce((s, t) => s + (t.pnl || 0), 0).toFixed(2);
  const avgWin = closed.filter(t => t.result === "win").reduce((s, t) => s + (t.pnl || 0), 0) / (wins || 1);
  const avgLoss = closed.filter(t => t.result === "loss").reduce((s, t) => s + (t.pnl || 0), 0) / ((closed.length - wins) || 1);

  // 按时间段统计
  const hourStats = {};
  closed.forEach(t => {
    const h = new Date(t.time + 8 * 3600000).getUTCHours();
    if (!hourStats[h]) hourStats[h] = { win: 0, total: 0 };
    hourStats[h].total++;
    if (t.result === "win") hourStats[h].win++;
  });
  const badHours = Object.entries(hourStats)
    .filter(([h, s]) => s.total >= 2 && s.win / s.total < 0.3)
    .map(([h]) => h);

  // 按方向统计
  const longWins = closed.filter(t => t.dir === "LONG" && t.result === "win").length;
  const longTotal = closed.filter(t => t.dir === "LONG").length;
  const shortWins = closed.filter(t => t.dir === "SHORT" && t.result === "win").length;
  const shortTotal = closed.filter(t => t.dir === "SHORT").length;

  return {
    total: closed.length,
    winRate,
    totalPnl,
    avgWin: avgWin.toFixed(2),
    avgLoss: avgLoss.toFixed(2),
    badHours,
    longWinRate: longTotal > 0 ? (longWins / longTotal * 100).toFixed(1) : "N/A",
    shortWinRate: shortTotal > 0 ? (shortWins / shortTotal * 100).toFixed(1) : "N/A",
    recentTrend: closed.slice(-5).filter(t => t.result === "win").length >= 3 ? "连胜中" : 
                 closed.slice(-5).filter(t => t.result === "loss").length >= 3 ? "连败中⚠️" : "正常"
  };
}

  // ── 指标计算 ──────────────────────────────────────────────
  ema(arr, p) {
    const k = 2 / (p + 1), r = Array(arr.length).fill(null); let s = 0;
    for (let i = 0; i < arr.length; i++) {
      if (i < p - 1) s += arr[i];
      else if (i === p - 1) { s += arr[i]; r[i] = s / p; }
      else r[i] = arr[i] * k + r[i - 1] * (1 - k);
    }
    return r;
  }

  rsiCalc(cls, p) {
    const r = Array(cls.length).fill(null); let ag = 0, al = 0;
    for (let i = 1; i <= p; i++) { const d = cls[i] - cls[i-1]; d > 0 ? ag += d/p : al -= d/p; }
    r[p] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
    for (let i = p + 1; i < cls.length; i++) {
      const d = cls[i] - cls[i-1];
      ag = (ag * (p-1) + (d > 0 ? d : 0)) / p;
      al = (al * (p-1) + (d < 0 ? -d : 0)) / p;
      r[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
    }
    return r;
  }

  atrCalc(cs, p = 14) {
    const tr = cs.map((c, i) => i === 0 ? c.high - c.low :
      Math.max(c.high - c.low, Math.abs(c.high - cs[i-1].close), Math.abs(c.low - cs[i-1].close)));
    return cs.map((_, i) => i < p - 1 ? null : tr.slice(i - p + 1, i + 1).reduce((a, v) => a + v, 0) / p);
  }

  bbCalc(cls, p = 20, m = 2) {
    const mid = this.ema(cls, p), up = Array(cls.length).fill(null), lo = Array(cls.length).fill(null);
    for (let i = p - 1; i < cls.length; i++) {
      const sl = cls.slice(i - p + 1, i + 1), mn = sl.reduce((a, v) => a + v, 0) / p;
      const sd = Math.sqrt(sl.map(v => (v - mn) ** 2).reduce((a, v) => a + v, 0) / p);
      up[i] = mid[i] + m * sd; lo[i] = mid[i] - m * sd;
    }
    return { mid, up, lo };
  }

  adxCalc(cs, p = 14) {
    const tr = cs.map((c, i) => i === 0 ? c.high - c.low :
      Math.max(c.high - c.low, Math.abs(c.high - cs[i-1].close), Math.abs(c.low - cs[i-1].close)));
    const plusDM = cs.map((c, i) => {
      if (i === 0) return 0;
      const up = c.high - cs[i-1].high, down = cs[i-1].low - c.low;
      return (up > down && up > 0) ? up : 0;
    });
    const minusDM = cs.map((c, i) => {
      if (i === 0) return 0;
      const up = c.high - cs[i-1].high, down = cs[i-1].low - c.low;
      return (down > up && down > 0) ? down : 0;
    });
    const atr = this.atrCalc(cs, p);
    const plusDI = atr.map((a, i) => i < p ? null :
      100 * (plusDM.slice(i - p + 1, i + 1).reduce((x, y) => x + y, 0) / p) / a);
    const minusDI = atr.map((a, i) => i < p ? null :
      100 * (minusDM.slice(i - p + 1, i + 1).reduce((x, y) => x + y, 0) / p) / a);
    const dx = plusDI.map((pdi, i) => pdi === null ? null :
      100 * Math.abs(pdi - minusDI[i]) / (pdi + minusDI[i]));
    const adx = Array(cs.length).fill(null);
    for (let i = p * 2 - 1; i < cs.length; i++) {
      adx[i] = dx.slice(i - p + 1, i + 1).reduce((a, b) => a + b, 0) / p;
    }
    return adx;
  }

  buildIndicators(cs) {
    const cls = cs.map(c => c.close);
    const ef = this.ema(cls, 9), es = this.ema(cls, 21), em = this.ema(cls, 55);
    const ri = this.rsiCalc(cls, 14), at = this.atrCalc(cs, 14), B = this.bbCalc(cls, 20, 2);
    return cs.map((c, i) => ({ ...c, ef: ef[i], es: es[i], em: em[i], rsi: ri[i], atr: at[i], bbUp: B.up[i], bbLo: B.lo[i] }));
  }

  isBullC(c) { const b = Math.abs(c.close - c.open); return c.close > c.open && (Math.min(c.close, c.open) - c.low) > b * 1.5; }
  isBearC(c) { const b = Math.abs(c.close - c.open); return c.close < c.open && (c.high - Math.max(c.close, c.open)) > b * 1.5; }
  isBullE(c, p) { return c.close > c.open && p.close < p.open && c.close > p.open && c.open < p.close; }
  isBearE(c, p) { return c.close < c.open && p.close > p.open && c.open > p.close && c.close < p.open; }

  getSignal(cur, prev) {
    if (!cur.ef || cur.rsi === null || !cur.atr || !cur.bbUp) return "HOLD";
    if (cur.atr / cur.close < 0.0003) return "HOLD";
    const xUp = prev.ef < prev.es && cur.ef > cur.es;
    const xDn = prev.ef > prev.es && cur.ef < cur.es;
    const emaTrendLong = cur.close > cur.ef && cur.ef > cur.es && cur.es > cur.em;
    const emaTrendShort = cur.close < cur.ef && cur.ef < cur.es && cur.es < cur.em;
    const bbL = prev.close <= prev.bbLo && cur.close > cur.bbLo;
    const bbS = prev.close >= prev.bbUp && cur.close < cur.bbUp;
    const emaL = prev.low <= prev.em * 1.003 && cur.close > cur.em && cur.close > prev.close;
    const emaS = prev.high >= prev.em * 0.997 && cur.close < cur.em && cur.close < prev.close;
    const rsiL = cur.rsi > 30 && cur.rsi < 70;
    const rsiS = cur.rsi > 30 && cur.rsi < 72;
    const long = (bbL && rsiL) || (xUp && cur.close > cur.em && rsiL) || (emaL && rsiL && (this.isBullC(cur) || this.isBullE(cur, prev))) || (emaTrendLong && cur.rsi < 65);
    const short = (bbS && rsiS) || (xDn && cur.close < cur.em && rsiS) || (emaS && rsiS && (this.isBearC(cur) || this.isBearE(cur, prev))) || (emaTrendShort && cur.rsi > 35);
    return long ? "LONG" : short ? "SHORT" : "HOLD";
  }

  // ── 震荡模式执行开仓（内部辅助方法）──
  async _executeOpen(sig, price, sl, tp, contracts, notional, margin, balance, emaDiffForOpen, posType) {
    if (this.pos) return; // 已有持仓，不重复开
    if (this.cfg.dryRun) {
      if (this.simAvail < margin) {
        this.log("error", `💰 模拟账户资金不足！需要 ${margin.toFixed(2)}U，可用 ${this.simAvail.toFixed(2)}U`); return;
      }
      const feeOpen = +(notional * 0.0005).toFixed(4);
      this.simAvail -= margin + feeOpen;
      this.simMargin += margin;
      this.simBalance -= feeOpen;
      this.log("open", `💸 开仓手续费: ${feeOpen.toFixed(4)}U`);
      this.emit("balance", { balance: this.simAvail, start: this.startBal, total: this.simBalance, margin: this.simMargin, pnl: 0, totalPnl: this.simTotalPnl, simBalance: this.simBalance });
    }
    if (!this.cfg.dryRun) await this.placeOrder(sig, contracts);
    this.emit("trade", { time: Date.now(), dir: sig, entry: price, exit: null, contracts, notional, pPct: null, pnl: null, reason: "开仓", result: "open" });
    this.pos = {
      dir: sig, entry: price, sl, tp, contracts, notional, margin,
      time: Date.now(), _movedToBreakeven: false, _tp1Hit: false, _tp2Hit: false,
      feeOpen: notional * 0.0005, feeClose: notional * 0.0005,
      emaDiffAtOpen: emaDiffForOpen, posType: posType || "trend",
    };
    this.emit("position", { ...this.pos, price, pPct: 0 });
    if (this.cfg.dryRun) this.saveSimState();
  }

  // ── 行情模式识别：自动判断趋势/震荡 ──────────────────────────────────────
  // 分析最近4小时K线，判断是否为震荡行情
  detectMarketMode(cs30m) {
    if (!cs30m || cs30m.length < 8) return "trend";
    // 取最近8根30m K线（约4小时）
    const recent = cs30m.slice(-8);
    const highs = recent.map(c => c.high);
    const lows = recent.map(c => c.low);
    const closes = recent.map(c => c.close);
    const highestHigh = Math.max(...highs);
    const lowestLow = Math.min(...lows);
    const rangeRatio = (highestHigh - lowestLow) / lowestLow * 100;
    // 计算EMA差的绝对值变化：如果过去4小时EMA差都 < 0.06% 认为震荡
    const withIndicators = this.buildIndicators(recent);
    const emaDiffs = withIndicators.map(c => c.ef && c.es ? Math.abs((c.ef - c.es) / c.es * 100) : 0);
    const avgEmaDiff = emaDiffs.reduce((a, b) => a + b, 0) / emaDiffs.length;
    const maxEmaDiff = Math.max(...emaDiffs);
    // 震荡条件：价格区间<1.2% 且 平均EMA差<0.06% 且 最大EMA差<0.1%
    const isOsc = rangeRatio < 1.2 && avgEmaDiff < 0.06 && maxEmaDiff < 0.10;
    return isOsc ? "oscillation" : "trend";
  }

  // 震荡模式信号判断：RSI超卖/超买 + 订单簿支持
  getOscSignal(cur5m, orderBook) {
    if (!cur5m || cur5m.rsi === null) return "HOLD";
    const rsi = cur5m.rsi;
    const obBuy = orderBook ? (orderBook.buyRatio || 50) : 50;
    // 超卖做多：RSI < 32 + 买方订单簿 > 60%
    if (rsi < 32 && obBuy > 55) return "LONG";
    // 超买做空：RSI > 68 + 卖方订单簿（买方<40%）
    if (rsi > 68 && obBuy < 42) return "SHORT";
    return "HOLD";
  }

  // ── API ──────────────────────────────────────────────────
  // ✅ 修复：API请求加重试机制（最多3次，间隔2秒）
  async request(method, apiPath, query = {}, body = null, _retryCount = 0) {
    try {
      return await this._requestOnce(method, apiPath, query, body);
    } catch(e) {
      if (_retryCount < 2) {
        await new Promise(r => setTimeout(r, 2000));
        return this.request(method, apiPath, query, body, _retryCount + 1);
      }
      throw e;
    }
  }

  _requestOnce(method, apiPath, query = {}, body = null) {
    return new Promise((resolve, reject) => {
      const ts = Math.floor(Date.now() / 1000).toString();
const sortedKeys = Object.keys(query).sort();
const qs = sortedKeys.length ? sortedKeys.map(k => `${k}=${query[k]}`).join("&") : "";
const fullPath = "/api/v4" + apiPath + (qs ? "?" + qs : "");
const bodyStr = (method === "GET" || !body) ? "" : JSON.stringify(body);
const headers = {
  "Content-Type": "application/json",
  "Accept": "application/json",
};
const bh = crypto.createHash("sha512").update(bodyStr).digest("hex");
const signStr = method + "\n" + "/api/v4" + apiPath + "\n" + qs + "\n" + bh + "\n" + ts;


      if (this.cfg.apiKey && this.cfg.apiSecret) {
        const sig = crypto.createHmac("sha512", this.cfg.apiSecret).update(signStr).digest("hex");
        headers.KEY = this.cfg.apiKey;
        headers.Timestamp = ts;
        headers.SIGN = sig;
      }

      const req = https.request({
  hostname: "api.gateio.ws",
  port: 443,
  path: fullPath,
  method: method,
  headers: headers,
  timeout: 10000,
}, res => {
        let d = "";
        res.on("data", c => d += c);
        res.on("end", () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
          catch (e) { reject(e); }
        });
      });
      req.on("timeout", () => { req.destroy(new Error("请求超时(10s)")); });
      req.on("error", reject);
      if (bodyStr) req.write(bodyStr);
      req.end();
    });
  }

  async fetchKlines(interval = "1h", bars = 120, symbol = "BTC_USDT") {
  const SECS = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400 };
  const to = Math.floor(Date.now() / 1000), from = to - (SECS[interval] || 3600) * bars;
  const r = await this.request("GET", "/futures/usdt/candlesticks",
  { contract: symbol, from, to, interval });
return r.body.map(c => ({ time: +c.t, open: +c.o, high: +c.h, low: +c.l, close: +c.c, volume: +(c.v || 0) }))
  .sort((a, b) => a.time - b.time);
}
// 获取订单簿深度
  async getOrderBook() {
    try {
      const r = await this.request("GET", "/futures/usdt/order_book",
        { contract: this.cfg.contract || "BTC_USDT", interval: "0", limit: "50" });
      const bids = r.body.bids || [];
      const asks = r.body.asks || [];
      const bidVol = bids.slice(0,10).reduce((s, b) => s + Math.abs(parseFloat(b.s)), 0);
      const askVol = asks.slice(0,10).reduce((s, a) => s + Math.abs(parseFloat(a.s)), 0);
      const ratio = bidVol / (bidVol + askVol);
      const topBid = bids[0] ? parseFloat(bids[0].p) : 0;
      const topAsk = asks[0] ? parseFloat(asks[0].p) : 0;
      return {
        bidVol: bidVol.toFixed(0),
        askVol: askVol.toFixed(0),
        ratio: (ratio * 100).toFixed(1),
        topBid, topAsk,
        pressure: ratio > 0.6 ? "买方强势" : ratio < 0.4 ? "卖方强势" : "多空均衡"
      };
    } catch(e) {
      this.log("warn", "订单簿获取失败: " + e.message);
      return null;
    }
  }

  // 获取资金费率
  async getFundingRate() {
    try {
      const r = await this.request("GET", "/futures/usdt/contracts/" + (this.cfg.contract || "BTC_USDT"));
      const rate = parseFloat(r.body.funding_rate) * 100;
      const nextTime = r.body.funding_next_apply;
      const nextDt = new Date(nextTime * 1000 + 8*3600*1000).toISOString().slice(11,16);
      return {
        rate: rate.toFixed(4),
        nextTime: nextDt,
        sentiment: rate > 0.05 ? "多头过热⚠️" : rate < -0.05 ? "空头过热⚠️" : "情绪正常✅"
      };
    } catch(e) {
      this.log("warn", "资金费率获取失败: " + e.message);
      return null;
    }
  }
async getBalance() {
try {
const r = await this.request("GET", "/futures/usdt/accounts");
const data = r.body;
if (!data) return null;
return {
total: parseFloat(data.total || 0),
available: parseFloat(data.available || 0),
unrealised_pnl: parseFloat(data.unrealised_pnl || 0),
};
} catch(e) {
this.log("warn", "获取余额失败: " + e.message);
return null;
}
}
  // 获取多空比
async getLongShortRatio() {
  try {
    const r = await this.request("GET",
      "/futures/usdt/contract_stats",
      { contract: this.cfg.contract || "BTC_USDT", interval: "5m", limit: "1" }
    );
    const d = r.body[0];
    if (!d) return null;

    // lsr_taker = 多空比（多/空），>1表示多头占优
    const lsr = parseFloat(d.lsr_taker || 1);
    const longPct = (lsr / (1 + lsr) * 100);
    const shortPct = 100 - longPct;

    // 用户数多空比
    const longUsers = parseInt(d.long_users || 0);
    const shortUsers = parseInt(d.short_users || 0);
    const totalUsers = longUsers + shortUsers || 1;
    const longUserPct = (longUsers / totalUsers * 100).toFixed(1);

    return {
      longRatio: longPct.toFixed(1),
      shortRatio: shortPct.toFixed(1),
      longUsers: longUserPct,
      sentiment: longPct > 65
        ? "散户严重偏多⚠️(反向看空)"
        : longPct < 35
        ? "散户严重偏空⚠️(反向看多)"
        : longPct > 55
        ? "散户偏多"
        : longPct < 45
        ? "散户偏空"
        : "情绪均衡✅"
    };
  } catch(e) {
    this.log("warn", "多空比获取失败: " + e.message);
    return null;
  }
}

// 获取持仓量变化
async getOpenInterest() {
  try {
    const r = await this.request("GET",
      "/futures/usdt/contract_stats",
      { contract: this.cfg.contract || "BTC_USDT", interval: "5m", limit: "6" }
    );
    if (!r.body || r.body.length < 2) return null;
    const latest = parseFloat(r.body[0].open_interest || 0);
    const prev = parseFloat(r.body[r.body.length - 1].open_interest || 0);
    const change = prev > 0 ? ((latest - prev) / prev * 100).toFixed(2) : "0";
    return {
      current: latest.toFixed(0),
      change: change,
      trend: parseFloat(change) > 3
        ? "持仓快速增加🔥(趋势加速)"
        : parseFloat(change) < -3
        ? "持仓快速减少❄️(趋势减弱)"
        : "持仓稳定"
    };
  } catch(e) {
    this.log("warn", "持仓量获取失败: " + e.message);
    return null;
  }
}
 

  async getPrice(symbol) {
  symbol = symbol || this.cfg.contract || "BTC_USDT";
  try {
    const r = await this.request("GET", "/futures/usdt/tickers", { contract: symbol });
    return parseFloat(r.body[0]?.last || "0");
  } catch (e) {
    this.log("error", "获取价格失败: " + e.message);
    return 0;
  }
}

  async getPosition() {
    try {
      const contract = this.cfg.contract || "BTC_USDT";
const r = await this.request("GET", "/futures/usdt/positions/" + contract);
      const p = r.body;
      if (!p || p.size === 0) return null;
      return { dir: p.size > 0 ? "LONG" : "SHORT", size: Math.abs(p.size), entry: parseFloat(p.entry_price), upnl: parseFloat(p.unrealised_pnl) };
    } catch (e) {
      this.log("error", "获取持仓失败: " + e.message);
      return null;
    }
  }

  async getContractInfo() {
    const r = await this.request("GET", "/futures/usdt/contracts/" + (this.cfg.contract || "BTC_USDT"));
    return { mult: parseFloat(r.body.quanto_multiplier), minSize: parseInt(r.body.order_size_min) };
  }

  async testAPI() {
    try {
      const balData = await this.getBalance();
const bal = balData ? balData.available : 0;
this.log("info", "API 连接测试成功, 余额: " + bal.toFixed(2) + " U");
      return true;
    } catch (e) {
      this.log("error", "API 测试失败: " + e.message);
      return false;
    }
  }

  async setLeverage() {
    const contract = this.cfg.contract || "BTC_USDT";
await this.request("POST", "/futures/usdt/positions/" + contract + "/leverage", {},
      { leverage: String(this.cfg.leverage), cross_leverage_limit: "0" });
  }

  async placeOrder(dir, contracts) {
    const r = await this.request("POST", "/futures/usdt/orders", {},
      { contract: this.cfg.contract || "BTC_USDT", size: dir === "LONG" ? contracts : -contracts, price: "0", tif: "ioc", reduce_only: false });
    if (r.status !== 201) throw new Error("下单失败: " + JSON.stringify(r.body));
  }

  async closePosition(size, dir) {
    const r = await this.request("POST", "/futures/usdt/orders", {},
      { contract: this.cfg.contract || "BTC_USDT", size: dir === "LONG" ? -size : size, price: "0", tif: "ioc", reduce_only: true });
    if (r.status !== 201) throw new Error("平仓失败: " + JSON.stringify(r.body));
  }

  log(level, msg) {
    const ts = new Date(Date.now() + 8 * 3600 * 1000).toISOString().replace("T", " ").slice(0, 19);
    this.emit("log", { level, msg, ts });
  }

  // ── 手动操作 ─────────────────────────────────────────────
  async partialClose(ratio) {
    const livePos = this.cfg.dryRun ? this.pos : await this.getPosition();
    if (!livePos) { this.log("warn", "无持仓"); return; }
    const totalSz = this.cfg.dryRun ? this.pos.contracts : livePos.size;
    const closeSize = Math.max(1, Math.floor(totalSz * ratio));
    const dir = this.pos.dir, entry = this.pos.entry;
    this.log("open", `手动平仓 ${(ratio * 100).toFixed(0)}% | ${dir} 平 ${closeSize}张`);
    if (!this.cfg.dryRun) {
      const r = await this.request("POST", "/futures/usdt/orders", {},
        { contract: this.cfg.contract || "BTC_USDT", size: dir === "LONG" ? -closeSize : closeSize, price: "0", tif: "ioc", reduce_only: true });
      if (r.status !== 201) throw new Error("平仓失败: " + JSON.stringify(r.body));
    }
    const price = await this.getPrice().catch(() => entry);
    const pPct = dir === "LONG" ? (price - entry) / entry * 100 : (entry - price) / entry * 100;
    const notional = this.pos.notional || (this.pos.contracts * this.pos.entry * 0.0001);
// 部分平仓只扣对应比例的平仓手续费
const feeClose = +(notional * ratio * 0.0005).toFixed(4);
const pnl = notional * ratio * pPct / 100 - feeClose;
    this.emit("trade", {
      time: Date.now(), dir, entry, exit: price, contracts: closeSize,
      notional: +(this.pos.notional * ratio).toFixed(2), pPct: +pPct.toFixed(2),
      pnl: +pnl.toFixed(2), reason: `手动平仓${(ratio * 100).toFixed(0)}%`, result: pnl >= 0 ? "win" : "loss"
    });
    // ✅ 保存减仓历史记录
this.tradeHistory.push({
time: Date.now(), dir, entry, exit: price,
openTime: this.pos.openTime || this.pos.time,
closeTime: Date.now(),
pPct: +pPct.toFixed(2), pnl: +pnl.toFixed(2),
reason: `手动平仓${(ratio*100).toFixed(0)}%`,
result: pnl >= 0 ? "win" : "loss",
hour: new Date().getUTCHours(),
});
this.saveTradeHistory();
    
    if (this.cfg.dryRun) {
  const releasedMargin = this.pos.margin * ratio;
  this.simAvail += releasedMargin;
  this.simBalance += pnl;
  this.simTotalPnl += pnl;
  this.simMargin -= releasedMargin;
  this.saveSimState();
  this.emit("balance", { balance: this.simAvail, start: this.startBal, total: this.simBalance, margin: this.simMargin, pnl: 0, totalPnl: this.simTotalPnl, simBalance: this.simBalance });
}
this.pos.notional = +(this.pos.notional * (1 - ratio)).toFixed(2);
this.pos.margin = +(this.pos.margin * (1 - ratio)).toFixed(2);
this.pos.contracts -= closeSize;
    
    if (this.pos.contracts <= 0) { this.pos = null; this.simMargin = 0; this.emit("position", null); this.log("info", "持仓已全部平仓"); if (this.cfg.dryRun) this.saveSimState(); }
    else { this.emit("position", { ...this.pos, price: entry, pPct: 0 }); this.log("info", `剩余: ${this.pos.contracts}张`); }
  }

  setTP(v) {
    if (!this.pos) { this.log("warn", "无持仓"); return; }
    const o = this.pos.tp; this.pos.tp = parseFloat(v);
    this.log("open", `止盈: ${o}→${this.pos.tp}`);
    this.emit("position", { ...this.pos, price: this.pos.entry, pPct: 0 });
  }

  setSL(v) {
    if (!this.pos) { this.log("warn", "无持仓"); return; }
    const o = this.pos.sl; this.pos.sl = parseFloat(v);
    this.log("open", `止损: ${o}→${this.pos.sl}`);
    this.emit("position", { ...this.pos, price: this.pos.entry, pPct: 0 });
  }

  async runAiDriven(price, balance, curSlot) {
  try {
    // 第6条：重要数据发布时间过滤（UTC时间）
const nowUtc = new Date();
const hUtc = nowUtc.getUTCHours(), mUtc = nowUtc.getUTCMinutes();
const isNewsTime = (hUtc === 12 && mUtc >= 25 && mUtc <= 35) || // 美国CPI/非农 20:30北京时间
                   (hUtc === 14 && mUtc >= 25 && mUtc <= 35) || // FOMC 22:30北京时间
                   (hUtc === 8  && mUtc >= 25 && mUtc <= 35);   // 欧洲数据 16:30北京时间
if (isNewsTime && !this.pos) {
  this.log("scan", `⏸ 重要数据发布窗口(UTC ${hUtc}:${String(mUtc).padStart(2,"0")})，暂停开仓10分钟`);
  return;
}
// 冷却期检查
const curSlotCheck = Math.floor(Date.now() / (5 * 60 * 1000));
if (curSlotCheck < this.cooldownUntilSlot) {
const remain = (this.cooldownUntilSlot - curSlotCheck) * 5;
this.log("scan", `⏸ 冷却期 剩余约${remain}分钟，AI主导暂停`);
return;
}
    this.log("scan", "🤖 AI主导模式 | 主动获取数据分析中...");

    // 获取所有数据
    const raw5m = await this.fetchKlines("5m", 300, this.cfg.contract);
    const raw1h = await this.fetchKlines("1h", 100, this.cfg.contract);
    const raw4h = await this.fetchKlines("4h", 60, this.cfg.contract);
    const raw1d = await this.fetchKlines("1d", 30, this.cfg.contract);
    const cs5m = this.buildIndicators(raw5m).filter(c => c.ef && c.rsi !== null);
    const cs1h = this.buildIndicators(raw1h).filter(c => c.ef && c.rsi !== null);

    // ✅ 信号计算用已收盘K线(倒数第二)保证准确；趋势判断用最新根(含未收盘)即时响应
    const cur5m = cs5m[cs5m.length - 2];
    const prev5m = cs5m[cs5m.length - 3];
    const cur1h = cs1h[cs1h.length - 1] || cs1h[cs1h.length - 2];

    if (!cur5m || !prev5m) return;

    const [orderBook, fundingRate, lsRatio, openInterest] = await Promise.all([
  this.getOrderBook().catch(() => null),
  this.getFundingRate().catch(() => null),
  this.getLongShortRatio().catch(() => null),
  this.getOpenInterest().catch(() => null),
]);


    // 策略信号（仅作参考）
    const sig = this.getSignal(cur5m, prev5m);
    const score = this.scoreSignal(cur5m, prev5m, sig);
    const ema_diff_1h = (cur1h.ef - cur1h.es) / cur1h.es * 100;
const trend1h = ema_diff_1h > 0.07 ? "LONG" : ema_diff_1h < -0.07 ? "SHORT" : "HOLD";
this.log("scan", `📊 1h趋势: ${trend1h} (EMA差${ema_diff_1h.toFixed(3)}%)`);

    this.log("scan",
      "[AI主导] 价格:" + price.toFixed(2) +
      " RSI:" + cur5m.rsi.toFixed(1) +
      " 策略参考信号:" + sig +
      " 评分:" + score);

    // 让AI自主判断（不限制信号方向）
    // AI主导模式：不强制方向，让AI自主判断
      // 用5m策略信号为主，1h趋势为参考
const baseSig = sig !== "HOLD" ? sig : (cur1h ? (cur1h.ef > cur1h.es ? "LONG" : "SHORT") : "LONG");
const stats = this.getWinStats();
const aiResult = await aiAdvise({
 sig: baseSig,
      price,
      rsi: cur5m.rsi,
      ef: cur5m.ef,
      es: cur5m.es,
      em: cur5m.em,
      atr: cur5m.atr,
      adx: 25,
      trend: trend1h,
      score,
      recentCandles: raw5m,
      orderBook,
      fundingRate,
      
      candles1h: raw1h,
      candles4h: raw4h,
      candles1d: raw1d,
      aiDrivenMode: true, // 告诉AI是主导模式
      winStats: stats,
    }, this.log.bind(this));
    this.log("scan", `🤖 AI决策依据: ${aiResult.reason || JSON.stringify(aiResult).slice(0, 200)}`);
    this.emit("aiDecision", {
  time: Date.now(),
  sig: baseSig,
  confidence: aiResult.confidence,
  reason: aiResult.reason,
  action: aiResult.allow ? "open" : "skip",
  price,
  suggestSL: aiResult.suggestSL,
  suggestTP: aiResult.suggestTP,
  source: "aiDriven",
});
    if (!aiResult.allow) {
  this.log("scan", `⏸ AI判断跳过 | 置信度${aiResult.confidence}% | ${aiResult.reason}`);
  return;
}

    // AI同意开仓，执行
    const finalSig = aiResult.direction || (cur5m.ef > cur5m.es ? "LONG" : "SHORT");
    // 1h趋势参考（AI已综合分析，不强制拒绝，仅降低置信度记录）
if (trend1h !== "HOLD" && finalSig !== trend1h) {
this.log("warn", `⚠️ AI主导：${finalSig}与1h趋势${trend1h}方向相反，AI已综合判断，继续执行`);
}
// trend1h 为 HOLD 时也继续，由 AI 自主决策
    const info = this.contractInfo || { mult: 0.0001 };
    // AI动态仓位（从ratio字段读取，无效时按置信度换算）
  const aiRatio = aiResult.ratio || (
 aiResult.confidence >= 85 ? 1.0 :
 aiResult.confidence >= 72 ? 0.7 : 0.5
);
this.log("open", `💰 AI仓位比例:${(aiRatio*100).toFixed(0)}% 置信度${aiResult.confidence}%`);
 
// ✅ AI主导模式止盈止损 — 震荡行情跟随UI参数，强趋势适度放大
const aiUiSlPct = (this.cfg.stopPct || 0.8) / 100;
const aiUiTpPct = Math.max((this.cfg.takePct || 1.5) / 100, 0.015);
const emaDiffAbs2 = Math.abs((cur5m.ef - cur5m.es) / cur5m.es * 100);
let slPct2, tpPct2;

if (emaDiffAbs2 > 0.3) {
slPct2 = aiUiSlPct * 1.5; tpPct2 = aiUiTpPct * 2.0; // 强趋势适度放大
} else if (emaDiffAbs2 > 0.15) {
slPct2 = aiUiSlPct * 1.2; tpPct2 = aiUiTpPct * 1.5; // 中趋势
} else {
slPct2 = aiUiSlPct; tpPct2 = aiUiTpPct; // 弱趋势/震荡：直接用UI设定
}

const fixedSL2 = +(price * slPct2).toFixed(2);
const fixedTP2 = +(price * tpPct2).toFixed(2);

const aiSLValid2 = aiResult.suggestSL &&
Math.abs(aiResult.suggestSL - price) / price >= 0.003 && // ✅ 下限放宽到0.3%
Math.abs(aiResult.suggestSL - price) / price <= 0.03; // ✅ 上限放宽到3%
const aiTPValid2 = aiResult.suggestTP &&
Math.abs(aiResult.suggestTP - price) / price >= 0.008 && // ✅ 下限放宽到0.8%
Math.abs(aiResult.suggestTP - price) / price <= 0.08; // ✅ 上限放宽到8%（覆盖强趋势7%）

let sl, tp;
if (aiSLValid2 && aiTPValid2) {
const aiSlDist2 = Math.abs(aiResult.suggestSL - price);
const aiTpDist2 = Math.abs(aiResult.suggestTP - price);
if (aiTpDist2 / aiSlDist2 >= 1.5) {
sl = aiResult.suggestSL;
tp = aiResult.suggestTP;
this.log("open", `🤖 AI主导止损:${sl} 止盈:${tp} 盈亏比:${(aiTpDist2/aiSlDist2).toFixed(1)}`);
} else {
sl = finalSig === "LONG" ? +(price - fixedSL2).toFixed(2) : +(price + fixedSL2).toFixed(2);
tp = finalSig === "LONG" ? +(price + fixedTP2).toFixed(2) : +(price - fixedTP2).toFixed(2);
this.log("open", `📐 AI盈亏比不足，用固定标准 SL:${sl} TP:${tp}`);
}
} else {
sl = finalSig === "LONG" ? +(price - fixedSL2).toFixed(2) : +(price + fixedSL2).toFixed(2);
tp = finalSig === "LONG" ? +(price + fixedTP2).toFixed(2) : +(price - fixedTP2).toFixed(2);
this.log("open", `📐 AI主导固定止损:${sl} 止盈:${tp} (0.3%/0.6%)`);
}

// 最终安全验证
if (finalSig === "LONG") {
if (sl <= 0 || sl >= price) sl = +(price - fixedSL2).toFixed(2);
if (tp <= price) tp = +(price + fixedTP2).toFixed(2);
} else {
if (sl <= price) sl = +(price + fixedSL2).toFixed(2);
if (tp >= price) tp = +(price - fixedTP2).toFixed(2);
}



// 最终方向验证
if (finalSig === "LONG") {
if (sl <= 0 || sl >= price) sl = +(price - fixedSL2).toFixed(2);
if (tp <= price) tp = +(price + fixedTP2).toFixed(2);
} else {
if (sl <= price) sl = +(price + fixedSL2).toFixed(2);
if (tp >= price) tp = +(price - fixedTP2).toFixed(2);
}
    const contracts = Math.max(1, Math.floor(
 balance * (this.cfg.posRatio / 100) * aiRatio * this.cfg.leverage / (price * info.mult)
));
 const notional = +(contracts * price * info.mult).toFixed(2);
 const margin = +(notional / this.cfg.leverage).toFixed(2);

 if (this.cfg.dryRun) {
 if (this.simAvail < margin) {
 this.log("error", "💰 资金不足！需要 " + margin.toFixed(2) + "U，可用 " + this.simAvail.toFixed(2) + "U");
        return;
      }
      this.simAvail -= margin;
      this.simMargin += margin;
      const feeOpenAi = +(notional * 0.0005).toFixed(4);
this.simAvail -= feeOpenAi;
this.simBalance -= feeOpenAi;
this.log("open", `💸 开仓手续费: ${feeOpenAi.toFixed(4)}U`);
      this.emit("balance", {
balance: this.simAvail,
start: this.cfg.dryRun ? this.simAvail : this.startBal,
total: this.simBalance,
margin: this.simMargin,
pnl: this.simTotalPnl
});
    }

    this.log("open",
      "🤖 AI主导开仓 " + finalSig + " " + contracts + "张 (~" + notional + "U)" +
      " AI置信度" + aiResult.confidence + "% | 入:" + price.toFixed(2) +
      " SL:" + sl + " TP:" + tp);

    if (!this.cfg.dryRun) await this.placeOrder(finalSig, contracts);

    this.pos = {
      dir: finalSig, entry: price, sl, tp, contracts, notional, margin,
      time: Date.now(), _movedToBreakeven: false,
      _tp1Hit: false, _tp2Hit: false,
      feeOpen: notional * 0.0005,
      feeClose: notional * 0.0005,
    };

    this.emit("position", { ...this.pos, price, pPct: 0 });
    this.emit("trade", {
      time: Date.now(), dir: finalSig, entry: price, exit: null,
      contracts, notional, pPct: null, pnl: null,
      reason: "AI主导开仓", result: "open"
    });

    if (this.cfg.dryRun) this.saveSimState();

  } catch(e) {
    this.log("error", "AI主导模式出错: " + e.message);
  }
}
}

module.exports = { TradingEngine };
