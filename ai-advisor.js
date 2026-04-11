"use strict";
const https = require("https");

/**
 * AI 顾问模块 - 接入千问3 Max 模型
 * 只在 score >= 60 且 MTF 顺势时调用，节省 API 费用
 */

const AI_CONFIG = {
  apiKey: process.env.QWEN_API_KEY || "sk-c8ltKB9BbxxMteuEr0xja9N6O3uD68ykmTggXEcEPMsulvM2",
  endpoint: "dashscope.aliyuncs.com",
  path: "/compatible-mode/v1/chat/completions",
  model: "qwen-max-latest", // 千问3 Max
  timeoutMs: 8000, // 8秒超时，超时不开仓
};

/**
 * 构建发给 AI 的市场分析 Prompt
 */
function buildPrompt({ sig, price, rsi, ef, es, em, atr, adx, trend, score, recentCandles }) {
  const direction = sig === "LONG" ? "做多(买入)" : "做空(卖出)";
  const trendStr = trend === "LONG" ? "上涨趋势" : "下跌趋势";

  // 最近10根K线摘要
  let candleSummary = "";
  if (recentCandles && recentCandles.length > 0) {
    const last10 = recentCandles.slice(-10);
    candleSummary = last10.map((c, i) => {
      const chg = ((c.close - c.open) / c.open * 100).toFixed(2);
      return `K${i + 1}: 开${c.open.toFixed(0)} 高${c.high.toFixed(0)} 低${c.low.toFixed(0)} 收${c.close.toFixed(0)} (${chg >= 0 ? "+" : ""}${chg}%)`;
    }).join("\n");
  }

  return `你是一位专业的BTC合约交易分析师。请基于以下实时市场数据，判断当前是否适合开仓。

## 当前市场数据
- 交易标的: BTC/USDT 永续合约 (Gate.io)
- 当前价格: ${price.toFixed(2)} USDT
- 策略信号: ${direction}
- 大级别趋势: ${trendStr}
- 策略评分: ${score}/100

## 技术指标
- RSI(14): ${rsi.toFixed(1)} ${rsi < 30 ? "⚠️超卖" : rsi > 70 ? "⚠️超买" : "正常区间"}
- EMA9: ${ef.toFixed(2)} | EMA21: ${es.toFixed(2)} | EMA55: ${em.toFixed(2)}
- EMA9 vs EMA21: ${ef > es ? "金叉(看涨)" : "死叉(看跌)"}
- ATR(14): ${atr.toFixed(2)} USDT (波动率: ${(atr / price * 100).toFixed(3)}%)
${adx ? `- ADX: ${adx.toFixed(1)} ${adx > 25 ? "趋势强" : "趋势弱/震荡"}` : ""}

## 最近10根5分钟K线
${candleSummary}

## 你的任务
请综合分析以上数据，给出简洁判断。

严格按以下JSON格式回复（不要有其他文字）：
{
  "action": "open" 或 "skip",
  "confidence": 0-100的整数,
  "reason": "15字以内的简短理由"
}

判断标准：
- action="open": 赞同开仓，各指标一致，趋势明确
- action="skip": 建议跳过，有明显风险或信号矛盾
- confidence: 你的判断置信度，低于65则建议 skip
`;
}

/**
 * 调用 AI API（带超时控制）
 */
function callAI(prompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: AI_CONFIG.model,
      messages: [
        {
          role: "system",
          content: "你是专业的量化交易分析师，只输出JSON格式结果，不输出任何其他内容。"
        },
        {
          role: "user",
          content: prompt
        }
      ],
      max_tokens: 150,
      temperature: 0.1, // 低温度，输出更稳定
    });

    const options = {
      hostname: AI_CONFIG.endpoint,
      path: AI_CONFIG.path,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${AI_CONFIG.apiKey}`,
        "Content-Length": Buffer.byteLength(body),
      },
    };

    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error("AI请求超时"));
    }, AI_CONFIG.timeoutMs);

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        clearTimeout(timer);
        try {
          const json = JSON.parse(data);
          const content = json.choices?.[0]?.message?.content || "";
          resolve(content.trim());
        } catch (e) {
          reject(new Error("AI响应解析失败: " + e.message));
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

/**
 * 解析 AI 返回的 JSON
 */
function parseAIResponse(content) {
  try {
    // 提取 JSON（有时 AI 会包裹在 ```json ``` 里）
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("未找到JSON");
    const result = JSON.parse(match[0]);

    return {
      action: result.action === "open" ? "open" : "skip",
      confidence: Math.min(100, Math.max(0, parseInt(result.confidence) || 0)),
      reason: result.reason || "无",
    };
  } catch (e) {
    return { action: "skip", confidence: 0, reason: "解析失败" };
  }
}

/**
 * 主入口：AI 分析是否开仓
 * @param {object} params - 市场数据参数
 * @param {function} log - 日志回调 (level, msg)
 * @returns {object} { allow: bool, confidence: number, reason: string }
 */
async function aiAdvise(params, log) {
  const startTime = Date.now();

  try {
    log("info", `🤖 AI分析中... [${params.sig}] 评分${params.score}`);

    const prompt = buildPrompt(params);
    const rawContent = await callAI(prompt);
    const result = parseAIResponse(rawContent);

    const elapsed = Date.now() - startTime;
    // ✅ 修复: 置信度门槛 65 → 60（AI频繁返回58-63导致永远不开仓）
    const allow = result.action === "open" && result.confidence >= 60;

    if (allow) {
      log("open", `✅ AI建议开仓 | 置信度${result.confidence}% | ${result.reason} (${elapsed}ms)`);
    } else {
      log("scan", `🤖 AI建议跳过 | 置信度${result.confidence}% | ${result.reason} (${elapsed}ms)`);
    }

    return {
      allow,
      confidence: result.confidence,
      reason: result.reason,
      elapsed,
    };

  } catch (e) {
    const elapsed = Date.now() - startTime;
    log("warn", `⚠️ AI分析失败，跳过本次开仓 | ${e.message} (${elapsed}ms)`);

    // 超时或失败 → 不开仓
    return {
      allow: false,
      confidence: 0,
      reason: e.message,
      elapsed,
      error: true,
    };
  }
}

module.exports = { aiAdvise };
