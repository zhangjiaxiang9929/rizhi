"use strict";
const https = require("https");

// ✅ API密钥从配置文件读取，不硬编码
let _aiConfig = null;
function getAIConfig() {
  if (_aiConfig) return _aiConfig;
  try {
    const fs = require("fs"), path = require("path");
    const cfgPath = path.join(__dirname, "ai_config.json");
    if (fs.existsSync(cfgPath)) {
      const c = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
      _aiConfig = {
        apiKey: c.aiApiKey || "",
        endpoint: c.aiEndpoint || "api2.openclawcn.net",
        path: "/v1/chat/completions",
        model: c.aiModel || "qwen3-max-2026-01-23阿里云特价",
        timeoutMs: 12000,
      };
      return _aiConfig;
    }
  } catch(e) {}
  // fallback默认值
  _aiConfig = {
    apiKey: process.env.AI_API_KEY || "",
    endpoint: "api2.openclawcn.net",
    path: "/v1/chat/completions",
    model: "qwen3-max-2026-01-23阿里云特价",
    timeoutMs: 12000,
  };
  return _aiConfig;
}
// 保持向后兼容
const AI_CONFIG = {
  get apiKey() { return getAIConfig().apiKey; },
  get endpoint() { return getAIConfig().endpoint; },
  get path() { return getAIConfig().path; },
  get model() { return getAIConfig().model; },
  get timeoutMs() { return getAIConfig().timeoutMs; },
};

function buildPrompt(params) {
  
  const { sig, price, rsi, ef, es, em, atr, adx, trend, score,
    recentCandles, candles1h, candles4h, orderBook, fundingRate, lsRatio, openInterest } = params;
  const direction = sig === "LONG" ? "做多(买入)" : "做空(卖出)";
  const trendStr = trend === "LONG" ? "上涨趋势" : "下跌趋势";

  // 5分钟K线摘要（最近10根）
  let candleSummary = "";
  if (recentCandles && recentCandles.length > 0) {
    const last10 = recentCandles.slice(-10);
    candleSummary = last10.map((c, i) => {
      const chg = ((c.close - c.open) / c.open * 100).toFixed(2);
      return "K" + (i + 1) + ": 开" + c.open.toFixed(0) + " 高" + c.high.toFixed(0) + " 低" + c.low.toFixed(0) + " 收" + c.close.toFixed(0) + " (" + (chg >= 0 ? "+" : "") + chg + "%)";
    }).join("\n");
  }

  // 1小时K线分析
  let trend1hDesc = "无数据";
  if (candles1h && candles1h.length >= 20) {
    const c1h = candles1h.slice(-20);
    const first = c1h[0].close, last = c1h[c1h.length - 1].close;
    const high1h = Math.max(...c1h.map(c => c.high));
    const low1h = Math.min(...c1h.map(c => c.low));
    const pct = ((last - first) / first * 100).toFixed(2);
    const ema9_1h = c1h.slice(-9).reduce((s, c) => s + c.close, 0) / 9;
    const ema21_1h = c1h.slice(-21).reduce((s, c) => s + c.close, 0) / Math.min(21, c1h.length);
    const trendDir = last > first ? "↑上涨" : "↓下跌";
    trend1hDesc = `近20根1h K线: ${trendDir} 开${first.toFixed(0)} 收${last.toFixed(0)} 涨跌${pct}% 最高${high1h.toFixed(0)} 最低${low1h.toFixed(0)} EMA9:${ema9_1h.toFixed(0)} EMA21:${ema21_1h.toFixed(0)}`;
  }

  // 4小时K线分析
  let trend4hDesc = "无数据";
  if (candles4h && candles4h.length >= 10) {
    const c4h = candles4h.slice(-10);
    const first = c4h[0].close, last = c4h[c4h.length - 1].close;
    const high4h = Math.max(...c4h.map(c => c.high));
    const low4h = Math.min(...c4h.map(c => c.low));
    const pct = ((last - first) / first * 100).toFixed(2);
    const highs = c4h.map(c => c.high);
    const lows = c4h.map(c => c.low);
    const isHigherHighs = highs[highs.length - 1] > highs[0];
    const isHigherLows = lows[lows.length - 1] > lows[0];
    let structure = "震荡";
    if (isHigherHighs && isHigherLows) structure = "上升结构";
    else if (!isHigherHighs && !isHigherLows) structure = "下降结构";
    trend4hDesc = `近10根4h K线: ${structure} 开${first.toFixed(0)} 收${last.toFixed(0)} 涨跌${pct}% 最高${high4h.toFixed(0)} 最低${low4h.toFixed(0)}`;
  }

  // 日线趋势分析
let trend1dDesc = "无数据";
if (params.candles1d && params.candles1d.length >= 10) {
  const c1d = params.candles1d.slice(-30);
  const first = c1d[0].close, last = c1d[c1d.length - 1].close;
  const high1d = Math.max(...c1d.map(c => c.high));
  const low1d = Math.min(...c1d.map(c => c.low));
  const pct = ((last - first) / first * 100).toFixed(2);
  // 价格在30日区间的位置
  const range = high1d - low1d;
  const position = range > 0 ? ((last - low1d) / range * 100).toFixed(0) : 50;
  // 成交量趋势（近5日 vs 前5日）
  const volRecent = c1d.slice(-5).reduce((s, c) => s + (c.volume || 0), 0);
  const volPrev = c1d.slice(-10, -5).reduce((s, c) => s + (c.volume || 0), 0);
  const volTrend = volPrev > 0 ? (volRecent > volPrev ? "放量" : "缩量") : "未知";
  const trendDir = last > first ? "↑上涨" : "↓下跌";
  trend1dDesc = `近30日: ${trendDir} 涨跌${pct}% 30日高${high1d.toFixed(0)} 30日低${low1d.toFixed(0)} 当前位置:${position}%分位 成交量:${volTrend}`;
}
  let obStr = "";
  if (orderBook) {
    obStr = "买方力量: " + orderBook.bidVol + "张 | 卖方力量: " + orderBook.askVol + "张\n" +
      "买方占比: " + orderBook.ratio + "% | " + orderBook.pressure + "\n" +
      "最强支撑: " + orderBook.topBid + " | 最强压力: " + orderBook.topAsk;
  }

  let frStr = "";
  if (fundingRate) {
    frStr = "当前费率: " + fundingRate.rate + "% | " + fundingRate.sentiment + " | 下次结算: " + fundingRate.nextTime;
  }
  const lines = [
    "你是一位专业的BTC合约交易分析师。请基于以下实时市场数据，判断当前是否适合开仓。",
    "",
    "== 当前市场数据 ==",
    "交易标的: BTC/USDT 永续合约 (Gate.io)",
    "当前价格: " + price.toFixed(2) + " USDT",
    "策略信号: " + direction,
    "大级别趋势: " + trendStr,
    "策略评分: " + score + "/100",
    "",
    "== 多周期走势分析 ==",
    "日线趋势(30日): " + trend1dDesc,
    "4小时趋势: " + trend4hDesc,
    "1小时趋势: " + trend1hDesc,
    "",
    "== 5分钟技术指标 ==",
    "RSI(14): " + rsi.toFixed(1) + (rsi < 30 ? " 超卖" : rsi > 70 ? " 超买" : " 正常"),
    "EMA9: " + ef.toFixed(2) + " | EMA21: " + es.toFixed(2) + " | EMA55: " + em.toFixed(2),
    "EMA排列: " + (ef > es && es > em ? "多头排列(看涨)" : ef < es && es < em ? "空头排列(看跌)" : "混乱排列"),
    "ATR(14): " + atr.toFixed(2) + " USDT | 波动率: " + (atr / price * 100).toFixed(3) + "%",
    adx ? ("ADX: " + adx.toFixed(1) + (adx > 25 ? " 趋势强" : " 趋势弱")) : "",
    "",
    obStr ? ("== 订单簿深度 ==\n" + obStr) : "",
    "",
    frStr ? ("== 资金费率 ==\n" + frStr) : "",
    "",
    lsRatio ? ("== 多空比 ==\n多头占比: " + lsRatio.longRatio + "% | 空头占比: " + lsRatio.shortRatio + "%\n情绪: " + lsRatio.sentiment) : "",
    "",
    openInterest ? ("== 持仓量 ==\n当前持仓量: " + openInterest.current + "\n变化: " + (openInterest.change >= 0 ? "+" : "") + openInterest.change + "% | " + openInterest.trend) : "",
    "",
    "== 最近10根5分钟K线 ==",
    candleSummary,
    "",
    params.winStats ? (
  "== 历史胜率参考 ==\n" +
  `总交易${params.winStats.total}次 胜率${params.winStats.winRate}% 累计${params.winStats.totalPnl}U\n` +
  `做多胜率${params.winStats.longWinRate}% | 做空胜率${params.winStats.shortWinRate}%\n` +
  `近期状态: ${params.winStats.recentTrend}\n` +
  (params.winStats.badHours.length > 0 ? `低胜率时段: ${params.winStats.badHours.map(h => (parseInt(h)+8)%24 + "点").join(" ")} 请谨慎` : "")
) : "",
    "== 综合判断要点 ==",
"1. 主要看1h趋势方向，5m信号与1h一致则开仓",
"2. 4h和日线仅作背景参考，不强制要求对齐",
"3. 5m出现明确信号（EMA交叉/布林带突破）优先执行",
'4.根据综合分析自主判断，信号明确direction明确则action=open，否则action=skip\n',
"5. 多空比极端时(>65%或<35%)考虑反向",
'6.开仓次数不限制但是要高质量开仓，宁可少开不开低胜率单\n7.你的核心目标是账户持续盈利，每笔交易必须有明确盈利逻辑才开仓',
"7. 手续费为固定成本，不影响开仓决策",
"8. 止盈空间必须是止损空间的2倍以上才开仓（盈亏比≥2:1），止损目标1%、止盈目标2.5%",
"9. 5m信号明确 + 1h趋势一致才开仓，4h顺势加分",
"10. 根据综合分析自主判断是否开仓，信号明确则开，不明确则跳过",
"11. 震荡区间无明确方向时跳过，等待突破再开仓",
"12. 趋势明确时让利润继续跑，不要过早平仓",
"13. 4H趋势向上（价格>EMA20 & EMA20>EMA50）时做多信号更可靠，加分+10",
"14. 做多时RSI(14)<45更佳，做空时RSI(14)>55更佳，反之降低置信度",
"15. 资金费率接近0或负值时做多更安全，>0.05%时做多降低置信度",
"16. 高位震荡行情（价格在近期区间内反复）等待明确突破再开仓",
"17. 你的核心目标是帮助账户持续盈利，宁可少开高质量单，不开低胜率单，每一笔交易都要对盈利有正向贡献",

    "",
    "== 判断要求 ==",
    params.aiDrivenMode
? '当前为AI主导模式，中频稳健策略，目标日盈利2.5%-3%。必须严格按JSON回复：\n{"action":"open或skip","confidence":0到100整数,"direction":"LONG或SHORT","reason":"20字内","suggestSL":止损价格数字,"suggestTP":止盈价格数字,"ratio":仓位比例如0.2到1.0}\n核心原则：\n1.止盈必须是止损的1.5倍以上，否则action=skip\n2.止损控制在价格0.5%-3%之间，止盈控制在1%-6%之间，根据趋势强度自主设置\n3.5m信号明确+1h趋势一致才开仓\n4.置信度≥62才action=open\n5.ratio：置信度≥85用1.0，≥72用0.7，≥62用0.5\n6.每天6-8次高质量开仓，宁可少开不开低胜率单': '严格按JSON格式回复，不输出任何其他内容：{"action":"open或skip","confidence":0到100整数,"reason":"20字内简短理由","suggestSL":止损价格数字,"suggestTP":止盈价格数字}',
"",
    "",
    "判断标准：",
    "action=open 赞同开仓，多周期趋势一致，信号明确",
    "action=skip 建议跳过，趋势不明或信号矛盾",
    "confidence低于60自动判定为skip",
  ];

  return lines.filter(l => l !== undefined).join("\n");
}

function callAI(prompt, model) {
  return new Promise((resolve, reject) => {
    const cfg = getAIConfig();
    const usedModel = model || cfg.model;
    const body = JSON.stringify({
      model: usedModel,
      messages: [
        { role: "system", content: "你是专业量化交易分析师，只输出JSON格式，不输出任何其他内容。" },
        { role: "user", content: prompt }
      ],
      max_tokens: 300,
      temperature: 0.1,
    });

    const options = {
      hostname: cfg.endpoint,
      port: 443,
      path: cfg.path,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + cfg.apiKey,
        "Content-Length": Buffer.byteLength(body),
      },
    };

    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error("AI请求超时(12s)"));
    }, cfg.timeoutMs);

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        clearTimeout(timer);
        try {
          const json = JSON.parse(data);
          if (json.error) {
            // ✅ 模型名失效时自动fallback到备用模型重试一次
            if (json.error.code === "model_not_found" && usedModel !== "qwen3-max-2026-01-23阿里云特价") {
              resolve(callAI(prompt, "qwen3-max-2026-01-23阿里云特价"));
              return;
            }
            reject(new Error("API错误: " + (json.error.message || "未知错误")));
            return;
          }
          const content = json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
          resolve(content ? content.trim() : "");
        } catch (e) {
          reject(new Error("AI响应解析失败"));
        }
      });
    });

    req.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });

    req.write(body);
    req.end();
  });
}

function parseAIResponse(content) {
  try {
    // ✅ 先去掉思维链标签
    const cleaned = content.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("未找到JSON");
    const result = JSON.parse(match[0]);
    return {
      action: result.action === "open" ? "open" : "skip",
      confidence: Math.min(100, Math.max(0, parseInt(result.confidence) || 0)),
      reason: result.reason || "无",
      direction: result.direction || null,
      suggestSL: result.suggestSL ? parseFloat(result.suggestSL) : null,
      suggestTP: result.suggestTP ? parseFloat(result.suggestTP) : null,
      ratio: result.ratio ? parseFloat(result.ratio) : null,
    };
  } catch (e) {
    return { action: "skip", confidence: 0, reason: "解析失败", direction: null, suggestSL: null, suggestTP: null };
  }
}

function buildOscillationPrompt(params) {
  const { sig, price, rsi, ef, es, orderBook, fundingRate, lsRatio } = params;
  const direction = sig === "LONG" ? "做多(超卖反弹)" : "做空(超买回落)";

  let obStr = orderBook ? (
    "买方占比: " + orderBook.ratio + "% | " + orderBook.pressure +
    "\n最强支撑: " + orderBook.topBid + " | 最强压力: " + orderBook.topAsk
  ) : "无数据";

  let frStr = fundingRate ? ("当前费率: " + fundingRate.rate + "% | " + fundingRate.sentiment) : "无数据";
  let lsStr = lsRatio ? ("多头: " + lsRatio.longRatio + "% | 空头: " + lsRatio.shortRatio + "% | " + lsRatio.sentiment) : "无数据";

  const lines = [
    "你是BTC合约交易分析师。当前处于震荡行情（价格在区间内横盘，EMA差<0.06%，无明显趋势）。",
    "策略使用区间反转逻辑，请判断当前是否适合开仓。",
    "",
    "== 当前市场数据 ==",
    "交易标的: BTC/USDT 永续合约",
    "当前价格: " + price.toFixed(2) + " USDT",
    "策略信号: " + direction,
    "",
    "== 技术指标 ==",
    "RSI(14): " + rsi.toFixed(1) + (rsi < 30 ? " ⚠️超卖" : rsi > 70 ? " ⚠️超买" : " 正常"),
    "EMA9: " + ef.toFixed(2) + " | EMA21: " + es.toFixed(2),
    "EMA差: " + ((ef - es) / es * 100).toFixed(3) + "% (接近0 = 震荡确认)",
    "",
    "== 订单簿 ==",
    obStr,
    "",
    "== 资金费率 ==",
    frStr,
    "",
    "== 多空比 ==",
    lsStr,
    "",
    "== 震荡模式判断原则 ==",
    "1. 当前为震荡区间，不考虑趋势方向，只做反转",
    "2. 做多条件：RSI<32（超卖）+ 买方支撑强（订单簿买方>55%）",
    "3. 做空条件：RSI>68（超买）+ 卖方压力强（订单簿买方<42%）",
    "4. 止盈目标0.5%，止损0.3%，盈亏比≥1.5:1",
    "5. 资金费率极端（>0.05%）时做多降低置信度",
    "6. 散户极度偏多（>70%）反向看空，极度偏空（<30%）反向看多",
    "7. 震荡模式不要求趋势对齐，只看超卖/超买反转质量",
    "",
    "== 判断要求 ==",
    "严格按JSON格式回复，不输出任何其他内容：",
    '{"action":"open或skip","confidence":0到100整数,"reason":"20字内","suggestSL":止损价格数字,"suggestTP":止盈价格数字}',
    "",
    "判断标准：confidence≥55才建议open，RSI信号明确+订单簿支持才open，否则skip",
  ];
  return lines.join("\n");
}

async function aiAdviseOscillation(params, log) {
  const startTime = Date.now();
  try {
    log("info", `🤖 AI分析中(震荡)... [${params.sig}] RSI:${params.rsi.toFixed(1)}`);
    const prompt = buildOscillationPrompt(params);
    const rawContent = await callAI(prompt);
    const result = parseAIResponse(rawContent);
    const elapsed = Date.now() - startTime;
    const allow = result.action === "open" && result.confidence >= 55;
    if (allow) {
      log("open", `✅ AI(震荡)建议开仓 | 置信度${result.confidence}% | ${result.reason} (${elapsed}ms)`);
    } else {
      log("warn", `❌ AI(震荡)建议跳过 | 置信度${result.confidence}% | ${result.reason} (${elapsed}ms)`);
    }
    return { allow, confidence: result.confidence, reason: result.reason, suggestSL: result.suggestSL, suggestTP: result.suggestTP, elapsed };
  } catch(e) {
    const elapsed = Date.now() - startTime;
    log("warn", `⚠️ AI(震荡)分析失败，跳过 | ${e.message} (${elapsed}ms)`);
    return { allow: false, confidence: 0, reason: e.message, elapsed, error: true };
  }
}

async function aiAdvise(params, log) {
  
  const startTime = Date.now();
  try {
    log("info", "🤖 AI分析中... [" + params.sig + "] 策略评分" + params.score + " (含1h/4h趋势)");
    const prompt = buildPrompt(params);
    const rawContent = await callAI(prompt);
    const result = parseAIResponse(rawContent);
    
    const elapsed = Date.now() - startTime;
    // ✅ 动态置信度门槛：
    // 评分≥60：门槛降到50%（高质量信号，AI只需不强烈反对）
    // 评分≥80：门槛降到50%（保持不变，已包含在上面）
    // 连续信号≥5次：门槛降到45%（方向已多次验证）
    // 普通情况（评分45~59）：55%
    let confidenceThreshold = 55;
    if (params.score && params.score >= 60) confidenceThreshold = 50;
    if (params.score && params.score >= 80) confidenceThreshold = 50;
    if (params.sigCount && params.sigCount >= 5) confidenceThreshold = Math.min(confidenceThreshold, 45);
    const allow = result.action === "open" && result.confidence >= confidenceThreshold;

    if (allow) {
      log("open", "✅ AI建议开仓 | 置信度" + result.confidence + "% | " + result.reason + " (" + elapsed + "ms)");
    } else {
      log("warn", "❌ AI建议跳过 | 置信度" + result.confidence + "% | " + result.reason + " (" + elapsed + "ms)");
    }

    return { allow, confidence: result.confidence, reason: result.reason, direction: result.direction, suggestSL: result.suggestSL, suggestTP: result.suggestTP, ratio: result.ratio, elapsed };
  } catch (e) {
    const elapsed = Date.now() - startTime;
    log("warn", "⚠️ AI分析失败，本次不开仓 | " + e.message + " (" + elapsed + "ms)");
    return { allow: false, confidence: 0, reason: e.message, elapsed, error: true };
  }
}

function buildCheckPrompt(params) {
  const { dir, entry, price, pPct, sl, tp, holdMinutes, orderBook, fundingRate } = params;
  const lines = [
    "你是BTC合约交易风控专家。分析以下持仓状态，判断是否需要提前平仓或减仓。",
    "",
    "== 当前持仓 ==",
    "方向: " + (dir === "LONG" ? "做多" : "做空"),
    "开仓价: " + entry.toFixed(2) + " | 当前价: " + price.toFixed(2),
    "浮动盈亏: " + (pPct >= 0 ? "+" : "") + pPct.toFixed(2) + "%",
    "止损价: " + sl + " | 止盈价: " + tp,
    "持仓时长: " + holdMinutes + "分钟",
    "",
    orderBook ? ("== 订单簿 ==\n买方占比: " + orderBook.ratio + "% | " + orderBook.pressure) : "",
    "",
    fundingRate ? ("== 资金费率 ==\n" + fundingRate.rate + "% | " + fundingRate.sentiment) : "",
    "",
    params.lsRatio ? ("== 多空比 ==\n多:" + params.lsRatio.longRatio + "% 空:" + params.lsRatio.shortRatio + "% | " + params.lsRatio.sentiment) : "",
    "",
    params.openInterest ? ("== 持仓量变化 ==\n" + (params.openInterest.change >= 0 ? "+" : "") + params.openInterest.change + "% | " + params.openInterest.trend) : "",
    "== 判断要求 ==",
    "严格按JSON格式回复，不输出其他内容：",
    '{"action":"hold或reduce或close","reason":"15字内理由","urgency":"low或high"}',
    "",
    "判断标准：",
"hold: 继续持有，风险可控",
"reduce: 建议减仓50%，有一定风险",
"close: 建议立即全平，风险较高",
"",
"⚠️ 重要原则：",
"1. 手续费属于正常交易成本，不能作为平仓理由",
"2. 只要浮亏未超过止损价，不建议close或reduce",
"3. 判断依据：价格趋势、订单簿压力、资金费率，而非盈亏数字",
"4. 短暂浮亏且趋势未反转，一律判断hold",
"5. 浮盈达到0.35%以上且趋势出现反转信号 → 建议close，保住利润",
"6. 浮盈达到0.5%以上，趋势反转信号明确则必须建议close",
"7. 持仓超过90分钟 且 浮盈在-0.2%到+0.2%之间（真正横盘）→ 建议close换机会",
"8. reduce只在：浮盈回撤超60% 或 出现明确反转信号",
"9. close只在：价格逼近止损（距止损<0.1%）或 强烈反转信号+大量抛压持续出现 或 满足第7条超时横盘条件",
"10. 开空后价格持续上涨（连续3次以上）且订单簿买方占比持续>75%（非短暂波动）→ 趋势可能反转，考虑close",
"11. 开多后价格持续下跌（连续3次以上）且订单簿卖方占比持续>75%（非短暂波动）→ 趋势可能反转，考虑close",
  ];
  return lines.filter(l => l !== undefined).join("\n");
}

function parseCheckResponse(content) {
  try {
    // ✅ 先去掉思维链标签
    const cleaned = content.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("未找到JSON");
    const result = JSON.parse(match[0]);
    return {
      action: ["hold", "reduce", "close"].includes(result.action) ? result.action : "hold",
      reason: result.reason || "无",
      urgency: result.urgency || "low",
    };
  } catch (e) {
    return { action: "hold", reason: "解析失败", urgency: "low" };
  }
}

async function aiCheckPosition(params, log) {
  const startTime = Date.now();
  try {
    log("scan", "🔍 AI巡检持仓中...");
    const prompt = buildCheckPrompt(params);
    const rawContent = await callAI(prompt);
 
 const result = parseCheckResponse(rawContent);
    const elapsed = Date.now() - startTime;

    if (result.action === "close") {
      log("warn", "🤖 AI建议平仓！| " + result.reason);
    } else if (result.action === "reduce") {
      log("warn", "🤖 AI建议减仓！| " + result.reason);
    } else {
      log("scan", "🤖 AI巡检正常 | " + result.reason);
    }

    return result;
  } catch (e) {
    log("warn", "⚠️ AI巡检失败 | " + e.message);
    return { action: "hold", reason: "巡检失败", urgency: "low" };
  }
}

module.exports = { aiAdvise, aiAdviseOscillation, aiCheckPosition };