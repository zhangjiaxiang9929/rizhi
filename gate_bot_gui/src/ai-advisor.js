"use strict";
const https = require("https");

const AI_CONFIG = {
  apiKey: "sk-c8ltKB9BbxxMteuEr0xja9N6O3uD68ykmTggXEcEPMsulvM2",
  endpoint: "api2.openclawcn.net",
  path: "/v1/chat/completions",
  model: "deepseek-v3.2阿里云",
  timeoutMs: 8000,
};

function buildPrompt(params) {
  console.log("buildPrompt:", params.sig, params.price, params.score);
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
    const vol1h = c1h.reduce((s, c) => s + (c.volume || 0), 0);
    // 判断1h趋势方向
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
    // 判断4h趋势
    const highs = c4h.map(c => c.high);
    const lows = c4h.map(c => c.low);
    const isHigherHighs = highs[highs.length - 1] > highs[0];
    const isHigherLows = lows[lows.length - 1] > lows[0];
    let structure = "震荡";
    if (isHigherHighs && isHigherLows) structure = "上升结构";
    else if (!isHigherHighs && !isHigherLows) structure = "下降结构";
    trend4hDesc = `近10根4h K线: ${structure} 开${first.toFixed(0)} 收${last.toFixed(0)} 涨跌${pct}% 最高${high4h.toFixed(0)} 最低${low4h.toFixed(0)}`;
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
    "== 综合判断要点 ==",
    "1. 优先看4h/1h大趋势方向，5m信号需与大趋势一致",
    "2. 4h上升结构做多，下降结构做空，震荡谨慎",
    "3. 资金费率>0.05%多头过热，<-0.05%空头过热，反向操作",
    "4. 多空比极端时(>65%或<35%)考虑反向",
    "",
    "== 判断要求 ==",
    params.aiDrivenMode
      ? '当前为AI主导模式，你可以自主判断做多或做空。严格按JSON回复：{"action":"open或skip","confidence":0到100整数,"direction":"LONG或SHORT","reason":"20字内"}'
      : '严格按JSON格式回复，不输出任何其他内容：{"action":"open或skip","confidence":0到100整数,"reason":"20字内简短理由"}',
    "",
    "判断标准：",
    "action=open 赞同开仓，多周期趋势一致，信号明确",
    "action=skip 建议跳过，趋势不明或信号矛盾",
    "confidence低于65自动判定为skip",
  ];

  return lines.filter(l => l !== undefined).join("\n");
}

function callAI(prompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: AI_CONFIG.model,
      messages: [
        { role: "system", content: "你是专业量化交易分析师，只输出JSON格式，不输出任何其他内容。" },
        { role: "user", content: prompt }
      ],
      max_tokens: 100,
      temperature: 0.1,
    });

    const options = {
      hostname: AI_CONFIG.endpoint,
      port: 443,
      path: AI_CONFIG.path,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + AI_CONFIG.apiKey,
        "Content-Length": Buffer.byteLength(body),
      },
    };

    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error("AI请求超时(8s)"));
    }, AI_CONFIG.timeoutMs);

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        clearTimeout(timer);
        try {
          const json = JSON.parse(data);
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
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("未找到JSON");
    const result = JSON.parse(match[0]);
    return {
      action: result.action === "open" ? "open" : "skip",
      confidence: Math.min(100, Math.max(0, parseInt(result.confidence) || 0)),
      reason: result.reason || "无",
      direction: result.direction || null,
    };
  } catch (e) {
    return { action: "skip", confidence: 0, reason: "解析失败", direction: null };
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
    const allow = result.action === "open" && result.confidence >= 65;

    if (allow) {
      log("open", "✅ AI建议开仓 | 置信度" + result.confidence + "% | " + result.reason + " (" + elapsed + "ms)");
    } else {
      log("warn", "❌ AI建议跳过 | 置信度" + result.confidence + "% | " + result.reason + " (" + elapsed + "ms)");
    }

    return { allow, confidence: result.confidence, reason: result.reason, direction: result.direction, elapsed };
  } catch (e) {
    const elapsed = Date.now() - startTime;
    log("warn", "⚠️ AI分析失败，本次不开仓 | " + e.message + " (" + elapsed + "ms)");
    return { allow: false, confidence: 0, reason: e.message, elapsed, error: true };
  }
}

// 持仓巡检 Prompt
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
  ];

  return lines.filter(l => l !== undefined).join("\n");
}

function parseCheckResponse(content) {
  try {
    const match = content.match(/\{[\s\S]*\}/);
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

module.exports = { aiAdvise, aiCheckPosition };
