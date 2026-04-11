"use strict";
const https  = require("https");
const crypto = require("crypto");
const fs     = require("fs");
const path   = require("path");

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
    
    // ★ 增强：风控追踪
    this.dailyStats = { trades: 0, wins: 0, losses: 0, pnl: 0, date: new Date().toDateString() };
    this.weeklyStats = { trades: 0, wins: 0, losses: 0, pnl: 0, week: this.getWeekNumber() };
    this.consecutiveLosses = 0;
    this.maxDrawdown = 0;
    this.peakBalance = null;
    this.lastTradeTime = 0;
    
    // ★ 增强：多币种支持
    this.symbols = config.symbols || [{ symbol: "ETH_USDT", weight: 1 }];
    this.activeSymbol = this.symbols[0].symbol;
    this.multiPos = {}; // 多币种持仓
    
    // ★ 增强：市场状态
    this.marketRegime = "unknown"; // trending, ranging, volatile
    this.volatilityRegime = "normal"; // low, normal, high
    this.lastNewsCheck = 0;
    
    // ★ 增强：指标缓存
    this.indicatorCache = {};
    this.cacheExpiry = 5 * 60 * 1000; // 5分钟
  }

  getWeekNumber() {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + 4 - (d.getDay() || 7));
    const yearStart = new Date(d.getFullYear(), 0, 1);
    return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  }

  async start() {
    this.running = true;
    this.log("info", `🚀 超级版机器人启动 | ${this.cfg.dryRun ? "【模拟模式】" : "【真实交易】"}`);
    this.log("info", `📊 交易对: ${this.symbols.map(s => s.symbol).join(", ")}`);
    
    try {
      // 加载历史统计
      this.loadStats();
      
      if (!this.cfg.dryRun) { 
        await this.setLeverage(); 
        this.log("info", `杠杆已设置: ${this.cfg.leverage}x`);
      }
      
      this.contractInfo = await this.getContractInfo();
      this.startBal = this.cfg.dryRun ? this.cfg.capital : await this.getBalance();
      this.peakBalance = this.startBal;
      this.emit("balance", { balance: this.startBal, start: this.startBal });
      this.log("info", `💰 账户余额: ${this.startBal.toFixed(2)} USDT`);
      
      // 检测市场状态
      await this.detectMarketRegime();
      
      this._setConn(true);
      
      // 预加载历史数据
      for (const sym of this.symbols) {
        try {
          const hist1m = await this.fetchKlines("1m", 120, sym.symbol);
          this.emit("priceHistory", { symbol: sym.symbol, prices: hist1m.map(c => c.close) });
        } catch(e) { this.log("warn", `${sym.symbol} 历史价格加载失败`); }
      }
      
      this.tick();
      this.startPriceTicker();
      this.startStatsSaver();
      
    } catch(e) { 
      this._setConn(false); 
      this.log("error", "启动失败: " + e.message); 
    }
  }

  // ★ 增强：市场状态检测
  async detectMarketRegime() {
    try {
      const klines = await this.fetchKlines("1h", 48);
      const closes = klines.map(k => k.close);
      const atr = this.atrCalc(klines, 14);
      const lastATR = atr[atr.length - 1];
      const avgATR = atr.slice(-20).reduce((a, b) => a + b, 0) / 20;
      
      // 波动率状态
      if (lastATR > avgATR * 1.5) this.volatilityRegime = "high";
      else if (lastATR < avgATR * 0.7) this.volatilityRegime = "low";
      else this.volatilityRegime = "normal";
      
      // 趋势状态（ADX近似）
      const ema20 = this.ema(closes, 20);
      const ema50 = this.ema(closes, 50);
      const trendStrength = Math.abs(ema20[ema20.length - 1] - ema50[ema50.length - 1]) / closes[closes.length - 1] * 100;
      
      if (trendStrength > 2) this.marketRegime = "trending";
      else if (trendStrength < 0.5) this.marketRegime = "ranging";
      else this.marketRegime = "mixed";
      
      this.log("info", `📈 市场状态: ${this.marketRegime} | 波动率: ${this.volatilityRegime}`);
      
      // 自适应参数调整
      this.adaptParameters();
      
    } catch(e) {
      this.log("warn", "市场状态检测失败: " + e.message);
    }
  }

  // ★ 增强：自适应参数
  adaptParameters() {
    const base = { ...this.cfg };
    
    // 根据波动率调整
    if (this.volatilityRegime === "high") {
      this.cfg.stopPct = base.stopPct * 1.3;
      this.cfg.takePct = base.takePct * 1.2;
      this.cfg.posRatio = Math.min(base.posRatio * 0.7, 15);
      this.log("info", "⚙️ 高波动模式: 止损+30%, 止盈+20%, 仓位-30%");
    } else if (this.volatilityRegime === "low") {
      this.cfg.stopPct = base.stopPct * 0.8;
      this.cfg.takePct = base.takePct * 0.9;
      this.cfg.posRatio = Math.min(base.posRatio * 1.2, 30);
      this.log("info", "⚙️ 低波动模式: 止损-20%, 止盈-10%, 仓位+20%");
    }
    
    // 震荡市场提高评分门槛
    if (this.marketRegime === "ranging") {
      this.cfg.scoreThreshold = (base.scoreThreshold || 65) + 10;
      this.log("info", "⚙️ 震荡市场: 评分门槛+10");
    }
  }

  loadStats() {
    try {
      const data = fs.readFileSync(path.join(__dirname, "trade_stats.json"), "utf8");
      const stats = JSON.parse(data);
      if (stats.daily && stats.daily.date === new Date().toDateString()) {
        this.dailyStats = stats.daily;
      }
      if (stats.weekly && stats.weekly.week === this.getWeekNumber()) {
        this.weeklyStats = stats.weekly;
      }
      this.consecutiveLosses = stats.consecutiveLosses || 0;
      this.maxDrawdown = stats.maxDrawdown || 0;
    } catch(e) {
      // 首次运行
    }
  }

  saveStats() {
    try {
      fs.writeFileSync(path.join(__dirname, "trade_stats.json"), JSON.stringify({
        daily: this.dailyStats,
        weekly: this.weeklyStats,
        consecutiveLosses: this.consecutiveLosses,
        maxDrawdown: this.maxDrawdown,
        lastSave: Date.now()
      }), "utf8");
    } catch(e) {}
  }

  startStatsSaver() {
    setInterval(() => this.saveStats(), 60000); // 每分钟保存
  }

  updateConfig(newCfg) {
    const keys = ["takePct","stopPct","posRatio","maxLoss","leverage","trailPct","partialPct",
                  "scoreThreshold","dailyMaxTrades","weeklyMaxTrades","maxConsecutiveLosses"];
    keys.forEach(k => { if (newCfg[k] != null) this.cfg[k] = newCfg[k]; });
    this.log("open", `⚙️ 参数热更新 | 止盈${this.cfg.takePct}% 止损${this.cfg.stopPct}%`);
    this.emit("configUpdated", this.cfg);
  }

  stop() {
    this.running = false;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.priceTimer) { clearInterval(this.priceTimer); this.priceTimer = null; }
    this.saveStats();
    this.log("info", "🛑 机器人已停止");
  }

  async tick() {
    if (!this.running) return;
    try { 
      await this.run(); 
      this._setConn(true); 
    }
    catch(e) { 
      this._setConn(false); 
      this.log("error", e.message); 
    }
    if (this.running) this.timer = setTimeout(() => this.tick(), 60_000);
  }

  startPriceTicker() {
    this.priceTimer = setInterval(async () => {
      if (!this.running) return;
      try { 
        const price = await this.getPrice(this.activeSymbol);
        this.emit("price", { symbol: this.activeSymbol, price }); 
        this._setConn(true); 
      }
      catch(e) { this._setConn(false); }
    }, 1000);
  }

  _setConn(ok) {
    if (this._connOk === ok) return;
    this._connOk = ok;
    this.emit("conn", { ok });
    this.log(ok ? "info" : "warn", ok ? "✅ API 连接已恢复" : "⚠️ API 连接异常");
  }

  // ★ 增强：风控检查
  checkRiskLimits(balance) {
    // 每日交易次数限制
    if (this.cfg.dailyMaxTrades && this.dailyStats.trades >= this.cfg.dailyMaxTrades) {
      this.log("warn", `📛 今日已达最大交易次数 (${this.cfg.dailyMaxTrades})`);
      return false;
    }
    
    // 每周交易次数限制
    if (this.cfg.weeklyMaxTrades && this.weeklyStats.trades >= this.cfg.weeklyMaxTrades) {
      this.log("warn", `📛 本周已达最大交易次数 (${this.cfg.weeklyMaxTrades})`);
      return false;
    }
    
    // 连续亏损限制
    if (this.cfg.maxConsecutiveLosses && this.consecutiveLosses >= this.cfg.maxConsecutiveLosses) {
      this.log("error", `🚨 连续亏损${this.consecutiveLosses}次，暂停交易`);
      this.stop();
      this.emit("stopped", { reason: `连续亏损${this.consecutiveLosses}次熔断` });
      return false;
    }
    
    // 最大回撤保护
    if (this.peakBalance && this.cfg.maxDrawdown) {
      const drawdown = (this.peakBalance - balance) / this.peakBalance * 100;
      if (drawdown > this.maxDrawdown) this.maxDrawdown = drawdown;
      if (drawdown > this.cfg.maxDrawdown) {
        this.log("error", `🚨 回撤熔断！当前回撤 ${drawdown.toFixed(1)}% > ${this.cfg.maxDrawdown}%`);
        this.stop();
        this.emit("stopped", { reason: `回撤熔断 ${drawdown.toFixed(1)}%` });
        return false;
      }
    }
    
    // 最小交易间隔
    if (this.cfg.minTradeInterval) {
      const sinceLast = Date.now() - this.lastTradeTime;
      if (sinceLast < this.cfg.minTradeInterval * 60000) {
        return false;
      }
    }
    
    return true;
  }

  // ★ 增强：评分系统（含MACD和成交量）
  scoreSignal(cur, prev, sig, extra = {}) {
    if (sig === "HOLD") return { score: 0, factors: {} };
    
    let s = 50;
    const factors = {};
    
    // RSI 加分
    if (sig === "LONG") {
      s += cur.rsi < 35 ? 15 : cur.rsi < 45 ? 10 : cur.rsi < 55 ? 5 : 0;
      factors.rsi = cur.rsi < 35 ? 15 : cur.rsi < 45 ? 10 : cur.rsi < 55 ? 5 : 0;
    } else {
      s += cur.rsi > 65 ? 15 : cur.rsi > 55 ? 10 : cur.rsi > 50 ? 3 : 0;
      factors.rsi = cur.rsi > 65 ? 15 : cur.rsi > 55 ? 10 : cur.rsi > 50 ? 3 : 0;
    }
    
    // EMA 间距（趋势强度）
    const ed = Math.abs(cur.ef - cur.es) / cur.close * 100;
    s += ed > 0.3 ? 15 : ed > 0.15 ? 8 : ed > 0.05 ? 3 : 0;
    factors.emaSpread = ed > 0.3 ? 15 : ed > 0.15 ? 8 : ed > 0.05 ? 3 : 0;
    
    // ATR 波动
    const ap = cur.atr / cur.close * 100;
    s += ap > 0.4 ? 10 : ap > 0.25 ? 5 : 0;
    factors.atr = ap > 0.4 ? 10 : ap > 0.25 ? 5 : 0;
    
    // ★ MACD 加分
    if (extra.macd && extra.macdSignal) {
      const macdBull = extra.macd > extra.macdSignal && extra.macd > 0;
      const macdBear = extra.macd < extra.macdSignal && extra.macd < 0;
      if (sig === "LONG" && macdBull) { s += 12; factors.macd = 12; }
      if (sig === "SHORT" && macdBear) { s += 12; factors.macd = 12; }
    }
    
    // ★ 成交量加分
    if (extra.volumeRatio) {
      s += extra.volumeRatio > 2 ? 10 : extra.volumeRatio > 1.5 ? 6 : extra.volumeRatio > 1 ? 3 : 0;
      factors.volume = extra.volumeRatio > 2 ? 10 : extra.volumeRatio > 1.5 ? 6 : extra.volumeRatio > 1 ? 3 : 0;
    }
    
    // ★ 布林带位置
    if (cur.bbUp && cur.bbLo) {
      const bbPos = (cur.close - cur.bbLo) / (cur.bbUp - cur.bbLo);
      if (sig === "LONG" && bbPos < 0.3) { s += 8; factors.bb = 8; }
      if (sig === "SHORT" && bbPos > 0.7) { s += 8; factors.bb = 8; }
    }
    
    // 蜡烛形态
    if (sig === "LONG" && (this.isBullC(cur) || this.isBullE(cur, prev))) { s += 10; factors.candle = 10; }
    if (sig === "SHORT" && (this.isBearC(cur) || this.isBearE(cur, prev))) { s += 10; factors.candle = 10; }
    
    return { score: Math.min(100, s), factors };
  }

  async run() {
    const price = await this.getPrice(this.activeSymbol);
    const balance = this.cfg.dryRun ? this.cfg.capital : await this.getBalance();
    
    // 更新峰值和回撤
    if (balance > this.peakBalance) this.peakBalance = balance;
    if (!this.cfg.dryRun) this.emit("realBalance", { balance });
    
    const curSlot = Math.floor(Date.now() / (15 * 60 * 1000));
    this.emit("balance", { balance, start: this.startBal, peak: this.peakBalance, drawdown: this.maxDrawdown });

    // 风控熔断
    if (!this.cfg.dryRun && this.startBal) {
      const loss = (this.startBal - balance) / this.startBal;
      if (loss > this.cfg.maxLoss / 100) {
        this.log("error", `🚨 风控触发！亏损 ${(loss*100).toFixed(1)}%`);
        this.stop(); 
        this.emit("stopped", { reason: "风控熔断" }); 
        return;
      }
    }
    
    // 风控限制检查
    if (!this.checkRiskLimits(balance)) return;

    const livePos = this.cfg.dryRun ? this.pos : await this.getPosition(this.activeSymbol);

    // ── 持仓管理 ──────────────────────────────────────────
    if (livePos && this.pos) {
      const { dir } = this.pos;
      const entry = this.pos.entry;

      // 保本移损
      if (!this.pos._movedToBreakeven) {
        const profitPct = dir === "LONG"
          ? (price - entry) / entry * 100
          : (entry - price) / entry * 100;
        if (profitPct >= this.cfg.stopPct) {
          this.pos._movedToBreakeven = true;
          this.pos.sl = entry;
          this.log("open", `🔒 止损移至保本: ${entry} (盈利已达${profitPct.toFixed(1)}%)`);
        }
      }

      // 移动止损
      if (this.cfg.trailPct > 0) {
        const tr = this.cfg.trailPct / 100;
        const nsl = +(price * (dir === "LONG" ? 1 - tr : 1 + tr)).toFixed(2);
        const better = dir === "LONG" ? nsl > this.pos.sl : nsl < this.pos.sl;
        if (better) { 
          this.pos.sl = nsl; 
          this.log("scan", `📐 移动止损 → ${nsl}`); 
        }
      }

      const hitSL = dir === "LONG" ? price <= this.pos.sl : price >= this.pos.sl;
      const hitTP = dir === "LONG" ? price >= this.pos.tp : price <= this.pos.tp;

      if (hitTP || hitSL) {
        const reason = hitTP ? "止盈" : (this.pos._movedToBreakeven ? "保本出场" : "止损");
        const pPct = dir === "LONG" ? (price-entry)/entry*100 : (entry-price)/entry*100;
        const pnl = this.pos.notional * pPct / 100 / this.cfg.leverage;
        
        // 更新统计
        this.updateStats(pnl >= 0, pnl);
        
        this.log(pnl >= 0 ? "win" : "loss",
          `平仓${hitTP?"✅":"🔒"} ${reason} | ${dir} | 入:${entry.toFixed(2)} 现:${price.toFixed(2)} ${pPct>=0?"+":""}${pPct.toFixed(2)}%`);
        
        if (!this.cfg.dryRun) await this.closePosition(livePos.size, dir, this.activeSymbol);

        if (!hitTP) {
          this.cooldownUntilSlot = curSlot + 2;
          this.log("warn", `⏸ 冷却期启动，30分钟内不开新仓`);
        }

        this.emit("trade", {
          time: Date.now(), symbol: this.activeSymbol, dir, entry, exit: price,
          contracts: this.pos.contracts, notional: this.pos.notional,
          pPct: +pPct.toFixed(2), pnl: +pnl.toFixed(2), reason,
          result: pnl >= 0 ? "win" : "loss",
          dailyStats: this.dailyStats,
          weeklyStats: this.weeklyStats
        });
        
        this.pos = null; 
        this.emit("position", null);
        this.lastTradeTime = Date.now();
        return;
      }

      const pPct = dir === "LONG" ? (price-entry)/entry*100 : (entry-price)/entry*100;
      this.emit("position", { ...this.pos, symbol: this.activeSymbol, price, pPct: +pPct.toFixed(2) });
      return;
    }

    if (livePos && !this.pos) { this.log("warn", "检测到未记录持仓，跳过"); return; }

    // ── 开仓（多时间框架分析）─────────────────────────────
    if (!this.pos && curSlot !== this.lastSlot) {
      this.lastSlot = curSlot;

      if (curSlot < this.cooldownUntilSlot) {
        const remain = (this.cooldownUntilSlot - curSlot) * 15;
        this.log("scan", `⏸ 冷却期 剩余约${remain}分钟`);
        this.emit("cooldown", { remain });
        return;
      }

      // ★ 多时间框架数据获取
      const [raw15m, raw1h, raw4h] = await Promise.all([
        this.fetchKlines("15m", 200, this.activeSymbol),
        this.fetchKlines("1h", 60, this.activeSymbol),
        this.fetchKlines("4h", 30, this.activeSymbol)
      ]);

      const cs15m = this.buildIndicators(raw15m, true); // true = 包含成交量
      const cs1h = this.buildIndicators(raw1h);
      const cs4h = this.buildIndicators(raw4h);

      if (cs15m.length < 3) { this.log("warn", "15m K线不足"); return; }

      const cur15m = cs15m[cs15m.length - 2];
      const prev15m = cs15m[cs15m.length - 3];
      const sig = this.getSignal(cur15m, prev15m);

      // ★ 多时间框架趋势确认
      let trend1h = "HOLD", trend4h = "HOLD";
      if (cs1h.length >= 2) {
        const c1h = cs1h[cs1h.length - 2];
        trend1h = c1h.ef > c1h.es ? "LONG" : "SHORT";
      }
      if (cs4h.length >= 2) {
        const c4h = cs4h[cs4h.length - 2];
        trend4h = c4h.ef > c4h.es ? "LONG" : "SHORT";
      }

      // ★ 计算成交量比率
      const recentVol = raw15m.slice(-5).reduce((a, k) => a + k.volume, 0) / 5;
      const avgVol = raw15m.slice(-20, -5).reduce((a, k) => a + k.volume, 0) / 15;
      const volumeRatio = recentVol / avgVol;

      // ★ 增强评分
      const { score, factors } = this.scoreSignal(cur15m, prev15m, sig, {
        macd: cur15m.macd,
        macdSignal: cur15m.macdSignal,
        volumeRatio
      });

      // ★ 多时间框架共振要求
      const mtfScore = (trend1h === sig ? 1 : 0) + (trend4h === sig ? 1 : 0);
      const mtfOk = sig !== "HOLD" && mtfScore >= (this.cfg.mtfRequired || 1);
      
      const sigCN = sig === "LONG" ? "做多📈" : sig === "SHORT" ? "做空📉" : "观望";
      const mtfStr = sig === "HOLD" ? "" : ` MTF:${mtfScore}/2`;

      this.log("scan",
        `[${this.activeSymbol}] 价格:${price} RSI:${cur15m.rsi.toFixed(1)} | 【${sigCN}】${mtfStr} 评分:${score} 量:${volumeRatio.toFixed(1)}x`);
      
      this.emit("signal", {
        symbol: this.activeSymbol, sig, price, rsi: cur15m.rsi, 
        ef: cur15m.ef, es: cur15m.es, score, factors,
        mtfScore, trend1h, trend4h, volumeRatio
      });

      // 评分门槛检查
      const threshold = this.cfg.scoreThreshold || 65;
      if (sig !== "HOLD" && mtfOk && score >= threshold) {
        // 计算仓位（根据连续亏损递减）
        let positionMultiplier = Math.max(0.3, 1 - this.consecutiveLosses * 0.15);
        
        const info = this.contractInfo || { mult: 0.001 };
        const baseContracts = Math.max(1, Math.floor(
          balance * (this.cfg.posRatio/100) * this.cfg.leverage / (price * info.mult)
        ));
        const contracts = Math.floor(baseContracts * positionMultiplier);
        
        const sl = +(price * (sig==="LONG" ? 1-this.cfg.stopPct/100 : 1+this.cfg.stopPct/100)).toFixed(2);
        const tp = +(price * (sig==="LONG" ? 1+this.cfg.takePct/100 : 1-this.cfg.takePct/100)).toFixed(2);
        const notional = +(contracts * price * info.mult * this.cfg.leverage).toFixed(2);

        this.log("open",
          `开仓 ${sig} ${contracts}张 (~${notional}U) 评分${score} 仓位系数:${positionMultiplier.toFixed(1)}x | 入:${price.toFixed(2)} SL:${sl} TP:${tp}`);
        
        if (!this.cfg.dryRun) await this.placeOrder(sig, contracts, this.activeSymbol);
        
        this.emit("trade", {
          time: Date.now(), symbol: this.activeSymbol, dir: sig, entry: price, exit: null,
          contracts, notional, pPct: null, pnl: null, reason: "开仓", result: "open",
          factors
        });
        
        this.pos = {
          dir: sig, entry: price, sl, tp, contracts, notional,
          time: Date.now(), _movedToBreakeven: false
        };
        this.emit("position", { ...this.pos, symbol: this.activeSymbol, price, pPct: 0 });
        this.lastTradeTime = Date.now();
      }
    }
  }

  updateStats(isWin, pnl) {
    this.dailyStats.trades++;
    this.weeklyStats.trades++;
    this.dailyStats.pnl += pnl;
    this.weeklyStats.pnl += pnl;
    
    if (isWin) {
      this.dailyStats.wins++;
      this.weeklyStats.wins++;
      this.consecutiveLosses = 0;
    } else {
      this.dailyStats.losses++;
      this.weeklyStats.losses++;
      this.consecutiveLosses++;
    }
    
    this.saveStats();
  }

  // ── 指标计算（含MACD和成交量）───────────────────────────
  ema(arr, p) {
    const k = 2/(p+1), r = Array(arr.length).fill(null);
    let s = 0;
    for (let i = 0; i < arr.length; i++) {
      if (i < p-1) s += arr[i];
      else if (i === p-1) { s += arr[i]; r[i] = s/p; }
      else r[i] = arr[i]*k + r[i-1]*(1-k);
    }
    return r;
  }
  
  macdCalc(cls) {
    const ema12 = this.ema(cls, 12);
    const ema26 = this.ema(cls, 26);
    const macd = ema12.map((v, i) => v && ema26[i] ? v - ema26[i] : null);
    const signal = this.ema(macd.filter(v => v !== null), 9);
    return { macd, signal };
  }
  
  rsiCalc(cls, p) {
    const r = Array(cls.length).fill(null);
    let ag = 0, al = 0;
    for (let i = 1; i <= p; i++) {
      const d = cls[i] - cls[i-1];
      d > 0 ? ag += d/p : al -= d/p;
    }
    r[p] = al === 0 ? 100 : 100 - 100/(1 + ag/al);
    for (let i = p+1; i < cls.length; i++) {
      const d = cls[i] - cls[i-1];
      ag = (ag*(p-1) + (d > 0 ? d : 0))/p;
      al = (al*(p-1) + (d < 0 ? -d : 0))/p;
      r[i] = al === 0 ? 100 : 100 - 100/(1 + ag/al);
    }
    return r;
  }
  
  atrCalc(cs, p = 14) {
    const tr = cs.map((c, i) => i === 0 ? c.high - c.low :
      Math.max(c.high - c.low, Math.abs(c.high - cs[i-1].close), Math.abs(c.low - cs[i-1].close)));
    return cs.map((_, i) => i < p-1 ? null : tr.slice(i-p+1, i+1).reduce((a, v) => a+v, 0)/p);
  }
  
  bbCalc(cls, p = 20, m = 2) {
    const mid = this.ema(cls, p);
    const up = Array(cls.length).fill(null), lo = Array(cls.length).fill(null);
    for (let i = p-1; i < cls.length; i++) {
      const sl = cls.slice(i-p+1, i+1);
      const mn = sl.reduce((a, v) => a+v, 0)/p;
      const sd = Math.sqrt(sl.map(v => (v-mn)**2).reduce((a, v) => a+v, 0)/p);
      up[i] = mid[i] + m*sd;
      lo[i] = mid[i] - m*sd;
    }
    return { mid, up, lo };
  }
  
  buildIndicators(cs, withVolume = false) {
    const cls = cs.map(c => c.close);
    const ef = this.ema(cls, 9), es = this.ema(cls, 21), em = this.ema(cls, 55);
    const ri = this.rsiCalc(cls, 14), at = this.atrCalc(cs, 14);
    const B = this.bbCalc(cls, 20, 2);
    const macdData = this.macdCalc(cls);
    
    return cs.map((c, i) => ({
      ...c,
      ef: ef[i], es: es[i], em: em[i],
      rsi: ri[i], atr: at[i],
      bbUp: B.up[i], bbLo: B.lo[i],
      macd: macdData.macd[i],
      macdSignal: macdData.signal[i] || null,
      volume: withVolume ? c.volume : null
    }));
  }

  isBullC(c) { 
    const b = Math.abs(c.close - c.open);
    return c.close > c.open && (Math.min(c.close, c.open) - c.low) > b * 1.5;
  }
  isBearC(c) { 
    const b = Math.abs(c.close - c.open);
    return c.close < c.open && (c.high - Math.max(c.close, c.open)) > b * 1.5;
  }
  isBullE(c, p) { 
    return c.close > c.open && p.close < p.open && c.close > p.open && c.open < p.close;
  }
  isBearE(c, p) { 
    return c.close < c.open && p.close > p.open && c.open > p.close && c.close < p.open;
  }

  getSignal(cur, prev) {
    if (!cur.ef || cur.rsi === null || !cur.atr || !cur.bbUp) return "HOLD";
    if (cur.atr/cur.close < 0.0015) return "HOLD";
    const xUp = prev.ef < prev.es && cur.ef > cur.es;
    const xDn = prev.ef > prev.es && cur.ef < cur.es;
    const bbL = prev.close <= prev.bbLo && cur.close > cur.bbLo;
    const bbS = prev.close >= prev.bbUp && cur.close < cur.bbUp;
    const emaL = prev.low <= prev.em*1.003 && cur.close > cur.em && cur.close > prev.close;
    const emaS = prev.high >= prev.em*0.997 && cur.close < cur.em && cur.close < prev.close;
    const rsiL = cur.rsi > 30 && cur.rsi < 70;
    const rsiS = cur.rsi > 30 && cur.rsi < 72;
    const long  = (bbL&&rsiL)||(xUp&&cur.close>cur.em&&rsiL)||(emaL&&rsiL&&(this.isBullC(cur)||this.isBullE(cur,prev)));
    const short = (bbS&&rsiS)||(xDn&&cur.close<cur.em&&rsiS)||(emaS&&rsiS&&(this.isBearC(cur)||this.isBearE(cur,prev)));
    return long?"LONG":short?"SHORT":"HOLD";
  }

  // ── API 方法 ────────────────────────────────────────────
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

  async fetchKlines(interval="1h", bars=120, symbol="ETH_USDT") {
    const SECS={"1m":60,"5m":300,"15m":900,"1h":3600,"4h":14400,"1d":86400};
    const to=Math.floor(Date.now()/1000), from=to-(SECS[interval]||3600)*bars;
    const r=await this.request("GET","/futures/usdt/candlesticks",
      {contract:symbol,from,to,interval});
    return r.body.map(c=>({time:+c.t,open:+c.o,high:+c.h,low:+c.l,close:+c.c,volume:+c.v||0}))
      .sort((a,b)=>a.time-b.time);
  }
  async getBalance()  { const r=await this.request("GET","/futures/usdt/accounts"); return parseFloat(r.body.available); }
  async getPrice(symbol="ETH_USDT") { const r=await this.request("GET","/futures/usdt/tickers",{contract:symbol}); return parseFloat(r.body[0].last); }
  async getPosition(symbol="ETH_USDT") {
    const r=await this.request("GET","/futures/usdt/positions/"+symbol); const p=r.body;
    if(!p||p.size===0) return null;
    return{dir:p.size>0?"LONG":"SHORT",size:Math.abs(p.size),entry:parseFloat(p.entry_price),upnl:parseFloat(p.unrealised_pnl)};
  }
  async getContractInfo(symbol="ETH_USDT") {
    const r=await this.request("GET","/futures/usdt/contracts/"+symbol);
    return{mult:parseFloat(r.body.quanto_multiplier),minSize:parseInt(r.body.order_size_min)};
  }
  async setLeverage(symbol="ETH_USDT") {
    await this.request("POST","/futures/usdt/positions/"+symbol+"/leverage",{},
      {leverage:String(this.cfg.leverage),cross_leverage_limit:"0"});
  }
  async placeOrder(dir,contracts,symbol="ETH_USDT") {
    const r=await this.request("POST","/futures/usdt/orders",{},{
      contract:symbol,size:dir==="LONG"?contracts:-contracts,price:"0",tif:"ioc",reduce_only:false});
    if(r.status!==201) throw new Error("下单失败: "+JSON.stringify(r.body));
  }
  async closePosition(size,dir,symbol="ETH_USDT") {
    const r=await this.request("POST","/futures/usdt/orders",{},{
      contract:symbol,size:dir==="LONG"?-size:size,price:"0",tif:"ioc",reduce_only:true});
    if(r.status!==201) throw new Error("平仓失败: "+JSON.stringify(r.body));
  }
  log(level, msg) {
    const ts=new Date(Date.now()+8*3600*1000).toISOString().replace("T"," ").slice(0,19);
    this.emit("log",{level,msg,ts});
  }

  // ── 手动操作 ─────────────────────────────────────────────
  async partialClose(ratio) {
    const livePos=this.cfg.dryRun?this.pos:await this.getPosition(this.activeSymbol);
    if(!livePos){this.log("warn","无持仓");return;}
    const totalSz=this.cfg.dryRun?this.pos.contracts:livePos.size;
    const closeSize=Math.max(1,Math.floor(totalSz*ratio));
    const dir=this.pos.dir, entry=this.pos.entry;
    this.log("open",`手动平仓 ${(ratio*100).toFixed(0)}% | ${dir} 平 ${closeSize}张`);
    if(!this.cfg.dryRun){
      const r=await this.request("POST","/futures/usdt/orders",{},{
        contract:this.activeSymbol,size:dir==="LONG"?-closeSize:closeSize,price:"0",tif:"ioc",reduce_only:true});
      if(r.status!==201) throw new Error("平仓失败: "+JSON.stringify(r.body));
    }
    const price=await this.getPrice(this.activeSymbol).catch(()=>entry);
    const pPct=dir==="LONG"?(price-entry)/entry*100:(entry-price)/entry*100;
    const pnl=this.pos.notional*ratio*pPct/100/this.cfg.leverage;
    this.emit("trade",{time:Date.now(),symbol:this.activeSymbol,dir,entry,exit:price,contracts:closeSize,
      notional:+(this.pos.notional*ratio).toFixed(2),pPct:+pPct.toFixed(2),
      pnl:+pnl.toFixed(2),reason:`手动平仓${(ratio*100).toFixed(0)}%`,result:pnl>=0?"win":"loss"});
    this.pos.contracts-=closeSize;
    if(this.pos.contracts<=0){this.pos=null;this.emit("position",null);this.log("info","持仓已全部平仓");}
    else{this.emit("position",{...this.pos,price:entry,pPct:0});this.log("info",`剩余: ${this.pos.contracts}张`);}
  }
  setTP(v){if(!this.pos){this.log("warn","无持仓");return;}const o=this.pos.tp;this.pos.tp=parseFloat(v);this.log("open",`止盈: ${o}→${this.pos.tp}`);this.emit("position",{...this.pos,price:this.pos.entry,pPct:0});}
  setSL(v){if(!this.pos){this.log("warn","无持仓");return;}const o=this.pos.sl;this.pos.sl=parseFloat(v);this.log("open",`止损: ${o}→${this.pos.sl}`);this.emit("position",{...this.pos,price:this.pos.entry,pPct:0});}
}

module.exports = { TradingEngine };