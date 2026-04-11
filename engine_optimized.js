"use strict";
const https = require("https");
const crypto = require("crypto");
const { aiAdvise } = require("./ai-advisor");

/**
 * 优化的BTC合约交易引擎 v2.0
 * 修复了所有关键问题，集成AI分析，改进策略逻辑
 */

class TradingEngine {
 constructor(config, emit) {
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

 // 风控状态
 this.dailyTrades = 0;           // 今日开仓次数
 this.lastTradeDate = null;      // 上次开仓日期 (YYYY-MM-DD)
 this.consecutiveLosses = 0;     // 连续亏损次数
 this.dailyPnl = 0;              // 今日盈亏
 this.dailyStartBal = null;      // 今日起始余额
 this.consecutiveWins = 0;       // 连续盈利次数
 }

 async start() {
 this.running = true;

 // 检查是否需要重置每日计数
 const today = new Date(Date.now()+8*3600*1000).toISOString().slice(0,10);
 if (this.lastTradeDate !== today) {
 this.dailyTrades = 0;
 this.lastTradeDate = today;
 this.dailyPnl = 0;
 this.dailyStartBal = this.cfg.dryRun ? this.cfg.capital : await this.getBalance();
 }

 this.log("info", `🤖 机器人启动 | ${this.cfg.dryRun ? "【模拟模式】" : "【真实交易】"}`);
 this.log("info", `止盈${this.cfg.takePct}% 止损${this.cfg.stopPct}% ${this.cfg.leverage}x 仓位${this.cfg.posRatio}%`);
 this.log("info", `💰 AI分析已启用 | 每日限${this.cfg.maxTradesPerDay || 10}次 | 盈亏比目标${(this.cfg.takePct/this.cfg.stopPct).toFixed(1)}:1`);
 
 try {
 if (!this.cfg.dryRun) { await this.setLeverage(); this.log("info", `杠杆已设置: ${this.cfg.leverage}x`); }
 this.contractInfo = await this.getContractInfo();
 this.log("info", `合约: BTC_USDT | 每张=${this.contractInfo.mult} BTC`);
 this.startBal = this.cfg.dryRun ? this.cfg.capital : await this.getBalance();
 this.emit("balance", { balance: this.startBal, start: this.startBal });
 this.log("info", `账户余额: ${this.startBal.toFixed(2)} USDT`);
 this._setConn(true);
 this.tick();
 this.startPriceTicker();
 } catch(e) { this._setConn(false); this.log("error", "启动失败: " + e.message); }
 }

 updateConfig(newCfg) {
 ["takePct","stopPct","posRatio","maxLoss","leverage","trailPct","partialPct",
 "maxTradesPerDay","reduceAfterLosses","dailyTpPct","dailySlPct","trendMode"]
 .forEach(k => { if (newCfg[k] != null) this.cfg[k] = newCfg[k]; });
 this.log("open", `⚙️ 参数热更新 | 止盈${this.cfg.takePct}% 止损${this.cfg.stopPct}%`);
 this.emit("configUpdated", this.cfg);
 }

 stop() {
 this.running = false;
 if (this.timer) { clearTimeout(this.timer); this.timer = null; }
 if (this.priceTimer) { clearInterval(this.priceTimer); this.priceTimer = null; }
 this.log("info", "机器人已停止");
 }

 async tick() {
 if (!this.running) return;
 try { await this.run(); this._setConn(true); }
 catch(e) { this._setConn(false); this.log("error", e.message); }
 if (this.running) this.timer = setTimeout(() => this.tick(), 60_000);
 }

 startPriceTicker() {
 this.priceTimer = setInterval(async () => {
 if (!this.running) return;
 try { 
 const price = await this.getPrice();
 this.emit("price", { price });
 this._setConn(true);
 
 // 持仓时实时更新移动止损
 if (this.pos && this.cfg.trailPct > 0) {
 const { dir, entry } = this.pos;
 const profitPct = dir === "LONG" ? (price - entry) / entry * 100 : (entry - price) / entry * 100;
 
 // 盈利超过止损幅度时移动止损
 const tr = this.cfg.trailPct / 100;
 const nsl = +(price * (dir === "LONG" ? 1 - tr : 1 + tr)).toFixed(2);
 const better = dir === "LONG" ? nsl > this.pos.sl : nsl < this.pos.sl;
 if (better) {
 this.pos.sl = nsl;
 this.log("scan", `📐 动态止损更新 → ${nsl} (盈利${profitPct.toFixed(2)}%)`);
 }
 }
 } catch(e) { this._setConn(false); }
 }, 1000);
 }

 _setConn(ok) {
 if (this._connOk === ok) return;
 this._connOk = ok;
 this.emit("conn", { ok });
 this.log(ok ? "info" : "warn", ok ? "✅ API 连接已恢复" : "⚠️ API 连接异常");
 }

 /**
  * 改进的信号评分算法
  * 增加了趋势强度、市场状态、AI置信度等维度
  */
 scoreSignal(cur, prev, sig, trendStrength = 0) {
 if (sig === "HOLD") return 0;
 let s = 50;
 
 // RSI权重（优化）
 if (sig === "LONG") {
 s += cur.rsi < 35 ? 20 : cur.rsi < 45 ? 15 : cur.rsi < 55 ? 10 : 5;
 } else {
 s += cur.rsi > 65 ? 20 : cur.rsi > 55 ? 15 : cur.rsi > 50 ? 10 : 5;
 }
 
 // EMA差异权重（考虑趋势强度）
 const ed = Math.abs(cur.ef - cur.es) / cur.close * 100;
 s += ed > 0.4 ? 20 : ed > 0.2 ? 15 : ed > 0.1 ? 10 : 5;
 
 // 波动率权重（ATR）
 const ap = cur.atr / cur.close * 100;
 s += ap > 0.5 ? 15 : ap > 0.3 ? 10 : ap > 0.1 ? 5 : 0;
 
 // K线形态权重
 if (sig === "LONG" && (this.isBullC(cur) || this.isBullE(cur, prev))) s += 15;
 if (sig === "SHORT" && (this.isBearC(cur) || this.isBearE(cur, prev))) s += 15;
 
 // 趋势强度加成
 s += Math.floor(trendStrength * 10);
 
 return Math.min(100, s);
 }

 /**
  * 改进的趋势判断算法
  * 使用多根K线确认趋势，避免频繁切换
  */
 getTrend1h(cs1h) {
 if (cs1h.length < 5) return "HOLD";
 const last5 = cs1h.slice(-5);
 const bullishCount = last5.filter(c => c.ef > c.es && c.close > c.em).length;
 const bearishCount = last5.filter(c => c.ef < c.es && c.close < c.em).length;
 
 // 趋势强度计算
 const avgDiff = Math.abs((last5[last5.length-1].ef - last5[last5.length-1].es) / last5[last5.length-1].es * 100);
 const trendStrength = avgDiff;
 
 if (bullishCount >= 3) return { direction: "LONG", strength: trendStrength };
 if (bearishCount >= 3) return { direction: "SHORT", strength: trendStrength };
 return { direction: "HOLD", strength: 0 };
 }

 /**
  * 市场状态检测（震荡/趋势）
  */
 detectMarketState(cs15m) {
 if (cs15m.length < 20) return "unknown";
 const recent20 = cs15m.slice(-20);
 const highMax = Math.max(...recent20.map(c => c.high));
 const lowMin = Math.min(...recent20.map(c => c.low));
 const rangePct = (highMax - lowMin) / lowMin * 100;
 
 const avgATR = recent20.reduce((sum, c) => sum + c.atr, 0) / recent20.length;
 const atrPct = avgATR / recent20[recent20.length-1].close * 100;
 
 // 震荡市场：振幅小，ATR低
 if (rangePct < 1.5 && atrPct < 0.3) return "consolidation";
 // 趋势市场：振幅大，ATR高
 if (rangePct > 3 && atrPct > 0.5) return "trending";
 return "normal";
 }

 async run() {
 const price = await this.getPrice();
 const balance = this.cfg.dryRun ? this.cfg.capital : await this.getBalance();
 if (!this.cfg.dryRun) this.emit("realBalance", { balance });

 const curSlot = Math.floor(Date.now() / (15 * 60 * 1000));
 this.emit("balance", { balance, start: this.startBal });

 // 风控熔断检查
 if (!this.cfg.dryRun && this.startBal) {
 const loss = (this.startBal - balance) / this.startBal;
 if (loss > this.cfg.maxLoss / 100) {
 this.log("error", `🚨 风控触发！亏损 ${(loss*100).toFixed(1)}%`);
 this.stop(); this.emit("stopped", { reason: "风控熔断" }); return;
 }
 }

 // 每日盈亏限制检查
 if (this.dailyStartBal) {
 const dailyPct = (balance - this.dailyStartBal) / this.dailyStartBal * 100;
 const dailyTpLimit = this.cfg.dailyTpPct || 5;
 const dailySlLimit = this.cfg.dailySlPct || 3;
 
 if (dailyTpLimit > 0 && dailyPct >= dailyTpLimit) {
 this.log("win", `🎯 今日盈利已达${dailyPct.toFixed(2)}%，停止开新仓！`);
 return;
 }
 if (dailySlLimit > 0 && dailyPct <= -dailySlLimit) {
 this.log("error", `🛑 今日亏损已达${Math.abs(dailyPct).toFixed(2)}%，停止开新仓！`);
 return;
 }
 }

 const livePos = this.cfg.dryRun ? this.pos : await this.getPosition();

 // ── 持仓管理 ──────────────────────────────────────────
 if (livePos && this.pos) {
 const { dir } = this.pos;
 const entry = this.pos.entry;

 // 保本止损逻辑
 if (!this.pos._movedToBreakeven) {
 const profitPct = dir === "LONG"
 ? (price - entry) / entry * 100
 : (entry - price) / entry * 100;
 if (profitPct >= this.cfg.stopPct) {
 this.pos._movedToBreakeven = true;
 this.pos.sl = entry;
 this.log("open", `🔒 止损移至保本: ${entry} (盈利${profitPct.toFixed(1)}%)`);
 }
 }

 // 改进的移动止损逻辑
 if (this.cfg.trailPct > 0) {
 const profitPct = dir === "LONG" ? (price - entry) / entry * 100 : (entry - price) / entry * 100;
 // 只有盈利超过止损幅度时才移动止损
 if (profitPct >= this.cfg.stopPct) {
 const tr = this.cfg.trailPct / 100;
 const nsl = +(price * (dir === "LONG" ? 1 - tr : 1 + tr)).toFixed(2);
 const better = dir === "LONG" ? nsl > this.pos.sl : nsl < this.pos.sl;
 if (better) { this.pos.sl = nsl; this.log("scan", `📐 移动止损 → ${nsl}`); }
 }
 }

 const hitSL = dir === "LONG" ? price <= this.pos.sl : price >= this.pos.sl;
 const hitTP = dir === "LONG" ? price >= this.pos.tp : price <= this.pos.tp;

 if (hitTP || hitSL) {
 const reason = hitTP ? "止盈" : (this.pos._movedToBreakeven ? "保本出场" : "止损");
 const pPct = dir === "LONG" ? (price-entry)/entry*100 : (entry-price)/entry*100;
 
 // 正确的盈亏计算（含手续费）
 const fee = this.pos.notional * 0.0005 * 2; // 开仓+平仓手续费（0.05% each）
 const grossPnl = this.pos.notional * pPct / 100;
 const netPnl = grossPnl - fee;
 
 this.log(netPnl >= 0 ? "win" : "loss",
 `平仓${hitTP?"✅":"🔒"} ${reason} | ${dir} | 入:${entry.toFixed(2)} 现:${price.toFixed(2)} ${pPct>=0?"+":""}${pPct.toFixed(2)}% | 净利${netPnl>=0?"+":""}${netPnl.toFixed(2)}U`);
 
 if (!this.cfg.dryRun) await this.closePosition(livePos.size, dir);

 // 更新连亏/连盈计数
 if (netPnl >= 0) {
 this.consecutiveLosses = 0;
 this.consecutiveWins++;
 } else {
 this.consecutiveLosses++;
 this.consecutiveWins = 0;
 }

 // 更新每日盈亏
 this.dailyPnl += netPnl;

 // 根据亏损幅度设置冷却时间
 if (!hitTP) {
 const lossPct = Math.abs(pPct);
 let coolSlots = 2; // 默认30分钟
 if (lossPct > 2) coolSlots = 3; // 亏损>2%，冷却45分钟
 if (lossPct > 3) coolSlots = 4; // 亏损>3%，冷却60分钟
 this.cooldownUntilSlot = curSlot + coolSlots;
 this.log("warn", `⏸ 冷却期启动，${coolSlots*15}分钟内不开新仓（亏损${lossPct.toFixed(1)}%）`);
 }

 this.emit("trade", {
 time: Date.now(), dir, entry, exit: price,
 contracts: this.pos.issueContracts, notional: this.pos.notional,
 pPct: +pPct.toFixed(2), pnl: +netPnl.toFixed(2), reason,
 result: netPnl >= 0 ? "win" : "loss", consecutiveLosses: this.consecutiveLosses,
 consecutiveWins: this.consecutiveWins, fee: +fee.toFixed(4)
 });
 this.pos = null; this.emit("position", null); return;
 }

 const pPct = dir === "LONG" ? (price-entry)/entry*100 : (entry-price)/entry*100;
 this.emit("position", { ...this.pos, price, pPct: +pPct.toFixed(2) });
 this.log("info",
 `持仓 ${dir} | 入:${entry.toFixed(2)} 现:${price.toFixed(2)} ${pPct>=0?"+":""}${pPct.toFixed(2)}% SL:${this.pos.sl} TP:${this.pos.tp}${this.pos._movedToBreakeven?" 🔒保本":""}`);
 return;
 }

 if (livePos && !this.pos) { this.log("warn", "检测到未记录持仓，跳过"); return; }

 // ── 开仓（15m信号 + 1h趋势过滤 + AI分析）──────────────────────
 if (!this.pos && curSlot !== this.lastSlot) {
 this.lastSlot = curSlot;

 if (curSlot < this.cooldownUntilSlot) {
 const remain = (this.cooldownUntilSlot - curSlot) * 15;
 this.log("scan", `⏸ 冷却期 剩余约${remain}分钟，跳过本次扫描`);
 return;
 }

 // 检查每日交易次数限制
 if (this.cfg.maxTradesPerDay && this.dailyTrades >= this.cfg.maxTradesPerDay) {
 this.log("warn", `⚠️ 今日已开仓 ${this.dailyTrades}/${this.cfg.maxTradesPerDay} 次，达到日限制`);
 return;
 }

 // 获取多时间框架数据
 const [raw15m, raw1h] = await Promise.all([
 this.fetchKlines("15m", 200),
 this.fetchKlines("1h", 60)
 ]);

 const cs15m = this.buildIndicators(raw15m).filter(c => c.ef && c.rsi !== null && c.bbUp);
 const cs1h = this.buildIndicators(raw1h).filter(c => c.ef && c.rsi !== null);

 if (cs15m.length < 3) { this.log("warn", "15m K线不足"); return; }

 const cur15m = cs15m[cs15m.length - 2];
 const prev15m = cs15m[cs15m.length - 3];
 const sig = this.getSignal(cur15m, prev15m);

 // 改进的趋势判断
 const trendInfo = this.getTrend1h(cs1h);
 const trend1h = trendInfo.direction;
 const trendStrength = trendInfo.strength;

 // 市场状态检测
 const marketState = this.detectMarketState(cs15m);

 // 评分计算（含趋势强度）
 const score = this.scoreSignal(cur15m, prev15m, sig, trendStrength);
 const mtfOk = sig !== "HOLD" && sig === trend1h;
 const sigCN = sig === "LONG" ? "做多📈" : sig === "SHORT" ? "做空📉" : "观望";
 const mtfStr = sig === "HOLD" ? "" : (mtfOk ? ` ✅1h顺势(${trend1h})` : ` ⚠️1h逆势(${trend1h})`);
 const marketStr = marketState === "consolidation" ? ` ⚠️震荡市` : marketState === "trending" ? ` ✅趋势市` : "";

 this.log("scan",
 `[15m] 价格:${price} RSI:${cur15m.rsi.toFixed(1)} EMA9/21:${cur15m.ef.toFixed(0)}/${cur15m.es.toFixed(0)} | 【${sigCN}】${mtfStr}${marketStr} 评分:${score}`);
 this.emit("signal", {
 sig, price, rsi: cur15m.rsi, ef: cur15m.ef, es: cur15m.es,
 em: cur15m.em, bbComplement: cur15m.bbUp, bbLo: cur15m.bbLo,
 score, mtfOk, trend1h, marketState, trendStrength
 });

 // 核心开仓条件：信号非HOLD，趋势一致，评分足够
 if (sig !== "HOLD" && mtfOk && score >= 60) {
 // 市场状态过滤：震荡市降低置信度
 if (marketState === "consolidation" && score < 70) {
 this.log("scan", `⏸ 震荡市场，需要更高评分(${score}<70)，跳过`);
 return;
 }

 // AI分析决策
 const aiResult = await aiAdvise({
 sig, price, rsi: cur15m.rsi, ef: cur15m.ef, es: cur15m.es, em: cur15m.em,
 atr: cur15m.atr, trend: trend1h, score,
 recentCandles: raw15m.slice(-20)
 }, this.log.bind(this));

 // AI建议过滤（置信度≥60）
 if (!aiResult.allow) {
 this.log("scan", `🤖 AI建议跳过 | ${aiResult.reason} (置信度${aiResult.confidence}%)`);
 return;
 }

 this.log("open", `🤖 AI同意开仓 | ${aiResult.reason} (置信度${aiResult.confidence}%)`);

 const info = this.contractInfo || { mult: 0.0001 };

 // 改进的仓位管理：根据连亏状态和市场状态调整
 let posRatio = this.cfg.posRatio;
 let reductionMsg = "";
 
 // 连亏减仓（线性递减而非指数级）
 if (this.cfg.reduceAfterLosses && this.consecutiveLosses >= this.cfg.reduceAfterLosses) {
 const lossCount = Math.floor(this.consecutiveLosses / this.cfg.reduceAfterLosses);
 const reductionFactor = 1 - (lossCount * 0.25); // 每次减25%
 posRatio = Math.max(10, posRatio * reductionFactor); // 最低保持10%仓位
 reductionMsg = ` (连亏${this.consecutiveLosses}次，仓位${(reductionFactor*100).toFixed(0)}%)`;
 }
 
 // 震荡市减仓
 if (marketState === "consolidation") {
 posRatio = posRatio * 0.7; // 震荡市减仓30%
 reductionMsg += ` 震荡市减仓`;
 }

 // 连盈加仓（谨慎）
 if (this.consecutiveWins >= 3) {
 posRatio = Math.min(100, posRatio * 1.2); // 连盈加仓20%，最高100%
 reductionMsg += ` 连盈${this.consecutiveWins}次加仓`;
 }

 // 计算合约数量（包含手续费预留）
 const margin = balance * (posRatio/100);
 const contracts = Math.max(1, Math.floor(margin * this.cfg.leverage / (price * info.mult)));
 const notional = +(contracts * price * info.mult).toFixed(2);
 const actualMargin = +(notional / this.cfg.leverage).toFixed(2);
 
 // 检查保证金是否足够（含手续费预留）
 const feeReserve = notional * 0.001; // 手续费预留（0.1%）
 if (actualMargin + feeReserve > margin) {
 this.log("error", `💰 资金不足！需要 ${(actualMargin+feeReserve).toFixed(2)}U，可用 ${margin.toFixed(2)}U`);
 return;
 }

 // 改进的止损止盈计算
 const slDist = price * (this.cfg.stopPct/100);
 const tpDist = price * (this.cfg.takePct/100);
 
 // 验证盈亏比
 const riskRewardRatio = tpDist / slDist;
 if (riskRewardRatio < 1.5) {
 this.log("warn", `⚠️ 盈亏比不足 ${riskRewardRatio.toFixed(1)}:1，需要至少1.5:1`);
 return;
 }

 const sl = +(sig === "LONG" ? price - slDist : price + slDist).toFixed(2);
 const tp = +(sig === "LONG" ? price + tpDist : price - tpDist).toFixed(2);

 // 更新每日交易计数
 this.dailyTrades++;
 const today = new Date(Date.now()+8*3600*1000).toISOString().slice(0,10);
 this.lastTradeDate = today;

 this.log("open",
 `🚀 开仓 ${sig} ${contracts}张 (~${notional}U) 评分${score}${reductionMsg} | 今日${this.dailyTrades}${this.cfg.maxTradesPerDay?"/"+this.cfg.maxTradesPerDay:""}次 | 入:${price.toFixed(2)} SL:${sl} TP:${tp} (盈亏比${riskRewardRatio.toFixed(1)}:1)`);
 
 if (!this.cfg.dryRun) await this.placeOrder(sig, contracts);
 
 this.emit("trade", {
 time: Date.now(), dir: sig, entry: price, exit: null,
 contracts, notional, pPct: null, pnl: null, reason: "AI+策略开仓", result: "open",
 dailyTrades: this.dailyTrades, maxTradesPerDay: this.cfg.maxTradesPerDay,
 riskRewardRatio: +riskRewardRatio.toFixed(1), aiConfidence: aiResult.confidence
 });
 
 this.pos = {
 dir: sig, entry: price, sl, tp, contracts, notional,
 time: Date.now(), _movedToBreakeven: false,
 feeOpen: notional * 0.0005, feeClose: notional * 0.0005
 };
 
 this.emit("position", { ...this.pos, price, pPct: 0 });
 }
 }
 }

 // ── 指标计算 ──────────────────────────────────────────────
 ema(arr, p) {
 const k=2/(p+1), r=Array(arr.length).fill(null); let s=0;
 for(let i=0;i<arr.length;i++){
 if(i<p-1) s+=arr[i];
 else if(i===p-1){s+=arr[i];r[i]=s/p;}
 else r[i]=arr[i]*k+r[i-1]*(1-k);
 }
 return r;
 }
 rsiCalc(cls, p) {
 const r=Array(cls.length).fill(null); let ag=0,al=0;
 for(let i=1;i<=p;i++){const d=cls[i]-cls[i-1];d>0?ag+=d/p:al-=d/p;}
 r[p]=al===0?100:100-100/(1+ag/al);
 for(let i=p+1;i<cls.length;i++){
 const d=cls[i]-cls[i-1];
 ag=(ag*(p-1)+(d>0?d:0))/p; al=(al*(p-1)+(d<0?-d:0))/p;
 r[i]=al===0?100:100-100/(1+ag/al);
 }
 return r;
 }
 atrCalc(cs, p=14) {
 const tr=cs.map((c,i)=>i===0?c.high-c.low:
 Math.max(c.high-c.low,Math.abs(c.high-cs[i-1].close),Math.abs(c.low-cs[i-1].close)));
 return cs.map((_,i)=>i<p-1?null:tr.slice(i-p+1,i+1).reduce((a,v)=>a+v,0)/p);
 }
 bbCalc(cls, p=20, m=2) {
 const mid=this.ema(cls,p),up=Array(cls.length).fill(null),lo=Array(cls.length).fill(null);
 for(let i=p-1;i<cls.length;i++){
 const sl=cls.slice(i-p+1,i+1),mn=sl.reduce((a,v)=>a+v,0)/p;
 const sd=Math.sqrt(sl.map(v=>(v-mn)**2).reduce((a,v)=>a+v,0)/p);
 up[i]=mid[i]+m*sd; lo[i]=mid[i]-m*sd;
 }
 return{mid,up,lo};
 }
 buildIndicators(cs) {
 const cls=cs.map(c=>c.close);
 const ef=this.ema(cls,9),es=this.ema(cls,21),em=this.ema(cls,55);
 const ri=this.rsiCalc(cls,14),at=this.atrCalc(cs,14),B=this.bbCalc(cls,20,2);
 return cs.map((c,i)=>({...c,ef:ef[i],es:es[i],em:em[i],rsi:ri[i],atr:at[i],bbComplement:B.up[i],bbLo:B.lo[i]}));
 }
 isBullC(c){const b=Math.abs(c.close-c.open);return c.close>c.open&&(Math.min(c.close,c.open)-c.low)>b*1.5;}
 isBearC(c){const b=Math.abs(c.close-c.open);return c.close<c.open&&(c.high-Math.max(c.close,c.open))>b*1.5;}
 isBullE(c,p){return c.close>c.open&&p.close<p.open&&c.close>p.open&&c.open<p.close;}
 isBearE(c,p){return c.close<c.open&&p.close>p.open&&c.open>p.close&&c.close<p.open;}

 getSignal(cur, prev) {
 if(!cur.ef||cur.rsi===null||!cur.atr||!cur.bbComplement) return "HOLD";
 
 // 过滤低波动行情
 if(cur.atr/cur.close < 0.0015) return "HOLD";
 
 const xUp = prev.ef<prev.es && cur.ef>cur.es;
 const xDn = prev.ef>prev.es && cur.ef<cur.es;
 const bbL = prev.close<=prev.bbLo && cur.close>cur.bbLo;
 const bbS = prev.close>=prev.bbComplement && cur.close<cur.bbComplement;
 const emaL = prev.low<=prev.em*1.003 && cur.close>cur.em && cur.close>prev.close;
 const emaS = prev.high>=prev.em*0.997 && cur.close<cur.em && cur.close<prev.close;
 const rsiL = cur.rsi>30 && cur.rsi<70;
 const rsiS = cur.rsi>30 && cur.rsi<72;
 const long = (bbL&&rsiL)||(xUp&&cur.close>cur.em&&rprobabilityL)||(emaL&&rsiL&&(this.isBullC(cur)||this.isBullE(cur,prev)));
 const short = (bbS&&rsiS)||(xDn&&cur.close<cur.em&&rsiS)||(emaS&&rsiS&&(this.isBearC(cur)||this.isBearE(cur,prev)));
 return long?"LONG":short?"SHORT":"HOLD";
 }

 // ── API ──────────────────────────────────────────────────
 request(method, apiPath, query={}, body=null) {
 return new Promise((resolve,reject)=>{
 const qs=Object.keys(query).length
 ?Object.entries(query).map(([k,v])=>`${k}=${encodeURIComponent(v)}`).join("&"):"";
 const fullPath="/api/v4"+apiPath+(qs?"?"+qs:"");
 const bodyStr=body?JSON.stringify(body):"";
 const headers={"Content-Type":"application/json",Accept:"application/json"};
 if(this.cfg.apiKey){
 const ts=Math.floor(Date.now()/1000).toString();
 const bh=crypto.createHash("sha256").update(bodyStr).digest("hex");
 const sig=crypto.createHmac("sha256",this.cfg.apiSecret)
 .update(`${method}\n/api/v4${apiPath}\n${qs}\n${bh}\n${ts}`).digest("hex");
 headers.KEY=this.cfg.apiKey; headers.Timestamp=ts; headers.SIGN=sig;
 }
 const req=https.request({hostname:"api.gateio.ws",path:fullPath,method,headers},res=>{
 let d=""; res.on("data",c=>d+=c);
 res.on("end",()=>{try{resolve({status:res.statusCode,body:JSON.parse(d)});}catch(e){reject(e);}});
 });
 req.on("error",reject); if(bodyStr)req.write(bodyStr); req.end();
 });
 }

 async fetchKlines(interval="1h", bars=120) {
 const SECS={"1m":60,"5m":300,"15m":900,"1h":3600,"4h":14400,"1d":86400};
 const to=Math.floor(Date.now()/1000), from=to-(SECS[interval]||3600)*bars;
 const r=await this.request("GET","/futures/usdt/candlesticks",
 {contract:"BTC_USDT",from,to,interval});
 return r.body.map(c=>({time:+c.t,open:+c.o,high:+c.h,low:+c.l,close:+c.c}))
 .sort((a,b)=>a.time-b.time);
 }
 async getBalance() { 
 const r=await this.request("GET","/futures/usdt/accounts"); 
 return parseFloat(r.body.available); 
 }
 async getPrice() { 
 const r=await this.request("GET","/futures/usdt/tickers",{contract:"BTC_USDT"}); 
 return parseFloat(r.body[0].last); 
 }
 async getPosition() {
 const r=await this.request("GET","/futures/usdt/positions/BTC_USDT"); const p=r.body;
 if(!p||p.size===0) return null;
 return{dir:p.size>0?"LONG":"SHORT",size:Math.abs(p.size),entry:parseFloat(p.entry_price),upnl:parseFloat(p.unrealised_pnl)};
 }
 async getContractInfo() {
 const r=await this.request("GET","/futures/usdt/contracts/BTC_USDT");
 return{mult:parseFloat(r.body.quanto_multiplier),minSize:parseInt(r.body.order_size_min)};
 }
 async setLeverage() {
 await this.request("POST","/futures/usdt/positions/BTC_USDT/leverage",{},
 {leverage:String(this.cfg.leverage),cross_leverage_limit:"0"});
 }
 async placeOrder(dir,contracts) {
 const r=await this.request("POST","/futures/usdt/orders",{},{
 contract:"BTC_USDT",size:dir==="LONG"?contracts:-contracts,price:"0",tif:"ioc",reduce_only:false});
 if(r.status!==201) throw new Error("下单失败: "+JSON.stringify(r.body));
 }
 async closePosition(size,dir) {
 const r=await this.request("POST","/futures/usdt/orders",{},{
 contract:"BTC_USDT",size:dir==="LONG"?-size:size,price:"0",tif:"ioc",reduce_only:true});
 if(r.status!==201) throw new Error("平仓失败: "+JSON.stringify(r.body));
 }
 log(level, msg) {
 const ts=new Date(Date.now()+8*3600*1000).toISOString().replace("T"," ").slice(0,19);
 this.emit("log",{level,msg,ts});
 }

 // ── 手动操作 ─────────────────────────────────────────────
 async partialClose(ratio) {
 const livePos=this.cfg.dryRun?this.pos:await this.getPosition();
 if(!livePos){this.log("warn","无持仓");return;}
 const totalSz=this.cfg.dryRun?this.pos.contracts:livePos.size;
 const closeSize=Math.max(1,Math.floor(totalSz*ratio));
 const dir=this.pos.dir, entry=this.pos.entry;
 this.log("open",`手动平仓 ${(ratio*100).toFixed(0)}% | ${dir} 平 ${closeSize}张`);
 if(!this.cfg.dryRun){
 const r=await this.request("POST","/futures/usdt/orders",{},{
 contract:"BTC_USDT",size:dir==="LONG"?-closeSize:closeSize,price:"0",tif:"ioc",reduce_only:true});
 if(r.status!==201) throw new Error("平仓失败: "+JSON.stringify(r.body));
 }
 const price=await this.getPrice().catch(()=>entry);
 const pPct=dir==="LONG"?(price-entry)/entry*100:(entry-price)/entry*100;
 // 正确的手动平仓盈亏计算
 const feeClose = this.pos.feeClose * ratio; // 只支付对应比例的平仓手续费
 const grossPnl = this.pos.notional * ratio * pPct /