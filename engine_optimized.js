// engine_optimized.js - 优化版
// 主要修改内容：

// 1. 降低评分门槛 (60 → 55)
// 2. 放宽震荡模式RSI阈值 (32/68 → 35/65)
// 3. 增加中间模式 (ADX 20-30)
// 4. 降低扫描频率 (1分钟 → 3分钟)

// 替换原 engine.js 中的相关函数和参数

"use strict";
const https = require("https");
const crypto = require("crypto");
const { aiAdvise, aiAdviseOscillation, aiCheckPosition } = require("./ai-advisor");

class TradingEngine {
  // ... 保持原有构造函数不变 ...

  // ==================== 核心修改点 ====================
  
  /**
   * 修改1: 评分阈值降低到55分
   * 原位置: 搜索 "评分:53<60，跳过"
   */
  scoreSignal(cur, prev, sig) {
    if (sig === "HOLD") return 0;
    let s = 50;
    
    // RSI权重
    if (sig === "LONG") {
      s += cur.rsi < 35 ? 15 : cur.rsi < 45 ? 10 : cur.rsi < 55 ? 5 : 0;
    } else {
      s += cur.rsi > 65 ? 15 : cur.rsi > 55 ? 10 : cur.rsi > 50 ? 3 : 0;
    }
    
    // EMA差异权重
    const ed = Math.abs(cur.ef - cur.es) / cur.close * 100;
    s += ed > 0.3 ? 15 : ed > 0.15 ? 8 : ed > 0.05 ? 3 : 0;
    
    // ATR波动率权重
    const ap = cur.atr / cur.close * 100;
    s += ap > 0.4 ? 10 : ap > 0.25 ? 5 : 0;
    
    // K线形态
    if (sig === "LONG" && (this.isBullC(cur) || this.isBullE(cur, prev))) s += 10;
    if (sig === "SHORT" && (this.isBearC(cur) || this.isBearE(cur, prev))) s += 10;
    
    return Math.min(100, s);
  }

  /**
   * 修改2: 趋势模式开单条件 (原60分 → 55分)
   * 原位置: 搜索 "if (score >= 60)"
   */
  async runStrategy() {
    // ... 省略其他代码 ...
    
    const score = this.scoreSignal(cur5m, prev5m, sig);
    
    // 修改前: if (score >= 60)
    // 修改后: if (score >= 55)  // 降低门槛
    if (score >= 55) {
      // 开仓逻辑
      this.log("open", `✅ 信号评分:${score}≥55，符合开仓条件`);
      // ... 后续逻辑
    } else {
      // 修改前: `评分:${score}<60，跳过`
      // 修改后: `评分:${score}<55，跳过`
      this.log("scan", `⏸ 信号评分:${score}<55，跳过`);
    }
  }

  /**
   * 修改3: 震荡模式RSI阈值放宽
   * 原位置: 搜索 "RSI<32或>68"
   */
  async checkOscillationMode(rsi) {
    // 修改前: if (rsi < 32 || rsi > 68)
    // 修改后: if (rsi < 35 || rsi > 65)
    if (rsi < 35 || rsi > 65) {
      this.log("scan", "⬜ 震荡模式 | 达到反转条件(RSI<35或>65)");
      return true;
    } else {
      // 修改前: "未达反转条件(需RSI<32或>68)，等待"
      // 修改后: "未达反转条件(需RSI<35或>65)，等待"
      this.log("scan", `⬜ 震荡模式 | RSI:${rsi} 未达反转条件(需RSI<35或>65)，等待`);
      return false;
    }
  }

  /**
   * 修改4: 模式切换逻辑 - 增加中间模式
   * 原位置: 搜索 "ADX:16.5 → 30m"
   */
  determineMarketMode(adx) {
    // 原逻辑: ADX≥30→趋势模式, ADX<20→震荡模式
    // 新增: ADX 20-30 → 中间模式 (混合策略)
    
    if (adx >= 30) {
      this.marketMode = "trend";
      this.log("scan", `📊 自适应模式 ADX:${adx} → 趋势模式(1h)`);
    } else if (adx >= 20 && adx < 30) {
      this.marketMode = "mixed";  // 新增中间模式
      this.log("scan", `📊 自适应模式 ADX:${adx} → 混合模式(30m)`);
    } else {
      this.marketMode = "oscillation";
      this.log("scan", `📊 自适应模式 ADX:${adx} → 震荡模式(30m)`);
    }
  }

  /**
   * 修改5: 扫描频率降低 (1分钟 → 3分钟)
   * 原位置: 搜索 "this.tick(), 60_000"
   */
  async tick() {
    if (!this.running) return;
    try {
      await this.run();
      this._setConn(true);
    } catch (e) {
      // ... 错误处理 ...
    }
    if (this.running) {
      // 修改前: this.timer = setTimeout(() => this.tick(), 60_000); // 1分钟
      // 修改后: this.timer = setTimeout(() => this.tick(), 180_000); // 3分钟
      this.timer = setTimeout(() => this.tick(), 180_000);
    }
  }

  /**
   * 修改6: 中间模式策略 (ADX 20-30)
   */
  async runMixedMode(cur5m, prev5m, sig, score) {
    // 混合模式策略: 降低门槛 + 多条件确认
    if (score >= 50) {  // 中间模式要求50分
      // 检查趋势一致性
      const trend1h = await this.get1hTrend();
      const trend30m = await this.get30mTrend();
      
      // 要求两个时间框架趋势一致
      if (sig === trend1h || sig === trend30m) {
        this.log("open", `🔸 混合模式开仓 ${sig} | 评分:${score} 趋势:1h(${trend1h})/30m(${trend30m})`);
        return true;
      }
    }
    return false;
  }

  /**
   * 修改7: 连续信号容忍度调整
   * 原位置: 搜索 "LONG信号连续7次"
   */
  checkConsecutiveSignals(sig) {
    if (sig === this.lastSigDir) {
      this.lastSigCount++;
    } else {
      this.lastSigDir = sig;
      this.lastSigCount = 1;
    }
    
    // 修改前: 连续7次信号才考虑跳过
    // 修改后: 连续5次信号考虑跳过
    if (this.lastSigCount >= 5 && score < 60) {
      this.log("scan", `⏸ ${sig}信号连续${this.lastSigCount}次，趋势持续但评分<60，跳过`);
      return false;
    }
    return true;
  }

  // ... 保持其他原有方法不变 ...
}

module.exports = { TradingEngine };